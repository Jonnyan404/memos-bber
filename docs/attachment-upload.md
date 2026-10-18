# Memos 附件上传能力调研与最佳实践

调研对象：usememos/memos 公开 API（`proto/api/**`、`server/api/**`、官方 Web 客户端 `web/src/components/MemoEditor/**`）。
结论按版本分档，覆盖 v0.15 → 26.10+。

## 一、结论摘要

1. **每个大版本都提供附件上传**，但接口形态变了四次：`resource/blob`（multipart）→ `resources`（JSON+base64）→ `attachments`（JSON+base64）→ `attachments:upload`（分片续传）。
2. **上游从来没有"随消息一起上传"的接口**。附件必须先在附件服务里落地成一个独立资源（resource / attachment），再与 memo 建立关联。这不是实现偏好，是 API 的硬约束。
3. 因此真正要选的不是"能不能一起传"，而是**什么时候发起这次独立上传**：用户选中文件时（upload-first），还是用户点发送时（send-time）。
4. 推荐 **upload-first**，但必须配套三件事：发送前的状态校验、草稿引用校验、未关联附件的显式清理。详见第六节。

## 二、API 能力矩阵

| 版本 | 资源实体 | 上传接口 | 传输格式 | 与 memo 关联 | 关键约束 |
|---|---|---|---|---|---|
| 0.15 – 0.21 | `resource` | `POST /api/v1/resource/blob` | `multipart/form-data`，字段 `file` | 创建 memo 时带 `resourceIdList`（数字 id 数组） | 默认上限 32 MiB（`maxUploadSizeMiB`）；`POST /api/v1/resource` 只建元数据/外链，不传二进制 |
| 0.22 – 0.24 | `resource` | `POST /api/v1/resources` | JSON，`content` 为 base64（proto `bytes`） | **必须二次调用** `PATCH /api/v1/{name=memos/*}/resources`（SetMemoResources，全量替换） | `Memo.resources` 是 `OUTPUT_ONLY`，创建 memo 时带不进去 |
| 0.25 – 0.31 | `attachment` | `POST /api/v1/attachments` | JSON，`content` 为 base64 | `Attachment.memo` 可选，可在创建时带 `memos/{id}`；或 `PATCH /api/v1/{name=memos/*}/attachments` | 下载走 `GET /file/{name=attachments/*}/{filename}?thumbnail=` |
| 26.10+（v2） | `attachment` | `POST /api/attachments`（inline）<br>`POST /api/attachments:upload`（分片） | JSON base64 / 二进制分片 | `POST /api/memos` 可直接带 `attachments`（**原子创建**）；或 `PATCH /api/memos/*/attachments` | 分片 2 MiB/块，30 分钟不活动过期，重启丢失，每用户最多 8 个未完成上传；`/api/v1/*` 返回 410 Gone |

### 2.1 各版本细节

**0.15 – 0.21（legacy）**

```go
// server/route/api/v1/resource.go
g.POST("/resource", s.CreateResource)       // JSON：只有 filename/externalLink/type
g.POST("/resource/blob", s.UploadResource)  // multipart：真正的文件上传
```

`UploadResource` 读 `c.FormFile("file")`，超过 `maxUploadSizeMiB`（默认 32 MiB）直接 400。返回 `resource`，`id` 为数字。创建 memo 时用 `resourceIdList: [1,2,3]` 关联。
这是**唯一一条真正的流式 multipart 通道**，浏览器原生能报 `xhr.upload.onprogress`。

**0.22 – 0.24**

`resource_service.proto` 只提供 `CreateResource`（`body: "resource"`），`Resource.content` 是 `bytes`，JSON 下即 base64。
`memo_service.proto` 里 `Memo.resources` 标记为 `OUTPUT_ONLY`：

```proto
repeated Resource resources = 14 [(google.api.field_behavior) = OUTPUT_ONLY];
```

所以流程被强制拆成三步：上传 → 建 memo → `SetMemoResources` 回填。注意本项目实测 0.22 对 `updateMask=resources` 可能返回 200 却**静默不关联**，必须回读 `GetMemo` 校验。

**0.25 – 0.31**

`attachment_service.proto` 取代 `resource_service.proto`，新增 `Attachment.memo`：

```proto
optional string memo = 8;  // Format: memos/{memo}
```

这意味着 0.25+ 可以在上传时就声明归属 memo（前提是 memo 已存在），也可以在 `CreateAttachment` 之后单独 `SetMemoAttachments`。

**26.10+（v2，无 `/v1` 标记）**

新增分片续传，这是唯一为大文件设计的接口：

```proto
rpc UploadAttachment(UploadAttachmentRequest) returns (UploadAttachmentResponse) {
  option (google.api.http) = { post: "/api/attachments:upload" body: "*" };
}
```

