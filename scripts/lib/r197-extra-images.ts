/**
 * R197 截图/验收附加夹具：在 r170-fixture --r192 之后补三类「图片-only（无正文）」
 * 本人消息——对话串一条、私信一条、房间主池一条，用于检查图片气泡贴合、引用/复制
 * 图片绝对路径与图片右键复制。
 *
 * 只操作隔离数据目录（由截图脚本传入），不接触用户运行数据；fake runtime、零真实调用。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { localUserId } from '../../src/contracts/daemonIpc.ts';

const [dir] = process.argv.slice(2);
if (!dir) throw Error('Expected isolated data directory');
const meta = JSON.parse(readFileSync(join(dir, 'guide-fixture.json'), 'utf8')) as {
  projectId: string; roomId: string; conversationId: string; dm: string;
  chat: { threadId: string };
};
process.env.ZS_RUNTIME = 'fake';
process.env.ZS_ALLOW_FAKE = '1';
process.env.ZS_REAL_DISPATCH_GUARD = '1';

const db = openDatabase(join(dir, 'state.sqlite'));
const user = localUserId();
const command = async <T>(method: string, params: unknown): Promise<T> => {
  const result = await dispatchDaemonCommand(
    { db, appDataDir: dir, localUserId: user, interruptTurn: async () => { /* 仅记录，无执行 */ } },
    { protocolVersion: 1, commandId: randomUUID(), method, params },
  ) as { ok: boolean; data: T; error?: unknown };
  if (!result.ok) throw Error(`${method}: ${JSON.stringify(result.error)}`);
  return result.data;
};

async function main(): Promise<void> {
  const imageBase64 = readFileSync(join(process.cwd(), 'logo.png')).toString('base64');
  const upload = async (conversationId: string, filename: string): Promise<string> =>
    (await command<{ attachmentId: string }>('attachment.uploadImage', { conversationId, filename, contentBase64: imageBase64 })).attachmentId;

  const threadAttachment = await upload(meta.conversationId, '猫猫图片.png');
  const thread = await command<{ messageId: string }>('message.submit', {
    target: { kind: 'thread', projectId: meta.projectId, conversationId: meta.conversationId, threadId: meta.chat.threadId },
    body: '', intent: 'record_only', mentions: [], attachmentRefs: [threadAttachment],
  });

  const dmAttachment = await upload(meta.dm, '私信猫猫.png');
  const dm = await command<{ messageId: string }>('message.submit', {
    target: { kind: 'dm', projectId: meta.projectId, conversationId: meta.dm },
    body: '', intent: 'record_only', mentions: [], attachmentRefs: [dmAttachment],
  });

  const roomAttachment = await upload(meta.conversationId, '主池猫猫.png');
  const room = await command<{ messageId: string }>('message.submit', {
    target: { kind: 'room_root', projectId: meta.projectId, conversationId: meta.conversationId, roomId: meta.roomId },
    body: '', intent: 'record_only', mentions: [], attachmentRefs: [roomAttachment],
  });

  const extra = {
    thread: { messageId: thread.messageId, attachmentId: threadAttachment, filename: '猫猫图片.png', threadId: meta.chat.threadId },
    dm: { messageId: dm.messageId, attachmentId: dmAttachment, filename: '私信猫猫.png', conversationId: meta.dm },
    room: { messageId: room.messageId, attachmentId: roomAttachment, filename: '主池猫猫.png' },
  };
  writeFileSync(join(dir, 'r197-extra.json'), JSON.stringify(extra, null, 2), 'utf8');
  console.log(JSON.stringify(extra));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => db.close());
