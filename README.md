# 众说（zhongshuo）

本地项目群聊多 Agent 协同工作台：以文件夹为项目，在群聊中组织多个 CLI agent 完成工作；仿照 Raft 的协作体验，控制面与工作记录保存在本机。

**日常使用先看 [众说 V51 操作手册](docs/user-guide/README.md)**（[离线 HTML 版](docs/user-guide/index.html)）：包括执行状态、找回刚才的发送、桌面通知与静音、原答与补交版，附操作步骤、界面图和常见问题。桌面包根目录也有 `众说操作手册.html`，双击即可阅读。下方早期原型与设计记录保留作历史参考。

本目录承载设计资料（含 Obsidian 配置）与交互原型，**自 2026-09-25 起已在 `D:\zhongshuo` 初始化 Git 仓库**（分支 `main`，见下方「仓库」一节）；目录归属与迁移安排见[目录方案](docs/workspace-layout-proposal.md)，正式开发前的待办见 [docs/pre-development-checklist.md](docs/pre-development-checklist.md)。

## 原型（2026-09-19）

**现行原型：[hifi-prototype/](hifi-prototype/) — Electron 桌面客户端**（React + TypeScript + Vite）

- `pnpm install && pnpm run build && pnpm run desktop` 启动原生窗口（含系统托盘、原生目录选择器、关闭窗口缩托盘）
- [hifi-prototype/README.md](hifi-prototype/README.md) — 桌面能力表、路由与截图对照、硬约束落点、已知边界
- [hifi-prototype/screenshots-desktop/](hifi-prototype/screenshots-desktop/) — 真实 Electron 窗口截图 12 张；[screenshots/](hifi-prototype/screenshots/) — 浏览器逐页 24 张
- 状态：业务内核仍是内存态（无 daemon/SQLite/runtime 适配器，刷新即回种子），但**桌面外壳是真的**：窗口/托盘/原生对话框/单实例锁/contextIsolation 桥接均可用 `node scripts/verify-desktop.mjs` 复验
- 可复跑的验证：各套件的**最新通过数**以 [hifi-prototype/README.md 的「验证状态」](hifi-prototype/README.md) 为准（本文不再重复，避免再次过期）。截至 2026-09-25：`verify-default-ai-input.mjs` 39/39、`verify-declutter.mjs` 109/109、`smoke.mjs` 28/28、`verify-visual.mjs` 48/0/1跳过、`verify-nav.mjs` 121/121、`verify-desktop.mjs` 8/8，Electron 全套件与 9335 批次全绿

**历史原型（不作为依据）**：[docs/zhongshuo-hifi-prototype-v1.html](docs/zhongshuo-hifi-prototype-v1.html)（v1.8）、[docs/zhongshuo-ui-prototype.html](docs/zhongshuo-ui-prototype.html)（v1.5 草图）、[prototype/](prototype/)（早期 React 尝试）—— 均已在文件头标注"已过时"，保留作历史记录。

## 权威文档

- **2026-09-26 开工基线 v1.23**：[契约与收口](docs/development-baseline-v1.23.md)、[137 项分批与发布依赖](docs/development-delivery-matrix-v1.23.md)。R4/R5/R6/E11/MCP 预留/LAN 已完成设计，DEV-01 同步；B6、真实 M0 与原生模块仍须实施验证，不能把文档当运行证据。
- **本轮文档交付**：[五项要求的收口报告](docs/dev-briefs/pre-development-closeout-v1.23.md)、[原型到真实工程的闭环交接](docs/dev-briefs/prototype-to-runtime-handoff-v1.23.md)。按用户最新要求只做文档，不继续原型测试；报告中的设计完成不代表实现验收。

