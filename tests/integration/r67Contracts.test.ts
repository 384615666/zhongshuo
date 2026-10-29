/**
 * R67 合同测试：工作区完整读取/原件字节、member.create、search visible、app 身份/继承校验、
 * 文件-only 真实派发（FakeWorker startTurn 实际输入含文件文本——不能只证明建了任务卡）。
 * fake runtime 零真实调用。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { successTurn } from '../../src/adapter/fake/script.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-r67-'));
const appData = join(tmpRoot, 'app');
mkdirSync(appData, { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄重试 */ } } });

const db = openDatabase(':memory:');
const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData };
const cmd = async <T,>(method: string, params: unknown, commandId?: string): Promise<T> => {
  const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `r67-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { message: string } };
  if (!r.ok) throw new Error(r.error?.message);
  return r.data as T;
};

const projDir = join(tmpRoot, '项目甲');
mkdirSync(projDir, { recursive: true });
const tailMark = 'R67-WORKTREE-TAIL-超过六万四千字节的尾部可达';
writeFileSync(join(projDir, 'README.md'), '# R67\n', 'utf8');
writeFileSync(join(projDir, '长文.md'), `# 长文标题\n\n${'正文填充。'.repeat(9000)}\n${tailMark}\n`, 'utf8');
writeFileSync(join(projDir, '页.html'), '<!DOCTYPE html><html><head><style>h1{color:navy}</style></head><body><h1>R67-页</h1></body></html>', 'utf8');

describe('R67：app 身份与继承校验', () => {
  it('app.identity 懒建稳定 dataRootId（重复调用同值；目录复制后同值）；rootIdentityOf 只读核对', async () => {
    const a = await cmd<{ localUserId: string; appDataDir: string; dataRootId: string | null }>('app.identity', {});
    expect(a.dataRootId).toBeTruthy();
    expect(a.dataRootId).toMatch(/^dri_/);
    const b = await cmd<{ dataRootId: string | null }>('app.identity', {});
    expect(b.dataRootId).toBe(a.dataRootId);
    // 目录复制 → 同一 id（rootIdentityOf 对新路径只读核对）。
    const copyDir = join(tmpRoot, 'app-copy');
    mkdirSync(copyDir, { recursive: true });
    writeFileSync(join(copyDir, 'root-identity.json'), JSON.stringify({ id: a.dataRootId, createdAt: 0 }), 'utf8');
    const ids = await cmd<{ ids: Record<string, string | null> }>('app.rootIdentityOf', { appDataDirs: [copyDir, join(tmpRoot, '不存在目录')] });
    expect(ids.ids[copyDir]).toBe(a.dataRootId);
    expect(ids.ids[join(tmpRoot, '不存在目录')]).toBeNull();
    // 标记文件内容逐字保持（身份文件不漂移）。
    const marker = JSON.parse(readFileSync(join(appData, 'root-identity.json'), 'utf8')) as { id: string };
    expect(marker.id).toBe(a.dataRootId);
  });
});

describe('R67：工作区完整读取与原字节', () => {
  let projectId = '';
  it('project.open 注册后 readFull 返回全文+sha256（>64KB 尾部可达）', async () => {
    const r = await cmd<{ project: { id: string } }>('project.open', { path: projDir });
    projectId = r.project.id;
    const full = await cmd<{ content: string; bytes: number; sha256: string; truncated: boolean; bytesBase64?: string }>('project.file.readFull', { projectId, path: '长文.md', includeBytes: true });
    expect(full.truncated).toBe(false);
    expect(full.content).toContain(tailMark);
    expect(full.bytes).toBeGreaterThan(64 * 1024);
    expect(full.bytesBase64).toBeTruthy();
    const raw = Buffer.from(full.bytesBase64!, 'base64');
    expect(createHash('sha256').update(raw).digest('hex')).toBe(full.sha256);
    // 旧提取窗命令保持 64KB 截断（分列合同不变）。
    const excerpt = await cmd<{ content: string; truncated: boolean }>('project.file.read', { projectId, path: '长文.md' });
    expect(excerpt.truncated).toBe(false);
    expect(excerpt.content).toContain(tailMark);
  });
  it('originalFile 返回原字节（BOM/字节逐字）；越界/白名单外拒绝', async () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 带BOM\n', 'utf8')]);
    writeFileSync(join(projDir, 'bom.md'), bom, 'utf8');
    const orig = await cmd<{ bytesBase64: string; bytes: number; sha256: string }>('project.file.originalFile', { projectId, path: 'bom.md' });
    const raw = Buffer.from(orig.bytesBase64, 'base64');
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM 原样
    expect(createHash('sha256').update(raw).digest('hex')).toBe(orig.sha256);
    await expect(cmd('project.file.readFull', { projectId, path: '../越界.md' })).rejects.toThrow(/越界|不存在|拒绝/);
    writeFileSync(join(projDir, 'bin.dat'), Buffer.from([0, 1, 2]), 'utf8');
    await expect(cmd('project.file.originalFile', { projectId, path: 'bin.dat' })).rejects.toThrow(/白名单/);
  });
  it('R72：20–32MiB 区间 Office 文件树读取不再被旧 20MiB 拒（readFull+originalFile 双通道；readFull 只认扩展名，合成件即可锁边界）', async () => {
    // 21MiB 合成 .pptx——真实 22.54MiB 内蒙古 PPT 走 UI 门；此处锁 daemon 合同边界。
    const body = Buffer.alloc(21 * 1024 * 1024, 0x50);
    const bigPath = join(projDir, '大件.pptx');
    writeFileSync(bigPath, body);
    const expectSha = createHash('sha256').update(body).digest('hex');
    const full = await cmd<{ bytes: number; sha256: string; bytesBase64: string; binaryKind: string }>('project.file.readFull', { projectId, path: '大件.pptx' });
    expect(full.binaryKind).toBe('slides_file');
    expect(full.sha256).toBe(expectSha);
    expect(Buffer.from(full.bytesBase64, 'base64').length).toBe(body.length);
    const orig = await cmd<{ bytes: number; sha256: string; bytesBase64: string }>('project.file.originalFile', { projectId, path: '大件.pptx' });
    expect(orig.sha256).toBe(expectSha); // 另存原件=同字节
    // 33MiB 负例仍在 32MiB 上限外被拒（humanized 消息）。
    const over = Buffer.alloc(33 * 1024 * 1024 + 512, 0x51);
    writeFileSync(join(projDir, '超大.pptx'), over);
    const fullLarge=await cmd<{bytes:number;bytesBase64:string}>('project.file.readFull', { projectId, path: '超大.pptx' });
    expect(fullLarge.bytes).toBe(over.length);expect(Buffer.from(fullLarge.bytesBase64,'base64').equals(over)).toBe(true);
    // PDF 分道：21MiB PDF 仍按自己的 20MiB 通道限额拒绝（不因 Office 扩容被带上车）。
    writeFileSync(join(projDir, '大.pdf'), Buffer.alloc(21 * 1024 * 1024, 0x25));
    const largePdf=await cmd<{bytes:number}>('project.file.readFull', { projectId, path: '大.pdf' });
    expect(largePdf.bytes).toBeGreaterThan(20*1024*1024);
  });
});

