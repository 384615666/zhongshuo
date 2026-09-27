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

## 勘误（2026-09-27 修复轮，外部只读审查后）

原报告六项缺陷由外部只读审查发现，全部修复并补真反例（详见总账"修复轮"表与 `tests/integration/m0Fixes.test.ts`）：

1. 超时依赖事件到达：改独立截止计时（沉默 runtime 按时中断；中断宽限后无终结→UNKNOWN，不伪造）。
2. 会话打开期间停止失效：openSession 返回后复查停止代次/终态，停止已生效不 startTurn、按取消收尾并留 `stop-during-session-open` 审计。
3. 恢复无执行约束：迁移 003 `daemon_state` 派发门禁——applyRecovery 落 `held`、`openDispatchGate`（用户确认继续）放行、worker 领取前检查；重排后 worker 不再自动补跑（drain=0 用例）。
4. 崩溃重领与既有 turn 唯一键冲突：dispatch_key 已有 turn → `failOutbox` + `run.reconcileRequired` 审计（RT-03 语义），不新建 turn。
5. 模式门禁缺失：AUTO/DELIBERATE 任务 → BLOCKED + `mode_unavailable_in_m0` 审计，不冒充单成员执行。
6. 验收策略未执行：user_review → REVIEW+pending 交付（唯一待办、current_delivery_id）；auto_deliver → DONE+not_required（不伪造人工通过）。
7. 单实例锁非原子：O_EXCL 独占创建+陈旧锁原子接管，真实双进程竞态用例（恰好一个赢家）。
8. **IPC 传输已补齐交付**（撤回原"随 DEV-07 后移"结论）：`namedPipeIpc` JSON 行协议（同 socket FIFO 串行），测试客户端往返验证；Electron 接线仍随 DEV-07。
9. 修复中额外发现：事件竞速丢弃 pending 的 `iterator.next()` 会吞事件（async iterator 禁止并发 next）——已修。
