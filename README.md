一款通过浏览器插件发布 [Memos](https://usememos.com/) 的插件。基于 iSpeak-bber 修改，原作者为 [DreamyTZK](https://www.antmoe.com/)。

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/jonnyan404)

## 更新日志

- 当前支持memos `v0.15.0 - 26.10+` [点击查看详细更新日志](https://raw.githubusercontent.com/Jonnyan404/memos-bber/refs/heads/main/change.log)

## 在线商店安装

- Chrome 应用商店：https://chrome.google.com/webstore/detail/memos-bber/cbhjebjfccgchgbmfbobjmebjjckgofe/
- FireFox 应用商店: https://addons.mozilla.org/zh-CN/firefox/addon/memos-bber/
- (等待上架)Edge: 使用离线安装包或者直接使用 chrome 扩展

## 移动端

Android
- 可直接用 chrome 扩展: https://github.com/uazo/cromite/releases
- firefox 手机版（需 Firefox for Android 142+，插件已按移动端调整布局）: https://addons.mozilla.org/zh-CN/firefox/addon/memos-bber/
- edge 手机版

### 使用教程

- 在文本框输入想搜索的关键字,点击搜索按钮
- 随机和搜索功能在所有受支持版本中都包含自己的私有 memo
- 顶部新增两个图标入口：Ko-fi 赞赏与 GitHub 仓库；两个链接只在 `js/config.js` 里维护一处，三端同时生效
- 右键菜单可发送「选中文本 / 链接 / 当前页 / 图片」到草稿：发送后工具栏图标会显示 ✓，点开弹窗即是草稿
- `Ctrl+Shift+F`（macOS `Ctrl+Shift+F`）直接打开编辑弹窗

## 开发与校验

扩展本身**没有运行时依赖**（jQuery 3.7.1 与 dayjs 以文件形式内置），`devDependencies` 只用于开发期工具：

```bash
npm ci                 # 只安装 eslint / web-ext
npm run lint           # ESLint（no-undef / no-redeclare / no-unused-vars）
npm run audit          # 仅审计生产依赖（0 漏洞）
npm test               # = npm run verify：三端静态一致性 + 纯函数单测
```

更完整的验证（需要 Docker / Chrome / Firefox）见 `tools/verify/README.md`。
