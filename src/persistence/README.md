# persistence（DEV-02 已交付核心）

SQLite 正式 migration、事务命令网关（幂等回执）、outbox（CAS 租约）、领域事件追加
与主池根任务单事务写入路径。依赖边界：contracts + domain；由 daemon 组装。

- 迁移：`migrations/001-initial.ts`（§12.2 全表 + 开工契约 §2.2 增量 + §12.3 约束）
- 运行器：`db.ts`（WAL/FK/user_version/审计/升级前 VACUUM INTO 备份）
- 事务网关：`commandGateway.ts`（RT-01 幂等；§11.2 单事务范式）
- 其余实体仓储随消费包（DEV-05/17/22…）按 `stores/roomRootTask.ts` 模式扩展。

报告：[../../implementation/reports/dev-02-result.md](../implementation/reports/dev-02-result.md)
