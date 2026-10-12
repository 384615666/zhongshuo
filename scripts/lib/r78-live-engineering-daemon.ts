/** External, QA-built entry for a copied final package. Never installed in the daily package. */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Server, type Socket } from 'node:net';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';

type StopResult = { complete: boolean; phase: string; stopRequestsSentTo: string[]; inFlightRemaining?: string[]; startingRemaining?: string[]; disposeReport?: { unconfirmed?: unknown[]; failed?: unknown[] } };
type Running = { pipeName: string; db: { prepare(sql: string): { get(): { c: number } }; }; stop(opts?: { force?: boolean }): Promise<StopResult> };

const appDataDir = process.env.ZS_APP_DATA;
if (appDataDir == null || appDataDir.length === 0) throw new Error('R78 engineering daemon requires explicit ZS_APP_DATA');
const data = resolve(appDataDir);
const packageRoot = resolve(data, '..', 'ZhongshuoDual');
const packedEntry = join(packageRoot, 'resources', 'app', 'daemon', 'daemon.cjs');
const buildFile = join(packageRoot, 'BUILD.json');
const markerFile = join(data, 'engineering-r78.json');
// Isolated engineering host only. Product daemon and daily package do not contain this hook.
const ownedSockets=new Set<Socket>();let blockedUntil=0;
const originalEmit=Server.prototype.emit;
Server.prototype.emit=function(event:string,...args:unknown[]){if(event==='connection'){const socket=args[0] as Socket;if(performance.now()<blockedUntil){socket.destroy();return true;}ownedSockets.add(socket);socket.once('close',()=>ownedSockets.delete(socket));}return Reflect.apply(originalEmit,this,[event,...args]);};
const controlPath=join(data,'engineering','r80-control.json');
const controlTimer=setInterval(()=>{if(!existsSync(controlPath))return;try{const control=JSON.parse(readFileSync(controlPath,'utf8')) as {op:string;ms:number};rmSync(controlPath);if(control.op==='disconnect'){blockedUntil=performance.now()+Math.min(30_000,Math.max(0,control.ms));for(const socket of ownedSockets)socket.destroy();writeFileSync(join(data,'engineering','r80-control-receipt.json'),JSON.stringify({op:control.op,at:Date.now(),ms:control.ms,pid:process.pid}));}}catch{/* own fixture control */}},250);controlTimer.unref();
for (const file of [packedEntry, buildFile, markerFile]) if (!existsSync(file)) throw new Error(`R78 engineering daemon missing ${file}`);
const build = JSON.parse(readFileSync(buildFile, 'utf8')) as { buildId: string };
const marker = JSON.parse(readFileSync(markerFile, 'utf8')) as { token?: string; appDataDir?: string; daemonEntry?: string };
if (marker.appDataDir !== data || marker.daemonEntry !== resolve(process.argv[1] ?? '')) throw new Error('R78 engineering marker path mismatch');
if (marker.token == null || marker.token.length < 32 || process.env.ZS_R78_ENGINEERING_TOKEN !== marker.token) throw new Error('R78 engineering marker token mismatch');

// The packaged entry's normal CLI auto-start is keyed by ZS_PACKED_ENTRY. Require its exported
// startDaemon without starting a second instance; this helper remains the only daemon process.
const require = createRequire(packedEntry);
delete process.env.ZS_PACKED_ENTRY;
const packed = require(packedEntry) as { startDaemon?: (options: unknown) => Promise<Running> };
if (typeof packed.startDaemon !== 'function') throw new Error('final packaged daemon does not export startDaemon');
process.env.ZS_RUNTIME = 'fake';
process.env.ZS_ALLOW_FAKE = '1';
process.env.ZS_REAL_DISPATCH_GUARD = '1';
process.env.ZS_APP_MODE = 'fake-sim';

