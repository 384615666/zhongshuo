/**
 * 进程身份登记与退出取证（DEV-13 第七轮：OS 退出证据由正式服务端生成和绑定）。
 *
 * 登记（worker 在 startTurn 成功后）：adapter 如实上报进程模型——
 * - per-turn：每 turn 独立子进程（Claude CLI），PID 专属该 turn；
 * - shared：常驻进程（Codex App Server），PID 由多 turn 共享，不专属单一 turn；
 * - none：无子进程（fake/内联）——无 OS 遗留进程可能，退出事实可由程序事实+无在途消费者判定。
 * 登记时尽力取 OS 启动时刻（复用检测锚点；不可得则 pid-only，对账时复用不可检测=保守）。
 *
 * 取证（probe，只读不改状态）：按 turn 的**已登记身份**做 OS 核对并落服务端证据记录
 * （recovery_exit_probes）。错误 PID、其他 turn 的证据、PID 复用、缺失历史身份都不能
 * 冒充确认退出——各按 exited/alive/unknown/no-os-process/identity-missing 如实返回。
 */
import { randomUUID } from 'node:crypto';
import { analyzeProcessTree, sameProcessIdentity, type LivenessResult, type ProcessTableRow, type TreeScan } from './processCheck.ts';

/** 最小 DB 面（测试可注入；避免与 ZhongshuoDatabase 具体类型耦合）。 */
export interface RegistryDb {
  prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown };
}

export interface ProcessTreeIdentityRow {
  id: number;
  turn_id: string;
  pid: number;
  started_at_ms: number | null;
  first_seen_at: number;
  last_seen_alive_at: number;
  exit_confirmed_at: number | null;
  is_root: number;
}

/**
 * 进程树观察记录（第九轮：**追加式历史身份登记**——按进程代次=pid+started_at_ms）。
 *
 * 旧 saveProcessTreeSnapshot（012 表 DELETE+INSERT 保留最新一代）的缺陷：后续快照从登记
 * 根 BFS，根退出后只写占位——**父链已断但仍存活的后代从后续快照中消失**；新快照覆盖掉
 * 尚未确认退出的身份。新语义：
 * - 每个观察到的进程代次只 upsert（更新 last_seen_alive_at），**从不删除**；
 * - 已确认退出（exit_confirmed_at）后同代次再次出现=防御性重开追踪（不该发生：同
 *   pid+startedAt 即同进程；出现即先前确认有误）；
 * - PID 脱离启动时间不构成身份：started_at_ms NULL 仍登记，但 probe 核对时无法与复用
 *   区分——保守按不可确认处理。
 * 退出确认（exit_confirmed_at）由 probeTurnExit 核对后写回。
 */
export function recordProcessTreeObservation(
  db: RegistryDb, turnId: string, rootPid: number, rows: Array<{ pid: number; ppid: number; startedAt: number | null }>, now = Date.now(),
): void {
  const tx = (db as unknown as { transaction(fn: () => void): () => void }).transaction(() => {
    const select = db.prepare(
      'SELECT id, exit_confirmed_at FROM process_tree_identities WHERE turn_id = ? AND pid = ? AND started_at_ms IS ?',
    );
    const insert = db.prepare(
      'INSERT INTO process_tree_identities (turn_id, pid, started_at_ms, first_seen_at, last_seen_alive_at, exit_confirmed_at, is_root) VALUES (?, ?, ?, ?, ?, NULL, ?)',
    );
    const touch = db.prepare('UPDATE process_tree_identities SET last_seen_alive_at = ? WHERE id = ?');
    const reopen = db.prepare('UPDATE process_tree_identities SET exit_confirmed_at = NULL, last_seen_alive_at = ? WHERE id = ?');
    const observed = new Map<string, { pid: number; startedAt: number | null }>();
    observed.set(`${rootPid}`, { pid: rootPid, startedAt: rows.find((r) => r.pid === rootPid)?.startedAt ?? null });
    for (const r of rows) observed.set(`${r.pid}`, { pid: r.pid, startedAt: r.startedAt });
    for (const [key, o] of observed) {
      void key;
      const existing = select.get(turnId, o.pid, o.startedAt) as { id: number; exit_confirmed_at: number | null } | undefined;
      if (existing == null) {
        insert.run(turnId, o.pid, o.startedAt, now, now, o.pid === rootPid ? 1 : 0);
      } else if (existing.exit_confirmed_at != null) {
        reopen.run(now, existing.id); // 防御：先前确认有误，重开追踪
      } else {
        touch.run(now, existing.id);
      }
    }
  });
  tx();
}

