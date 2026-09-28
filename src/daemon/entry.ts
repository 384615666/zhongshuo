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
import { MemberRuntimeRegistry, type MemberAdapterFactory } from './memberRuntime.ts';
import { FakeRuntimeAdapter } from '../adapter/fake/runtimeAdapter.ts';
import { successTurn } from '../adapter/fake/script.ts';
import { simulateDeliberationTurn } from '../adapter/fake/deliberationSim.ts';
import { CodexAppServerAdapter } from '../adapter/codex/appServerAdapter.ts';
import { ClaudeCliAdapter } from '../adapter/claude/cliAdapter.ts';
import type { RuntimeAdapter } from '../contracts/runtime.ts';
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
  stop(): Promise<void>;
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

    adapter = options.runtime === 'codex'
      ? new CodexAppServerAdapter({ model: process.env.ZS_E2E_MODEL })
      : options.runtime === 'claude'
        ? new ClaudeCliAdapter({ model: process.env.ZS_CLAUDE_MODEL })
        : new FakeRuntimeAdapter(
            // fake 专用编排入口（仅 ZS_ALLOW_FAKE=1 显式开发模式）：停延 stall 供
            // UI 端到端在「运行中」窗口内点击停止/制造中断现场（正式路径不读取）；
            // ZS_FAKE_DELIB=1 时按输入契约生成合法研讨载荷（UI 全链路演练）。
            process.env.ZS_FAKE_STALL_MS != null && Number(process.env.ZS_FAKE_STALL_MS) > 0
              ? { turnScripts: [[{ kind: 'stall', ms: Number(process.env.ZS_FAKE_STALL_MS) }, ...successTurn()]] }
              : process.env.ZS_FAKE_DELIB === '1'
                ? { structuredFinal: false, turnScriptSequencer: (input) => simulateDeliberationTurn(input.text) }
                : undefined,
          );

    // 成员级 runtime 注册表（DEV-10）：同一项目允许成员 A 绑定 codex、成员 B 绑定
    // claude（模型/权限档来自 agent_profiles.settings_json）；fake 工厂仅显式开发模式注册。
    const claudePermissionOf = (mode: string | null): 'plan' | 'manual' | 'acceptEdits' | 'auto' | 'dontAsk' | 'bypassPermissions' | undefined =>
      mode === 'plan' || mode === 'manual' || mode === 'acceptEdits' || mode === 'auto' || mode === 'dontAsk' || mode === 'bypassPermissions' ? mode : undefined;
    const factories: Record<string, MemberAdapterFactory> = {
      codex: (binding) => new CodexAppServerAdapter({ model: binding.model ?? process.env.ZS_E2E_MODEL }),
      claude: (binding) => new ClaudeCliAdapter({
        model: binding.model ?? process.env.ZS_CLAUDE_MODEL,
        executable: binding.executable ?? undefined,
        permissionMode: claudePermissionOf(binding.permissionMode),
        installationId: binding.installationId ?? undefined,
      }),
    };
    if (process.env.ZS_ALLOW_FAKE === '1') {
      factories.fake = () => new FakeRuntimeAdapter();
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
    const pipeName = options.pipeName ?? daemonPipeNameFor(localUserId);
    ipc = await startNamedPipeIpc(
      pipeName,
      async (envelope) =>
        dispatchDaemonCommand({
          db: db!,
          localUserId,
          interruptTurn: (turnId) => worker.interruptTurn(turnId),
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

    let stopped = false;
    let stopPromise: Promise<void> | null = null; // 重复 stop 共用同一次关闭
    return {
      pipeName,
      db,
      worker,
      adapter,
      memberRuntime,
      credential,
      stop(): Promise<void> {
        if (stopPromise != null) return stopPromise; // 重复 stop 幂等：同一关闭过程
        stopped = true;
        stopPromise = (async () => {
          clearInterval(tick);          // 1) 拒新派发（停 tick）
          await ipc!.close();           // 2) 拒新命令（断开全部连接）
          // 3) 等待在途 drain 收敛（不取消——让当前事务/事件落库后停），
          //    上限保护：tick 间隔级 drain 不应长挂；超时则记录并继续（数据库仍按序关闭）。
          if (inFlightDrain != null) {
            await Promise.race([
              inFlightDrain,
              new Promise((r) => { const t = setTimeout(r, options.drainSettleTimeoutMs ?? 10_000); t.unref?.(); }),
            ]);
          }
          // 4) 收拢全部 runtime（成员级 + 默认；等待子进程退出）——失败/未确认上报，不吞。
          //    杀进程触发在途消费器收终态 → 5) 等消费器写库收敛（关库前回调必须收敛）。
          const disposeReport = await memberRuntime.disposeAll();
          if (disposeReport.failed.length > 0 || disposeReport.unconfirmed.length > 0) {
            process.stderr.write(`[zhongshuo-daemon] runtime 收拢未全确认：failed=${JSON.stringify(disposeReport.failed)} unconfirmed=${JSON.stringify(disposeReport.unconfirmed)}\n`);
          }
          const inFlight = await worker.awaitInFlightTurns(options.drainSettleTimeoutMs ?? 10_000);
          if (inFlight.remaining.length > 0) {
            process.stderr.write(`[zhongshuo-daemon] stop：在途 turn 消费器未全收敛（不确定，不假装完成）：${inFlight.remaining.join(',')}\n`);
          }
          db!.close();                  // 6) 关库（此后 worker 任何写入都会抛 SQLITE 错误——按序保证不再发生）
          lockHandle.release();         // 6) 释放锁
          void stopped;
        })();
        return stopPromise;
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

/** 独立进程入口：node --experimental-strip-types src/daemon/entry.ts */
if (process.argv[1]?.replaceAll('\\', '/').endsWith('src/daemon/entry.ts')) {
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
  void startDaemon({ appDataDir, runtime, pipeName: process.env.ZS_PIPE_NAME }).then((daemon) => {
    process.stderr.write(`[zhongshuo-daemon] listening ${daemon.pipeName} runtime=${runtime}\n`);
    // pid 落盘（诊断/UI 端到端定位子进程；正常退出删除——SIGKILL 残留即崩溃现场）。
    const pidPath = join(appDataDir, 'daemon.pid');
    writeFileSync(pidPath, String(process.pid), 'utf8');
    const shutdown = async () => {
      await daemon.stop();
      try { rmSync(pidPath, { force: true }); } catch { /* 退出路径不因此失败 */ }
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  });
}
