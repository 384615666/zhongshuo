/**
 * 房间主池页（H1 首包）：真实 room.pool 根消息（MessageView 呈现）+ Composer 真实发送
 * （message.submit room_root；意图 ai→default / record→record_only；mention 选择成员）。
 * 线程打开/附件/预览属 H2——入口不出现或如实标注，不用假动作。
 */
import { useEffect, useMemo } from 'react';
import { MessageView } from './components/MessageView';
import { Composer } from './components/Composer';
import { useStore, loadRoomPool, sendRoomRoot, toast } from './shell';

const EMPTY: never[] = [];

export function RoomPage({ roomId }: { roomId: string }) {
  // selector 必须返回稳定引用（useSyncExternalStore 契约）——过滤/派生放 useMemo。
  const rooms = useStore((s) => s.rooms);
  const membersAll = useStore((s) => s.members);
  const poolMap = useStore((s) => s.roomPool);
  const room = useMemo(() => rooms.find((r) => r.id === roomId), [rooms, roomId]);
  const members = useMemo(() => membersAll.filter((m) => m.principalType === 'agent'), [membersAll]);
  const msgs = poolMap?.[roomId] ?? EMPTY;

  useEffect(() => { void loadRoomPool(roomId).catch((e) => toast(`主池读取失败：${(e as Error).message}`, 'error')); }, [roomId]);

  if (room == null) return <div className="panel info">房间不存在或尚未装载。</div>;
  const memberById = new Map(members.map((m) => [m.id, m]));

  return (
    <div className="page-stack" style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, flex: 1 }}>
      <div className="row tight wrap" style={{ padding: '10px 14px 0' }}>
        <span className="section-title">#{room.name}</span>
        <span className="faint small">{members.length > 0 ? `成员：${members.map((m) => m.displayName).join('、')}` : '暂无启用成员'}</span>
      </div>
      <div className="msg-list" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 14px' }}>
        {msgs.length === 0 ? <div className="panel info">主池暂无消息——发送第一条（或仅记录）。</div> : null}
        {msgs.map((m) => (
          <MessageView key={m.id} message={m} author={m.authorType === 'human' ? undefined : memberById.get((m as { authorId?: string }).authorId ?? '')} />
        ))}
      </div>
      <Composer
        target={{ kind: 'room_root', roomId }}
        draftKey={`room:${roomId}`}
        onSend={(p) => {
          void sendRoomRoot(roomId, p.body, p.sendAs === 'record' ? 'record_only' : 'default', p.mentionIds, p.attachments)
            .then(() => toast(p.sendAs === 'record' ? '已仅记录（不派发）' : '已发送', 'success'))
            .catch(() => { /* 错误已由 loader/toast 呈现 */ });
        }}
      />
    </div>
  );
}
