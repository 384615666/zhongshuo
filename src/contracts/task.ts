/**
 * 任务契约（§12.2 tasks/task_deliveries/change_sets + §10.5 可选任务验收 + 开工契约 §2.2 增量）。
 * 状态分开保存：Task.status=工作进展；task_deliveries.review_status=人工验收；
 * ChangeSet.application_status=文件是否已应用；Git commit=版本历史。任何一种不能自动推断另一种。
 */
import { z } from 'zod';
import type { ConversationId } from './conversation.ts';
import type { ProjectId, RoomId } from './project.ts';
import type { ThreadId } from './thread.ts';
import type { MessageId } from './message.ts';
import type { RunId } from './run.ts';
import type { Revision } from './common.ts';

export type TaskId = string;
export type DeliveryId = string;
export type ChangeSetId = string;
export type WorkspaceId = string;

/** room_task=房间任务；dm_turn=DM 内部执行任务（无房间任务号、不进看板）。 */
export type TaskKind = 'room_task' | 'dm_turn';

export type TaskStatus =
  | 'OPEN'
  | 'ACTIVE'
  | 'WAITING_USER'
  | 'BLOCKED'
  | 'REVIEW'
  | 'DONE'
  | 'CANCELLED';

/** 任务验收策略：创建用户任务时从项目 taskReviewEnabled 快照（§10.5）。 */
export type ReviewPolicy = 'auto_deliver' | 'user_review';

/** 交付验收状态；not_required≠已验收（关闭验收时 reviewed_by/at 为空，不伪造人工通过）。 */
export type DeliveryReviewStatus =
  | 'not_required'
  | 'pending'
  | 'accepted'
  | 'changes_requested'
  | 'superseded';

/** 文件应用状态（第十四批：与人工验收分开；旧 pending_review 语义废止）。 */
export type ChangeSetApplicationStatus = 'applied' | 'not_applied' | 'reverted' | 'partial';

export interface Task {
  id: TaskId;
  projectId: ProjectId;
  kind: TaskKind;
  conversationId: ConversationId;
  /** 仅 room_task：dm_turn 为 NULL。 */
  roomId?: RoomId | null;
  /** 仅 room_task：dm_turn 为 NULL。 */
  conversationThreadId?: ThreadId | null;
  /** 房间根任务＝原始工作请求；dm_turn＝本次用户输入消息。 */
  rootMessageId?: MessageId | null;
  /** 仅 room_task：房间任务号；(room_id,room_task_number) 唯一且非 NULL 约束。 */
  roomTaskNumber?: number | null;
  ownerMemberId?: string | null;
  parentTaskId?: TaskId | null;
  /**
   * 任务链发起连接（§31.8）：本机用户新建根任务为 null；
   * 外部任务派生的本地 zs 调用、子任务与提醒继承原来源/范围，不能因入口本地化清空。
   */
  sourceConnectionId?: string | null;
  title: string;
  objective?: string | null;
  status: TaskStatus;
  revision: Revision;
  reviewPolicy: ReviewPolicy;
  currentDeliveryId?: DeliveryId | null;
}

export const taskSchema = z.strictObject({
  id: z.string().min(1),
  projectId: z.string().min(1),
  kind: z.enum(['room_task', 'dm_turn']),
  conversationId: z.string().min(1),
  roomId: z.string().min(1).nullable().optional(),
  conversationThreadId: z.string().min(1).nullable().optional(),
  rootMessageId: z.string().min(1).nullable().optional(),
  roomTaskNumber: z.number().int().positive().nullable().optional(),
  ownerMemberId: z.string().min(1).nullable().optional(),
  parentTaskId: z.string().min(1).nullable().optional(),
  sourceConnectionId: z.string().min(1).nullable().optional(),
  title: z.string().min(1),
  objective: z.string().nullable().optional(),
  status: z.enum(['OPEN', 'ACTIVE', 'WAITING_USER', 'BLOCKED', 'REVIEW', 'DONE', 'CANCELLED']),
  revision: z.number().int().nonnegative(),
  reviewPolicy: z.enum(['auto_deliver', 'user_review']),
  currentDeliveryId: z.string().min(1).nullable().optional(),
}).refine((t) => {
  if (t.kind === 'dm_turn') {
    return t.roomId == null && t.conversationThreadId == null && t.roomTaskNumber == null;
  }
  return true;
}, {
  message: '私信任务包含了房间任务信息',
});

