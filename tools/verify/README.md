# 真实浏览器 UI 验证（Chrome）

用 DevTools Protocol 直接驱动 Chrome，把 `chrome/` 以未打包扩展加载，打开
`chrome-extension://<id>/popup.html` 当真页面操作（填网址/令牌、保存、发送、切换可见性），
再回到服务端核对结果。**零 npm 依赖**，只需要 Node 18+（内置 `fetch`/`WebSocket`）。

## 1. 浏览器：用 Chrome for Testing，不要用日常 Chrome

Chrome 137+ 的品牌版会忽略 `--load-extension`（页面会停在错误页，标题就是 URL）。
实测：Google Chrome 155 加载失败，Chrome for Testing 156 正常。

优先级（脚本自动按此顺序找）：

1. `CHROME_PATH` 环境变量
2. Playwright 缓存里的 CfT：`~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Google Chrome for Testing.app/...`
3. `/Applications/Google Chrome.app`（通常不可用，仅兜底）

没有 CfT 时下载（macOS arm64，~150MB）：

```bash
curl -s https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json \
  | python3 -c 'import sys,json;d=json.load(sys.stdin)["channels"]["Stable"];print(d["version"]);[print(x["url"]) for x in d["downloads"]["chrome"] if x["platform"]=="mac-arm64"]'
# 取上面打印的 URL
curl -L -o /tmp/chrome-cft.zip "<url>"
unzip -q /tmp/chrome-cft.zip -d ~/chrome-cft
export CHROME_PATH="$HOME/chrome-cft/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
```

## 2. 准备一个 Memos 实例和令牌

```bash
docker run -d --name ui-memos -p 15400:5230 neosmemo/memos:0.31.0
curl -s -X POST http://127.0.0.1:15400/api/v1/users \
  -H 'Content-Type: application/json' \
  -d '{"username":"tester","password":"Passw0rd!123","role":"ADMIN"}'
TOKEN=$(curl -s -X POST http://127.0.0.1:15400/api/v1/auth/signin \
  -H 'Content-Type: application/json' \
  -d '{"passwordCredentials":{"username":"tester","password":"Passw0rd!123"}}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
```

## 3. 运行

```bash
# 正常发布：期望 toast「发送成功」且服务端能查到该条
node tools/verify/chrome-ui.mjs --url http://127.0.0.1:15400/ --token "$TOKEN"

# issue #8 回归：0.26.1 + disallowPublicVisibility=true，选择“公开”发送
node tools/verify/chrome-ui.mjs --url http://127.0.0.1:15401/ --token "$TOKEN" \
  --scenario public-forbidden

# 看得到界面（非 headless）、保留浏览器
node tools/verify/chrome-ui.mjs --url ... --token ... --headless=false --keep

# 换 bundle（firefox 包是 MV2，Chrome 不加载，仅供对照）
node tools/verify/chrome-ui.mjs --url ... --token ... --extension edge
```

参数：`--extension`（目录）、`--chrome`/`CHROME_PATH`、`--port`（调试端口，默认 9444）、
`--scenario`（见下表）、`--subpath /memos`、`--page`（默认 `popup.html`，全屏页用
`--page=popup.html?mode=full`）、`--viewport 1280x800`、`--mobile`、`--screenshot out.png`、`--text`。

场景：

| `--scenario` | 期望 |
|---|---|
| `success`（默认） | toast「发送成功」，服务端能查到该条 |
| `public-forbidden` | 服务端禁用公开时，toast 指出具体原因且不产生 memo |
| `invalid-token` | 保存阶段即提示令牌无效/URL 错误，不写入设置 |
| `upload` | 通过真实文件选择框上传 PNG，空正文发送后服务端 memo 带 1 个附件 |
| `locked-public` | 服务端禁用公开时，「公开」置灰（`not-allowed` + 透明度 + tooltip），点击只弹原因、不改变选择，正文仍以 PRIVATE 发出 |
| `resize` | 用真实鼠标拖角：宽高各自独立变化、拖拽中只做 `transform` 预览、松手后落盘到 `popupEditorSize`；方向键 ±24px、双击复位 |
| `drop-multi` | 在编辑器上 drop 两个 PNG：两个都上传、高亮清除、草稿不被清空，发送后 memo 带 2 个附件 |
| `fullscreen-layout` | 全屏页（`--page=popup.html?mode=full`）无整页滚动、编辑区 880 上限且占满剩余高度、发送按钮在视口内、语言/设置按钮仍在视口内 |

## 4. 它做了什么 / 坑

- 扩展 ID：未打包扩展的 ID = `sha256(绝对路径)` 前 16 字节按 0-f → a-p 映射，脚本自行计算，
  不依赖 `chrome://extensions`。
