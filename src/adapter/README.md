# adapter（DEV-03 已交付 fake；DEV-06/10 承载真实 runtime）

runtime 适配器、进程树管理、会话生命周期与规范化事件（§9.3/§9.4）。
依赖边界：contracts + domain；厂商类型不渗入 domain。

- `fake/`：可脚本化 fake adapter（六类 fixture：成功/失败/审批/超时/停止不响应/迟到），
  供 DEV-05/17 调度与隔离测试复用；不标真实 runtime supported。
- 真实接入：Codex App Server（DEV-06）、Claude Code headless（DEV-10）。

Codex 内部会话保留持久历史。每轮成功、失败或确认停止后，适配器检查会话已空闲并自动归档，从客户端的普通历史列表收起；下一轮先恢复归档，再原生续接同一会话，保留模型、权限范围和常驻指令。归档是有界的元数据操作，失败不改写任务结果，也不额外发起模型调用。执行期间仍可能出现在 Codex 客户端。

新版后台每次启动后，随正常调度逐条整理本数据根已登记的旧 Codex 会话：只按 `runtime_sessions` 中的精确 provider ID，且必须有已终态执行证据；未收尾、UNKNOWN、同成员在途或无法确认归属的记录跳过。恢复/归档使用官方协议，不删除会话文件，不迁移运行数据。其他渠道的会话存储方式保持现有实现。
