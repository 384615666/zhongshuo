/**
 * daemon 组装入口（DEV-07；修复轮 5：凭据握手 + 生命周期）。
 *
 * 生命周期：
 * - drain 单飞保护（计时器不得在上一轮 drain 未完成时重入——串行调度，并发须走
 *   正式预算/成员限制，不由计时器重入决定）。
 * - stop 顺序：停 tick（拒新派发）→ 停 IPC（拒新命令）→ 收拢 runtime（等待子进程
 *   退出）→ 关库 → 释放锁；重复 stop 幂等。
 * - 启动中失败：部分资源先释放再抛出（不留半启动实例）。
 * - 恢复：applyRecovery 重排孤儿租约（旧 daemon 已死≠其 runtime 子进程已死；
 *   幂等键保证重试不重复执行——不确定执行窗口由 reconcile 审计承载，DEV-13 完整收口）。
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeFileSync, rmSync } from 'node:fs';
import { openDatabase } from '../persistence/db.ts';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { acquireSingletonLock } from './singletonLock.ts';
import { applyRecovery } from './stopFlow.ts';
import { startNamedPipeIpc } from './namedPipeIpc.ts';
import type { NamedPipeIpcHandle } from './namedPipeIpc.ts';
import { dispatchDaemonCommand } from './commands.ts';
import { DispatchWorker } from './dispatchWorker.ts';
import { MemberRuntimeRegistry, type MemberAdapterFactory, type MemberDisposeReport } from './memberRuntime.ts';
import { FakeRuntimeAdapter } from '../adapter/fake/runtimeAdapter.ts';
import { successTurn } from '../adapter/fake/script.ts';
import { simulateDeliberationTurn } from '../adapter/fake/deliberationSim.ts';
import { CodexAppServerAdapter } from '../adapter/codex/appServerAdapter.ts';
import * as managedBridgeMod from './managed/bridge.ts';
import * as claudeCliMod from '../adapter/claude/cliAdapter.ts';
import { ClaudeCliAdapter } from '../adapter/claude/cliAdapter.ts';
import type { RuntimeAdapter } from '../contracts/runtime.ts';
import type { FakeTurnScript } from '../adapter/fake/script.ts';
import { daemonPipeNameFor, ensureLocalCredential } from '../contracts/daemonIpc.ts';
import type { LocalCredential } from '../contracts/daemonIpc.ts';

export interface DaemonOptions {
  appDataDir: string;
  /** 全局默认 runtime（未绑定成员的回落值；fake 仅限显式开发/测试模式 ZS_ALLOW_FAKE=1）。 */
  runtime: 'fake' | 'codex' | 'claude';
  localUserId?: string;
  pipeName?: string;
  tickMs?: number;
  /** stop 时等待在途 drain 收敛的上限（默认 10s）。 */
  drainSettleTimeoutMs?: number;
  /** 测试注入口：覆盖默认 adapter 构建（仅测试用——生产路径不传）。 */
  testAdapter?: RuntimeAdapter;
  /**
   * 正式关闭命令入口（DEV-15 第十四轮三：daemon.shutdown 经 IPC 驱动）。注入时命令面开放
   * （standalone 进程入口）；内嵌实例（测试/UI 进程内）不注入——命令明确拒绝。
   */
  standaloneShutdown?: () => void;
}

/** 退出状态机结果：complete=全部收拢（关库+释放锁）；否则未完成，上层不得视为成功。 */
export interface DaemonStopResult {
  complete: boolean;
  phase: 'closed' | 'incomplete' | 'forced-closed';
  /** 停止请求已发的 turnId（不含退出确认——确认在 disposeReport/inFlightRemaining）。 */
  stopRequestsSentTo: string[];
  disposeReport?: MemberDisposeReport;
  inFlightRemaining?: string[];
  /** 关闭开始后仍在启动窗口的派发（晚返回的 openSession 未登记 live/消费器）。 */
  startingRemaining?: string[];
  /** stop 判定时在途 drain 仍未结束（启动/消费均可能未收敛）。 */
  drainPending?: boolean;
  /** 未完成原因摘要（恢复依据：WAL/崩溃恢复语义 + 审计 + daemon:stop:last 持久化记录）。 */
  reason?: string;
}

