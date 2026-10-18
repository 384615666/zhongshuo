import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase } from '../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../src/daemon/commands.ts';
import { DispatchWorker } from '../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../src/adapter/fake/runtimeAdapter.ts';
import { failingTurn, successTurn } from '../src/adapter/fake/script.ts';
import { localUserId } from '../src/contracts/daemonIpc.ts';

const inputRoot = process.argv[2];
if (inputRoot == null || inputRoot.trim() === '') {
  throw Error('usage: node --experimental-strip-types scripts/prepare-r90-old-failure-ui.ts <fresh-root>');
}
const root = resolve(inputRoot);
if (existsSync(root)) throw Error(`fixture root already exists: ${root}`);
const appData = join(root, 'app-data');
const projectPath = join(root, 'project');
mkdirSync(appData, { recursive: true });
mkdirSync(projectPath, { recursive: true });
writeFileSync(join(projectPath, 'synthetic.txt'), 'R90 old failure/new message synthetic fixture\n', 'utf8');

process.env.ZS_ALLOW_FAKE = '1';
process.env.ZS_RUNTIME = 'fake';
process.env.ZS_DEFAULT_MEMBER_DISCOVERY = '0';
delete process.env.ZS_REAL_DISPATCH_GUARD;

const db = openDatabase(join(appData, 'state.sqlite'));
const scripts = [
  failingTurn('PROVIDER_ERROR', 'R90 synthetic old failure', false),
  successTurn('R90_NEW_MESSAGE_AFTER_FAILURE_OK', 'msg_r90_old_failure_new'),
];
const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => scripts.shift() ?? successTurn() });
const worker = new DispatchWorker({ db, adapter, leaseOwner: 'r90-old-failure-ui', appDataDir: appData });
try {
  const deps = { db, localUserId: localUserId(), appDataDir: appData, interruptTurn: (id: string) => worker.interruptTurn(id) };
  const command = async <T>(method: string, params: unknown): Promise<T> => {
    const response = await dispatchDaemonCommand(deps, {
      protocolVersion: 1,
      commandId: `r90-old-ui-${randomUUID()}`,
      method,
      params,
    }) as { ok: boolean; data?: T; error?: { code?: string; message?: string } };
    if (!response.ok || response.data == null) throw Error(`${method}: ${response.error?.code ?? 'NO_DATA'} ${response.error?.message ?? ''}`);
    return response.data;
  };

  const opened = await command<{ project: { id: string } }>('project.open', {
    path: projectPath,
    displayName: 'R90 旧失败新消息',
    agentNames: ['GLM'],
  });
  const projectId = opened.project.id;
  const member = await command<{ memberId: string }>('member.create', { projectId, displayName: 'GLM' });
  await command('member.setRuntime', {
    memberId: member.memberId,
    kind: 'fake',
    executable: 'fake',
    permissionMode: 'bypassPermissions',
  });
  const conversation = await command<{ conversationId: string }>('conversation.create', {
    projectId,
    peerMemberId: member.memberId,
    title: 'R90 old failure new message',
  });
  const old = await command<{ taskId: string; disposition: string }>('message.submit', {
    target: { kind: 'dm', projectId, conversationId: conversation.conversationId },
    body: 'R90 synthetic request that fails before a later new message',
    intent: 'default',
    mentions: [],
  });
  await worker.runOnce();
  const task = db.prepare('SELECT status FROM tasks WHERE id=?').get(old.taskId) as { status: string } | undefined;
  const run = db.prepare('SELECT status FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(old.taskId) as { status: string } | undefined;
  if (task?.status !== 'ACTIVE' || run?.status !== 'FAILED') {
    throw Error(`old failure fixture mismatch: task=${task?.status ?? 'missing'} run=${run?.status ?? 'missing'}`);
  }
  await command('app.settings.set', { key: 'ui.autoOpenProjectPath', value: projectPath });
  const report = {
    format: 'r90-old-failure-ui-fixture-v1',
    root,
    appData,
    projectId,
    projectPath,
    memberId: member.memberId,
    conversationId: conversation.conversationId,
    oldTaskId: old.taskId,
    oldTaskStatus: task.status,
    oldRunStatus: run.status,
    oldFailureText: 'R90 synthetic old failure',
  };
  writeFileSync(join(root, 'fixture.json'), JSON.stringify(report, null, 2), 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  db.close();
}