请求是 `oneof upload { spec | upload_id }` + `write_offset` + `data` + `finish_write`。服务端常量：

```go
uploadChunkSize        = 2 << 20        // 2 MiB
uploadTTL              = 30 * time.Minute
uploadMaxActivePerUser = 8
```

同时 `Memo.attachments` 不再是 `OUTPUT_ONLY`，`CreateMemo` 会消费它（`prepareMemoCreate` → `createMemoWithMutation`），所以 v2 上可以**一次请求原子地建 memo + 挂附件**。

## 三、三条从代码里读出来的硬事实

1. **上传与发帖是两个事务。** 除了 v2 的原子创建，其余版本都至少需要两次请求。附件在"已上传、未关联"的中间态是真实存在的。
2. **中间态没有自动回收。** 仓库里没有任何 cron / scheduler / 清理任务；v2 的 `ListAttachments` 注释明确写着会返回 "the caller's unlinked uploads"。未关联附件会一直留在存储里，只能靠客户端 `DeleteAttachment` / `BatchDeleteAttachments`（≤100 条）显式删除。
3. **base64 通道是主流，分片是例外。** 0.22 之后到 v2 的 inline 接口都是 JSON + base64，体积膨胀约 33%，且编码阶段在浏览器主线程完成，**这段时间没有任何可观测进度**。只有 0.15–0.21 的 multipart 和 v2 的 `attachments:upload` 能给出真实字节进度。

## 四、两种策略的对比

### A. 发送前即时上传（upload-first）

用户选中/粘贴/拖入文件 → 立刻上传 → 拿到 `attachments/{id}` → 发送时只提交引用。

### B. 点击发送时上传（send-time）

用户点"发送" → 先上传全部附件 → 成功后创建 memo（或 v2 原子创建）→ 返回结果。

| 维度 | A. 发送前上传 | B. 发送时上传 |
|---|---|---|
| 用户感知时延 | 上传与写正文**并行**，发送几乎是瞬时的 | 点击后进入不可交互的等待，时长 = 文件体积 / 上行带宽 |
| 进度反馈 | 天然可做：逐文件 + 总体百分比，可取消、可重试 | 能显示，但此时用户已"提交"，心理上是在等结果而不是在操作 |
| 失败处理 | 失败只影响该附件，正文不受影响，可单独重试 | 失败会卡住整条 memo；0.22–0.24 还可能出现"memo 已建、附件没挂上"的半成品 |
| 孤儿文件 | **有风险**：用户放弃草稿会留下未关联附件 | 无（失败即整体失败） |
| 草稿恢复 | 可持久化 attachment name，重开编辑器还原 | 无草稿概念，关了就是全丢 |
| 发送按钮语义 | 纯提交，幂等、快 | 变成"上传+提交"的复合长任务，需要防重复点击 |
| 大文件 | 可提前发现超限并拒绝，不浪费用户时间 | 用户等很久才被告知超限 |
| 并发控制 | 可控（官方客户端 4 并发，服务端上限 8） | 天然串行，但会拉长总时长 |
| 跨版本实现 | 需要按 era 分支，但只影响上传那一段 | 分支更多：上传 + 建 memo + 回填，三处都要兼容 |
| 实现复杂度 | 中（多一套进度状态机） | 中高（事务性编排 + 回滚） |

### 适用场景

- **A 更适合**：桌面/移动端编辑器、需要粘贴截图、多附件、大文件、弱网、有草稿需求的场景。也是官方 Web 客户端的做法（`uploadService.uploadFile` 在选文件时即调用，编辑器状态持有 `Attachment`，保存 memo 时一并提交）。
- **B 更适合**：无草稿的一次性提交入口（CLI、快捷指令、机器人回复）、附件与正文强绑定且不允许中间态泄漏、或服务端明确禁止未关联附件长期存在的部署。

## 五、注意事项（踩坑清单）

1. **base64 膨胀**：32 MiB 的限额若按请求体算，实际只能传约 24 MiB 的原文件。判断超限要用 `ceil(n/3)*4` 估算编码后大小。
2. **编码阶段无进度**：FileReader 是同步 CPU 操作，几百毫秒到数秒。进度条要么先显示"准备中"的 indeterminate 态，要么直接走分片接口。
3. **0.22–0.24 的静默失败**：`PATCH .../resources` 返回 200 不代表挂上了，必须 `GetMemo` 回读比对数量。
4. **v2 的 8 个未完成上传**：并发超过 8 会被拒（`uploadMaxActivePerUser`）。官方客户端取 4 作并发上限。
5. **分片上传不可持久化**：30 分钟 TTL + 重启丢失，断点续传只能在单次会话内做，不能写进 storage 指望下次续上。
6. **popup 生命周期**：浏览器扩展的 popup 失焦即销毁，长上传会中断。upload-first 至少保证"已完成的附件"不会丢；send-time 则会整体作废。
7. **孤儿附件**：没有服务端 GC。放弃草稿时要主动 `DeleteAttachment`，否则存储只增不减。
8. **下载需鉴权**：`/file/...` 走 Bearer，不能直接 `<img src>`，要用 fetch + blob URL（本项目已有该逻辑）。

