# ui（DEV-07 起承载）

Electron main/preload 与正式 React renderer；正式界面沿已确认原型（hifi-prototype/ 为交互参照）。
依赖边界：仅 contracts（经 daemon IPC 消费其余层，不直接读写 SQLite、不拉起模型 CLI）。

DEV-01 只预留本骨架。
