import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { buildR78WorkflowFixture } from '../../scripts/lib/r78-workflow-fixture.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_REAL_BATCH_ID;
const base = mkdtempSync(join(tmpdir(), 'zs-r78-workflow-'));
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(base, { recursive: true, force: true }); break; } catch { /* Windows delayed handles */ } } });

describe('R78 persistent formal workflow and cross-page facts', () => {
  it('room DIRECT and DM deliver two real-file versions, explicit rework and acceptance, then reopen with same viewer', async () => {
    const f = await buildR78WorkflowFixture(join(base, `fixture-${randomUUID()}`));
    const db = openDatabase(f.dbPath);
    const userId = `local-${homedir().replaceAll('\\', '_').replaceAll(':', '_')}`;
    const deps = { db, localUserId: userId, appDataDir: f.appData, interruptTurn: async () => {} };
    const read = async (method: string, params: unknown): Promise<unknown> => {
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `r78-read-${randomUUID()}`, method, params }) as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
      if (!r.ok) throw new Error(`${method}: ${r.error?.code} ${r.error?.message}`);
      return r.data;
    };
    try {
      const tasks = db.prepare('SELECT id, status, revision FROM tasks WHERE id IN (?, ?) ORDER BY id').all(f.roomTaskId, f.dmTaskId) as Array<{ id: string; status: string; revision: number }>;
      expect(tasks).toHaveLength(2);
      expect(tasks.every((t) => t.status === 'DONE' && t.revision >= 4)).toBe(true);
      const deliveries = db.prepare('SELECT task_id, revision, review_status FROM task_deliveries WHERE task_id IN (?, ?) ORDER BY task_id, revision').all(f.roomTaskId, f.dmTaskId) as Array<{ task_id: string; revision: number; review_status: string }>;
      expect(deliveries).toHaveLength(4);
      expect(deliveries.map((d) => d.review_status).sort()).toEqual(['accepted', 'accepted', 'changes_requested', 'changes_requested']);
      for (const name of f.finalFiles) expect(readFileSync(join(f.projectPath, name), 'utf8')).toContain('真实文件');
      for (const deliveryId of [...f.roomDeliveries, ...f.dmDeliveries]) {
        const doc = await read('delivery.document', { deliveryId }) as { hashMatch: boolean; text: string | null };
        expect(doc.hashMatch).toBe(true);
        expect(doc.text).toContain('changeSummary');
      }
      const before = (db.prepare('SELECT count(*) c FROM agent_turns').get() as { c: number }).c;
      const pool = await read('room.pool', { roomId: f.roomId });
      const thread = await read('thread.history', { threadId: f.roomThreadId });
      const dm = await read('conversation.history', { conversationId: f.dmConversationId });
      const board = await read('board.view', { scope: 'project', projectId: f.projectId });
      const roomTask = await read('task.get', { taskId: f.roomTaskId });
      const dmTask = await read('task.get', { taskId: f.dmTaskId });
      const progress = await read('run.progress', { taskId: f.roomTaskId });
      const files = await read('files.view', { scope: 'project', projectId: f.projectId });
      const search = await read('search.query', { text: 'R78 ROOM DIRECT', scope: 'project', projectId: f.projectId });
      const activity = await read('activity.list', { scope: 'project', projectId: f.projectId, limit: 200 });
      expect(JSON.stringify(pool)).toContain(f.roomTaskId);
      expect(JSON.stringify(thread)).toContain('房间返工完成');
      expect(JSON.stringify(dm)).toContain('私信返工完成');
      expect(JSON.stringify(board)).toContain(f.roomTaskId);
      expect(JSON.stringify(roomTask)).toContain('DONE');
      expect(JSON.stringify(dmTask)).toContain('DONE');
      expect(JSON.stringify(progress)).toContain('AUTO');
      expect(JSON.parse((db.prepare('SELECT route_json FROM tasks WHERE id=?').get(f.roomTaskId) as {route_json:string}).route_json).mode).toBe('DIRECT');
      expect(JSON.stringify(files)).toContain(f.roomDeliveries[1]);
      expect(JSON.stringify(files)).toContain(f.dmDeliveries[1]);
      expect(JSON.stringify(search)).toContain(f.roomTaskId);
      expect(JSON.stringify(activity)).toContain(f.roomTaskId);
      expect(JSON.stringify(activity)).toContain(f.dmTaskId);
      const reviewEvents = (activity as {items:Array<{kind:string;taskId:string;locate:string|null}>}).items.filter(e=>e.kind==='task.reviewRecorded');
      expect.soft(reviewEvents.some(e=>e.taskId===f.roomTaskId && e.locate===`#task=${f.roomTaskId}`)).toBe(true);
      expect.soft(reviewEvents.some(e=>e.taskId===f.dmTaskId && e.locate===`#task=${f.dmTaskId}`)).toBe(true);
      await read('thread.subscribe', { threadId: f.roomThreadId, follow: true });
      const favorites = await read('thread.subscriptions', { projectId: f.projectId });
      expect(JSON.stringify(favorites)).toContain(f.roomThreadId);
      const pending = await read('mine.pending', {});
      expect(JSON.stringify(pending)).toContain(f.dmConversationId);
      expect((db.prepare('SELECT count(*) c FROM agent_turns').get() as { c: number }).c).toBe(before);
      expect((db.prepare("SELECT count(*) c FROM workflow_runs WHERE task_id=? AND status='FAILED'").get(f.failedTaskId) as { c: number }).c).toBe(1);
      expect((db.prepare('SELECT count(*) c FROM tasks WHERE conversation_thread_id=?').get(f.recordedThreadId) as { c: number }).c).toBe(0);
      expect((db.prepare('SELECT count(*) c FROM messages WHERE id=?').get(f.unknownReplayMessageId) as { c: number }).c).toBe(1);
      const outsider = { ...deps, localUserId: 'r78-other-viewer' };
      const denied = await dispatchDaemonCommand(outsider, { protocolVersion: 1, commandId: `r78-out-${randomUUID()}`, method: 'task.get', params: { taskId: f.dmTaskId } }) as { ok: boolean; error?: { code: string } };
      expect(denied.ok).toBe(false);
      expect(denied.error?.code).toBe('FORBIDDEN');
      const otherSearch = await dispatchDaemonCommand(outsider, { protocolVersion: 1, commandId: `r78-out-${randomUUID()}`, method: 'search.query', params: { text: 'R78 DM DIRECT', scope: 'project', projectId: f.projectId } }) as { ok: boolean; data?: unknown };
      expect(otherSearch.ok).toBe(true);
      expect(JSON.stringify(otherSearch.data)).not.toContain(f.dmTaskId);
      const otherActivity = await dispatchDaemonCommand(outsider, {protocolVersion:1,commandId:randomUUID(),method:'activity.list',params:{scope:'project',projectId:f.projectId,limit:200}}) as {ok:boolean;data?:unknown};
      expect(otherActivity.ok).toBe(true);expect(JSON.stringify(otherActivity.data)).not.toContain(f.dmTaskId);
    } finally { db.close(); }
  }, 60_000);
});