## 六、推荐方案

**推荐 A：发送前即时上传，发送时只提交引用。** 理由按权重排序：

1. **API 事实决定了必须分两步**（除 v2 原子创建），既然无法合并，就让这两步在时间上解耦，而不是都压在点击发送的那一刻。
2. **感知性能**：上传与写正文并行，是唯一能做到"点发送即完成"的方案。
3. **失败可局部化**：单个附件失败可以重试，不会把整条 memo 拖下水。
4. **进度条才有意义**：真实字节进度来自 `xhr.upload.onprogress`（legacy）或 `committed_size`（v2 分片），这两种都要求上传是一个**用户可感知的独立过程**。
5. **官方实现同款**：与上游 Web 客户端行为一致，遇到问题可以直接对照。

### 6.1 目标时序

```
选择/粘贴/拖入
   └─→ [并发 ≤4] 上传（v2 分片 2MiB / 旧版 base64 / legacy multipart）
          ├─ 进度事件 → 更新 UI（文件级 + 总体）
          ├─ 成功 → 记录 {name, filename, size} 到 pendingAttachments
          └─ 失败 → 标红 + 重试按钮，不阻塞输入
写正文（与上传并行）
   └─→ 点发送
          ├─ 校验：所有 pending 项 state === 'done'，否则禁用/提示
          ├─ v2：POST /api/memos { content, visibility, attachments: [...] }   // 一次原子
          ├─ 0.25+：POST /api/v1/memos → PATCH /api/v1/{name}/attachments
          ├─ 0.22–0.24：POST /api/v1/memos → PATCH .../resources → GetMemo 回读校验
          └─ legacy：POST /api/v1/memo { resourceIdList: [数字 id] }
```

### 6.2 必须配套的三件事

- **发送前状态门禁**：只要有附件还在上传/失败，就阻止发送并给出明确原因（"1 个附件仍在上传"）。不要静默丢弃。
- **草稿引用校验**：`pendingAttachments` 持久化后，下次打开编辑器要逐个 `GetAttachment` 校验；404 的直接从列表移除，避免发出指向已删附件的 memo。
- **未关联附件的清理**：删除按钮 → `DeleteAttachment`；草稿被清空或用户显式放弃时，批量 `BatchDeleteAttachments`（v2，≤100 条）清理残留。

### 6.3 什么时候改用 B

- 附件体积常态超过单次上限的 70%（upload-first 会白等）；
- 部署方明确要求零孤儿文件且不接受客户端清理；
- 入口本身没有编辑器（命令行、Webhook、快捷指令）。

即便这些场景，也建议保留 A 的进度条与重试能力，只是把触发点从"选中文件"挪到"点击发送"。

## 七、已落地的实现

| 文件 | 改动 |
|---|---|
| `chrome/js/compat/memosApi.js` | `request()` 增加 `xhr` 工厂挂 `upload.onprogress`；`uploadFile()` 透传 `onProgress`；26.10+ 走 `uploadChunked()`（`attachments:upload`，2 MiB/块、串行、按服务端 `maxChunkSize` 取小值），spec 失败时安全回退到 inline |
| `chrome/js/oper.js` | `uploadJobs` 内存态 + `uploadBatch` 字节汇总；`renderUploadProgress()` 按帧节流；失败保留重试入口；发送前状态门禁 |
| `chrome/popup.html` / `css/main.css` | 进度条节点（`role=progressbar`）、4px 轨道、编码期 sweep 不确定态、失败态配色 |
| `tools/verify/*` | `chrome-ui.mjs` 的 `upload` 场景断言进度条真的绘制；新增 `upload-fail` 场景；`memos-api-matrix.mjs` 增加 `uploadProgress` / `uploadLarge` 检查与 `--ui` 真实浏览器选项 |

**没有采用 4 并发分片**：本项目是串行上传多文件，单文件内也串行分片。服务端限制每用户 8 个未完成上传，串行离上限最远，也避免了并发写同一 `uploadId` 的顺序问题。官方 Web 客户端用 4 并发是因为它的编辑器可以同时拖入多个大文件并各自独立显示进度；本项目的进度条是批次级的，串行更简单且结果一致。

当前实现已经是 upload-first（选中即传、`pendingAttachments` 落 `chrome.storage.sync`），方向正确，本轮补的是进度反馈、失败重试与发送前门禁。

