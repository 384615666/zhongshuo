/** Browser-safe runtime result contract shared by dispatch and chat projection. */
import {z} from 'zod';
import {coordinationPlanSchema} from './coordination.ts';

export const TASK_COMPLETE_SCHEMA_VERSION='task-complete-v1';
export const taskCompleteSchema=z.strictObject({
  schemaVersion:z.literal(TASK_COMPLETE_SCHEMA_VERSION),
  resultKey:z.string().min(1),
  changeSummary:z.string(),
  answer:z.string().optional(),
  responseKind:z.enum(['conversation','work']).optional(),
  files:z.array(z.string()),
  executedVerifications:z.array(z.string()),
  unexecutedVerifications:z.array(z.strictObject({item:z.string(),reason:z.string()})),
  remainingIssues:z.array(z.string()),
  coordinationPlan:coordinationPlanSchema.nullable().optional(),
});
export type TaskComplete=z.infer<typeof taskCompleteSchema>;

export function taskCompleteOutputSchema(resultKey:string,planning=false){
  const common=taskCompleteSchema.omit({coordinationPlan:true}).extend({resultKey:z.literal(resultKey),answer:z.string(),responseKind:z.enum(['conversation','work'])});
  // Claude CLI validates draft-07; Codex shares the same closed object schema.
  return z.toJSONSchema(planning?common.extend({coordinationPlan:coordinationPlanSchema.nullable()}):common,{target:'draft-7'});
}
