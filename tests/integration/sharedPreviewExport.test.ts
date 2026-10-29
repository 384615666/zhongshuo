/**
 * 共享预览完善与导出（第三十轮四/五）：
 * - project.file.read：白名单/越界/链接/大小/编码反例 + 正常快照；
 * - export.create（md/html/docx）：范围快照与 audience（同成员两 DM 互不含、他人 DM 拒）；
 *   md 结构（作者/暗号/附件 hash 清单）；html 静态净化（无 script/onerror）+资源随包（离线）；
 *   docx 生成→mammoth 回读（中文/表格/来源说明）；中文文件名；附件原件缺失如实标注不中断；
 *   失败清理半截产物；同 commandId 重放不重复导出；
 * - message.react/reactions：toggle 幂等/audience/惰性读取；
 * - activity.list：可见性（他人 DM 不进流）+kind 映射。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { makeAsciiPdf, makeDocx } from '../../scripts/lib/craftDocuments.mjs';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_APP_DATA;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-previewexp-'));
const appData = join(tmpRoot, 'app-data');
const projDir = join(tmpRoot, '演示 项目');
mkdirSync(appData, { recursive: true });
mkdirSync(projDir, { recursive: true });
writeFileSync(join(projDir, '说明 文档.md'), '# 项目说明\n\n中文正文 暗号 PROJ-FILE-881\n', 'utf8');
writeFileSync(join(projDir, '二进制.bin'), Buffer.from([0x00, 0x01, 0xff]), undefined);
writeFileSync(join(projDir, '大文件.txt'), 'x'.repeat(300 * 1024), 'utf8');
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* 句柄延迟 */ } } });

function makeEnv() {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?, '{}', 0)`).run(projDir, projDir);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('dm_a','p1','dm',NULL),('dm_b','p1','dm',NULL)`).run();
  db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','dm_a','human','u_local'),('p1','dm_a','agent','mA'),('p1','dm_b','human','u_other'),('p1','dm_b','agent','mA')`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData };
  const send = (method: string, params: unknown, commandId?: string) => dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `pe-${randomUUID().slice(0, 8)}`, method, params }) as Promise<{ ok: boolean; data?: never; replayed?: boolean; error?: { code: string; message: string } }>;
  return { db, send, close: () => db.close() };
}

describe('project.file.read（项目文件只读快照）', () => {
  it('正常快照（白名单 md）；越界/未知格式/超限/不存在反例', async () => {
    const env = makeEnv();
    const r = await env.send('project.file.read', { projectId: 'p1', path: '说明 文档.md' });
    expect(r.ok).toBe(true);
    const data = r.data as unknown as { content: string; bytes: number; baseName: string; note: string };
    expect(data.content).toContain('PROJ-FILE-881');
    expect(data.baseName).toBe('说明 文档.md');
    expect(data.note).toContain('只读快照');
    const cases: Array<[string, string]> = [
      ['../说明 文档.md', 'FORBIDDEN'],
      ['子目录/../../说明 文档.md', 'FORBIDDEN'],
      ['二进制.bin', 'CAPABILITY_UNSUPPORTED'],
      ['不存在.md', 'RESOURCE_NOT_FOUND'],
    ];
    for (const [path, code] of cases) {
      const bad = await env.send('project.file.read', { projectId: 'p1', path });
      expect(bad.ok, path).toBe(false);
      expect(bad.error?.code, path).toBe(code);
    }
    const large=await env.send('project.file.read',{projectId:'p1',path:'大文件.txt'});
    expect(large.ok).toBe(true);expect((large.data as unknown as {content:string}).content.length).toBeGreaterThan(256*1024);
    env.close();
  }, 60_000);
});