- headless 下 MV3 扩展可用；service worker 可能懒启动，直接开 popup 页最稳。
- 必须等 `window.jQuery && window.MemosApiAdapter` 与 `#saveSettings` 就绪再操作，
  否则事件还没绑定，点击会被静默丢弃。
- `chrome.storage` 是回调式 API：在 `Runtime.evaluate` 里返回 Promise 时必须传
  `awaitPromise: true`，否则拿到 Promise 对象会被误判为“已保存”。
- 设置保存会先探测服务端版本，冷启动容器可能让首次请求失败；脚本会自动重点一次保存。

## 5. 版本号与 CI

- 版本号只有一处：仓库根目录 `VERSION`。改版本用它，不要手改 manifest：
  ```bash
  node tools/set-version.mjs 2026.11.01   # 同时写 VERSION 与三端 manifest
  ```
  `tools/verify/bundles.mjs` 会校验三端 manifest 与 `VERSION` 一致。
- `.github/workflows/verify.yml`：
  - 每次 push / PR：bundle 静态检查 + 矩阵子集（0.15 / 0.23 / 0.26 / 0.31 / 26.10）
  - 每晚 18:00 UTC：完整 16 版本矩阵
  - Browser UI job：起 0.31 容器、装 Chrome for Testing，分别跑根路径与 `--subpath /memos` 两种部署

## 6. 子路径部署

`--subpath /memos` 会在本地起一个反向代理（随机端口），把 `http://127.0.0.1:<port>/memos/`
转发到 `--url`，然后让扩展把这个带前缀的地址当作 `apiUrl`。用于验证反向代理子路径场景：

```bash
node tools/verify/chrome-ui.mjs --url http://127.0.0.1:15400/ --token "$TOKEN" --subpath /memos
```

## 7. Firefox（MV3 + Android）

Manifest V3，但**背景用事件页而不是 service worker**——Firefox for Android 不支持
`background.service_worker`，所以 `background.scripts` 是桌面与移动端都能跑的唯一选择：

```json
"background": { "scripts": ["js/background.js"] },
"permissions": ["tabs", "scripting", "storage", "activeTab", "contextMenus"],
"host_permissions": ["http://*/*", "https://*/*"],
"browser_specific_settings": {
  "gecko": { "id": "...", "strict_min_version": "142.0", "data_collection_permissions": { "required": ["none"] } },
  "gecko_android": { "strict_min_version": "142.0" }
}
```

142 是 `data_collection_permissions`（桌面 140 / Android 142）要求的版本下限，低于它 AMO 会报
`KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION`。

三层验证：

```bash
# 1) AMO 同一套校验器：0 error 才能上传
npx web-ext lint --source-dir firefox

# 2) 真实 Firefox 安装（ID / 版本 / MV3 / 事件页 / Android 下限）
FIREFOX_PATH="/path/to/firefox" node tools/verify/firefox-smoke.mjs

# 3) 事件页在「桌面」和「Android（无 contextMenus）」两种 chrome 对象下的加载
node tools/verify/unit.mjs
```

`unit.mjs` 里用 vm + mock chrome 跑 `background.js`：桌面应创建 3 个菜单，Android 形态下
（`contextMenus` 整个不存在）顶层注册不得抛错——这正是 Android 上最容易炸的地方。

**UI 自动化受限（上游限制）**：BiDi 拒绝导航到 `moz-extension://`（`not allowed in this context`），
Puppeteer / Playwright 也不支持给 Firefox 装扩展，所以 Firefox 的弹窗交互仍需手工
`web-ext run --source-dir firefox`。布局与交互由 Chrome harness 覆盖——两端的 HTML/CSS/JS 是同一份文件，
Chrome MV3 的 CSP 与 Firefox 等价，所以 `chrome-ui.mjs` 能代表 Firefox 的行为。

移动端布局用同一套 harness 在 360×640、`pointer: coarse` 下验证：

```bash
node tools/verify/chrome-ui.mjs --url http://127.0.0.1:15400/ --token "$TOKEN" --mobile
```

断言：无横向溢出（`scrollWidth <= viewport`）、`.body` 的 `min-width` 被移动端规则置 0、
可见性选择器与发送按钮高度 ≥ 40px、选择器右边缘不得滑进发送按钮下方，并照常发布一条 memo。
CSS 用 `@media (pointer: coarse)` 隔离，桌面弹窗外观不受影响（可用 `--screenshot out.png` 目视复核）。

## 8. 全屏页与自由缩放

两者共用 `popup.html`，只是全屏页带 `?mode=full`：body 加 `.fullscreen` 后变成 flex 列，
编辑区 `flex:1` 吃掉剩余高度、内容列 `max-width:880px` 居中、`margin:0` 去掉 100vh 页面
多出来的 16px 滚动。缩放把手是 `role="separator" tabindex="0"`：默认两轴独立、按住 Shift
保持比例、方向键每次 24px（Shift 8px）、Home 或双击复位；拖拽中只改 `transform`（否则
每次 pointermove 都改真实弹窗尺寸会让 Chrome 抖动），松手才落盘 `popupEditorSize`
（旧的 `popupEditorScale` 会迁移）。

