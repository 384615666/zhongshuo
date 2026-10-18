import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase } from '../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../src/daemon/commands.ts';
import { localUserId } from '../src/contracts/daemonIpc.ts';

const root = process.argv[2];
if (root == null || root.trim() === '') throw Error('usage: node --experimental-strip-types scripts/prepare-r90-real-fixture.ts <fresh-root>');
const fixtureRoot = resolve(root);
if (existsSync(fixtureRoot)) throw Error(`fixture root already exists: ${fixtureRoot}`);
const appData = join(fixtureRoot, 'app-data');
const projectPath = join(fixtureRoot, 'project');
mkdirSync(appData, { recursive: true });
mkdirSync(projectPath, { recursive: true });
writeFileSync(join(projectPath, 'R90真实合成报告.md'), '# R90 真实调用合成资料\n\n唯一标记：R90_REAL_DOC_9031\n\n本文件只用于真实模型读取验证，不含用户数据。\n', 'utf8');
writeFileSync(join(projectPath, 'R90真实对照.html'), '<!doctype html><meta charset="utf-8"><title>R90 synthetic</title><p>R90_REAL_HTML_9032</p>', 'utf8');

process.env.ZS_DEFAULT_MEMBER_DISCOVERY = '0';
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
    displayName: 'R90 真实日常样例',
    agentNames: ['GLM', 'DeepSeek'],
  });
  const projectId = opened.project.id;
  const members = db.prepare('SELECT id,display_name FROM project_members WHERE project_id=? ORDER BY rowid').all(projectId) as Array<{ id: string; display_name: string }>;
  const glm = members.find((member) => member.display_name === 'GLM')!;
  const deepseek = members.find((member) => member.display_name === 'DeepSeek')!;
  await command('member.setRuntime', { memberId: glm.id, kind: 'codex', model: 'ccs-new/glm-5.3-flash', executable: 'codex', permissionMode: 'plan', effort: 'high' });
  await command('member.setRuntime', { memberId: deepseek.id, kind: 'claude', model: 'deepseek-flash', executable: 'claude', permissionMode: 'plan' });
  const room = db.prepare('SELECT id,name,revision FROM rooms WHERE project_id=? ORDER BY rowid LIMIT 1').get(projectId) as { id: string; name: string; revision: number };
  await command('room.update', { roomId: room.id, coordinatorMemberId: glm.id, expectedRevision: room.revision });
  const conversation = db.prepare('SELECT id FROM conversations WHERE room_id=? LIMIT 1').get(room.id) as { id: string };
  const glmDm = await command<{ conversationId: string }>('conversation.create', { projectId, peerMemberId: glm.id, title: 'R90-real-GLM' });
  const deepseekDm = await command<{ conversationId: string }>('conversation.create', { projectId, peerMemberId: deepseek.id, title: 'R90-real-DeepSeek' });
  await command('app.settings.set', { key: 'ui.autoOpenProjectPath', value: projectPath });
  const report = {
    format: 'r90-real-fixture-v1',
    root: fixtureRoot,
    appData,
    projectId,
    projectPath,
    roomId: room.id,
    conversationId: conversation.id,
    coordinatorMemberId: glm.id,
    members: [
      { id: glm.id, displayName: 'GLM', kind: 'codex', model: 'ccs-new/glm-5.3-flash', effort: 'high' },
      { id: deepseek.id, displayName: 'DeepSeek', kind: 'claude', model: 'deepseek-flash', effort: null },
    ],
    dms: [
      { conversationId: glmDm.conversationId, memberId: glm.id, displayName: 'GLM' },
      { conversationId: deepseekDm.conversationId, memberId: deepseek.id, displayName: 'DeepSeek' },
    ],
  };
  writeFileSync(join(fixtureRoot, 'fixture.json'), JSON.stringify(report, null, 2), 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  db.close();
}