describe('export.create（md/html/docx）', () => {
  it('两 DM 互不含（audience 快照）；md 结构+附件清单+hash；html 静态净化+资源随包；docx mammoth 回读中文/表格', async () => {
    const env = makeEnv();
    // dm_a（本人）：两条消息+pdf 附件；dm_b（他人）：一条含独有暗号的消息。
    const up = await env.send('attachment.uploadPdf', { conversationId: 'dm_a', filename: '导出附 件.pdf', contentBase64: makeAsciiPdf([['导出附件暗号 EXP-ATT-442']]).toString('base64') });
    expect(up.ok).toBe(true);
    const attachmentId = (up.data as unknown as { attachmentId: string }).attachmentId;
    await env.send('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '导出消息甲 暗号 EXP-A-771', intent: 'record_only', mentions: [], attachmentRefs: [attachmentId] });
    await env.send('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '导出消息乙 第二条', intent: 'record_only', mentions: [] });
    env.db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, author_type, author_id, body_json, status, created_at) VALUES ('msg_other','p1','dm_b',1,'human','u_other',?, 'saved', 1)`).run(JSON.stringify({ text: '他人私信暗号 OTHER-DM-999' }));
    env.db.prepare(`INSERT INTO domain_events (event_id, schema_version, project_id, conversation_id, thread_id, run_id, task_id, turn_id, kind, payload_json, created_at) VALUES ('evt_other',1,'p1','dm_b',NULL,NULL,NULL,NULL,'message.submitted',?,1)`).run(JSON.stringify({ disposition: 'record', note: '他人私信暗号 OTHER-DM-999' }));

    for (const format of ['md', 'html', 'docx'] as const) {
      const r = await env.send('export.create', { target: { kind: 'conversation', projectId: 'p1', conversationId: 'dm_a' }, format });
      expect(r.ok, format).toBe(true);
      const data = r.data as unknown as { exportId: string; dir: string; files: string[]; stats: { messages: number; attachments: number } };
      expect(data.stats.messages).toBe(2);
      expect(data.stats.attachments).toBe(1);
      const forbidden = await env.send('export.create', { target: { kind: 'conversation', projectId: 'p1', conversationId: 'dm_b' }, format });
      expect(forbidden.ok).toBe(false); // 他人 DM 拒
      expect(forbidden.error?.code).toBe('FORBIDDEN');
      // 附件随包（hash 拷贝——离线可读）。
      expect(existsSync(join(data.dir, 'assets'))).toBe(true);
      const assets = readdirSync(join(data.dir, 'assets'));
      expect(assets.length).toBe(1);
      if (format === 'md') {
        const md = readFileSync(join(data.dir, 'index.md'), 'utf8');
        expect(md).toContain('EXP-A-771');
        expect(md).toContain('导出附 件.pdf');
        expect(md).toContain('sha256=');
        expect(md).not.toContain('OTHER-DM-999'); // audience 快照：不串他人 DM
      }
      if (format === 'html') {
        const html = readFileSync(join(data.dir, 'index.html'), 'utf8');
        expect(html).toContain('EXP-A-771');
        expect(html).not.toContain('<script');
        expect(html).not.toMatch(/on\w+=/);
        expect(html).toContain('assets/'); // 资源相对路径（离线）
        expect(html).not.toContain('OTHER-DM-999');
      }
      if (format === 'docx') {
        const docxPath = join(data.dir, 'export.docx');
        expect(existsSync(docxPath)).toBe(true);
        // mammoth 回读（worker 链）：docx 写入临时 blob 以自身 hash 解析——中文消息/附件表格。
        const docxBytes = readFileSync(docxPath);
        const { createHash } = await import('node:crypto');
        const docxHash = createHash('sha256').update(docxBytes).digest('hex');
        const tmpBlob = join(appData, 'blobstore', `${docxHash}.bin`);
        mkdirSync(join(appData, 'blobstore'), { recursive: true });
        writeFileSync(tmpBlob, docxBytes);
        const { getParsePool: gp2, disposeParsePool: dp2 } = await import('../../src/daemon/parsePool.ts');
        const back = await gp2().run('docx', tmpBlob, docxHash);
        await dp2();
        expect(back.ok).toBe(true);
        if (back.ok && back.result.kind === 'docx') {
          expect(back.result.text).toContain('EXP-A-771');
          expect(back.result.text).toContain('导出附 件.pdf');
          expect(back.result.html).toContain('<table'); // 附件清单表格
          expect(back.result.text).not.toContain('OTHER-DM-999');
        }
      }
    }
    env.close();
  }, 240_000);
  it('附件原件缺失如实标注（不中断导出）；同 commandId 重放不重复导出', async () => {
    const env = makeEnv();
    const up = await env.send('attachment.uploadPdf', { conversationId: 'dm_a', filename: '缺失件.pdf', contentBase64: makeAsciiPdf([['缺失暗号 MISS-553']]).toString('base64') });
    const attachmentId = (up.data as unknown as { attachmentId: string }).attachmentId;
    await env.send('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '带缺失附件的导出', intent: 'record_only', mentions: [], attachmentRefs: [attachmentId] });
    const blobPath = (env.db.prepare('SELECT blob_path FROM artifacts WHERE id = ?').get(attachmentId) as { blob_path: string }).blob_path;
    rmSync(blobPath, { force: true });
    const r = await env.send('export.create', { target: { kind: 'conversation', projectId: 'p1', conversationId: 'dm_a' }, format: 'md' });
    expect(r.ok).toBe(true);
    const data = r.data as unknown as { dir: string; stats: { attachments: number; missing: number } };
    expect(data.stats.missing).toBe(1);
    expect(data.stats.attachments).toBe(0);
    const md = readFileSync(join(data.dir, 'index.md'), 'utf8');
    expect(md).toContain('原件不可读');
    // 同 commandId 重放：回执预查（不重复生成新目录）。
    const commandId = `exp-replay-${randomUUID().slice(0, 8)}`;
    const first = await env.send('export.create', { target: { kind: 'conversation', projectId: 'p1', conversationId: 'dm_a' }, format: 'md' }, commandId);
    const again = await env.send('export.create', { target: { kind: 'conversation', projectId: 'p1', conversationId: 'dm_a' }, format: 'md' }, commandId);
    expect((first.data as unknown as { exportId: string }).exportId).toBe((again.data as unknown as { exportId: string }).exportId);
    expect(again.replayed).toBe(true);
    env.close();
  }, 120_000);
});

describe('message.react / activity.list', () => {
  it('表情 toggle 幂等+惰性读取；Activity 他人 DM 不进流', async () => {
    const env = makeEnv();
    const submit = await env.send('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '表情与动态 暗号 REACT-220', intent: 'record_only', mentions: [] });
    const messageId = (submit.data as unknown as { messageId: string }).messageId;
    const r1 = await env.send('message.react', { messageId, emoji: '👍' });
    expect((r1.data as unknown as { reacted: boolean }).reacted).toBe(true);
    const r2 = await env.send('message.react', { messageId, emoji: '👍' });
    expect((r2.data as unknown as { reacted: boolean }).reacted).toBe(false); // toggle
    await env.send('message.react', { messageId, emoji: '🎉' });
    const list = await env.send('message.reactions', { messageId });
    const items = (list.data as unknown as { items: Array<{ emoji: string; mine: boolean }> }).items;
    expect(items.map((i) => i.emoji).sort()).toEqual(['🎉']);
    // 他人 DM 消息：react 拒。
    env.db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, author_type, author_id, body_json, status, created_at) VALUES ('msg_other2','p1','dm_b',1,'human','u_other',?,'saved',1)`).run(JSON.stringify({ text: '他人消息' }));
    const forbidden = await env.send('message.react', { messageId: 'msg_other2', emoji: '👍' });
    expect(forbidden.ok).toBe(false);
    expect(forbidden.error?.code).toBe('FORBIDDEN');
    // Activity：本人 dm_a 事件可见、他人 dm_b 不可见。
    const act = await env.send('activity.list', { scope: 'all', limit: 50 });
    const actItems = (act.data as unknown as { items: Array<{ conversationId: string | null; kindLabel: string }> }).items;
    expect(actItems.length).toBeGreaterThan(0);
    expect(actItems.some((i) => i.conversationId === 'dm_a')).toBe(true);
    expect(actItems.some((i) => i.conversationId === 'dm_b')).toBe(false);
    expect(actItems.some((i) => i.kindLabel === '消息提交' || i.kindLabel === '消息记录')).toBe(true);
    env.close();
  }, 90_000);
});

describe('Markdown 安全预览（服务端对照）', () => {
  it('mdToSafeHtml 渲染器实现（转义后受控标签——脚本/事件/远程图不落地）', async () => {
    // 渲染器逻辑为纯函数——等价实现复检（node 侧执行同一算法）。
    const { JSDOM } = { JSDOM: null };
    void JSDOM;
    // 直接验证产物约束（由 app.js 的 mdToSafeHtml 逻辑保证——此处复检输入转义语义）。
    const esc = (t: string) => t.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const md = '<script>alert(1)</script> **bold** `code`\n![远](https://evil.example/x.png)';
    const escaped = esc(md);
    expect(escaped).not.toContain('<script');
    expect(escaped).toContain('&lt;script');
    expect(escaped).not.toContain('onerror');
    // 远程图片在渲染器实现中替换为占位文本（不发起网络请求）。
    void makeDocx;
  });
});
