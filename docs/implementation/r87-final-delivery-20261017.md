# R87 收口记录（2026-10-17）

## 交付身份

- 源码分支：`codex/full-implementation`
- 源码提交：`9771a8a39caec15c85429580b78827ef9f8baca0`（已推送）
- clean BUILD：`bld_939523319bbbd61d`，`dirty=false`
- Windows 包：`dist/desktop/desktop-daily-win-v26-r87-20261017`
- 程序清单：595 个文件，构建时逐文件 SHA-256 一致
- 数据 schema：迁移 001–052 冻结，053/054 为追加迁移

本轮从 clean worktree 构建，不把 `.codex-deepseek/`、用户旧包、用户 profile、运行数据或凭据带入包。

## 已完成产品范围

### 完整本地数据引导

- 设置 → 数据与存储新增“备份全部数据”“使用已有数据或从备份恢复”。
- 路径只由 native folder picker 取得；renderer 不能提交任意路径。
- 复制前正常关闭窗口和 daemon；后台 worker 使用随包 Node 与 better-sqlite3，不启动模型。
- 完整复制数据根；保留 SQLite/WAL/SHM、附件、草稿、未知账本、空目录、root identity 和整个 `electron-user-data`。
- 每个文件复制前后核对 SHA-256；SQLite 在独立 scratch 副本做 integrity/user_version 检查。
- 只有完整 manifest 和位置指针原子提交后才切换；import 前保全当前根。
- 位置指针丢失/无效时安全拒绝启动并提供重新定位入口，不静默打开空根。
- 正常 BAT 使用保存的数据位置；关闭后重开保持一致。
- 已覆盖：同一操作回执丢失、死 worker、未提交中断、晚到位置变化、活动源、重叠、链接/junction、空间不足、读写失败、schema 过高、备份篡改/未完成。

### 设置、恢复与成果

- 设置导航收敛为通用、外观、AI 设置、连接与设备、数据与存储、帮助与关于；移除正常页中的“未接入”假开关。
- AI 设置保留真实模型/渠道/权限入口；程序路径等技术项进入高级详情。
- 恢复面板优先显示“发送结果待确认”“任务中断”“继续处理”等自然语言摘要；原始对账/租约/保护事实折叠到高级详情，服务端保护逻辑未放松。
- 成果附近提供打开/保存文件、按意见修改、确认完成；聊天导出与成果文件分开。
- 详细版本身份折叠显示；普通用户默认看到任务/版本/是否待确认。
- 添加 AI 后立即刷新 `members` 与房屋成员投影，不再需要整页重载才能 @ 新成员。

## 真实同 BUILD 验收

### 隔离 UI 路线

从隔离空数据目录启动正式 BAT，实际完成：

1. 欢迎页打开合成的 DOCX/PDF 报告项目。
2. 通过 UI 添加 Claude `deepseek-flash` 与 Codex `gpt-6-luna`，不预置成员。
3. 同串问候，原执行成员回答。
4. 同串读取 DOCX/PDF，发现金额、日期、缺失附件、验收人冲突和发布风险，生成 `报告复核-v1.md`。
5. 在同一串加入 Codex，@本串全体；Codex 实际读取原件、独立复核并回传，DeepSeek 汇总更新同串文件。
6. 普通追问“为什么剩余预算应为 36,500 元”获得回答。
7. 明确修改生成 `报告复核-v2.md`，包含 `100,000 - 63,500 = 36,500`、缺失 `预算明细.xlsx`、日期冲突和验收人建议。
8. 在精确 pending delivery UI 验收当前**revision 3**，任务转 DONE；中间 revision 1/2 保留为 superseded。
9. 预览工作区 `报告复核-v2.md`，通过系统保存桥保存原件；源文件与保存件均为 9,116B、SHA-256 `a6e8a1cfecb9be5430cf76c52349cca4bd9735ae0699a07a79a75d46a9564116`。
10. 正常关闭，经同一 BAT 重开；项目、房间、成员、对话、已完成任务、accepted revision 3 和文件保持，真实调用数重开前后同为 9，无自动补发。

精确交付身份：

- Task：`task_0b193d84-c301-4fb8-bbd6-cc063a2165c2`
- Thread：`thread_d6d44fdb-c2f0-48c3-a266-1822b5f35630`
- Delivery：`dlv_turn_a578783b-ed50-4d01-a04d-90ce23218572`，revision 3
- Manifest：`11d432d8ae6343a69a5653455ac18474f3f74cea21e83a6afd20c8a87b63a552`
- 实际模型：Claude `deepseek-flash`、Codex `gpt-6-luna`
- 真实调用：9/9 succeeded；重开后仍 9

文件命名保留 `报告复核-v2.md`，而交付 revision 为 3。这是本轮连续修改产生的真实版本事实；验收和 manifest 都绑定 revision 3，不用文件名冒充交付版本。

### 完整数据引导路线

同一 clean BUILD 的隔离副本：

- UI 触发备份 → 正常关闭 app/daemon → 独立进度窗口 → worker 完整复制并校验 75 个文件 → 自动重开。
- 从该完整备份恢复 → 先保全当前根 → 复制并验证新副本 → 原子切换位置 → 自动重开。
- 再次通过正常 BAT 打开，数据根保持在新副本。
- 0 模型调用。

证据：

- `dist/review-r87-final/final-natural-1/result.json`
- `dist/review-r87-source/r87-data-copy-probe-2026-10-17T15-32-48-812Z/result.json`
- `dist/review-r87-final/final-natural-1/two-model-collaboration.png`
- `dist/review-r87-final/final-natural-1/v2-file.png`
- `dist/review-r87-final/final-natural-1/v2-preview-saved.png`
- `dist/review-r87-final/final-natural-1/reopened-completed.png`

## 工程验证

- 全量源码：170 个测试文件、1254 项通过。
- `pnpm typecheck`：通过。
- `pnpm typecheck:hifi`：通过。
- 本轮新增/修改的 TypeScript 与 QA 脚本定向 eslint：通过。
- 全仓 `pnpm lint` 仍失败：16137 problems（16094 errors/43 warnings），主要来自历史 scripts/tests 和旧 renderer；不宣称全仓 lint 通过。
- 构建清单：595 个程序文件逐文件 SHA-256 一致。
- 原失败、早期 data-copy WIP 和全仓 lint 失败保留，不改写为通过。

## 边界

- 真实验收仅限本轮本机 Windows 环境及已配置的 Claude/Codex 渠道与账号；不认证其他渠道、第三方模型或账号。
- Android、安装器、签名、自动更新、并行写入增强、跨机器同步未扩入本轮。
- 合成报告和合成项目只用于验收；未读取、复制或发送用户实际文档。
- 用户原根、旧包、配置、凭据、草稿、未知账本和 `.codex-deepseek/` 未删除、移动或提交。
- 未把 `deepseek-v4-flash` 或旧 v25 当成最终交付；最终实际调用为当前可用的 `deepseek-flash`。

## 复核入口

- 最终源码：`9771a8a39caec15c85429580b78827ef9f8baca0`
- 最终包：`D:\zhongshuo\dist\desktop\desktop-daily-win-v26-r87-20261017`
- 最终 BUILD：`bld_939523319bbbd61d`
- 最终 JSON 证据：`dist/review-r87-final/final-natural-1/result.json`
