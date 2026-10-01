/**
 * 提取缓存伪造外壳与迟到回写（第三十轮三）：
 * - **伪造外壳**：仅改 parserVersion/塞超预算字符串进合法外壳 → validateExtractCache 判无效
 *   （适用解析器/真实版本/逐层字节一致性）→ 预览侧隔离重提回写；组装侧 fail-closed 不派发；
 * - **迟到回写防覆盖**：重提是慢路径——期间资源 revision 变化（重传/更新）→ 回写绑定读取时
 *   快照（id+hash+revision），受影响行=0 即放弃（内存结果供本次预览，不覆盖新资源缓存）。
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
import { getParsePool, disposeParsePool } from '../../src/daemon/parsePool.ts';
import { makeAsciiPdf } from '../../scripts/lib/craftDocuments.mjs';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_APP_DATA;
process.env.ZS_TEST_PARSE_HOOKS = '1';
delete process.env.ZS_TEST_PARSE_BUSY_MS;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-cacheint-'));
const appData = join(tmpRoot, 'app-data');
mkdirSync(appData, { recursive: true });
afterAll(async () => {
  delete process.env.ZS_TEST_PARSE_BUSY_MS;
  await disposeParsePool();
  for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* 句柄延迟 */ } }
});

const validDone = (): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: `m_${randomUUID().slice(0, 8)}`, text: '完成' } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: '完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
];

function makeEnv() {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?,'{}',0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('dm_a','p1','dm',NULL)`).run();
  db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','dm_a','human','u_local'),('p1','dm_a','agent','mA')`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData };
  const cmd = async <T,>(method: string, params: unknown): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `ci-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!r.ok) throw Object.assign(new Error(r.error?.message ?? 'error'), { code: r.error?.code });
    return r.data as T;
  };
  const cmdRaw = async (method: string, params: unknown) =>
    await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `ci-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  const makeWorker = () => {
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => validDone() });
    return { worker: new DispatchWorker({ db, adapter, leaseOwner: `w-${randomUUID().slice(0, 4)}`, appDataDir: appData }), adapter };
  };
  return { db, cmd, cmdRaw, makeWorker, close: () => db.close() };
}

describe('伪造外壳缓存', () => {
  it('parserVersion 篡改 → 无效；预览重提回写正确版本', async () => {
    const env = makeEnv();
    const up = await env.cmd<{ attachmentId: string }>('attachment.uploadPdf', { conversationId: 'dm_a', filename: '篡版.pdf', contentBase64: makeAsciiPdf([['篡版探针 VER-TAMPER-1']]).toString('base64') });
    const cache = JSON.parse((env.db.prepare('SELECT extracted_text_json j FROM artifacts WHERE id = ?').get(up.attachmentId) as { j: string }).j) as Record<string, unknown>;
    const completed0 = getParsePool().stats().completed;
    // ① 适用解析器对但版本伪造。
    const tamperedVersion = { ...cache, parserVersion: '0.0.0-fake' };
    env.db.prepare('UPDATE artifacts SET extracted_text_json = ? WHERE id = ?').run(JSON.stringify(tamperedVersion), up.attachmentId);
    const pv = await env.cmd<{ text: string; parser: string }>('attachment.previewPdf', { attachmentId: up.attachmentId });
    expect(pv.text).toContain('VER-TAMPER-1'); // 重提成功
    expect(pv.parser).not.toContain('0.0.0-fake'); // 回写为真实版本
    expect(getParsePool().stats().completed).toBe(completed0 + 1);
    // ② 适用解析器伪造（pdf 缓存标成 mammoth）。
    const tamperedName = { ...cache, parserName: 'mammoth' };
    env.db.prepare('UPDATE artifacts SET extracted_text_json = ? WHERE id = ?').run(JSON.stringify(tamperedName), up.attachmentId);
    const pv2 = await env.cmd<{ text: string }>('attachment.previewPdf', { attachmentId: up.attachmentId });
    expect(pv2.text).toContain('VER-TAMPER-1');
    env.close();
  }, 90_000);
  it('超预算字符串塞进合法外壳（bytes 不改）→ 无效：组装 fail-closed；预览重提回写', async () => {
    const env = makeEnv();
    const up = await env.cmd<{ attachmentId: string }>('attachment.uploadPdf', { conversationId: 'dm_a', filename: '外壳.pdf', contentBase64: makeAsciiPdf([['外壳探子 SHELL-773']]).toString('base64') });
    const cache = JSON.parse((env.db.prepare('SELECT extracted_text_json j FROM artifacts WHERE id = ?').get(up.attachmentId) as { j: string }).j) as { pages: Array<{ page: number; text: string; bytes: number; truncated: boolean }>; totalTextBytes: number };
    const forged = { ...cache, pages: [{ ...cache.pages[0]!, text: '超预算'.repeat(60_000) }] }; // ~700KB 文本但 bytes 沿旧值
    env.db.prepare('UPDATE artifacts SET extracted_text_json = ? WHERE id = ?').run(JSON.stringify(forged), up.attachmentId);
    // 组装 fail-closed（不以伪造外壳注入）。
    await env.cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '按外壳执行', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId] });
    const { worker, adapter } = env.makeWorker();
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(0);
    // 预览重提回写合法缓存。
    const pv = await env.cmd<{ text: string }>('attachment.previewPdf', { attachmentId: up.attachmentId });
    expect(pv.text).toContain('SHELL-773');
    const after = JSON.parse((env.db.prepare('SELECT extracted_text_json j FROM artifacts WHERE id = ?').get(up.attachmentId) as { j: string }).j) as { pages: Array<{ text: string }> };
    expect(after.pages[0]!.text).not.toContain('超预算'.repeat(10)); // 外壳已清除
    env.close();
  }, 120_000);
});

describe('迟到回写防覆盖', () => {
  it('重提期间 revision 变化 → 回写放弃（不覆盖新资源缓存行）', async () => {
    const env = makeEnv();
    const up = await env.cmd<{ attachmentId: string }>('attachment.uploadPdf', { conversationId: 'dm_a', filename: '迟到.pdf', contentBase64: makeAsciiPdf([['迟到探针 LATE-556']]).toString('base64') });
    env.db.prepare("UPDATE artifacts SET extracted_text_json = 'broken{not-json' WHERE id = ?").run(up.attachmentId);
    process.env.ZS_TEST_PARSE_BUSY_MS = '1200'; // 慢重提窗口
    try {
      const pending = env.cmdRaw('attachment.previewPdf', { attachmentId: up.attachmentId });
      await new Promise((r) => setTimeout(r, 250));
      // 重提期间资源被更新（revision+1——如重传同 id 换内容）：迟到旧解析不得覆盖。
      env.db.prepare('UPDATE artifacts SET revision = revision + 1 WHERE id = ?').run(up.attachmentId);
      const r = await pending;
      expect(r.ok).toBe(true); // 本次预览用内存结果（用户拿到的内容正确）
      const row = env.db.prepare('SELECT extracted_text_json j, revision FROM artifacts WHERE id = ?').get(up.attachmentId) as { j: string; revision: number };
      expect(row.revision).toBe(2);
      expect(row.j).toBe('broken{not-json'); // **未回写**——迟到结果不覆盖新版本资源行
    } finally {
      delete process.env.ZS_TEST_PARSE_BUSY_MS;
    }
    env.close();
  }, 90_000);
});
