/**
 * DOCX 真实布局验收（第三十一轮二）：mammoth 回读保留为结构验证——本文件用**真实 Word**
 * （COM 自动化）打开导出产物做布局层验证：
 * - 打开无修复提示（非法 XML/损坏在 DisplayAlerts=0 下抛 COM 错——repairError 如实记录）；
 * - 多页样本页数 ≥ 3（分页事实，非「生成成功」冒充）；长表格行数不丢；
 * - 全文 Content.Text 核对暗号（乱码/截断检出）；非法控制字符已清洗（XML 1.0 合法性）；
 * - 特殊字符（& < > " ' 制表/竖直制表/中文标点）保留不破坏文档；
 * - 缺失附件=⚠ 行如实呈现不中断；
 * - 尝试 Word→PDF（页图证据；Word 2007 无 Save as PDF 加载项时 pdfExport:false 如实报，
 *   不升级完成声明）。样本与证据复制到 artifacts 目录保留。
 * ZS_SKIP_WORD=1 跳过（无 Word 环境）——跳过时其余断言（导出成功+manifest）仍执行。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_APP_DATA;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-docxword-'));
const appData = join(tmpRoot, 'app-data');
// Each run keeps new synthetic evidence without overwriting archived historical files.
const evidenceDir = join(repoRoot, 'dist', 'test-artifacts', 'docx-word-evidence', `${Date.now()}-${process.pid}`);
mkdirSync(appData, { recursive: true });
mkdirSync(evidenceDir, { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* 句柄延迟 */ } } });

function makeEnv() {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?,'{}',0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('dm_a','p1','dm',NULL)`).run();
  db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','dm_a','human','u_local'),('p1','dm_a','agent','mA')`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData };
  const send = (method: string, params: unknown, commandId?: string) => dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `dw-${randomUUID().slice(0, 8)}`, method, params }) as Promise<{ ok: boolean; data?: never; error?: { code: string; message: string } }>;
  return { db, send, close: () => db.close() };
}

interface WordResult {
  engine: string | null; docx: string; opened: boolean; repairError: string | null; pages: number; words: number;
  tables: number; tableRows: number; markers: Record<string, boolean>; controlCharsLeft: boolean;
  textLength: number; pdfExport: boolean; pdfPath: string | null;
}

const WORD_EXE = 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE';

