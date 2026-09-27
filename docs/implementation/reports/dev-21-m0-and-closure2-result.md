# 收口轮 2 + DEV-21-M0 完成报告

- 日期：2026-09-27 · 分支：`codex/full-implementation`（基线 `8ef911a` = 修复轮 1）
- 输入：用户转交的 GPT 复核意见（三个剩余收口 + DEV-21-M0 验证要求）
- 结果：全部完成；`pnpm check`（tsc + eslint + vitest）**244/244 全绿**（新增 18 用例）

## 三个收口

| 项 | 修复 | 验证 |
|---|---|---|
| 1 单实例锁 | ①「创建中」窗口（空/半截文件、mtime 在 createGraceMs 内）保守 BUSY 不接管；超宽限损坏才按陈旧处理；②陈旧接管三步防误移：判定死 pid → rename 前二次读取确认内容未变（读到活 pid 即 BUSY）→ rename 后读回核对确系旧锁，误移则还原并 BUSY | 受控时间窗口三反例：空文件+新 mtime→BUSY；空文件+旧 mtime→接管；死 pid 锁被替换为活 pid 锁→BUSY 且新锁原样保留。双进程竞态用例保留 |
| 2 恢复门禁 | applyRecovery 增加 pending outbox 检查：**已提交未领取**的遗留派发工作同样落 held 门禁 | RT-02 用例重写：重开后 drain=0、无新 run；openDispatchGate 后 drain=1 |
| 3 中断截止 | adapter.interrupt() 限时发送（fire-and-forget，宽限剩余时间为上限）后立即回主循环——interrupt 挂起不阻塞宽限计时；race 侧定时器 clearTimeout+unref | hangInterrupt 反例：挂起的 interrupt 下总时长≈deadline+grace，按 UNKNOWN 收尾不挂死 |

## DEV-21-M0（提示词/输出合同，依据 docs/zhongshuo-prompts-v0.1.md）

| 交付 | 落点 |
|---|---|
| 层 A 常驻模板 `zs-standing-v0.1.1` 全文照录 + 变量白名单渲染（缺/多变量、值缺失→失败；DM 会话→「私信提示词契约未完成」明确拒绝，不填伪造 roomId）+ 模板/渲染双 hash | `src/contracts/prompts.ts` |
| 层 B 信封 `zs-turn-v0.1.2`（M0 DIRECT 子集）schema + §4.2 固定分节渲染 + canonical hash | 同上 |
| DIRECT 指令模板照录 + 模板选择程序表（AUTO/DELIBERATE/checkpoint → M0 未实现，组装失败不降级） | 同上 |
| TaskComplete 输出契约 `task-complete-v1`（strict：成功/缺项/越权/旧版本四类 fixture；resultKey 服务端分配） | 同上 |
| 敏感模式扫描（PP-03：token/私钥/云密钥形态，层 A+B 全文零命中） | 同上 |
| 正式输入组装器：根消息+本线程获准历史正文、§13.4 过滤、预算快照、resultKey、组装失败结构化错误 | `src/daemon/turnInput.ts` |
| worker 接线：组装**前置**（失败→任务 BLOCKED+`task.contextAssemblyFailed` 审计+不建 run/turn）；层 A 随 openSession 注入（developerInstructions+promptVersion，fake 已记录）；信封全文+hash 落 context_bundles；startTurn 文本=渲染后的正式输入 | `src/daemon/dispatchWorker.ts` |
| 追加 turn 再交付：revision 递增、旧 pending 标 superseded（§10.5-5） | 同上 |

## 用户指定的三条验证（tests/integration/dev21m0.test.ts）

1. **实际输入包含用户根消息和获准历史**：首任务文本含根消息正文+输入头+DIRECT 指令+resultKey；续接任务（REVIEW 态 redispatch）文本含第一轮 agent 回复正文与根消息。
2. **与 ContextBundle/版本/hash 一致**：inputBundleId=context_bundles.id；库内信封 canonical 重算 hash 与行 hash 相等；bundleVersion/promptVersion 留档；materials 与 threadDigest 对应。
3. **组装失败不派发**：根消息被删→零 run/turn、BLOCKED、missing-root-message 审计；用户正文含 token→sensitive-content 审计、零 startTurn。

PP 自测覆盖：PP-02（版本+hash 留档）、PP-03（渲染全文零命中+命中阻断）、PP-04（一致性+必填缺失组装失败+模板选择不降级）、PP-05 应用层隔离（沿用 FIX-6 用例）。PP-01/PP-12（真实注入通道）按规格归 DEV-06 联合验证；PP-06 归 DEV-20。

## 额外修复（本轮发现）

- 追加 turn 交付撞 (task_id,revision) 唯一键（§10.5-5 未实现）→ revision 递增+superseded。
- 层 A 渲染的缺变量判定漏掉值为 undefined 的键 → 改按值判空。
- redispatch 派发键通道（同任务追加 turn，任务非终态+stop_generation=0 才放行）。

## 修改文件

新增：`src/contracts/prompts.ts`、`src/daemon/turnInput.ts`、`tests/unit/prompts.test.ts`、`tests/integration/dev21m0.test.ts`；修改：`singletonLock.ts`、`stopFlow.ts`、`dispatchWorker.ts`、`contracts/runtime.ts`（OpenSessionInput+层 A 字段）、`contracts/common.ts`（canonicalJson 上移）、`domain/idempotency.ts`、`adapter/fake/runtimeAdapter.ts`（hangInterrupt/startTurnLog/promptVersion）、`isolationTasks.test.ts`（信封新格式断言）、`dev05Daemon.test.ts`（RT-02 门禁化）、`m0Fixes.test.ts`（收口反例）。未触碰 `hifi-prototype/`。

## 边界声明（延续口径）

fake+SQLite 已验证：模板/信封/组装/敏感扫描/隔离一致性在派发路径真实执行。**未验证**：真实 runtime 注入通道（PP-01/PP-12，随 DEV-06）、层 C steering 事件（随 DEV-08/09/11 调度）、PP-06 OS 级隔离（DEV-20）。测试数量不作为全范围通过证明。