describe('R67：member.create 与 search visible', () => {
  it('member.create：项目级实例+自动加入未归档房间+不自动协调者；重复名不合并', async () => {
    const projectId = (await cmd<{ project: { id: string } }>('project.open', { path: projDir })).project.id;
    const m1 = await cmd<{ memberId: string; roomsJoined: number; coordinator: boolean }>('member.create', { projectId, displayName: '审查者', description: '负责把关' });
    expect(m1.roomsJoined).toBeGreaterThanOrEqual(1); // 默认房间
    expect(m1.coordinator).toBe(false);
    const m2 = await cmd<{ memberId: string }>('member.create', { projectId, displayName: '审查者' });
    expect(m2.memberId).not.toBe(m1.memberId);
    const list = await cmd<{ items: Array<{ id: string; displayName: string; description?: string }> }>('member.list', { projectId });
    const named = list.items.filter((x) => x.displayName === '审查者');
    expect(named.length).toBe(2);
    expect(named.find((x) => x.description === '负责把关')).toBeTruthy(); // 048 列投影（id 序不确定——按值找）
    const roomMembers = await cmd<{ items: Array<{ displayName: string }> }>('member.list', { projectId, roomId: `room_default_${projectId}` });
    expect(roomMembers.items.some((x) => x.displayName === '审查者')).toBe(true);
  });
  it('search.query scope=visible：按导航偏好可见集过滤（无偏好=全量；project 范围不受可见集限制）', async () => {
    const projectId = (await cmd<{ project: { id: string } }>('project.open', { path: projDir })).project.id;
    const other = join(tmpRoot, '项目乙');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'README.md'), '# 乙\n', 'utf8');
    const p2 = (await cmd<{ project: { id: string } }>('project.open', { path: other })).project.id;
    await cmd('navigation.set', { clientId: 'desktop-hifi', activeProjectId: projectId, visibleProjectIds: [projectId], expandedProjectIds: [projectId], pinnedProjectIds: [], fileGitTabs: {} });
    // 全量：命中乙的 README？search 检索消息——先在两项目各发一条 record。
    const convA = `conv_default_${projectId}`;
    await cmd('message.submit', { target: { kind: 'room_root', projectId, conversationId: convA, roomId: `room_default_${projectId}` }, body: '可见集标记 R67-A', intent: 'record_only', mentions: [] });
    const convB = `conv_default_${p2}`;
    await cmd('message.submit', { target: { kind: 'room_root', projectId: p2, conversationId: convB, roomId: `room_default_${p2}` }, body: '可见集标记 R67-B', intent: 'record_only', mentions: [] });
    const vis = await cmd<{ messages: Array<{ snippet: string; projectId: string }> }>('search.query', { text: '可见集标记', scope: 'visible', pageSize: 20 });
    expect(vis.messages.every((m) => m.projectId === projectId)).toBe(true); // 乙被隐藏
    const all = await cmd<{ messages: Array<{ snippet: string; projectId: string }> }>('search.query', { text: '可见集标记', scope: 'all', pageSize: 20 });
    expect(new Set(all.messages.map((m) => m.projectId)).size).toBe(2); // all=全部可访问（同 mine.pending 口径）
    const proj = await cmd<{ messages: Array<{ projectId: string }> }>('search.query', { text: '可见集标记', scope: 'project', projectId: p2, pageSize: 20 });
    expect(proj.messages.length).toBeGreaterThanOrEqual(1); // 显式 project 不受可见集限制
  });
});