```bash
node tools/verify/chrome-ui.mjs --url http://127.0.0.1:15400/ --token "$TOKEN" --scenario resize
node tools/verify/chrome-ui.mjs --page=popup.html?mode=full --viewport 1280x800 \
  --url http://127.0.0.1:15400/ --token "$TOKEN" --scenario fullscreen-layout --screenshot /tmp/fs.png
node tools/verify/chrome-ui.mjs --url http://127.0.0.1:15400/ --token "$TOKEN" --scenario drop-multi
```

拖放上传：整个编辑器都可接收（原来只有 textarea），多文件按顺序逐个上传，文件夹/空文件
跳过并提示，拖入时给编辑区加 `drop-active` 虚线高亮（原来是把整页 opacity 降到 0.3），
上传成功不再清空草稿。

## 9. 右键菜单与快捷键

四个菜单项由一张 `MENUS` 描述表驱动（创建、改标题、点击分发都读它），菜单 id 保持稳定：

| id | 上下文 | 行为 |
|---|---|---|
| `Memos-send-selection` | selection | 选中文本（注入到 `info.frameId`，iframe 里也有效）+ `[Reference Link](<url>)` |
| `Memos-send-link` | link | 链接 URL 原文 |
| `Memos-send-page` | page | 当前页 URL |
| `Memos-send-image` | image | `![](<src>)` |

要点：

- **每次 `onInstalled` 都 `removeAll` 后重建**（不是 `create`）：升级时改名/删项不会残留旧条目，
  也不会撞 “duplicate id”；`create/update` 都带回调吞掉 `lastError`。
- **点击一定有反馈**：先给工具栏徽标打 `✓`（`.setBadgeText`），再尝试打开弹窗；弹窗打开时
  自己清空徽标（事件页不能靠 `setTimeout` 保持状态）。上传进行中或弹窗打不开 → 打 `!`。
- **不再用 `alert()`**：MV3 的 service worker / 事件页没有 UI，旧代码在“上传中点击菜单”时会抛错。
- **文本拼接**：CRLF→LF、行尾空格清理、与已有草稿用空行分隔；URL 含 `)` 或空格时用 `<...>`
  包住（`Foo_(bar)` 这类维基链接否则会被 Markdown 截断）。
- **`Ctrl+Shift+F` 真的能用**：`commands.onCommand` → `action.openPopup`，不支持时回退打开
  全屏页标签（之前 manifest 声明了命令但没有任何监听器）。
- Firefox for Android 没有上下文菜单：`contextMenus` 缺失时整体跳过，不抛错。

验证分两层：

```bash
# 逻辑层：vm + chrome mock，逐项断言写进 storage 的内容、徽标、iframe、上传态、命令回退
node tools/verify/unit.mjs

# 真实层：连上 Chrome 的 service worker，用“重复 id 必然报错”反证四个菜单真的注册了
node tools/verify/background-live.mjs
```

`background-live.mjs` 还会在真实 SW 里调用一次 `handleMenuClick`，断言 `chrome.storage`
里的草稿确实被写成 `https://live.test/a?b=1\n`，并检查全程没有 `Runtime.exceptionThrown`。

## 10. 可见性策略（禁止公开备忘录）

Memos 0.15–0.26 有 `disallowPublicVisibility`（0.27 起移除）。适配层用
`GET instance/settings/MEMO_RELATED` 读取它（普通用户令牌也能读），结果存进
`chrome.storage.sync.disallowPublic`；`oper.js` 据此给 `#lockPublic` 加 `lock-blocked`。

```bash
# 带限制的适配层断言（会自己开 0.26.1 容器并在容器内打开设置）
node tools/verify/memos-api-matrix.mjs --only 0.26.1 --disallow-public

# 真实弹窗：置灰 + 拒绝点击 + 仍能发私有
node tools/verify/chrome-ui.mjs --url http://127.0.0.1:15402/ --token "$TOKEN" --scenario locked-public
```

矩阵里的 `visibilityPolicy` 项对每个版本做双向断言：服务端真能收 PUBLIC 时适配层不得说
「被禁」，服务端 403 时必须说「被禁」。矩阵端口可用 `MATRIX_PORT` 覆盖（默认 15400）。

## 11. 纯函数单测

`node tools/verify/unit.mjs` 覆盖 `parseVersion / eraOfVersion / memoRef / errorInfo / extractTags / normalizeResource`，
不需要 Docker，CI 的 bundle job 会跑。
