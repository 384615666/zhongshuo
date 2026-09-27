/**
 * CallerContext：服务端生成的调用上下文（§31.1 第 2 条、开工契约 §3.1）。
 *
 * 只由认证后的 daemon 入口生成，不能放进可自报的 CommandEnvelope；
 * 契约层不接受自报 authorId 作为授权依据；「仅用户可做」按实际调用主体判断，
 * 不按消息 author_type 判断（归属 ≠ 权限，§31.2 v1.20）。
 */
import { z } from 'zod';
import type { ConversationId } from './conversation.ts';
import type { MemberId, ProjectId } from './project.ts';
import type { RunId } from './run.ts';

/** 命令入口。 */
export type CommandEntry = 'ui' | 'zs' | 'mcp';

/**
 * 实际调用主体。MCP 外部助手的 actualPrincipal 始终 external_connection，
 * 不因 representedUserId 变为人类（开工契约 §3.1）。
 */
export type ActualPrincipal =
  | { kind: 'local_user'; id: string }
  | { kind: 'external_connection'; id: string }
  | { kind: 'paired_device'; id: string }
  /** zs 任务凭据：绑定成员、会话、运行与代次（开工契约 §6）。 */
  | { kind: 'agent_task_credential'; id: string };

/**
 * 操作集（授权范围第 2 维）。USER_ONLY_OPERATIONS 内的操作仅实际主体为
 * local_user（或映射到已认证人类的配对设备）时可执行；审批与验收永远只属于用户。
 */
export type OperationKind =
  | 'read'
  | 'conversation.read'
  | 'conversation.manage'
  | 'message.submit'
  | 'task.create'
  | 'task.steer'
  | 'task.stop'
  | 'task.resume'
  | 'task.review'
  | 'approval.respond'
  | 'member.configure'
  | 'room.manage'
  | 'artifact.read'
  | 'artifact.submit'
  | 'context.grant'
  | 'git.write'
  | 'budget.modify';

/** 仅用户可做：外部 AI（含外部助手/任务凭据）一律拒绝（§31.3、RT-28 ⑦）。 */
export const USER_ONLY_OPERATIONS: readonly OperationKind[] = [
  'task.review',
  'approval.respond',
  'member.configure',
  'budget.modify',
  'context.grant',
];

/** 会话范围（授权范围第 1 维：可读上下文）。读不蕴含唤醒。 */
export type ConversationScope =
  | { kind: 'all_in_project' }
  | { kind: 'listed'; conversationIds: readonly ConversationId[] };

/** 授权范围第 3 维：可调度成员。是连接发起工作链（子任务/交接/互唤）的硬上限（§31.5）。 */
export type DispatchMemberScope =
  | { kind: 'all_enabled' }
  | { kind: 'listed'; memberIds: readonly MemberId[] };

export interface CallerContext {
  /** 实际调用主体。 */
  actualPrincipal: ActualPrincipal;
  /** 所代表的用户（外部助手代操作时的归属展示；不授予操作权）。 */
  representedUserId?: string | null;
  entry: CommandEntry;
  credentialId: string;
  /** 当前直接接入的外部连接；与任务链最初发起连接 sourceConnectionId 分开。 */
  connectionId?: string | null;
  /** 可访问项目集合。 */
  projectIds: readonly ProjectId[];
  conversationScope: ConversationScope;
  operations: readonly OperationKind[];
  dispatchMemberScope: DispatchMemberScope;
  /** 第四维预算：发起连接工作链预算（本地 UI 根任务通常无连接链预算）。 */
  budgetGrantId?: string | null;
  /** 任务凭据绑定的运行链（zs 入口）。 */
  runId?: RunId | null;
  turnId?: string | null;
  epoch?: number | null;
  grantRevision: number;
}

export const actualPrincipalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('local_user'), id: z.string().min(1) }),
  z.strictObject({ kind: z.literal('external_connection'), id: z.string().min(1) }),
  z.strictObject({ kind: z.literal('paired_device'), id: z.string().min(1) }),
  z.strictObject({ kind: z.literal('agent_task_credential'), id: z.string().min(1) }),
]);

export const conversationScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('all_in_project') }),
  z.strictObject({ kind: z.literal('listed'), conversationIds: z.array(z.string().min(1)) }),
]);

export const dispatchMemberScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('all_enabled') }),
  z.strictObject({ kind: z.literal('listed'), memberIds: z.array(z.string().min(1)) }),
]);

export const callerContextSchema = z.strictObject({
  actualPrincipal: actualPrincipalSchema,
  representedUserId: z.string().min(1).nullable().optional(),
  entry: z.enum(['ui', 'zs', 'mcp']),
  credentialId: z.string().min(1),
  connectionId: z.string().min(1).nullable().optional(),
  projectIds: z.array(z.string().min(1)),
  conversationScope: conversationScopeSchema,
  operations: z.array(z.enum([
    'read', 'conversation.read', 'conversation.manage', 'message.submit', 'task.create',
    'task.steer', 'task.stop', 'task.resume', 'task.review', 'approval.respond',
    'member.configure', 'room.manage', 'artifact.read', 'artifact.submit',
    'context.grant', 'git.write', 'budget.modify',
  ])),
  dispatchMemberScope: dispatchMemberScopeSchema,
  budgetGrantId: z.string().min(1).nullable().optional(),
  runId: z.string().min(1).nullable().optional(),
  turnId: z.string().min(1).nullable().optional(),
  epoch: z.number().int().nonnegative().nullable().optional(),
  grantRevision: z.number().int().nonnegative(),
});

/** 本地 UI 变体：无 connectionId、全项目/全成员、全操作（权限由操作系统用户身份承载）。 */
export function localUiCaller(userId: string, projectIds: readonly ProjectId[]): CallerContext {
  return {
    actualPrincipal: { kind: 'local_user', id: userId },
    entry: 'ui',
    credentialId: `local-ui:${userId}`,
    connectionId: null,
    projectIds,
    conversationScope: { kind: 'all_in_project' },
    operations: [
      'read', 'conversation.read', 'conversation.manage', 'message.submit', 'task.create',
      'task.steer', 'task.stop', 'task.resume', 'task.review', 'approval.respond',
      'member.configure', 'room.manage', 'artifact.read', 'artifact.submit',
      'context.grant', 'git.write', 'budget.modify',
    ],
    dispatchMemberScope: { kind: 'all_enabled' },
    budgetGrantId: null,
    grantRevision: 0,
  };
}
