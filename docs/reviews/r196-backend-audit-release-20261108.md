# R196 后端审计修复落地与 beta.41 发版

用户 2026-11-08：「我让 gpt 审计后修复完了 bug，你把现在所有没提交的一起提交，并且打包发版。」

## 本轮范围

1. **GPT 后端审计修复**（详见 [backend-audit-20261108](backend-audit-20261108.md)）：
   - [P1] 较晚排队请求的附件/文字提前进入前一个请求的模型输入；
   - [P2] 停止后「继续任务」丢失最后一次执行的成员、模式与研讨子集；
   - 第 1 项「历史图片随上下文发送」经用户复核符合「全部带图」的既定产品决定，保持现状。
2. **此前一直未提交的侧栏「工作区」改动**：工作区标题固定在导航与滚动列表之间、打开/切换项目收进标题右侧（文件夹加号）、删除底部旧入口、空态与手册文案同步；`capture-r193-ui.cjs` 增加对应的几何/滚动断言。
3. **此前未提交的界面文案**（成员管理/看板/文件页空态、用户手册「切换项目」说明）随本轮一并提交。
4. **审计回归转正**：`tests/integration/backendAudit20261108.test.ts`（10 项）纳入默认套件；保留 `scripts/audits/backend-20261108.*` 独立入口。

口径：不改 schema（保持 61）、权限分级、audience、图片能力门与消息/任务合同；不迁移用户数据；不改旧信封与停止代次语义。

## 提交与工作区收口

- 程序提交 `ed51d34`（23 文件：daemon 4、hifi 侧栏 7、daemon 审计回归 2、审计报告/入口 3、手册与版本文件等），版本升 `0.1.3-beta.41`（numericVersion `0.1.3.41`）。
- 按用户要求「所有没提交的一起提交」：此前 R195 拆分提交时保留在工作区的侧栏「工作区」改动（`App.tsx`、`base.css`、`Icon.tsx`、`MembersPage.tsx`、`TasksBoard.tsx`、`LibraryPage.tsx`、`pages-misc.tsx`、`capture-r193-ui.cjs`、手册 README/index）本轮全部提交，工作区不再保留产品代码改动。
- 仍**未**提交的只有此前各轮明确标注为「本机未跟踪」的 R130/R131/R180 混沌检测套件、夹具、历史审计报告与临时脚本：这些是本机一次性对抗资产，其中 `tests/integration/chaosR13x/R18x*.test.ts` 依赖本机历史数据目录，进入默认套件会在干净环境失败；此前续工记录一直按「未跟踪夹具」处理。本轮未纳入提交与安装包，工作区保持原样。

## 验证

- 已跟踪全量测试 + 新增审计回归：**378 文件 / 3387 通过 / 3 预期失败 / 16 跳过 / 0 失败**（`--maxWorkers=4`；排除默认禁用的 GitHub 远端沙箱与 Word COM 验收；约 222 秒）。
- 干净 worktree `dist/r196-source`（`ed51d34`，status 0，dirty=false）：根工程 `tsc --noEmit` **0 错**、hifi `tsc --noEmit -p tsconfig.hifi.json` **0 错**、`build-ui` / `pack-daemon` 通过；复跑单元+浏览器+审计回归通过；`capture-r195-ui.cjs` 与 `capture-r193-ui.cjs` 结果见下。
- 审计修复自身验证沿用 [审计报告](backend-audit-20261108.md)：新增对抗回归 10/10、关联协调/提醒/并行写入 4 文件 76 项、扩大回归 377 文件 3385 通过/16 跳过/0 失败（修复后、本机未跟踪夹具排除）。
- 未调用真实模型、未安装/升级/卸载、未操作用户数据。

## 交付

- 安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.41-x64.exe`：160,216,471 字节，SHA256 `a8a9a14bae78e6c03a6e5e479a49018eb07c39a086d35064872b48b44120bb06`，未签名，附 `.sha256` / `.release.json`。
- 干净 worktree 构建：便携镜像 BUILD `bld_442c3de79ddbffaa`（clean、632 文件 MANIFEST 逐项 SHA256）、安装器 BUILD `bld_c809db5b12a4bc3b`（安装镜像 668 文件 MANIFEST；payload-audit `files=668`、`runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）。
- 记录提交后推送 `main`、创建 tag `v0.1.3-beta.41` 与 GitHub Release（exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.41.md`）；用户自行安装，未覆盖已装 beta.40 与运行数据。
- R195 界面修复与 beta.40 内容见 [R195 记录](r195-ui-feedback-20261108.md)；后端审计细节见 [审计报告](backend-audit-20261108.md)。