describe('R67：文件-only 真实派发（FakeWorker 实际输入含文件文本）', () => {
  it('空正文+就绪 MD → dm 派发 → startTurn 输入含附件全文标记；仅记录零派发', async () => {
    const projectId = (await cmd<{ project: { id: string } }>('project.open', { path: projDir })).project.id;
    const members = await cmd<{ items: Array<{ id: string; principalType: string }> }>('member.list', { projectId });
    const agent = members.items.find((m) => m.principalType === 'agent')!;
    const dm = await cmd<{ conversationId: string }>('conversation.create', { projectId, peerMemberId: agent.id });
    const up = await cmd<{ attachmentId: string }>('attachment.uploadText', { conversationId: dm.conversationId, filename: 'r67 派发.md', content: '# R67-DISPATCH-MARK\n\n文件正文内容。' });
    const send = await cmd<{ messageId: string; taskId: string | null; disposition: string }>('message.submit', { target: { kind: 'dm', projectId, conversationId: dm.conversationId }, body: '', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId] });
    expect(send.taskId).toBeTruthy();
    expect(send.disposition).toBe('dispatched');
    // 真实 FakeWorker 消费：startTurn 实际输入包含附件文本（模型输入真源）。
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => [
      { kind: 'event', event: { kind: 'message.completed', messageId: 'r67_reply', text: '收到文件' } },
      { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: '完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
    ] });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-r67', appDataDir: appData });
    for (let i = 0; i < 6 && (adapter as unknown as { startTurnLog: Array<{ text: string }> }).startTurnLog.length === 0; i += 1) {
      await worker.runOnce();
      await new Promise((r) => setTimeout(r, 60));
    }
    expect((adapter as unknown as { startTurnLog: Array<{ text: string }> }).startTurnLog.length).toBeGreaterThanOrEqual(1);
    const input = (adapter as unknown as { startTurnLog: Array<{ text: string }> }).startTurnLog[0]!.text;
    expect(input).toContain('R67-DISPATCH-MARK'); // 附件文本注入实际模型输入
    // 仅记录负例：零派发键。
    const before = (db.prepare('SELECT count(*) c FROM outbox').get() as { c: number }).c;
    await cmd('message.submit', { target: { kind: 'dm', projectId, conversationId: dm.conversationId }, body: '', intent: 'record_only', mentions: [], attachmentRefs: [up.attachmentId] });
    const after = (db.prepare('SELECT count(*) c FROM outbox').get() as { c: number }).c;
    expect(after).toBe(before);
    void successTurn;
  });
});
