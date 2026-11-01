import type {RecoveryInspection} from '../contracts/recoveryInspection.ts';
import {safeRuntimeToolText} from '../contracts/runtimeProgress.ts';
import type {ZhongshuoDatabase} from '../persistence/db.ts';
import {getTurnProcessRegistration,type QueryFn} from './processRegistry.ts';
import type {TreeScan} from './processCheck.ts';
import {verifyPreviousManagedOwnerExit} from './managed/previousOwnerExit.ts';

export interface RecoveryInspectionOptions {
  appDataDir?: string;
  instance?: {pid:number;startedAt:number};
  query?: QueryFn;
  treeScan?: (pid:number,historical:Array<{pid:number;startedAt:number|null}>)=>TreeScan;
  managedEvidence?: (jobId:string)=>{pid:number|null;releasable:boolean;reason:string}|undefined;
}

/** Read durable business facts and current OS evidence without reconciliation,
 * budget changes, lease release or dispatch. A missing final answer is visible. */
export function inspectRecovery(db:ZhongshuoDatabase,turnId:string,options:RecoveryInspectionOptions):RecoveryInspection|null {
  const turn=db.prepare(`SELECT a.id,a.status,a.protection_state,a.budget_mark,r.task_id,t.parent_task_id,t.title,
    t.project_id,t.conversation_id,pm.display_name FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id
    JOIN tasks t ON t.id=r.task_id LEFT JOIN project_members pm ON pm.id=a.member_id WHERE a.id=?`).get(turnId) as {
    id:string;status:string;protection_state:string|null;budget_mark:string|null;task_id:string;parent_task_id:string|null;
    title:string;project_id:string;conversation_id:string;display_name:string|null;
  }|undefined;
  if(!turn)return null;
  const now=Date.now();
  const outcome:RecoveryInspection={schemaVersion:'recovery-inspection-v1',turnId,taskId:turn.task_id,parentTaskId:turn.parent_task_id,
    taskTitle:turn.title,memberName:turn.display_name??'AI 成员',turnStatus:turn.status,protectionState:turn.protection_state,budgetMark:turn.budget_mark,
    result:{complete:turn.status==='SUCCEEDED',answer:null,files:[]},lastActivity:null,
    exitCheck:{state:'blocked',message:'尚不能确认旧执行已经结束。',action:'retry',checkedAt:now}};
  const reply=db.prepare(`SELECT body_json FROM messages WHERE task_id=? AND author_type='agent'
    AND substr(id,1,length(?))=? ORDER BY rowid DESC LIMIT 1`).get(turn.task_id,`msg_${turnId}_`,`msg_${turnId}_`) as {body_json:string}|undefined;
  if(reply){
    try{
      const body=JSON.parse(reply.body_json) as {text?:string;runtimeControlResult?:string};
      let answer=body.text;
      try{const control=JSON.parse(body.runtimeControlResult??body.text??'') as {answer?:string;changeSummary?:string};answer=control.answer??control.changeSummary??answer;}catch{/* Natural partial replies are still readable. */}
      if(answer?.trim())outcome.result.answer=answer;
    }catch{/* Corrupt history is not a completed result. */}
  }
  outcome.result.files=db.prepare(`SELECT DISTINCT a.id artifactId,COALESCE(f.display_name,f.path) filename,a.kind
    FROM message_file_changes f JOIN artifacts a ON a.id=f.artifact_id
    WHERE f.turn_id=? AND f.task_id=? AND f.project_id=? AND f.conversation_id=? AND a.task_id=f.task_id
      AND a.project_id=f.project_id AND a.conversation_id=f.conversation_id
    ORDER BY f.rowid`).all(turnId,turn.task_id,turn.project_id,turn.conversation_id) as RecoveryInspection['result']['files'];
  const activity=db.prepare(`SELECT kind,created_at,payload_json FROM domain_events WHERE turn_id=?
    AND kind IN ('tool.started','tool.completed') ORDER BY seq DESC LIMIT 1`).get(turnId) as {kind:string;created_at:number;payload_json:string}|undefined;
  if(activity){
    try{
      const p=JSON.parse(activity.payload_json) as Record<string,unknown>;
      outcome.lastActivity={at:activity.created_at,description:safeRuntimeToolText(p.target??p.argumentsSummary??p.toolName??'工具活动',300),outcome:typeof p.outcome==='string'?p.outcome:null};
    }catch{/* Missing activity does not fabricate a result. */}
  }
  const released=db.prepare(`SELECT 1 FROM domain_events WHERE turn_id=? AND kind='recovery.protectionReleased'
    AND json_extract(payload_json,'$.released')=1 LIMIT 1`).get(turnId);
  const leases=db.prepare("SELECT 1 FROM workspace_leases WHERE owner_turn_id=? AND status!='released' LIMIT 1").get(turnId);
  if(!['UNKNOWN','FAILED','CANCELLED','SUCCEEDED'].includes(turn.status)){
    outcome.exitCheck.message='这次执行仍在进行，请先停止任务，再检查。';
    return outcome;
  }
  if(turn.protection_state!=='retained'&&!leases&&(turn.status!=='UNKNOWN'||released)){
    outcome.exitCheck={state:'released',message:'旧执行的占用已解除。原结果和记录保留，可以回原任务继续。',action:'none',checkedAt:now};
    return outcome;
  }
  const reg=getTurnProcessRegistration(db,turnId);
  try{
    if(!reg)throw Error('旧执行缺少进程登记，暂不能确认退出。');
    if(reg.process_model==='none'&&reg.identity_source==='none'&&reg.pid==null&&reg.started_at_ms==null){
      outcome.exitCheck={state:'ready',message:'程序已确认这次执行没有遗留进程；可以解除占用，保留原结果。',action:'release',checkedAt:now};
    }else if(reg.identity_source==='managed-job'&&reg.managed_job_id){
      const managed=options.managedEvidence?.(reg.managed_job_id);
      if(managed){
        if(managed.pid!==reg.pid||!managed.releasable)throw Error(managed.reason||'旧执行尚未完全结束。');
      }else{
        if(!options.instance||!options.appDataDir)throw Error('当前服务无法核查旧执行，请在本机桌面重新打开众说后检查。');
        verifyPreviousManagedOwnerExit(db,reg,{appDataDir:options.appDataDir,instance:options.instance,now,query:options.query,treeScan:options.treeScan});
      }
      outcome.exitCheck={state:'ready',message:'程序已确认旧执行结束。可以解除占用；这不代表原任务已完成，也不会重发旧请求。',action:'release',checkedAt:now};
    }else throw Error('旧执行没有完整的退出凭据，请先保留记录，勿重复执行。');
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    outcome.exitCheck={state:'blocked',message,action:/重启 Windows|重启Windows/.test(message)?'restart-windows':'retry',checkedAt:now};
  }
  return outcome;
}
