/**
 * Office 三类 + CSV + 图片能力门 + WebP 头（第二十九轮三/四）：
 * - DOCX：段落/表格有序提取+安全排版 HTML（白名单）；宏文档拒绝；
 * - XLSX：中文/空格/数字/日期/公式（不执行——无缓存值占位、有缓存值直读）/合并单元格/
 *   多 sheet；CSV：编码规则（UTF-8 BOM/UTF-16/不支持编码明确拒）；
 * - PPTX：按页文字+备注保序；
 * - 注入：表格**范围选择**（attachmentRanges→message_attachments.range_spec→组装按窗口），
 *   默认=有界默认窗口；越界/超窗口/坏格式在提交时明确拒绝；
 * - 图片能力门：IMAGE_INPUT_UNVERIFIED（无确认不发）；确认后注入「图片未发送+用户确认」
 *   说明；record_only 不设门；
 * - WebP VP8/VP8L/JPEG/GIF 头部样本：宽高可解析（头部≠像素解码——解码验证在渲染器）。
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
import {
  makeDocx, makeXlsx, makePptx, makeCsvText, makePng, makeJpegHeaderOnly, makeGifHeaderOnly,
  makeWebpVp8HeaderOnly, makeWebpVp8lHeaderOnly, makeMacroDocx, makePptxSlides, makePptxZipEntries, zipToBuffer,
} from '../../scripts/lib/craftDocuments.mjs';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_APP_DATA;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-office-'));
const appData = join(tmpRoot, 'app-data');
mkdirSync(appData, { recursive: true });
afterAll(async () => {
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
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r0','p1','大厅','mA')`).run();
  db.prepare('INSERT INTO room_members (room_id, member_id) VALUES (?, ?)').run('r0', 'mA');
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('dm_a','p1','dm',NULL)`).run();
  db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','dm_a','human','u_local'),('p1','dm_a','agent','mA')`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData };
  const cmd = async <T,>(method: string, params: unknown): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `of-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!r.ok) throw Object.assign(new Error(r.error?.message ?? 'error'), { code: r.error?.code });
    return r.data as T;
  };
  const cmdRaw = async (method: string, params: unknown) =>
    await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `of-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  const makeWorker = () => {
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => validDone() });
    return { worker: new DispatchWorker({ db, adapter, leaseOwner: `w-${randomUUID().slice(0, 4)}`, appDataDir: appData }), adapter };
  };
  return { db, cmd, cmdRaw, makeWorker, close: () => db.close() };
}

describe('DOCX', () => {
  it('段落+表格有序提取；安全排版 HTML（白名单零属性）；预览/注入分列', async () => {
    const env = makeEnv();
    const bytes = makeDocx({ paras: ['需求说明 第一段', '中文段落 表格如下'], table: [['列一', '列二'], ['甲值', '乙值']] });
    const up = await env.cmd<{ attachmentId: string; paragraphCount: number }>('attachment.uploadOffice', { conversationId: 'dm_a', filename: '说明.docx', contentBase64: bytes.toString('base64') });
    expect(up.paragraphCount).toBeGreaterThanOrEqual(3);
    const pv = await env.cmd<{ html: string; text: string; pixelRendering: string; modelInput: string }>('attachment.previewOffice', { attachmentId: up.attachmentId });
    expect(pv.html).toContain('<table');
    expect(pv.html).toContain('甲值');
    expect(pv.html).not.toMatch(/on\w+=|href=|<script/i); // 白名单零属性/无脚本
    expect(pv.pixelRendering).toBe('safe-html+docx-preview'); // 第四十轮：视觉=渲染器侧 docx-preview（净化 HTML 保留为回退）
    expect(pv.modelInput).toBe('extracted-text');
    // 注入：有序文本进模型输入（非路径冒充已读）。
    await env.cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '按文档执行', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId] });
    const { worker, adapter } = env.makeWorker();
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(1);
    expect(adapter.startTurnLog[0]!.text).toContain('需求说明 第一段');
    expect(adapter.startTurnLog[0]!.text).toContain('乙值');
    env.close();
  }, 90_000);
  it('宏文档（macroEnabled 内容类型）明确拒绝', async () => {
    const env = makeEnv();
    const macro = makeMacroDocx();
    const r = await env.cmdRaw('attachment.uploadOffice', { conversationId: 'dm_a', filename: '宏.docm', contentBase64: macro.toString('base64') });
    expect(r.ok).toBe(false);
    expect(String(r.error?.message)).toContain('宏');
    env.close();
  }, 60_000);
});

describe('XLSX / CSV', () => {
  it('中文/空格/数字/日期/公式两态/合并/多 sheet；预览窗口如实标注', async () => {
    const env = makeEnv();
    const bytes = makeXlsx([
      { name: '数据', rows: [['名称', '数量', null], ['中文行一', 42, { formula: 'B2*2' }], ['带缓存', { formula: '5*2', cached: '10' }, ''], ['日期行', { date: 45123 }, '末列']], merges: ['A1:B1'] },
      { name: '汇总', rows: [['总计', 100]] },
    ]);
    const up = await env.cmd<{ attachmentId: string; sheets: number; sourceFormat: string }>('attachment.uploadOffice', { conversationId: 'dm_a', filename: '数据.xlsx', contentBase64: bytes.toString('base64') });
    expect(up.sheets).toBe(2);
    expect(up.sourceFormat).toBe('xlsx');
    const pv = await env.cmd<{ sheets: Array<{ name: string; cells: string[][]; merges: unknown[]; formulaMissing: boolean; rowCount: number; colCount: number }>; formulaExecution: string }>('attachment.previewOffice', { attachmentId: up.attachmentId });
    const s1 = pv.sheets[0]!;
    expect(s1.name).toBe('数据');
    expect(s1.cells[0]![0]).toBe('名称');
    expect(s1.cells[1]![1]).toBe('42'); // 数字
    expect(s1.cells[1]![2]).toContain('公式无缓存值'); // 公式不执行——无缓存值如实占位
    expect(s1.formulaMissing).toBe(true);
    expect(s1.cells[2]![1]).toBe('10'); // 有缓存值直读
    expect(s1.cells[3]![1]).toMatch(/^\d{4}-\d{2}-\d{2}T/); // 日期（numFmt14→Date→ISO）
    expect(s1.merges).toHaveLength(1); // 合并单元格
    expect(s1.rowCount).toBe(4);
    expect(pv.formulaExecution).toBe('never-cached-values-only');
    expect(pv.sheets[1]!.name).toBe('汇总');
    env.close();
  }, 90_000);
  it('范围选择注入：指定窗口进模型（列头/值/范围标注）；默认=有界默认窗口；坏格式/越界/超窗口拒绝', async () => {
    const env = makeEnv();
    const bytes = makeXlsx([{ name: '数据', rows: [['名称', '数量', '备注'], ['中文行一', 42, '甲'], ['行二', 7, '乙'], ['行三', 9, '丙'], ['行四', 11, '丁']] }]);
    const up = await env.cmd<{ attachmentId: string }>('attachment.uploadOffice', { conversationId: 'dm_a', filename: '范围.xlsx', contentBase64: bytes.toString('base64') });
    // ① 显式范围 A1:C2（表头+首行）。
    await env.cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '按范围执行', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId], attachmentRanges: { [up.attachmentId]: '数据!A1:C2' } });
    const { worker, adapter } = env.makeWorker();
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(1);
    const text1 = adapter.startTurnLog[0]!.text;
    expect(text1).toContain('【表格 XLSX】工作表「数据」');
    expect(text1).toContain('A1:C2');
    expect(text1).toContain('中文行一');
    expect(text1).not.toContain('行二'); // 范围外不注入（无界全量反例）
    const rangeSpec = (env.db.prepare('SELECT range_spec FROM message_attachments WHERE artifact_id = ?').get(up.attachmentId) as { range_spec: string }).range_spec;
    expect(rangeSpec).toBe('数据!A1:C2'); // 持久（迁移 036）
    // ② 默认（无范围）=有界默认窗口（首表 50×16——本例 5×3 全入但明确标注默认窗口）。
    await env.cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '默认窗口执行', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId] });
    const { worker: w2, adapter: a2 } = env.makeWorker();
    await w2.runOnce();
    expect(a2.startTurnLog[0]!.text).toContain('默认窗口');
    // ③ 坏格式 / 越界（超出实际行列）/ 超预览窗口 —— 提交时明确拒绝（零派发）。
    for (const spec of ['not a range', '数据!Z9:Z20', '数据!A1:D250']) {
      const r = await env.cmdRaw('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: `坏范围 ${spec}`, intent: 'default', mentions: [], attachmentRefs: [up.attachmentId], attachmentRanges: { [up.attachmentId]: spec } });
      expect(r.ok, `范围 ${spec} 应被拒绝`).toBe(false);
      expect(String(r.error?.message)).toMatch(/范围|注入/);
    }
    const { worker: w3, adapter: a3 } = env.makeWorker();
    await w3.runOnce();
    expect(a3.startTurnLog.length).toBe(0); // 被拒消息不派发
    env.close();
  }, 120_000);
  it('CSV：UTF-8 BOM/UTF-16LE 解码+分号嗅探；不支持编码明确拒绝（不静默转码）', async () => {
    const env = makeEnv();
    const plain = makeCsvText([['名称', '备注'], ['中文,带逗号', '含"引号"'], ['第二行', '普通']], ';');
    const up1 = await env.cmd<{ attachmentId: string; sourceFormat: string; sheets: number }>('attachment.uploadCsv', { conversationId: 'dm_a', filename: '表.csv', contentBase64: plain.toString('base64') });
    expect(up1.sourceFormat).toBe('csv');
    expect(up1.sheets).toBe(1);
    const pv = await env.cmd<{ encoding: string; sheets: Array<{ cells: string[][]; rowCount: number }> }>('attachment.previewOffice', { attachmentId: up1.attachmentId });
    expect(pv.encoding).toBe('utf-8');
    expect(pv.sheets[0]!.cells[1]![0]).toBe('中文,带逗号');
    expect(pv.sheets[0]!.cells[1]![1]).toBe('含"引号"'); // RFC4180 引号转义
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plain]);
    const up2 = await env.cmd<{ attachmentId: string }>('attachment.uploadCsv', { conversationId: 'dm_a', filename: '带bom.csv', contentBase64: bom.toString('base64') });
    const pv2 = await env.cmd<{ encoding: string }>('attachment.previewOffice', { attachmentId: up2.attachmentId });
    expect(pv2.encoding).toBe('utf-8-bom');
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('列一,列二\n中文,值', 'utf16le')]);
    const up3 = await env.cmd<{ attachmentId: string }>('attachment.uploadCsv', { conversationId: 'dm_a', filename: 'utf16.csv', contentBase64: utf16.toString('base64') });
    const pv3 = await env.cmd<{ encoding: string; sheets: Array<{ cells: string[][] }> }>('attachment.previewOffice', { attachmentId: up3.attachmentId });
    expect(pv3.encoding).toBe('utf-16le');
    expect(pv3.sheets[0]!.cells[1]![0]).toBe('中文');
    const gbkish = Buffer.concat([Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('\n1,2', 'latin1')]);
    const r = await env.cmdRaw('attachment.uploadCsv', { conversationId: 'dm_a', filename: 'gbk.csv', contentBase64: gbkish.toString('base64') });
    expect(r.ok).toBe(false);
    expect(String(r.error?.message)).toContain('编码');
    env.close();
  }, 120_000);
});

describe('PPTX', () => {
  it('真实顺序（sldIdLst）+关系定位备注（编号不一致）+孤立页排除+备注计入预算；注入页序；页图如实 unsupported', async () => {
    const env = makeEnv();
    // slide5→slide2 真实顺序（编号不连续重排）；slide5 的备注在 notesSlide3（错号）；
    // slide9 孤立未引用（不得混入）；slide2 备注超长（验证截断与备注计入总预算）。
    const longNotes = '长备注词'.repeat(30000); // 60KB×3 字节=180KB > 64KB 单页上限 → 截断
    const bytes = makePptxSlides({
      slides: [
        { no: 5, texts: ['第五页真身 顺序一', '要点甲'], notes: '错号备注 演讲词', notesNo: 3 },
        { no: 2, texts: ['第二页真身 顺序二'], notes: longNotes },
      ],
      orphanSlides: [9],
    });
    // 孤立页内容（存在文件但未被 sldIdLst 引用）——直接塞进 zip 不可经 makePptxSlides，另行以
    // 旧路径验证：此处 makePptxSlides 的 orphanSlides 仅登记内容类型；内容注入用第二个包。
    const up = await env.cmd<{ attachmentId: string; slides: number }>('attachment.uploadOffice', { conversationId: 'dm_a', filename: '顺序演示.pptx', contentBase64: bytes.toString('base64') });
    expect(up.slides).toBe(2);
    const pv = await env.cmd<{ slides: Array<{ slide: number; text: string; notes: string; truncated: boolean }>; totalSlides: number; totalTextBytes: number; truncatedTotal: boolean }>('attachment.previewOffice', { attachmentId: up.attachmentId });
    expect(pv.slides[0]!.slide).toBe(1); // 顺序位置（非文件编号）
    expect(pv.slides[0]!.text).toContain('第五页真身 顺序一');
    expect(pv.slides[0]!.notes).toContain('错号备注 演讲词'); // 经 slide5 的关系表定位到 notesSlide3
    expect(pv.slides[1]!.slide).toBe(2);
    expect(pv.slides[1]!.text).toContain('第二页真身 顺序二');
    expect(pv.slides[1]!.truncated).toBe(true); // 超长备注截断
    expect(Buffer.byteLength(pv.slides[1]!.notes, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    // 备注计入总预算：totalTextBytes ≥ 正文+已收备注字节。
    const sum = pv.slides.reduce((acc, sl) => acc + Buffer.byteLength(sl.text, 'utf8') + Buffer.byteLength(sl.notes, 'utf8'), 0);
    expect(pv.totalTextBytes).toBe(sum);
    const pv2 = await env.cmd<{ slides: Array<{ text: string }>; pixelRendering: string }>('attachment.previewOffice', { attachmentId: up.attachmentId });
    expect(pv2.pixelRendering).toBe('renderer-pptx-renderer'); // 第四十轮：视觉=渲染器侧 pptx-renderer——与文本输入分列
    // 注入：按真实顺序页标注。
    await env.cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '按幻灯片执行', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId] });
    const { worker, adapter } = env.makeWorker();
    await worker.runOnce();
    const text = adapter.startTurnLog[0]!.text;
    expect(text).toContain('[幻灯片 1]');
    expect(text).toContain('第五页真身 顺序一');
    expect(text).toContain('[幻灯片 1 备注]');
    expect(text).toContain('错号备注 演讲词');
    expect(text.indexOf('第五页真身')).toBeLessThan(text.indexOf('第二页真身')); // 顺序一在顺序二前
    env.close();
  }, 120_000);
  it('孤立未引用页排除（存在 slideN.xml 但不在 sldIdLst）', async () => {
    const env = makeEnv();
    // 用 zipToBuffer 直接造：sldIdLst 只引 slide1；slide7 文件存在但未引用。
    const bytes = zipToBuffer(makePptxZipEntries({
      presentationRids: [{ rid: 'rId1', target: 'slides/slide1.xml' }],
      slideFiles: { 1: ['正文真身 PAGE-1'], 7: ['孤立的第七页 ORPHAN-7'] },
      notes: {},
    }));
    const up = await env.cmd<{ attachmentId: string; slides: number }>('attachment.uploadOffice', { conversationId: 'dm_a', filename: '孤立页.pptx', contentBase64: bytes.toString('base64') });
    expect(up.slides).toBe(1);
    const pv = await env.cmd<{ slides: Array<{ text: string }>; totalSlides: number }>('attachment.previewOffice', { attachmentId: up.attachmentId });
    expect(pv.totalSlides).toBe(1);
    expect(pv.slides[0]!.text).toContain('PAGE-1');
    expect(JSON.stringify(pv.slides)).not.toContain('ORPHAN-7'); // 孤立页不混入
    env.close();
  }, 90_000);
});

describe('图片能力门（IMAGE_INPUT_UNVERIFIED）', () => {
  it('无确认→拒发且零派发；确认→注入「图片未发送+用户确认」；record_only 不设门', async () => {
    const env = makeEnv();
    const up = await env.cmd<{ attachmentId: string }>('attachment.uploadImage', { conversationId: 'dm_a', filename: '门禁图.png', contentBase64: makePng(8, 8).toString('base64') });
    // 无确认：拒绝（不悄悄省略图片冒充成功）。
    const blocked = await env.cmdRaw('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '看这张图执行', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId] });
    expect(blocked.ok).toBe(false);
    expect(String(blocked.error?.message)).toContain('IMAGE_INPUT_UNVERIFIED');
    expect((env.db.prepare("SELECT count(*) c FROM messages WHERE body_json LIKE '%看这张图执行%'").get() as { c: number }).c).toBe(0);
    // 确认（imageAck=omit-images）：消息落库+派发；注入明示图片未发送。
    await env.cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '看这张图执行', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId], imageAck: 'omit-images' });
    const { worker, adapter } = env.makeWorker();
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(1);
    const text = adapter.startTurnLog[0]!.text;
    expect(text).toContain('【图片附件未发送】');
    expect(text).toContain('仅发送文字');
    expect(text).not.toMatch(/data:image|像素内容/); // 不混入像素/伪内容
    // record_only：不派发→无门；保存成功。
    const saved = await env.cmdRaw('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '仅记录这张图', intent: 'record_only', mentions: [], attachmentRefs: [up.attachmentId] });
    expect(saved.ok).toBe(true);
    const { worker: w2, adapter: a2 } = env.makeWorker();
    await w2.runOnce();
    expect(a2.startTurnLog.length).toBe(0); // record_only 零派发
    env.close();
  }, 120_000);
});

describe('WebP/JPEG/GIF 头部样本（头部≠像素解码）', () => {
  it('VP8/VP8L/JPEG/GIF 头：宽高可解析（上传按头部限幅放行——像素解码验证在渲染器）', async () => {
    const env = makeEnv();
    const cases: Array<[string, Buffer, number, number]> = [
      ['vp8.webp', makeWebpVp8HeaderOnly(320, 200), 320, 200],
      ['vp8l.webp', makeWebpVp8lHeaderOnly(90, 60), 90, 60],
      ['head.jpg', makeJpegHeaderOnly(300, 160), 300, 160],
      ['head.gif', makeGifHeaderOnly(120, 80), 120, 80],
    ];
    for (const [filename, buf, w, h] of cases) {
      const up = await env.cmd<{ attachmentId: string; width: number; height: number; mime: string }>('attachment.uploadImage', { conversationId: 'dm_a', filename, contentBase64: buf.toString('base64') });
      expect(up.width, filename).toBe(w);
      expect(up.height, filename).toBe(h);
    }
    // 完整 PNG 对照（合法像素）。
    const png = await env.cmd<{ width: number; height: number }>('attachment.uploadImage', { conversationId: 'dm_a', filename: '完整.png', contentBase64: makePng(20, 10).toString('base64') });
    expect(png.width).toBe(20);
    env.close();
  }, 90_000);
  it('VP8 同步码缺失=损坏拒绝（不把任意 RIFF/WEBP 当图）', async () => {
    const env = makeEnv();
    const bad = Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 \x0a\x00\x00\x00'), Buffer.alloc(10, 0)]); // 同步码位全 0
    const r = await env.cmdRaw('attachment.uploadImage', { conversationId: 'dm_a', filename: '坏vp8.webp', contentBase64: bad.toString('base64') });
    expect(r.ok).toBe(false);
    env.close();
  }, 60_000);
});

describe('第四十轮·选型 A：previewOffice 视觉字节通道（includeBytes）', () => {
  it('slides/docx 带核验字节（hash 与原件一致）；sheet 不带字节；缺参不带；超限明确分列', async () => {
    const env = makeEnv();
    // PPTX：includeBytes → bytesBase64 与上传字节逐字节一致；pixelRendering=渲染器侧。
    const pptx = makePptx([{ texts: ['视觉字节通道 幻灯一'], notes: '备注一' }, { texts: ['幻灯二'] }]);
    const up1 = await env.cmd<{ attachmentId: string }>('attachment.uploadOffice', { conversationId: 'dm_a', filename: '通道.pptx', contentBase64: pptx.toString('base64') });
    const pv1 = await env.cmd<{ hash: string; bytesBase64?: string; visualBytesAvailable?: boolean; pixelRendering: string }>('attachment.previewOffice', { attachmentId: up1.attachmentId, includeBytes: true });
    expect(pv1.visualBytesAvailable).toBe(true);
    expect(typeof pv1.bytesBase64).toBe('string');
    const got = Buffer.from(pv1.bytesBase64!, 'base64');
    expect(got.equals(pptx)).toBe(true); // 原件逐字节一致（readVerifiedBlob 核验后返回）
    expect(pv1.pixelRendering).toBe('renderer-pptx-renderer');
    // 同附件不带 includeBytes → 无字节字段（旧调用面不受影响）。
    const pv1b = await env.cmd<{ bytesBase64?: string; visualBytesAvailable?: boolean }>('attachment.previewOffice', { attachmentId: up1.attachmentId });
    expect(pv1b.bytesBase64).toBeUndefined();
    expect(pv1b.visualBytesAvailable).toBeUndefined();
    // DOCX：同通道。
    const docx = makeDocx({ paras: ['视觉字节通道 Word'] });
    const up2 = await env.cmd<{ attachmentId: string }>('attachment.uploadOffice', { conversationId: 'dm_a', filename: '通道.docx', contentBase64: docx.toString('base64') });
    const pv2 = await env.cmd<{ bytesBase64?: string; visualBytesAvailable?: boolean }>('attachment.previewOffice', { attachmentId: up2.attachmentId, includeBytes: true });
    expect(pv2.visualBytesAvailable).toBe(true);
    expect(Buffer.from(pv2.bytesBase64!, 'base64').equals(docx)).toBe(true);
    // XLSX（sheet）：视觉=网格分列，includeBytes 也不带字节。
    const xlsx = makeXlsx([{ name: 'Sheet1', rows: [['a', '1']] }]);
    const up3 = await env.cmd<{ attachmentId: string }>('attachment.uploadOffice', { conversationId: 'dm_a', filename: '通道.xlsx', contentBase64: xlsx.toString('base64') });
    const pv3 = await env.cmd<{ bytesBase64?: string; visualBytesAvailable?: boolean; pixelRendering: string }>('attachment.previewOffice', { attachmentId: up3.attachmentId, includeBytes: true });
    expect(pv3.bytesBase64).toBeUndefined();
    expect(pv3.visualBytesAvailable).toBeUndefined();
    expect(pv3.pixelRendering).toBe('grid-preview');
    env.close();
  }, 120_000);
});