- [docs/zhongshuo-development-design-v1.md](docs/zhongshuo-development-design-v1.md) — 开发设计报告，**唯一权威版本**（文件名中的 v1 保持稳定，当前 **v1.23**；2026-09-26 新增 §14.7：多 Agent 并行写入增强**已延期、未批准施工**，当前以同一物理目录默认单写者完成闭环，探索记录见 [docs/zhongshuo-parallel-write-exploration-v1.md](docs/zhongshuo-parallel-write-exploration-v1.md)，候选设计稿见 [docs/zhongshuo-parallel-write-intent-gate-v1.md](docs/zhongshuo-parallel-write-intent-gate-v1.md)（已标注延期）；项目设置独立于应用设置，导航、文件/Git 合页、项目分组看板和可选验收沿用；2026-09-25 起输入区**默认交给 AI**、私聊收敛为 1 对 1（§0.19–§0.22）；同日新增 **§31 MCP 接入层**（E25/ADR-16/RT-28/FULL-11，不进 v0.1、预留条款即时生效），**v1.20/v1.21 已吸收三轮外部评审修订**——协议勘误、Tasks/MRTR 采用边界（首批不采用）、身份/授权契约与提交型工具幂等键收口（§0.24/§0.25）。历史 B1—B5 验证不代替 B6 权限验证；E11/E13 与 R4—R11 的工程设计已由 v1.23 收口，代码/schema 和真实验证按工作包完成）
- [docs/product-decisions-guide.md](docs/product-decisions-guide.md) — 产品决策指南（48 项逐项讲解：背景/选项/优劣/推荐）
- [docs/product-decisions-checklist.md](docs/product-decisions-checklist.md) — 产品行为与功能待确认清单（48 项，含确认记录；原始清单，已加历史提示）
- [docs/pre-development-checklist.md](docs/pre-development-checklist.md) — 正式开发前待办清单
- [docs/zhongshuo-prompts-v0.1.md](docs/zhongshuo-prompts-v0.1.md) — 提示词规格 v0.1：常驻提示词模板、三层注入规则与程序执行边界（对应清单 E13/R9，建议承载 DEV-21）
- [docs/dev-briefs/prototype-optional-task-review.md](docs/dev-briefs/prototype-optional-task-review.md) — 任务验收可选功能：原型修改说明、页面映射和验收用例；文档已定，原型待实现
- [docs/dev-briefs/prototype-sidebar-project-navigation.md](docs/dev-briefs/prototype-sidebar-project-navigation.md) — 第十五批原型交接：侧栏顺序、顶栏多选、文件/Git 合页、项目分组看板与 Runtime 收入设置；包含旧路由兼容与回归用例
- [docs/dev-briefs/prototype-settings-separation.md](docs/dev-briefs/prototype-settings-separation.md) — 第十六批原型交接：各项目独立设置单页、底部应用设置、表单简化和旧链接兼容；覆盖上一批设置混合展示规则

## 仓库（Git，2026-09-25 初始化）

- **仓库根 = 本目录 `D:\zhongshuo`**（设计资料 + 原型同仓），分支 `main`；初始提交 `84a2250`「chore: 初始化仓库，导入当前工作区状态」。
- **远端**：GitHub **私有**仓库 <https://github.com/384615666/zhongshuo>（账号 `384615666`，用 `gh auth login` 登录；2026-09-25 首次推送，`origin/main` 与本地 `main` 同 commit）。新克隆：`git clone https://github.com/384615666/zhongshuo.git && cd zhongshuo/hifi-prototype && pnpm install && pnpm run build`。
- **纳入版本库**：`docs/`（设计报告、决策清单、任务书与施工报告等文本与设计资产）、`hifi-prototype/`（源码 `src/`、回归脚本 `scripts/`、Electron 宿主 `electron/`、配置与 README）、`design-shootout/` 与 `prototype/` 的内容部分。
- **有意忽略**（见根 `.gitignore`）：`node_modules/`、`dist/` 构建产物、`*.log`、`archive/`（无 Git 时期的大体量快照副本，含 452MB node_modules）、各截图目录与 `gui-test-screenshots/`（都可由 `scripts/shot-*.mjs` 重新生成）、`.obsidian/`、`.qoder/`。
- **拿到新克隆后**：`cd hifi-prototype && pnpm install && pnpm run build` —— `dist/` 与 `node_modules/` 不入库，Electron 宿主跑的是构建产物。
- 提交约定：本仓库提交使用本机 Git 全局身份；施工报告与 README 里的"通过数/证据"仍按各套件真实输出填写，不因有 Git 而放宽。

## 开发

- **全功能正式施工入口（GLM‑5.3）**：[施工总任务书](docs/dev-briefs/full-implementation-brief-glm5.3.md)。用户已确认原型与开工准备完成；该文档定义 M0—M3、DEV 与 FULL-01—11 的持续施工、验收、进度与续工要求，末尾附可直接发送的启动指令。

