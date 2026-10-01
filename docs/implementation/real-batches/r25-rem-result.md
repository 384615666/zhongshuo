# r25-rem 真实批次结果（2026-10-01 第二十五轮五）

授权依据：Claude Code + deepseek-flash 持续授权（仅该渠道、逐批目标/上限/停止条件）；本批为用户明确的**新真实认证目标**（第二十五轮指令五）：system 来源提醒经正式链**自动触发一次**+**待确认→用户确认触发一次**。不重复 r20-dm、不清旧账。

- 预期与上限：恰 2 次 startTurn；机械 cap=4（`ZS_REAL_BATCH_ID=r25-rem`——RealCallGate 硬上限；任何超发即护栏拒绝=停批）。
- 实际：**2/2 succeeded**（`real_calls` count=2，`succeeded=2`）；请求模型与响应自报**双向一致 deepseek-flash/deepseek-flash**；机械 cap 未触。
- 提醒调用台账（reminder_calls）：两提醒各恰一行，终态 `settled`×2（turn_id 已挂钩——迁移 028 台账随真实执行结算）。
- 正式链核对（批次内 PASS）：
  - ① 自动触发：occurrence `dispatched` + dm_turn 任务落目标会话；owner=对端成员；根消息 `author_type='system'`+`author_id=reminder:{id}`；DEV-21-M3 模板字段（【提醒触发】/occurrence:{id}@/来源 r25-rem:auto/不要自行安排后续循环）；结果回复落目标会话（暗号 R25-REM-4128 回流）。
  - ② 待确认：到点 `awaiting_confirmation`（未执行）→ mine.pending 列出 → `reminder.confirm` 返回 taskId → 执行 DONE → 回复仍落目标会话（暗号再次回流）。
- 停机事实：daemon 优雅退出 exit 0（shutdown 正式链）。
- 台账：`docs/implementation/real-batches/r25-rem-ledger-real.json`（清理前行级 callsDetail（model/response_model/usage_json/run_id）、runtime_sessions 身份、reminder_calls、daemon 停机事实、stderr 尾部）。
- 演练：`r25-rem-ledger-rehearsal.json`（fake 零真实调用——脚本自身验证）。
- 批次脚本：`scripts/real-batch-r25-rem.mjs`。
