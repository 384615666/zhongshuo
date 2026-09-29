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

/** turn 活跃期进程树快照（第八轮：持续归属登记——中间代际退出后历史父子边消失，
 *  退出时刻的现存树扫描不可见孙进程；快照是历史代际归属核对的唯一锚点）。
 *  每 turn 保留最新一代（事务内 DELETE+INSERT；写入方=worker 首拍+周期重拍）。 */
export function saveProcessTreeSnapshot(
  db: RegistryDb, turnId: string, rootPid: number, rows: Array<{ pid: number; ppid: number; startedAt: number | null }>, now = Date.now(),
): void {
  const tx = (db as unknown as { transaction(fn: () => void): () => void }).transaction(() => {
    db.prepare('DELETE FROM process_tree_snapshots WHERE turn_id = ?').run(turnId);
    const insert = db.prepare(
      'INSERT INTO process_tree_snapshots (turn_id, root_pid, pid, ppid, started_at_ms, observed_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const r of rows) insert.run(turnId, rootPid, r.pid, r.ppid, r.startedAt, now);
  });
  tx();
}

export interface ProcessTreeSnapshot {
  rootPid: number;
  observedAt: number;
  rows: ProcessTableRow[];
}

export function getProcessTreeSnapshot(db: RegistryDb, turnId: string): ProcessTreeSnapshot | null {
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
  identity_source: 'os-starttime' | 'pid-only' | 'none' | 'pre-launch';
  registered_at: number;
  closed_at: number | null;
  note: string | null;
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
    startedAtMs: number | null; identitySource: 'os-starttime' | 'pid-only' | 'none' | 'pre-launch';
    note?: string; now?: number;
  },
): void {
  db.prepare(
    `INSERT OR REPLACE INTO runtime_process_registry
       (turn_id, run_id, member_id, adapter_kind, process_model, pid, started_at_ms, identity_source, registered_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.turnId, input.runId, input.memberId, input.adapterKind, input.processModel,
    input.pid, input.startedAtMs, input.identitySource, input.now ?? Date.now(), input.note ?? null,
  );
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

/**
 * 服务端退出取证：查 turn 已登记身份 → OS 核对 → 写证据记录。
 * 不接受调用方自报结果；每一步无法确认都如实降级（不推断）。
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
    // 全树归属分析（第八轮）：登记根 PID 退出**不证明**执行载体全部结束。退出事实
    // =现存树 BFS 无存活后代 **且** 快照历史代际核对无遗留（中间代际已退出时其历史
    // 父子边随进程消失——现存图不连通，靠活跃期快照锚定孙进程归属）。
    // 无快照=中间代际遗留不可排除=unknown（未完整确认，保护保留）。
    const snapshot = getProcessTreeSnapshot(db, turnId);
    const historical = new Map<number, { pid: number; startedAt: number | null }>();
    if (snapshot != null) for (const row of snapshot.rows) historical.set(row.pid, row);
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
          ? `登记进程已退出，但活跃期快照的历史归属核对发现存活后代（PID ${pids}——中间代际已退出、现存父子图不连通）：执行载体未全部结束，保护保留`
          : `登记进程已退出，但其子/派生进程仍在运行（PID ${pids}）——父退出不证明执行结束，保护保留`,
      });
    }
    if (scan.state === 'unsupported' || scan.state === 'failed') {
      return write({
        turnId, registryId: reg.id, processModel: reg.process_model, pid: reg.pid, observedAt: now,
        result: 'unknown', startedAtMs: null, reuseCheck: null,
        detail: `登记进程已退出（OS 确认），但进程树${scan.state === 'unsupported' ? '枚举平台不支持' : `枚举查询失败（${scan.error.slice(0, 80)}）`}——未完整确认执行结束，保护保留`,
      });
    }
    if (snapshot == null) {
      return write({
        turnId, registryId: reg.id, processModel: reg.process_model, pid: reg.pid, observedAt: now,
        result: 'unknown', startedAtMs: null, reuseCheck: null,
        detail: '登记 PID 已退出且现存树无存活后代，但该 turn 无活跃期进程树快照——中间代际已退出的遗留（孙进程）不可排除：未完整确认，保护保留',
      });
    }
    return write({
      turnId, registryId: reg.id, processModel: reg.process_model, pid: reg.pid, observedAt: now,
      result: 'exited', startedAtMs: null, reuseCheck: null,
      detail: reg.process_model === 'per-turn'
        ? `登记 PID 已退出；全树归属核对无存活后代（含活跃期快照 ${snapshot.rows.length} 个历史身份）——该 turn 专属进程树已完整退出`
        : `登记 PID 已退出；全树归属核对无存活后代（含活跃期快照 ${snapshot.rows.length} 个历史身份）——共享进程树已完整退出（证据按 shared 标注）`,
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
