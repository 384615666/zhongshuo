/**
 * 真实格式样本（第二十九轮三）：真实中文（Identity-H+ToUnicode 码位双射——此前 latin1
 * 冒充的样本中文已丢失）、CMap 解码（UniGB-UCS2-H——**依赖随包 cmaps**，隔离副本缺失
 * 时降级可证）、扫描件（图像页零文本如实）、加密（Standard R2/RC4——pdfjs PasswordException
 * 分类）、损坏。经命令面全链（上传→缓存→分页预览）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { getParsePool, disposeParsePool } from '../../src/daemon/parsePool.ts';
import { makeCjkToUnicodePdf, makeCmapPdf, makeImagePdf, makeEncryptedPdf, makeAsciiPdf } from '../../scripts/lib/craftDocuments.mjs';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_APP_DATA;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-realformat-'));
const appData = join(tmpRoot, 'app-data');
mkdirSync(appData, { recursive: true });
afterAll(async () => {
  delete process.env.ZS_PARSE_WORKER;
  await disposeParsePool();
  for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* 句柄延迟 */ } }
});

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
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `rf-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!r.ok) throw new Error(r.error?.message);
    return r.data as T;
  };
  const cmdRaw = async (method: string, params: unknown) =>
    await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `rf-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  return { db, cmd, cmdRaw, close: () => db.close() };
}

describe('真实中文 PDF（ToUnicode 码位双射）', () => {
  it('完整中文/行序/页码：缓存与分页预览逐字对上', async () => {
    const env = makeEnv();
    const bytes = makeCjkToUnicodePdf([
      ['众说协作平台 第一页', '关键暗号 中文暗号七三一'],
      ['第二页 预算与交付', '页码尾注 — 2 —'],
    ]);
    const up = await env.cmd<{ attachmentId: string; pages: number }>('attachment.uploadPdf', { conversationId: 'dm_a', filename: '真实中文 报告.pdf', contentBase64: bytes.toString('base64') });
    expect(up.pages).toBe(2);
    const pv1 = await env.cmd<{ text: string }>('attachment.previewPdf', { attachmentId: up.attachmentId, page: 1 });
    expect(pv1.text).toContain('众说协作平台');
    expect(pv1.text).toContain('中文暗号七三一');
    const pv2 = await env.cmd<{ text: string }>('attachment.previewPdf', { attachmentId: up.attachmentId, page: 2 });
    expect(pv2.text).toContain('第二页 预算与交付');
    expect(pv2.text).toContain('— 2 —');
    env.close();
  }, 60_000);
});

describe('CMap 解码（UniGB-UCS2-H——随包 cmaps 依赖可证）', () => {
  it('随包 cmaps 存在 → 预定义 CMap 字体提取正确中文', async () => {
    const env = makeEnv();
    const bytes = makeCmapPdf([['预定义字体解码测试', '中文 CMap 提取 5531']]);
    const up = await env.cmd<{ attachmentId: string }>('attachment.uploadPdf', { conversationId: 'dm_a', filename: 'CMap 样本.pdf', contentBase64: bytes.toString('base64') });
    const pv = await env.cmd<{ text: string }>('attachment.previewPdf', { attachmentId: up.attachmentId });
    expect(pv.text).toContain('预定义字体解码测试');
    expect(pv.text).toContain('5531');
    env.close();
  }, 60_000);
  it('隔离 worker 副本（无 cmaps 目录）→ 提取降级（依赖真实被消费，不是可选装饰）', async () => {
    // 复制 parse-worker.cjs 到无 cmaps 的目录并指为解析 worker：打包形态只认同目录 cmaps。
    const isolated = join(tmpRoot, 'isolated-worker');
    mkdirSync(isolated, { recursive: true });
    copyFileSync(join(process.cwd(), 'dist', 'dev-parse', 'parse-worker.cjs'), join(isolated, 'parse-worker.cjs'));
    const prev = process.env.ZS_PARSE_WORKER;
    process.env.ZS_PARSE_WORKER = join(isolated, 'parse-worker.cjs');
    await disposeParsePool(); // 复位单例——下次按新环境解析 worker 路径
    try {
      const env = makeEnv();
      const bytes = makeCmapPdf([['无资源降级探针', 'CMAP-DEP-9917']]);
      const r = await env.cmdRaw('attachment.uploadPdf', { conversationId: 'dm_a', filename: '降级样本.pdf', contentBase64: bytes.toString('base64') });
      if (r.ok) {
        const attachmentId = (r.data as { attachmentId: string }).attachmentId;
        const pv = await env.cmd<{ text: string }>('attachment.previewPdf', { attachmentId });
        expect(pv.text).not.toContain('无资源降级探针'); // 缺 CMap=降级（空/乱码），不冒充
      } else {
        expect(String(r.error?.message)).toMatch(/CMap|PDF|解析/); // 字体构建失败如实报错
      }
      env.close();
    } finally {
      if (prev === undefined) delete process.env.ZS_PARSE_WORKER;
      else process.env.ZS_PARSE_WORKER = prev;
      await disposeParsePool();
    }
  }, 90_000);
});

describe('扫描件（图像页）与加密', () => {
  it('扫描件：零文本层如实空页 + 页数/结构正确（视觉像素见渲染器验收）', async () => {
    const env = makeEnv();
    const bytes = makeImagePdf([
      { w: 64, h: 40, color: [200, 30, 30] },
      { w: 64, h: 40, color: [30, 30, 200] },
    ]);
    const up = await env.cmd<{ attachmentId: string; pages: number }>('attachment.uploadPdf', { conversationId: 'dm_a', filename: '扫描件.pdf', contentBase64: bytes.toString('base64') });
    expect(up.pages).toBe(2);
    const pv = await env.cmd<{ text: string; totalPages: number; ocr: string }>('attachment.previewPdf', { attachmentId: up.attachmentId, page: 2 });
    expect(pv.text.trim()).toBe(''); // 无文本=如实空（不虚构 OCR）
    expect(pv.totalPages).toBe(2);
    expect(pv.ocr).toBe('unsupported');
    env.close();
  }, 60_000);
  it('加密（Standard R2/RC4）：明确 pdf-encrypted 拒绝', async () => {
    const env = makeEnv();
    const bytes = makeEncryptedPdf(['机密内容 加密样本'], 'zs-pass-7595');
    const r = await env.cmdRaw('attachment.uploadPdf', { conversationId: 'dm_a', filename: '加密.pdf', contentBase64: bytes.toString('base64') });
    expect(r.ok).toBe(false);
    expect(String(r.error?.message)).toContain('加密');
    env.close();
  }, 60_000);
  it('损坏（缺 xref）：明确拒绝（沿用既有口径回归）', async () => {
    const env = makeEnv();
    const broken = Buffer.from('%PDF-1.4\n垃圾内容没有xref\n%%EOF\n', 'latin1');
    const r = await env.cmdRaw('attachment.uploadPdf', { conversationId: 'dm_a', filename: '损坏.pdf', contentBase64: broken.toString('base64') });
    expect(r.ok).toBe(false);
    const asciiOk = await env.cmdRaw('attachment.uploadPdf', { conversationId: 'dm_a', filename: '对照.pdf', contentBase64: makeAsciiPdf([['对照样本 REG-1']]).toString('base64') });
    expect(asciiOk.ok).toBe(true);
    env.close();
  }, 60_000);
});
