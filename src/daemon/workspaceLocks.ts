/**
 * 写入租约（§10.3/§12.2 workspace_leases/RT-07/RT-08/RT-09）。
 * - 锁域=identityKey；重叠判定（父子/junction）在 acquire 时逐租约检查。
 * - single_writer：同一锁域同时最多 1 个活跃租约，其他任务排队并可见持有者。
 * - session_scope：同项目同根目录、不同串的已登记完整权限执行可共存。
 * - RT-07：租约过期不给新写者放行，直到旧持有者被确认终止。
 */
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { domainErr, domainOk } from '../contracts/errors.ts';
import type { DomainResult } from '../contracts/errors.ts';
import { comparisonKey, lockDomainsOverlap } from './directoryIdentity.ts';
import { effectiveTaskWriteAccess } from './projectWriteAccess.ts';
import { resolveWriteConcurrency } from './writeConcurrency.ts';
import { coordinationRoster } from './coordination.ts';
import type { EffectiveWriteConcurrency } from '../contracts/writeConcurrency.ts';

export interface LeaseRow {
  lock_domain: string;
  owner_turn_id: string;
  epoch: number;
  heartbeat_at: number;
  status: 'active' | 'released' | 'expired';
}

export interface AcquireLeaseInput {
  lockDomain: string;
  ownerTurnId: string;
  policy: 'single_writer' | 'parallel_writers' | 'session_scope';
  now: number;
}

export interface LeaseHolderInfo {
  ownerTurnId: string;
  lockDomain: string;
  status: string;
  heartbeatAt: number;
}

export interface AcquireLeaseOk {
  granted: true;
  epoch: number;
}

/**
 * 申请写入租约。
 * - 冲突时返回 WORKSPACE_BUSY 并列出全部重叠持有者（排队可见）。
 * - RT-07：`active` 与 `expired`（心跳超时但持有者未确认终止）都阻塞新写者；
 *   只有 `released`（正常释放或确认终止）才放行。
 * - 共享写入逐持有者核对本次执行的完整权限、实际策略及保护状态。
 */
export function acquireLease(
  db: ZhongshuoDatabase,
  input: AcquireLeaseInput,
): DomainResult<AcquireLeaseOk> {
  return db.transaction(()=>acquireLeaseInTransaction(db,input))();
}

function acquireLeaseInTransaction(db:ZhongshuoDatabase,input:AcquireLeaseInput):DomainResult<AcquireLeaseOk> {
  if (!['single_writer', 'session_scope', 'parallel_writers'].includes(input.policy)) {
    return domainErr(
      'CAPABILITY_UNSUPPORTED',
      '文件修改并发策略无法识别',
    );
  }
  // 未确认释放的租约（active 或 expired）都是潜在持有者。
  const rows = db
    .prepare("SELECT * FROM workspace_leases WHERE status != 'released'")
    .all() as LeaseRow[];
  const overlapping = rows.filter((row) => lockDomainsOverlap(row.lock_domain, input.lockDomain));
  const scope=writeSessionScope(db,input.ownerTurnId);
  const fact=input.policy==='single_writer'?null:incomingWriteFact(db,input,scope);
  // Protected executions block new writers even if a legacy record lacks a lease.
  const protectedRoots=db.prepare(`SELECT p.canonical_path FROM agent_turns t
    JOIN workflow_runs r ON r.id=t.run_id JOIN tasks tk ON tk.id=r.task_id
    JOIN projects p ON p.id=tk.project_id
    WHERE (t.status='UNKNOWN' AND t.protection_state IS NOT 'released') OR t.protection_state='retained'`).all() as Array<{canonical_path:string}>;
  if(protectedRoots.some(p=>lockDomainsOverlap(p.canonical_path,input.lockDomain)))return domainErr('WORKSPACE_BUSY','此目录有未确认结束的执行，解除保护前不启动新的写入');
  if(input.policy!=='single_writer' && !fact)return domainErr('WORKSPACE_BUSY','共享写入的完整权限、项目目录或并发策略无法核实');
  if (overlapping.some(row=>!fact||row.status!=='active'||row.lock_domain!==input.lockDomain||!canShareWriteLease(db,row.owner_turn_id,fact))) {
    return busy(overlapping);
  }

  const prev = db
    .prepare('SELECT * FROM workspace_leases WHERE lock_domain = ? AND owner_turn_id = ?')
    .get(input.lockDomain, input.ownerTurnId) as LeaseRow | undefined;
  const epoch = (prev?.epoch ?? 0) + 1;
  db.prepare(
    `INSERT INTO workspace_leases (lock_domain, owner_turn_id, epoch, heartbeat_at, status)
     VALUES (?, ?, ?, ?, 'active')
     ON CONFLICT (lock_domain, owner_turn_id) DO UPDATE SET
       epoch = excluded.epoch, heartbeat_at = excluded.heartbeat_at, status = 'active'`,
  ).run(input.lockDomain, input.ownerTurnId, epoch, input.now);
  db.prepare('INSERT OR REPLACE INTO daemon_state(key,value,updated_at) VALUES(?,?,?)').run(`write-lease-fact:${input.ownerTurnId}`,JSON.stringify(fact??{policy:'single_writer',lockDomain:input.lockDomain}),input.now);
  if(fact){
    db.prepare('INSERT OR REPLACE INTO daemon_state(key,value,updated_at) VALUES(?,?,?)').run(`write-session-scope:${input.ownerTurnId}`,scope,input.now);
    // Keep durable evidence on both sides. A directory snapshot spanning another
    // writer cannot establish exclusive authorship, even when the bytes match.
    for(const row of overlapping){
      for(const id of [row.owner_turn_id,input.ownerTurnId]){
        db.prepare('INSERT OR REPLACE INTO daemon_state(key,value,updated_at) VALUES(?,?,?)').run(`write-overlap:${id}`,'true',input.now);
        const snapshot=db.prepare('SELECT value FROM daemon_state WHERE key=?').get(`write-changeset:${id}`) as {value:string}|undefined;
        if(snapshot)protectSharedWriteSnapshot(db,snapshot.value);
      }
    }
  }
  return domainOk({ granted: true, epoch });
}

