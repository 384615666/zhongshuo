# R193 侧栏对齐与旧样式泄漏修复（2026-11-08）

## 用户反馈

1. 2026-11-08，用户发来侧栏截图（安装版 beta.37，125% 缩放，项目为 VoiceMeeter-backup 等真实数据），说「左侧边栏总看得不顺眼，你知道怎么回事吗」，要求定位原因。
2. 看到原因说明后，用户要求：「一起都靠左一点吧，然后打包发版推送」——把剩余 4px 的图标列差异按「统一靠左」处理，并构建安装包、发版、推送。

## 诊断（根因）

不是错觉，是**旧界面的 CSS 泄漏到 hifi 侧栏**。

同一份 `dist/ui/renderer/index.html` 会先加载旧界面 `renderer/style.css`，再由 hifi `main.tsx` 注入 `hifi/app.css`。旧样式里也有一条：

```css
.sidebar { width: 240px; ... padding: 12px; gap: 10px; overflow-y: auto; }
```

hifi 的 `.sidebar` 只声明了 `width: 246px`、背景、边框和 `overflow`，**没有声明 `padding` / `gap`**，因此旧规则的 `padding: 12px` 与 `gap: 10px` 继续命中新侧栏。实测（用 beta.37 安装版的 CSS 在隔离渲染器里复现，坐标与用户截图一致）：

| 位置 | 设计值 | beta.37 实际 |
|---|---|---|
| 选中竖条 `::before` | x=0（贴窗口左缘） | x=12（悬在侧栏内） |
| 顶部导航图标 | x=32 | x=44 |
| 项目图标 / 项目名 | 36 / 57 | 48 / 69 |
| 房间名 | 57 | 66 |
| 「设置」图标 | 32 | 28 |
| 每行名称可用宽度 | 230 | 少 24px |

同时旧规则的 `gap: 10px` 让顶部导航、项目区、底部设置三段之间多出 10px 间距。另有两处与泄漏无关、但和 CSS 注释自相矛盾的对齐偏差：底部「设置」比顶部导航图标左突 16px；房间名比项目名左 3px（`--control-icon-compact` 是 24px，旧注释仍按 22px 的箭头宽度写 padding）。

为什么一直没被发现：旧脚本 `verify-r135-sidebar.cjs` 自己手写的 `index.html` 只加载 hifi 的 `app.css`，没有加载真实页面的 `style.css`，所以侧栏几何断言看不到生产页面的组合；R192 起的隔离截图虽然加载真实页面，但没有侧栏坐标断言。

## 实现

只改 `src/ui/hifi/styles/base.css`（另新增一个隔离回归脚本）：

1. `.sidebar` 显式补 `padding: 0; gap: 0;`，阻断旧界面同名类泄漏，并写明原因。修复后选中竖条回到 x=0。
2. `.sidebar-foot > .side-item` 补 `padding-left: 24px`；「恢复任务 / 设置」与顶部五个一级入口共用图标基线（8 + 24 = 32）。
3. 项目树与一级导航统一靠左：`.side-row` 的 `gap: 2px` 归零、`.side-item-label-btn` 左内边距 2px 归零、`.side-item.sub` 的 `padding-left` 由 16px 改为 12px。最终所有图标（导航 / 项目 / 房间状态位 / 设置）都在 **x=32**；项目名与房间名在 **x=53**，导航与设置名称在 **x=54**（1px 差来自 14px 导航图标与 13px 树图标，肉眼不可见）。
4. 新增 `scripts/capture-r193-ui.cjs`：在真实 `index.html` 组合（同时加载 legacy 样式）+ 隔离数据 + 假运行时里断言侧栏 20 项几何，包含 `.sidebar` 四边 padding=0、gap=0、全部图标 x=32、名称列 53/54、选中竖条 x=0 且宽 3px、无行溢出。

没有改 daemon 命令合同、schema 61、权限/audience 与任何数据；只动 hifi 样式、版本号与验证脚本。

## 验证

- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.hifi.json`：0 错。
- `node scripts/build-ui.mjs`：通过（仅既有 `import.meta` CJS 警告）。
- 新增 `scripts/capture-r193-ui.cjs --run=r193-verify`：真实页面组合下 **20/20 断言通过**，证据 `dist/r193-ui/r193-verify/`（`01-library.png`、`02-sidebar.png`）。
- 回归 `scripts/capture-r192-ui.cjs --run=r193-sidebar-unified`：R192 的 10/10 断言通过，确认消息图片、收藏搜索、头像、设置页无回归。
- `tests/unit` + `tests/browser`：138 文件 / **982 项通过**。
- 旧 `verify-r135-sidebar.cjs` 仍无法构建（脚本没有为后来新增的头像 PNG 配置 loader），属历史脚本问题，与本轮无关，未作为门禁。
- 安装包构建见下方交付；未安装、未升级、未启动安装版、未操作用户运行数据、零真实模型调用。
- 包内核对：安装镜像 `resources/app/dist/ui/renderer/hifi/app.css` 与主仓构建产物按换行归一后**逐字节一致**，修复确实进包；`installed-desktop.json` 与两个 PE 版本资源均为 `0.1.3-beta.38` / `0.1.3.38`；安装器 EXE 签名状态为 `NotSigned`。

## 交付

- 程序提交 `b5ed75c`（含版本 `0.1.3-beta.38`：`package.json`、`packaging/windows/release.json`、`base.css`、`capture-r193-ui.cjs`）。
- 干净 worktree `dist/r193-source`（`b5ed75c`，status 0，node_modules junction）构建：
  - 便携镜像 BUILD `bld_c0a36980380b43a0`（clean、632 文件 MANIFEST 逐项 SHA256 复核通过）；
  - 安装器 BUILD `bld_b9e01d704d38ef22`；安装镜像 668 文件 MANIFEST 逐项 SHA256 复核通过，payload 审计 `privacyScanPassed=true`、`dataFilesIncluded=false`。
- 安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.38-x64.exe`：**160,218,557 字节**，SHA256 `16ddd6a1e76066caf026a2aece82bf695edb0c4eb6a4b881ab6d64ab930dd495`，未签名；附 `.sha256` 与 `.release.json`。
- 推送 `main`，创建 tag `v0.1.3-beta.38` 与 GitHub Release（不覆盖用户已安装的 beta.37；由用户自行安装）。
