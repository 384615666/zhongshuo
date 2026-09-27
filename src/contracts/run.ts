/**
 * WorkflowRun / AgentTurn / 参与者契约（§10.1、§12.2）。
 * Task 保存长期目标；WorkflowRun 是一次执行尝试；AgentTurn 是一次输入到结束事件的调用。
 */
import { z } from 'zod';
import type { Mode } from './routing.ts';
import type { ConversationId } from './conversation.ts';
import type { ThreadId } from './thread.ts';
import type { MemberId, ProjectId } from './project.ts';
import type { TaskId } from './task.ts';
import type { Revision } from './common.ts';

export type RunId = string;
export type TurnId = string;
export type SessionId = string;

export type RunStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING'
  | 'STOPPING'
  | 'SUCCEEDED'
  | 'PARTIAL'
  | 'FAILED'
  | 'CANCELLED'
  | 'INTERRUPTED';

/** run 终态判定（§10.2 迟到事件不能改变当前状态）。 */
export const RUN_TERMINAL_STATUSES: readonly RunStatus[] = [
  'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'INTERRUPTED',
];

export function isRunTerminal(status: RunStatus): boolean {
  return RUN_TERMINAL_STATUSES.includes(status);
}

/**
 * DELIBERATE 阶段枚举（§6.1）。PREPARE/PUBLISH 由程序完成不调用模型；
 * ISSUE_REVIEW_CHECKPOINT 只是模板标签，不得写进 stage 枚举（§6.1）。
 */
export type DeliberateStage =
  | 'PREPARE'
  | 'INDEPENDENT'
  | 'CROSS_REVIEW'
  | 'ISSUE_DISCUSSION'
  | 'SYNTHESIS'
  | 'RATIFY'
  | 'PUBLISH';

/**
 * WorkflowRun.stage：DELIBERATE 用 DeliberateStage；AUTO/DIRECT 的阶段编排
 * 由后续包（DEV-09/11）定稿，先以字符串承载，不用未定枚举冒充已定契约。
 */
export type WorkflowRunStage = DeliberateStage | (string & {});

export interface WorkflowRun {
  id: RunId;
  taskId: TaskId;
  conversationId: ConversationId;
  /** DM 内部 run：thread_id 为空、mode=DIRECT（开工契约 §2.2）。 */
  threadId?: ThreadId | null;
  mode: Mode;
  taskRevision: number;
  status: RunStatus;
  stage?: WorkflowRunStage | null;
  roundNo?: number | null;
  rosterRevision?: number | null;
  budgetJson?: unknown;
  revision: Revision;
}

export const workflowRunSchema = z.strictObject({
  id: z.string().min(1),
  taskId: z.string().min(1),
  conversationId: z.string().min(1),
  threadId: z.string().min(1).nullable().optional(),
  mode: z.enum(['AUTO', 'DELIBERATE', 'DIRECT']),
  taskRevision: z.number().int().nonnegative(),
  status: z.enum([
    'QUEUED', 'RUNNING', 'WAITING', 'STOPPING',
    'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'INTERRUPTED',
  ]),
  stage: z.string().nullable().optional(),
  roundNo: z.number().int().nonnegative().nullable().optional(),
  rosterRevision: z.number().int().nonnegative().nullable().optional(),
  budgetJson: z.unknown().optional(),
  revision: z.number().int().nonnegative(),
});

/** 一次成员调用（§12.2 agent_turns）。 */
export type TurnPurpose = 'stage_work' | 'checkpoint' | 'format_repair';

export type TurnStatus =
  | 'PENDING'
  | 'DISPATCHING'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'WAITING_INPUT'
  | 'STOPPING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface AgentTurn {
  id: TurnId;
  runId: RunId;
  conversationId: ConversationId;
  threadId?: ThreadId | null;
  memberId: MemberId;
  /** 阶段、轮次、职责和目标成果版本的组合键，避免主持 checkpoint 与同轮普通意见冲突（§12.2）。 */
  stageKey: string;
  turnPurpose: TurnPurpose;
  attempt: number;
  /** 递增 attemptEpoch：过期 worker 的结果不能改变当前任务（§11.4）。 */
  epoch: number;
  status: TurnStatus;
  dispatchKey?: string | null;
  sessionId?: SessionId | null;
}

export const agentTurnSchema = z.strictObject({
  id: z.string().min(1),
  runId: z.string().min(1),
  conversationId: z.string().min(1),
  threadId: z.string().min(1).nullable().optional(),
  memberId: z.string().min(1),
  stageKey: z.string().min(1),
  turnPurpose: z.enum(['stage_work', 'checkpoint', 'format_repair']),
  attempt: z.number().int().positive(),
  epoch: z.number().int().nonnegative(),
  status: z.enum([
    'PENDING', 'DISPATCHING', 'RUNNING', 'WAITING_APPROVAL', 'WAITING_INPUT',
    'STOPPING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN',
  ]),
  dispatchKey: z.string().min(1).nullable().optional(),
  sessionId: z.string().min(1).nullable().optional(),
});

/** 本次冻结参与者（run_participants）；与阅读关注、跨运行跟进名单分离（§12.2/R5）。 */
export interface RunParticipant {
  runId: RunId;
  memberId: MemberId;
  role: string;
  expected: boolean;
  status: string;
}

/** RuntimeSession 复用键下限（§13.4）；DM 按 conversation/member/generation 续接。 */
export interface RuntimeSessionRef {
  id: SessionId;
  projectId: ProjectId;
  conversationId: ConversationId;
  scopeKind: 'task' | 'dm';
  threadId?: ThreadId | null;
  memberId: MemberId;
  /** DM session 的 task_id 为空；当前 task 由 turn 绑定。 */
  taskId?: TaskId | null;
  sessionGeneration: number;
  providerSessionId?: string | null;
}
