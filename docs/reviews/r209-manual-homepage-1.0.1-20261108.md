# R209 操作手册更新 + 产品主页上线（1.0.1）

用户 2026-11-08 反馈：操作手册还是旧版；README 里的产品首页应指向 `https://zhongshuo.lsjx.xyz/`；线上首页没更新、现在已能下载。

## 操作手册

- 重新运行 `capture-user-guide.cjs` 采集当前 1.0 界面截图：
  - 24 张场景截图全部更新（`02-workspace` … `26-thread-members`），安装向导/安装完成两张保留；
  - 修复截图脚本两处过期定位：文件预览的下载入口已并入「更多文件操作」菜单（原 `[aria-label="下载原文件"]` 不存在）；深色设置页原 `/settings?section=general` 已不存在，改为 `appearance` 分区。
- 手册正文更新：
  - 版本行改为「Windows 桌面版 · 1.0.1」；
  - 设置章节分区改为「外观 → 通知 → AI 设置 → 数据与存储 → 帮助与关于」，注明设置页不再显示说明性小字、草稿设置和状态文字；
  - 文件预览保存步骤改为「更多文件操作 → 下载原文件 / 另存为…」并更新截图 alt/编号；
  - 删除已不存在的「对话串通知」说明；
  - 其余前几轮已同步的内容（成员卡片直达 AI 设置、回复串页签、参与成员、图片路径复制等）保留。
- 重新生成 `docs/user-guide/index.html`（应用内版与离线版使用同一源），图片随手册打包。
- 手册 HTML 的截图与文案由 `build:ui` 打包进安装包；1.0.1 安装包因此包含新手册。

## README 与产品主页

- README 两处「产品主页」链接改为 `https://zhongshuo.lsjx.xyz/`（不再指向仓库内 `site/index.html`）。
- 产品主页本就托管在 **本仓库 gh-pages 分支**（GitHub Pages，自定义域 `zhongshuo.lsjx.xyz`，DNS CNAME 指向 `384615666.github.io`），此前只更新了 main 里的 `site/`，gh-pages 仍是旧版（Last-Modified 2026-11-01、无下载按钮）。
- 本版把当前 `site/index.html`、`styles.css`、`app.js`、`site/assets/*` 以及 `docs/user-guide/{README.md,index.html,images/*}` 同步到 gh-pages，保留 `CNAME`；GitHub Pages 构建完成后线上首页应显示 1.0 正式版与下载按钮，离线手册链接也可访问。
- 首页/README 的下载链接统一为 `v1.0.1` 的 `Zhongshuo-Setup-1.0.1-x64.exe`。

## 版本与验证

- 版本 `1.0.1`（numericVersion `1.0.1.65535`），安装包 `Zhongshuo-Setup-1.0.1-x64.exe`。
- 手册采集 26 场景全部通过；`build:ui`/`pack-daemon` 通过；设置页/界面回归与全量测试见交付记录。
- 线上验证：部署后抓取 `https://zhongshuo.lsjx.xyz/` 断言包含「1.0 正式版」「下载 Windows 版」与 v1.0.1 安装包链接；`/docs/user-guide/index.html` 返回 200 且包含新手册文案。
- 未在本机安装/升级/卸载，未操作用户数据，未调用真实模型。

## 交付

- 程序/文档提交 `9c69bd5`。
- 干净 worktree `dist/r209-source`（status 0，`dirty=false`）构建：便携镜像 BUILD `bld_4fc20640e91bbb56`（clean、633 文件 MANIFEST）、安装器 BUILD `bld_0707cfc0cf2954c9`（安装镜像 670 文件 MANIFEST；payload-audit `runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）。
- 安装包 `dist/installers/Zhongshuo-Setup-1.0.1-x64.exe` **160,479,283 字节**，SHA256 `90224507bdede1a399ff047f316a6d7ab859c1e85ae583b9329e0043228d9f4c`，未签名；本记录提交后推送 `main`（`9c69bd5` + 记录提交）、创建 tag `v1.0.1` 与 GitHub Release「众说 1.0.1」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/1.0.1.md`）；用户自行安装。

## 已知边界

- 操作手册的安装向导两张截图（21/22）仍是旧截图，安装器界面未变化；其余截图均为当前 1.0 界面。
- gh-pages 部署为静态页面，无构建步骤；后续主页/手册改动需再次同步 gh-pages。
- 线上 CDN 可能有缓存，部署后验证以 GitHub Pages build 状态与最终抓取为准。
