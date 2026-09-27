# persistence（DEV-02 承载）

SQLite 正式 migration、事务、组合约束、命令回执与 outbox 的承载层。
依赖边界：contracts + domain；由 daemon 组装，UI 不直接读写。

DEV-01 只预留本骨架，不含任何数据库实现。
