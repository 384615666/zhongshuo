import { afterAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { persistDetailMarkdown } from '../../src/daemon/detailMarkdownAttachments.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { TASK_COMPLETE_SCHEMA_VERSION, renderTurnBundle, type TurnBundleEnvelope } from '../../src/contracts/prompts.ts';

afterAll(() => vi.unstubAllEnvs());
const roots: string[] = [];
const dbs: ZhongshuoDatabase[] = [];
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

function finalScript(input: string, answer: string, detailMarkdown?: string): FakeTurnScript {
  const resultKey = /resultKey=([^；\n]+)/.exec(input)?.[1] ?? /"resultKey":"(result_[^"]+)"/.exec(input)?.[1];
  if (!resultKey) throw new Error('R93 fixture could not resolve resultKey');
  return [{
    kind: 'event',
    event: {
      kind: 'turn.completed',
      finalText: JSON.stringify({
        schemaVersion: TASK_COMPLETE_SCHEMA_VERSION,
        resultKey,
        responseKind: 'work',
        answer,
        ...(detailMarkdown == null ? {} : { detailMarkdown }),
        changeSummary: answer,
        files: [],
        executedVerifications: [],
        unexecutedVerifications: [],
        remainingIssues: [],
      }),
    },
  }];
}

function finalDocumentScript(input: string, answer: string, document: { filename: string; purpose: string; markdown: string } | null): FakeTurnScript {
  const resultKey = /resultKey=([^；\n]+)/.exec(input)?.[1] ?? /"resultKey":"(result_[^"]+)"/.exec(input)?.[1];
  if (!resultKey) throw new Error('R96 fixture could not resolve resultKey');
  return [{
    kind: 'event',
    event: {
      kind: 'turn.completed',
      finalText: JSON.stringify({
        schemaVersion: TASK_COMPLETE_SCHEMA_VERSION,
        resultKey,
        responseKind: 'work',
        answer,
        document,
        changeSummary: answer,
        files: [],
        executedVerifications: [],
        unexecutedVerifications: [],
        remainingIssues: [],
      }),
    },
  }];
}

interface Fixture {
  dir: string;
  db: ZhongshuoDatabase;
  projectId: string;
  roomId: string;
  conversationId: string;
  memberId: string;
  cmd: <T>(method: string, params: unknown) => Promise<T>;
  setInterruptTurn: (fn: (turnId: string) => Promise<void>) => void;
  close: () => void;
}

async function fixture(): Promise<Fixture> {
  vi.stubEnv('ZS_ALLOW_FAKE', '1');
  vi.stubEnv('ZS_RUNTIME', 'fake');
  const dir = mkdtempSync(join(tmpdir(), 'zs-r93-detail-'));
  roots.push(dir);
  const project = join(dir, 'project');
  mkdirSync(project, { recursive: true });
  const db = openDatabase(join(dir, 'state.sqlite'));
  dbs.push(db);
  let interruptTurn: (turnId: string) => Promise<void> = async () => {};
  const deps = { db, localUserId: 'u_local', appDataDir: dir, interruptTurn: (turnId: string) => interruptTurn(turnId) };
  const attempt = async <T>(method: string, params: unknown) => {
    const result = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `r93-${randomUUID()}`, method, params }) as {
      ok: boolean; data?: T; error?: { code: string; message: string };
    };
    if (!result.ok) throw new Error(`${method}: ${JSON.stringify(result.error)}`);
    return result.data as T;
  };
  const projectId = (await attempt<{ project: { id: string } }>('project.open', { path: project })).project.id;
  const room = (await attempt<{ items: Array<{ id: string; conversationId: string }> }>('room.list', { projectId })).items[0]!;
  const memberId = (await attempt<{ memberId: string }>('member.create', { projectId, displayName: 'R93-合成成员' })).memberId;
  await attempt('member.setRuntime', { memberId, kind: 'fake', permissionMode: 'bypassPermissions' });
  return {
    dir, db, projectId, roomId: room.id, conversationId: room.conversationId, memberId, cmd: attempt,
    setInterruptTurn: (fn) => { interruptTurn = fn; },
    close: () => { try { db.close(); } catch { /* already closed */ } },
  };
}

async function submitRoom(f: Fixture, body: string) {
  return f.cmd<{ taskId: string; threadId: string; messageId: string }>('message.submit', {
    target: { kind: 'room_root', projectId: f.projectId, roomId: f.roomId, conversationId: f.conversationId },
    body,
    intent: 'default',
    mentions: [{ kind: 'member', memberId: f.memberId }],
  });
}

async function submitThread(f: Fixture, threadId: string, body: string, replyToMessageId?: string) {
  return f.cmd<{ taskId: string }>('message.submit', {
    target: {
      kind: 'thread', projectId: f.projectId, conversationId: f.conversationId, threadId,
      ...(replyToMessageId == null ? {} : { replyToMessageId }),
    },
    body,
    intent: 'default',
    mentions: [],
  });
}

function latestTurn(f: Fixture) {
  return f.db.prepare(
    `SELECT a.id turnId,a.run_id runId,a.member_id memberId,a.status,r.task_id taskId
       FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id ORDER BY a.rowid DESC LIMIT 1`,
  ).get() as { turnId: string; runId: string; memberId: string; status: string; taskId: string };
}

function latestContext(f: Fixture): TurnBundleEnvelope {
  const row = f.db.prepare('SELECT included_refs_json FROM context_bundles ORDER BY rowid DESC LIMIT 1').get() as { included_refs_json: string };
  return JSON.parse(row.included_refs_json) as TurnBundleEnvelope;
}