### 正式工程（2026-09-27 起，分支 `codex/full-implementation`）

- **运行与验证**：仓库根 `pnpm install && pnpm check`（= `tsc --noEmit` + `eslint .`（六边界 import 规则）+ `vitest run`）。当前 **DEV-01—05 已完成并验证**（契约/路由、SQLite 事务与 outbox、fake adapter、目录/锁域/基线、daemon 派发/停止/恢复核心；192/192 测试；报告见 [docs/implementation/reports/](docs/implementation/reports/)）。
- **结构**：`src/` 六边界（contracts / domain / persistence / adapter / daemon / ui，主设计 §8.4 C6）+ `tests/`。contracts 与 domain 已实装；persistence/adapter/daemon/ui 为骨架（分别由 DEV-02/03/04-05/07 起承载）。技术栈：Node ≥24、TypeScript 6.x strict、zod 4、Vitest 5、ESLint 10（依赖锁定见 `pnpm-lock.yaml`）。
- **施工总账**：[docs/implementation/implementation-status.md](docs/implementation/implementation-status.md)（DEV/FULL 包状态）、[需求追踪表](docs/implementation/requirements-traceability.md)（137 项）、[实施决策](docs/implementation/implementation-decisions.md)（ADR-Ixx）、[runtime 能力矩阵](docs/implementation/runtime-capability-matrix.md)、[续工记录](docs/implementation/continuation.md)。跨会话续工先读这些文件，不重新调研。

- 交互原型：`hifi-prototype/`（Electron 桌面外壳为真，业务为内存 mock；可整目录删除，不代表正式工程结构；与根工程各自独立 package.json，正式 UI 施工时按已确认交互复用改造进 `src/ui/`）
- [docs/dev-briefs/dev-01-contracts-and-routing.md](docs/dev-briefs/dev-01-contracts-and-routing.md) — 第一个开发包任务说明（消息契约与路由）；后续开发包说明也放 `docs/dev-briefs/`

## Raft 调研（2026-09-17，基于 1.0.32 官方二进制静态核查）

- [docs/raft-multi-agent-principle-visual-guide.html](docs/raft-multi-agent-principle-visual-guide.html) — 多 Agent 主动协作原理详解
- [docs/raft-prompt-source-evidence-1.0.17.md](docs/raft-prompt-source-evidence-1.0.17.md) — 提示词源码与 1.0.32 二进制证据
- [docs/raft-agent-proactive-collaboration-analysis.md](docs/raft-agent-proactive-collaboration-analysis.md) — 主动协作分析
- [docs/raft-multi-agent-mechanism-and-cli-prompts.md](docs/raft-multi-agent-mechanism-and-cli-prompts.md) — 机制整理与本机采集指南

## 历史资料

- [docs/zhongshuo-ui-prototype.html](docs/zhongshuo-ui-prototype.html) — 更早的界面草图（另一模型随手画的，2026-09-19 判定**不作为设计依据**，仅留档）
- [docs/agent-room/](docs/agent-room/) — 早期路线调研（DSH 应用 vs 独立 daemon）
- [docs/cli-orchestration-plan.md](docs/cli-orchestration-plan.md) — 早期 CLI 编排方案
- [docs/review-of-v1-design.md](docs/review-of-v1-design.md)、[docs/review-of-v1-and-review.md](docs/review-of-v1-and-review.md)、[docs/review-of-v1.2-design.md](docs/review-of-v1.2-design.md) — 历次评审记录
- 旧版归档与商业可行性报告未包含在当前目录；原 `archive/`、`众说-可行性研究报告.md` 链接已移除，找到实际文件后再补入口。

### 共享文件预览原型施工（2026-09-22 已确认）

- [原型施工说明](docs/dev-briefs/prototype-workspace-preview.md) — 直接交施工 AI，修改现有 hifi-prototype；实际代码和验证交付。
- [交互规格 v1.2](docs/zhongshuo-workspace-preview-interaction-v1.md) — §17.9 配套细则（v1.15 时并入主设计，此版本号为历史基线）。具体文件正文使用共享预览，主池/线程/私信入口均覆盖；宽度候选仍需实测。

既有 README/历史规范中“成果正文仅在串内 tab”描述由 §17.9 部分替换，非文件详情、线程隔离、权限和正式工程门槛不变。