/** Thread identity deliberately excludes member: two members in one thread
 * still serialize writes, while the member admission remains separately scoped. */
export function writeSessionScope(db:ZhongshuoDatabase,turnId:string):string|null {
  const row=db.prepare(`SELECT tk.project_id,t.conversation_id,t.thread_id,t.status,t.protection_state
    FROM agent_turns t JOIN workflow_runs r ON r.id=t.run_id JOIN tasks tk ON tk.id=r.task_id WHERE t.id=?`).get(turnId) as {project_id:string;conversation_id:string;thread_id:string|null;status:string;protection_state:string|null}|undefined;
  if(!row||!row.thread_id||!['RUNNING','DISPATCHING','WAITING_APPROVAL','WAITING_INPUT'].includes(row.status)||row.protection_state==='retained')return null;
  return JSON.stringify([row.project_id,row.conversation_id,row.thread_id]);
}

interface SharedWriteFact {
  policy: 'session_scope' | 'parallel_writers';
  fullAccess: true;
  projectId: string;
  memberId: string;
  scope: string;
  lockDomain: string;
}

function incomingWriteFact(db: ZhongshuoDatabase, input: AcquireLeaseInput, scope: string | null): SharedWriteFact | null {
  if (!scope) return null;
  const row=db.prepare(`SELECT tk.id taskId,tk.project_id projectId,tk.kind,tk.write_scope_json,t.member_id memberId,t.run_id runId,t.turn_purpose purpose,t.stage_key stageKey
    FROM agent_turns t JOIN workflow_runs r ON r.id=t.run_id JOIN tasks tk ON tk.id=r.task_id WHERE t.id=?`).get(input.ownerTurnId) as {taskId:string;projectId:string;kind:string;write_scope_json:string;memberId:string;runId:string;purpose:string;stageKey:string}|undefined;
  if (!row || row.kind==='dm_turn' || row.purpose==='format_repair') return null;
  try {
    const execution=db.prepare('SELECT value FROM daemon_state WHERE key=?').get(`execution-context:${input.ownerTurnId}`) as {value:string}|undefined;
    const rosterScope=row.stageKey.startsWith('delib.')?coordinationRoster(db,row.taskId,row.runId).find(m=>m.memberId===row.memberId)?.writeScope:null;
    const snapshot=execution?(JSON.parse(execution.value) as {writeScope:string}).writeScope:rosterScope??row.write_scope_json;
    const frozen=JSON.parse(snapshot) as {runtime?:{kind?:string}};
    const access=effectiveTaskWriteAccess(db,row.taskId,row.memberId,frozen.runtime?.kind??null,snapshot);
    const resolved=resolveWriteConcurrency(db,{projectId:row.projectId,fullAccess:access.fullAccess,eligible:true,sessionScopeKey:scope});
    if (!access.fullAccess || !access.modificationAuthorized || comparisonKey(access.root)!==input.lockDomain || resolved.writePolicy!==input.policy || input.policy==='single_writer') return null;
    return {policy:input.policy,fullAccess:true,projectId:row.projectId,memberId:row.memberId,scope,lockDomain:input.lockDomain};
  } catch { return null; }
}

