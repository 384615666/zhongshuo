/**
 * 房间主池页（H1 首包，第四十七轮修订）：真实 room.pool 根消息（MessageView 呈现）+
 * Composer 正式异步发送（message.submit room_root；意图 ai→default / record→record_only；
 * @ 候选=房间 memberIds 名单）。读取失败保留旧快照+就地错误（不冒充空态）；
 * 可见时轻量刷新（5s，仅当前房间——worker 回复不需重进可见）。
 * 线程/附件/预览属 H2——入口禁用并说明，不用假动作。
 */
import { useEffect, useMemo, useRef } from 'react';
import { MessageView } from './components/MessageView';
import { Composer } from './components/Composer';
import type { FormalSendOutcome } from './components/Composer';
import { useStore, loadRoomPool, sendRoomRoot, retryUnknownSend, toast, setState } from './shell';

const EMPTY: never[] = [];
/** 正式侧能力锁定（第四十七轮）：未接通的能力点击前禁用并说明。 */
const FORMAL_LIMITS = {
  attachments: '附件上传 H2 接入——本包请用纯文本或「仅记录」；需要发文件请经「原界面」',
  method: '执行方式开关（计划/跳过初稿/分工）尚未接入本包执行链（H3）——当前按项目默认方式派发',
  access: '权限档位声明尚未接入本包（H3 按已认证能力开放）——当前按成员默认权限执行',
} as const;

export function RoomPage({ roomId }: { roomId: string }) {
  // selector 必须返回稳定引用（useSyncExternalStore 契约）——过滤/派生放 useMemo。
  const rooms = useStore((s) => s.rooms);
  const membersAll = useStore((s) => s.members);
  const poolMap = useStore((s) => s.roomPool);
  const readError = useStore((s) => s.readErrors[roomId]);
  const rosterError = useStore((s) => s.readErrors[`roster:${roomId}`]);
  const room = useMemo(() => rooms.find((r) => r.id === roomId), [rooms, roomId]);
  const members = useMemo(() => membersAll.filter((m) => m.principalType === 'agent'), [membersAll]);
  const msgs = poolMap[roomId] ?? EMPTY;
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { void loadRoomPool(roomId); }, [roomId]);
  // 活动目标追踪（接管定位用）：当前房间写入 ui.activeRoomId。
  useEffect(() => { setState((st) => ({ ...st, ui: { ...st.ui, activeRoomId: roomId } })); }, [roomId]);
  // 可见时轻量刷新：同一视图内 worker/其它端的新根消息可见（隐藏/接管时暂停）。
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !document.body.classList.contains('legacy-on')) void loadRoomPool(roomId);
    }, 5000);
    return () => { window.clearInterval(t); };
  }, [roomId]);

  if (room == null) return <div className="panel info">房间不存在或尚未装载。</div>;
  const memberById = new Map(members.map((m) => [m.id, m]));
  const roomMembers = useMemoMembers(room.memberIds, memberById);

  return (
    <div className="page-stack" style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, flex: 1 }}>
      <div className="row tight wrap" style={{ padding: '10px 14px 0' }}>
        <span className="section-title">#{room.name}</span>
        <span className="faint small">{roomMembers.length > 0 ? `成员：${roomMembers.map((m) => m.displayName).join('、')}` : rosterError != null ? '成员名单读取失败（保留上次名单；重试=切换视图）' : '暂无启用成员（仅记录仍可保存；派发需先有成员）'}</span>
        <button className="btn ghost sm" style={{ marginLeft: 'auto' }} title="在本房间的原界面打开：附件上传/任务停止/验收返工/线程与预览（尚未换装的能力经此可达）" onClick={() => import('./App').then((m) => m.takeLegacy('current-room'))}>原界面打开本房间</button>
      </div>
      <div className="msg-list" ref={listRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 14px' }}>
        {readError != null ? <div className="panel info" style={{ borderColor: 'var(--warning)' }}>读取失败：{readError}（保留上次快照——重试=切换视图或等待自动刷新）</div> : null}
        {msgs.length === 0 && readError == null ? <div className="panel info">主池暂无消息——发送第一条（或仅记录）。</div> : null}
        {msgs.map((m) => (
          <MessageView key={m.id} message={m} author={m.authorType === 'human' ? undefined : memberById.get(m.authorId)} />
        ))}
      </div>
      <Composer
        target={{ kind: 'room_root', roomId }}
        draftKey={`room:${roomId}`}
        formalLimits={FORMAL_LIMITS}
        onRetrySend={(env) => retryUnknownSend(env).then((r) => {
          if (r.status === 'ok') { void loadRoomPool(roomId); toast('重发成功（原信封）', 'success'); }
          return r.status === 'ok' ? { status: 'ok' } : r.status === 'failed' ? { status: 'failed', error: `${r.code}: ${r.error}` } : { status: 'unknown', error: r.error };
        })}
        onSend={(p): Promise<FormalSendOutcome> => (async () => {
          // 正式异步合同：回执 ok 才清空（Composer 内部处理）；failed/unknown 行内呈现并保留草稿。
          const r = await sendRoomRoot(p.commandId, roomId, p.body, p.sendAs === 'record' ? 'record_only' : 'default', p.mentionIds);
          if (r.status === 'ok') {
            void loadRoomPool(roomId);
            toast(p.sendAs === 'record' ? '已仅记录（不派发）' : '已发送', 'success');
            return { status: 'ok' };
          }
          return r.status === 'failed' ? { status: 'failed', error: `${r.code}: ${r.error}` } : { status: 'unknown', error: r.error };
        })()}
      />
    </div>
  );
}

function useMemoMembers(ids: string[], byId: Map<string, { id: string; displayName: string }>): Array<{ id: string; displayName: string }> {
  return ids.map((id) => byId.get(id)).filter((m): m is { id: string; displayName: string } => m != null);
}