const revisions = { room: 0, dm: 0 };
let r79Failures = 0;
const adapter = new FakeRuntimeAdapter({
  turnScriptSequencer: ({ text }): FakeTurnScript => {
    if (text.includes('R79 UI LIVE') || text.includes('R79 UI FAIL') || text.includes('R79 UI SCALE')) {
      if (text.includes('R79 UI FAIL') && r79Failures++ === 0) return [
        { kind: 'event', event: { kind: 'tool.started', toolCallId: 'r79-fail-tool', toolName: 'R79_ENGINEERING_FAILURE', argumentsSummary: '' } },
        { kind: 'event', event: { kind: 'turn.failed', code: 'R79_ENGINEERING_FAILURE', message: '独立工程明确失败；显式继续才恢复', retryable: true } },
      ];
      const file = text.includes('R79 UI SCALE') ? 'results/r79-scale-original.md' : 'results/r79-live.md';
      const finalText = JSON.stringify({ schemaVersion: 'task-complete-v1', changeSummary: 'R79 工程自然交付', files: [file], executedVerifications: ['正式 worker + 显式 Fake adapter'], unexecutedVerifications: [], remainingIssues: [] });
      return [
        ...(text.includes('R79 UI LIVE') ? [
          { kind: 'stall' as const, ms: 2500 },
          { kind: 'event' as const, event: { kind: 'tool.started' as const, toolCallId: 'r79-live-tool', toolName: 'R79_LIVE_PROGRESS_MARKER', argumentsSummary: '' } },
          { kind: 'stall' as const, ms: 6000 },
          { kind: 'event' as const, event: { kind: 'tool.completed' as const, toolCallId: 'r79-live-tool', outcome: 'success' as const } },
          { kind: 'event' as const, event: { kind: 'usage.updated' as const, accounting: 'cumulative' as const, inputTokens: 321, outputTokens: 22, costQuality: 'unknown' as const } },
          { kind: 'stall' as const, ms: 20_000 },
        ] : []),
        { kind: 'writeFile', path: file, content: '# R79 工程原件\n\n正式 worker 自然生成；零真实模型调用。\n' },
        { kind: 'event', event: { kind: 'turn.completed', finalText } },
      ];
    }
    if (text.includes('R78 UI STOP')) return [
      { kind: 'event', event: { kind: 'message.completed', messageId: `r78-stop-progress-${randomUUID()}`, text: 'R78 UI STOP：运行中等待停止' } },
      { kind: 'stall', ms: 60_000 },
    ];
    const kind = text.includes('R78 UI ROOM') ? 'room' : text.includes('R78 UI DM') ? 'dm' : null;
    if (kind == null) return [{ kind: 'event', event: { kind: 'turn.failed', code: 'R78_UNSCRIPTED', message: '工程 daemon 仅处理 R78 UI ROOM/DM 标记任务', retryable: false } }];
    const revision = ++revisions[kind];
    const file = `results/r78-ui-${kind}-v${revision}.md`;
    const label = `R78 UI ${kind.toUpperCase()} 第 ${revision} 版工程交付`;
    const finalText = JSON.stringify({ schemaVersion: 'task-complete-v1', changeSummary: label, files: [file], executedVerifications: ['工程 Fake adapter 写入真实项目文件'], unexecutedVerifications: [], remainingIssues: [] });
    return [
      { kind: 'event', event: { kind: 'message.completed', messageId: `r78-progress-${randomUUID()}`, text: `${label}：正在生成成果文件` } },
      { kind: 'stall', ms: 5000 },
      { kind: 'writeFile', path: file, content: `# ${label}\n\n该文件由正式打包 worker 与显式工程 Fake adapter 自然生成。\n` },
      { kind: 'event', event: { kind: 'turn.completed', finalText } },
    ];
  },
});

let daemon: Running | null = null;
let shutdownStarted = false;
const pidPath = join(data, 'daemon.pid');
const readyPath = join(data, 'engineering', 'ready.json');
async function shutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  if (daemon == null) return;
  try {
    // stop closes the DB, so collect this invariant first; it is also checked by the parent verifier.
    const realCalls = daemon.db.prepare('SELECT count(*) c FROM real_calls').get().c;
    let stop = await daemon.stop();
    if (!stop.complete) stop = await daemon.stop({ force: true });
    try { rmSync(pidPath, { force: true }); } catch { /* diagnostic file only */ }
    try { rmSync(readyPath, { force: true }); } catch { /* diagnostic file only */ }
    process.stderr.write(`[zhongshuo-daemon] stop-result ${JSON.stringify({
      complete: stop.complete, phase: stop.phase, exitCode: stop.complete && realCalls === 0 ? 0 : 3,
      forced: stop.phase === 'forced-closed', stopRequestsSentTo: stop.stopRequestsSentTo,
      inFlightRemaining: stop.inFlightRemaining ?? [], startingRemaining: stop.startingRemaining ?? [],
      disposeUnconfirmed: stop.disposeReport?.unconfirmed?.length ?? 0,
      disposeFailed: stop.disposeReport?.failed?.length ?? 0, realCalls,
      stopRecord: 'daemon_state[daemon:stop:last]（appData/state.sqlite）',
    })}\n`);
    process.exit(stop.complete && realCalls === 0 ? 0 : 3);
  } catch (error) {
    process.stderr.write(`[r78-engineering-daemon] stop failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(3);
  }
}
const requestShutdown = () => { setTimeout(() => { void shutdown(); }, 250).unref?.(); };
process.on('SIGINT', requestShutdown);
process.on('SIGTERM', requestShutdown);

void (async () => {
  daemon = await packed.startDaemon!({ appDataDir: data, runtime: 'fake', pipeName: process.env.ZS_PIPE_NAME, tickMs: 700, testAdapter: adapter, standaloneShutdown: requestShutdown });
  writeFileSync(pidPath, String(process.pid), 'utf8');
  const ready = { buildId: build.buildId, packedEntry, appDataDir: data, pipeName: daemon.pipeName, pid: process.pid, fakeAdapterInjected: true, realDispatchGuard: true, at: Date.now() };
  writeFileSync(readyPath, JSON.stringify(ready, null, 2), 'utf8');
  process.stderr.write(`[r78-engineering-daemon] listening ${daemon.pipeName} build=${build.buildId} fake-sim\n`);
})().catch((error) => {
  process.stderr.write(`[r78-engineering-daemon] startup failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
