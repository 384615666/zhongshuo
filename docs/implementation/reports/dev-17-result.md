# DEV-17 完成报告（M0 最小隔离）

- 日期：2026-09-27 · 分支：`codex/full-implementation`（基线 `41b58dc` = DEV-05 检查点）
- 状态：**VERIFIED（M0 最小隔离范围）**；完整隔离（阶段过滤、DM 上下文、真实进程边界）随 DEV-06/08/22 扩展

## 实现范围

| 交付 | 落点 |
|---|---|
| 五级归属绑定纯校验（task/run/turn/conversation/thread 一致性；不匹配即拒，不猜测不兜底） | `src/domain/isolation/binding.ts` `validateExecutionBinding` |
| 事件归属校验（迟到 turn 事件拒绝改变状态；agent 不能用结果参数更换目的地，§4.5/RT-06） | 同上 `validateEventAttribution` |
| 会话复用键（任务键含 task+generation；DM 键按会话+成员+代次、不跨对话复用，§13.4/开工契约 §2.2） | 同上 `taskSessionKey`/`dmSessionKey` |
| 上下文过滤（§13.4 矩阵最小：本线程消息/指令放行；跨任务消息与未授权成果拒绝；grant 放行；全拒报 CONTEXT_NOT_GRANTED 不装空包） | `src/domain/isolation/contextFilter.ts` |
| ContextBundle 契约骨架（§13.1 优先级、ContextRef 版本/基线/截断、hash 草案——DEV-21-M0 消费） | `src/contracts/contextBundle.ts` |
| **双任务不串线集成测试（TH-02/TH-03 存储级）**：同房两任务交错派发，回复/会话/run 各归各 | `tests/integration/isolationTasks.test.ts` |

## 修复的真实缺陷

隔离测试暴露：派发 worker 的回复消息 ID 直接用 provider messageId 命名，跨会话同名（fake 默认 `msg_fake_1`）导致第二任务回复被主键去重静默丢弃。已改为 **turn 命名空间**（`msg_{turnId}_{messageId}`）：同 turn 重放仍去重（RT-05），跨 turn/会话不冲突。这正是 TH-02 类串线/丢消息风险的存储级反例。

## 验证证据

- 命令：`pnpm check`；结果：typecheck 0 错、eslint 0 错、**vitest 16 文件 206/206**（新增 14 用例，2026-09-27 09:25）。
- 覆盖：绑定反例（run/turn/线程/会话漂移全拒）；事件归属（迟到/换目的地拒绝）；会话键不相交；上下文过滤（本线程放行/跨任务拒/grant 放行/全拒报错）；双任务交错各归各（主池无 agent 长回复泄漏、每任务一个 run、会话按成员+任务隔离）。

## 未实现/交接

- 阶段级过滤（INDEPENDENT 不读他人草稿等 §6.2 屏障）→ DEV-08/09。
- DM 上下文过滤与跨对话隔离执行 → DEV-22。
- OS/工具强制读取隔离（PP-06）→ DEV-20（不作为首版虚假承诺）。
- runtime_sessions 复用键在 worker 的续接消费（当前每代次新会话；续接接 DEV-06 resume 验证）。

## 修改文件

新增：`src/domain/isolation/`（binding.ts、contextFilter.ts）、`src/contracts/contextBundle.ts`、`tests/unit/isolation.test.ts`、`tests/integration/isolationTasks.test.ts`；修改：`src/daemon/dispatchWorker.ts`（消息 ID turn 命名空间修复）、contracts/domain 出口。未触碰 `hifi-prototype/`。

## 勘误（2026-09-27 修复轮，外部只读审查后）

1. 原结论"上下文过滤已验证"表述过满：原实现对 directive/summary 无条件放行、file 只验 baselineId 非空，未校验归属。现全部白名单化（allowedDirectives/allowedSummaries/allowedBaselineIds，服务端解析归属），补伪造指令/跨任务摘要/错误基线三个反例。
2. 隔离原仅在单测层：现 worker 派发路径实际接入——按 §13.4 过滤组装 ContextBundle（含拒绝记录）并落 `context_bundles` 表，输入文本携带真实组装结果（正式模板文本仍归 DEV-21-M0）。
3. 原双任务用例为不同成员串行：补同成员先后双任务用例，断言任务 4 的输入包不含任务 3 线程任何消息。
4. 结论修正为：**任务级隔离合同与派发路径接线已实现并验证**；阶段级过滤（INDEPENDENT 草稿隔离等）与 OS 级边界仍分别归 DEV-08/09 与 DEV-20，不在本包范围。
