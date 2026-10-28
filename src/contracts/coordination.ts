import { z } from 'zod';

/** The daemon supplies the eligible roster. A model proposes work, never authority. */
export const coordinationStepSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  memberId: z.string().min(1).max(160),
  title: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  role: z.enum(['analysis', 'implementation', 'review']),
  dependsOn: z.array(z.string().max(40)),
});
export const coordinationPlanSchema = z.strictObject({
  summary: z.string().trim().min(1),
  steps: z.array(coordinationStepSchema).min(1),
});
export type CoordinationPlan = z.infer<typeof coordinationPlanSchema>;

/** Concrete messages proposed by the executing model; identities, recipients,
 * permission and budgets are checked by the daemon before accepting a handoff. */
export const memberHandoffSchema=z.strictObject({
  toMemberId:z.string().min(1).max(160),
  message:z.string().trim().min(1),
  purpose:z.enum(['ask','review','implement','reply']),
});
export type MemberHandoff=z.infer<typeof memberHandoffSchema>;

/** Stable dependency order, independent of the model's array presentation order. */
export function coordinationTopologicalSteps(plan:CoordinationPlan):CoordinationPlan['steps'] {
  const ordered:CoordinationPlan['steps']=[],visited=new Set<string>(),visiting=new Set<string>();
  const visit=(key:string):void=>{
    if(visiting.has(key))throw Error('分工依赖存在循环');if(visited.has(key))return;
    const step=plan.steps.find(s=>s.key===key);if(!step)throw Error('分工依赖不存在');
    visiting.add(key);for(const dependency of step.dependsOn)visit(dependency);visiting.delete(key);visited.add(key);ordered.push(step);
  };
  for(const step of plan.steps)visit(step.key);return ordered;
}

export function validateCoordinationPlan(value: unknown, eligibleMemberIds: readonly string[], options?: { accumulated?: boolean }): CoordinationPlan {
  // Individual and accumulated work use the same identity/dependency contract.
  void options;
  const plan = coordinationPlanSchema.parse(value);
  const allowed = new Set(eligibleMemberIds);
  const byKey = new Map(plan.steps.map(step => [step.key, step]));
  if (byKey.size !== plan.steps.length) throw Error('分工计划包含重复步骤');
  for (const step of plan.steps) {
    if (!allowed.has(step.memberId)) throw Error('分工成员不在本轮获准名单中');
    if (new Set(step.dependsOn).size !== step.dependsOn.length) throw Error('分工依赖重复');
    for (const key of step.dependsOn) if (!byKey.has(key)) throw Error('分工依赖不存在');
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw Error('分工依赖存在循环');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of byKey.get(key)!.dependsOn) visit(dependency);
    visiting.delete(key); visited.add(key);
  };
  for (const key of byKey.keys()) visit(key);
  return plan;
}

export const COORDINATION_MAX_CALLS = 24;
export const COORDINATION_INTEGRATION_RESERVE = 2;

export interface CoordinationDetails {
  runId:string;state:string;summary:string;errorMessage:string|null;usedCalls:number;maxCalls:number;
  enforcement?: 'enabled'|'disabled'|'legacy';
  steps:Array<{key:string;taskId:string;title:string;status:string;role:string;memberId:string;displayName:string;
    model:string|null;channel:string|null;dependsOn:string[];deliveryId:string|null;deliveryRevision:number|null;manifestHash:string|null;locate:string;
    inputVersions?:Array<{deliveryId:string;revision:number;manifestHash:string}>;reviewVersionCurrent?:boolean|null}>;
}

/** Includes reserved/unknown attempts. Child-local budgets never enlarge the parent cap. */
export function coordinationCallAvailable(used: number, phase: 'work' | 'integration'): boolean {
  if (!Number.isSafeInteger(used) || used < 0) return false;
  return used < COORDINATION_MAX_CALLS - (phase === 'work' ? COORDINATION_INTEGRATION_RESERVE : 0);
}
