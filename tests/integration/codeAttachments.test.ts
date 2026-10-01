/**
 * DEV-24 代码附件+基础评论（第二十七轮六）：
 * - 代码类按扩展名推导（kindForFilename：.ts/.py 等=code_file；.md/.txt=text_file）——同一
 *   读取/截断/完整性/注入链路；上传→引用→DM 派发→startTurn 实际输入含代码文本。
 * - 评论：行号/选区/正文入库锚定**评论时** artifact_hash/revision；资源更新（同名新内容=新
 *   资源）后旧评论 stale=true（读取比对当前 hash——行号锚点不漂移不重算）；audience=归属
 *   会话（跨会话拒绝）；行区间校验。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';
import { kindForFilename } from '../../src/daemon/attachments.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_APP_DATA;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-codeatt-'));
const appData = join(tmpRoot, 'app-data');
mkdirSync(appData, { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

const validDone = (): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: `m_${randomUUID().slice(0, 8)}`, text: '完成' } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: '完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
];

function makeEnv() {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?,'{}',0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r0','p1','大厅','mA')`).run();
  db.prepare('INSERT INTO room_members (room_id, member_id) VALUES (?, ?)').run('r0', 'mA');
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room','p1','room','r0')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('dm_a','p1','dm',NULL)`).run();
  db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','dm_a','human','u_local'),('p1','dm_a','agent','mA')`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData };
  const cmd = async <T,>(method: string, params: unknown): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `ca-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!r.ok) throw new Error(r.error?.message);
    return r.data as T;
  };
  const cmdRaw = async (method: string, params: unknown) =>
    await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `ca-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  const makeWorker = () => {
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => validDone() });
    return { worker: new DispatchWorker({ db, adapter, leaseOwner: `w-${randomUUID().slice(0, 4)}`, appDataDir: appData }), adapter };
  };
  return { db, cmd, cmdRaw, makeWorker, close: () => db.close() };
}

describe('代码附件（文本链路第二类）', () => {
  it('kind 按扩展名推导；四能力复用：上传/预览/引用/注入（startTurn 实际代码文本）', async () => {
    expect(kindForFilename('工具 脚本.py')).toBe('code_file');
    expect(kindForFilename('index.ts')).toBe('code_file');
    expect(kindForFilename('说明.md')).toBe('text_file');
    expect(kindForFilename('笔记.txt')).toBe('text_file');
    const env = makeEnv();
    const up = await env.cmd<{ attachmentId: string; hash: string }>('attachment.uploadText', { conversationId: 'dm_a', filename: '解析 器.ts', content: 'export function parse(): string {\n  return "CODE-MARK-4411";\n}\n' });
    const row = env.db.prepare('SELECT kind FROM artifacts WHERE id = ?').get(up.attachmentId) as { kind: string };
    expect(row.kind).toBe('code_file');
    const pv = await env.cmd<{ kind: string; text: string }>('attachment.previewText', { attachmentId: up.attachmentId });
    expect(pv.kind).toBe('code_file');
    expect(pv.text).toContain('CODE-MARK-4411');
    // 引用→DM 派发→模型输入含代码文本（同 text_file 链路）。
    await env.cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '按这个解析器实现', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId] });
    const { worker, adapter } = env.makeWorker();
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(1);
    expect(adapter.startTurnLog[0]!.text).toContain('CODE-MARK-4411');
    expect(adapter.startTurnLog[0]!.text).toContain('解析 器.ts');
    env.close();
  });
});

describe('附件基础评论（文本/代码/Markdown）', () => {
  it('行号/选区/正文锚定评论时版本；同名新内容=新资源→旧评论 stale（锚点不漂移）；跨会话拒绝；行区间校验', async () => {
    const env = makeEnv();
    const v1 = await env.cmd<{ attachmentId: string; hash: string }>('attachment.uploadText', { conversationId: 'dm_a', filename: '草稿 v1.md', content: '# 草稿\n第一行内容\n第二行内容\n' });
    const c1 = await env.cmd<{ commentId: string; anchoredRevision: number }>('attachment.comment.add', { attachmentId: v1.attachmentId, body: '第 2 行建议改为要点式', lineFrom: 2, lineTo: 2, quote: '第一行内容' });
    expect(c1.anchoredRevision).toBe(1);
    // 同名不同内容=不同资源（新 artifact 行）——原资源不变，评论仍锚 v1。
    const v2 = await env.cmd<{ attachmentId: string; hash: string }>('attachment.uploadText', { conversationId: 'dm_a', filename: '草稿 v1.md', content: '# 草稿 v2\n改写后的第一行\n' });
    expect(v2.hash).not.toBe(v1.hash);
    // 同一 artifact 被更新（revision 前进 + hash 变）——模拟资源版本演进（评论锚定旧版）。
    env.db.prepare('UPDATE artifacts SET revision = revision + 1, hash = ? WHERE id = ?').run(`${v1.hash.slice(0, 62)}ff`, v1.attachmentId);
    const list = await env.cmd<{ currentHash: string; items: Array<{ commentId: string; lineFrom: number | null; lineTo: number | null; quote: string | null; body: string; anchoredTo: { hash: string; revision: number }; stale: boolean }> }>('attachment.comment.list', { attachmentId: v1.attachmentId });
    expect(list.items).toHaveLength(1);
    const item = list.items[0]!;
    expect(item.commentId).toBe(c1.commentId);
    expect(item.lineFrom).toBe(2);
    expect(item.lineTo).toBe(2);
    expect(item.quote).toBe('第一行内容');
    expect(item.anchoredTo.revision).toBe(1); // 锚定评论时版本（不漂移）
    expect(item.stale).toBe(true); // 资源已更新——旧评论明确标旧
    // 跨会话评论拒绝（**他人 DM** 的附件——audience：u_local 不是 dm_b 参与者）。
    env.db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('dm_b','p1','dm',NULL)`).run();
    env.db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','dm_b','human','u_other'),('p1','dm_b','agent','mA')`).run();
    const otherAtt = await (async () => {
      const deps = { db: env.db, localUserId: 'u_other', interruptTurn: async () => {}, appDataDir: appData };
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `ca-o-${randomUUID().slice(0, 8)}`, method: 'attachment.uploadText', params: { conversationId: 'dm_b', filename: '他人 草稿.md', content: '他人内容' } }) as { ok: boolean; data?: { attachmentId: string }; error?: { message: string } };
      if (!r.ok) throw new Error(r.error?.message);
      return r.data!;
    })();
    const cross = await env.cmdRaw('attachment.comment.add', { attachmentId: otherAtt.attachmentId, body: '他人会话的附件评论' });
    expect(cross.ok).toBe(false);
    expect(String(cross.error?.message)).toContain('audience');
    const crossList = await env.cmdRaw('attachment.comment.list', { attachmentId: otherAtt.attachmentId });
    expect(crossList.ok).toBe(false); // 列表同样拒绝
    // 行区间校验。
    const badRange = await env.cmdRaw('attachment.comment.add', { attachmentId: v1.attachmentId, body: '区间反了', lineFrom: 5, lineTo: 2 });
    expect(badRange.ok).toBe(false);
    expect(String(badRange.error?.message)).toContain('行区间');
    env.close();
  });
});