function wordCheck(docxPath: string, markers: string[], pdfPath: string | null): WordResult {
  const manifestPath = join(tmpRoot, `word-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(manifestPath, JSON.stringify({ docx: docxPath, markers, pdfPath, wordExe: WORD_EXE }, null, 2), 'utf8');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repoRoot, 'scripts', 'word-open-check.ps1'), '-ManifestPath', manifestPath], { timeout: 180_000, encoding: 'utf8' });
  if (r.status !== 0 || r.stdout == null || r.stdout.trim().length === 0) {
    throw new Error(`Word 检查脚本失败（status=${r.status}）：${(r.stderr ?? '').slice(0, 300)}`);
  }
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? '{}') as WordResult;
}

describe('DOCX 真实 Word 布局验收（固定样本）', () => {
  it('长中文多页样本：页数≥3、无修复、暗号全文可读', async () => {
    const env = makeEnv();
    const markers: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const tag = `DOCX-LONG-CH-${String(i).padStart(3, '0')}`;
      if (i % 10 === 0) markers.push(tag);
      const body = `${tag} 长中文样本段落：协同工作台的导出必须保留完整中文正文，本段用于验证 Word 实际分页与字符渲染不发生乱码或截断。`.repeat(8);
      await env.send('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body, intent: 'record_only', mentions: [] });
    }
    const r = await env.send('export.create', { target: { kind: 'conversation', projectId: 'p1', conversationId: 'dm_a' }, format: 'docx' });
    expect(r.ok).toBe(true);
    const data = r.data as unknown as { dir: string; manifest: { files: unknown[] } };
    const docxPath = join(data.dir, 'export.docx');
    expect(existsSync(docxPath)).toBe(true);
    copyFileSync(docxPath, join(evidenceDir, '长中文多页.docx'));
    if (process.env.ZS_SKIP_WORD === '1' || !existsSync(WORD_EXE)) { env.close(); return; }
    const w = wordCheck(docxPath, markers, join(evidenceDir, '长中文多页.pdf'));
    copyFileSync(docxPath, join(evidenceDir, '长中文多页.docx'));
    expect(w.engine ?? '').toContain('Microsoft Office'); // 真 Word（非 WPS 劫持实例）
    expect(w.opened).toBe(true);
    expect(w.repairError).toBeNull();
    expect(w.pages).toBeGreaterThanOrEqual(3);
    expect(w.controlCharsLeft).toBe(false);
    for (const m of markers) expect(w.markers[m], `暗号 ${m}`).toBe(true);
    expect(w.pdfExport).toBe(true); // 本机 Word 2007+Save as PDF 加载项可用（不可用时改此断言为如实 false 登记）
    env.close();
  }, 240_000);

  it('长表格样本：60 行附件清单不丢行（tableRows≥60）', async () => {
    const env = makeEnv();
    const ids: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      const up = await env.send('attachment.uploadText', { conversationId: 'dm_a', filename: `长表行-${String(i + 1).padStart(2, '0')}.txt`, content: `长表附件 ${i} 内容 ROW-TBL-${String(i + 1).padStart(2, '0')}` });
      expect(up.ok).toBe(true);
      ids.push((up.data as unknown as { attachmentId: string }).attachmentId);
    }
    await env.send('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '长表格导出宿主消息 TBL-HOST-01', intent: 'record_only', mentions: [], attachmentRefs: ids });
    const r = await env.send('export.create', { target: { kind: 'conversation', projectId: 'p1', conversationId: 'dm_a' }, format: 'docx' });
    expect(r.ok).toBe(true);
    const data = r.data as unknown as { dir: string };
    const docxPath = join(data.dir, 'export.docx');
    copyFileSync(docxPath, join(evidenceDir, '长表格60行.docx'));
    if (process.env.ZS_SKIP_WORD === '1' || !existsSync(WORD_EXE)) { env.close(); return; }
    const w = wordCheck(docxPath, ['长表行-01.txt', '长表行-60.txt', 'TBL-HOST-01'], join(evidenceDir, '长表格60行.pdf'));
    copyFileSync(docxPath, join(evidenceDir, '长表格60行.docx'));
    expect(w.opened).toBe(true);
    expect(w.repairError).toBeNull();
    expect(w.tables).toBeGreaterThanOrEqual(1);
    expect(w.tableRows).toBeGreaterThanOrEqual(60); // 不丢行（截断=行数<60）
    expect(w.markers['长表行-01.txt']).toBe(true);
    expect(w.markers['长表行-60.txt']).toBe(true);
    expect(w.pdfExport).toBe(true);
    env.close();
  }, 240_000);

  it('特殊字符样本：&<>"\'/制表/竖直制表/中文标点——控制字符清洗、特殊字符保留', async () => {
    const env = makeEnv();
    const vtab = String.fromCharCode(11);
    await env.send('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: `特殊字符 SPEC-${vtab}-CH-77：& < > " ' / \\ 半角与「中文引号」《书名号》·——破折号……省略号`, intent: 'record_only', mentions: [] });
    const r = await env.send('export.create', { target: { kind: 'conversation', projectId: 'p1', conversationId: 'dm_a' }, format: 'docx' });
    expect(r.ok).toBe(true);
    const data = r.data as unknown as { dir: string };
    const docxPath = join(data.dir, 'export.docx');
    copyFileSync(docxPath, join(evidenceDir, '特殊字符.docx'));
    if (process.env.ZS_SKIP_WORD === '1' || !existsSync(WORD_EXE)) { env.close(); return; }
    const w = wordCheck(docxPath, ['SPEC--CH-77', '& < > " \' /', '「中文引号」《书名号》'], join(evidenceDir, '特殊字符.pdf'));
    copyFileSync(docxPath, join(evidenceDir, '特殊字符.docx'));
    expect(w.opened).toBe(true);
    expect(w.repairError).toBeNull();
    expect(w.controlCharsLeft).toBe(false); // 竖直制表等非法 XML 控制字符已清洗
    expect(w.markers['「中文引号」《书名号》']).toBe(true);
    expect(w.markers['SPEC--CH-77']).toBe(true); // vtab 被清洗后暗号两半相连
    env.close();
  }, 240_000);

  it('缺失附件样本：导出不中断、⚠ 行如实呈现', async () => {
    const env = makeEnv();
    const up = await env.send('attachment.uploadText', { conversationId: 'dm_a', filename: '缺失表格件.txt', content: 'MISS-DOCX-55 内容' });
    const attachmentId = (up.data as unknown as { attachmentId: string }).attachmentId;
    await env.send('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '缺失附件导出宿主 MISS-HOST-42', intent: 'record_only', mentions: [], attachmentRefs: [attachmentId] });
    rmSync((env.db.prepare('SELECT blob_path FROM artifacts WHERE id = ?').get(attachmentId) as { blob_path: string }).blob_path, { force: true });
    const r = await env.send('export.create', { target: { kind: 'conversation', projectId: 'p1', conversationId: 'dm_a' }, format: 'docx' });
    expect(r.ok).toBe(true);
    const data = r.data as unknown as { dir: string; stats: { missing: number; attachments: number } };
    expect(data.stats.missing).toBe(1);
    expect(data.stats.attachments).toBe(0);
    const docxPath = join(data.dir, 'export.docx');
    copyFileSync(docxPath, join(evidenceDir, '缺失附件.docx'));
    if (process.env.ZS_SKIP_WORD === '1' || !existsSync(WORD_EXE)) { env.close(); return; }
    const w = wordCheck(docxPath, ['MISS-HOST-42', '原件不可读'], join(evidenceDir, '缺失附件.pdf'));
    copyFileSync(docxPath, join(evidenceDir, '缺失附件.docx'));
    expect(w.opened).toBe(true);
    expect(w.repairError).toBeNull();
    expect(w.markers['MISS-HOST-42']).toBe(true);
    expect(w.markers['原件不可读']).toBe(true); // ⚠ 行在表格中如实呈现
    env.close();
  }, 240_000);

  it('OOXML 结构断言（不依赖 Word）：w:color w:val/tblGrid/document.xml.rels styles 关系', async () => {
    // 直接复检长中文样本产物内部结构（zip 解包断言——Word 之外的结构层证据）。
    const docxPath = join(evidenceDir, '长表格60行.docx'); // 含表格样本（tblGrid 断言需要）
    const raw = readFileSync(docxPath);
    const { unzipSync } = await import('fflate');
    const files = unzipSync(new Uint8Array(raw)) as Record<string, Uint8Array<ArrayBuffer>>;
    const dec = (b: Uint8Array) => Buffer.from(b).toString('utf8');
    const document = dec(files['word/document.xml']!);
    const rels = dec(files['_rels/.rels']!);
    const docRels = dec(files['word/_rels/document.xml.rels']!);
    expect(document).not.toMatch(/<w color=/);      // 旧非法写法已消灭
    expect(document).toMatch(/<w:color w:val="[0-9A-F]{6}"\/>/);
    expect(document).toMatch(/<w:tblGrid>/);        // 表格带 tblGrid（已知修复触发器）
    expect(document).toMatch(/<w:gridCol w:w="\d+"\/>/);
    expect(rels).not.toMatch(/styles/);             // styles 不再挂包级 .rels
    expect(docRels).toMatch(/relationships\/styles/); // styles 关系在 document.xml.rels
    expect(document).toMatch(/<w:sectPr>/);         // 节属性（分页合法结构）
  }, 30_000);
});
