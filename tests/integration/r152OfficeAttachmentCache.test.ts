import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { disposeParsePool, getParsePool } from '../../src/daemon/parsePool.ts';
import { ARTIFACT_PARSE_KINDS, validateExtractCache } from '../../src/daemon/parseContracts.ts';
import { assembleDirectTurn, assembleDirectTurnWithAttachmentCache, type AssembledTurnInput } from '../../src/daemon/turnInput.ts';
import { makeAsciiPdf, makeDocx, makePptx, makeXlsx } from '../../scripts/lib/craftDocuments.mjs';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await disposeParsePool();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const done = (answer: string, extra: Record<string, unknown> = {}): FakeTurnScript => [{ kind: 'event', event: {
  kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: 'task-complete-v1', resultKey: 'fixture', responseKind: 'work',
    answer, changeSummary: answer, files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [], ...extra }),
} }];

type Artifact = { id: string; source_name: string; kind: string; hash: string; blob_path: string; revision: number; extracted_text_json: string | null };

/** Formal planning -> implementation child -> generated delivery -> all other peers -> integration. */
async function fixture(options: { invalidDocx?: boolean; csv?: boolean } = {}) {
  vi.stubEnv('ZS_ALLOW_FAKE', '1');
  vi.stubEnv('ZS_RUNTIME', 'fake');
  const root = mkdtempSync(join(tmpdir(), 'zs-r152-cache-'));
  roots.push(root);
  const project = join(root, 'project');
  mkdirSync(project);
  const db = openDatabase(join(root, 'state.sqlite'));
  const cmd = async <T>(method: string, params: unknown): Promise<T> => {
    const result = await dispatchDaemonCommand({ db, localUserId: 'u_local', appDataDir: root, interruptTurn: async () => {} },
      { protocolVersion: 1, commandId: randomUUID(), method, params }) as { ok: boolean; data: T; error?: unknown };
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    return result.data;
  };
  const projectId = (await cmd<{ project: { id: string } }>('project.open', { path: project })).project.id;
  const room = (await cmd<{ items: { id: string; conversationId: string; revision: number }[] }>('room.list', { projectId })).items[0]!;
  const members: string[] = [];
  for (const displayName of ['协调者', '复核甲', '复核乙', '复核丙']) {
    const { memberId } = await cmd<{ memberId: string }>('member.create', { projectId, displayName });
    members.push(memberId);
    await cmd('member.setRuntime', { memberId, kind: 'fake', permissionMode: 'bypassPermissions' });
  }
  const a = members[0]!;
  const revision = (db.prepare('SELECT revision FROM rooms WHERE id=?').get(room.id) as { revision: number }).revision;
  await cmd('room.update', { roomId: room.id, expectedRevision: revision, coordinatorMemberId: a });
  const roomMembers = await cmd<{ items: { id: string }[] }>('member.list', { projectId, roomId: room.id });
  for (const member of roomMembers.items) if (!members.includes(member.id)) await cmd('room.members.set', { roomId: room.id, memberId: member.id, action: 'remove' });
  const files = new Map<string, Buffer>([
    ['测试文档.docx', options.invalidDocx ? Buffer.from('broken Office bytes') : makeDocx({ paras: ['R152_DOCX_BODY', '末尾正文'] })],
    ['测试文档.pdf', makeAsciiPdf([['R152_PDF_BODY']])],
    ['测试表格.xlsx', makeXlsx([{ name: '核对', rows: [['R152_XLSX_BODY', 42]] }])],
    ['测试演示.pptx', makePptx([{ texts: ['R152_PPTX_BODY'], notes: 'R152_NOTES_BODY' }])],
    ...(options.csv ? [['测试表格.csv', Buffer.from('名称,数值\nR152_CSV_BODY,7')] as [string, Buffer]] : []),
  ]);
  const artifacts = () => db.prepare("SELECT id,source_name,kind,hash,blob_path,revision,extracted_text_json FROM artifacts WHERE id LIKE 'art_gf_%' ORDER BY source_name").all() as Artifact[];
  const peerInputs: string[] = [];
  const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: ({ text }) => {
    const turnId = /\bturn=([^\s]+)/.exec(text)?.[1];
    const turn = db.prepare(`SELECT a.run_id,t.owner_member_id FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id
      JOIN tasks t ON t.id=r.task_id WHERE a.id=?`).get(turnId) as { run_id: string; owner_member_id: string };
    if (db.prepare('SELECT 1 FROM coordination_runs WHERE run_id=?').get(turn.run_id)) {
      expect(artifacts()).toHaveLength(0);
      return done('安排实施后交给其他所有成员核对', { coordinationPlan: { summary: '生成并复核四种文件', steps: [
        { key: 'generate', memberId: a, title: '生成文件', objective: '生成测试文件，并交给其他所有成员复核', role: 'implementation', dependsOn: [] },
      ] } });
    }
    if (db.prepare('SELECT 1 FROM coordination_runs WHERE integration_run_id=?').get(turn.run_id)) return done('所有成员已收到并核对真实文件内容');
    if (turn.owner_member_id === a) {
      for (const [name, bytes] of files) writeFileSync(join(project, name), bytes);
      return done('测试文件已生成，请其他所有成员核对', { files: [...files.keys()], handoffs: members.slice(1).map(toMemberId => ({
        toMemberId, purpose: 'review', message: '请阅读本次交付的测试文档、表格、演示和 PDF，核对正文与备注。',
      })) });
    }
    for (const token of ['R152_DOCX_BODY', 'R152_PDF_BODY', 'R152_XLSX_BODY', 'R152_PPTX_BODY', 'R152_NOTES_BODY', ...(options.csv ? ['R152_CSV_BODY'] : [])]) expect(text).toContain(token);
    for (const row of artifacts()) expect(validateExtractCache(row.extracted_text_json, row.hash, ARTIFACT_PARSE_KINDS[row.kind]!.cache)).not.toBeNull();
    expect(text).not.toContain(join(root, 'blobstore'));
    peerInputs.push(text);
    return done('已从本轮附件材料核对正文');
  } });
  const worker = new DispatchWorker({ db, adapter, leaseOwner: 'r152-cache', appDataDir: root });
  const sent = await cmd<{ taskId: string; threadId: string }>('message.submit', {
    target: { kind: 'room_root', projectId, roomId: room.id, conversationId: room.conversationId },
    body: '请协调者先生成 docx/pdf/xlsx/pptx 测试文件作为正式交付，再转交其他所有成员核对内容。', intent: 'default',
    mentions: [{ kind: 'member', memberId: a }],
  });
  const task = db.prepare('SELECT root_message_id,revision FROM tasks WHERE id=?').get(sent.taskId) as { root_message_id: string; revision: number };
  const assemblyInput: AssembledTurnInput = {
    db, blobRoot: join(root, 'blobstore'), skipFileDiscovery: true, turnId: 'turn_r152_sync',
    task: { id: sent.taskId, projectId, conversationId: room.conversationId, conversationKind: 'room', roomId: room.id,
      threadId: sent.threadId, rootMessageId: task.root_message_id, title: '测试', objective: null, taskRevision: task.revision },
    identity: { member: { id: a, displayName: '协调者' }, project: { id: projectId, displayName: '项目' }, room: { id: room.id, name: '大厅' } },
    budget: { grantId: 'r152', maxTurns: 10, usedTurns: 0, inFlightReservedTurns: 1 },
  };
  const ready = assembleDirectTurnWithAttachmentCache(assemblyInput);
  expect(ready).not.toBeInstanceOf(Promise);
  if (!(ready instanceof Promise)) expect(ready.ok).toBe(true);
  await worker.runOnce(); // Read-only planner, no generated files yet.
  await worker.runOnce(); // Implementation child generates a formal delivery and handoffs.
  const generated = artifacts();
  expect(generated).toHaveLength(files.size);
  expect(generated.every(row => row.extracted_text_json == null)).toBe(true);
  expect(db.prepare("SELECT count(*) n FROM coordination_messages WHERE purpose='review'").get()).toEqual({ n: 3 });
  expect(db.prepare('SELECT count(*) n FROM task_deliveries').get()).toEqual({ n: 1 });
  return { root, project, projectId, room, members, db, cmd, files, artifacts, peerInputs, adapter, worker, sent, assemblyInput };
}

