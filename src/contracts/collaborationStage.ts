/**
 * 研讨阶段可见性契约（R91 模块2/模块3 前后端接口）。
 *
 * 只描述**已完成阶段产物被投影为正式消息**时附带的呈现标记：
 * `body_json.collaborationStage = { stage, roundNo, turnId, runId }`。
 *
 * - stage 只用工作流既有阶段枚举中的五个中间阶段（PREPARE/PUBLISH 由程序完成，不是
 *   模型产物，故不在可见阶段集合内）；格式检查点属于 ISSUE_DISCUSSION 阶段内部动作，
 *   投影时归入 ISSUE_DISCUSSION，不发明 `CHECKPOINT` 客户端猜测值。
 * - roundNo 为阶段轮次（INDEPENDENT/CROSS_REVIEW/SYNTHESIS/RATIFY 为 0，争议讨论/检查点
 *   为实际轮次）；前端只对 >0 的轮次显示「第N轮」。
 * - turnId/runId 是持久化与审计身份，只在数据层携带；界面不展示。
 */
import { z } from 'zod';

/** 可投影为串内正式消息的研讨阶段（工作流既有枚举的子集）。 */
export const DELIBERATION_VISIBLE_STAGES = [
  'INDEPENDENT',
  'CROSS_REVIEW',
  'ISSUE_DISCUSSION',
  'SYNTHESIS',
  'RATIFY',
] as const;
export type DeliberationVisibleStage = (typeof DELIBERATION_VISIBLE_STAGES)[number];

/** 阶段中文标签（服务端正文投影使用；前端另有呈现映射，语义一致即可）。 */
export const DELIBERATION_VISIBLE_STAGE_LABELS: Record<DeliberationVisibleStage, string> = {
  INDEPENDENT: '独立分析',
  CROSS_REVIEW: '互评',
  ISSUE_DISCUSSION: '争议讨论',
  SYNTHESIS: '整合',
  RATIFY: '确认',
};

export const collaborationStageSchema = z.strictObject({
  stage: z.enum(DELIBERATION_VISIBLE_STAGES),
  roundNo: z.number().int().nonnegative(),
  turnId: z.string().min(1),
  runId: z.string().min(1),
});

/** `body_json.collaborationStage` 的完整形状（可选附加在普通消息正文上）。 */
export type CollaborationStageMetadata = z.infer<typeof collaborationStageSchema>;
