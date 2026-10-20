/**
 * 房间主池页（第五十一轮 H2 修订）：room.pool 线程卡（原型 root-card 形态——任务号/状态/
 * 正文/回复数/未读；记录串如实无任务号）→ 点击进线程视图（/thread/:id）。Composer 正式
 * 异步发送（room_root）+ 附件上传通道（uploadText/Office… 回执进不可变信封）。
 * 读取失败保留旧快照+就地错误；可见时轻量刷新（5s，仅当前房间）。
 */
import { useEffect, useMemo, useRef } from 'react';
import { Icon } from './components/Icon';
import { Tag } from './components/ui';
import { Composer } from './components/Composer';
import type { FormalSendOutcome } from './components/Composer';
import { useStore, loadRoomPool, retryUnknownSend, toast, setState } from './shell';
import { buildRoomRootEnvelope, sendEnvelope, attachmentRefsFromDraft, attachmentRangesFromDraft } from './loader';
import { stageOutbound, settleOutbound, dropOutbound, confirmOutboundUnknown } from './data/store';
import { navigate } from './lib/router';

const EMPTY: never[] = [];
/** 正式侧能力锁定（第四十七轮）：未接通的能力点击前禁用并说明。 */
const FORMAL_LIMITS = {
  method: '执行方式开关（计划/跳过初稿/分工）尚未接入本包执行链（H3）——当前按项目默认方式派发',
  access: '权限档位声明尚未接入本包（H3 按已认证能力开放）——当前按成员默认权限执行',
} as const;

const TASK_STATUS: Record<string, { label: string; tone: 'success' | 'info' | 'neutral' | 'warning' }> = {
  ACTIVE: { label: '执行中', tone: 'info' }, WAITING_USER: { label: '待你处理', tone: 'warning' },
  BLOCKED: { label: '受阻', tone: 'warning' }, REVIEW: { label: '待验收', tone: 'info' },
  DONE: { label: '已完成', tone: 'success' }, CANCELLED: { label: '已取消', tone: 'neutral' },
};

