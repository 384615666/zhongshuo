/**
 * PPTX 静态页预览（DEV-24 M3；第三十七轮四建立，第三十八轮四重写）：受控转换+版本绑定缓存+分列。
 * - 真实幻灯片列表（sldIdLst 顺序，含跳号）；当前页内容（形状坐标/文本/图片内联）；缩放=SVG 矢量；
 * - 重活进 parsePool 可终止子进程（kind='pptx-pages'，载荷走 outPath 文件）；
 * - 缓存命中也核对原件（readVerifiedBlob 先行——原件损坏不再回旧缓存）；
 * - 严格缓存校验（schema 2：结构/页序/尺寸/字节预算/SVG 白名单/转换器版本）；
 * - 五缺陷反例（第三十八轮确认）：①纯图表页静默白页→显式未渲染标注；②400 字截 300 不标→
 *   textTruncated；③XML 实体双重转义→先解码再安全输出；④277748B SVG 超 220KB 预算放行→
 *   按 UTF-8 字节核对+截断标注；⑤异常缓存（foreignObject/onclick/错页序/非法尺寸）过校验→拒。
 */
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { makePptxPagesSample, makePng } from '../../scripts/lib/craftDocuments.mjs';
import { safeUnzipWith as safeUnzip } from '../../src/daemon/zipGuard.ts';
import { buildPptxPages, validatePptxPagesCache, svgWellFormed, PAGE_SVG_MAX_BYTES, PPTX_PAGES_CONVERTER_VERSION } from '../../src/daemon/pptxPages.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_APP_DATA;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-pptxpages-'));
const appData = join(tmpRoot, 'app-data');
const blobRoot = join(appData, 'blobstore');
mkdirSync(blobRoot, { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* 句柄 */ } } });

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');

const PNG = makePng(4, 3);

/** 受控写入 blobstore 并登记 artifacts 行——经正式 uploadOffice 命令。 */
async function uploadPptx(bytes: Buffer, name: string): Promise<{ attachmentId: string; hash: string }> {
  const convId = 'conv_pp';
  const out = await dispatchDaemonCommand(
    { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData },
    { protocolVersion: 1, commandId: `up-${name}-${Math.random().toString(36).slice(2, 8)}`, method: 'attachment.uploadOffice', params: { conversationId: convId, filename: name, contentBase64: bytes.toString('base64') } },
  ) as { ok: boolean; data?: { attachmentId: string; hash: string }; error?: { message: string } };
  if (out.ok !== true || out.data == null) throw new Error(`uploadOffice 失败：${out.error?.message ?? 'unknown'}`);
  return { attachmentId: out.data.attachmentId, hash: out.data.hash };
}
const deps = () => ({ db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData });
type PagesData = {
  cache: string; totalSlides: number; pxW: number; pxH: number; hash: string; revision: number;
  slides: Array<{ slide: number; svg: string; truncated: boolean; textTruncated: boolean; shapes: number; images: number; unsupported: number; unsupportedKinds: string; notes: string; notesTruncated: boolean }>;
};
async function preview(attachmentId: string, commandId: string): Promise<{ ok: boolean; data?: PagesData; error?: { message: string } }> {
  return await dispatchDaemonCommand(deps(), { protocolVersion: 1, commandId, method: 'attachment.previewSlidesPages', params: { attachmentId } }) as never;
}

let db: ZhongshuoDatabase;
beforeAll(() => {
  db = openDatabase(join(appData, 'state.sqlite'));
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','p',?,?,'{}',0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_pp','p1','dm',NULL)`).run();
  db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','conv_pp','human','u_local'),('p1','conv_pp','agent','mA')`).run();
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','甲','agent',1)`).run();
});

