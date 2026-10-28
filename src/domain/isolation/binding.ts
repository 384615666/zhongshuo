/**
 * 目标绑定与会话隔离纯校验（DEV-17 最小隔离，G1/G3 前置）。
 * - turn/run/task/conversation/thread 五级归属必须一致（服务端绑定，不能随 UI 切换漂移）。
 * - 事件归属：agent 输出继承 AgentTurn.threadId，不能用结果参数更换目的地（§4.5）。
 * - RuntimeSession 复用键（§13.4/开工契约 §2.2）：任务按 (project,thread,member,task,generation)；
 *   DM 按 (project,conversation,member,generation) 且 task_id 为空、不跨对话复用。
 */
import { domainErr, domainOk } from '../../contracts/errors.ts';
import type { DomainResult } from '../../contracts/errors.ts';

export interface BindingEntityRefs {
  task: { id: string; projectId: string; conversationId: string; threadId: string | null };
  run: { id: string; taskId: string; conversationId: string; threadId: string | null; mode: string };
  turn: { id: string; runId: string; conversationId: string; threadId: string | null; memberId: string };
  thread: { id: string; projectId: string; conversationId: string; roomId: string } | null;
}

/** 五级归属校验：任何一级不匹配即拒绝（不猜测、不兜底）。 */
export function validateExecutionBinding(refs: BindingEntityRefs): DomainResult<{ bound: true }> {
  if (refs.run.taskId !== refs.task.id) {
    return domainErr('THREAD_SCOPE_MISMATCH', 'run 不属于目标任务');
  }
  if (refs.turn.runId !== refs.run.id) {
    return domainErr('THREAD_SCOPE_MISMATCH', 'turn 不属于目标运行');
  }
  if (refs.run.conversationId !== refs.task.conversationId || refs.turn.conversationId !== refs.task.conversationId) {
    return domainErr('CONVERSATION_SCOPE_MISMATCH', '执行记录与当前对话不匹配');
  }
  if (refs.run.threadId !== refs.task.threadId || refs.turn.threadId !== refs.task.threadId) {
    return domainErr('THREAD_SCOPE_MISMATCH', '执行记录与当前回复串不匹配');
  }
  if (refs.thread != null) {
    if (refs.thread.id !== refs.task.threadId) {
      return domainErr('THREAD_SCOPE_MISMATCH', '线程实体与任务绑定不一致');
    }
    if (refs.thread.conversationId !== refs.task.conversationId) {
      return domainErr('CONVERSATION_SCOPE_MISMATCH', '线程不属于任务会话');
    }
  }
  return domainOk({ bound: true });
}

/** 事件归属校验：规范化事件必须落在其 turn 的绑定目标上（迟到/串线事件拒绝改变状态）。 */
export function validateEventAttribution(input: {
  event: { turnId?: string | null; sessionId: string };
  turn: { id: string; conversationId: string; threadId: string | null };
  eventThreadId?: string | null;
}): DomainResult<{ attributed: true }> {
  if (input.event.turnId == null) {
    return domainOk({ attributed: true }); // process.exited 等无 turn 事件
  }
  if (input.event.turnId !== input.turn.id) {
    return domainErr('THREAD_SCOPE_MISMATCH', '事件携带的 turnId 与执行 turn 不一致（迟到事件走审计，不改变当前状态）');
  }
  if (input.eventThreadId != null && input.eventThreadId !== input.turn.threadId) {
    return domainErr('THREAD_SCOPE_MISMATCH', '事件目标线程与 turn 绑定线程不一致（agent 不能更换目的地）');
  }
  return domainOk({ attributed: true });
}

// ---------- 会话复用键（§13.4） ----------

export interface TaskSessionKeyInput {
  projectId: string;
  threadId: string;
  memberId: string;
  taskId: string;
  sessionGeneration: number;
}

export interface DmSessionKeyInput {
  projectId: string;
  conversationId: string;
  memberId: string;
  sessionGeneration: number;
}

/** 任务会话键：同一任务同一代次复用；换任务/线程/代次即新会话。 */
export function taskSessionKey(key: TaskSessionKeyInput): string {
  return `task:${key.projectId}:${key.threadId}:${key.memberId}:${key.taskId}:${key.sessionGeneration}`;
}

/** DM 会话键：按会话+成员+代次续接；task 维度不参与（当前 task 由 turn 绑定），不跨对话复用。 */
export function dmSessionKey(key: DmSessionKeyInput): string {
  return `dm:${key.projectId}:${key.conversationId}:${key.memberId}:${key.sessionGeneration}`;
}
