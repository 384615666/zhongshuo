/**
 * daemon 组装入口（DEV-07）：单实例锁 → 打开/迁移库 → 恢复（落门禁）→
 * 命名管道 IPC（真实命令面）→ outbox worker（门禁感知）→ 优雅退出。
 * runtime 注册表：ZS_RUNTIME=fake（默认，零额度）| codex（真实 App Server）。
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDatabase } from '../persistence/db.ts';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { acquireSingletonLock } from './singletonLock.ts';
import { applyRecovery } from './stopFlow.ts';
import { startNamedPipeIpc } from './namedPipeIpc.ts';
import { dispatchDaemonCommand } from './commands.ts';
import { DispatchWorker } from './dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../adapter/fake/runtimeAdapter.ts';
import { CodexAppServerAdapter } from '../adapter/codex/appServerAdapter.ts';
import type { RuntimeAdapter } from '../contracts/runtime.ts';

export interface DaemonOptions {
  appDataDir: string;
  runtime: 'fake' | 'codex';
  localUserId?: string;
  pipeName?: string;
  /** 工作循环间隔（测试可调小）。 */
  tickMs?: number;
}

export interface RunningDaemon {
  pipeName: string;
  db: ZhongshuoDatabase;
  worker: DispatchWorker;
  adapter: RuntimeAdapter;
  stop(): Promise<void>;
}

export function defaultAppDataDir(): string {
  return join(homedir(), '.zhongshuo');
}

export function daemonPipeNameFor(user: string): string {
  return `\\\\.\\pipe\\zhongshuo-daemon-${user}`;
}

export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const lock = acquireSingletonLock(join(options.appDataDir, 'locks'));
  if (!lock.ok) throw new Error(`daemon 单实例锁获取失败：${lock.error.message}`);

  const db = openDatabase(join(options.appDataDir, 'state.sqlite'), {
    backupDir: join(options.appDataDir, 'backups'),
  });
  // 恢复：非终态标记 + 孤儿租约重排；有遗留即落 dispatch_gate=held（不自动续跑）。
  applyRecovery(db, Date.now());

  const adapter: RuntimeAdapter = options.runtime === 'codex'
    ? new CodexAppServerAdapter({ model: process.env.ZS_E2E_MODEL })
    : new FakeRuntimeAdapter();
  const worker = new DispatchWorker({
    db,
    adapter,
    leaseOwner: `daemon-${process.pid}`,
    appDataDir: options.appDataDir,
  });

  const localUserId = options.localUserId ?? `local-${homedir().replaceAll('\\', '_').replaceAll(':', '_')}`;
  const pipeName = options.pipeName ?? daemonPipeNameFor(localUserId);
  const ipc = await startNamedPipeIpc(pipeName, async (envelope) =>
    dispatchDaemonCommand({
      db,
      localUserId,
      interruptTurn: (turnId) => worker.interruptTurn(turnId),
    }, envelope),
  );

  const tick = setInterval(() => {
    void worker.drain().catch((error) => {
      process.stderr.write(`[zhongshuo-daemon] drain error: ${error instanceof Error ? error.stack : String(error)}
`);
    });
  }, options.tickMs ?? 500);
  tick.unref?.();

  return {
    pipeName,
    db,
    worker,
    adapter,
    async stop() {
      clearInterval(tick);
      await ipc.close();
      if (adapter instanceof CodexAppServerAdapter) await adapter.dispose();
      else await (adapter as FakeRuntimeAdapter).closeAllSessions();
      db.close();
      lock.value.release();
    },
  };
}

/** 独立进程入口：node --experimental-strip-types src/daemon/entry.ts */
if (process.argv[1]?.replaceAll('\\', '/').endsWith('src/daemon/entry.ts')) {
  const appDataDir = process.env.ZS_APP_DATA ?? defaultAppDataDir();
  const runtime = (process.env.ZS_RUNTIME === 'codex' ? 'codex' : 'fake') as 'fake' | 'codex';
  const daemon = await startDaemon({ appDataDir, runtime });
  process.stderr.write(`[zhongshuo-daemon] listening ${daemon.pipeName} runtime=${runtime}\n`);
  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