// ---------- 交付与验收（§10.5） ----------

export interface TaskDelivery {
  id: DeliveryId;
  taskId: TaskId;
  runId?: RunId | null;
  /** (task_id,revision) 唯一；一个任务最多一个 pending 版本。 */
  revision: number;
  manifestHash: string;
  artifactRefs: readonly string[];
  changeSetRefs: readonly string[];
  verificationRefs: readonly string[];
  reviewStatus: DeliveryReviewStatus;
  reviewedBy?: string | null;
  reviewedAt?: number | null;
  reviewNote?: string | null;
}

export const taskDeliverySchema = z.strictObject({
  id: z.string().min(1),
  taskId: z.string().min(1),
  runId: z.string().min(1).nullable().optional(),
  revision: z.number().int().positive(),
  manifestHash: z.string().min(1),
  artifactRefs: z.array(z.string()),
  changeSetRefs: z.array(z.string()),
  verificationRefs: z.array(z.string()),
  reviewStatus: z.enum(['not_required', 'pending', 'accepted', 'changes_requested', 'superseded']),
  reviewedBy: z.string().min(1).nullable().optional(),
  reviewedAt: z.number().int().nonnegative().nullable().optional(),
  reviewNote: z.string().nullable().optional(),
}).refine((d) => (d.reviewStatus === 'not_required') === (d.reviewedBy == null && d.reviewedAt == null), {
  message: '验收记录不完整或与当前设置不一致',
});

/** task.delivery.review：仅人类可提交，携带目标版本；request_changes 必填意见（§15.2）。 */
export interface TaskDeliveryReviewParams {
  taskId: TaskId;
  deliveryId: DeliveryId;
  expectedRevision: Revision;
  manifestHash: string;
  decision: 'accept' | 'request_changes';
  note?: string;
}

export const taskDeliveryReviewParamsSchema = z.strictObject({
  taskId: z.string().min(1),
  deliveryId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  manifestHash: z.string().min(1),
  decision: z.enum(['accept', 'request_changes']),
  note: z.string().optional(),
}).refine((p) => p.decision !== 'request_changes' || (p.note != null && p.note.length > 0), {
  message: '请填写需要修改的内容',
});

// ---------- 改动集 ----------

export interface ChangeSet {
  id: ChangeSetId;
  projectId: ProjectId;
  taskId?: TaskId | null;
  workspaceId?: WorkspaceId | null;
  beforeRef: string;
  afterRef: string;
  applicationStatus: ChangeSetApplicationStatus;
  manifestJson?: unknown;
}

export const changeSetSchema = z.strictObject({
  id: z.string().min(1),
  projectId: z.string().min(1),
  taskId: z.string().min(1).nullable().optional(),
  workspaceId: z.string().min(1).nullable().optional(),
  beforeRef: z.string().min(1),
  afterRef: z.string().min(1),
  applicationStatus: z.enum(['applied', 'not_applied', 'reverted', 'partial']),
  manifestJson: z.unknown().optional(),
});

// ---------- 停止 / 继续 / 补充（§15.2、开工契约 §2.3/§3.2） ----------

/** 停止结果：旧 run 的停止请求返回 target_obsolete，不修改新 run、不取消后续运行。 */
export type TaskStopOutcome = 'stopping' | 'stopped' | 'already_stopped' | 'target_obsolete';

export interface TaskStopParams {
  taskId: TaskId;
  targetRunId: RunId;
  expectedStopGeneration: number;
  commandId: string;
}

export interface TaskStopResult {
  outcome: TaskStopOutcome;
  stopGeneration: number;
}

/** task.resume：只允许人类显式继续；重新核对归档、成员、权限和预算。 */
export interface TaskResumeParams {
  taskId: TaskId;
  expectedRevision: Revision;
  commandId: string;
}

export type SteerDeliveryPolicy = 'inline' | 'after_turn' | 'requires_restart';
export type SteerDisposition = 'accepted' | 'queued' | 'requires_restart';

export interface TaskSteerParams {
  taskId: TaskId;
  body: string;
  deliveryPolicy: SteerDeliveryPolicy;
  commandId: string;
}

export interface TaskSteerResult {
  disposition: SteerDisposition;
  turnId?: string | null;
}
