# 众说（zhongshuo）

本地项目群聊多 Agent 协同工作台：以文件夹为项目，在群聊中组织多个 CLI agent 完成工作；仿照 Raft 的协作体验，控制面与工作记录保存在本机。

本目录目前承载设计资料（含 Obsidian 配置）与交互原型，尚未初始化正式代码工程。原定正式仓库路径也为 `D:\zhongshuo`；两者的归属与迁移安排见[目录方案](docs/workspace-layout-proposal.md)，确认前不搬移文件、不在根目录初始化 Git 或安装依赖。正式开发前的待办见 [docs/pre-development-checklist.md](docs/pre-development-checklist.md)。

## 原型（2026-09-19）

**现行原型：[hifi-prototype/](hifi-prototype/) — Electron 桌面客户端**（React + TypeScript + Vite）

- `pnpm install && pnpm run build && pnpm run desktop` 启动原生窗口（含系统托盘、原生目录选择器、关闭窗口缩托盘）
- [hifi-prototype/README.md](hifi-prototype/README.md) — 桌面能力表、路由与截图对照、硬约束落点、已知边界
- [hifi-prototype/screenshots-desktop/](hifi-prototype/screenshots-desktop/) — 真实 Electron 窗口截图 12 张；[screenshots/](hifi-prototype/screenshots/) — 浏览器逐页 24 张
- 状态：业务内核仍是内存态（无 daemon/SQLite/runtime 适配器，刷新即回种子），但**桌面外壳是真的**：窗口/托盘/原生对话框/单实例锁/contextIsolation 桥接均可用 `node scripts/verify-desktop.mjs` 复验
- 可复跑的验证：`verify-review-fixes.mjs` 21 项、`verify-round13.mjs` 16 项、`verify-desktop.mjs` 8 项、`smoke.mjs` 27 项

**历史原型（不作为依据）**：[docs/zhongshuo-hifi-prototype-v1.html](docs/zhongshuo-hifi-prototype-v1.html)（v1.8）、[docs/zhongshuo-ui-prototype.html](docs/zhongshuo-ui-prototype.html)（v1.5 草图）、[prototype/](prototype/)（早期 React 尝试）—— 均已在文件头标注"已过时"，保留作历史记录。

## 权威文档

- [docs/zhongshuo-development-design-v1.md](docs/zhongshuo-development-design-v1.md) — 开发设计报告，**唯一权威版本**（文件名中的 v1 保持稳定，当前 **v1.15**；项目设置独立于应用设置，导航、文件/Git 合页、项目分组看板和可选验收沿用。历史 B1—B5 验证不代替 B6 权限验证；E11、E13 剩余契约与 R4—R11 等工程事项仍需收口）
- [docs/product-decisions-guide.md](docs/product-decisions-guide.md) — 产品决策指南（48 项逐项讲解：背景/选项/优劣/推荐）
- [docs/product-decisions-checklist.md](docs/product-decisions-checklist.md) — 产品行为与功能待确认清单（48 项，含确认记录；原始清单，已加历史提示）
- [docs/pre-development-checklist.md](docs/pre-development-checklist.md) — 正式开发前待办清单
- [docs/zhongshuo-prompts-v0.1.md](docs/zhongshuo-prompts-v0.1.md) — 提示词规格 v0.1：常驻提示词模板、三层注入规则与程序执行边界（对应清单 E13/R9，建议承载 DEV-21）
- [docs/dev-briefs/prototype-optional-task-review.md](docs/dev-briefs/prototype-optional-task-review.md) — 任务验收可选功能：原型修改说明、页面映射和验收用例；文档已定，原型待实现
- [docs/dev-briefs/prototype-sidebar-project-navigation.md](docs/dev-briefs/prototype-sidebar-project-navigation.md) — 第十五批原型交接：侧栏顺序、顶栏多选、文件/Git 合页、项目分组看板与 Runtime 收入设置；包含旧路由兼容与回归用例
- [docs/dev-briefs/prototype-settings-separation.md](docs/dev-briefs/prototype-settings-separation.md) — 第十六批原型交接：各项目独立设置单页、底部应用设置、表单简化和旧链接兼容；覆盖上一批设置混合展示规则

## 开发

- 交互原型：`hifi-prototype/`（Electron 桌面外壳为真，业务为内存 mock；可整目录删除，不代表正式工程结构）
- 正式代码仓库原定：`D:\zhongshuo`。当前已有资料与原型，不能再按“空文件夹”执行初始化；先确认[目录归属方案](docs/workspace-layout-proposal.md)，再按开发清单及 DEV-01 的前置条件开工。
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
- [交互规格 v1.2](docs/zhongshuo-workspace-preview-interaction-v1.md) — 开发报告 v1.15 §17.9 配套细则。具体文件正文使用共享预览，主池/线程/私信入口均覆盖；宽度候选仍需实测。

既有 README/历史规范中“成果正文仅在串内 tab”描述由 §17.9 部分替换，非文件详情、线程隔离、权限和正式工程门槛不变。
