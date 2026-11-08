/**
 * R197 第 2/3/5 项：图片附件的**可读绝对路径**（复制消息 / 引用 / 消息图片右键「复制图片
 * 路径」共用的正式只读通道）。
 *
 * 合同（daemon）：attachment.absolutePath
 *  - 参数 { attachmentId, conversationId? }；audience 与 attachment.previewImage 完全一致
 *    （跨会话/他人私信拒绝；附件必须属于该会话）→ 失败 FORBIDDEN；
 *  - 仅 image_file；其他 kind 明确 CAPABILITY_UNSUPPORTED（不以扩展名冒充图片）；
 *  - 读托管原件（readVerifiedBlob：受控句柄 + 实际字节 sha256 核对）后按 magic bytes
 *    得到的 mime 定扩展名（png/jpg/gif/webp/bmp）；
 *  - 在 {appData}/attachment-paths/ 下生成 `{hash前16位}-{安全化原文件名主干}.{ext}` 的
 *    绝对路径副本（优先硬链原件，失败退回复制；已存在且大小一致复用）；
 *  - 返回 { attachmentId, filename, mime, path, bytes }；远程通道 FORBIDDEN（仅本机）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import zlib from 'node:zlib';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand, type DaemonCommandDeps } from '../../src/daemon/commands.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_APP_DATA;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-imgpath-'));
const appData = join(tmpRoot, 'app-data');
mkdirSync(appData, { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

/** 合成最小合法 PNG（1×1 灰度，带正确 CRC——daemon 只做 magic/IHDR 头部校验）。 */
function makePng(width = 1, height = 1): Buffer {
  const chunk = (type: Buffer, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crcBuf = Buffer.concat([type, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(crcBuf) >>> 0);
    return Buffer.concat([len, crcBuf, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8bit 灰度
  const idat = zlib.deflateSync(Buffer.from([0, 0xff]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk(Buffer.from('IHDR'), ihdr),
    chunk(Buffer.from('IDAT'), idat),
    chunk(Buffer.from('IEND'), Buffer.alloc(0)),
  ]);
}

interface AbsolutePathData {
  attachmentId: string; filename: string; mime: string; path: string; bytes: number;
}

function makeEnv() {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?,'{}',0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r0','p1','大厅','mA')`).run();
  db.prepare('INSERT INTO room_members (room_id, member_id) VALUES (?, ?)').run('r0', 'mA');
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room','p1','room','r0')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('dm_a','p1','dm',NULL)`).run();
  db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','dm_a','human','u_local'),('p1','dm_a','agent','mA')`).run();
  const deps: DaemonCommandDeps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData };
  const dispatch = async (targetDeps: DaemonCommandDeps, method: string, params: unknown) =>
    await dispatchDaemonCommand(targetDeps, { protocolVersion: 1, commandId: `ip-${randomUUID().slice(0, 8)}`, method, params }) as
      { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  const cmd = async <T,>(method: string, params: unknown): Promise<T> => {
    const r = await dispatch(deps, method, params);
    if (!r.ok) throw new Error(r.error?.message);
    return r.data as T;
  };
  const cmdRaw = async (method: string, params: unknown) => await dispatch(deps, method, params);
  return { db, deps, dispatch, cmd, cmdRaw, close: () => db.close() };
}

describe('R197 attachment.absolutePath：可读扩展名路径 + 原件字节一致 + 稳定复用', () => {
  it('上传 PNG 后返回 .png 绝对路径；文件存在且字节等于上传原件；重复调用同路径', async () => {
    const env = makeEnv();
    const png = makePng(32, 32);
    const up = await env.cmd<{ attachmentId: string; hash: string; bytes: number }>('attachment.uploadImage', {
      conversationId: 'dm_a', filename: '截图 演示.png', contentBase64: png.toString('base64'),
    });
    const abs = await env.cmd<AbsolutePathData>('attachment.absolutePath', { attachmentId: up.attachmentId });
    expect(abs.attachmentId).toBe(up.attachmentId);
    expect(abs.filename).toBe('截图 演示.png');
    expect(abs.mime).toBe('image/png');
    expect(abs.bytes).toBe(png.length);
    expect(isAbsolute(abs.path)).toBe(true);
    expect(abs.path.startsWith(appData)).toBe(true); // 路径只落在应用数据目录下
    expect(abs.path.startsWith(join(appData, 'attachment-paths'))).toBe(true);
    expect(abs.path.endsWith('.png')).toBe(true); // 可读扩展名（原件托管名是 {hash}.bin）
    expect(basename(abs.path).startsWith(`${up.hash.slice(0, 16)}-`)).toBe(true);
    expect(existsSync(abs.path)).toBe(true);
    expect(readFileSync(abs.path).equals(png)).toBe(true); // 字节等于上传原件（sha256 已核验）
    expect(statSync(abs.path).size).toBe(png.length);
    // 重复调用（渲染层缓存失效/重新进入对话）必须复用同一路径，不产生第二份。
    const again = await env.cmd<AbsolutePathData>('attachment.absolutePath', { attachmentId: up.attachmentId });
    expect(again.path).toBe(abs.path);
    expect(readFileSync(again.path).equals(png)).toBe(true);
    // 显式带同会话 conversationId 也放行（调用方拿到消息归属时可直接传）。
    const withConversation = await env.cmd<AbsolutePathData>('attachment.absolutePath', { attachmentId: up.attachmentId, conversationId: 'dm_a' });
    expect(withConversation.path).toBe(abs.path);
    env.close();
  });
});

describe('R197 attachment.absolutePath：只对图片、只对有权会话、只限本机', () => {
  it('非图片附件（text_file）明确拒绝，消息不含路径', async () => {
    const env = makeEnv();
    const up = await env.cmd<{ attachmentId: string }>('attachment.uploadText', {
      conversationId: 'dm_a', filename: '说明.md', content: '# 文本附件',
    });
    const rejected = await env.cmdRaw('attachment.absolutePath', { attachmentId: up.attachmentId });
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe('CAPABILITY_UNSUPPORTED');
    expect(String(rejected.error?.message)).toContain('非图片附件');
    env.close();
  });

  it('跨会话/他人私信（audience 校验）拒绝；附件不属于传入会话也拒绝', async () => {
    const env = makeEnv();
    const png = makePng(8, 8);
    const up = await env.cmd<{ attachmentId: string }>('attachment.uploadImage', {
      conversationId: 'dm_a', filename: '私有图.png', contentBase64: png.toString('base64'),
    });
    // 他人私信：本地用户不是参与者。
    env.db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('dm_b','p1','dm',NULL)`).run();
    env.db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','dm_b','human','u_other'),('p1','dm_b','agent','mA')`).run();
    const cross = await env.cmdRaw('attachment.absolutePath', { attachmentId: up.attachmentId, conversationId: 'dm_b' });
    expect(cross.ok).toBe(false);
    expect(cross.error?.code).toBe('FORBIDDEN');
    expect(String(cross.error?.message)).toContain('audience');
    // 附件归属 dm_a，却声称属于房间会话：同会话校验拒绝。
    const mismatched = await env.cmdRaw('attachment.absolutePath', { attachmentId: up.attachmentId, conversationId: 'conv_room' });
    expect(mismatched.ok).toBe(false);
    expect(mismatched.error?.code).toBe('FORBIDDEN');
    // 不存在的附件如实 404。
    const missing = await env.cmdRaw('attachment.absolutePath', { attachmentId: 'art_does_not_exist' });
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe('RESOURCE_NOT_FOUND');
    env.close();
  });

  it('远程通道 FORBIDDEN（本机路径不交给远程设备）', async () => {
    const env = makeEnv();
    const png = makePng(8, 8);
    const up = await env.cmd<{ attachmentId: string }>('attachment.uploadImage', {
      conversationId: 'dm_a', filename: '远程不可见.png', contentBase64: png.toString('base64'),
    });
    const remoteDeps: DaemonCommandDeps = { ...env.deps, remoteAudit: { deviceId: 'dev_1', authEpoch: 1 } };
    const remote = await env.dispatch(remoteDeps, 'attachment.absolutePath', { attachmentId: up.attachmentId });
    expect(remote.ok).toBe(false);
    expect(remote.error?.code).toBe('FORBIDDEN');
    expect(String(remote.error?.message)).toContain('仅限本机');
    env.close();
  });
});

describe('R197 attachment.absolutePath：文件名安全化且可读', () => {
  it('含中文与 Windows 非法字符：路径安全化（无分隔符/控制字符）、保留可读中文', async () => {
    const env = makeEnv();
    const png = makePng(4, 4);
    const dirtyName = '..\\..\\旅行 照片:第一天?.png';
    const up = await env.cmd<{ attachmentId: string; hash: string }>('attachment.uploadImage', {
      conversationId: 'dm_a', filename: dirtyName, contentBase64: png.toString('base64'),
    });
    const abs = await env.cmd<AbsolutePathData>('attachment.absolutePath', { attachmentId: up.attachmentId });
    const leaf = basename(abs.path);
    expect(leaf.endsWith('.png')).toBe(true);
    expect(leaf.startsWith(`${up.hash.slice(0, 16)}-`)).toBe(true);
    expect(leaf).toContain('旅行'); // 可读中文保留，便于用户辨认
    expect(leaf).not.toContain('..'); // 目录穿越被去掉
    for (const bad of ['/', '\\', ':', '?', '*', '"', '<', '>', '|']) expect(leaf).not.toContain(bad);
    expect(Array.from(leaf).every((ch) => { const code = ch.codePointAt(0) ?? 0; return code >= 0x20 && code !== 0x7f; })).toBe(true);
    const stem = leaf.slice(17, -'.png'.length);
    expect(stem.length).toBeLessThanOrEqual(40); // 长度上限 40
    expect(existsSync(abs.path)).toBe(true);
    expect(readFileSync(abs.path).equals(png)).toBe(true);
    env.close();
  });

  it('超长文件名截断到 40 字；清洗后为空的名字用 image', async () => {
    const env = makeEnv();
    const png = makePng(3, 3);
    const long = await env.cmd<{ attachmentId: string; hash: string }>('attachment.uploadImage', {
      conversationId: 'dm_a', filename: `${'很长的名字'.repeat(20)}.png`, contentBase64: png.toString('base64'),
    });
    const longAbs = await env.cmd<AbsolutePathData>('attachment.absolutePath', { attachmentId: long.attachmentId });
    const longLeaf = basename(longAbs.path);
    expect(longLeaf.startsWith(`${long.hash.slice(0, 16)}-`)).toBe(true);
    expect(longLeaf.slice(17, -'.png'.length).length).toBe(40);
    // 只有点的名字清洗后为空 → image（不生成空主干或纯点文件）。
    const dotOnly = await env.cmd<{ attachmentId: string; hash: string }>('attachment.uploadImage', {
      conversationId: 'dm_a', filename: '....png', contentBase64: png.toString('base64'),
    });
    const dotAbs = await env.cmd<AbsolutePathData>('attachment.absolutePath', { attachmentId: dotOnly.attachmentId });
    expect(basename(dotAbs.path)).toBe(`${dotOnly.hash.slice(0, 16)}-image.png`);
    env.close();
  });
});
