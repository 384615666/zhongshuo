import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase } from '../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../src/daemon/commands.ts';
import { localUserId } from '../src/contracts/daemonIpc.ts';

const root = process.argv[2];
if (root == null || root.trim() === '') throw Error('usage: node --experimental-strip-types scripts/prepare-r88-visible-fixture.ts <fresh-root>');
const fixtureRoot = resolve(root);
if (existsSync(fixtureRoot)) throw Error(`fixture root already exists: ${fixtureRoot}`);
const appData = join(fixtureRoot, 'app-data');
const projectPath = join(fixtureRoot, 'project');
mkdirSync(appData, { recursive: true });
mkdirSync(projectPath, { recursive: true });
writeFileSync(join(projectPath, 'README.md'), '# R88 visible fixture\n\nSynthetic local project for chat rendering.\n', 'utf8');

process.env.ZS_ALLOW_FAKE = '1';
process.env.ZS_DEFAULT_MEMBER_DISCOVERY = '0';
delete process.env.ZS_REAL_DISPATCH_GUARD;
const db = openDatabase(join(appData, 'state.sqlite'));
const deps = { db, localUserId: localUserId(), appDataDir: appData, interruptTurn: async () => {} };
const command = async <T>(method: string, params: unknown): Promise<T> => {
  const response = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: randomUUID(), method, params }) as {
    ok: boolean; data?: T; error?: { code: string; message: string };
  };
  if (!response.ok || response.data == null) throw Error(`${method}: ${response.error?.code ?? 'NO_DATA'} ${response.error?.message ?? ''}`);
  return response.data;
};

try {
  const opened = await command<{ project: { id: string } }>('project.open', {
    path: projectPath,
    displayName: 'R88 聊天阅读样例',
    agentNames: ['Claude', 'Codex'],
  });
  const projectId = opened.project.id;
  const members = db.prepare("SELECT id,display_name FROM project_members WHERE project_id=? ORDER BY rowid").all(projectId) as Array<{ id: string; display_name: string }>;
  const claude = members.find((member) => member.display_name === 'Claude')!;
  const codex = members.find((member) => member.display_name === 'Codex')!;
  const fake = { kind: 'fake', executable: 'fake', permissionMode: 'plan' };
  await command('member.setRuntime', { memberId: claude.id, ...fake });
  await command('member.setRuntime', { memberId: codex.id, ...fake });
  const room = db.prepare('SELECT id,name FROM rooms WHERE project_id=? ORDER BY rowid LIMIT 1').get(projectId) as { id: string; name: string };
  const conversation = db.prepare('SELECT id,last_message_seq FROM conversations WHERE room_id=? LIMIT 1').get(room.id) as { id: string; last_message_seq: number };
  const target = { kind: 'room_root', projectId, conversationId: conversation.id, roomId: room.id };
  const rootSend = await command<{ messageId: string; threadId: string }>('message.submit', {
    target,
    body: [
      '# 请整理本周发布记录',
      '',
      '请把结果整理成可快速扫读的摘要，并说明风险。',
      '',
      '- 构建状态',
      '- 失败项与影响',
      '- 下一步建议',
    ].join('\n'),
    intent: 'record_only',
    mentions: [],
  });
  const insertReply = (authorId: string, authorType: 'human'|'agent', text: string, threadSeq: number): string => {
    const id = `msg_r88_${randomUUID()}`;
    const last = db.prepare('SELECT last_message_seq FROM conversations WHERE id=?').get(conversation.id) as { last_message_seq: number };
    const conversationSeq = last.last_message_seq + 1;
    db.prepare(`INSERT INTO messages
      (id,project_id,conversation_id,conversation_seq,room_id,thread_id,task_id,reply_to_message_id,thread_message_seq,author_type,author_id,body_json,status,created_at)
      VALUES (?,?,?,?,?,?,NULL,NULL,?,?,?,?,'final',?)`)
      .run(id, projectId, conversation.id, conversationSeq, room.id, rootSend.threadId, threadSeq, authorType, authorId, JSON.stringify({ text }), Date.now() + threadSeq);
    db.prepare('UPDATE conversations SET last_message_seq=? WHERE id=?').run(conversationSeq, conversation.id);
    db.prepare('UPDATE conversation_threads SET last_message_seq=? WHERE id=?').run(threadSeq, rootSend.threadId);
    return id;
  };
  insertReply(claude.id, 'agent', [
    '## 发布摘要',
    '',
    '| 检查项 | 结果 | 说明 |',
    '| --- | --- | --- |',
    '| 类型检查 | 通过 | 主工程与界面工程均无错误 |',
    '| 定向测试 | 通过 | 聊天、默认成员、副屏定位共 9 项 |',
    '| 可见复核 | 待进行 | 使用最终包在非主屏检查 |',
    '',
    '```ts',
    'const release = {',
    '  status: "ready",',
    '  blockers: 0,',
    '};',
    '```',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[构建] --> B{回归通过}',
    '  B -->|是| C[副屏复核]',
    '  B -->|否| D[停止发布]',
    '```',
    '',
    '```chart',
    '{"title":"检查覆盖","type":"bar","data":[{"label":"界面","value":8},{"label":"后端","value":6},{"label":"回归","value":9}]}',
    '```',
  ].join('\n'), 1);
  insertReply(deps.localUserId, 'human', '把表格和流程图留在串里，按最终包再核一次副屏位置。', 2);
  insertReply(codex.id, 'agent', [
    '收到。最终复核重点：',
    '',
    '1. 人类消息在右，AI 消息在左。',
    '2. 宽表格与代码块只在消息内横向滚动。',
    '3. 窗口从隐藏状态直接出现在非主屏，过程不闪到主屏。',
  ].join('\n'), 3);
  await command('app.settings.set', { key: 'ui.autoOpenProjectPath', value: projectPath });
  const report = {
    format: 'r88-visible-fixture-v1',
    root: fixtureRoot,
    appData,
    projectId,
    projectPath,
    roomId: room.id,
    conversationId: conversation.id,
    threadId: rootSend.threadId,
    rootMessageId: rootSend.messageId,
    members,
  };
  writeFileSync(join(fixtureRoot, 'fixture.json'), JSON.stringify(report, null, 2), 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  db.close();
}
