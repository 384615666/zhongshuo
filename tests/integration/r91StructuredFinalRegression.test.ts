/**
 * R91 窄回归：结构化终态的可见回复**不得用任意子串 includes 判定“已含答案”**。
 *
 * 真实反例（本文件第一条）：message.completed 只给状态前缀「不是最终结论。」，随后同 turn 的
 * 合法 TaskComplete.answer='是。'——旧实现在 normalize 后做 `text.includes(answer)`，把“是”
 * 当成已包含，吞掉真实答案并把文件卡挂在前缀消息上（R90 final5 同根因）。
 * 修复复用 agentReplyText/完整答案段落判定：同一最终消息补全为「不是最终结论。\n\n是。」，
 * 文件卡仍挂该消息；另外覆盖“仅 turn.completed 结构化终态”和“完整答案已有时不重复”。
 *
 * 全部经 message.submit → DispatchWorker.runOnce（生产入口）；临时合成目录，不读用户数据。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';

afterEach(() => vi.unstubAllEnvs());

const complete = (resultKey: string, answer: string, files: string[]): string => JSON.stringify({
  schemaVersion: 'task-complete-v1',
  resultKey,
  answer,
  changeSummary: answer,
  files,
  executedVerifications: [],
  unexecutedVerifications: [],
  remainingIssues: [],
});

/** FakeRuntimeAdapter 只把提示词文本交给 sequencer：从中取本轮绑定的 resultKey。 */
function resultKeyFromPrompt(text: string): string {
  const direct = text.match(/result_turn_[0-9a-f-]{36}/);
  if (direct != null) return direct[0];
  const named = text.match(/"resultKey":"(result_[^"]+)"/) ?? text.match(/resultKey=([^；\n]+)/);
  return named?.[1]?.trim() ?? 'result_unknown';
}

async function fixture(scriptFor: (resultKey: string) => FakeTurnScript) {
  vi.stubEnv('ZS_ALLOW_FAKE', '1');
  vi.stubEnv('ZS_RUNTIME', 'fake');
  const dir = mkdtempSync(join(tmpdir(), 'zs-r91-final-reply-'));
  const projectRoot = join(dir, 'project');
  mkdirSync(projectRoot);
  const db = openDatabase(join(dir, 'state.sqlite'));
  const deps = { db, localUserId: 'u_r91_final', appDataDir: dir, interruptTurn: async () => {} };
  const cmd = async <T,>(method: string, params: unknown): Promise<T> => {
    const response = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: randomUUID(), method, params }) as
      { ok: boolean; data: T; error?: { code: string; message: string } };
    expect(response.ok, response.error?.message).toBe(true);
    return response.data;
  };
  const projectId = (await cmd<{ project: { id: string } }>('project.open', { path: projectRoot })).project.id;
  const memberId = (await cmd<{ memberId: string }>('member.create', { projectId, displayName: '合成成员甲' })).memberId;
  // 本 turn 的写权限事实由 dispatch 快照：fake + acceptEdits + 项目授权 → modificationAuthorized=true。
  await cmd('member.setRuntime', { memberId, kind: 'fake', permissionMode: 'acceptEdits' });
  const room = (await cmd<{ items: Array<{ id: string; conversationId: string }> }>('room.list', { projectId })).items[0]!;
  await cmd('room.members.set', { roomId: room.id, memberId, action: 'add' });
  // 项目写入授权先于提交：本 turn 的 writeAccessMode 由 dispatch 快照记录（fullAccess=false，
  // modificationAuthorized=true → 快照只收项目内且本 turn diff 有写入证据的文件）。
  await cmd('project.writeAccess.set', { projectId, authorized: true, expectedRevision: 0 });
  const submitted = await cmd<{ taskId: string; threadId: string }>('message.submit', {
    target: { kind: 'room_root', projectId, roomId: room.id, conversationId: room.conversationId },
    body: '生成一份结果表',
    intent: 'default',
    mentions: [{ kind: 'member', memberId }],
  });
  const adapter = new FakeRuntimeAdapter({
    structuredFinal: false,
    turnScriptSequencer: (input) => scriptFor(resultKeyFromPrompt(input.text)),
  });
  const worker = new DispatchWorker({ db, adapter, leaseOwner: 'r91-structured-final', appDataDir: dir });
  await worker.runOnce();
  const task = db.prepare('SELECT id,status,conversation_thread_id FROM tasks WHERE id = ?').get(submitted.taskId) as
    { id: string; status: string; conversation_thread_id: string };
  const turn = db.prepare('SELECT id,status FROM agent_turns WHERE run_id IN (SELECT id FROM workflow_runs WHERE task_id = ?) ORDER BY rowid DESC LIMIT 1')
    .get(submitted.taskId) as { id: string; status: string };
  const agentMessages = db.prepare("SELECT id, body_json, status FROM messages WHERE task_id = ? AND author_type = 'agent' ORDER BY rowid")
    .all(submitted.taskId) as Array<{ id: string; body_json: string; status: string }>;
  const attachments = (messageId: string) => db.prepare(
    `SELECT ma.message_id, ma.display_name, a.id AS artifact_id, a.kind, a.hash
     FROM message_attachments ma JOIN artifacts a ON a.id = ma.artifact_id WHERE ma.message_id = ? ORDER BY ma.rowid`,
  ).all(messageId) as Array<{ message_id: string; display_name: string; artifact_id: string; kind: string; hash: string }>;
  return { dir, db, projectRoot, cmd, projectId, memberId, submitted, task, turn, agentMessages, attachments };
}

