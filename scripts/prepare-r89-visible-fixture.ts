import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase } from '../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../src/daemon/commands.ts';
import { localUserId } from '../src/contracts/daemonIpc.ts';

const root = process.argv[2];
if (root == null || root.trim() === '') throw Error('usage: node --experimental-strip-types scripts/prepare-r89-visible-fixture.ts <fresh-root>');
const fixtureRoot = resolve(root);
if (existsSync(fixtureRoot)) throw Error(`fixture root already exists: ${fixtureRoot}`);
const appData = join(fixtureRoot, 'app-data');
const projectPath = join(fixtureRoot, 'project');
const otherProjectPath = join(fixtureRoot, 'project-other');
mkdirSync(appData, { recursive: true });
mkdirSync(projectPath, { recursive: true });
mkdirSync(otherProjectPath, { recursive: true });
writeFileSync(join(projectPath, '合成资料.md'), '# R89 合成资料\n\n内容标记：R89_DOC_WORKSPACE_42\n\n这是只用于界面和引用通道验证的合成文档。\n', 'utf8');
writeFileSync(join(projectPath, 'README.md'), '# R89 visible fixture\n\nSynthetic local project.\n', 'utf8');
writeFileSync(join(projectPath, '异步读取.md'), `# R89 async document\n\nSYNTHETIC_ONLY\n\n${'A'.repeat(200 * 1024)}\n`, 'utf8');
writeFileSync(join(otherProjectPath, 'README.md'), '# R89 async switch fixture\n\nSynthetic second project.\n', 'utf8');

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
    displayName: 'R89 正文提及样例',
    agentNames: ['Claude', 'Codex', 'GLM'],
  });
  const projectId = opened.project.id;
  const members = db.prepare('SELECT id,display_name FROM project_members WHERE project_id=? ORDER BY rowid').all(projectId) as Array<{ id: string; display_name: string }>;
  const fake = { kind: 'fake', executable: 'fake', permissionMode: 'plan' };
  for (const member of members) await command('member.setRuntime', { memberId: member.id, ...fake });
  const room = db.prepare('SELECT id,name FROM rooms WHERE project_id=? ORDER BY rowid LIMIT 1').get(projectId) as { id: string; name: string };
  const conversation = db.prepare('SELECT id FROM conversations WHERE room_id=? LIMIT 1').get(room.id) as { id: string };
  const thread = await command<{ threadId: string; messageId: string }>('message.submit', {
    target: { kind: 'room_root', projectId, conversationId: conversation.id, roomId: room.id },
    body: 'R89 回复串样例',
    intent: 'record_only',
    mentions: [],
  });
  const uploaded = await command<{ attachmentId: string }>('attachment.uploadText', {
    conversationId: conversation.id,
    filename: '已上传资料.txt',
    content: '内容标记：R89_DOC_UPLOADED_77\n\n这是已上传合成文档。',
  });
  const otherOpened = await command<{ project: { id: string } }>('project.open', {
    path: otherProjectPath,
    displayName: 'R89 异步切换样例',
    agentNames: ['Claude'],
  });
  const otherProjectId = otherOpened.project.id;
  const otherRoom = db.prepare('SELECT id FROM rooms WHERE project_id=? ORDER BY rowid LIMIT 1').get(otherProjectId) as { id: string };
  const otherConversation = db.prepare('SELECT id FROM conversations WHERE room_id=? LIMIT 1').get(otherRoom.id) as { id: string };
  await command('app.settings.set', { key: 'ui.autoOpenProjectPath', value: projectPath });
  const report = {
    format: 'r89-visible-fixture-v1',
    root: fixtureRoot,
    appData,
    projectId,
    projectPath,
    roomId: room.id,
    conversationId: conversation.id,
    otherProjectId,
    otherProjectPath,
    otherRoomId: otherRoom.id,
    otherConversationId: otherConversation.id,
    threadId: thread.threadId,
    threadMessageId: thread.messageId,
    uploadedAttachmentId: uploaded.attachmentId,
    members,
  };
  writeFileSync(join(fixtureRoot, 'fixture.json'), JSON.stringify(report, null, 2), 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  db.close();
}
