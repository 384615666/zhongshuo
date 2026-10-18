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
  runId:string;
  stage:string|null;
  waitStartedAt:number|null;
}

function waitedText(waitStartedAt:number|null, now:number):string {
  if(waitStartedAt==null)return '';
  const seconds=Math.max(0,Math.floor((now-waitStartedAt)/1000));
  if(seconds<60)return ` · 已等待 ${seconds} 秒`;
  const minutes=Math.floor(seconds/60);
  if(minutes<60)return ` · 已等待 ${minutes} 分钟`;
  const hours=Math.floor(minutes/60);
  return ` · 已等待 ${hours} 小时 ${minutes%60} 分钟`;
}

/** One factual status line for the live progress card. Waiting object comes
 * from persisted turn/run state, never from transport connection alone. */
export function runtimeProgressWaitLabel(progress:Pick<ThreadVisibleProgress,'status'|'phase'|'waitStartedAt'>,now=Date.now()):string {
  if(progress.status==='STOPPING')return '正在停止';
  if(progress.status==='WAITING_APPROVAL')return `等待你确认操作${waitedText(progress.waitStartedAt,now)}`;
  if(progress.status==='WAITING_INPUT')return `等待你补充信息${waitedText(progress.waitStartedAt,now)}`;
  if(progress.status==='PENDING'||progress.status==='DISPATCHING')return `等待执行席位${waitedText(progress.waitStartedAt,now)}`;
  if(progress.phase==='connecting')return `正在连接模型${waitedText(progress.waitStartedAt,now)}`;
  if(progress.phase==='connected')return `等待模型回应${waitedText(progress.waitStartedAt,now)}`;
  return '正在返回内容';
}
