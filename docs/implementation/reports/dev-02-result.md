# DEV-02 完成报告：SQLite 基础

- 日期：2026-09-27 · 分支：`codex/full-implementation`（基线 `8e88799` = DEV-01 检查点）
- 范围：总任务书 §6.1 DEV-02 行——SQLite 正式 migration、事务、组合约束、回执、outbox、重启读取
- 状态：**VERIFIED（本包存储侧范围；G1 闸门整体还含 DEV-03/04/05/17，未齐不宣称 G1 通过）**

## 实现范围

| 交付 | 落点 | 说明 |
|---|---|---|
| 数据库打开 | `src/persistence/db.ts` | WAL（文件库；:memory: 如实保持 memory）、foreign_keys=ON、busy_timeout 5s |
| 迁移运行器 | `src/persistence/db.ts` | user_version 门控 + schema_migrations 审计（checksum 指纹）+ 每迁移单事务；已有数据升级先 `VACUUM INTO` 一致性备份（ADR-I12：better-sqlite3 backup 为异步 API，不适用同步迁移器）；失败回滚且 user_version 不变 |
| 001 初始迁移 | `src/persistence/migrations/001-initial.ts` | §12.2 目录全量表（45 张业务表 + 审计）+ 开工契约 §2.2 会话增量 + §12.3 唯一/部分索引与 CHECK；组合外键 (project_id,conversation_id) 按 ADR-I16 落位 |
| 事务命令网关 | `src/persistence/commandGateway.ts` | BEGIN IMMEDIATE；同 scope+commandId 同 hash 重放持久结果 / 异 hash IDEMPOTENCY_CONFLICT / 回执清理后 RESULT_EXPIRED；handler 异常整事务回滚并映射 STORAGE_UNAVAILABLE |
| Outbox | `src/persistence/outbox.ts` | dispatch_key 唯一入队（重复幂等）、CAS 领取（pending 或租约过期）、attemptEpoch fencing 完结 |
| 事件追加 | `src/persistence/events.ts` | domain_events 与业务写入同事务 |
| 主池根写入路径 | `src/persistence/stores/roomRootTask.ts` | §3.4/§12.3 范式：会话校验→conversation_seq 事务分配→anchor 消息→thread（root_task_id 先空）→根任务+回填→事件→dispatch 路由入 outbox；record_only 只建消息+记录串零任务零派发 |

## 验证证据

- 环境：Windows 11 x64、Node 24.16.0、pnpm 11.23.0、better-sqlite3 13.0.3（SQLite 3.53.4，prebuilds）。
- 命令：`pnpm check`（tsc --noEmit + eslint + vitest run）。
- 结果：**typecheck 0 错、eslint 0 错、vitest 12 文件 151/151 通过**（DEV-01 127 + DEV-02 24 个集成用例，2026-09-27 08:59 本机执行）。
- 关键用例（`tests/integration/persistence.test.ts`）：
  - 迁移：全表存在（≥45）、user_version=1、FK=ON、重开幂等、**失败回滚（user_version 不变）**、**升级前备份（备份库含旧数据、无新表）**。
  - RT-01（存储侧）：同键同参重放（handler 仅执行一次、业务行各 1）；同键异参 IDEMPOTENCY_CONFLICT 且零新行；跨 scope 隔离；handler 中途抛错→无回执无业务行。
  - RT-02：提交后关库重开，任务/消息/线程/事件/outbox pending 全部保留。
  - RT-05（存储侧）：同 dispatchKey 重复入队同一行。
  - outbox CAS：租约内他人不可领、过期回收、旧代次完结被 fence、当前代次成功。
  - 写入路径：dispatch 全链一次落库（任务号 1→2 递增）；record_only 零任务零 outbox；归档房间拒绝。
  - 约束反例：dm_turn 带 room 字段、同 anchor 第二线程、同房重复任务号、同根消息第二任务、thread_id⇔seq 失配、via_connection_id 非 human、room/dm 会话 roomId 违例、同房第二会话、not_required 带人工记录、同任务第二个 pending 交付、DM session 复用键重复——全部被 DB 层拒绝。

## 未实现/交接（非缺陷）

- 其余实体仓储（线程回复、DM 写入路径、交付/验收、研讨矩阵等）→ 随消费包（DEV-05/17/22 等）按需落库；模式已由 roomRootTask 确立。
- 预算事务预占/结算接库（BudgetState ↔ 库表）→ 与 DEV-05 调度器联合（开工契约 §3.1：DEV-02/05 承担）。
- RT-13（磁盘满）未模拟：存储错误已统一映射 STORAGE_UNAVAILABLE 且有回滚用例；物理磁盘故障注入待 DEV-13 故障包。
- 真实 appData 目录布局（§12.1）与迁移备份目录接线 → DEV-04/05 daemon 引导时接入。
- dm_participants 恰两主体/第三人拒绝的服务层用例 → DEV-22。
- WAL checkpoint 策略、concurrency=readonly 连接（LAN 读者）→ DEV-25。

## 修改文件

新增：`src/persistence/`（db.ts、commandGateway.ts、outbox.ts、events.ts、index.ts、migrations/001-initial.ts、migrations/registry.ts、migrations/index.ts、stores/roomRootTask.ts）、`tests/integration/persistence.test.ts`、`pnpm-workspace.yaml`（仅设置，ADR-I17）；修改：`package.json`（+better-sqlite3/@types）、`pnpm-lock.yaml`、`src/persistence/README.md` 由骨架替换为实现说明、docs/implementation/ 各总账。
未触碰：`hifi-prototype/`、用户既有文档。