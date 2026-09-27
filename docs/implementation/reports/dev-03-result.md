# DEV-03 完成报告：可脚本化 fake adapter

- 日期：2026-09-27 · 分支：`codex/full-implementation`（基线 `0feb053` = DEV-02 检查点）
- 状态：**VERIFIED**（进程内确定性实现，零模型调用——按任务书非目标边界，fake 不标任何真实 runtime supported）

## 实现范围

| 交付 | 落点 |
|---|---|
| §9.3 自有适配器契约（RuntimeAdapter/SessionRef/TurnRequest/RuntimeCapabilities/ProbeResult/AdapterCallError） | `src/contracts/runtime.ts` |
| §9.4 规范化事件 12 kind 判别联合 + eventKey 稳定去重 + 终结判定 | `src/contracts/runtime.ts` |
| 六类 fixture 编排（纯数据脚本） | `src/adapter/fake/script.ts`：successTurn / failingTurn / approvalTurn / stuckTurn / unresponsiveTurn / lateFollowUp + waitApproval/stall/late/unresponsiveToInterrupt 原语 |
| fake 执行器 | `src/adapter/fake/runtimeAdapter.ts`：事件积压回放（重连语义）、审批阻塞与答复、中断（含「停止不响应」仅标记）、迟到事件按绝对 turn 序号投递并携带原 turnId、能力 unsupported → CAPABILITY_UNSUPPORTED、并发 turn → WORKSPACE_BUSY |

关键语义忠实点：中断绑定目标运行（目标已非活跃时零影响）；不伪造终结事件（脚本走完无 turn.completed 时只发 process.exited(0)，结果不确定由消费方判定）；审批等待可被中断打断；停止不响应 fixture 维持"turn 活跃 + interruptRequested=true"形态（WORKER_STILL_RUNNING）。

## 验证证据

- 命令：`pnpm check`；结果：typecheck 0 错、eslint 0 错、**vitest 13 文件 167/167**（新增 16 用例，2026-09-27 09:07）。
- 覆盖：成功序列（含 eventKey 唯一与 turnId 归属）/积压回放/失败/审批 allow·deny·错答复/超时中断 INTERRUPTED/停止不响应（窗口内无终结+状态标记）/迟到 interrupt 零影响/迟到事件（原 turnId+新 turn 开始后到达）/steer 记录/能力 unsupported 抛错/并发 turn 拒绝/close 失效/probe 三态。

## 未实现/交接

- 真实 runtime（Codex App Server）→ DEV-06；第二 runtime → DEV-10；能力认证（B6/RT-23）随对应包。
- supervisor/进程树（fake 为进程内，无进程管理）→ DEV-05。
- 审批 payloadHash/有效期校验的 adapter 侧桥接（fake 不模拟过期；纯判定已在 DEV-01 `evaluateApprovalResponse` 覆盖）→ DEV-06 接线。

## 修改文件

新增：`src/contracts/runtime.ts`、`src/adapter/fake/`（script.ts、runtimeAdapter.ts、index.ts）、`tests/unit/fakeAdapter.test.ts`；修改：`src/contracts/index.ts`、`src/adapter/README.md`、总账四件。未触碰 `hifi-prototype/`。
