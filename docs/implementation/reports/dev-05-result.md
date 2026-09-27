# DEV-05 完成报告：daemon 核心调度

- 日期：2026-09-27 · 分支：`codex/full-implementation`（基线 `35df2f3` = DEV-04 检查点）
- 状态：**VERIFIED（派发/停止/恢复核心）**；两项明确交接（见下），不据此宣称 G1 全通过（还差 DEV-17 隔离）

## 实现范围

| 交付 | 落点 | 依据 |
|---|---|---|
| 迁移 002：tasks.stop_generation（停止代次持久化）+ route_json（resolvedRoute 落库，派发事实源） | `src/persistence/migrations/002-stop-generation.ts` | §11.4/§15.2 |
| 派发 worker：CAS 领取 → 建 run/turn/participant（预占预算）→ runtime_sessions 登记 → adapter 执行 → 规范化事件落库（回复入正确线程、usage 记录、终态原子应用、预算结算）→ completeOutbox | `src/daemon/dispatchWorker.ts` | §11.2/§11.3/§10.2 |
| 停止流程：runCommand 包裹（同 commandId 幂等）→ evaluateStopTarget → stop_generation+1、run/turn→STOPPING → worker 协议中断回调 → 确认退出 CANCELLED | `src/daemon/stopFlow.ts` | §7.3/§16.3/开工契约 §3.2 |
| 恢复：非终态 run→INTERRUPTED、turn→UNKNOWN、过期租约 outbox 重排 pending（不自动补跑）、占用租约列给人工处理 | `src/daemon/stopFlow.ts` | §16.4（决策 44/E7） |
| 单实例锁：锁文件 pid+启动时间、活进程互斥、死进程接管、仅清理自身锁 | `src/daemon/singletonLock.ts` | §8.3 |

防线实现：任务终态/stop_generation>0 阻止旧派发；重复完成靠消息序号唯一+状态 CAS+dispatch_key 单次语义（RT-05）；迟到旧 turn 事件终态后忽略不复活任务（RT-06 形态）；turn 超时先中断、仍无终结→UNKNOWN（结果不确定，不伪造）。

## 验证证据

- 命令：`pnpm check`；结果：typecheck 0 错、eslint 0 错、**vitest 15 文件 192/192**（新增 9 集成用例，2026-09-27 09:22）。
- 关键用例：成功全链（outbox→run/turn→回复落正确线程 seq=1/conversation_seq=2→任务 DONE→预算 used=1/inFlight=0→outbox done）；失败回 ACTIVE 可重试；RT-05 同 key 不二次派发；RT-02 提交后崩溃重开续派；**运行中停止全链（STOPPING→中断→CANCELLED→代次持久化+重放幂等）**；旧 run 停止 already_stopped 不改状态；恢复不自动补跑；单实例锁互斥/释放/接管。

## 未实现/明确交接（不是已完成）

1. **命名管道 IPC 传输**（§8.3 Windows 用户级命名管道）：命令面核心（envelope/CallerContext/runCommand）已具备，传输层随 DEV-07 Electron main 接线交付——首版 UI 是唯一本地消费者，提前建管道无消费者无法验证。
2. **真实进程注册表**（PID/启动时间/父子关系，§16.3/§16.4-3）：fake adapter 为进程内实现；进程树登记与身份核实随 DEV-06 真实 runtime 接入。
3. turnDeadline 到期后的 UNKNOWN→RECONCILE_REQUIRED 分支细化、DISPATCHING 不确定窗口（RT-03）→ DEV-13 故障包注入验证。
4. message.delta 流式透传（内存→UI 事件通道）→ DEV-07。

## 修改文件

新增：`src/daemon/dispatchWorker.ts`、`stopFlow.ts`、`singletonLock.ts`、`src/persistence/migrations/002-stop-generation.ts`、`tests/integration/dev05Daemon.test.ts`；修改：`migrations/registry.ts`、`stores/roomRootTask.ts`（route_json/owner 落库）、DEV-02 迁移测试改为对齐注册表长度。未触碰 `hifi-prototype/`。
