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
`--scenario success|public-forbidden|invalid-token`、`--subpath /memos`、`--text`（发送内容）。

场景：

| `--scenario` | 期望 |
|---|---|
| `success`（默认） | toast「发送成功」，服务端能查到该条 |
| `public-forbidden` | 服务端禁用公开时，toast 指出具体原因且不产生 memo |
| `invalid-token` | 保存阶段即提示令牌无效/URL 错误，不写入设置 |
| `upload` | 通过真实文件选择框上传 PNG，空正文发送后服务端 memo 带 1 个附件 |
| `locked-public` | 服务端禁用公开时，「公开」置灰（`not-allowed` + 透明度 + tooltip），点击只弹原因、不改变选择，正文仍以 PRIVATE 发出 |

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

## 7. Firefox（MV2）

`tools/verify/firefox-smoke.mjs` 用 WebDriver BiDi 的 `webExtension.install` 把 `firefox/` 装进真实 Firefox，
断言扩展被接受（ID 与 manifest 版本一致）：

```bash
FIREFOX_PATH="/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox" \
  node tools/verify/firefox-smoke.mjs
```

**UI 自动化受限（上游限制，不是配置问题）**：Firefox 的 BiDi 拒绝导航到 `moz-extension://`
（`not allowed in this context`），Puppeteer / Playwright 也都不支持给 Firefox 装扩展。
因此 Firefox 的弹窗交互目前只能手工验证：
`web-ext run --source-dir firefox` 后点扩展图标。逻辑层由三端字节一致的 adapter + 16 版本矩阵覆盖。

## 8. 可见性策略（禁止公开备忘录）

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

## 9. 纯函数单测

`node tools/verify/unit.mjs` 覆盖 `parseVersion / eraOfVersion / memoRef / errorInfo / extractTags / normalizeResource`，
不需要 Docker，CI 的 bundle job 会跑。
