/**
 * 发送意图、协作模式、结构化 mention 与路由结果契约（§4.1/§4.2/§4.6、§0.22、开工契约 §2.3）。
 *
 * 关键不变量：
 * - Mode 仅 AUTO / DELIBERATE / DIRECT 三种；SendIntent（default/record_only）是发送意图，
 *   与 Mode 分开建模，类型层面不得把 'record_only' 当 Mode（类型测试覆盖）。
 * - 路由只认结构化 mention 节点；正文、引用、代码块、日志、工具输出中的 @ 永不触发（§4.1/AT-09），
 *   该口径同样适用于外部 AI 写入的文本（§31.1 第 5 条）。
 * - 原任务/讨论常驻切换已取消（2026-09-25），不存在 '讨论' Mode 或常驻切换参数。
 */
import { z } from 'zod';
import type { ConversationId } from './conversation.ts';
import type { MemberId } from './project.ts';

/** 三种协作模式（§4.2）。DM 内部执行固定 DIRECT，但那由 daemon 决定，不在 UI/路由层推导。 */
export type Mode = 'AUTO' | 'DELIBERATE' | 'DIRECT';

/**
 * 发送意图：'default'=普通发送（默认与 AI 交流）；'record_only'=一次性「仅记录，不请求回复」。
 * record_only 不创建任务/运行、不调用模型、不计预算、不 steering；保存后意图复位为 default
 * （复位由调用方持久化，路由函数本身无状态）。
 */
export type SendIntent = 'default' | 'record_only';

/** 结构化 mention 节点：memberId 或 'all'。只有输入框识别的节点参与路由。 */
export type MentionNode =
  | { kind: 'member'; memberId: MemberId }
  | { kind: 'all' };

export const mentionNodeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('member'), memberId: z.string().min(1) }),
  z.strictObject({ kind: z.literal('all') }),
]);

// ---------- 路由结果（message.submit.resolvedRoute 的载荷） ----------

/** 顶层（主池根消息）路由结果。 */
export type TopLevelRouteOutcome =
  | {
      kind: 'record_only';
      /** 显式一次性「仅记录」：零任务、零运行、零派发、零预算；mention 节点不参与判定。 */
      reason: 'explicit_record_only';
    }
  | {
      kind: 'dispatch';
      mode: 'AUTO';
      /** 无 mention：默认协调者接单。 */
      coordinatorMemberId: MemberId;
      /** R87 explicit recipients constrain the whole natural collaboration. */
      participantScope?: 'selected';
      /** Ordinary @all: independent delivery, without model-led planning. */
      dispatchStyle?: 'broadcast';
      frozenMemberIds: readonly MemberId[];
      initialWakeMemberIds: readonly MemberId[];
    }
  | {
      kind: 'dispatch';
      mode: 'DIRECT';
      /** 单个明确 mention：仅指定成员，其他成员零调用（AT-07）。 */
      targetMemberId: MemberId;
      frozenMemberIds: readonly MemberId[];
      initialWakeMemberIds: readonly MemberId[];
    }
  | {
      kind: 'dispatch';
      mode: 'DELIBERATE';
      /** @全体=冻结房间全部启用 agent（rosterSource='all'）；多个 mention=仅所选子集（'selected'）。
       *  同时有 @全体 与单独 mention 时以全体为准并去重。 */
      rosterSource: 'all' | 'selected';
      frozenMemberIds: readonly MemberId[];
      initialWakeMemberIds: readonly MemberId[];
    };

/** 私信路由结果（§4.6 一对一）：不推导 Mode、不涉及协调者、无群聊冻结名单选择。 */
export type DmRouteOutcome =
  | {
      kind: 'record_only';
      reason: 'explicit_record_only';
      conversationId: ConversationId;
    }
  | {
      kind: 'deliver_to_peer';
      conversationId: ConversationId;
      /** 会话唯一对端成员。 */
      peerMemberId: MemberId;
      /** agent 对端=daemon 建立 dm_turn/DIRECT 内部执行；human 对端只投递，派发集合为空。 */
      executes: boolean;
    };

/** 串内跟进路由结果（§4.2 讨论串行）。 */
export type ThreadFollowUpOutcome =
  | {
      /** 历史记录串（root_task_id 为空）默认仍是保存记录（兼容例外）；讨论线程永不唤醒 agent。 */
      kind: 'record_only';
      reason: 'record_thread_default' | 'explicit_record_only';
    }
  | {
      /** 无 mention：延续当前任务参与者与当前模式（steering / 待处理输入）。 */
      kind: 'steering';
    }
  | {
      /** 点名当前参与者：在当前任务规则内定向提问，不重建工作流。 */
      kind: 'directed_question';
      memberIds: readonly MemberId[];
    }
  | {
      /** 点名非参与者：产出「待用户确认的扩大参与范围」，不直接唤醒（决策 10）。 */
      kind: 'expansion_proposal';
      candidateMemberIds: readonly MemberId[];
    };