function cleanup(f: { db: ReturnType<typeof openDatabase>; dir: string }): void {
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
}

describe('R91 结构化终态可见回复（窄回归：禁止任意子串吞答案）', () => {
  it('状态前缀「不是最终结论。」+ TaskComplete.answer=「是。」：补全同一最终消息，文件卡不挂前缀', async () => {
    const f = await fixture((resultKey) => [
      { kind: 'writeFile', path: '结果表.csv', content: '姓名,分数\n甲,90\n' },
      { kind: 'event', event: { kind: 'message.completed', messageId: 'prefix', text: '不是最终结论。' } },
      { kind: 'event', event: { kind: 'turn.completed', finalText: complete(resultKey, '是。', ['结果表.csv']) } },
    ]);
    try {
      expect(f.task.status).toBe('DONE');
      expect(f.turn.status).toBe('SUCCEEDED');
      expect(f.agentMessages).toHaveLength(1); // 同一最终消息被补全，不是两条气泡
      const body = JSON.parse(f.agentMessages[0]!.body_json) as { text: string; runtimeControlResult?: string };
      expect(body.text).toBe('不是最终结论。\n\n是。'); // 完整答案可见（不是前缀吞掉“是。”）
      expect(body.text).not.toBe('不是最终结论。');
      const atts = f.attachments(f.agentMessages[0]!.id);
      expect(atts).toHaveLength(1);
      expect(atts[0]).toMatchObject({ display_name: '结果表.csv', kind: 'sheet_file' });
      expect(atts[0]!.hash).toBe(createHash('sha256').update(readFileSync(join(f.projectRoot, '结果表.csv'))).digest('hex'));
      // UI 真实读取通道：thread.history 的正文与附件摘要。
      const history = await f.cmd<{ items: Array<{ id: string; body: { text: string }; attachments: Array<{ artifactId: string; filename: string; kind: string; sizeBytes?: number }> }> }>('thread.history', { threadId: f.task.conversation_thread_id });
      const visible = history.items.find((item) => item.id === f.agentMessages[0]!.id)!;
      expect(visible.body.text).toBe('不是最终结论。\n\n是。');
      expect(visible.attachments).toHaveLength(1);
      expect(visible.attachments[0]).toMatchObject({ filename: '结果表.csv', kind: 'sheet_file' });
      expect(visible.attachments[0]!.sizeBytes).toBe(Buffer.byteLength('姓名,分数\n甲,90\n', 'utf8'));
      // 审计如实记录补全（不是静默改写）。
      const supplement = f.db.prepare("SELECT count(*) c FROM domain_events WHERE turn_id = ? AND kind = 'turn.structuredFinalSupplemented'").get(f.turn.id) as { c: number };
      expect(supplement.c).toBe(1);
    } finally {
      cleanup(f);
    }
  });

  it('仅 turn.completed（无 message.completed）：生成结构化最终回复，文件卡挂该消息', async () => {
    const f = await fixture((resultKey) => [
      { kind: 'writeFile', path: '结果表.csv', content: '姓名,分数\n乙,88\n' },
      { kind: 'event', event: { kind: 'turn.completed', finalText: complete(resultKey, '是。', ['结果表.csv']) } },
    ]);
    try {
      expect(f.task.status).toBe('DONE');
      expect(f.agentMessages).toHaveLength(1);
      expect(f.agentMessages[0]!.id).toBe(`msg_${f.turn.id}_structured_final`);
      const body = JSON.parse(f.agentMessages[0]!.body_json) as { text: string };
      expect(body.text).toBe('是。'); // 协议 JSON 不进正文
      const atts = f.attachments(f.agentMessages[0]!.id);
      expect(atts).toHaveLength(1);
      expect(atts[0]!.display_name).toBe('结果表.csv');
    } finally {
      cleanup(f);
    }
  });

  it('完整答案已可见：不重复补全、不新增气泡、文件卡仍挂原最终消息', async () => {
    const f = await fixture((resultKey) => [
      { kind: 'writeFile', path: '结果表.csv', content: '姓名,分数\n丙,77\n' },
      { kind: 'event', event: { kind: 'message.completed', messageId: 'complete', text: '是。' } },
      { kind: 'event', event: { kind: 'turn.completed', finalText: complete(resultKey, '是。', ['结果表.csv']) } },
    ]);
    try {
      expect(f.task.status).toBe('DONE');
      expect(f.agentMessages).toHaveLength(1);
      const body = JSON.parse(f.agentMessages[0]!.body_json) as { text: string };
      expect(body.text).toBe('是。'); // 不追加第二遍
      expect(f.attachments(f.agentMessages[0]!.id)).toHaveLength(1);
      const supplement = f.db.prepare("SELECT count(*) c FROM domain_events WHERE turn_id = ? AND kind = 'turn.structuredFinalSupplemented'").get(f.turn.id) as { c: number };
      expect(supplement.c).toBe(0);
    } finally {
      cleanup(f);
    }
  });
});
