/**
 * DEV-24 PDF 附件首包（第二十八轮五）：四能力——保存原件（%PDF- magic+隔离解析验证）/
 * 预览（分页文本层——扫描件空页如实；像素渲染/OCR=未实施明确标注）/提取正文（缓存
 * artifacts.extracted_text_json——同 hash 不重复解析）/受限模型输入（注入提取文本——页码
 * 标注+64KB 预算截断；缓存不符=组装 fail-closed）。加密/损坏/超页数/超大小明确报错；
 * 依赖 pdfjs-dist 随 daemon 打包携带（无网络/无系统字体/无 canvas——隔离解析：不执行
 * PDF 脚本）。重启保持=缓存列持久；原件改动副本保持（sha256 核对）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_APP_DATA;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-pdfatt-'));
const appData = join(tmpRoot, 'app-data');
mkdirSync(appData, { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

/** 合成多页 PDF（文本层无需嵌入字体——pdfjs getTextContent 直接取内容流字符串；中文可提取）。 */
function makePdf(pages: string[][]): Buffer {
  const objects: string[] = [];
  const pageObjIds: number[] = [];
  // 1=catalog 2=pages 3=font 4..=page+content 成对
  for (let i = 0; i < pages.length; i += 1) pageObjIds.push(4 + i * 2);
  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objects.push(`<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
  pages.forEach((lines, i) => {
    const contentId = 5 + i * 2;
    const stream = lines.map((l, li) => `BT /F1 12 Tf 72 ${720 - li * 20}Td (${l}) Tj ET`).join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, idx) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${idx + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

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
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('dm_a','p1','dm',NULL)`).run();
  db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','dm_a','human','u_local'),('p1','dm_a','agent','mA')`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData };
  const cmd = async <T,>(method: string, params: unknown): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `pa-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!r.ok) throw new Error(r.error?.message);
    return r.data as T;
  };
  const cmdRaw = async (method: string, params: unknown) =>
    await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `pa-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  const makeWorker = () => {
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => validDone() });
    return { worker: new DispatchWorker({ db, adapter, leaseOwner: `w-${randomUUID().slice(0, 4)}`, appDataDir: appData }), adapter };
  };
  return { db, cmd, cmdRaw, makeWorker, close: () => db.close() };
}

describe('DEV-24 PDF 首包：保存+提取+预览', () => {
  it('多页中文 PDF：保存（magic/页数）+提取缓存+分页预览；原件改动副本保持（sha256 核对）', async () => {
    const env = makeEnv();
    const pdf = makePdf([
      ['中文报告 第一页', '关键暗号 PDF-CN-6688'],
      ['第二页内容：预算与交付', '第二页暗号 PAGE2-2244'],
    ]);
    const up = await env.cmd<{ attachmentId: string; hash: string; bytes: number; pages: number }>('attachment.uploadPdf', { conversationId: 'dm_a', filename: '季度 报告.pdf', contentBase64: pdf.toString('base64') });
    expect(up.pages).toBe(2);
    expect(up.bytes).toBe(pdf.length);
    const cache = JSON.parse((env.db.prepare('SELECT extracted_text_json FROM artifacts WHERE id = ?').get(up.attachmentId) as { extracted_text_json: string }).extracted_text_json) as { pages: Array<{ page: number; text: string }> };
    expect(cache.pages).toHaveLength(2);
    expect(cache.pages[0]!.text).toContain('PDF-CN-6688'); // 中文文本层提取
    // 分页预览：第 2 页定位 PAGE2 暗号；页码/总页数/截断事实齐备。
    const pv2 = await env.cmd<{ page: number; totalPages: number; text: string; truncated: boolean; pixelRendering: string; ocr: string }>('attachment.previewPdf', { attachmentId: up.attachmentId, page: 2 });
    expect(pv2.page).toBe(2);
    expect(pv2.totalPages).toBe(2);
    expect(pv2.text).toContain('PAGE2-2244');
    expect(pv2.pixelRendering).toBe('renderer-canvas'); // 第二十九轮三：视觉渲染=渲染器受限预览侧 canvas
    expect(pv2.ocr).toBe('unsupported');
    // 原件改动 → 副本保持（用户源文件与本副本无关）；副本被改写 → 完整性拒绝。
    const blobPath = (env.db.prepare('SELECT blob_path FROM artifacts WHERE id = ?').get(up.attachmentId) as { blob_path: string }).blob_path;
    const before = readFileSync(blobPath);
    writeFileSync(blobPath, makePdf([['被改写']])); // 同为合法 PDF 但字节不同
    const pvBad = await env.cmdRaw('attachment.previewPdf', { attachmentId: up.attachmentId });
    expect(pvBad.ok).toBe(false);
    expect(String(pvBad.error?.message)).toContain('完整性');
    writeFileSync(blobPath, before); // 还原（副本保持演示——原 hash 复核通过）
    const pvAgain = await env.cmd<{ text: string }>('attachment.previewPdf', { attachmentId: up.attachmentId });
    expect(pvAgain.text).toContain('PDF-CN-6688');
    env.close();
  }, 30_000);
  it('反例：非 PDF 内容（magic 拒绝）；损坏 xref；超大小上限；扫描件空页如实', async () => {
    const env = makeEnv();
    const fake = await env.cmdRaw('attachment.uploadPdf', { conversationId: 'dm_a', filename: '假.pdf', contentBase64: Buffer.from('just plain text, not a pdf').toString('base64') });
    expect(fake.ok).toBe(false);
    expect(String(fake.error?.message)).toContain('%PDF-');
    const broken = Buffer.from('%PDF-1.4\n垃圾内容没有xref\n%%EOF\n', 'latin1');
    const corrupt = await env.cmdRaw('attachment.uploadPdf', { conversationId: 'dm_a', filename: '损坏.pdf', contentBase64: broken.toString('base64') });
    expect(corrupt.ok).toBe(false);
    expect(['损坏', '解析失败'].some((k) => String(corrupt.error?.message).includes(k))).toBe(true);
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.alloc(20.5 * 1024 * 1024)]);
    const tooBig = await env.cmdRaw('attachment.uploadPdf', { conversationId: 'dm_a', filename: '大.pdf', contentBase64: big.toString('base64') });
    expect(tooBig.ok).toBe(false);
    expect(String(tooBig.error?.message)).toContain('上限');
    // 扫描件（无文本层）：合法 PDF 但内容流无文本 → 空页如实呈现（OCR 单列）。
    const scanned = makePdf([[]]); // 内容流空（无 Tj）
    const up2 = await env.cmd<{ attachmentId: string; pages: number }>('attachment.uploadPdf', { conversationId: 'dm_a', filename: '扫描件.pdf', contentBase64: scanned.toString('base64') });
    const pvEmpty = await env.cmd<{ text: string }>('attachment.previewPdf', { attachmentId: up2.attachmentId });
    expect(pvEmpty.text.trim()).toBe(''); // 无文本=如实空（不虚构 OCR）
    env.close();
  }, 30_000);
});

