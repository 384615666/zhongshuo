/**
 * 房间/线程动作的正式适配层（R64 原型还原）：原型 mock actions 的同名语义 → 真实命令。
 * 只落正式链路：thread.subscribe（关注/静音——人的阅读订阅）、message.react、thread.markRead
 * （门控在 loader）、task.stop（三重绑定）、export.create、room.create。后端没有的能力由
 * 调用方按「真实能力限制」呈现，不在这里伪造成功。
 */
import { command } from '../bridge';
import { getState, setState, toast, recordWrite } from './store';
import { markThreadReadIfAllowed, stopThreadTask, loadThread, refreshRooms } from '../loader';
import type { Task } from './types';

/** 关注/静音切换（thread.subscribe——真实回执更新投影；订阅事实同时写入卡片/ subscriptions）。 */
export async function toggleThreadSubscription(threadId: string, patch: { follow?: boolean; mute?: boolean }): Promise<void> {
  try {
    const r = await command<{ followed: boolean; muted: boolean }>('thread.subscribe', { threadId, ...patch });
    setState((s) => ({
      ...s,
      subscriptions: { ...s.subscriptions, [threadId]: { followed: r.followed, muted: r.muted } },
    }));
    recordWrite('thread.subscribe', `${patch.follow != null ? (patch.follow ? '关注' : '取消关注') : ''}${patch.mute != null ? (patch.mute ? '静音' : '取消静音') : ''}（人的阅读订阅——不改执行名单）`);
    toast(patch.mute === true ? '已静音（未读/通知聚合排除；待办保留）' : patch.follow === true ? '已关注（有新回复进「待我处理」）' : '订阅已更新', 'success');
  } catch (e) {
    toast(`订阅更新失败：${(e as Error).message}`, 'error');
  }
}

/** 打开线程即推进水位（贴底/前台由门核——服务端拒绝未来序号）。 */
export function markThreadReadReal(threadId: string): void {
  void markThreadReadIfAllowed(threadId);
}

/** 消息表情（message.react——toggle 幂等）。 */
export async function reactMessageReal(messageId: string, emoji: string, threadId?: string): Promise<void> {
  try {
    await command('message.react', { messageId, emoji });
    if (threadId != null) void loadThread(threadId).catch(() => { /* 刷新失败另有呈现 */ });
  } catch (e) {
    toast(`表情失败：${(e as Error).message}`, 'error');
  }
}

/** 停止任务（task.stop——run/停止代次三重绑定，loader 实现）。 */
export function stopTaskReal(threadId: string): Promise<{ ok: boolean; error?: string }> {
  return stopThreadTask(threadId);
}

/** 导出线程/成果（export.create——md/html/docx 快照事务）。 */
export async function exportThreadReal(target: { kind: 'thread'; projectId: string; conversationId: string; threadId: string }, format: 'md' | 'html' | 'docx'): Promise<void> {
  const { openExportDir } = await import('../bridge');
  try {
    const r = await command<{ exportId: string; dir: string; files: string[]; stats: { messages: number; attachments: number } }>('export.create', { target, format });
    recordWrite('export.create', `导出线程 ${format}（${r.stats.messages} 消息/${r.stats.attachments} 附件 → ${r.exportId}）`);
    toast(`已导出 ${format.toUpperCase()}（${r.stats.messages} 消息 · ${r.files.length} 文件）`, 'success');
    void openExportDir(r.dir).catch((e: unknown) => toast(`打开导出目录失败：${(e as Error).message}（目录 ${r.dir}）`, 'error'));
  } catch (e) {
    toast(`导出失败：${(e as Error).message}`, 'error');
  }
}

/** 新建房间（room.create——真实命令；成功后刷新房间列表并返回 roomId）。 */
export async function createRoomReal(projectId: string, name: string): Promise<string | null> {
  try {
    const r = await command<{ room: { id: string; name: string; conversationId: string }; roomIndex: number }>('room.create', { projectId, name });
    recordWrite('room.create', `新建房间「${name}」`);
    await refreshRooms().catch(() => { /* 名单下次刷新 */ });
    toast(`已创建房间「${name}」`, 'success');
    return r.room.id;
  } catch (e) {
    toast(`创建房间失败：${(e as Error).message}`, 'error');
    return null;
  }
}

/** 主池卡片主状态（原型 primary 逻辑——数据来自水合的 tasks/runs/threads）。 */
export function taskStatusOf(s: ReturnType<typeof getState>, taskId: string | undefined): Task['status'] | undefined {
  if (taskId == null) return undefined;
  return s.tasks.find((t) => t.id === taskId)?.status;
}
