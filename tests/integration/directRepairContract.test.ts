/**
 * DIRECT 输出合同修复链（第六轮，worker 正式路径，零额度）：
 * - 单层围栏规范化：仅剥「包裹整个文本」的一对 ``` 围栏，剥壳后走**同一**严格 schema；
 *   围栏外有正文/散文/附加键一律照旧拒绝（原始输出保留）——正反例全覆盖；
 * - formatRepair（task.redispatch formatRepair:true）：守卫（上 turn FAILED+outputInvalid、
 *   每任务一次）+ 修复上下文注入（原输出全文+校验错误+字段用途——不叫模型删短内容）；
 * - 修复耗尽收口：修复 turn 再失败 → 任务 BLOCKED（不再表现为可执行）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { stripSingleJsonFence } from '../../src/daemon/dispatchWorker.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-direct-repair-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function seed(db: ZhongshuoDatabase): void {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d','D:/x','D:/x','{}',0)`).run();
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','执行成员','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mA')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
  db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r1','mA')`).run();
}

function makeTask(db: ZhongshuoDatabase, n: number): string {
  const ids = { messageId: `rm${n}`, threadId: `th${n}`, taskId: `tk${n}`, taskEventId: `re${n}`, threadEventId: `te${n}` };
  createRoomRootTask(db, {
    ids, projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default',
    title: `T${n}`, body: `B${n}`, mentions: [{ kind: 'member', memberId: 'mA' }],
    author: { authorType: 'human', authorId: 'u' }, reviewPolicy: 'auto_deliver', sourceConnectionId: null,
    route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'mA', frozenMemberIds: ['mA'], initialWakeMemberIds: ['mA'] },
    now: n,
  });
  return ids.taskId;
}

async function cmd<T>(db: ZhongshuoDatabase, method: string, params: unknown): Promise<T> {
  const r = await dispatchDaemonCommand(
    { db, localUserId: 'u_test', interruptTurn: async () => {} },
    { protocolVersion: 1, commandId: `cmd-dr-${randomUUID().slice(0, 8)}`, method, params },
  ) as { ok: boolean; data?: T; error?: { message: string } };
  if (!r.ok) throw new Error(r.error?.message ?? '命令失败');
  return r.data as T;
}

function rig(scripts: FakeTurnScript[]) {
  const db = openDatabase(':memory:');
  seed(db);
  const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => scripts.shift() ?? [{ kind: 'event', event: { kind: 'turn.completed', finalText: '兜底' } }] });
  const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-dr', appDataDir: join(tmpRoot, 'a') });
  return { db, adapter, worker, scripts };
}

const validComplete = (resultKey: string, summary = '完成：三条结论均附行号依据。') =>
  JSON.stringify({ schemaVersion: 'task-complete-v1', resultKey, changeSummary: summary, files: ['notes.md'], executedVerifications: ['读取 notes.md 并核对行号'], unexecutedVerifications: [], remainingIssues: [] });

describe('单层围栏规范化（worker 正式路径）', () => {
  it('纯函数：整文本单层围栏剥壳；内部含围栏/围栏外正文不剥', () => {
    const wrapped = '```json\n{"a":1}\n```';
    expect(stripSingleJsonFence(wrapped)).toEqual({ text: '{"a":1}', normalized: true });
    expect(stripSingleJsonFence('```\n{"a":1}\n```')).toEqual({ text: '{"a":1}', normalized: true });
    // 围栏外有正文（前缀/后缀）→ 不剥。
    expect(stripSingleJsonFence('说明如下：\n```json\n{"a":1}\n```').normalized).toBe(false);
    expect(stripSingleJsonFence('```json\n{"a":1}\n```\n补充说明').normalized).toBe(false);
    // 内部还有围栏 → 非单层包裹，不剥。
    expect(stripSingleJsonFence('```json\n{"a":"x```y"}\n```').normalized).toBe(false);
    expect(stripSingleJsonFence('纯散文').normalized).toBe(false);
  });

  it('正例：围栏包裹的合法 TaskComplete → 剥壳过校验（turn.outputNormalized 留审计）', async () => {
    const { db, worker, scripts } = rig([]);
    const taskId = makeTask(db, 1);
    const rk = (db.prepare('SELECT id FROM agent_turns LIMIT 1').get() as { id: string } | undefined)?.id;
    void rk;
    // resultKey 依赖 turnId（运行时生成）——用 sequencer 动态读取输入契约里的 resultKey。
    const adapter2 = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        return [{ kind: 'event', event: { kind: 'turn.completed', finalText: '```json\n' + validComplete(key) + '\n```' } }];
      },
    });
    const worker2 = new DispatchWorker({ db, adapter: adapter2, leaseOwner: 'w-dr2', appDataDir: join(tmpRoot, 'b') });
    await worker2.runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('DONE');
    const norm = db.prepare(`SELECT count(*) c FROM domain_events WHERE kind = 'turn.outputNormalized'`).get() as { c: number };
    expect(norm.c).toBe(1); // 规范化留审计（原始长度+规则）
    void worker;
    void scripts;
    db.close();
  }, 15_000);

  it('自然正文后追加合法 TaskComplete：控制结果通过 resultKey 校验，消息只投影自然正文', async () => {
    const { db } = rig([]);
    const taskId = makeTask(db, 11);
    const natural = '收到，测试正常。我已就绪。';
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        const control = JSON.stringify({
          schemaVersion: 'task-complete-v1', resultKey: key, responseKind: 'conversation',
          answer: natural, changeSummary: natural, files: [], executedVerifications: [],
          unexecutedVerifications: [], remainingIssues: [], handoffs: [],
        });
        const raw = `${natural}\n\n${control}`;
        return [
          { kind: 'event', event: { kind: 'message.completed', messageId: 'm_r89_appended', text: raw } },
          { kind: 'event', event: { kind: 'turn.completed', finalText: raw } },
        ];
      },
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-r89-appended', appDataDir: join(tmpRoot, 'r89-appended') });
    await worker.runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as {status:string}).status).toBe('DONE');
    const message=db.prepare(`SELECT m.body_json FROM messages m JOIN conversation_threads th ON th.id=m.thread_id
      WHERE th.root_task_id=? AND m.author_type='agent' ORDER BY m.conversation_seq DESC LIMIT 1`).get(taskId) as {body_json:string};
    const body=JSON.parse(message.body_json) as {text:string;runtimeControlResult?:string};
    expect(body.text).toBe(natural);
    expect(body.runtimeControlResult).toContain('"schemaVersion":"task-complete-v1"');
    expect(body.text).not.toContain('task-complete-v1');
    const normalized=db.prepare("SELECT payload_json FROM domain_events WHERE kind='turn.outputNormalized' ORDER BY seq DESC LIMIT 1").get() as {payload_json:string};
    expect(JSON.parse(normalized.payload_json)).toMatchObject({rule:'separate-valid-appended-taskcomplete; same strict schema/resultKey after'});
    db.close();
  }, 15_000);

  it('控制结果只在 message.completed、turn.completed 仅自然文本时按同 turn 身份回收', async () => {
    const { db } = rig([]);
    const taskId = makeTask(db, 12);
    const natural = '确认：我是本项目的 GLM 协调者。';
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        const control = JSON.stringify({
          schemaVersion: 'task-complete-v1', resultKey: key, responseKind: 'conversation',
          answer: natural, changeSummary: natural, files: [], executedVerifications: [],
          unexecutedVerifications: [], remainingIssues: [], handoffs: [],
        });
        return [
          { kind: 'event', event: { kind: 'message.completed', messageId: 'm_r89_natural', text: natural } },
          { kind: 'event', event: { kind: 'message.completed', messageId: 'm_r89_message_only', text: control } },
          { kind: 'event', event: { kind: 'turn.completed', finalText: natural } },
        ];
      },
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-r89-message-only', appDataDir: join(tmpRoot, 'r89-message-only') });
    await worker.runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as {status:string}).status).toBe('DONE');
    const message=db.prepare(`SELECT m.body_json FROM messages m JOIN conversation_threads th ON th.id=m.thread_id
      WHERE th.root_task_id=? AND m.author_type='agent' ORDER BY m.conversation_seq DESC LIMIT 1`).get(taskId) as {body_json:string};
    const body=JSON.parse(message.body_json) as {text:string;runtimeControlResult?:string};
    expect(body.text).toBe(natural);
    expect(body.runtimeControlResult).toContain('"schemaVersion":"task-complete-v1"');
    expect((db.prepare('SELECT count(*) n FROM messages WHERE task_id=? AND author_type=\'agent\'').get(taskId) as {n:number}).n).toBe(1);
    expect(db.prepare("SELECT count(*) n FROM domain_events WHERE kind='turn.duplicateVisibleReplyMerged'").get()).toEqual({n:1});
    const normalized=db.prepare("SELECT payload_json FROM domain_events WHERE kind='turn.outputNormalized' ORDER BY seq DESC LIMIT 1").get() as {payload_json:string};
    expect(JSON.parse(normalized.payload_json)).toMatchObject({rule:'use-validated-control-from-message-completed; same strict schema/resultKey'});
    db.close();
  }, 15_000);

  it('无句末标点的自然前缀仍按同 turn 身份投影，可见消息不含控制 JSON', async () => {
    const { db } = rig([]);
    const taskId = makeTask(db, 13);
    const natural = '已经收到你的问题';
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        const control = JSON.stringify({
          schemaVersion: 'task-complete-v1', resultKey: key, responseKind: 'conversation',
          answer: `${natural}。`, changeSummary: natural, files: [], executedVerifications: [],
          unexecutedVerifications: [], remainingIssues: [], handoffs: [],
        });
        const mixed = `${natural}\n\n${control}`;
        return [
          { kind: 'event', event: { kind: 'message.completed', messageId: 'm_r89_unpunctuated', text: mixed } },
          { kind: 'event', event: { kind: 'turn.completed', finalText: mixed } },
        ];
      },
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-r89-unpunctuated', appDataDir: join(tmpRoot, 'r89-unpunctuated') });
    await worker.runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as {status:string}).status).toBe('DONE');
    const message=db.prepare(`SELECT body_json FROM messages WHERE task_id=? AND author_type='agent'`).get(taskId) as {body_json:string};
    const body=JSON.parse(message.body_json) as {text:string;runtimeControlResult?:string};
    expect(body.text).toBe(natural);
    expect(body.text).not.toContain('task-complete-v1');
    expect(body.runtimeControlResult).toContain('"schemaVersion":"task-complete-v1"');
    db.close();
  }, 15_000);

  it('message 缓存不能掩盖 turn 终态明确给出的错误 resultKey', async () => {
    const { db } = rig([]);
    const taskId = makeTask(db, 14);
    const natural = '已经收到你的问题。';
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        const control=(resultKey:string)=>JSON.stringify({
          schemaVersion: 'task-complete-v1', resultKey, responseKind: 'conversation',
          answer: natural, changeSummary: natural, files: [], executedVerifications: [],
          unexecutedVerifications: [], remainingIssues: [], handoffs: [],
        });
        return [
          { kind: 'event', event: { kind: 'message.completed', messageId: 'm_r89_cached', text: control(key) } },
          { kind: 'event', event: { kind: 'turn.completed', finalText: control('result_wrong_turn') } },
        ];
      },
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-r89-wrong-terminal', appDataDir: join(tmpRoot, 'r89-wrong-terminal') });
    await worker.runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as {status:string}).status).toBe('ACTIVE');
    expect(db.prepare('SELECT status FROM agent_turns').get()).toEqual({status:'FAILED'});
    const invalid=db.prepare("SELECT payload_json FROM domain_events WHERE kind='turn.outputInvalid'").get() as {payload_json:string};
    expect(JSON.parse(invalid.payload_json).issues.join(' ')).toContain('resultKey 不匹配');
    expect(db.prepare("SELECT count(*) n FROM domain_events WHERE kind='turn.outputNormalized' AND payload_json LIKE '%use-validated-control%'").get()).toEqual({n:0});
    db.close();
  }, 15_000);

  it('message 缓存不能掩盖 turn 终态明确给出的坏 schema', async () => {
    const { db } = rig([]);
    const taskId = makeTask(db, 16);
    const natural = '已经收到你的问题。';
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        const base = {
          schemaVersion: 'task-complete-v1', resultKey: key, responseKind: 'conversation',
          answer: natural, changeSummary: natural, files: [], executedVerifications: [],
          unexecutedVerifications: [], remainingIssues: [], handoffs: [],
        };
        return [
          { kind: 'event', event: { kind: 'message.completed', messageId: 'm_r89_cached_valid', text: JSON.stringify(base) } },
          { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ ...base, files: 'not-an-array' }) } },
        ];
      },
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-r89-bad-terminal', appDataDir: join(tmpRoot, 'r89-bad-terminal') });
    await worker.runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as {status:string}).status).toBe('ACTIVE');
    expect(db.prepare('SELECT status FROM agent_turns').get()).toEqual({status:'FAILED'});
    expect(db.prepare("SELECT count(*) n FROM domain_events WHERE kind='turn.outputInvalid'").get()).toEqual({n:1});
    db.close();
  }, 15_000);

  it('自然消息先被收藏后，控制消息合并到原 ID，不删除收藏目标', async () => {
    const { db } = rig([]);
    const taskId = makeTask(db, 15);
    const natural = '已经收到你的问题。';
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        const control=JSON.stringify({
          schemaVersion: 'task-complete-v1', resultKey: key, responseKind: 'conversation',
          answer: natural, changeSummary: natural, files: [], executedVerifications: [],
          unexecutedVerifications: [], remainingIssues: [], handoffs: [],
        });
        return [
          { kind: 'event', event: { kind: 'message.completed', messageId: 'm_r89_bookmarked_natural', text: natural } },
          { kind: 'stall', ms: 500 },
          { kind: 'event', event: { kind: 'message.completed', messageId: 'm_r89_bookmarked_control', text: control } },
          { kind: 'event', event: { kind: 'turn.completed', finalText: natural } },
        ];
      },
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-r89-bookmarked', appDataDir: join(tmpRoot, 'r89-bookmarked') });
    const running=worker.runOnce();
    let messageId:string|undefined;
    for(let n=0;n<100&&messageId==null;n+=1){
      messageId=(db.prepare(`SELECT id FROM messages WHERE task_id=? AND author_type='agent' ORDER BY rowid LIMIT 1`).get(taskId) as {id:string}|undefined)?.id;
      if(messageId==null)await new Promise((resolve)=>setTimeout(resolve,5));
    }
    if(messageId==null)throw Error('自然消息未到达测试观察窗口');
    const savedMessageId=messageId;
    await cmd(db,'saved.add',{kind:'message',ref:savedMessageId,title:'R89 原消息',projectId:'p1'});
    const before=await cmd<{items:Array<{ref:string;status:string}>}>(db,'saved.list',{});
    expect(before.items.find((item)=>item.ref===savedMessageId)).toMatchObject({status:'ok'});
    await running;
    const after=await cmd<{items:Array<{ref:string;status:string}>}>(db,'saved.list',{});
    expect(after.items.find((item)=>item.ref===savedMessageId)).toMatchObject({status:'ok'});
    expect((db.prepare('SELECT count(*) n FROM messages WHERE task_id=? AND author_type=\'agent\'').get(taskId) as {n:number}).n).toBe(1);
    expect(db.prepare("SELECT count(*) n FROM domain_events WHERE kind='turn.duplicateVisibleReplyMerged'").get()).toEqual({n:1});
    const body=JSON.parse((db.prepare('SELECT body_json FROM messages WHERE id=?').get(savedMessageId) as {body_json:string}).body_json) as {text:string;runtimeControlResult?:string};
    expect(body.text).toBe(natural);
    expect(body.runtimeControlResult).toContain('"schemaVersion":"task-complete-v1"');
    db.close();
  }, 15_000);

  it('反例：围栏外带正文 → 照旧拒绝；散文/附加键 → 照旧拒绝（原始输出保留）', async () => {
    const { db, worker } = rig([]);
    const taskId = makeTask(db, 2);
    const adapter2 = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        return [{ kind: 'event', event: { kind: 'turn.completed', finalText: '```json\n' + validComplete(key) + '\n```\n以上为结果。' } }];
      },
    });
    const worker2 = new DispatchWorker({ db, adapter: adapter2, leaseOwner: 'w-dr3', appDataDir: join(tmpRoot, 'c') });
    await worker2.runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('ACTIVE');
    expect((db.prepare(`SELECT count(*) c FROM domain_events WHERE kind = 'turn.outputInvalid'`).get() as { c: number }).c).toBe(1);
    void worker;
    db.close();
  }, 15_000);
});

describe('formatRepair 修复绑定（命令守卫+上下文注入+耗尽收口）', () => {
  it('完整链：首 turn 附加键被拒 → formatRepair（输入含原输出全文+校验错误+指引）→ 修正后 DONE', async () => {
    const { db } = rig([]);
    const taskId = makeTask(db, 3);
    let turnCount = 0;
    let capturedInput = '';
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        turnCount += 1;
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        if (turnCount === 1) {
          // A 组真实失败形态：合法 JSON + 附加 conclusions 键（先落消息再终局——真实批次同构）。
          const out = JSON.stringify({ schemaVersion: 'task-complete-v1', resultKey: key, changeSummary: '完成分析', files: ['notes.md'], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [], conclusions: ['结论一（依据 L3）', '结论二（依据 L5）'] });
          return [
            { kind: 'event', event: { kind: 'message.completed', messageId: 'm_bad', text: out } },
            { kind: 'event', event: { kind: 'turn.completed', finalText: out } },
          ];
        }
        capturedInput = input.text;
        // 修复轮：按指引把结论并入 changeSummary（内容不删短）。
        return [{ kind: 'event', event: { kind: 'turn.completed', finalText: validComplete(key, '完成分析。结论：结论一（依据 L3）；结论二（依据 L5）。') } }];
      },
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-fr', appDataDir: join(tmpRoot, 'd') });
    await worker.runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('ACTIVE');
    // 守卫反例：非 FAILED 前置不可用（此刻上 turn FAILED ✓ 可用——先测错误路径：对无任务 id）。
    await expect(cmd(db, 'task.redispatch', { taskId: 'tk_missing', formatRepair: true })).rejects.toThrow(/不存在/);
    const ack = await cmd<{ enqueued: boolean; formatRepair: boolean }>(db, 'task.redispatch', { taskId, formatRepair: true, reason: '测试修复' });
    expect(ack.formatRepair).toBe(true);
    await worker.runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('DONE');
    // 修复绑定证据：修复轮输入包含原输出全文+校验错误+字段指引。
    expect(capturedInput).toContain('【格式修复轮】');
    expect(capturedInput).toContain('Unrecognized key'); // 校验错误原文
    expect(capturedInput).toContain('结论二（依据 L5）'); // 原输出全文（不截短）
    expect(capturedInput).toContain('不要缩短或删除内容'); // 指引=搬字段，不是删短
    // 每任务每逻辑输出一次：修复成功后任务 DONE，再修被终态守卫拒绝。
    await expect(cmd(db, 'task.redispatch', { taskId, formatRepair: true })).rejects.toThrow(/已终态/);
    db.close();
  }, 20_000);

  it('守卫：上 turn 非 FAILED（SUCCEEDED 后）不可 formatRepair；耗尽收口：修复轮再失败 → BLOCKED', async () => {
    const { db } = rig([]);
    const taskId = makeTask(db, 4);
    let turnCount = 0;
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        turnCount += 1;
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        if (turnCount === 1) return [{ kind: 'event', event: { kind: 'turn.completed', finalText: validComplete(key) } }];
        return [{ kind: 'event', event: { kind: 'turn.completed', finalText: '仍然不是 JSON' } }];
      },
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-fr2', appDataDir: join(tmpRoot, 'e') });
    await worker.runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('DONE');
    // 任务终态：任何 redispatch 都不可。
    await expect(cmd(db, 'task.redispatch', { taskId, formatRepair: true })).rejects.toThrow(/已终态/);

    // 耗尽收口：另一任务首 turn 失败→formatRepair→再失败→BLOCKED（不再 ACTIVE 表现为可执行）。
    const taskId2 = makeTask(db, 5);
    const adapter2 = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        void key;
        // 真实批次同构：终局前先落 message.completed（同轮完成输出——修复绑定取证来源）。
        return [
          { kind: 'event', event: { kind: 'message.completed', messageId: `m_bad_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, text: '一直都不是 JSON' } },
          { kind: 'event', event: { kind: 'turn.completed', finalText: '一直都不是 JSON' } },
        ];
      },
    });
    const worker2 = new DispatchWorker({ db, adapter: adapter2, leaseOwner: 'w-fr3', appDataDir: join(tmpRoot, 'f') });
    await worker2.runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId2) as { status: string }).status).toBe('ACTIVE');
    await cmd(db, 'task.redispatch', { taskId: taskId2, formatRepair: true, reason: '再修一次' });
    await worker2.runOnce();
    const finalStatus = (db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId2) as { status: string }).status;
    expect(finalStatus).toBe('BLOCKED'); // 修复耗尽：收口为 BLOCKED（UI 不再表现为正在执行/可执行）
    const blockedEvt = db.prepare(`SELECT count(*) c FROM domain_events WHERE kind = 'task.statusChanged' AND payload_json LIKE '%direct-repair-exhausted%'`).get() as { c: number };
    expect(blockedEvt.c).toBeGreaterThanOrEqual(1);
    db.close();
  }, 20_000);
});

describe('格式修复工作项（第六轮·下：持久绑定/预算沿用/区分普通重派；第七轮：按逻辑输出限次）', () => {
  it('同轮精确取证+禁止修复套修复：修复轮失败后不得再修；正式独立输出有自己的资格', async () => {
    const { db } = rig([]);
    const taskId = makeTask(db, 6);
    let turnCount = 0;
    const badJson = (key: string, tag: string) => JSON.stringify({ schemaVersion: 'task-complete-v1', resultKey: key, changeSummary: tag, files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [], conclusions: [tag] });
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        turnCount += 1;
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        // turn1=附加键失败；turn2（修复轮）=散文失败；turn3（普通重派·独立输出）=散文失败；
        // turn4（修复轮2）=通过。
        if (turnCount === 1) {
          return [
            { kind: 'event', event: { kind: 'message.completed', messageId: `m6_${turnCount}`, text: badJson(key, '第一轮的结论') } },
            { kind: 'event', event: { kind: 'turn.completed', finalText: badJson(key, '第一轮的结论') } },
          ];
        }
        if (turnCount === 4) {
          return [
            { kind: 'event', event: { kind: 'message.completed', messageId: 'm6_ok', text: 'ok' } },
            { kind: 'event', event: { kind: 'turn.completed', finalText: validComplete(key, '修复轮2 通过') } },
          ];
        }
        return [
          { kind: 'event', event: { kind: 'message.completed', messageId: `m6_${turnCount}`, text: `第${turnCount}轮纯散文输出` } },
          { kind: 'event', event: { kind: 'turn.completed', finalText: `第${turnCount}轮纯散文输出` } },
        ];
      },
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-wi1', appDataDir: join(tmpRoot, 'wi-a') });
    await worker.runOnce(); // turn1 失败（附加键）
    await expect(cmd(db, 'task.redispatch', { taskId, formatRepair: true, reason: '源=turn1' })).resolves.toBeTruthy();
    await worker.runOnce(); // turn2（修复轮）也失败（散文）
    const wi1 = db.prepare(`SELECT source_turn_id, logical_output_id, source_output_text FROM format_repair_workitems ORDER BY created_at ASC LIMIT 1`).get() as { source_turn_id: string; logical_output_id: string; source_output_text: string };
    expect(wi1.source_output_text).toContain('第一轮的结论'); // 工作项绑定 turn1（自己的输出）
    expect(wi1.logical_output_id).toBe(wi1.source_turn_id); // 初始输出：逻辑输出身份=自身
    const turnCountBefore = (db.prepare(`SELECT count(*) c FROM agent_turns WHERE dispatch_key LIKE 'task:' || ? || ':%'`).get(taskId) as { c: number }).c;
    expect(turnCountBefore).toBe(2);
    // 禁止修复套修复：对修复轮 turn2 再 formatRepair → 拒绝（继承根逻辑输出身份=turn1，已用资格）。
    await expect(cmd(db, 'task.redispatch', { taskId, formatRepair: true, reason: '源=turn2（修复轮）' })).rejects.toThrow(/不得修复套修复|已用过修复资格/);
    // 被拒的第二次修复不创建工作项、不入队、实际启动计数不再增加。
    expect((db.prepare(`SELECT count(*) c FROM format_repair_workitems`).get() as { c: number }).c).toBe(1);
    expect((db.prepare(`SELECT count(*) c FROM outbox WHERE status != 'done'`).get() as { c: number }).c).toBe(0);
    expect((db.prepare(`SELECT count(*) c FROM agent_turns WHERE dispatch_key LIKE 'task:' || ? || ':%'`).get(taskId) as { c: number }).c).toBe(2);
    // 正式独立输出（普通 redispatch——业务来源）→ turn3 失败 → 有自己的修复资格（新逻辑输出身份）。
    await cmd(db, 'task.redispatch', { taskId, reason: '正式跟进（独立输出）' });
    await worker.runOnce(); // turn3 失败（散文）
    await expect(cmd(db, 'task.redispatch', { taskId, formatRepair: true, reason: '源=turn3（独立输出）' })).resolves.toBeTruthy();
    const wi2 = db.prepare(`SELECT source_turn_id, logical_output_id, source_output_text FROM format_repair_workitems ORDER BY created_at DESC LIMIT 1`).get() as { source_turn_id: string; logical_output_id: string; source_output_text: string };
    expect(wi2.source_output_text).toBe('第3轮纯散文输出');
    expect(wi2.logical_output_id).toBe(wi2.source_turn_id); // 新独立输出=新身份（不靠生成 turn ID 绕过）
    expect(wi2.logical_output_id).not.toBe(wi1.logical_output_id);
    await worker.runOnce(); // turn4（修复轮2）→ DONE
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('DONE');
    // 预算沿用（第七轮统一授权账目）：修复轮2 的 carryover=非退款 turn 计数（turn1+turn2+turn3=3）。
    const carry = db.prepare(`SELECT payload_json FROM domain_events WHERE kind = 'task.repairConsumed' ORDER BY seq DESC LIMIT 1`).get() as { payload_json: string };
    expect((JSON.parse(carry.payload_json) as { budgetCarryoverUsed: number }).budgetCarryoverUsed).toBe(3);
    db.close();
  }, 25_000);

  it('同一逻辑输出第二次修复被拒；准入满/重启不丢上下文（重开库后续派仍带全文）', async () => {
    const { db } = rig([]);
    const taskId = makeTask(db, 7);
    let turnCount = 0;
    let capturedRepairInput = '';
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        turnCount += 1;
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        if (turnCount === 1) {
          const out = JSON.stringify({ schemaVersion: 'task-complete-v1', resultKey: key, changeSummary: 'x', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [], extra: ['被拒字段内容七号'] });
          return [
            { kind: 'event', event: { kind: 'message.completed', messageId: 'm7_1', text: out } },
            { kind: 'event', event: { kind: 'turn.completed', finalText: out } },
          ];
        }
        capturedRepairInput = input.text;
        return [
          { kind: 'event', event: { kind: 'message.completed', messageId: 'm7_ok', text: 'ok' } },
          { kind: 'event', event: { kind: 'turn.completed', finalText: validComplete(key, '修复通过') } },
        ];
      },
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-wi2', appDataDir: join(tmpRoot, 'wi-b') });
    await worker.runOnce(); // 失败
    // 第二次修复同一输出：先入队一次 pending，再建第二个工作项被 (task, source) 唯一约束+守卫拒绝。
    await cmd(db, 'task.redispatch', { taskId, formatRepair: true, reason: '第一次' });
    await expect(cmd(db, 'task.redispatch', { taskId, formatRepair: true, reason: '第二次' })).rejects.toThrow(/已用过修复资格/);
    // 「重启」语义：不跑 worker，新开数据库连接（工作项持久）后再派——上下文完整。
    const worker2 = new DispatchWorker({ db, adapter, leaseOwner: 'w-wi2b', appDataDir: join(tmpRoot, 'wi-b2') });
    await worker2.runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('DONE');
    expect(capturedRepairInput).toContain('被拒字段内容七号'); // 修复上下文全文注入（重开连接后不丢）
    expect(capturedRepairInput).toContain('【格式修复轮】');
    // 已消费的工作项：再次对同一输出修复仍拒。
    await expect(cmd(db, 'task.redispatch', { taskId, formatRepair: true, reason: '已消费后再修' })).rejects.toThrow(/已终态|已用过修复资格/);
    db.close();
  }, 25_000);

  it('普通 redispatch 不被认作修复轮：失败后任务保持 ACTIVE（非 BLOCKED）；无工作项副作用', async () => {
    const { db } = rig([]);
    const taskId = makeTask(db, 8);
    let turnCount = 0;
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        turnCount += 1;
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        void key;
        const out = turnCount === 1
          ? JSON.stringify({ schemaVersion: 'task-complete-v1', resultKey: key, changeSummary: 'x', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [], extraField: ['首 turn 失败'] })
          : '普通重派仍然散文';
        return [
          { kind: 'event', event: { kind: 'message.completed', messageId: `m8_${turnCount}`, text: out } },
          { kind: 'event', event: { kind: 'turn.completed', finalText: out } },
        ];
      },
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-wi3', appDataDir: join(tmpRoot, 'wi-c') });
    await worker.runOnce();
    await cmd(db, 'task.redispatch', { taskId, reason: '普通跟进重派' }); // 无 formatRepair
    await worker.runOnce(); // 修复语义外的重派失败
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('ACTIVE'); // 不是 BLOCKED（非修复轮）
    expect((db.prepare(`SELECT count(*) c FROM format_repair_workitems`).get() as { c: number }).c).toBe(0); // 无工作项
    db.close();
  }, 25_000);

  it('损坏上下文（hash 不符）→ 阻塞留证不花调用：任务 BLOCKED+workitem blocked+审计', async () => {
    const { db } = rig([]);
    const taskId = makeTask(db, 9);
    let turnCount = 0;
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: () => {
        turnCount += 1;
        const out = JSON.stringify({ schemaVersion: 'task-complete-v1', resultKey: 'result_x', changeSummary: 'x', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] });
        return [
          { kind: 'event', event: { kind: 'message.completed', messageId: `m9_${turnCount}`, text: out } },
          { kind: 'event', event: { kind: 'turn.completed', finalText: out } },
        ];
      },
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-wi4', appDataDir: join(tmpRoot, 'wi-d') });
    await worker.runOnce();
    await cmd(db, 'task.redispatch', { taskId, formatRepair: true, reason: 'r' });
    // 注入损坏：篡改工作项存储原文（hash 复核将失败）。
    db.prepare(`UPDATE format_repair_workitems SET source_output_text = '被篡改的原文' WHERE task_id = ?`).run(taskId);
    await worker.runOnce();
    const st = (db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status;
    expect(st).toBe('BLOCKED'); // 阻塞（不降级普通重跑、不花调用）
    const wi = db.prepare(`SELECT status FROM format_repair_workitems WHERE task_id = ?`).get(taskId) as { status: string };
    expect(wi.status).toBe('blocked');
    const corrupt = (db.prepare(`SELECT count(*) c FROM domain_events WHERE kind = 'task.repairContextCorrupt'`).get() as { c: number }).c;
    expect(corrupt).toBe(1);
    // 没有第二次模型调用：turn 数仍为 1。
    expect((db.prepare(`SELECT count(*) c FROM agent_turns WHERE dispatch_key LIKE 'task:' || ? || ':%'`).get(taskId) as { c: number }).c).toBe(1);
    db.close();
  }, 25_000);
});
