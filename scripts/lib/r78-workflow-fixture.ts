/** R78 engineering fixture. Invoke only with a fresh, dedicated root. No real runtime is started. */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';

type Reply<T> = { ok: boolean; data?: T; error?: { code: string; message: string }; replayed?: boolean };
type Submit = { taskId: string | null; threadId?: string; messageId?: string; disposition: string };
type Delivery = { id: string; revision: number; manifest_hash: string; run_id: string; review_status: string };

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until<T>(read: () => T, good: (value: T) => boolean, label: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (good(value)) return value;
    if (Date.now() - start > 10_000) throw new Error(`R78 ${label} timeout: ${JSON.stringify(value)}`);
    await pause(40);
  }
}

export interface R78FixtureReport {
  root: string; appData: string; dbPath: string; projectPath: string;
  projectId: string; roomId: string; roomConversationId: string; dmConversationId: string;
  memberId: string; roomTaskId: string; roomThreadId: string; dmTaskId: string;
  roomDeliveries: string[]; dmDeliveries: string[];
  recordedThreadId: string; failedTaskId: string; stoppedTaskId: string; unknownReplayMessageId: string;
  finalFiles: string[];
}

/** Creates a persistent disk fixture through daemon commands and normal DispatchWorker consumption. */
export async function buildR78WorkflowFixture(fixtureRoot: string): Promise<R78FixtureReport> {
  const root = resolve(fixtureRoot);
  if (existsSync(root)) throw new Error(`R78 fixture root already exists; refusing to overwrite: ${root}`);
  const appData = join(root, 'app-data');
  const projectPath = join(root, 'project');
  // Must match startDaemon's appData/state.sqlite so the final desktop launcher can reopen it.
  const dbPath = join(appData, 'state.sqlite');
  mkdirSync(appData, { recursive: true });
  mkdirSync(projectPath, { recursive: true });
  const db = openDatabase(dbPath);
  // Match startDaemon's default identity so the dedicated desktop reopen sees this fixture's DM.
  const userId = `local-${homedir().replaceAll('\\', '_').replaceAll(':', '_')}`;
  const scripts: Array<() => FakeTurnScript> = [];
  const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => scripts.shift()?.() ?? [{ kind: 'event', event: { kind: 'turn.failed', code: 'UNSCRIPTED', message: 'R78 fixture missing script', retryable: false } }] });
  let activeWorker: DispatchWorker | null = null;
  const deps = { db, localUserId: userId, appDataDir: appData, interruptTurn: async (turnId: string) => { await activeWorker?.interruptTurn(turnId); } };
  const raw = <T,>(method: string, params: unknown, commandId = `r78-${randomUUID()}`) => dispatchDaemonCommand(deps, { protocolVersion: 1, commandId, method, params }) as Promise<Reply<T>>;
  const cmd = async <T,>(method: string, params: unknown, commandId?: string): Promise<T> => {
    const r = await raw<T>(method, params, commandId);
    if (!r.ok || r.data == null) throw new Error(`${method}: ${r.error?.code ?? 'NO_DATA'} ${r.error?.message ?? ''}`);
    return r.data;
  };
  const worker = () => { activeWorker = new DispatchWorker({ db, adapter, leaseOwner: `r78-${randomUUID().slice(0, 8)}`, appDataDir: appData }); return activeWorker; };
  const delivery = (taskId: string, revision: number): Delivery | undefined => db.prepare('SELECT id, revision, manifest_hash, run_id, review_status FROM task_deliveries WHERE task_id=? AND revision=?').get(taskId, revision) as Delivery | undefined;
  const status = (taskId: string): string | undefined => (db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status: string } | undefined)?.status;
  const runScript = async (script: () => FakeTurnScript, taskId: string, revision: number): Promise<Delivery> => {
    scripts.push(script);
    const worked = await worker().runOnce();
    if (!worked) throw new Error(`R78 worker did not claim task ${taskId} rev ${revision}`);
    return until(() => delivery(taskId, revision), (x) => x != null, `delivery ${taskId}/${revision}`) as Promise<Delivery>;
  };
  const success = (file: string, label: string): FakeTurnScript => {
    const content = `# ${label}\n\nR78 工程夹具生成的真实文件。\n`;
    const pendingTurn = db.prepare("SELECT id FROM agent_turns WHERE status IN ('PENDING','DISPATCHING','RUNNING') ORDER BY rowid DESC LIMIT 1").get() as { id: string } | undefined;
    if (pendingTurn == null) throw new Error(`R78 missing active turn for ${label}`);
    const finalText = JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: `result_${pendingTurn.id}`, changeSummary: label, files: [file], executedVerifications: ['R78 fake worker completed'], unexecutedVerifications: [], remainingIssues: [] });
    return [
      { kind: 'event', event: { kind: 'message.completed', messageId: `progress-${randomUUID().slice(0, 8)}`, text: `${label}：处理中` } },
      { kind: 'writeFile', path: file, content },
      { kind: 'event', event: { kind: 'message.completed', messageId: `final-${randomUUID().slice(0, 8)}`, text: finalText } },
      { kind: 'event', event: { kind: 'turn.completed', finalText } },
    ];
  };
  const review = (taskId: string, d: Delivery, decision: 'accept' | 'changes_requested', note?: string) => cmd('task.review', { taskId, deliveryId: d.id, deliveryRevision: d.revision, manifestHash: d.manifest_hash, decision, ...(note != null ? { note } : {}) });
  const execute = (taskId: string, d: Delivery) => cmd('task.executeRework', { taskId, deliveryId: d.id, deliveryRevision: d.revision, manifestHash: d.manifest_hash, sourceRunId: d.run_id });
  try {
    const opened = await cmd<{ project: { id: string } }>('project.open', { path: projectPath, displayName: 'R78 独立工作流', agentNames: ['R78 模拟协作员'] });
    const projectId = opened.project.id;
    const members = await cmd<{ items: Array<{ id: string; principalType: string }> }>('member.list', { projectId });
    const memberId = members.items.find((m) => m.principalType === 'agent')?.id;
    if (memberId == null) throw new Error('R78 project bootstrap yielded no agent');
    const p = db.prepare('SELECT revision FROM projects WHERE id=?').get(projectId) as { revision: number };
    await cmd('project.reviewPolicy.set', { projectId, taskReviewEnabled: true, expectedRevision: p.revision });
    const room = (await cmd<{ room: { id: string; conversationId: string } }>('room.create', { projectId, name: 'R78 流程房间', memberIds: [memberId] })).room;
    const dm = await cmd<{ conversationId: string }>('conversation.create', { projectId, peerMemberId: memberId, title: 'R78 流程私信' });
    const roomTarget = { kind: 'room_root', projectId, conversationId: room.conversationId, roomId: room.id };
    const dmTarget = { kind: 'dm', projectId, conversationId: dm.conversationId };
    const roomSend = await cmd<Submit>('message.submit', { target: roomTarget, body: 'R78 ROOM DIRECT：生成初稿并等待验收', intent: 'default', mentions: [{ kind: 'member', memberId }] });
    if (roomSend.taskId == null || roomSend.threadId == null) throw new Error('R78 room did not create a task/thread');
    const roomTaskId = roomSend.taskId; const roomThreadId = roomSend.threadId;
    const rd1 = await runScript(() => success('results/room-v1.md', '房间初稿'), roomTaskId, 1);
    const roomPending = await cmd<unknown>('mine.pending', {});
    const roomBoard = await cmd<unknown>('board.view', { scope: 'project', projectId });
    if (!JSON.stringify(roomPending).includes(rd1.id) || !JSON.stringify(roomBoard).includes(rd1.id)) throw new Error('R78 room delivery absent from pending/board');
    await review(roomTaskId, rd1, 'changes_requested', 'R78 房间返工：补充第二版结论');
    if (status(roomTaskId) !== 'ACTIVE' || await worker().runOnce()) throw new Error('R78 room review unexpectedly dispatched');
    await execute(roomTaskId, rd1);
    const rd2 = await runScript(() => success('results/room-v2.md', '房间返工完成'), roomTaskId, 2);
    if (!adapter.startTurnLog[1]?.text.includes('R78 房间返工：补充第二版结论')) throw new Error('R78 room rework note absent from runtime input');
    await review(roomTaskId, rd2, 'accept');
    const dmSend = await cmd<Submit>('message.submit', { target: dmTarget, body: 'R78 DM DIRECT：生成初稿并等待验收', intent: 'default', mentions: [] });
    if (dmSend.taskId == null) throw new Error('R78 DM did not create task');
    const dmTaskId = dmSend.taskId;
    const dd1 = await runScript(() => success('results/dm-v1.md', '私信初稿'), dmTaskId, 1);
    const dmPending = await cmd<unknown>('mine.pending', {});
    if (!JSON.stringify(dmPending).includes(dd1.id)) throw new Error('R78 DM delivery absent from mine.pending');
    await review(dmTaskId, dd1, 'changes_requested', 'R78 私信返工：补充第二版结论');
    if (status(dmTaskId) !== 'ACTIVE' || await worker().runOnce()) throw new Error('R78 DM review unexpectedly dispatched');
    await execute(dmTaskId, dd1);
    const dd2 = await runScript(() => success('results/dm-v2.md', '私信返工完成'), dmTaskId, 2);
    if (!adapter.startTurnLog[3]?.text.includes('R78 私信返工：补充第二版结论')) throw new Error('R78 DM rework note absent from runtime input');
    await review(dmTaskId, dd2, 'accept');
    const recorded = await cmd<Submit>('message.submit', { target: roomTarget, body: 'R78 ONLY RECORD：不得建立任务', intent: 'record_only', mentions: [] });
    if (recorded.taskId != null || recorded.threadId == null) throw new Error('R78 record_only created a task');
    const failed = await cmd<Submit>('message.submit', { target: roomTarget, body: 'R78 EXPLICIT FAILURE：保留失败事实', intent: 'default', mentions: [{ kind: 'member', memberId }] });
    if (failed.taskId == null) throw new Error('R78 failure branch missing task');
    scripts.push(() => [{ kind: 'event', event: { kind: 'turn.failed', code: 'R78_EXPLICIT_FAILURE', message: '工程显式失败', retryable: false } }]);
    await worker().runOnce();
    await until(() => (db.prepare('SELECT status FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(failed.taskId) as { status: string } | undefined)?.status, (s) => s === 'FAILED', 'failure run');
    const stopped = await cmd<Submit>('message.submit', { target: roomTarget, body: 'R78 STOP BRANCH：运行中停止', intent: 'default', mentions: [{ kind: 'member', memberId }] });
    if (stopped.taskId == null) throw new Error('R78 stop branch missing task');
    scripts.push(() => [{ kind: 'stall', ms: 60_000 }]);
    const startsBeforeStop = adapter.startTurnLog.length;
    const stoppingWorker = worker();
    const consuming = stoppingWorker.runOnce();
    await until(() => adapter.startTurnLog.length, (n) => n > startsBeforeStop, 'stop turn started');
    const stopRun = db.prepare('SELECT id FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(stopped.taskId) as { id: string } | undefined;
    if (stopRun == null) throw new Error('R78 stop run missing');
    await cmd('task.stop', { taskId: stopped.taskId, targetRunId: stopRun.id, expectedStopGeneration: 0 });
    await consuming;
    await until(() => (db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(stopRun.id) as { status: string }).status, (s) => s === 'CANCELLED' || s === 'INTERRUPTED', 'stop settled');
    const envelope = { target: dmTarget, body: 'R78 UNKNOWN ENVELOPE：同号人工重放', intent: 'record_only', mentions: [] };
    const commandId = `r78-unknown-${randomUUID()}`;
    const first = await raw<Submit>('message.submit', envelope, commandId);
    if (!first.ok || first.data == null) throw new Error(`R78 unknown first commit: ${first.error?.message}`);
    // Simulate the caller losing the reply. Human action replays the exact commandId and payload.
    const replay = await raw<Submit>('message.submit', envelope, commandId);
    if (!replay.ok || !replay.replayed || replay.data?.messageId !== first.data.messageId) throw new Error('R78 same-envelope replay failed');
    const mismatch = await raw<Submit>('message.submit', { ...envelope, body: 'R78 altered envelope must fail' }, commandId);
    if (mismatch.ok || mismatch.error?.code !== 'IDEMPOTENCY_CONFLICT') throw new Error('R78 changed payload reused commandId');
    const finalFiles = ['results/room-v1.md', 'results/room-v2.md', 'results/dm-v1.md', 'results/dm-v2.md'];
    for (const file of finalFiles) if (!readFileSync(join(projectPath, file), 'utf8').includes('真实文件')) throw new Error(`R78 missing file ${file}`);
    if (status(roomTaskId) !== 'DONE' || status(dmTaskId) !== 'DONE') throw new Error('R78 acceptance incomplete');
    const report: R78FixtureReport = { root, appData, dbPath, projectPath, projectId, roomId: room.id, roomConversationId: room.conversationId, dmConversationId: dm.conversationId, memberId, roomTaskId, roomThreadId, dmTaskId, roomDeliveries: [rd1.id, rd2.id], dmDeliveries: [dd1.id, dd2.id], recordedThreadId: recorded.threadId, failedTaskId: failed.taskId, stoppedTaskId: stopped.taskId, unknownReplayMessageId: first.data.messageId ?? '', finalFiles };
    return report;
  } finally {
    await adapter.closeAllSessions();
    db.close();
  }
}