export function getProcessTreeIdentities(db: RegistryDb, turnId: string): ProcessTreeIdentityRow[] {
  return db.prepare('SELECT * FROM process_tree_identities WHERE turn_id = ? ORDER BY id').all(turnId) as ProcessTreeIdentityRow[];
}

/** 兼容导出（第八轮快照表读取——已停写，probe 历史核对改走 identities 表）。 */
export function getProcessTreeSnapshot(db: RegistryDb, turnId: string): { rootPid: number; observedAt: number; rows: ProcessTableRow[] } | null {
  const rows = db.prepare(
    'SELECT root_pid, pid, ppid, started_at_ms, observed_at FROM process_tree_snapshots WHERE turn_id = ? ORDER BY pid',
  ).all(turnId) as Array<{ root_pid: number; pid: number; ppid: number; started_at_ms: number | null; observed_at: number }>;
  if (rows.length === 0) return null;
  return {
    rootPid: rows[0]!.root_pid,
    observedAt: rows[0]!.observed_at,
    rows: rows.map((r) => ({ pid: r.pid, ppid: r.ppid, startedAt: r.started_at_ms })),
  };
}

export interface ProcessRegistryRow {
  id: number;
  turn_id: string;
  run_id: string;
  member_id: string;
  adapter_kind: string;
  process_model: 'per-turn' | 'shared' | 'none' | 'unknown';
  pid: number | null;
  started_at_ms: number | null;
  identity_source: 'os-starttime' | 'pid-only' | 'none' | 'pre-launch' | 'managed-job';
  registered_at: number;
  closed_at: number | null;
  note: string | null;
  /** 受管稳定身份（第十四轮二：jobId 正式列——PID 可复用不构成唯一身份；NULL=非受管/登记不完整）。 */
  managed_job_id: string | null;
}

export interface ProbeOutcome {
  probeId: string;
  turnId: string;
  registryId: number | null;
  processModel: 'per-turn' | 'shared' | 'none' | 'unknown' | null;
  pid: number | null;
  observedAt: number;
  result: 'exited' | 'alive' | 'unknown' | 'no-os-process' | 'identity-missing';
  startedAtMs: number | null;
  reuseCheck: 'same' | 'different' | 'unknown' | null;
  detail: string;
}