export interface RunningDaemon {
  pipeName: string;
  db: ZhongshuoDatabase;
  worker: DispatchWorker;
  /** 全局默认 adapter（未绑定成员回落值）。 */
  adapter: RuntimeAdapter;
  /** 成员级 runtime 注册表（DEV-10：按成员绑定选择 adapter）。 */
  memberRuntime: MemberRuntimeRegistry;
  credential: LocalCredential;
  /**
   * 退出状态机（幂等：重复调用返回同一关闭过程的结果）。
   * - 优雅路径：拒新命令/派发 → drain 安全边界 → 对在途发停止请求 → 收拢 runtime（杀+等退出）
   *   → 等消费器写库收敛 → 确认零后台写库后关库+释放锁 → {complete:true}。
   * - 超时（进程退出未确认/消费器未收敛/收拢失败）：**不关库、不释放锁**（单实例锁≠子进程
   *   退出；恢复依据=崩溃恢复语义：WAL+applyRecovery），返回 {complete:false}。
   * - 强制路径（force:true）：优雅超时后杀进程+中止消费器（UNKNOWN 收尾）再关库——
   *   {complete:false, phase:'forced-closed'}，恢复依据已持久化。
   */
  stop(options?: { force?: boolean }): Promise<DaemonStopResult>;
}

export function defaultAppDataDir(): string {
  return join(homedir(), '.zhongshuo');
}