function insertThreadFillers(f: Fixture, threadId: string, count: number): void {
  const thread = f.db.prepare('SELECT conversation_id,room_id,root_task_id,last_message_seq FROM conversation_threads WHERE id=?').get(threadId) as
    {conversation_id:string;room_id:string;root_task_id:string|null;last_message_seq:number};
  const conversation = f.db.prepare('SELECT last_message_seq FROM conversations WHERE id=?').get(thread.conversation_id) as {last_message_seq:number};
  let conversationSeq = conversation.last_message_seq;
  let threadSeq = thread.last_message_seq;
  f.db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      conversationSeq += 1; threadSeq += 1;
      f.db.prepare(`INSERT INTO messages
        (id,project_id,conversation_id,conversation_seq,room_id,thread_id,task_id,thread_message_seq,author_type,author_id,body_json,status,created_at)
        VALUES (?,?,?,?,?,?,?,?, 'agent', ?, ?, 'final', ?)`)
        .run(`msg_filler_${randomUUID()}`, f.projectId, thread.conversation_id, conversationSeq, thread.room_id, threadId, thread.root_task_id, threadSeq, f.memberId, JSON.stringify({text:`合成填充 ${index + 1}`}), Date.now());
    }
    f.db.prepare('UPDATE conversations SET last_message_seq=? WHERE id=?').run(conversationSeq, thread.conversation_id);
    f.db.prepare('UPDATE conversation_threads SET last_message_seq=?,revision=revision+1 WHERE id=?').run(threadSeq, threadId);
  })();
}

function insertDmFillers(f: Fixture, conversationId: string, count: number): void {
  const conversation = f.db.prepare('SELECT last_message_seq FROM conversations WHERE id=?').get(conversationId) as {last_message_seq:number};
  let sequence = conversation.last_message_seq;
  f.db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      sequence += 1;
      f.db.prepare(`INSERT INTO messages
        (id,project_id,conversation_id,conversation_seq,room_id,thread_id,task_id,thread_message_seq,author_type,author_id,body_json,status,created_at)
        VALUES (?,?,?,?,NULL,NULL,NULL,NULL,'agent',?,?,'final',?)`)
        .run(`msg_dm_filler_${randomUUID()}`, f.projectId, conversationId, sequence, f.memberId, JSON.stringify({text:`私信填充 ${index + 1}`}), Date.now());
    }
    f.db.prepare('UPDATE conversations SET last_message_seq=? WHERE id=?').run(sequence, conversationId);
  })();
}

