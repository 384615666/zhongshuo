# R200 对话串页签简化 + 串内成员管理（另一 AI 的改动，主控提交打包）

## 来源与范围

另一个 AI 在 `D:/zhongshuo-public` 工作区完成了一批未提交改动（7 个已跟踪文件 + 1 张新手册截图），用户要求「另一个 ai 也修改了代码，你一起帮他提交打包」。主控未改其设计，按原样提交并在干净 worktree 复验、打包。

改动内容：

- **对话串页签简化**：`src/ui/hifi/lib/threadNav.ts` + `src/ui/hifi/pages/Room.tsx`（-478 行）把常驻页签收敛为 **回复 / 成果（讨论串为附件）/ 参与成员**；移除「详情」页签及其内部分组（任务概况、活动与进展、运行详情、研讨记录）。串顶任务状态条、继续/结束任务与成果确认入口保留；旧 `?tab=task/activity/run/deliberation` 深链映射到「参与成员」，`?tab=delivery` 仍打开成果确认（不出现旧详情分组）。
- **串内成员管理**：新增「参与成员」页（`data-zs-thread-members`），列出本串成员，可「移出」「添加到本串」；写入走既有 `thread.members.change`（expectedVersion 版本核对，CAS 冲突刷新重试）；成员页只读名单，不加载任务详情；移出后该成员不再收到本串后续消息。
- **用户手册同步**：`docs/user-guide/README.md` 第 4/6/12 节按新页签改写（不再引导「详情 → 活动与进展 / 运行详情」），新增 `images/26-thread-members.png`，`images/08-progress.png` 更新为新的状态条界面；`index.html` 由手册重新生成。
- **回归辅助同步**：`tests/browser/helpers/r153ProductNavigation.cjs` 改为新线程导航断言（成员页、`thread.members.change` 版本号 v1→v2、交付仍在成果下、成员页不读 `task.details`）；`scripts/lib/user-guide-scenes.js` 第 8/26 场景改为新界面。

## 验证（主控在干净 worktree 复验后打包）

- 已跟踪全量测试（含该 AI 更新的 R153 helper）：**379 文件执行，377 通过 / 2 跳过；3394 通过 / 3 预期失败 / 16 跳过 / 0 失败**（`--maxWorkers=4`，约 236 秒）。
- 隔离 Electron 界面回归：`capture-r193-ui.cjs` **25/25**（侧栏）、`capture-r195-ui.cjs` **41/41**（图片预览/引用/操作条/带鱼屏/名字）、`capture-r197-ui.cjs` **23/23**（图片绝对路径/右键复制/通知图标 ICO）；截图见 `dist/r193-ui/r200/`、`dist/r195-ui/r200/`、`dist/r197-ui/r200/`。
- 干净 worktree `dist/r200-source`（`ac912d9`，dirty=false）：根 `tsc --noEmit` **0 错**、hifi tsc **0 错**、`build-ui`/`pack-daemon` 通过；单元+浏览器 **140 文件 / 994 项通过**。
- 未在本机安装/升级/卸载，未操作用户数据，未调用真实模型。

## 交付

- 程序提交 `ac912d9`（10 文件：Room/threadNav/手册三件/场景脚本/R153 helper/两个版本文件 + 新截图），提交说明注明「Submitted as-is from another AI's working tree」；版本升 `0.1.3-beta.45`（numericVersion `0.1.3.45`）。
- 干净 worktree `dist/r200-source` 构建：便携镜像 BUILD `bld_72b5d4d92176992c`（clean、633 文件 MANIFEST 逐项 SHA256）、安装器 BUILD `bld_f774d3f688aa2d15`（安装镜像 670 文件 MANIFEST；payload-audit `files=670`、`runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）。
- 安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.45-x64.exe` **160,445,224 字节**，SHA256 `b8f02d1e614b6bbfca913859232da624cbe9033c5f69d5adac4d957ec2ddb0d5`，未签名；本记录提交后推送 `main`（`ac912d9` + 记录提交）、创建 tag `v0.1.3-beta.45` 与 GitHub Release「众说 0.1.3-beta.45」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.45.md`）；用户自行安装。

## 已知边界

- 旧链接兼容只做路由映射，不改历史数据；已移除的「详情」分组内容（活动/运行/研讨的历史视图）不再有独立页面，相关事实仍在回复、成果、成员页与恢复面板呈现。
- 串内成员变更沿用既有 `thread.members.change` 权限与版本核对；被移出成员不再收新消息，历史消息保留。
- 该 AI 未附设计说明文档；本记录按实际 diff 与手册改动整理，未扩大其设计范围。
