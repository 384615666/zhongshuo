/**
 * DEV-21-M3 提醒模板（第二十四轮四）：提醒事件的输入/消息渲染**统一出处**。
 * - 不让模型自行循环（模板由服务端渲染，模型收到的是结构化上下文——循环计划由调度器
 *   推进，模型只处理单次触发）；
 * - 携带合同字段：occurrenceId（reminderId+scheduledAt 唯一）/scheduledAt/timezone/
 *   missedCount/sourceRef/预算与授权状态；
 * - 消息与任务输入同源（同一次渲染）——避免「消息说一套、输入另一套」。
 */

export interface ReminderWakeContext {
  reminderId: string;
  title: string;
  /** 原定触发时刻（UTC ms——occurrence 唯一键成员）。 */
  scheduledAt: number;
  timezone: string;
  missedCount: number;
  sourceRef: string | null;
  budget: { sum: number } | null;
  /** true=创建时明确授权自动派发；false=待用户确认（reminder.confirm）。 */
  autoDispatch: boolean;
  /** 已派发执行数（预算口径展示）。 */
  dispatchedCount: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** 人侧可见的唤醒消息体（system 来源——不伪装人类发言）。 */
export function renderReminderWakeMessage(ctx: ReminderWakeContext): string {
  const lines = [
    `【提醒触发】${ctx.title}`,
    `- occurrence：${ctx.reminderId}@${iso(ctx.scheduledAt)}（时区 ${ctx.timezone}）`,
    `- 原定时刻（UTC）：${iso(ctx.scheduledAt)}`,
    ctx.missedCount > 0 ? `- 本次合并了停机/休眠期间错过的 ${ctx.missedCount} 次计划触发（不逐次补跑）` : null,
    `- 来源：${ctx.sourceRef ?? '（本地创建）'}`,
    `- 预算：${ctx.budget != null ? `已用 ${ctx.dispatchedCount}/${ctx.budget.sum} 次执行` : '未设置'}`,
    ctx.autoDispatch
      ? '- 授权：创建时已明确授权自动派发——本次将作为正式任务执行。'
      : '- 授权：未授权自动执行——请在「待我处理」确认后派发（reminder.confirm）。',
  ].filter((x) => x != null);
  return lines.join('\n');
}

/** 派发为正式任务时的输入体（DEV-21-M3：模型收到的结构化上下文）。 */
export function renderReminderWakeInput(ctx: ReminderWakeContext): string {
  return [
    renderReminderWakeMessage(ctx),
    '',
    '请处理本次提醒触发：围绕提醒标题中的目标主动完成必要的查证、命令、修改和验证。',
    '这是单次触发输入；后续循环由系统调度器推进。若真实预算或工具限制阻止继续，说明已完成部分、实际限制和下一步所需条件。',
  ].join('\n');
}
