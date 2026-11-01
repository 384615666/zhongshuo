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
| `app.js` | 顶栏状态、移动端导航、滚动出现、大图查看、复制构建命令 |
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

## 文案边界

页面事实以根目录 README 与 `docs/user-guide/README.md` 为准，刻意不写：

- 「下载安装包」：当前 GitHub Releases 为空，只提供源码与构建步骤；
- 「数据不出本机」：聊天与文件保存在本机，但 AI 请求会经 Claude/Codex 渠道发出；
- 「主题偏好会保存」：深色主题可切换，但已知重启后会回浅色；
- 「稳定版 / 生产级」：项目仍在持续开发中。

如果后续能力变化（例如发布安装包或修复深色主题持久化），再同步更新对应文案。