/** turn 启动身份登记（INSERT OR REPLACE：崩溃重领同 turn 重登记以最新身份为准）。 */
export function registerTurnProcess(
  db: RegistryDb, input: {
    turnId: string; runId: string; memberId: string; adapterKind: string;
    processModel: 'per-turn' | 'shared' | 'none' | 'unknown'; pid: number | null;
    startedAtMs: number | null; identitySource: 'os-starttime' | 'pid-only' | 'none' | 'pre-launch' | 'managed-job';
    managedJobId?: string | null; note?: string; now?: number;
  },
): void {
  db.prepare(
    `INSERT OR REPLACE INTO runtime_process_registry
       (turn_id, run_id, member_id, adapter_kind, process_model, pid, started_at_ms, identity_source, managed_job_id, registered_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.turnId, input.runId, input.memberId, input.adapterKind, input.processModel,
    input.pid, input.startedAtMs, input.identitySource, input.managedJobId ?? null,
    input.now ?? Date.now(), input.note ?? null,
  );
}

/** 同一受管 job 仍开放的登记（共享 job 收尾闸门：其他 turn 仍需证据/句柄时不 dispose）。 */
export function openManagedJobRegistrations(
  db: RegistryDb, jobId: string, excludeTurnId?: string,
): ProcessRegistryRow[] {
  return db.prepare(
    `SELECT * FROM runtime_process_registry WHERE managed_job_id = ? AND closed_at IS NULL AND turn_id != ?`,
  ).all(jobId, excludeTurnId ?? '') as ProcessRegistryRow[];
}

/** 正常终态收口（closed_at——区分崩溃遗留登记与已收口登记）。 */
export function closeTurnProcessRegistration(db: RegistryDb, turnId: string, now = Date.now()): void {
  db.prepare(`UPDATE runtime_process_registry SET closed_at = ? WHERE turn_id = ?`).run(now, turnId);
}

export function getTurnProcessRegistration(db: RegistryDb, turnId: string): ProcessRegistryRow | null {
  return (db.prepare(`SELECT * FROM runtime_process_registry WHERE turn_id = ?`).get(turnId) as ProcessRegistryRow | undefined) ?? null;
}

export function getProbe(db: RegistryDb, probeId: string): (ProbeOutcome & { createdBy: string }) | null {
  interface ProbeRow {
    id: string; turn_id: string; registry_id: number | null; process_model: ProbeOutcome['processModel'];
    pid: number | null; observed_at: number; result: ProbeOutcome['result'];
    started_at_ms: number | null; reuse_check: ProbeOutcome['reuseCheck']; detail: string | null; created_by: string;
  }
  const row = db.prepare(`SELECT * FROM recovery_exit_probes WHERE id = ?`).get(probeId) as ProbeRow | undefined;
  if (row == null) return null;
  return {
    probeId: row.id, turnId: row.turn_id, registryId: row.registry_id, processModel: row.process_model,
    pid: row.pid, observedAt: row.observed_at, result: row.result, startedAtMs: row.started_at_ms,
    reuseCheck: row.reuse_check, detail: row.detail ?? '', createdBy: row.created_by,
  };
}

export type QueryFn = (pid: number) => LivenessResult;

/** 受管 job 现场观察（第十四轮二：注入自受管桥——jobId 查找+PID 辅助核对）。 */
export interface ManagedJobObservation {
  /** 本进程是否持有该 job（false=无句柄：daemon 重启或已收尾）。 */
  held: boolean;
  /** job 根进程当前 PID（与登记 pid 核对——复用/错位即证据不属本 turn）。 */
  pid: number | null;
  rootExited: boolean;
  activeCount: number | null;
}

/**
 * 服务端退出取证：查 turn 已登记身份 → OS 核对 → 写证据记录。
 * 不接受调用方自报结果；每一步无法确认都如实降级（不推断）。
 *
 * 受管登记（identity_source='managed-job'，第十四轮二）：核对以登记的 managed_job_id 为准
 * （稳定身份），PID 仅辅助——无句柄/PID 不一致/其他 job 的现场都不冒充本 turn 的退出证据。
 *
 * 第八轮：exited（登记 PID 不存在）不再是完整退出证据——**父进程退出不证明其工具/
 * 派生子进程已结束**。退出事实=现存树 BFS 无存活后代 **且**（有活跃期快照时）快照
 * 历史代际核对无遗留；无快照=中间代际遗留不可排除=unknown（未完整确认，保护保留）。
 */
export function probeTurnExit(
  db: RegistryDb, turnId: string, queryFn: QueryFn,
  options: {
    createdBy: 'probe' | 'reconcile'; now?: number;
    /** 树归属分析注入（测试故障模拟）；缺省=真实 analyzeProcessTree。 */
    treeScan?: (rootPid: number, historical: Array<{ pid: number; startedAt: number | null }>) => TreeScan;
    /** 受管 job 现场注入（生产=受管桥；未注入=按 OS 路径核对——历史单测行为）。 */
    managedJob?: (jobId: string | null) => ManagedJobObservation | null;
  },
): ProbeOutcome {
  const now = options.now ?? Date.now();
  const write = (o: Omit<ProbeOutcome, 'probeId'>): ProbeOutcome => {
    const probeId = `probe_${randomUUID()}`;
    db.prepare(
      `INSERT INTO recovery_exit_probes
         (id, turn_id, registry_id, process_model, pid, observed_at, result, started_at_ms, reuse_check, detail, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      probeId, o.turnId, o.registryId, o.processModel ?? 'none', o.pid, o.observedAt,
      o.result, o.startedAtMs, o.reuseCheck, o.detail, options.createdBy,
    );
    return { ...o, probeId };
  };
  const reg = getTurnProcessRegistration(db, turnId);
  if (reg == null) {
    return write({
      turnId, registryId: null, processModel: null, pid: null, observedAt: now,
      result: 'identity-missing', startedAtMs: null, reuseCheck: null,
      detail: '该 turn 无进程身份登记（崩溃发生在登记前或 adapter 未上报）——退出事实无从核对',
    });
  }
  // 受管登记（第十四轮二）：以 managed_job_id 查找并核对——PID 仅辅助。无注入（历史单测）
  // 时按 OS 路径核对。观察只产生 alive/unknown（释放依据独属 releaseProtection 的完整证据链）。
  if (reg.identity_source === 'managed-job' && options.managedJob != null) {
    const obs = options.managedJob(reg.managed_job_id);
    if (obs == null || !obs.held) {
      return write({
        turnId, registryId: reg.id, processModel: reg.process_model, pid: reg.pid, observedAt: now,
        result: 'unknown', startedAtMs: reg.started_at_ms, reuseCheck: null,
        detail: '受管执行但本进程未持有其 job 句柄（daemon 重启或已收尾）——「曾纳管」不构成退出证据，人工核对',
      });
    }
    if (obs.pid != null && reg.pid != null && obs.pid !== reg.pid) {
      return write({
        turnId, registryId: reg.id, processModel: reg.process_model, pid: reg.pid, observedAt: now,
        result: 'unknown', startedAtMs: reg.started_at_ms, reuseCheck: 'different',
        detail: `登记 PID(${reg.pid}) 与 job 实际 PID(${obs.pid}) 不一致（PID 复用或登记错位）——现场证据不属本 turn`,
      });
    }
    if (!obs.rootExited || (obs.activeCount == null ? 1 : obs.activeCount) > 0) {
      return write({
        turnId, registryId: reg.id, processModel: reg.process_model, pid: reg.pid, observedAt: now,
        result: 'alive', startedAtMs: reg.started_at_ms, reuseCheck: 'same',
        detail: !obs.rootExited
          ? '受管 job 根进程仍存活'
          : `受管 job 根已退出但仍有 ${obs.activeCount} 个活跃进程（后代存活）——执行载体未全部结束`,
      });
    }
    return write({
      turnId, registryId: reg.id, processModel: reg.process_model, pid: reg.pid, observedAt: now,
      result: 'unknown', startedAtMs: reg.started_at_ms, reuseCheck: 'same',
      detail: '受管 job 根已退出且活跃计数 0（观察）——完整释放依据以 recovery.releaseProtection 的受管证据链为准，probe 不直接释放',
    });
  }
  if (reg.process_model === 'none') {
    return write({
      turnId, registryId: reg.id, processModel: 'none', pid: null, observedAt: now,
      result: 'no-os-process', startedAtMs: null, reuseCheck: null,
      detail: `${reg.adapter_kind}：无子进程模型（内联执行）——无 OS 遗留进程可能`,
    });
  }
  if (reg.pid == null) {
    return write({
      turnId, registryId: reg.id, processModel: reg.process_model, pid: null, observedAt: now,
      result: 'unknown', startedAtMs: null, reuseCheck: null,
      detail: reg.identity_source === 'pre-launch'
        ? '启动窗口身份未持久化（pre-launch 登记、请求可能已发出但 adapter 未及上报 PID）——退出事实无从核对，保护保留'
        : `${reg.process_model} 登记但无 PID——无法做 OS 核对`,
    });
  }
  const r = queryFn(reg.pid);
  if (r.state === 'unknown') {
    return write({
      turnId, registryId: reg.id, processModel: reg.process_model, pid: reg.pid, observedAt: now,
      result: 'unknown', startedAtMs: null, reuseCheck: null, detail: `OS 查询不可确认：${r.error}`,
    });
  }
  if (r.state === 'exited') {
    // 第九轮收紧：**周期快照不构成「全部受管执行已结束」的完整证明**——最后快照之后
    // 派生且父链已断的深层链不可排除，扫描为空≠完整退出。对 per-turn/shared 一律不返回
    // exited（该结果自本轮起不再产生；枚举值保留仅为兼容历史行）；观察事实进 detail。
    // 核对分两层（都只产生观察，不产生释放依据）：
    // ① 历史身份全集（014 追加式登记）：未确认身份逐代次核对存活/复用——发现存活=明确
    //    执行载体遗留；已退出=写回确认（不丢身份）；
    // ② 现存树扫描（BFS/历史挂靠）：抓快照间隔内派生且父链现存的进程（观察增强）。
    const identities = getProcessTreeIdentities(db, turnId);
    const confirm = db.prepare('UPDATE process_tree_identities SET exit_confirmed_at = ? WHERE id = ? AND exit_confirmed_at IS NULL');
    const unconfirmed = identities.filter((row) => row.exit_confirmed_at == null);
    let queryFailed: string | null = null;
    for (const idRow of unconfirmed) {
      if (idRow.pid === reg.pid && reg.started_at_ms != null && idRow.started_at_ms == null) continue; // 根身份以登记值为准（同 pid 行）
      const li = queryFn(idRow.pid);
      if (li.state === 'exited') {
        confirm.run(now, idRow.id); // 该代次已退出：确认并保留（不删——后续仍可查证）
        continue;
      }
      if (li.state === 'unknown') {
        queryFailed = `PID ${idRow.pid} 查询不可确认（${li.error.slice(0, 60)}）`;
        continue;
      }
      // alive：与登记代次做复用核对——同代次存活=执行载体仍在。
      const reuse = sameProcessIdentity({ pid: idRow.pid, startedAt: idRow.started_at_ms }, li.identity);
      if (reuse === 'same') {
        return write({
          turnId, registryId: reg.id, processModel: reg.process_model, pid: reg.pid, observedAt: now,
          result: 'unknown', startedAtMs: null, reuseCheck: null,
          detail: `登记根进程已退出，但历史身份核对发现仍在运行的执行载体（PID ${idRow.pid}${idRow.is_root === 1 ? '（登记根代次）' : ''}）——保护保留`,
        });
      }
      if (reuse === 'unknown') {
        return write({
          turnId, registryId: reg.id, processModel: reg.process_model, pid: reg.pid, observedAt: now,
          result: 'unknown', startedAtMs: null, reuseCheck: null,
          detail: `历史身份 PID ${idRow.pid} 现仍存活但登记代次缺启动时间（无法与复用区分）——保守按执行载体可能仍在处理，保护保留`,
        });
      }
      confirm.run(now, idRow.id); // different：该代次已退出（现存者为复用进程，不属本 turn）
    }
    const historical = new Map<number, { pid: number; startedAt: number | null }>();
    for (const row of identities) historical.set(row.pid, { pid: row.pid, startedAt: row.started_at_ms });
    historical.set(reg.pid, { pid: reg.pid, startedAt: reg.started_at_ms });
    const scan = (options.treeScan ?? ((rootPid: number, hist: Array<{ pid: number; startedAt: number | null }>) => analyzeProcessTree(rootPid, hist)))(
      reg.pid,
      [...historical.values()],
    );
    if (scan.state === 'live') {
      const pids = scan.survivors.slice(0, 8).map((s) => s.pid).join(', ');
      return write({
        turnId, registryId: reg.id, processModel: reg.process_model, pid: reg.pid, observedAt: now,
        result: 'unknown', startedAtMs: null, reuseCheck: null,
        detail: scan.via === 'historical-attachment'
          ? `登记根已退出，但历史归属核对发现存活后代（PID ${pids}——中间代际已退出、现存父子图不连通）：执行载体未全部结束，保护保留`
          : `登记根已退出，但其子/派生进程仍在运行（PID ${pids}）——父退出不证明执行结束，保护保留`,
      });
    }
    if (scan.state === 'unsupported' || scan.state === 'failed') {
      return write({
        turnId, registryId: reg.id, processModel: reg.process_model, pid: reg.pid, observedAt: now,
        result: 'unknown', startedAtMs: null, reuseCheck: null,
        detail: `登记根已退出（OS 确认），但进程树${scan.state === 'unsupported' ? '枚举平台不支持' : `枚举查询失败（${scan.error.slice(0, 80)}）`}——未完整确认执行结束，保护保留`,
      });
    }
    // 全部历史身份已确认退出+现存树无存活——**仍只是「未观察到存活后代」**：周期快照
    // 机制无法排除最后快照之后派生且父链已断的执行载体。关闭该自动释放路径（用户令
    // 第九轮一）；无子进程模型的程序事实（no-os-process）不受影响。
    return write({
      turnId, registryId: reg.id, processModel: reg.process_model, pid: reg.pid, observedAt: now,
      result: 'unknown', startedAtMs: null, reuseCheck: null,
      detail: `未观察到存活后代（登记根与 ${identities.length} 个历史身份均已确认退出、现存树为空）——但周期快照机制无法证明「最后快照之后无派生且父链已断」的执行载体不存在：未完整确认，保护保留（该 runtime 的服务端解除路径已关闭；无子进程模型的程序事实不受影响）${queryFailed != null ? `；另有 ${queryFailed}` : ''}`,
    });
  }
  // alive：与登记时历史身份做复用检测——different=PID 已被复用（不是原进程，不能当「仍存活」）。
  const historical = { pid: reg.pid, startedAt: reg.started_at_ms };
  const reuse = sameProcessIdentity(historical, r.identity);
  const detail = reuse === 'different'
    ? 'PID 已被复用（启动时间与登记不符）——不是原进程，退出事实不可据此判定'
    : reuse === 'unknown'
      ? '进程存活但复用检测不可用（历史/当前启动时间缺失）——保留保护'
      : reg.process_model === 'per-turn'
        ? '该 turn 专属进程仍存活'
        : '共享常驻进程仍存活（该 turn 执行状态未知）';
  return write({
    turnId, registryId: reg.id, processModel: reg.process_model, pid: reg.pid, observedAt: now,
    result: reuse === 'different' ? 'unknown' : 'alive',
    startedAtMs: r.identity.startedAt, reuseCheck: reuse, detail,
  });
}