describe('R152 generated Office attachment cache before peer turns', () => {
  it('creates durable caches without preview and reuses verified content for every peer', async () => {
    const f = await fixture();
    try {
      // Reproduce the screenshot's exact failure with the previous synchronous
      // path, using artifacts created by the real worker's formal delivery.
      const cold = assembleDirectTurn(f.assemblyInput);
      expect(cold.ok).toBe(false);
      if (!cold.ok) {
        expect(cold.error.message).toContain('提取缓存缺失/无效（测试文档.docx）');
      }
      for (const row of f.artifacts()) {
        const bytes = f.files.get(row.source_name)!;
        expect(readFileSync(row.blob_path)).toEqual(bytes);
        expect(row.hash).toBe(createHash('sha256').update(bytes).digest('hex'));
      }
      const other = await f.cmd<{ attachmentId: string }>('attachment.uploadOffice', {
        conversationId: f.room.conversationId, filename: '其他对话.docx',
        contentBase64: makeDocx({ paras: ['OTHER_THREAD_DO_NOT_READ'] }).toString('base64'),
      });
      await f.cmd('message.submit', { target: { kind: 'room_root', projectId: f.projectId, roomId: f.room.id, conversationId: f.room.conversationId },
        body: '仅记录在另一对话串', intent: 'record_only', mentions: [], attachmentRefs: [other.attachmentId] });
      f.db.prepare('UPDATE artifacts SET extracted_text_json=NULL WHERE id=?').run(other.attachmentId);
      const before = getParsePool().stats().completed;
      await f.worker.runOnce();
      expect(f.peerInputs, JSON.stringify(f.db.prepare('SELECT kind,payload_json FROM domain_events ORDER BY rowid DESC LIMIT 7').all())).toHaveLength(1);
      expect(getParsePool().stats().completed).toBe(before + 4);
      const saved = f.artifacts().map(row => row.extracted_text_json);
      const ready = assembleDirectTurnWithAttachmentCache(f.assemblyInput);
      expect(ready).not.toBeInstanceOf(Promise);
      if (!(ready instanceof Promise)) expect(ready.ok).toBe(true);
      for (let i = 0; i < 6 && await f.worker.runOnce(); i++) { /* bounded fake coordination */ }
      expect(f.peerInputs).toHaveLength(3);
      expect(f.peerInputs.join('\n')).not.toContain('OTHER_THREAD_DO_NOT_READ');
      expect(f.db.prepare('SELECT extracted_text_json FROM artifacts WHERE id=?').get(other.attachmentId)).toEqual({ extracted_text_json: null });
      expect(getParsePool().stats().completed).toBe(before + 4);
      expect(f.artifacts().map(row => row.extracted_text_json)).toEqual(saved);
      expect(f.db.prepare('SELECT state FROM coordination_runs WHERE task_id=?').get(f.sent.taskId)).toEqual({ state: 'completed' });
      expect(f.db.prepare("SELECT count(*) n FROM coordination_messages WHERE status='completed'").get()).toEqual({ n: 3 });
      expect(f.adapter.startTurnLog).toHaveLength(6);
    } finally { await f.adapter.closeAllSessions(); f.db.close(); }
  }, 90_000);

  it('regenerates malformed/hash-invalid caches from the relocated current store and chooses the CSV parser', async () => {
    const f = await fixture({ csv: true });
    try {
      for (const row of f.artifacts()) f.db.prepare('UPDATE artifacts SET blob_path=?,extracted_text_json=? WHERE id=?')
        .run(join(f.root, 'old-data', 'blobstore', `${row.hash}.bin`), row.kind === 'docx_file' ? '{broken' : JSON.stringify({ cacheSchema: 2, sourceHash: 'wrong', text: 'FORGED_BODY' }), row.id);
      await f.worker.runOnce();
      expect(f.peerInputs).toHaveLength(1);
      expect(f.peerInputs[0]).not.toContain('FORGED_BODY');
      for (const row of f.artifacts()) expect(row.extracted_text_json).toContain(row.hash);
    } finally { await f.adapter.closeAllSessions(); f.db.close(); }
  }, 90_000);

  it.each(['broken-parser', 'corrupt-blob', 'outside-store', 'timeout', 'changed-revision', 'changed-scope', 'invalid-parser-cache'] as const)(
    'blocks the receiving worker honestly for %s and never injects unread documents', async variant => {
      const f = await fixture({ invalidDocx: variant === 'broken-parser' });
      try {
        const first = f.db.prepare(`SELECT a.id,a.source_name,a.kind,a.hash,a.blob_path,a.revision,a.extracted_text_json
          FROM artifacts a JOIN message_attachments ma ON ma.artifact_id=a.id WHERE a.id LIKE 'art_gf_%' ORDER BY ma.rowid LIMIT 1`).get() as Artifact;
        expect(first.source_name).toBe('测试文档.docx');
        const pool = getParsePool(), before = pool.stats().completed;
        if (variant === 'corrupt-blob') writeFileSync(first.blob_path, 'tampered bytes');
        if (variant === 'outside-store') f.db.prepare('UPDATE artifacts SET blob_path=? WHERE id=?').run(join(f.project, 'test.bin'), first.id);
        if (variant === 'timeout') vi.spyOn(pool, 'run').mockResolvedValueOnce({ ok: false, error: { code: 'docx-timeout', message: '解析端到端超时' } });
        if (variant === 'invalid-parser-cache') vi.spyOn(pool, 'run').mockResolvedValueOnce({ ok: true, result: {
          cacheSchema: 2, kind: 'docx', sourceHash: first.hash, parserName: 'fake', parserVersion: 'invalid', extractedAt: 0,
          budgets: {}, totalTextBytes: 0, truncatedTotal: false, text: 'FORGED_BODY', html: '', htmlTruncated: false, paragraphCount: 0,
        } });
        if (variant === 'changed-revision' || variant === 'changed-scope') {
          const original = pool.run.bind(pool);
          vi.spyOn(pool, 'run').mockImplementationOnce(async (...args) => {
            const parsed = await original(...args);
            if (variant === 'changed-revision') f.db.prepare('UPDATE artifacts SET revision=revision+1 WHERE id=?').run(first.id);
            else f.db.prepare('DELETE FROM message_attachments WHERE artifact_id=?').run(first.id);
            return parsed;
          });
        }
        await f.worker.runOnce();
        expect(f.peerInputs).toHaveLength(0);
        expect(f.adapter.startTurnLog).toHaveLength(2);
        expect((f.db.prepare('SELECT extracted_text_json FROM artifacts WHERE id=?').get(first.id) as Artifact).extracted_text_json).toBeNull();
        const failure = f.db.prepare("SELECT payload_json FROM domain_events WHERE kind='turn.preparationFailed' ORDER BY rowid DESC LIMIT 1").get() as { payload_json: string } | undefined;
        // Worker audit must include the filename and a recoverable, truthful reason.
        const errors = f.db.prepare("SELECT payload_json FROM domain_events WHERE kind LIKE '%Failed%' OR kind LIKE '%failed%' ORDER BY rowid DESC").all() as { payload_json: string }[];
        const message = failure?.payload_json ?? errors.map(row => row.payload_json).join('\n');
        expect(message).toContain('测试文档.docx');
        expect(message).toMatch(/重试|重新导出/);
        if (variant === 'timeout') expect(message).toContain('docx-timeout');
        if (variant === 'corrupt-blob' || variant === 'outside-store') expect(pool.stats().completed).toBe(before);
      } finally { await f.adapter.closeAllSessions(); f.db.close(); }
    }, 90_000,
  );
});
