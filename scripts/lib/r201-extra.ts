/** R201 截图夹具（在 r170 --r192 夹具之后运行）：让一次真实 fake 回合产出含
 *  `file:///` 本地图片/文件链接的 **AI 回复**，用于验证「本地文件只显示文件名 + 右键菜单」。
 *  不修改共享的 r170 夹具数据，只追加一个任务。 */
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';
import {localUserId} from '../../src/contracts/daemonIpc.ts';

const [dir, project] = process.argv.slice(2);
if (!dir || !project) throw Error('Expected isolated data and project directories');
mkdirSync(dir, {recursive: true});
process.env.ZS_RUNTIME = 'fake';
process.env.ZS_ALLOW_FAKE = '1';
process.env.ZS_REAL_DISPATCH_GUARD = '1';

const path1 = 'C:\\Users\\Public\\Documents\\示例 图片.png';
const path2 = 'C:\\Users\\Public\\Documents\\说明 文档.txt';
const answer = [
  '本地文件已经放到这些位置，这里只列文件名：',
  '',
  `![示例 图片.png](${'file:///C:/Users/Public/Documents/%E7%A4%BA%E4%BE%8B%20%E5%9B%BE%E7%89%87.png'})`,
  `[说明 文档.txt](${'file:///C:/Users/Public/Documents/%E8%AF%B4%E6%98%8E%20%E6%96%87%E6%A1%A3.txt'})`,
  '',
  '右键文件可以复制地址或用其他程序打开。',
].join('\n');

const db = openDatabase(join(dir, 'state.sqlite'));
const user = localUserId();
let script: FakeTurnScript = [];
const adapter = new FakeRuntimeAdapter({turnScriptSequencer: () => script});
const worker = new DispatchWorker({db, adapter, leaseOwner: 'r201-fixture', appDataDir: dir});
const command = async <T>(method: string, params: unknown): Promise<T> => {
  const result = await dispatchDaemonCommand({db, appDataDir: dir, localUserId: user, interruptTurn: id => worker.interruptTurn(id)},
    {protocolVersion: 1, commandId: randomUUID(), method, params}) as {ok: boolean; data: T; error?: unknown};
  if (!result.ok) throw Error(`${method}: ${JSON.stringify(result.error)}`);
  return result.data;
};

async function main(): Promise<void> {
  const {project: {id: projectId}} = await command<{project: {id: string}}>('project.open', {path: project});
  const room = (await command<{items: {id: string; conversationId: string; revision: number}[]}>('room.list', {projectId})).items[0]!;
  const members = (await command<{items: {id: string; displayName: string}[]}>('member.list', {projectId})).items;
  const claude = members.find(m => m.displayName === 'Claude') ?? members[0];
  if (!claude) throw Error('No member available for R201 fixture');
  script = [{kind: 'event', event: {kind: 'turn.completed', finalText: JSON.stringify({
    schemaVersion: 'task-complete-v1', resultKey: 'example', answer, changeSummary: answer,
    responseKind: 'conversation', userQuestion: null, document: null, files: [],
    executedVerifications: [], unexecutedVerifications: [], remainingIssues: [],
  })}}];
  const sent = await command<{taskId: string; threadId: string}>('message.submit', {
    target: {kind: 'room_root', projectId, roomId: room.id, conversationId: room.conversationId},
    body: '这些本地文件请只显示文件名。',
    intent: 'default',
    mentions: [{kind: 'member', memberId: claude.id}],
  });
  await worker.drain();
  writeFileSync(join(dir, 'r201-extra.json'), JSON.stringify({
    projectId, roomId: room.id, conversationId: room.conversationId,
    threadId: sent.threadId, taskId: sent.taskId, paths: [path1, path2],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