describe('PPTX 静态页预览：受控转换（parsePool 子进程路径）', () => {
  it('真实幻灯片列表+当前页 SVG（形状坐标/文本/图片内联/备注）+缓存绑定版本+子进程路径', async () => {
    const emu = 9525;
    const bytes = makePptxPagesSample({
      slides: [
        {
          no: 1,
          shapes: [
            { x: 100 * emu, y: 80 * emu, cx: 400 * emu, cy: 120 * emu, texts: ['标题页：静态页预览', '副标题行'] },
            { x: 100 * emu, y: 240 * emu, cx: 200 * emu, cy: 100 * emu, kind: 'pic' },
          ],
          image: { name: 'img1.png', ext: 'png', mime: 'image/png', bytes: PNG },
          notes: '首页备注要点',
        },
        { no: 5, shapes: [{ x: 120 * emu, y: 90 * emu, cx: 300 * emu, cy: 90 * emu, texts: ['第二张（文件名跳号 5）'] }] },
      ],
    });
    const { attachmentId } = await uploadPptx(bytes, '静态页样本.pptx');
    const r = await preview(attachmentId, 'pp-preview-1');
    expect(r.ok).toBe(true);
    if (r.data == null) throw new Error(JSON.stringify(r.error));
    expect(r.data.cache).toBe('built');
    expect(r.data.totalSlides).toBe(2);
    expect(r.data.pxW).toBe(1280); // 12192000 EMU / 9525
    const s1 = r.data.slides[0]!;
    const s2 = r.data.slides[1]!;
    // 真实顺序（sldIdLst——跳号 5 仍是第 2 页）。
    expect(s1.slide).toBe(1);
    expect(s2.slide).toBe(2);
    // 当前页内容：SVG 文档完整 + 文本 + 图片 base64 内联 + 坐标。
    expect(s1.svg.startsWith('<svg')).toBe(true);
    expect(s1.svg).toContain('标题页：静态页预览');
    expect(s1.svg).toContain('data:image/png;base64,');
    expect(s1.svg).toContain(`x="${100}"`); // EMU→px 坐标
    expect(s1.svg).toContain('首页备注要点');
    expect(s2.svg).toContain('第二张（文件名跳号 5）');
    expect(s1.images).toBe(1);
    expect(s1.shapes).toBe(2);
    expect(s1.unsupported).toBe(0);
    // 命中路径（严格校验过——schema 2+转换器版本）。
    const r2 = await preview(attachmentId, 'pp-preview-2');
    expect(r2.data?.cache).toBe('hit');
  }, 180_000);

  it('反例①：纯图表页不再静默白页——graphicFrame 显式「图表（静态页不渲染）」标注', () => {
    const emu = 9525;
    const bytes = makePptxPagesSample({
      slides: [{ no: 1, shapes: [{ x: 100 * emu, y: 100 * emu, cx: 500 * emu, cy: 300 * emu, kind: 'chart' }] }],
    });
    const files = safeUnzip(bytes);
    const pages = buildPptxPages(files, (n) => files[n], sha(bytes));
    const s1 = pages.slides[0]!;
    expect(s1.unsupported).toBe(1);
    expect(s1.unsupportedKinds).toContain('图表');
    expect(s1.svg).toContain('图表（静态页不渲染）'); // 显式降级标注
    expect(s1.svg).toContain('<rect'); // 占位框存在——不是空白输出
    // 表格与组合同样标注（分组计数）。
    const bytes2 = makePptxPagesSample({
      slides: [
        {
          no: 1,
          shapes: [
            { x: 0, y: 0, cx: 300 * emu, cy: 200 * emu, kind: 'table', texts: ['表'] },
            { x: 0, y: 250 * emu, cx: 300 * emu, cy: 200 * emu, kind: 'grpSp' },
          ],
        },
      ],
    });
    const f2 = safeUnzip(bytes2);
    const p2 = buildPptxPages(f2, (n) => f2[n], sha(bytes2));
    expect(p2.slides[0]!.unsupported).toBe(2);
    expect(p2.slides[0]!.unsupportedKinds).toContain('表格');
    expect(p2.slides[0]!.unsupportedKinds).toContain('组合形状');
  }, 60_000);

  it('反例②：形状文本超字节预算截断必须置 textTruncated（旧实现 400 字无声截 300 不标）', () => {
    const emu = 9525;
    const long = '中'.repeat(500); // 500 字=1500B——SHAPE_TEXT_MAX_BYTES=1200B 截断（400 字整=预算内）
    const bytes = makePptxPagesSample({
      slides: [{ no: 1, shapes: [{ x: 50 * emu, y: 50 * emu, cx: 600 * emu, cy: 200 * emu, texts: [long] }] }],
    });
    const files = safeUnzip(bytes);
    const pages = buildPptxPages(files, (n) => files[n], sha(bytes));
    const s1 = pages.slides[0]!;
    expect(s1.textTruncated).toBe(true); // 截断可见
    const shown = /中+/.exec(s1.svg)?.[0]?.length ?? 0;
    expect(shown).toBe(400); // 1200B=400 字（旧实现按字符固定截 300——字节口径下 400 且有标记）
    expect(s1.truncated).toBe(false); // 页级预算未触
    // 超预算长文本（3 字/字×5000 字=15000B>1200B）→截断+flag+不再固定 300。
    const longer = '汉'.repeat(5000);
    const bytes2 = makePptxPagesSample({ slides: [{ no: 1, shapes: [{ x: 0, y: 0, cx: 600 * emu, cy: 400 * emu, texts: [longer] }] }] });
    const f2 = safeUnzip(bytes2);
    const p2 = buildPptxPages(f2, (n) => f2[n], sha(bytes2));
    expect(p2.slides[0]!.textTruncated).toBe(true);
    const shown2 = /汉+/.exec(p2.slides[0]!.svg)?.[0]?.length ?? 0;
    expect(shown2).toBe(400); // 1200B=400 字（不是旧实现的 300）
  }, 60_000);

  it('反例③：XML 实体先解码再安全输出——A &amp; B 不再变成 A &amp;amp; B', () => {
    const emu = 9525;
    // rawText=true：字面写入 a:t（XML 源形态即携带转义实体——真实 pptx 的形态）。
    const bytes = makePptxPagesSample({
      slides: [
        { no: 1, shapes: [{ x: 50 * emu, y: 50 * emu, cx: 400 * emu, cy: 100 * emu, texts: ['A &amp; B &lt;tag&gt; "q"'], rawText: true }] },
      ],
    });
    const files = safeUnzip(bytes);
    const pages = buildPptxPages(files, (n) => files[n], sha(bytes));
    const svg = pages.slides[0]!.svg;
    // 解码一次再转义：& 显示为 &amp;（单层）——旧实现双重转义成 &amp;amp;。
    expect(svg).toContain('A &amp; B');
    expect(svg).not.toContain('&amp;amp;');
    expect(svg).toContain('&lt;tag&gt;');
    expect(svg).not.toContain('&amp;lt;');
    // 数字字符引用同样解码（&#20013;=中）。
    const bytes2 = makePptxPagesSample({ slides: [{ no: 1, shapes: [{ x: 0, y: 0, cx: 300 * emu, cy: 100 * emu, texts: ['&#20013;文'], rawText: true }] }] });
    const f2 = safeUnzip(bytes2);
    const p2 = buildPptxPages(f2, (n) => f2[n], sha(bytes2));
    expect(p2.slides[0]!.svg).toContain('中文');
  }, 60_000);

  it('反例④：SVG 预算按 UTF-8 字节核对——350 形状×200 汉字（旧 277748B 放行）截断标注', () => {
    const emu = 9525;
    const shapes = Array.from({ length: 350 }, (_, i) => ({
      x: (i % 7) * 90 * emu, y: Math.floor(i / 7) * 40 * emu, cx: 80 * emu, cy: 30 * emu,
      texts: ['汉'.repeat(200)],
    }));
    const bytes = makePptxPagesSample({ slides: [{ no: 1, shapes }] });
    const files = safeUnzip(bytes);
    const pages = buildPptxPages(files, (n) => files[n], sha(bytes));
    const s1 = pages.slides[0]!;
    // 硬界：放行的每页 SVG 必须 ≤ 预算（字节口径）。
    expect(byteLen(s1.svg)).toBeLessThanOrEqual(PAGE_SVG_MAX_BYTES);
    // 超限页明确标注（丢图片内联救不回纯文本页→整页「未渲染」标注——不静默放行超预算内容）。
    expect(s1.truncated).toBe(true);
    expect(s1.svg).toContain('超静态预览上限');
  }, 60_000);

  it('反例⑤：异常缓存不再过校验——foreignObject/onclick/错页序/非法尺寸/超预算字节/SVG 白名单', async () => {
    const emu = 9525;
    const bytes = makePptxPagesSample({ slides: [{ no: 1, shapes: [{ x: 0, y: 0, cx: 400 * emu, cy: 100 * emu, texts: ['缓存反例基底'] }] }] });
    const files = safeUnzip(bytes);
    const h = sha(bytes);
    const good = buildPptxPages(files, (n) => files[n], h);
    expect(validatePptxPagesCache(JSON.stringify(good), h)).not.toBeNull(); // 基底通过
    // ①注入 foreignObject+onclick 的 SVG。
    const evil = JSON.parse(JSON.stringify(good)) as typeof good;
    evil.slides[0]!.svg = evil.slides[0]!.svg.replace('<rect', '<foreignObject onload="alert(1)"><div onclick="x()"><rect');
    expect(validatePptxPagesCache(JSON.stringify(evil), h)).toBeNull();
    expect(svgWellFormed(evil.slides[0]!.svg).ok).toBe(false);
    // ②javascript: URL。
    const evil2 = JSON.parse(JSON.stringify(good)) as typeof good;
    evil2.slides[0]!.svg = evil2.slides[0]!.svg.replace('<rect', '<image xlink:href="javascript:alert(1)" x="0" y="0" width="9" height="9"/><rect');
    expect(validatePptxPagesCache(JSON.stringify(evil2), h)).toBeNull();
    // ③页序错乱（slide 2,1）。
    const evil3 = JSON.parse(JSON.stringify(good)) as typeof good;
    evil3.slides = [{ ...evil3.slides[0]!, slide: 2 }];
    expect(validatePptxPagesCache(JSON.stringify(evil3), h)).toBeNull();
    // ④非法画布尺寸。
    const evil4 = JSON.parse(JSON.stringify(good)) as typeof good;
    (evil4 as unknown as { pxW: number }).pxW = 99999;
    expect(validatePptxPagesCache(JSON.stringify(evil4), h)).toBeNull();
    // ⑤转换器版本/旧 schema。
    const evil5 = JSON.parse(JSON.stringify(good)) as typeof good;
    (evil5 as unknown as { converterVersion: string }).converterVersion = 'pptx-pages-v1';
    expect(validatePptxPagesCache(JSON.stringify(evil5), h)).toBeNull();
    const legacy = JSON.stringify({ schema: 1, sourceHash: h, pxW: 1280, pxH: 720, slides: [{ slide: 1, svg: '<svg/>', truncated: false, shapes: 1, images: 0, notes: '' }] });
    expect(validatePptxPagesCache(legacy, h)).toBeNull(); // 旧 schema 全量作废
    // ⑥超预算字节 SVG（内容合法但超界）。
    const evil6 = JSON.parse(JSON.stringify(good)) as typeof good;
    evil6.slides[0]!.svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720"><text x="1" y="1" font-size="12" fill="#1e293b" font-family="system-ui,'Microsoft YaHei',sans-serif">${'汉'.repeat(80_000)}</text></svg>`;
    expect(byteLen(evil6.slides[0]!.svg)).toBeGreaterThan(PAGE_SVG_MAX_BYTES);
    expect(validatePptxPagesCache(JSON.stringify(evil6), h)).toBeNull();
    void PPTX_PAGES_CONVERTER_VERSION;
  }, 60_000);

  it('缓存命中也核对原件：原件损坏后命中路径拒绝（不再回旧缓存）', async () => {
    const emu = 9525;
    const bytes = makePptxPagesSample({ slides: [{ no: 1, shapes: [{ x: 0, y: 0, cx: 300 * emu, cy: 100 * emu, texts: ['原件核对基准'] }] }] });
    const up = await uploadPptx(bytes, '原件核对.pptx');
    const r1 = await preview(up.attachmentId, 'pp-verify-1');
    expect(r1.data?.cache).toBe('built');
    // 篡改托管副本（缓存仍有效——但原件 hash 已不符）。
    const row = db.prepare('SELECT blob_path FROM artifacts WHERE id = ?').get(up.attachmentId) as { blob_path: string };
    writeFileSync(row.blob_path, 'corrupted-not-a-pptx'); // blob_path 为绝对路径
    const r2 = await preview(up.attachmentId, 'pp-verify-2');
    expect(r2.ok).toBe(false); // 命中不再豁免原件核对
    expect(r2.error?.message ?? '').toMatch(/sha256|不符|损坏|缺失/);
  }, 180_000);

  it('版本绑定：重传新版本（新 hash）→旧缓存弃用重建；分列失败不影响提取文本', async () => {
    const v1 = makePptxPagesSample({ slides: [{ no: 1, shapes: [{ x: 0, y: 0, cx: 2000000, cy: 1000000, texts: ['旧版本内容 V1'] }] }] });
    const up1 = await uploadPptx(v1, '版本绑定A.pptx');
    const r1 = await preview(up1.attachmentId, 'pp-vbind-01');
    if (r1.data == null || r1.data.slides?.[0] == null) throw new Error(`v1 预览无数据：${JSON.stringify(r1).slice(0, 240)}`);
    expect(r1.data.slides[0]!.svg).toContain('旧版本内容 V1');
    const v2 = makePptxPagesSample({ slides: [{ no: 1, shapes: [{ x: 0, y: 0, cx: 2000000, cy: 1000000, texts: ['新版本内容 V2 重签'] }] }] });
    const up2 = await uploadPptx(v2, '版本绑定B.pptx');
    expect(up2.hash).not.toBe(up1.hash);
    const r2 = await preview(up2.attachmentId, 'pp-vbind-02');
    expect(r2.data?.slides[0]?.svg).toContain('新版本内容 V2 重签');
    // hash 不符→null（校验函数）。
    expect(validatePptxPagesCache(JSON.stringify({ schema: 2, converterVersion: PPTX_PAGES_CONVERTER_VERSION, sourceHash: 'deadbeef', pxW: 1280, pxH: 720, slides: [] }), up2.hash)).toBeNull();
    expect(validatePptxPagesCache(null, up2.hash)).toBeNull();
    // 图片缺失占位（不冒充）——提取文本通道不受影响（分列）。
    const emu = 9525;
    const bytes = makePptxPagesSample({ slides: [{ no: 1, shapes: [{ x: 0, y: 0, cx: 200 * emu, cy: 200 * emu, kind: 'pic' }] }] });
    const files = safeUnzip(bytes);
    delete files['ppt/media/img1.png'];
    const pages = buildPptxPages(files, (n) => files[n], sha(bytes));
    expect(pages.slides[0]!.svg).toContain('图片缺失');
    expect(pages.slides[0]!.images).toBe(0);
  }, 180_000);

  it('超页数明确拒绝（不静默截断列表）', () => {
    const many = Array.from({ length: 61 }, (_, i) => ({ no: i + 1, shapes: [{ x: 0, y: 0, cx: 1000, cy: 1000, texts: [`页${i + 1}`] }] }));
    const bytes = makePptxPagesSample({ slides: many });
    const files = safeUnzip(bytes);
    expect(() => buildPptxPages(files, (n) => files[n], sha(bytes))).toThrow(/超静态预览上限/);
  }, 60_000);
});
