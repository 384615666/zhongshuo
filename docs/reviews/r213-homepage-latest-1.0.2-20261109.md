# R213：产品主页更新到 1.0.2，并自动指向最新 Release

用户 2026-11-09 反馈：今天已发布 1.0.2，但 `https://zhongshuo.lsjx.xyz/` 仍是 1.0.1；要求更新首页，并让以后每次发版首页都自动是最新版本。

## 处理

- **首页 `site/index.html`**：3 个下载按钮的静态回退从 `v1.0.1` 改成 `v1.0.2`；顶栏、首屏、开始使用、页脚 4 处版本号改成 `data-release-version` 挂点；开始使用小节新增 `data-release-page` 的 Release 链接（默认 `releases/latest`）。
- **稳定下载页 `site/download/index.html`（新增）**：`https://zhongshuo.lsjx.xyz/download/` 始终展示最新版本与安装包按钮，可直接作为 README、社交平台或二维码的下载入口。
- **`site/app.js`**：新增「最新版本校准」逻辑——打开页面后请求 `https://api.github.com/repos/384615666/zhongshuo/releases/latest`，把版本号文本、安装包下载地址（按 `Zhongshuo-Setup-*-x64.exe` 匹配）和 Release 链接替换为最新发布；结果按 10 分钟缓存在 `sessionStorage`；离线、接口限流或网络失败时保留页面上的静态回退值，不报错、不改动其它交互。
- **README**：下载按钮改为 `https://zhongshuo.lsjx.xyz/download/`，版本与 SHA256 链接改为 `releases/latest`，不再写死安装包版本。
- **`site/README.md`**：记录自动校准机制、静态回退值、`download/` 稳定入口与 gh-pages 发布步骤。
- **部署**：源码提交 `ee86fef` 推送 `main`；`gh-pages` 提交 `22da7b9` 同步 `site/` 与 1.0.2 操作手册（保留 `CNAME` 与 gh-pages 自带 README）。

## 验证

- `node --check site/app.js` 通过，`eslint site/app.js` 退出码 0。
- 用假 DOM 在 Node 中执行 `site/app.js`（`dist/r213-site/check-site.cjs`，ignored）：成功路径把 4 个版本挂点、3 个下载按钮和 Release 链接更新为 `v1.0.2`；接口失败路径保留静态 `1.0.2` 且不抛错；`sessionStorage` 缓存命中时不再发请求。全部断言 **PASS**。
- Electron 本地渲染两种页面：`/download/` 卡片 680px、无横向溢出；首页无横向溢出；截图留在 ignored 的 `dist/r213-site/`。
- GitHub Pages：`gh-pages` 推送后 build `22da7b9` 状态 `built`（2026-11-09T05:01:07Z）。
- 线上 `https://zhongshuo.lsjx.xyz/`（带缓存刷新参数）：HTTP 200，首屏/顶栏/开始使用/页脚均显示 1.0.2，3 个下载按钮均指向 `releases/download/v1.0.2/Zhongshuo-Setup-1.0.2-x64.exe`，Release 链接指向 `releases/tag/v1.0.2`。
- 线上真实浏览器执行 `app.js`：成功从 GitHub API 读取最新 Release（`sessionStorage` 缓存 `tag_name=v1.0.2`、安装包 URL 与最新资产一致），证明「自动指向最新版」在自定义域上实际生效。
- 线上 `https://zhongshuo.lsjx.xyz/download/`：HTTP 200，显示当前最新版本 1.0.2，下载与 Release 链接正确。
- 线上 `https://zhongshuo.lsjx.xyz/docs/user-guide/index.html`：HTTP 200，版本行为「Windows 桌面版 · 1.0.2 · 图文入门 · 更新于 2026-11-09」。
- GitHub Release `v1.0.2` 为 Latest，资产 `Zhongshuo-Setup-1.0.2-x64.exe`（160,976,533 字节，SHA256 `662d4e4b5f3fe32df9b319d522b2353239b59fe5602709c53b60fe8665a90a0a`）未变。

## 以后发版的行为

- 发布新的 GitHub Release 后，首页与 `/download/` 会在缓存过期（最多 10 分钟）或下次打开页面时自动显示新版本号，并直接链接到新安装包；**不需要重新部署站点**。
- 页面上的静态回退值仍建议在下一次改站点时顺手更新，但不更新也不影响新版展示（仅影响 API 不可达的极少数访问）。
- 自动校准只读取 GitHub 公开的 Release 元数据，不上报访客信息，不引入第三方脚本或统计。

## 边界

- 未修改桌面应用代码，未打包、未安装/升级/卸载，未调用真实模型，未操作用户数据。
- GitHub API 未认证配额为每 IP 每小时 60 次；站点用 10 分钟会话缓存降低请求频率。若访客网络屏蔽 GitHub API，页面保留静态回退版本。
- 安装包链接仍由 GitHub Release 提供；站点不托管安装包本体。

## 部署与线上验证（已执行）

- 源码/文档 `main`：`ee86fef`（站点改动）与本文档提交。
- 发布分支 `gh-pages`：`22da7b9`（deploy: publish Zhongshuo 1.0.2 homepage, latest-download page and 1.0.2 user guide），保留 `CNAME=zhongshuo.lsjx.xyz`。
- GitHub Pages 构建：commit `22da7b963132889135030996b1a4be04e0c7fd06`，status `built`。
