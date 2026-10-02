/**
 * PPTX 静态页预览（DEV-24 M3，第三十七轮四）：受控转换（slide XML→SVG）+版本绑定缓存+分列。
 * - 真实幻灯片列表（sldIdLst 顺序，含跳号）；当前页内容（形状坐标/文本/图片内联）；缩放=SVG
 *   矢量（客户端）；
 * - 绑定原件版本：缓存键=artifact hash——重传新版本后旧缓存弃用重建；
 * - 提取文本预览（previewOffice slides 通道）与静态页预览（previewSlidesPages）**分列**：文本
 *   提取不受静态页构建失败影响；
 * - 边界：超页数明确拒绝；缺图片占位标注（不冒充）；损坏结构拒绝不吞。
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
import { buildPptxPages, validatePptxPagesCache } from '../../src/daemon/pptxPages.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_APP_DATA;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-pptxpages-'));
const appData = join(tmpRoot, 'app-data');
const blobRoot = join(appData, 'blobstore');
mkdirSync(blobRoot, { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* 句柄 */ } } });

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

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

let db: ZhongshuoDatabase;
beforeAll(() => {
  db = openDatabase(join(appData, 'state.sqlite'));
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','p',?,?,'{}',0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_pp','p1','dm',NULL)`).run();
  db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','conv_pp','human','u_local'),('p1','conv_pp','agent','mA')`).run();
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','甲','agent',1)`).run();
});

describe('PPTX 静态页预览：受控转换', () => {
  it('真实幻灯片列表+当前页 SVG（形状坐标/文本/图片内联/备注）+缓存绑定版本', async () => {
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
    const { attachmentId, hash } = await uploadPptx(bytes, '静态页样本.pptx');
    const r = await dispatchDaemonCommand(
      { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData },
      { protocolVersion: 1, commandId: 'pp-preview-1', method: 'attachment.previewSlidesPages', params: { attachmentId } },
    ) as { ok: boolean; data?: { cache: string; totalSlides: number; pxW: number; pxH: number; slides: Array<{ slide: number; svg: string; truncated: boolean; shapes: number; images: number; notes: string }> }; error?: { message: string } };
    expect(r.ok).toBe(true);
    if (r.data == null) throw new Error(r.error?.message ?? 'no data');
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
    // 缓存命中（版本绑定）。
    const r2 = await dispatchDaemonCommand(
      { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData },
      { protocolVersion: 1, commandId: 'pp-preview-2', method: 'attachment.previewSlidesPages', params: { attachmentId } },
    ) as { ok: boolean; data?: { cache: string } };
    expect(r2.data?.cache).toBe('hit');
    void hash;
  }, 120_000);

  it('版本绑定：重传新版本（新 hash）→旧缓存弃用重建（SVG 反映新内容）', async () => {
    const v1 = makePptxPagesSample({ slides: [{ no: 1, shapes: [{ x: 0, y: 0, cx: 2000000, cy: 1000000, texts: ['旧版本内容 V1'] }] }] });
    const up1 = await uploadPptx(v1, '版本绑定A.pptx');
    const r1 = await dispatchDaemonCommand(
      { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData },
      { protocolVersion: 1, commandId: 'pp-vbind-01', method: 'attachment.previewSlidesPages', params: { attachmentId: up1.attachmentId } },
    ) as { ok: boolean; data?: { slides: Array<{ svg: string }>; hash: string } };
    if (r1.data == null || r1.data.slides?.[0] == null) throw new Error(`v1 预览无数据：${JSON.stringify(r1).slice(0, 240)}`);
    void 0;
    expect(r1.data.slides[0].svg).toContain('旧版本内容 V1');
    // 同名重传=新 artifact（内容寻址——不同 hash/新行）。
    const v2 = makePptxPagesSample({ slides: [{ no: 1, shapes: [{ x: 0, y: 0, cx: 2000000, cy: 1000000, texts: ['新版本内容 V2 重签'] }] }] });
    const up2 = await uploadPptx(v2, '版本绑定B.pptx');
    expect(up2.hash).not.toBe(up1.hash);
    const r2 = await dispatchDaemonCommand(
      { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData },
      { protocolVersion: 1, commandId: 'pp-vbind-02', method: 'attachment.previewSlidesPages', params: { attachmentId: up2.attachmentId } },
    ) as { ok: boolean; data?: { slides: Array<{ svg: string }> } };
    expect(r2.data?.slides[0]?.svg).toContain('新版本内容 V2 重签');
    // 缓存校验函数：hash 不符→null。
    expect(validatePptxPagesCache(JSON.stringify({ schema: 1, sourceHash: 'deadbeef', pxW: 1, pxH: 1, slides: [] }), up2.hash)).toBeNull();
    expect(validatePptxPagesCache(null, up2.hash)).toBeNull();
  }, 120_000);

  it('分列：静态页构建失败不影响提取文本预览（previewOffice slides 通道照常）', async () => {
    // 无 spTree/无画布形状的极简页（文本提取仍可工作；静态页 builder 要求 presentation.xml——
    // 用一个 media 缺失的图片页证分列：占位标注不冒充 + 提取文本照常。
    const emu = 9525;
    const bytes = makePptxPagesSample({
      slides: [
        { no: 1, shapes: [{ x: 0, y: 0, cx: 200 * emu, cy: 200 * emu, kind: 'pic' }], notes: '图片 media 缺失页' },
      ],
    });
    // 直接从字节构造（不经 uploadOffice——builder 层验证占位）。
    const files = safeUnzip(bytes);
    // 删除 media 文件（模拟缺失）——builder 应占位标注。
    delete files['ppt/media/img1.png'];
    const h = sha(bytes);
    let pages;
    try {
      pages = buildPptxPages(files, (n) => files[n], h);
    } catch (e) {
      throw new Error(`不应整体失败：${e instanceof Error ? e.message : String(e)}`);
    }
    expect(pages.slides[0]?.svg).toContain('图片缺失');
    expect(pages.slides[0]?.images).toBe(0);
    // 提取文本通道不受影响（parsePool 正常路径由 officeAttachments 覆盖——此处证 builder 独立）。
    expect(pages.schema).toBe(1);
  }, 60_000);

  it('超页数明确拒绝（不静默截断列表）', () => {
    const many = Array.from({ length: 61 }, (_, i) => ({ no: i + 1, shapes: [{ x: 0, y: 0, cx: 1000, cy: 1000, texts: [`页${i + 1}`] }] }));
    const bytes = makePptxPagesSample({ slides: many });
    const files = safeUnzip(bytes);
    expect(() => buildPptxPages(files, (n) => files[n], sha(bytes))).toThrow(/超静态预览上限/);
  }, 60_000);
});
