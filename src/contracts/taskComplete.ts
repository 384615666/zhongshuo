/** Browser-safe runtime result contract shared by dispatch and chat projection. */
import {z} from 'zod';
import {coordinationPlanSchema,memberHandoffSchema} from './coordination.ts';
import {documentSchema} from './document.ts';

export const TASK_COMPLETE_SCHEMA_VERSION='task-complete-v1';
export const taskCompleteSchema=z.strictObject({
  schemaVersion:z.literal(TASK_COMPLETE_SCHEMA_VERSION),
  resultKey:z.string().min(1),
  changeSummary:z.string(),
  answer:z.string().optional(),
  /** Short visible reply and its complete, human-readable Markdown detail. */
  detailMarkdown:z.string().optional(),
  /** Optional model-authored document; null is a valid short-reply result. */
  document:documentSchema.nullable().optional(),
  responseKind:z.enum(['conversation','work']).optional(),
  /** Internal completion is still required when no visible reply is useful. */
  replyDisposition:z.enum(['reply','none']).optional(),
  /** Only work depending on this answer waits; independent peer steps may proceed. */
  userQuestion:z.string().trim().min(1).max(8000).nullable().optional(),
  files:z.array(z.string()),
  executedVerifications:z.array(z.string()),
  unexecutedVerifications:z.array(z.strictObject({item:z.string(),reason:z.string()})),
  remainingIssues:z.array(z.string()),
  coordinationPlan:coordinationPlanSchema.nullable().optional(),
  handoffs:z.array(memberHandoffSchema).max(4).optional(),
});
export type TaskComplete=z.infer<typeof taskCompleteSchema>;

export function taskCompleteOutputSchema(resultKey:string,planning=false){
  const common=taskCompleteSchema.omit({coordinationPlan:true,detailMarkdown:true,document:true}).extend({
    resultKey:z.literal(resultKey),
    answer:z.string(),
    // Provider structured-output schemas require every declared property. Keep it
    // semantically optional through null when no document is useful.
    document:documentSchema.nullable(),
    responseKind:z.enum(['conversation','work']),
    replyDisposition:z.enum(['reply','none']),
    userQuestion:z.string().trim().min(1).max(8000).nullable(),
    handoffs:z.array(memberHandoffSchema).max(4),
  });
  // Claude CLI validates draft-07; Codex shares the same closed object schema.
  return z.toJSONSchema(planning?common.extend({coordinationPlan:coordinationPlanSchema.nullable()}):common,{target:'draft-7'});
}