export function RoomPage({ roomId }: { roomId: string }) {
  // selector 必须返回稳定引用（useSyncExternalStore 契约）——过滤/派生放 useMemo。
  const rooms = useStore((s) => s.rooms);
  const membersAll = useStore((s) => s.members);
  const poolMap = useStore((s) => s.roomPool);
  const readError = useStore((s) => s.readErrors[roomId]);
  const rosterError = useStore((s) => s.readErrors[`roster:${roomId}`]);
  const room = useMemo(() => rooms.find((r) => r.id === roomId), [rooms, roomId]);
  const members = useMemo(() => membersAll.filter((m) => m.principalType === 'agent'), [membersAll]);
  const cards = poolMap[roomId] ?? EMPTY;
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
        <button className="btn ghost sm" style={{ marginLeft: 'auto' }} title="在本房间的原界面打开：附件管理/任务停止/验收返工/成果与预览（尚未换装的能力经此可达）" onClick={() => import('./App').then((m) => m.takeLegacy('current-room'))}>原界面打开本房间</button>
      </div>
      <div className="msg-list" ref={listRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 14px' }}>
        {readError != null ? <div className="panel info" style={{ borderColor: 'var(--warning)' }}>读取失败：{readError}（保留上次快照——重试=切换视图或等待自动刷新）</div> : null}
        {cards.length === 0 && readError == null ? <div className="panel info">主池暂无线程——发送第一条（或仅记录）。</div> : null}
        {cards.map((c) => (
          <div
            key={c.threadId}
            className="root-card"
            style={{ cursor: 'pointer' }}
            title={c.taskId != null ? `打开回复串（任务 ${c.taskId}）` : '打开记录串（无任务——发送仅保存）'}
            onClick={(e) => {
              // 文本选择不算点击（拖选复制不进线程——原型同一保护）。
              const sel = window.getSelection();
              if (sel != null && !sel.isCollapsed && sel.toString().trim().length > 0) return;
              void e;
              navigate(`/thread/${c.threadId}`);
            }}
          >
            <div className="root-card-head" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {c.taskId != null && c.roomTaskNumber != null ? <span className="root-task-no">#{c.roomTaskNumber}</span> : <Tag tone="neutral" icon="message-square">记录 · 无任务号</Tag>}
              {c.taskId != null && c.taskStatus != null && (c.taskStatus === 'REVIEW' || c.taskStatus === 'ACTIVE' || c.delivery == null) ? <Tag tone={TASK_STATUS[c.taskStatus]?.tone ?? 'neutral'} icon="activity">{TASK_STATUS[c.taskStatus]?.label ?? c.taskStatus}</Tag> : null}
              {c.taskId != null && c.delivery != null && c.delivery.status !== 'delivered' ? <Tag tone={c.delivery.status === 'blocked' || c.delivery.status === 'needs_user' ? 'warning' : 'neutral'} icon="activity">{c.delivery.status === 'delivered_with_questions' ? '已交付 · 有待确认' : c.delivery.status === 'needs_user' ? '等待你补充' : c.delivery.status === 'blocked' ? '交付未完成' : '旧格式 · 结束'}</Tag> : null}
              {c.unread > 0 ? <Tag tone="info" icon="message-square">{c.unread} 条未读</Tag> : null}
              <span style={{ flex: 1 }} />
              <span className="small faint">{c.createdAt > 0 ? new Date(c.createdAt).toLocaleString() : '时间未知'}</span>
            </div>
            <div className="root-body clamp-2" style={{ marginTop: 4 }}>{c.body || '（正文不可得——如实标注）'}</div>
            {c.delivery?.feedback?.find((item) => item.status === 'needs_revision' || item.status === 'needs_user') ? (
              <div className="small faint" style={{ marginTop: 4 }}>
                {(() => {
                  const item = c.delivery!.feedback!.find((entry) => entry.status === 'needs_revision')
                    ?? c.delivery!.feedback!.find((entry) => entry.status === 'needs_user')!;
                  return item.question ? `${item.question}${item.owner ? `（责任方：${item.owner}）` : ''}` : item.revisionRequest;
                })()}
              </div>
            ) : null}
            <div className="root-foot" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <button
                type="button"
                className="btn ghost sm"
                title={`打开回复串：${c.replyCount} 条回复${c.unread > 0 ? `，${c.unread} 条未读` : ''}`}
                onClick={(e) => { e.stopPropagation(); navigate(`/thread/${c.threadId}`); }}
              >
                <Icon name="message-square" size={11} /> {c.replyCount} 条回复
              </button>
              {c.muted ? <span className="faint small">已静音</span> : null}
              {c.lastReplyAt != null ? <span className="faint small">最后回复 {new Date(c.lastReplyAt).toLocaleString()}</span> : null}
            </div>
          </div>
        ))}
      </div>
      <Composer
        target={{ kind: 'room_root', roomId }}
        draftKey={`room:${roomId}`}
        formalLimits={FORMAL_LIMITS}
        attachmentUpload={room.conversationId != null && room.conversationId !== '' ? { conversationId: room.conversationId } : undefined}
        onRetrySend={(env) => retryUnknownSend(env).then((r) => {
          if (r.status === 'ok') { void loadRoomPool(roomId); toast('重发成功（原信封）', 'success'); }
          return r.status === 'ok' ? { status: 'ok' } : r.status === 'failed' ? { status: 'failed', error: `${r.code}: ${r.error}` } : { status: 'unknown', error: r.error };
        })}
        onSend={(p): Promise<FormalSendOutcome> => (async () => {
          // 发送前用唯一正式 builder 固化完整信封（含 projectId/conversationId/roomId——
          // 不从 UI 目标重造，review-r48 §3）；unknown 时按发起键冻结这份原信封。
          const intent = p.sendAs === 'record' ? 'record_only' : 'default';
          if (roomMembers.length === 0 && intent === 'default') {
            return { status: 'failed', error: '该房间没有启用成员——无法派发（可先用「仅记录」保存）' };
          }
          const draftKey = `room:${roomId}`;
          const refs = attachmentRefsFromDraft(draftKey, intent);
          if (refs.blockError != null) return { status: 'failed', error: refs.blockError };
          const env = buildRoomRootEnvelope(p.commandId, roomId, p.body, intent, p.mentionIds, refs.refs, { imageAck: p.imageAck, attachmentRanges: attachmentRangesFromDraft(draftKey) });
          env.revAtSend = p.draftRev;
          const staged = stageOutbound(draftKey, env); // r62 P1：预 bridge 耐久落账（三态收口）
          if (staged.ok !== true) return { status: 'failed', error: staged.error ?? '原信封未能耐久保存' };
          const r = await sendEnvelope(env);
          if (r.status === 'ok') settleOutbound(draftKey, env);
          else if (r.status === 'failed') dropOutbound(draftKey, env);
          else confirmOutboundUnknown(draftKey, env);
          if (r.status === 'ok') {
            void loadRoomPool(roomId).catch(() => { /* 读取失败另有呈现 */ });
            toast(intent === 'record_only' ? '已仅记录（不派发）' : '已发送', 'success');
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