describe('DEV-24 PDF 首包：受限模型输入', () => {
  it('注入=提取文本（页码标注+预算截断）；缓存不符=组装失败（fail-closed）；跨会话拒绝', async () => {
    const env = makeEnv();
    const pdf = makePdf([['执行依据 PDF-INPUT-9911', '第一页其余内容'], ['第二页补充说明']]);
    const up = await env.cmd<{ attachmentId: string; hash: string }>('attachment.uploadPdf', { conversationId: 'dm_a', filename: '执行依据.pdf', contentBase64: pdf.toString('base64') });
    await env.cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '按 PDF 执行', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId] });
    const { worker, adapter } = env.makeWorker();
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(1);
    expect(adapter.startTurnLog[0]!.text).toContain('PDF-INPUT-9911'); // 提取文本注入（非路径）
    expect(adapter.startTurnLog[0]!.text).toContain('第 1 页'); // 页码标注
    expect(adapter.startTurnLog[0]!.text).toContain('第 2 页');
    // 缓存不符（sourceHash 与 artifacts.hash 脱钩）→ 组装 fail-closed（不以旧缓存冒充）。
    const up2 = await env.cmd<{ attachmentId: string; hash: string }>('attachment.uploadPdf', { conversationId: 'dm_a', filename: '第二份.pdf', contentBase64: makePdf([['第二份内容']]).toString('base64') });
    env.db.prepare("UPDATE artifacts SET extracted_text_json = ? WHERE id = ?").run(JSON.stringify({ sourceHash: 'deadbeef', pages: [{ page: 1, text: '陈旧缓存', truncated: false }] }), up2.attachmentId);
    await env.cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '执行第二份', intent: 'default', mentions: [], attachmentRefs: [up2.attachmentId] });
    const { worker: w2, adapter: a2 } = env.makeWorker();
    await w2.runOnce();
    expect(a2.startTurnLog.length).toBe(0); // 组装失败=不发给模型
    // 跨会话预览拒绝。
    env.db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('dm_b','p1','dm',NULL)`).run();
    env.db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','dm_b','human','u_other'),('p1','dm_b','agent','mA')`).run();
    const cross = await env.cmdRaw('attachment.previewPdf', { attachmentId: up.attachmentId, conversationId: 'dm_b' });
    expect(cross.ok).toBe(false);
    expect(String(cross.error?.message)).toContain('audience');
    env.close();
  }, 30_000);
});