describe('R93 complete Markdown detail and bounded downstream reading', () => {
  it('keeps a short answer free of empty Markdown attachments', async () => {
    const f = await fixture();
    let adapter: FakeRuntimeAdapter | undefined;
    try {
      adapter = new FakeRuntimeAdapter({ turnScriptSequencer: ({ text }) => finalScript(text, '一句话结论。') });
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'r93-short', appDataDir: f.dir });
      const sent = await submitRoom(f, '请简短回答');
      await worker.runOnce();
      const turn = latestTurn(f);
      expect(turn.status).toBe('SUCCEEDED');
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({ status: 'DONE' });
      const message = f.db.prepare("SELECT id,body_json FROM messages WHERE task_id=? AND author_type='agent'").get(sent.taskId) as { id: string; body_json: string };
      expect(JSON.parse(message.body_json).text).toBe('一句话结论。');
      expect(f.db.prepare('SELECT count(*) n FROM message_attachments WHERE message_id=?').get(message.id)).toEqual({ n: 0 });
      expect(f.db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({ n: 0 });
    } finally {
      await adapter?.closeAllSessions();
      f.close();
    }
  });

  it('stores one model-authored named document with exact bytes while document:null stays attachment-free', async () => {
    const f = await fixture();
    const document = { filename: '登录校验方案.md', purpose: '供用户复核实现与验证范围', markdown: '# 登录校验方案\n\n## 验证\n\nR96_DOCUMENT_TAIL\n' };
    let calls = 0;
    let adapter: FakeRuntimeAdapter | undefined;
    try {
      adapter = new FakeRuntimeAdapter({
        turnScriptSequencer: ({ text }) => (calls++ === 0
          ? finalDocumentScript(text, '实现结论：详见方案文档。', document)
          : finalDocumentScript(text, '短交流不需要文档。', null)),
      });
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'r96-document', appDataDir: f.dir });
      const sent = await submitRoom(f, '请给出一个可复核的实现方案');
      await worker.runOnce();
      const final = f.db.prepare("SELECT id,body_json FROM messages WHERE task_id=? AND author_type='agent' ORDER BY rowid DESC LIMIT 1").get(sent.taskId) as { id: string; body_json: string };
      const body = JSON.parse(final.body_json) as { text: string; document?: { filename: string; purpose: string; artifactId?: string; markdown?: string } };
      expect(body.text).toBe('实现结论：详见方案文档。');
      expect(body.document).toMatchObject({ filename: document.filename, purpose: document.purpose });
      expect(body.document?.artifactId).toBeTruthy();
      expect(body.document?.markdown).toBeUndefined();
      const attachment = f.db.prepare(`SELECT ma.display_name,a.id artifact_id,a.source_name,a.hash,a.blob_path
        FROM message_attachments ma JOIN artifacts a ON a.id=ma.artifact_id WHERE ma.message_id=?`).get(final.id) as
        { display_name: string; artifact_id: string; source_name: string; hash: string; blob_path: string };
      expect(attachment).toMatchObject({ display_name: document.filename, source_name: document.filename });
      expect(body.document?.artifactId).toBe(attachment.artifact_id);
      expect(readFileSync(attachment.blob_path, 'utf8')).toBe(document.markdown);
      expect(attachment.hash).toBe(sha256(document.markdown));

      const second = await submitRoom(f, '只聊天，不要文件');
      await worker.runOnce();
      const secondFinal = f.db.prepare("SELECT id,body_json FROM messages WHERE task_id=? AND author_type='agent' ORDER BY rowid DESC LIMIT 1").get(second.taskId) as { id: string; body_json: string };
      expect((JSON.parse(secondFinal.body_json) as { document?: unknown }).document).toBeUndefined();
      expect(f.db.prepare('SELECT count(*) n FROM message_attachments WHERE message_id=?').get(secondFinal.id)).toEqual({ n: 0 });
    } finally {
      await adapter?.closeAllSessions();
      f.close();
    }
  });

  it('does not inject runtimeControlResult.detailMarkdown when document:null is present', async () => {
    const f = await fixture();
    let calls = 0;
    let adapter: FakeRuntimeAdapter | undefined;
    try {
      adapter = new FakeRuntimeAdapter({
        turnScriptSequencer: ({ text }) => {
          calls += 1;
          return finalDocumentScript(text, calls === 1 ? '第一条短回复。' : '第二条短回复。', null);
        },
      });
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'r96-null-precedence', appDataDir: f.dir });
      const first = await submitRoom(f, '第一条');
      await worker.runOnce();
      const firstAgent = f.db.prepare("SELECT id FROM messages WHERE task_id=? AND author_type='agent' ORDER BY rowid DESC LIMIT 1").get(first.taskId) as { id: string };
      const control = JSON.stringify({
        schemaVersion: TASK_COMPLETE_SCHEMA_VERSION,
        detailMarkdown: '# 旧格式完整详情\n\nR96_NESTED_OLD_DETAIL_MUST_NOT_BE_INJECTED',
        document: null,
      });
      f.db.prepare('UPDATE messages SET body_json=? WHERE id=?').run(JSON.stringify({ text: '第一条短回复。', runtimeControlResult: control }), firstAgent.id);

      await submitThread(f, first.threadId, '引用上一条', firstAgent.id);
      await worker.runOnce();
      const rendered = renderTurnBundle(latestContext(f));
      expect(rendered).toContain('引用上一条');
      expect(rendered).not.toContain('R96_NESTED_OLD_DETAIL_MUST_NOT_BE_INJECTED');
    } finally {
      await adapter?.closeAllSessions();
      f.close();
    }
  });

  it('does not drop detail when the model leaves visible answer strings empty', async () => {
    const f = await fixture();
    let adapter: FakeRuntimeAdapter | undefined;
    try {
      adapter = new FakeRuntimeAdapter({
        turnScriptSequencer: ({ text }) => finalScript(text, '', '# 完整详情\n\nR93_EMPTY_ANSWER_TAIL'),
      });
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'r93-empty-answer', appDataDir: f.dir });
      const sent = await submitRoom(f, '验证空可见答复仍保留详情');
      await worker.runOnce();
      const final = f.db.prepare("SELECT id,body_json FROM messages WHERE task_id=? AND author_type='agent' ORDER BY rowid DESC LIMIT 1").get(sent.taskId) as { id: string; body_json: string };
      expect(JSON.parse(final.body_json).text).toBe('完整详情见下方 Markdown 附件。');
      expect(f.db.prepare('SELECT count(*) n FROM message_attachments WHERE message_id=? AND id LIKE \'matt_detail_%\'').get(final.id)).toEqual({ n: 1 });
      const blob = f.db.prepare('SELECT a.blob_path FROM message_attachments ma JOIN artifacts a ON a.id=ma.artifact_id WHERE ma.message_id=?').get(final.id) as { blob_path: string };
      expect(readFileSync(blob.blob_path, 'utf8')).toContain('R93_EMPTY_ANSWER_TAIL');
    } finally {
      await adapter?.closeAllSessions();
      f.close();
    }
  });

  it('stores one complete MD before DONE and injects its full tail into the next ordinary turn', async () => {
    const f = await fixture();
    const detail = `# 完整详情\n\n## 证据\n\n${'逐项证据。'.repeat(180)}\n\nR93_DETAIL_TAIL_ALPHA`;
    let calls = 0;
    let adapter: FakeRuntimeAdapter | undefined;
    try {
      adapter = new FakeRuntimeAdapter({
        turnScriptSequencer: ({ text }) => (calls++ === 0 ? finalScript(text, '短结论：详见完整详情。', detail) : finalScript(text, '已收到完整详情。')),
      });
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'r93-long', appDataDir: f.dir });
      const sent = await submitRoom(f, '请分析后给出简短结论');
      await worker.runOnce();
      const firstTurn = latestTurn(f);
      expect(firstTurn.status).toBe('SUCCEEDED');
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({ status: 'DONE' });
      const final = f.db.prepare("SELECT id,author_id,body_json FROM messages WHERE task_id=? AND author_type='agent' ORDER BY rowid DESC LIMIT 1").get(sent.taskId) as { id: string; author_id: string; body_json: string };
      expect(JSON.parse(final.body_json).detailMarkdown).toBeUndefined();
      const attachment = f.db.prepare(
        `SELECT ma.id,ma.artifact_id,ma.display_name,a.author_id,a.task_id,a.run_id,a.kind,a.hash,a.blob_path,a.source_name
           FROM message_attachments ma JOIN artifacts a ON a.id=ma.artifact_id WHERE ma.message_id=?`,
      ).get(final.id) as { id: string; artifact_id: string; display_name: string; author_id: string; task_id: string; run_id: string; kind: string; hash: string; blob_path: string; source_name: string };
      expect(attachment).toMatchObject({ display_name: '完整详情.md', author_id: f.memberId, task_id: sent.taskId, run_id: firstTurn.runId, kind: 'text_file', source_name: '完整详情.md' });
      expect(attachment.id.startsWith('matt_detail_')).toBe(true);
      expect(attachment.hash).toBe(sha256(Buffer.from(detail, 'utf8')));
      expect(readFileSync(attachment.blob_path, 'utf8')).toBe(detail);
      const history = await f.cmd<{ items: Array<{ id: string; attachments: Array<{ artifactId: string; filename: string; detailMarkdown?: boolean; sizeBytes?: number }> }> }>('thread.history', { threadId: sent.threadId, limit: 20 });
      expect(history.items.find((item) => item.id === final.id)?.attachments).toContainEqual(expect.objectContaining({ artifactId: attachment.artifact_id, filename: '完整详情.md', detailMarkdown: true }));
      const preview = await f.cmd<{ text: string; truncated: boolean }>('attachment.previewText', { attachmentId: attachment.artifact_id, conversationId: f.conversationId });
      expect(preview.truncated).toBe(false);
      expect(preview.text).toContain('R93_DETAIL_TAIL_ALPHA');
      await worker.runOnce();
      expect(f.db.prepare('SELECT count(*) n FROM message_attachments WHERE message_id=?').get(final.id)).toEqual({ n: 1 });

      await submitThread(f, sent.threadId, '请根据上一轮完整详情复述末尾标记');
      await worker.runOnce();
      const envelope = latestContext(f);
      const injected = envelope.attachments?.find((entry) => entry.detail);
      expect(injected).toBeDefined();
      expect(injected).toMatchObject({ ref: attachment.artifact_id, truncated: false, hash: attachment.hash });
      expect(injected!.text).toContain('R93_DETAIL_TAIL_ALPHA');
      expect(renderTurnBundle(envelope)).toContain('R93_DETAIL_TAIL_ALPHA');
    } finally {
      await adapter?.closeAllSessions();
      f.close();
    }
  });

  it('satisfies a database gate that rejects DONE before the detail row exists', async () => {
    const f = await fixture();
    let adapter: FakeRuntimeAdapter | undefined;
    try {
      adapter = new FakeRuntimeAdapter({
        turnScriptSequencer: ({ text }) => finalScript(text, '短结论。', '# 完整详情\n\nR93_DONE_GATE_DETAIL'),
      });
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'r93-done-gate', appDataDir: f.dir });
      const sent = await submitRoom(f, '验证 DONE 前详情已可读');
      f.db.exec(`
        CREATE TRIGGER r93_detail_before_done
        BEFORE UPDATE OF status ON tasks
        WHEN OLD.id='${sent.taskId}' AND NEW.status IN ('DONE','REVIEW')
        BEGIN
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM messages m
              JOIN message_attachments ma ON ma.message_id=m.id
              JOIN artifacts a ON a.id=ma.artifact_id
             WHERE m.task_id=NEW.id AND ma.id LIKE 'matt_detail_%' AND a.kind='text_file'
          ) THEN 1 ELSE RAISE(ABORT, 'R93 detail must be readable before DONE') END;
        END;
      `);
      await worker.runOnce();
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({ status: 'DONE' });
      expect(f.db.prepare("SELECT count(*) n FROM message_attachments WHERE id LIKE 'matt_detail_%'").get()).toEqual({ n: 1 });
    } finally {
      await adapter?.closeAllSessions();
      f.close();
    }
  });

  it('rejects a detail host request whose turn identity does not match run/member/task', async () => {
    const f = await fixture();
    let adapter: FakeRuntimeAdapter | undefined;
    try {
      adapter = new FakeRuntimeAdapter({
        turnScriptSequencer: ({ text }) => finalScript(text, '短结论。', '# 完整详情\n\nR93_TURN_IDENTITY'),
      });
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'r93-turn-identity', appDataDir: f.dir });
      const sent = await submitRoom(f, '验证轮次身份');
      await worker.runOnce();
      const turn = latestTurn(f);
      const final = f.db.prepare("SELECT id FROM messages WHERE task_id=? AND author_type='agent' ORDER BY rowid DESC LIMIT 1").get(sent.taskId) as { id: string };
      const result = persistDetailMarkdown({
        db: f.db, appDataDir: f.dir, projectId: f.projectId, conversationId: f.conversationId,
        threadId: sent.threadId, taskId: sent.taskId, runId: turn.runId, turnId: 'turn_missing_identity',
        messageId: final.id, memberId: f.memberId, markdown: '# 不应登记\n\nR93_TURN_IDENTITY',
      });
      expect(result).toMatchObject({ status: 'failed', code: 'TURN_IDENTITY_MISMATCH' });
    } finally {
      await adapter?.closeAllSessions();
      f.close();
    }
  });

  it('keeps one complete MD when it exceeds the inline window and exposes a verified full path instead of claiming it was read', async () => {
    const f = await fixture();
    const detail = `# 完整详情\n\n${'很长的证据。'.repeat(6000)}\n\nR93_DETAIL_TAIL_OVER_64K`;
    let calls = 0;
    let adapter: FakeRuntimeAdapter | undefined;
    try {
      adapter = new FakeRuntimeAdapter({
        turnScriptSequencer: ({ text }) => (calls++ === 0 ? finalScript(text, '超长详情见附件。', detail) : finalScript(text, '已看到引用。')),
      });
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'r93-over64', appDataDir: f.dir });
      const sent = await submitRoom(f, '请给出一个会有超长证据的结论');
      await worker.runOnce();
      const final = f.db.prepare("SELECT id FROM messages WHERE task_id=? AND author_type='agent' ORDER BY rowid DESC LIMIT 1").get(sent.taskId) as { id: string };
      const attachment = f.db.prepare('SELECT a.id,a.hash,a.blob_path FROM message_attachments ma JOIN artifacts a ON a.id=ma.artifact_id WHERE ma.message_id=?').get(final.id) as { id: string; hash: string; blob_path: string };
      expect(f.db.prepare('SELECT count(*) n FROM message_attachments WHERE message_id=?').get(final.id)).toEqual({ n: 1 });
      expect(readFileSync(attachment.blob_path, 'utf8')).toContain('R93_DETAIL_TAIL_OVER_64K');

      await submitThread(f, sent.threadId, '继续');
      await worker.runOnce();
      const envelope = latestContext(f);
      const injected = envelope.attachments?.find((entry) => entry.detail);
      expect(injected).toMatchObject({ ref: attachment.id, truncated: true, hash: attachment.hash, fullTextPath: attachment.blob_path });
      expect(injected!.text).not.toContain('R93_DETAIL_TAIL_OVER_64K');
      const rendered = renderTurnBundle(envelope);
      expect(rendered).toContain(attachment.blob_path);
      expect(rendered).toContain('在真实读取前不得声称已读全文');
    } finally {
      await adapter?.closeAllSessions();
      f.close();
    }
  });

  it('keeps an R91 generated file and the one detail MD side by side without duplicate cards', async () => {
    const f = await fixture();
    let adapter: FakeRuntimeAdapter | undefined;
    try {
      const access = await f.cmd<{ revision: number }>('project.writeAccess.get', { projectId: f.projectId });
      await f.cmd('project.writeAccess.set', { projectId: f.projectId, authorized: true, expectedRevision: access.revision });
      const detail = '# 完整详情\n\n生成文件说明 R93_GENERATED_WITH_DETAIL';
      adapter = new FakeRuntimeAdapter({
        turnScriptSequencer: ({ text }) => {
          const resultKey = /resultKey=([^；\n]+)/.exec(text)?.[1] ?? /"resultKey":"(result_[^"]+)"/.exec(text)?.[1];
          if (!resultKey) throw new Error('resultKey missing');
          return [
            { kind: 'writeFile', path: 'r93-result.txt', content: 'R93 generated bytes\n' },
            {
              kind: 'event',
              event: {
                kind: 'turn.completed',
                finalText: JSON.stringify({
                  schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey, responseKind: 'work',
                  answer: '已生成文件，完整说明见详情。', detailMarkdown: detail, changeSummary: '生成文件',
                  files: ['r93-result.txt'], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [],
                }),
              },
            },
          ];
        },
      });
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'r93-files-detail', appDataDir: f.dir });
      const sent = await submitRoom(f, '生成一个文件并给完整说明');
      await worker.runOnce();
      const final = f.db.prepare("SELECT id FROM messages WHERE task_id=? AND author_type='agent' ORDER BY rowid DESC LIMIT 1").get(sent.taskId) as { id: string };
      const attachments = f.db.prepare(
        `SELECT ma.id,a.id artifactId,a.source_name,a.kind,a.hash FROM message_attachments ma JOIN artifacts a ON a.id=ma.artifact_id
          WHERE ma.message_id=? ORDER BY ma.rowid`,
      ).all(final.id) as Array<{ id: string; artifactId: string; source_name: string; kind: string; hash: string }>;
      expect(attachments).toHaveLength(2);
      expect(attachments.map((row) => row.source_name).sort()).toEqual(['r93-result.txt', '完整详情.md'].sort());
      expect(attachments.filter((row) => row.id.startsWith('matt_detail_'))).toHaveLength(1);
      expect(new Set(attachments.map((row) => row.artifactId)).size).toBe(2);
      const history = await f.cmd<{ items: Array<{ id: string; attachments: Array<{ filename: string; detailMarkdown?: boolean }> }> }>('thread.history', { threadId: sent.threadId, limit: 20 });
      const summary = history.items.find((item) => item.id === final.id)!.attachments;
      expect(summary).toHaveLength(2);
      expect(summary.find((item) => item.filename === '完整详情.md')?.detailMarkdown).toBe(true);
    } finally {
      await adapter?.closeAllSessions();
      f.close();
    }
  });

  it('injects only the latest four detail files for a normal continuation', async () => {
    const f = await fixture();
    let adapter: FakeRuntimeAdapter | undefined;
    try {
      const tails = Array.from({ length: 6 }, (_, index) => `R93_RECENT_TAIL_${index + 1}`);
      let call = 0;
      adapter = new FakeRuntimeAdapter({
        turnScriptSequencer: ({ text }) => {
          if (call >= tails.length) return finalScript(text, '已完成最近详情读取。');
          const tail = tails[call++]!;
          return finalScript(text, `第 ${call} 次短结论。`, `# 完整详情\n\n${'证据。'.repeat(100)}\n\n${tail}`);
        },
      });
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'r93-recent-four', appDataDir: f.dir });
      const first = await submitRoom(f, '第一次');
      await worker.runOnce();
      for (let index = 1; index < tails.length; index += 1) {
        await submitThread(f, first.threadId, `继续第 ${index + 1} 次`);
        await worker.runOnce();
      }
      await submitThread(f, first.threadId, '最后继续');
      await worker.runOnce();
      const envelope = latestContext(f);
      const details = (envelope.attachments ?? []).filter((item) => item.detail);
      expect(details).toHaveLength(4);
      const joined = details.map((item) => item.text).join('\n');
      expect(joined).toContain('R93_RECENT_TAIL_3');
      expect(joined).toContain('R93_RECENT_TAIL_4');
      expect(joined).toContain('R93_RECENT_TAIL_5');
      expect(joined).toContain('R93_RECENT_TAIL_6');
      expect(joined).not.toContain('R93_RECENT_TAIL_1');
      expect(joined).not.toContain('R93_RECENT_TAIL_2');
      const rendered = renderTurnBundle(envelope);
      expect(rendered).toContain('R93_RECENT_TAIL_3');
      expect(rendered).toContain('R93_RECENT_TAIL_6');
      expect(rendered).not.toContain('R93_RECENT_TAIL_1');
      expect(rendered).not.toContain('R93_RECENT_TAIL_2');
    } finally {
      await adapter?.closeAllSessions();
      f.close();
    }
  });

  it('bounds six inline room fallbacks to the latest four plus an explicit older reply target', async () => {
    const f = await fixture();
    const tails = Array.from({ length: 6 }, (_, index) => `R93_ROOM_INLINE_${index + 1}_TAIL`);
    let call = 0;
    let adapter: FakeRuntimeAdapter | undefined;
    try {
      f.db.exec(`
        CREATE TRIGGER r93_reject_room_detail_artifacts
        BEFORE INSERT ON artifacts
        WHEN NEW.id LIKE 'art_detail_%'
        BEGIN
          SELECT RAISE(ABORT, 'R93 synthetic room detail storage failure');
        END;
      `);
      adapter = new FakeRuntimeAdapter({
        turnScriptSequencer: ({ text }) => {
          const tail = tails[call];
          call += 1;
          return tail == null
            ? finalScript(text, '仅读取显式旧详情。')
            : finalScript(text, `第 ${call} 次短答。`, `# 完整详情\n\n${'房间回退。'.repeat(80)}\n\n${tail}`);
        },
      });
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'r93-room-inline-bound', appDataDir: f.dir });
      const first = await submitRoom(f, '第一条房间详情');
      await worker.runOnce();
      const agentIds: string[] = [];
      for (let index = 0; index < tails.length; index += 1) {
        const taskId = index === 0
          ? first.taskId
          : (await submitThread(f, first.threadId, `继续房间详情 ${index + 1}`)).taskId;
        if (index > 0) await worker.runOnce();
        const message = f.db.prepare("SELECT id,body_json FROM messages WHERE task_id=? AND author_type='agent' ORDER BY rowid DESC LIMIT 1").get(taskId) as { id: string; body_json: string };
        expect(JSON.parse(message.body_json).detailMarkdown).toContain(tails[index]!);
        agentIds.push(message.id);
      }
      await submitThread(f, first.threadId, '显式引用第一条完整详情', agentIds[0]);
      await worker.runOnce();
      const rendered = renderTurnBundle(latestContext(f));
      expect(rendered).toContain(tails[0]!);
      expect(rendered).toContain(tails[2]!);
      expect(rendered).toContain(tails[3]!);
      expect(rendered).toContain(tails[4]!);
      expect(rendered).toContain(tails[5]!);
      expect(rendered).not.toContain(tails[1]!);
    } finally {
      await adapter?.closeAllSessions();
      f.close();
    }
  });

  it('bounds six inline DM fallbacks to the latest four plus an explicit older reply target', async () => {
    const f = await fixture();
    const tails = Array.from({ length: 6 }, (_, index) => `R93_DM_INLINE_${index + 1}_TAIL`);
    let call = 0;
    let adapter: FakeRuntimeAdapter | undefined;
    try {
      f.db.exec(`
        CREATE TRIGGER r93_reject_dm_detail_artifacts
        BEFORE INSERT ON artifacts
        WHEN NEW.id LIKE 'art_detail_%'
        BEGIN
          SELECT RAISE(ABORT, 'R93 synthetic DM detail storage failure');
        END;
      `);
      adapter = new FakeRuntimeAdapter({
        turnScriptSequencer: ({ text }) => {
          const tail = tails[call];
          call += 1;
          return tail == null
            ? finalScript(text, '仅读取显式旧私信详情。')
            : finalScript(text, `第 ${call} 次私信短答。`, `# 私信完整详情\n\n${'私信回退。'.repeat(80)}\n\n${tail}`);
        },
      });
      const conversation = await f.cmd<{ conversationId: string }>('conversation.create', { projectId: f.projectId, peerMemberId: f.memberId });
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'r93-dm-inline-bound', appDataDir: f.dir });
      const agentIds: string[] = [];
      for (let index = 0; index < tails.length; index += 1) {
        const sent = await f.cmd<{ taskId: string }>('message.submit', {
          target: { kind: 'dm', projectId: f.projectId, conversationId: conversation.conversationId },
          body: `私信详情 ${index + 1}`,
          intent: 'default',
          mentions: [],
        });
        await worker.runOnce();
        const message = f.db.prepare("SELECT id,body_json FROM messages WHERE task_id=? AND author_type='agent' ORDER BY rowid DESC LIMIT 1").get(sent.taskId) as { id: string; body_json: string };
        expect(JSON.parse(message.body_json).detailMarkdown).toContain(tails[index]!);
        agentIds.push(message.id);
      }
      const explicit = await f.cmd<{ taskId: string }>('message.submit', {
        target: { kind: 'dm', projectId: f.projectId, conversationId: conversation.conversationId },
        body: '显式引用第一条私信完整详情',
        intent: 'default',
        mentions: [],
      });
      const explicitRoot = f.db.prepare("SELECT id FROM messages WHERE task_id=? AND author_type='human' ORDER BY rowid DESC LIMIT 1").get(explicit.taskId) as { id: string };
      f.db.prepare('UPDATE messages SET reply_to_message_id=? WHERE id=?').run(agentIds[0], explicitRoot.id);
      await worker.runOnce();
      const rendered = renderTurnBundle(latestContext(f));
      expect(rendered).toContain(tails[0]!);
      expect(rendered).toContain(tails[2]!);
      expect(rendered).toContain(tails[3]!);
      expect(rendered).toContain(tails[4]!);
      expect(rendered).toContain(tails[5]!);
      expect(rendered).not.toContain(tails[1]!);
    } finally {
      await adapter?.closeAllSessions();
      f.close();
    }
  });

  it('loads a room explicit inline detail even when it is outside the 200-message history window', async () => {
    const f = await fixture();
    let call = 0;
    let adapter: FakeRuntimeAdapter | undefined;
    try {
      f.db.exec(`
        CREATE TRIGGER r93_reject_room_cross_window
        BEFORE INSERT ON artifacts
        WHEN NEW.id LIKE 'art_detail_%'
        BEGIN
          SELECT RAISE(ABORT, 'R93 synthetic cross-window room failure');
        END;
      `);
      adapter = new FakeRuntimeAdapter({
        turnScriptSequencer: ({ text }) => {
          call += 1;
          return call === 1
            ? finalScript(text, '旧房间详情。', '# 完整详情\n\nR93_ROOM_CROSS_WINDOW_TAIL')
            : finalScript(text, '已读取旧房间引用。');
        },
      });
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'r93-room-cross-window', appDataDir: f.dir });
      const first = await submitRoom(f, '产生窗口外房间详情');
      await worker.runOnce();
      const old = f.db.prepare("SELECT id FROM messages WHERE task_id=? AND author_type='agent' ORDER BY rowid DESC LIMIT 1").get(first.taskId) as { id: string };
      insertThreadFillers(f, first.threadId, 205);
      await submitThread(f, first.threadId, '跨窗口引用旧房间详情', old.id);
      await worker.runOnce();
      const context = latestContext(f);
      expect(renderTurnBundle(context)).toContain('R93_ROOM_CROSS_WINDOW_TAIL');
      expect(context.threadDigest?.messages.some((message) => message.messageId === old.id)).toBe(true);
    } finally {
      await adapter?.closeAllSessions();
      f.close();
    }
  });

  it('loads a DM explicit inline detail even when it is outside the 50-message history window', async () => {
    const f = await fixture();
    let call = 0;
    let adapter: FakeRuntimeAdapter | undefined;
    try {
      f.db.exec(`
        CREATE TRIGGER r93_reject_dm_cross_window
        BEFORE INSERT ON artifacts
        WHEN NEW.id LIKE 'art_detail_%'
        BEGIN
          SELECT RAISE(ABORT, 'R93 synthetic cross-window DM failure');
        END;
      `);
      adapter = new FakeRuntimeAdapter({
        turnScriptSequencer: ({ text }) => {
          call += 1;
          return call === 1
            ? finalScript(text, '旧私信详情。', '# 私信完整详情\n\nR93_DM_CROSS_WINDOW_TAIL')
            : finalScript(text, '已读取旧私信引用。');
        },
      });
      const conversation = await f.cmd<{ conversationId: string }>('conversation.create', { projectId: f.projectId, peerMemberId: f.memberId });
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'r93-dm-cross-window', appDataDir: f.dir });
      const first = await f.cmd<{ taskId: string }>('message.submit', {
        target: { kind: 'dm', projectId: f.projectId, conversationId: conversation.conversationId },
        body: '产生窗口外私信详情', intent: 'default', mentions: [],
      });
      await worker.runOnce();
      const old = f.db.prepare("SELECT id FROM messages WHERE task_id=? AND author_type='agent' ORDER BY rowid DESC LIMIT 1").get(first.taskId) as { id: string };
      insertDmFillers(f, conversation.conversationId, 55);
      const explicit = await f.cmd<{ taskId: string }>('message.submit', {
        target: { kind: 'dm', projectId: f.projectId, conversationId: conversation.conversationId },
        body: '跨窗口引用旧私信详情', intent: 'default', mentions: [],
      });
      const root = f.db.prepare("SELECT id FROM messages WHERE task_id=? AND author_type='human' ORDER BY rowid DESC LIMIT 1").get(explicit.taskId) as { id: string };
      f.db.prepare('UPDATE messages SET reply_to_message_id=? WHERE id=?').run(old.id, root.id);
      await worker.runOnce();
      const context = latestContext(f);
      expect(renderTurnBundle(context)).toContain('R93_DM_CROSS_WINDOW_TAIL');
      expect(context.threadDigest?.messages.some((message) => message.messageId === old.id)).toBe(true);
    } finally {
      await adapter?.closeAllSessions();
      f.close();
    }
  });

  it('falls back to readable full text in the final message and next context when the MD is too large to host', async () => {
    const f = await fixture();
    const detail = `# 完整详情\n\n${'超限原文。'.repeat(50000)}\n\nR93_DETAIL_TAIL_FALLBACK`;
    let calls = 0;
    let adapter: FakeRuntimeAdapter | undefined;
    try {
      adapter = new FakeRuntimeAdapter({
        turnScriptSequencer: ({ text }) => (calls++ === 0 ? finalScript(text, '摘要保留，详情走原文降级。', detail) : finalScript(text, '已读取原文降级。')),
      });
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'r93-fallback', appDataDir: f.dir });
      const sent = await submitRoom(f, '请给出超限详情');
      await worker.runOnce();
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({ status: 'DONE' });
      const final = f.db.prepare("SELECT id,body_json FROM messages WHERE task_id=? AND author_type='agent' ORDER BY rowid DESC LIMIT 1").get(sent.taskId) as { id: string; body_json: string };
      expect(JSON.parse(final.body_json).detailMarkdown).toBeUndefined();
      const blob=f.db.prepare('SELECT a.blob_path FROM message_attachments ma JOIN artifacts a ON a.id=ma.artifact_id WHERE ma.message_id=?').get(final.id) as {blob_path:string};
      expect(readFileSync(blob.blob_path,'utf8')).toBe(detail);
      expect(f.db.prepare('SELECT count(*) n FROM message_attachments WHERE message_id=?').get(final.id)).toEqual({ n: 1 });
      await submitThread(f, sent.threadId, '继续读取降级原文');
      await worker.runOnce();
      const envelope = latestContext(f);
      const rendered = renderTurnBundle(envelope);
      expect(rendered).toContain('完整详情.md');
      expect(rendered).toContain('截断');
    } finally {
      await adapter?.closeAllSessions();
      f.close();
    }
  });

  it('falls back to readable full text when detail attachment registration fails', async () => {
    const f = await fixture();
    const detail = `# 完整详情\n\n${'存储故障仍保留。'.repeat(40)}\n\nR93_DETAIL_STORAGE_FALLBACK_TAIL`;
    let calls = 0;
    let adapter: FakeRuntimeAdapter | undefined;
    try {
      adapter = new FakeRuntimeAdapter({
        turnScriptSequencer: ({ text }) => (calls++ === 0 ? finalScript(text, '短结论。', detail) : finalScript(text, '已读到故障回退全文。')),
      });
      f.db.exec(`
        CREATE TRIGGER r93_reject_detail_artifact
        BEFORE INSERT ON artifacts
        WHEN NEW.id LIKE 'art_detail_%'
        BEGIN
          SELECT RAISE(ABORT, 'R93 synthetic detail storage failure');
        END;
      `);
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'r93-storage-fallback', appDataDir: f.dir });
      const sent = await submitRoom(f, '验证详情附件登记失败仍保留全文');
      await worker.runOnce();
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({ status: 'DONE' });
      const final = f.db.prepare("SELECT id,body_json FROM messages WHERE task_id=? AND author_type='agent' ORDER BY rowid DESC LIMIT 1").get(sent.taskId) as { id: string; body_json: string };
      expect(JSON.parse(final.body_json).detailMarkdown).toContain('R93_DETAIL_STORAGE_FALLBACK_TAIL');
      expect(f.db.prepare('SELECT count(*) n FROM message_attachments WHERE message_id=?').get(final.id)).toEqual({ n: 0 });

      await submitThread(f, sent.threadId, '继续读取故障回退');
      await worker.runOnce();
      const rendered = renderTurnBundle(latestContext(f));
      expect(rendered).toContain('【完整详情（附件不可用，原文保留）】');
      expect(rendered).toContain('R93_DETAIL_STORAGE_FALLBACK_TAIL');
    } finally {
      await adapter?.closeAllSessions();
      f.close();
    }
  });

  it('never creates a detail attachment for an invalid TaskComplete', async () => {
    const f = await fixture();
    let adapter: FakeRuntimeAdapter | undefined;
    try {
      adapter = new FakeRuntimeAdapter({
        turnScriptSequencer: ({ text }) => {
          const resultKey = /resultKey=([^；\n]+)/.exec(text)?.[1] ?? /"resultKey":"(result_[^"]+)"/.exec(text)?.[1];
          return [{
            kind: 'event',
            event: {
              kind: 'turn.completed',
              finalText: JSON.stringify({
                schemaVersion: TASK_COMPLETE_SCHEMA_VERSION,
                resultKey,
                answer: '非法详情结果',
                detailMarkdown: '# 不应登记\n\nR93_INVALID_DETAIL',
              }),
            },
          }];
        },
      });
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'r93-invalid-detail', appDataDir: f.dir });
      const sent = await submitRoom(f, '非法输出');
      await worker.runOnce();
      expect(latestTurn(f).status).toBe('FAILED');
      expect(f.db.prepare("SELECT count(*) n FROM artifacts WHERE id LIKE 'art_detail_%'").get()).toEqual({ n: 0 });
      expect(f.db.prepare("SELECT count(*) n FROM message_attachments WHERE id LIKE 'matt_detail_%'").get()).toEqual({ n: 0 });
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({ status: 'BLOCKED' });
    } finally {
      await adapter?.closeAllSessions();
      f.close();
    }
  });

  it('creates no success detail artifact when a pending detail-producing turn is stopped', async () => {
    const f = await fixture();
    let adapter: FakeRuntimeAdapter | undefined;
    try {
      adapter = new FakeRuntimeAdapter({
        turnScriptSequencer: ({ text }) => [
          { kind: 'stall', ms: 10_000 },
          ...finalScript(text, '不应在停止后成功提交。', '# 不应生成\n\nR93_STOPPED_DETAIL'),
        ],
      });
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'r93-stop-detail', appDataDir: f.dir });
      f.setInterruptTurn((turnId) => worker.interruptTurn(turnId));
      const sent = await submitRoom(f, '停止后不应生成详情');
      const running = worker.runOnce();
      let run: { run_id: string } | undefined;
      const deadline = Date.now() + 2_000;
      while (run == null && Date.now() < deadline) {
        run = f.db.prepare(
          `SELECT a.run_id FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id
            WHERE r.task_id=? ORDER BY a.rowid DESC LIMIT 1`,
        ).get(sent.taskId) as { run_id: string } | undefined;
        if (run == null) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(run).toBeDefined();
      await f.cmd('task.stop', { taskId: sent.taskId, targetRunId: run!.run_id, expectedStopGeneration: 0 });
      await running;
      expect(latestTurn(f).status).toBe('CANCELLED');
      expect(f.db.prepare("SELECT count(*) n FROM artifacts WHERE source_name='完整详情.md'").get()).toEqual({ n: 0 });
      expect(f.db.prepare("SELECT count(*) n FROM message_attachments WHERE id LIKE 'matt_detail_%'").get()).toEqual({ n: 0 });
    } finally {
      await adapter?.closeAllSessions();
      f.close();
    }
  });

  it('creates no success detail artifact when the runtime outcome is UNKNOWN', async () => {
    const f = await fixture();
    let adapter: FakeRuntimeAdapter | undefined;
    try {
      adapter = new FakeRuntimeAdapter({
        turnScriptSequencer: () => [{
          kind: 'event',
          event: { kind: 'turn.failed', code: 'INTERRUPTED', message: 'R93 synthetic deadline without user stop', retryable: false },
        }],
      });
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'r93-unknown-detail', appDataDir: f.dir });
      const sent = await submitRoom(f, '超时但不得伪造详情成功');
      await worker.runOnce();
      expect(latestTurn(f).status).toBe('UNKNOWN');
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({ status: 'ACTIVE' });
      expect(f.db.prepare("SELECT count(*) n FROM artifacts WHERE source_name='完整详情.md'").get()).toEqual({ n: 0 });
      expect(f.db.prepare("SELECT count(*) n FROM message_attachments WHERE id LIKE 'matt_detail_%'").get()).toEqual({ n: 0 });
    } finally {
      await adapter?.closeAllSessions();
      f.close();
    }
  });

  it('keeps detail attachments and bounded full reading in DM as well', async () => {
    const f = await fixture();
    const detail = `# 私信完整详情\n\n${'私信证据。'.repeat(120)}\n\nR93_DM_DETAIL_TAIL`;
    let calls = 0;
    let adapter: FakeRuntimeAdapter | undefined;
    try {
      const conversation = await f.cmd<{ conversationId: string }>('conversation.create', { projectId: f.projectId, peerMemberId: f.memberId });
      adapter = new FakeRuntimeAdapter({
        turnScriptSequencer: ({ text }) => (calls++ === 0 ? finalScript(text, '私信短结论。', detail) : finalScript(text, '已读私信详情。')),
      });
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'r93-dm', appDataDir: f.dir });
      const sent = await f.cmd<{ taskId: string }>('message.submit', { target: { kind: 'dm', projectId: f.projectId, conversationId: conversation.conversationId }, body: '合成私信长答复', intent: 'default', mentions: [] });
      await worker.runOnce();
      const final = f.db.prepare("SELECT id FROM messages WHERE conversation_id=? AND author_type='agent' ORDER BY rowid DESC LIMIT 1").get(conversation.conversationId) as { id: string };
      expect(f.db.prepare('SELECT count(*) n FROM message_attachments WHERE message_id=?').get(final.id)).toEqual({ n: 1 });
      await f.cmd('message.submit', { target: { kind: 'dm', projectId: f.projectId, conversationId: conversation.conversationId }, body: '继续', intent: 'default', mentions: [] });
      await worker.runOnce();
      const envelope = latestContext(f);
      expect(envelope.attachments?.find((entry) => entry.detail)?.text).toContain('R93_DM_DETAIL_TAIL');
      expect(sent.taskId).toMatch(/^task_/);
    } finally {
      await adapter?.closeAllSessions();
      f.close();
    }
  });
});

afterAll(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const root of roots.splice(0)) {
    for (let i = 0; i < 5; i += 1) {
      try { if (existsSync(root)) rmSync(root, { recursive: true, force: true }); break; } catch { /* Windows delayed handle */ }
    }
  }
});
