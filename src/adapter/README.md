# adapter（DEV-03 已交付 fake；DEV-06/10 承载真实 runtime）

runtime 适配器、进程树管理、会话生命周期与规范化事件（§9.3/§9.4）。
依赖边界：contracts + domain；厂商类型不渗入 domain。

- `fake/`：可脚本化 fake adapter（六类 fixture：成功/失败/审批/超时/停止不响应/迟到），
  供 DEV-05/17 调度与隔离测试复用；不标真实 runtime supported。
- 真实接入：Codex App Server（DEV-06）、Claude Code headless（DEV-10）。