function storedWriteFact(db:ZhongshuoDatabase,turnId:string,lockDomain:string):SharedWriteFact|null {
  const saved=db.prepare('SELECT value FROM daemon_state WHERE key=?').get(`write-lease-fact:${turnId}`) as {value:string}|undefined;
  if (!saved) return null;
  try {
    const fact=JSON.parse(saved.value) as SharedWriteFact;
    const actual=writeSessionScope(db,turnId);
    const turn=db.prepare(`SELECT t.member_id,tk.project_id,p.canonical_path FROM agent_turns t
      JOIN workflow_runs r ON r.id=t.run_id JOIN tasks tk ON tk.id=r.task_id JOIN projects p ON p.id=tk.project_id WHERE t.id=?`).get(turnId) as {member_id:string;project_id:string;canonical_path:string}|undefined;
    if (!turn || !actual || fact.scope!==actual || fact.fullAccess!==true || fact.memberId!==turn.member_id || fact.projectId!==turn.project_id || fact.lockDomain!==lockDomain || comparisonKey(turn.canonical_path)!==lockDomain || !['session_scope','parallel_writers'].includes(fact.policy)) return null;
    return fact;
  } catch { return null; }
}

function canShareWriteLease(db:ZhongshuoDatabase,turnId:string,incoming:SharedWriteFact):boolean {
  const held=storedWriteFact(db,turnId,incoming.lockDomain);
  return held!=null && held.projectId===incoming.projectId && held.policy===incoming.policy
    && (incoming.policy==='parallel_writers'?held.memberId!==incoming.memberId:held.scope!==incoming.scope);
}

/** Restore the policy actually acquired, never today's project setting. Unknown,
 * retained, expired and legacy leases always restore exclusive protection. */
export function recordedWriteConcurrency(db:ZhongshuoDatabase,turnId:string,lockDomain:string):{writePolicy:EffectiveWriteConcurrency;writeSessionScopeKey?:string;writeFullAccess?:true} {
  const lease=db.prepare("SELECT status FROM workspace_leases WHERE owner_turn_id=? AND lock_domain=? AND status!='released'").get(turnId,lockDomain) as {status:string}|undefined;
  const fact=lease?.status==='active'?storedWriteFact(db,turnId,lockDomain):null;
  return fact?{writePolicy:fact.policy,writeSessionScopeKey:fact.scope,writeFullAccess:true}:{writePolicy:'single_writer'};
}

/** Preserve the original bytes/hash, but prohibit automatic rollback of a
 * directory difference whose author cannot be proven during overlapping turns. */
export function protectSharedWriteSnapshot(db:ZhongshuoDatabase,changeSetId:string):void {
  const shared=db.prepare(`SELECT 1 FROM daemon_state c JOIN daemon_state o
    ON o.key='write-overlap:'||substr(c.key,length('write-changeset:')+1)
    WHERE c.key LIKE 'write-changeset:%' AND c.value=? LIMIT 1`).get(changeSetId);
  if(!shared)return;
  db.prepare(`UPDATE change_sets SET manifest_json=json_set(manifest_json,'$.concurrentWriteObservation',json('true')) WHERE id=?`).run(changeSetId);
}

function busy(holders: LeaseRow[]): DomainResult<never> {
  return domainErr('WORKSPACE_BUSY', '其他任务正在修改此目录，本任务正在等待', {
    details: {
      holders: holders.map<LeaseHolderInfo>((h) => ({
        ownerTurnId: h.owner_turn_id,
        lockDomain: h.lock_domain,
        status: h.status,
        heartbeatAt: h.heartbeat_at,
      })),
    },
  });
}

export function heartbeatLease(
  db: ZhongshuoDatabase,
  input: { lockDomain: string; ownerTurnId: string; now: number },
): void {
  db.prepare(
    `UPDATE workspace_leases SET heartbeat_at = ? WHERE lock_domain = ? AND owner_turn_id = ? AND status = 'active'`,
  ).run(input.now, input.lockDomain, input.ownerTurnId);
}

/** 正常释放（写入者完成/停止确认后）。 */
export function releaseLease(
  db: ZhongshuoDatabase,
  input: { lockDomain: string; ownerTurnId: string },
): void {
  db.prepare(
    `UPDATE workspace_leases SET status = 'released' WHERE lock_domain = ? AND owner_turn_id = ?`,
  ).run(input.lockDomain, input.ownerTurnId);
}

/** 旧租约心跳超时：标记 expired（仍阻塞新写者，直到确认终止，RT-07）。 */
export function markExpiredLeases(db: ZhongshuoDatabase, now: number, heartbeatTimeoutMs: number): void {
  db.prepare(
    `UPDATE workspace_leases SET status = 'expired'
     WHERE status = 'active' AND heartbeat_at < ?`,
  ).run(now - heartbeatTimeoutMs);
}

/** 确认旧持有者已终止（进程树核实由 DEV-05 supervisor 承担）：解除 RT-07 阻塞。 */
export function confirmLeaseTerminated(
  db: ZhongshuoDatabase,
  input: { lockDomain: string; ownerTurnId: string },
): void {
  db.prepare(
    `UPDATE workspace_leases SET status = 'released' WHERE lock_domain = ? AND owner_turn_id = ?`,
  ).run(input.lockDomain, input.ownerTurnId);
}

export function listActiveLeases(db: ZhongshuoDatabase): LeaseRow[] {
  return db.prepare("SELECT * FROM workspace_leases WHERE status != 'released'").all() as LeaseRow[];
}
