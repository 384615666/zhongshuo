/** Only complete, natural runtime message blocks are eligible for the compact
 * live progress view. Control objects, partial JSON and fenced output stay in
 * runtime evidence and cannot masquerade as an AI acknowledgement. Human text
 * never passes through this projection. */
export function visibleRuntimeProgress(text:string):string|null {
  const value=text.trim();
  if(!value||/^[{["`]/.test(value))return null;
  if(/(?:"(?:schemaVersion|resultKey|coordinationPlan)"\s*:|task-complete-v1)/.test(value))return null;
  return value.slice(0,2000);
}

export interface ThreadVisibleProgress {
  turnId:string;memberId:string;status:string;text:string|null;updatedAt:number|null;
  phase:'connecting'|'connected'|'responding';
}
