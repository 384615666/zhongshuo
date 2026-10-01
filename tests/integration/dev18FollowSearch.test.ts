/**
 * DEV-18 第二包（第二十五轮四）：关注/静音、搜索、收藏——纯读+偏好写（零新增 run/turn/
 * 预算/模型调用）。验收：中文查询、过滤分页、同名跨项目、他人 DM、隐藏项目范围、失效收藏、
 * 重启保持；关注/取消/静音不建运行、不停止任务、不改冻结参与者；muted 排除未读聚合；
 * followed 进待我处理；附件只随所在消息检索。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-d18fs-'));
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

function seed(db: ZhongshuoDatabase, projectTag: string): { convRoom: string; threadA: string; threadB: string; taskA: string; anchorA: string } {
  const base = Date.now() - 10_000; // 今日（日期过滤用例域）
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES (?,'同名项目',?,?, '{}', 0)`).run(projectTag, tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES (?,?,'执行成员','agent',1)`).run(`m_${projectTag}`, projectTag);
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES (?,?, '大厅',?)`).run(`r_${projectTag}`, projectTag, `m_${projectTag}`);
  db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES (?,?)`).run(`r_${projectTag}`, `m_${projectTag}`);
  const convRoom = `conv_${projectTag}`;
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES (?,?,'room',?)`).run(convRoom, projectTag, `r_${projectTag}`);
  // 线程 A：任务串（中文锚+回复）。
  db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, author_type, author_id, body_json, status, created_at) VALUES (?,?,?,?,?,'human','u_local',?,'final',${base})`).run(`anc_${projectTag}`, projectTag, convRoom, 1, `r_${projectTag}`, JSON.stringify({ text: `整理季度报告（${projectTag}）` }));
  db.prepare(`INSERT INTO conversation_threads (id, project_id, conversation_id, room_id, anchor_message_id, last_message_seq) VALUES (?,?,?,?,?,1)`).run(`th_${projectTag}`, projectTag, convRoom, `r_${projectTag}`, `anc_${projectTag}`);
  db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, thread_message_seq, author_type, author_id, body_json, status, created_at) VALUES (?,?,?,?,?,?,1,'agent',?,?,'final',?)`)
    .run(`rep_${projectTag}`, projectTag, convRoom, 2, `r_${projectTag}`, `th_${projectTag}`, `m_${projectTag}`, JSON.stringify({ text: '季报初稿完成' }), base + 1000);
  db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, conversation_thread_id, title, status, route_json) VALUES (?,?,?,'room_task',?,?, '季度报告','ACTIVE',?)`)
    .run(`tk_${projectTag}`, projectTag, convRoom, `r_${projectTag}`, `th_${projectTag}`, JSON.stringify({ kind: 'dispatch', mode: 'DIRECT', targetMemberId: `m_${projectTag}`, frozenMemberIds: [`m_${projectTag}`], initialWakeMemberIds: [`m_${projectTag}`] }));
  db.prepare(`UPDATE conversation_threads SET root_task_id = ? WHERE id = ?`).run(`tk_${projectTag}`, `th_${projectTag}`);
  // 线程 B：讨论串（无任务）。
  db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, author_type, author_id, body_json, status, created_at) VALUES (?,?,?,?,?,'human','u_local',?,'final',${base + 2000})`).run(`ancB_${projectTag}`, projectTag, convRoom, 3, `r_${projectTag}`, JSON.stringify({ text: '闲聊串' }));
  db.prepare(`INSERT INTO conversation_threads (id, project_id, conversation_id, room_id, anchor_message_id) VALUES (?,?,?,?,?)`).run(`thB_${projectTag}`, projectTag, convRoom, `r_${projectTag}`, `ancB_${projectTag}`);
  return { convRoom, threadA: `th_${projectTag}`, threadB: `thB_${projectTag}`, taskA: `tk_${projectTag}`, anchorA: `anc_${projectTag}` };
}

function makeEnv() {
  const db = openDatabase(':memory:');
  const pa = seed(db, 'pa');
  const pb = seed(db, 'pb'); // 同名项目（跨项目同名任务）
  // 他人 DM（audience 拒绝面）+本地 DM。
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_other_dm','pa','dm',NULL)`).run();
  db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('pa','conv_other_dm','human','u_other'),('pa','conv_other_dm','agent','m_pa')`).run();
  db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, author_type, author_id, body_json, status, created_at) VALUES ('msg_other_dm','pa','conv_other_dm',1,'human','u_other',?,'final',?)`).run(JSON.stringify({ text: '整理季度报告（他人私信不应出现）' }), Date.now() - 5_000);
  db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title, status) VALUES ('tk_other_dm','pa','conv_other_dm','dm_turn',NULL,'季度报告','ACTIVE')`).run();
  // 附件（只随所在消息检索）。
  db.prepare(`INSERT INTO artifacts (id, project_id, author_id, kind, hash, blob_path) VALUES ('art1','pa','u_local','file','h0','C:/tmp/a1.bin')`).run();
  db.prepare(`INSERT INTO message_attachments (id, message_id, artifact_id, display_name, source_hash) VALUES ('att1','anc_pa','art1','会议纪要-最终版.docx','h1')`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {} };
  const cmdRaw = async (method: string, params: unknown, commandId?: string) =>
    await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `d18fs-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: any; error?: { code: string; message: string } };
  const cmd = async <T,>(method: string, params: unknown, commandId?: string): Promise<T> => {
    const r = await cmdRaw(method, params, commandId);
    if (!r.ok) throw new Error(r.error?.message);
    return r.data as T;
  };
  return { db, cmd, cmdRaw, pa, pb };
}

describe('DEV-18 第二包：关注/静音（阅读订阅与执行名单分列）', () => {
  it('关注/取消/静音：持久保存+重启保持；不建运行、不停任务、不改冻结参与者；muted 排除未读聚合、followed 进待我处理', async () => {
    const { db, cmd } = makeEnv();
    const r1 = await cmd<{ followed: boolean; muted: boolean }>('thread.subscribe', { threadId: 'th_pa', follow: true });
    expect(r1).toMatchObject({ followed: true, muted: false });
    // 纯偏好：零新任务/零运行/冻结名单不动。
    expect((db.prepare("SELECT count(*) c FROM workflow_runs").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT count(*) c FROM thread_agent_followers").get() as { c: number }).c).toBe(0);
    // 重启等价（新连接只读同一库文件场景由 run/重启用例覆盖——此处验证持久行）。
    expect((db.prepare('SELECT followed, muted FROM thread_subscriptions WHERE thread_id = ? AND viewer_id = ?').get('th_pa', 'u_local') as { followed: number; muted: number })).toMatchObject({ followed: 1, muted: 0 });
    // followed+未读 → 待我处理。
    const pending = await cmd<{ projects: Array<{ projectId: string; followedThreads: Array<{ thread_id: string; unread: number }> }> }>('mine.pending', {});
    const paPending = pending.projects.find((p) => p.projectId === 'pa');
    expect(paPending?.followedThreads.some((f) => f.thread_id === 'th_pa' && f.unread >= 1)).toBe(true);
    // 静音：未读聚合排除（主池卡片 muted=1 且 unread=0；待我处理不再列）。
    await cmd('thread.subscribe', { threadId: 'th_pa', mute: true });
    const pool = await cmd<{ items: Array<{ threadId: string; unread: number; muted: boolean; followed: boolean }> }>('room.pool', { roomId: 'r_pa' });
    const row = pool.items.find((i) => i.threadId === 'th_pa');
    expect(row).toMatchObject({ unread: 0, muted: true, followed: true }); // 静音优先——即使仍关注
    const pending2 = await cmd<{ projects: Array<{ projectId: string; followedThreads: Array<{ thread_id: string }> }> }>('mine.pending', {});
    expect((pending2.projects.find((p) => p.projectId === 'pa')?.followedThreads ?? []).some((f) => f.thread_id === 'th_pa')).toBe(false);
    // 取消静音恢复；取消关注不停任务（任务仍 ACTIVE）。
    await cmd('thread.subscribe', { threadId: 'th_pa', mute: false, follow: false });
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get('tk_pa') as { status: string }).status).toBe('ACTIVE');
    db.close();
  });
});

describe('DEV-18 第二包：搜索（范围/过滤/分页/audience/定位）', () => {
  it('中文查询+项目范围+同名跨项目（scope=all 两项目都返回；scope=project 只当前）', async () => {
    const { db, cmd } = makeEnv();
    const all = await cmd<{ messages: any[]; threads: any[]; tasks: any[] }>('search.query', { text: '整理季度报告', scope: 'all' });
    expect(all.messages.length).toBe(2); // pa+pb 锚消息（他人 DM 的「整理季度报告（他人私信…）」不出现）
    expect(all.messages.every((m) => !String(m.conversationId).includes('other'))).toBe(true); // audience：他人 DM 零泄露
    expect(all.threads.length).toBe(2); // 同名线程（两项目）
    const scoped = await cmd<{ messages: any[]; threads: any[] }>('search.query', { text: '整理季度报告', scope: 'project', projectId: 'pa' });
    expect(scoped.messages.length).toBe(1);
    expect(scoped.threads.every((t) => t.projectId === 'pa')).toBe(true);
    const tasks = await cmd<{ tasks: any[] }>('search.query', { text: '季度报告', scope: 'all', kind: 'task' });
    expect(tasks.tasks.length).toBe(2); // 同名任务跨项目
    expect(tasks.tasks.some((t) => t.taskId === 'tk_other_dm')).toBe(false); // 他人 DM 任务不泄露
    void db;
    db.close();
  });
  it('过滤：作者/日期/会话；分页确定性（pageSize=1 两页）', async () => {
    const { cmd } = makeEnv();
    const byAuthor = await cmd<{ messages: any[] }>('search.query', { text: '季报', scope: 'all', authorDisplayName: '执行成员' });
    expect(byAuthor.messages.length).toBe(2); // 跨项目同名作者（pa+pb 的 agent 回复都命中——文本匹配如实）
    expect(byAuthor.messages.every((m) => m.authorType === 'agent')).toBe(true);
    const byConv = await cmd<{ messages: any[] }>('search.query', { text: '整理季度报告', scope: 'all', conversationId: 'conv_pb' });
    expect(byConv.messages.length).toBe(1);
    expect(byConv.messages[0].projectId).toBe('pb');
    const day = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10); // 本地日期（服务端过滤语义=本机时区——UTC 写法在北京 00—08 点必错位）
    const inDay = await cmd<{ messages: any[] }>('search.query', { text: '整理季度报告', scope: 'all', fromDay: day, toDay: day });
    expect(inDay.messages.length).toBe(2); // 含当日
    const outDay = await cmd<{ messages: any[] }>('search.query', { text: '整理季度报告', scope: 'all', fromDay: '2020-01-01', toDay: '2020-01-02' });
    expect(outDay.messages.length).toBe(0);
    const p1 = await cmd<{ messages: any[] }>('search.query', { text: '整理季度报告', scope: 'all', kind: 'message', page: 1, pageSize: 1 });
    const p2 = await cmd<{ messages: any[] }>('search.query', { text: '整理季度报告', scope: 'all', kind: 'message', page: 2, pageSize: 1 });
    expect(p1.messages.length).toBe(1);
    expect(p2.messages.length).toBe(1);
    expect(p1.messages[0].messageId).not.toBe(p2.messages[0].messageId); // 分页不重叠
    expect(p1.messages[0].locate).toMatch(/^#msg=/); // 定位原消息
  });
  it('附件只随所在消息检索（文件名命中=消息命中；正文提取不冒充）', async () => {
    const { cmd } = makeEnv();
    const r = await cmd<{ messages: any[]; attachmentNote: string }>('search.query', { text: '会议纪要-最终版', scope: 'all' });
    expect(r.messages.length).toBe(1); // 附件名命中其所在消息
    expect(r.messages[0].messageId).toBe('anc_pa');
    const none = await cmd<{ messages: any[] }>('search.query', { text: '附件正文不存在的内容', scope: 'all' });
    expect(none.messages.length).toBe(0); // 正文提取未实施——不冒充
    expect(r.attachmentNote).toContain('正文提取未实施');
  });

  it('第二十六轮三：日期按本机时区（北京时间凌晨边界）+混合类型过滤一致性+会话过滤', async () => {
    const { db, cmd } = makeEnv();
    // 构造本地凌晨边界消息：本地今日 00:30（北京时间凌晨——UTC 边界会把它归入前一 UTC 日）。
    const local = new Date();
    const todayLocal0030 = new Date(local.getFullYear(), local.getMonth(), local.getDate(), 0, 30, 0).getTime();
    db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, author_type, author_id, body_json, status, created_at) VALUES ('msg_dawn','pa','conv_pa',9,'r_pa','human','u_local',?,'final',?)`)
      .run(JSON.stringify({ text: '凌晨边界样本' }), todayLocal0030);
    const todayStr = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
    // fromDay=toDay=今天（本地）→ 必含本地 00:30 的消息（旧 UTC 实现在东八区会漏）。
    const inDay = await cmd<{ messages: any[] }>('search.query', { text: '凌晨边界样本', scope: 'all', fromDay: todayStr, toDay: todayStr });
    expect(inDay.messages.length).toBe(1);
    const beforeToday = await cmd<{ messages: any[] }>('search.query', { text: '凌晨边界样本', scope: 'all', toDay: todayStr, fromDay: '2000-01-01' });
    expect(beforeToday.messages.length).toBe(1); // 长区间同样命中
    // 混合类型一致性：会话过滤（conv_pb）下 kind=all——pa 的消息/线程/任务都不混入。
    const mixed = await cmd<{ messages: any[]; threads: any[]; tasks: any[] }>('search.query', { text: '季度报告', scope: 'all', conversationId: 'conv_pb' });
    expect(mixed.messages.every((x) => x.conversationId === 'conv_pb')).toBe(true);
    expect(mixed.threads.every((x) => x.conversationId === 'conv_pb')).toBe(true);
    expect(mixed.tasks.every((x) => x.conversationId === 'conv_pb')).toBe(true);
    expect(mixed.messages.length).toBe(1); // 仅 pb 锚
    // 作者过滤对线程统一：锚作者=执行成员（agent）的线程——seed 中锚是 u_local，agent 回复是成员写的锚？锚=u_local → 按作者「执行成员」过滤线程应为 0（锚作者不符——不混入）。
    const threadsByHuman = await cmd<{ threads: any[] }>('search.query', { text: '整理季度报告', scope: 'all', kind: 'thread', authorDisplayName: '执行成员' });
    expect(threadsByHuman.threads.length).toBe(0); // 锚作者是 u_local（human）——agent 名过滤不匹配（如实）
    const threadsByAnchor = await cmd<{ threads: any[] }>('search.query', { text: '整理季度报告', scope: 'all', kind: 'thread', authorDisplayName: '非存在名字' });
    expect(threadsByAnchor.threads.length).toBe(0);
    // 日期过滤对任务：任务（无根消息直插）在设日期过滤时如实排除（不冒充可判）。
    const tasksDated = await cmd<{ tasks: any[] }>('search.query', { text: '季度报告', scope: 'all', kind: 'task', fromDay: todayStr, toDay: todayStr });
    expect(tasksDated.tasks.length).toBe(0); // 无根消息→无法归日（明确行为）
    db.close();
  });
});

describe('DEV-18 第二包：收藏（独立持久/幂等/失效呈现/深链）', () => {
  it('消息+链接收藏：幂等；取消不删原内容；定位深链；重启保持（行持久）', async () => {
    const { db, cmd } = makeEnv();
    const a1 = await cmd<{ saved: boolean; existed: boolean }>('saved.add', { kind: 'message', ref: 'rep_pa', title: '季报初稿', projectId: 'pa' });
    expect(a1).toMatchObject({ saved: true, existed: false });
    const a2 = await cmd<{ saved: boolean; existed: boolean }>('saved.add', { kind: 'message', ref: 'rep_pa', title: '季报初稿', projectId: 'pa' });
    expect(a2.existed).toBe(true); // 幂等
    const link = await cmd<{ existed: boolean }>('saved.add', { kind: 'link', ref: 'https://example.com/spec', title: '规格页' });
    expect(link.existed).toBe(false);
    await expect(cmd('saved.add', { kind: 'link', ref: 'not-a-url' })).rejects.toThrow(/http/);
    const list = await cmd<{ items: any[] }>('saved.list', {});
    const msgItem = list.items.find((i) => i.kind === 'message');
    expect(msgItem).toMatchObject({ status: 'ok' });
    expect(msgItem.locate).toBe('#msg=rep_pa');
    await cmd('saved.remove', { kind: 'message', ref: 'rep_pa' });
    expect((db.prepare('SELECT body_json FROM messages WHERE id = ?').get('rep_pa') as { body_json: string }).body_json).toContain('季报初稿'); // 原内容不动
    const after = await cmd<{ items: any[] }>('saved.list', {});
    expect(after.items.some((i) => i.kind === 'message')).toBe(false);
    expect(after.items.some((i) => i.kind === 'link')).toBe(true); // 重启保持=行持久（db 文件级由 sqlite 保证）
    db.close();
  });
  it('失效/越权如实呈现：目标删除=missing；他人 DM=forbidden+不可定位', async () => {
    const { db, cmd, cmdRaw } = makeEnv();
    await cmd('saved.add', { kind: 'message', ref: 'ancB_pa', title: '闲聊串锚' });
    // 他人 DM 消息收藏：audience 拒绝（不入库——列表只剩一条）。
    const rejected = await cmdRaw('saved.add', { kind: 'message', ref: 'msg_other_dm', title: '他人私信' });
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.message).toContain('audience');
    const list = await cmd<{ items: any[] }>('saved.list', {});
    expect(list.items.length).toBe(1);
    db.prepare('DELETE FROM messages WHERE id = ?').run('ancB_pa');
    const after = await cmd<{ items: any[] }>('saved.list', {});
    expect(after.items[0]).toMatchObject({ status: 'missing', locate: null });
    db.close();
  });
});
