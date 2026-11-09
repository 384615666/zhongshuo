# 众说 · 产品主页

`site/` 是众说的对外产品主页，纯静态页面，不参与桌面应用构建。页头、页脚、首屏和站点图标使用根目录 `logo.png` 派生的网页版本；正式品牌源文件仍为仓库根目录 `logo.png`。

## 打开方式

直接用 Chrome / Edge 打开 `site/index.html`（双击即可）。页面不加载外部字体、第三方脚本或统计代码，离线也能完整显示。

从仓库根目录打开时，页脚的「离线手册」会跳到 `docs/user-guide/index.html`，可正常阅读。若把 `site/` 单独部署到静态托管，需把该链接改为线上手册地址，或把 `docs/user-guide/` 一并发布。

## 文件

| 文件 | 说明 |
| --- | --- |
| `index.html` | 页面结构与文案 |
| `styles.css` | 全部样式；品牌色沿用桌面应用的蓝绿渐变与中性面 |
| `app.js` | 顶栏状态、移动端导航、滚动出现、大图查看、复制构建命令，以及按 GitHub 最新 Release 校准版本号与下载链接 |
| `download/index.html` | 稳定的「下载最新版」入口；版本号与下载按钮同样在打开时校准 |
| `assets/logo.png` | 仓库根目录正式 logo 的原样副本，供页面资源与分享引用 |
| `assets/logo-mark.png` | 从正式 logo 裁去多余白边得到的网页横版标记（页头、页脚、首屏） |
| `assets/favicon.png` | 从正式 logo 生成的方形站点图标 |
| `assets/shots/*.png` | 真实桌面界面截图（2720×1840，2 倍像素密度） |

页面引用的截图：`room.png`、`brainstorm.png`、`review.png`、`audit.png`、`thread.png`、`preview.png`、`board.png`、`dm.png`、`dark-room.png`。同目录其余截图（`welcome.png`、`work.png`、`members.png`、`project-home.png`、`discussion.png`）由截图脚本一并生成，备用，不参与页面加载。

## 协作方式、跨 harness 与示例

「02 协作方式」按用户意图分成四组：让它做事（自动协作 / 指定成员 / 多人分工，附计划模式说明）、让它一起想（共同研讨 / 简短交流）、单独与记录（私信 / 文件评论）、继续这件事（原串继续 / 停止、验收与返工）。其中共同研讨对应正式独立研讨（DELIBERATE）：默认只读，不直接改文件。

「03 跨 harness 协作」解释与「子代理」的区别：子代理通常继承父 agent 的模型、工具和上下文，而众说里的每个 AI 成员运行在自己的 harness（Claude Code、Codex 等），各自保留 MCP、记忆与 skill，在同一个项目/房间层交接、评审和验收。这一节用白色平面分层做 2D 爆炸图（项目层 / 调度层 / 原生 harness 层），层间用虚线与上下箭头说明任务向下派发、结果向上回到原串；窄屏时三层自动收窄并纵向排列。

「04 示例」放三个真实场景：头脑风暴（多位 AI 从用户价值、增长、成本角度发散，再归类收敛）、方案评审（产品、架构、风险独立评审后互评）、多名专家代码审计（安全、并发、测试覆盖分头审计后交叉复核）。三个示例都来自隔离的合成项目「会员系统重构」，只用于展示真实界面的样子，不表示对真实模型输出的承诺。示例下方另列「还能这样用」：决策对比、多版本起草、资料核对、问题排查、文案与命名、学习与解释。

## 重新生成截图

截图使用隔离的合成示例项目（读书会筹备、会员系统重构）和 Fake 运行时拍摄，不读取用户数据、不调用真实模型；`discussion.png` 另有「发布准备」示例备用。

前置条件：Windows、Node.js 24、已执行 `pnpm install`，并已按根目录 README 完成一次桌面构建，确认存在 `dist/ui/main.cjs` 与 `dist/pack/daemon.cjs`（`node scripts/make-desktop-daily.mjs desktop-daily-win-local` 会同时生成）。只改了界面时，先 `pnpm build:ui`；daemon 产物可用 `node scripts/pack-daemon.mjs` 更新。然后：

```powershell
pnpm build:ui
node scripts/capture-homepage-shots.cjs
node scripts/capture-homepage-cases.cjs
```

只重拍部分页面：

```powershell
node scripts/capture-homepage-shots.cjs --only=room,thread,board
```

案例截图由独立脚本生成：它用隔离项目「会员系统重构」的三个房间（头脑风暴 / 方案评审 / 代码审计）各跑一次 Fake 独立研讨（`ZS_FAKE_DELIB=1` / `ZS_ENABLE_DELIBERATE=1`），截取多位成员独立分析、互评和阶段标签的画面，写入 `brainstorm.png`、`review.png` 与 `audit.png`。

```powershell
node scripts/capture-homepage-cases.cjs
```

可选的 `discussion.png`（发布准备示例）由独立脚本生成：

```powershell
node scripts/capture-homepage-discussion.cjs
```

脚本每次在 `dist/homepage-shots/run-<id>/` 下建立独立数据根与项目目录，并写入 `site/assets/shots/`。运行记录、失败截图和日志都留在 `dist/homepage-shots/`，不会进入版本库。

## 最新版本与下载入口

- 页面上的版本号（`data-release-version`）、下载按钮（`data-release-download`）与 Release 链接（`data-release-page`）在打开时由 `app.js` 请求 GitHub Releases API 的 `releases/latest` 校准；发新版后无需重新部署页面，首页与 `download/` 自动指向最新安装包。
- 请求结果在 `sessionStorage` 中缓存 10 分钟；离线、限流或接口不可用时保留静态回退值，当前为 `1.0.2`。静态回退值随站点部署一起更新。
- `download/` 是稳定的分享入口（`https://zhongshuo.lsjx.xyz/download/`），始终展示最新版本与下载按钮。
- 页面只读取公开的 Release 元数据，不上报访客信息；Release 仍是版本与 SHA256 的唯一事实来源。

## 部署（gh-pages）

线上 `https://zhongshuo.lsjx.xyz/` 由仓库 `gh-pages` 分支发布（`CNAME=zhongshuo.lsjx.xyz`，DNS CNAME 指向 `384615666.github.io`）。发布时把 `site/` 下的 `index.html`、`styles.css`、`app.js`、`download/`、`assets/` 与 `docs/user-guide/` 同步到 gh-pages 根目录，保留 gh-pages 自带的 `CNAME` 与 `README.md`，提交并推送；GitHub Pages 构建完成后线上生效。版本号由页面运行时自动校准，日常发版不需要为版本号改页面。

## 文案边界

页面事实以根目录 README 与 `docs/user-guide/README.md` 为准。1.0.2 发版时已同步：

- 下载按钮的静态回退指向 `v1.0.2` 的 `Zhongshuo-Setup-1.0.2-x64.exe`，运行时自动校准到最新 Release；后续发版不再需要手工改链接。
- README 的下载入口指向 `https://zhongshuo.lsjx.xyz/download/`（始终最新版），不再写死安装包版本。
- 「数据不出本机」仍不写：聊天与文件保存在本机，但 AI 请求会经 Claude/Codex 等渠道发出。
- 「主题偏好会保存」仍不写：深色主题可切换，但已知重启后会回浅色。
- 页面标注当前版本号；不再写「项目仍在持续开发中」。安装包未配置代码签名，页面已注明。

如果后续能力变化（例如修复深色主题持久化或调整发行方式），再同步更新对应文案。