export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  // 启动中任一步失败：先释放已获取资源再抛出。
  let lock: ReturnType<typeof acquireSingletonLock> | null = null;
  let db: ZhongshuoDatabase | null = null;
  let ipc: NamedPipeIpcHandle | null = null;
  let adapter: RuntimeAdapter | null = null;
  try {
    lock = acquireSingletonLock(join(options.appDataDir, 'locks'));
    if (!lock.ok) throw new Error(`daemon 单实例锁获取失败：${lock.error.message}`);
    const lockHandle = lock.value;

    db = openDatabase(join(options.appDataDir, 'state.sqlite'), {
      backupDir: join(options.appDataDir, 'backups'),
    });
    applyRecovery(db, Date.now()); // 孤儿租约重排 + 非终态标记 + 门禁

    adapter = options.testAdapter != null
      ? options.testAdapter
      : options.runtime === 'codex'
        ? new CodexAppServerAdapter({ model: process.env.ZS_E2E_MODEL })
        : options.runtime === 'claude'
          ? new ClaudeCliAdapter({ model: process.env.ZS_CLAUDE_MODEL })
          : new FakeRuntimeAdapter(
              // fake 专用编排入口（仅 ZS_ALLOW_FAKE=1 显式开发模式）：停延 stall 供
              // UI 端到端在「运行中」窗口内点击停止/制造中断现场（正式路径不读取）；
              // ZS_FAKE_DELIB=1 时按输入契约生成合法研讨载荷（UI 全链路演练）；
              // ZS_FAKE_TOOL_EVENTS=1 时首个 turn 发出工具事件序列（含迟到重复/进行中/
              // 失败——thread.toolCalls UI 审计断言用），后续 turn 回落默认脚本。
              process.env.ZS_FAKE_STALL_MS != null && Number(process.env.ZS_FAKE_STALL_MS) > 0
                ? { turnScripts: [[{ kind: 'stall', ms: Number(process.env.ZS_FAKE_STALL_MS) }, ...successTurn()]] }
                : process.env.ZS_FAKE_DELIB === '1'
                  ? { structuredFinal: false, turnScriptSequencer: (input) => simulateDeliberationTurn(input.text) }
                  : process.env.ZS_FAKE_TOOL_EVENTS === '1'
                    ? (() => {
                        // 仅首个 turn 发工具事件序列（含迟到重复/进行中/失败——thread.toolCalls
                        // UI 审计断言用）；后续 turn 回落默认成功脚本（切线程隔离对照）。
                        let toolTurnUsed = false;
                        return {
                          turnScriptSequencer: (): FakeTurnScript => {
                            if (toolTurnUsed) return successTurn();
                            toolTurnUsed = true;
                            return [
                              { kind: 'event', event: { kind: 'tool.started', toolCallId: 'tc_read_1', toolName: 'Read', argumentsSummary: '' } },
                              { kind: 'event', event: { kind: 'tool.completed', toolCallId: 'tc_read_1', outcome: 'success' } },
                              { kind: 'event', event: { kind: 'tool.completed', toolCallId: 'tc_read_1', outcome: 'unknown' } },
                              { kind: 'event', event: { kind: 'tool.started', toolCallId: 'tc_grep_2', toolName: 'Grep', argumentsSummary: '' } },
                              { kind: 'event', event: { kind: 'tool.started', toolCallId: 'tc_bash_3', toolName: 'Bash', argumentsSummary: '' } },
                              { kind: 'event', event: { kind: 'tool.completed', toolCallId: 'tc_bash_3', outcome: 'failure' } },
                              { kind: 'event', event: { kind: 'turn.completed', finalText: '完成' } },
                            ];
                          },
                        };
                      })()
                    : undefined,
            );

    // REC-LIFE-1（第十二轮·五）：受管运行时注入——ZS_MANAGED_RUNTIME=1 时生产 adapter 的
    // spawn 走 Job Object 受管桥（挂起创建→纳管→恢复，KILL_ON_JOB_CLOSE 兜底）；桥不可用
    // 直接抛错（daemon 启动失败），**不降级为未受管运行**。未设变量=维持既有路径与第九轮
    // 保守解除口径（按部署节奏逐项目启用）。受管句柄按 pid 注册（bridge），dispatchWorker
    // 登记 identity_source='managed-job'，releaseProtection 凭 releaseEvidence 解除。
    const managedClaudeSpawn = (() => {
      if (process.env.ZS_MANAGED_RUNTIME !== '1') return undefined;
      const { managedBridgeAvailable, spawnManagedBridge } = managedBridgeMod;
      const avail = managedBridgeAvailable();
      if (!avail.ok) {
        throw new Error(`受管运行时启用（ZS_MANAGED_RUNTIME=1）但不可用——拒绝启动，不降级为未受管执行：${avail.reason}`);
      }
      const { resolveClaudeExecutable } = claudeCliMod;
      return (executable: string | undefined) => (args: string[], cwd: string) =>
        spawnManagedBridge(resolveClaudeExecutable(executable).command, [...resolveClaudeExecutable(executable).prefixArgs, ...args], { cwd }) as never; // env 缺省=继承父环境（与未受管 spawn 的 env:process.env 等价）
    })();
    const managedCodexSpawn = (() => {
      if (process.env.ZS_MANAGED_RUNTIME !== '1') return undefined;
      const { spawnManagedBridge } = managedBridgeMod;
      return (cmd: string, args: string[]) => spawnManagedBridge(cmd, args, {}) as never; // env 缺省=继承父环境
    })();
    if (options.runtime === 'codex' && managedCodexSpawn != null) {
      adapter = new CodexAppServerAdapter({ model: process.env.ZS_E2E_MODEL, spawnFn: managedCodexSpawn });
    } else if (options.runtime === 'claude' && managedClaudeSpawn != null) {
      adapter = new ClaudeCliAdapter({ model: process.env.ZS_CLAUDE_MODEL }, managedClaudeSpawn(undefined));
    }

    // 成员级 runtime 注册表（DEV-10）：同一项目允许成员 A 绑定 codex、成员 B 绑定
    // claude（模型/权限档来自 agent_profiles.settings_json）；fake 工厂仅显式开发模式注册。
    const claudePermissionOf = (mode: string | null): 'plan' | 'manual' | 'acceptEdits' | 'auto' | 'dontAsk' | 'bypassPermissions' | undefined =>
      mode === 'plan' || mode === 'manual' || mode === 'acceptEdits' || mode === 'auto' || mode === 'dontAsk' || mode === 'bypassPermissions' ? mode : undefined;
    const factories: Record<string, MemberAdapterFactory> = {
      codex: (binding) => new CodexAppServerAdapter({
        model: binding.model ?? process.env.ZS_E2E_MODEL,
        ...(managedCodexSpawn != null ? { spawnFn: managedCodexSpawn } : {}),
      }),
      claude: (binding) => new ClaudeCliAdapter(
        {
          model: binding.model ?? process.env.ZS_CLAUDE_MODEL,
          executable: binding.executable ?? undefined,
          permissionMode: claudePermissionOf(binding.permissionMode),
          installationId: binding.installationId ?? undefined,
        },
        managedClaudeSpawn != null ? managedClaudeSpawn(binding.executable ?? undefined) : undefined,
      ),
    };
    if (process.env.ZS_ALLOW_FAKE === '1') {
      // 成员级 fake 实例与默认实例同款编排（ZS_FAKE_DELIB=1 时按输入契约生成合法研讨
      // 载荷——彩排/演练经成员绑定路径与真实链路一致，不因工厂实例缺编排而假失败）。
      factories.fake = () => new FakeRuntimeAdapter(
        process.env.ZS_FAKE_DELIB === '1'
          ? { structuredFinal: false, turnScriptSequencer: (input) => simulateDeliberationTurn(input.text) }
          : undefined,
      );
    }
    const memberRuntime = new MemberRuntimeRegistry(db, adapter, factories);
    const worker = new DispatchWorker({
      db,
      adapter,
      adapterFor: (memberId) => memberRuntime.adapterFor(memberId),
      leaseOwner: `daemon-${process.pid}`,
      // E4 调度解耦（生产承载）：turn 消费不阻塞 drain——泵可在成员在途期间推进屏障。
      // ZS_DETACHED_TURNS=0 显式关闭（排障用；既有内联语义）。
      detachedTurnConsumption: process.env.ZS_DETACHED_TURNS !== '0',
      defaultProviderKey: options.runtime, // 未绑定成员的 provider 准入键=全局 runtime 标识
      appDataDir: options.appDataDir,
      // M1 研讨编排：证据齐备后默认开放（ZS_ENABLE_DELIBERATE=0 可关）；缺席容忍默认 20 分钟。
      enableDeliberate: process.env.ZS_ENABLE_DELIBERATE === '1', // 能力状态合同：fake/UI 已验、真实研讨未完成——显式 opt-in；真实闭环验证后再默认开放
      // 单轮截止：真实 runtime 的研讨轮（含全部初稿互评正文）常超 60s——默认放宽到
      // 300s（ZS_TURN_DEADLINE_MS 可调）；60s 是 DIRECT 秒级 fixture 时代的默认。
      turnDeadlineMs: process.env.ZS_TURN_DEADLINE_MS != null ? Number(process.env.ZS_TURN_DEADLINE_MS) : 300_000,
      absenceToleranceMs: process.env.ZS_ABSENCE_MS != null ? Number(process.env.ZS_ABSENCE_MS) : undefined,
      deliberateMaxTurns: process.env.ZS_DELIB_MAX_TURNS != null ? Number(process.env.ZS_DELIB_MAX_TURNS) : undefined,
    });

    const credential = ensureLocalCredential(options.appDataDir);
    const localUserId = options.localUserId ?? `local-${homedir().replaceAll('\\', '_').replaceAll(':', '_')}`;
    // 管道名规范化：裸名字会被 node:net 当 TCP 主机名（EACCES）——统一补 \\.\pipe\ 前缀。
    const normalizePipe = (name: string): string => (name.startsWith('\\\\.\\pipe\\') ? name : `\\\\.\\pipe\\${name}`);
    const pipeName = options.pipeName != null ? normalizePipe(options.pipeName) : daemonPipeNameFor(localUserId);
    ipc = await startNamedPipeIpc(
      pipeName,
      async (envelope) =>
        dispatchDaemonCommand({
          db: db!,
          localUserId,
          interruptTurn: (turnId) => worker.interruptTurn(turnId),
          appDataDir: options.appDataDir,
          releaseAdmission: (turnId) => worker.reconcileRelease(turnId), // DEV-13 对账→准入内存联动
          pumpLateEvents: (turnId) => worker.pumpLateEventsForTurn(turnId), // 第八轮：迟到成果正式接收（adapter lateEvents 通道）
          ...(options.standaloneShutdown != null ? { scheduleShutdown: options.standaloneShutdown } : {}),
        }, envelope),
      { authToken: credential.token },
    );

    // drain 单飞（修复轮 5）：串行调度——上一轮未完成时跳过本 tick，不重入。
    // 修复轮 6：保存 drain Promise，stop 等待其收敛后才关库（数据库关闭后零业务写入）。
    let draining = false;
    let inFlightDrain: Promise<void> | null = null;
    const tick = setInterval(() => {
      if (draining) return;
      draining = true;
      inFlightDrain = worker.drain()
        .then(() => undefined)
        .catch((error) => {
          process.stderr.write(`[zhongshuo-daemon] drain error: ${error instanceof Error ? error.stack : String(error)}\n`);
        })
        .finally(() => {
          draining = false;
          inFlightDrain = null;
        });
    }, options.tickMs ?? 500);
    tick.unref?.();

    let stopPromise: Promise<DaemonStopResult> | null = null; // 优雅关闭（幂等缓存）
    let forcePromise: Promise<DaemonStopResult> | null = null; // 强制关闭（另行定义，幂等缓存）
    return {
      pipeName,
      db,
      worker,
      adapter,
      memberRuntime,
      credential,
      stop(stopOptions?: { force?: boolean }): Promise<DaemonStopResult> {
        const settleMs = options.drainSettleTimeoutMs ?? 10_000;
        // 有界收拢：disposeAll 可能挂起（真实反例）——限时返回合成失败项，不无限等待。
        const boundedDisposeAll = async (ms: number): Promise<MemberDisposeReport> => {
          let timer: NodeJS.Timeout | undefined;
          try {
            return await Promise.race([
              memberRuntime.disposeAll(),
              new Promise<MemberDisposeReport>((r) => {
                timer = setTimeout(() => r({
                  entries: [],
                  failed: [{ adapter: '(disposeAll)', error: `dispose 收拢超时（>${ms}ms）——进程状态不确定` }],
                  unconfirmed: [],
                }), ms);
                timer.unref?.();
              }),
            ]);
          } catch (error) {
            return { entries: [], failed: [{ adapter: '(disposeAll)', error: String(error).slice(0, 200) }], unconfirmed: [] };
          } finally {
            if (timer != null) clearTimeout(timer);
          }
        };
        // 不确定/收尾记录持久化（stderr ≠ 持久化——重启恢复从 daemon_state 读取）。
        const persistStopRecord = (record: Record<string, unknown>): void => {
          try {
            db!.prepare(
              `INSERT INTO daemon_state (key, value, updated_at) VALUES ('daemon:stop:last', ?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            ).run(JSON.stringify({ pid: process.pid, ...record }), Date.now());
          } catch (error) {
            process.stderr.write(`[zhongshuo-daemon] stop 记录持久化失败（恢复依据退回 WAL/崩溃语义）：${error instanceof Error ? error.message : String(error)}\n`);
          }
        };
        const beginGraceful = (): Promise<DaemonStopResult> => {
          if (stopPromise != null) return stopPromise; // 重复 stop 幂等：同一关闭过程同一结果
          stopPromise = runGraceful();
          return stopPromise;
        };
        const runGraceful = async (): Promise<DaemonStopResult> => {
          clearInterval(tick);                     // 1) 拒新派发（停 tick）
          worker.stopAccepting();                  // 1b) drain 安全边界：拒新领取（在执行项继续）+ 启动窗口检查位
          await ipc!.close();                      // 2) 拒新命令（断开全部连接）
          // 3) 等待在途 drain 收敛（不取消——当前项在安全边界内收尾）；超时不判定完成，
          //    最终 incomplete 判定（第 5 步后）复查 drain 是否仍挂起。
          if (inFlightDrain != null) {
            await Promise.race([
              inFlightDrain,
              new Promise((r) => { const t = setTimeout(r, settleMs); t.unref?.(); }),
            ]);
          }
          // 4) 对全部在途 turn 发停止请求（请求≠退出确认）；随后收拢 runtime（杀+等退出确认）。
          const stopRequestsSentTo = await worker.requestStopAll();
          const disposeReport = await boundedDisposeAll(settleMs);
          // 5) 等启动窗口与消费器全部收尾（覆盖晚返回的 openSession/startTurn 与运行中的
          //    消费器——两者都可能是后台写库者）+ 复查 drain；确认零后台写库后才允许关库。
          const settlement = await worker.awaitSettlement(settleMs);
          const drainPending = inFlightDrain != null;
          const inFlightRemaining = settlement.remaining.filter((r) => r.phase === 'consuming').map((r) => r.turnId);
          const startingRemaining = settlement.remaining.filter((r) => r.phase === 'starting').map((r) => r.turnId);
          const reasons = [
            drainPending ? `drain 未收敛（启动/消费可能仍在途）` : null,
            inFlightRemaining.length > 0 ? `消费器未收敛(${inFlightRemaining.length})` : null,
            startingRemaining.length > 0 ? `启动中的派发未收尾(${startingRemaining.length})` : null,
            disposeReport.failed.length > 0 ? `收拢失败(${disposeReport.failed.length})` : null,
            disposeReport.unconfirmed.length > 0 ? `退出未确认(${disposeReport.unconfirmed.length})` : null,
          ].filter((x) => x != null) as string[];
          if (reasons.length === 0) {
            persistStopRecord({ at: Date.now(), phase: 'closed', stopRequestsSentTo });
            // 受管 job 全量收尾（第十四轮二：stop 期间资源回收归属——runtime 已收拢、零后台
            // 写库确认后；KILL_ON_JOB_CLOSE 兜底残留进程；幂等）。不完整路径不收尾（崩溃语义：
            // 进程退出本身即关闭 job 句柄，现场随 WAL 保留）。
            managedBridgeMod.disposeAllManagedJobs();
            db!.close();                  // 6) 关库（零后台写库已确认：drain/启动/消费器全收敛）
            lockHandle.release();         // 7) 释放锁
            return { complete: true, phase: 'closed', stopRequestsSentTo, disposeReport, inFlightRemaining: [], startingRemaining: [] };
          }
          // 未完成：不关库、不释放锁（daemon 退出≠子进程退出；锁保留=崩溃现场，恢复路径收口）。
          const reason = reasons.join('；');
          persistStopRecord({
            at: Date.now(), phase: 'incomplete', reason, drainPending,
            stopRequestsSentTo, inFlightRemaining, startingRemaining,
            disposeFailed: disposeReport.failed, disposeUnconfirmed: disposeReport.unconfirmed,
          });
          process.stderr.write(`[zhongshuo-daemon] stop 未完成（incomplete）：${reason}——恢复依据=崩溃恢复语义（WAL+applyRecovery）+ daemon:stop:last 持久化记录\n`);
          return { complete: false, phase: 'incomplete', stopRequestsSentTo, disposeReport, inFlightRemaining, startingRemaining, drainPending, reason };
        };
        if (stopOptions?.force === true) {
          // 强制路径（另行定义，幂等）：等优雅结果 → 已完成则复用 → 杀进程 + 中止消费器
          // （UNKNOWN 收尾写库）→ **核对**进程收拢与消费器/启动收敛结果后才关库；仍有未确认
          // 对象则返回 incomplete（不关库、不释放锁——宿主若仍退出=崩溃语义，WAL 保留现场），
          // 不声称已确认杀完进程或已完成 UNKNOWN 落库。
          if (forcePromise != null) return forcePromise;
          forcePromise = (async (): Promise<DaemonStopResult> => {
            const gracefulResult = await beginGraceful();
            if (gracefulResult.complete) return gracefulResult;
            const disposeReport = await boundedDisposeAll(Math.min(settleMs, 5_000));
            worker.abortConsumers();
            const settlement = await worker.awaitSettlement(Math.min(settleMs, 5_000));
            const drainPending = inFlightDrain != null;
            const inFlightRemaining = settlement.remaining.filter((r) => r.phase === 'consuming').map((r) => r.turnId);
            const startingRemaining = settlement.remaining.filter((r) => r.phase === 'starting').map((r) => r.turnId);
            const unresolved = [
              drainPending ? `drain 仍挂起` : null,
              inFlightRemaining.length > 0 ? `消费器未收敛(${inFlightRemaining.length})` : null,
              startingRemaining.length > 0 ? `启动中的派发未收尾(${startingRemaining.length})` : null,
              disposeReport.failed.length > 0 ? `收拢失败(${disposeReport.failed.length})` : null,
              disposeReport.unconfirmed.length > 0 ? `退出未确认(${disposeReport.unconfirmed.length})` : null,
            ].filter((x) => x != null) as string[];
            if (unresolved.length > 0) {
              const reason = `强制路径仍未收敛：${unresolved.join('；')}——不关库不释放锁（崩溃语义，WAL/UNKNOWN 现场保留），不声称已确认杀完/落库`;
              persistStopRecord({
                at: Date.now(), phase: 'forced-incomplete', reason, drainPending,
                stopRequestsSentTo: gracefulResult.stopRequestsSentTo, inFlightRemaining, startingRemaining,
                disposeFailed: disposeReport.failed, disposeUnconfirmed: disposeReport.unconfirmed,
              });
              process.stderr.write(`[zhongshuo-daemon] ${reason}\n`);
              return {
                complete: false, phase: 'incomplete',
                stopRequestsSentTo: gracefulResult.stopRequestsSentTo, disposeReport,
                inFlightRemaining, startingRemaining, drainPending, reason,
              };
            }
            persistStopRecord({ at: Date.now(), phase: 'forced-closed', note: '强制路径已核对：进程收拢+消费器 UNKNOWN 落库+启动窗口收尾完成后关库', stopRequestsSentTo: gracefulResult.stopRequestsSentTo });
            managedBridgeMod.disposeAllManagedJobs(); // 受管 job 全量收尾（同优雅完成路径；幂等）
            db!.close();
            lockHandle.release();
            return {
              complete: true, phase: 'forced-closed',
              stopRequestsSentTo: gracefulResult.stopRequestsSentTo, disposeReport,
              inFlightRemaining: [], startingRemaining: [],
              reason: '强制路径：杀进程+消费器按 UNKNOWN 收尾，收拢结果已核对后关库',
            };
          })();
          return forcePromise;
        }
        // 非强制：若强制已发生，返回其结果（同一关闭过程的最终结果）。
        return forcePromise ?? beginGraceful();
      },
    };
  } catch (error) {
    // 启动失败清理（不留半启动实例）。
    if (ipc != null) await ipc.close().catch(() => {});
    if (adapter != null && adapter instanceof CodexAppServerAdapter) await adapter.dispose().catch(() => {});
    if (db != null) db.close();
    if (lock != null && lock.ok) lock.value.release();
    throw error;
  }
}

/** 独立进程入口：源码=src/daemon/entry.ts 尾缀；打包产物=ZS_PACKED_ENTRY=1（DEV-15 早期打包验证）。 */
if (process.argv[1]?.replaceAll('\\', '/').endsWith('src/daemon/entry.ts') || process.env.ZS_PACKED_ENTRY === '1') {
  const appDataDir = process.env.ZS_APP_DATA ?? defaultAppDataDir();
  const rawRuntime = process.env.ZS_RUNTIME ?? 'fake';
  const runtime = (rawRuntime === 'codex' || rawRuntime === 'claude' ? rawRuntime : 'fake') as 'fake' | 'codex' | 'claude';
  if (runtime === 'fake' && process.env.ZS_ALLOW_FAKE !== '1') {
    // 正式用户启动路径不得静默使用 fake runtime（显式开发模式需 ZS_ALLOW_FAKE=1）。
    process.stderr.write('[zhongshuo-daemon] fake runtime 仅限开发/测试（ZS_RUNTIME=fake 需同时设置 ZS_ALLOW_FAKE=1）；生产请用 ZS_RUNTIME=codex|claude\n');
    process.exit(2);
  }
  if (runtime === 'claude' && process.env.ZS_CLAUDE_MODEL == null) {
    // 只警告不退出：成员级绑定（agent_profiles.settings_json.model）可提供模型。
    process.stderr.write('[zhongshuo-daemon] ZS_CLAUDE_MODEL 未设置：全局 claude runtime 需显式模型（成员配置可按成员提供）\n');
  }
  let requestShutdown: (() => void) | null = null;
  void startDaemon({
    appDataDir, runtime, pipeName: process.env.ZS_PIPE_NAME,
    // daemon.shutdown（DEV-15 第十四轮三）：IPC 正式关闭——命令响应先发出（250ms 让路），
    // 确认=进程退出码+daemon:stop:last 记录（关闭会断 IPC，响应不声称完成）。
    standaloneShutdown: () => { requestShutdown?.(); },
  }).then((daemon) => {
    process.stderr.write(`[zhongshuo-daemon] listening ${daemon.pipeName} runtime=${runtime}\n`);
    // pid 落盘（诊断/UI 端到端定位子进程；正常退出删除——SIGKILL 残留即崩溃现场）。
    const pidPath = join(appDataDir, 'daemon.pid');
    writeFileSync(pidPath, String(process.pid), 'utf8');
    let shutdownStarted = false;
    const shutdown = async () => {
      let result = await daemon.stop();
      if (!result.complete) {
        // 优雅关闭未完成：走强制路径（恢复依据已持久化），退出码区分。
        result = await daemon.stop({ force: true });
      }
      try { rmSync(pidPath, { force: true }); } catch { /* 退出路径不因此失败 */ }
      // 结构化停机事实尾行（第十四轮三：宿主/UI 按事实呈现——强制≠优雅成功、未确认如实）。
      process.stderr.write(`[zhongshuo-daemon] stop-result ${JSON.stringify({
        complete: result.complete,
        phase: result.phase,
        exitCode: result.complete ? 0 : 3,
        forced: result.phase === 'forced-closed',
        stopRequestsSentTo: result.stopRequestsSentTo,
        inFlightRemaining: result.inFlightRemaining ?? [],
        startingRemaining: result.startingRemaining ?? [],
        disposeUnconfirmed: result.disposeReport?.unconfirmed?.length ?? 0,
        disposeFailed: result.disposeReport?.failed?.length ?? 0,
        stopRecord: 'daemon_state[daemon:stop:last]（appData/state.sqlite）',
      })}\n`);
      process.exit(result.complete ? 0 : 3);
    };
    requestShutdown = () => {
      if (shutdownStarted) return; // 重复 shutdown/信号=同一关闭过程（stop 本身幂等）
      shutdownStarted = true;
      setTimeout(() => { void shutdown(); }, 250).unref?.();
    };
    process.on('SIGINT', () => requestShutdown?.());
    process.on('SIGTERM', () => requestShutdown?.());
  });
}
