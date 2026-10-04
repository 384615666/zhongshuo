/**
 * 私信页（H1 首包）：真实 conversation.list/history/create/markRead + Composer 真实发送。
 * 执行态按钮（停止/继续队列/恢复/归档）与验收/返工属 H2——本包只如实显示 execState 文案，
 * 不放不可用按钮；私信会话列表在主区左侧（原型 Dm 布局的会话列），右侧消息+输入。
 */
import { useEffect, useMemo } from 'react';
import { MessageView } from './components/MessageView';
import { Composer } from './components/Composer';
import { useStore, loadDmHistory, sendDmMessage, createDm, toast } from './shell';
import { navigate, pathOf, useHashRoute } from './lib/router';

const EXEC_TEXT: Record<string, string> = {
  idle: '', running: '运行中…', queued: '排队等待（串行）', paused: '队列已暂停（停止后）', interrupted: '有中断待恢复的任务',
};
const EMPTY: never[] = [];

export function DmPage() {
  const route = useHashRoute();
  const path = pathOf(route);
  const dms = useStore((s) => s.dms);
  const membersAll = useStore((s) => s.members);
  const historyMap = useStore((s) => s.dmHistory);
  const members = useMemo(() => membersAll.filter((m) => m.principalType === 'agent'), [membersAll]);
  const activeId = path.startsWith('/dm/') ? path.slice('/dm/'.length) : dms[0]?.conversationId ?? '';
  const active = useMemo(() => dms.find((d) => d.conversationId === activeId), [dms, activeId]);
  const msgs = historyMap?.[activeId] ?? EMPTY;

  useEffect(() => { if (activeId !== '') void loadDmHistory(activeId).catch((e) => toast(`私信读取失败：${(e as Error).message}`, 'error')); }, [activeId]);

  

  return (
    <div style={{ display: 'flex', height: '100%', minWidth: 0, flex: 1 }}>
      <div className="sidebar-scroll" style={{ width: 224, borderRight: '1px solid var(--border)', padding: 8, minHeight: 0, overflow: 'auto' }}>
        <div className="side-heading">私信</div>
        {dms.length === 0 ? <div className="side-empty">本项目暂无私信会话</div> : null}
        {dms.map((d) => (
          <button
            key={d.conversationId}
            className={`side-item${d.conversationId === activeId ? ' active' : ''}`}
            title={d.title ?? `${d.peerDisplayName} 的一对一私信`}
            onClick={() => navigate(`/dm/${d.conversationId}`)}
          >
            <span className="side-item-label" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {d.peerDisplayName}{d.title != null && d.title.length > 0 ? ` · ${d.title}` : ''}
            </span>
            {d.unread > 0 ? <span className="side-marks"><NavDot /></span> : null}
          </button>
        ))}
        <div className="row tight wrap" style={{ marginTop: 6 }}>
          {members.map((m) => (
            <button key={m.id} className="btn ghost sm" title={`与 ${m.displayName} 新建一对一私信（正式 conversation.create）`} onClick={() => {
              void createDm(m.id).then((cid) => navigate(`/dm/${cid}`)).catch((e) => toast(`新建私信失败：${(e as Error).message}`, 'error'));
            }}>+ {m.displayName}</button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        {active == null ? (
          <div className="panel info" style={{ margin: 14 }}>选择或新建一个私信会话。</div>
        ) : (
          <>
            <div className="row tight wrap" style={{ padding: '10px 14px 0' }}>
              <span className="section-title">{active.peerDisplayName}{active.title != null && active.title.length > 0 ? ` · ${active.title}` : ''}</span>
              <span className="faint small">
                {active.archivedAt != null ? '已归档（只读）' : EXEC_TEXT[active.execState ?? 'idle'] ?? ''}
              </span>
            </div>
            <div className="msg-list" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 14px' }}>
              {msgs.length === 0 ? <div className="panel info">会话暂无消息。</div> : null}
              {msgs.map((m) => (
                <MessageView key={m.id} message={m} author={m.authorType === 'human' ? undefined : members.find((x) => x.id === (m as { authorId?: string | null }).authorId)} />
              ))}
            </div>
            {active.archivedAt != null ? (
              <div className="panel info" style={{ margin: '0 14px 12px' }}>已归档会话禁止新发（本包暂不提供取消归档——H2 接入）。</div>
            ) : (
              <Composer
                target={{ kind: 'dm', roomId: `dm:${active.conversationId}`, dmId: active.conversationId }}
                draftKey={`dm:${active.conversationId}`}
                showMentions={false}
                onSend={(p) => {
                  void sendDmMessage(active.conversationId, p.body, p.sendAs === 'record' ? 'record_only' : 'default', p.attachments)
                    .then(() => toast(p.sendAs === 'record' ? '已仅记录（不派发）' : '已发送', 'success'))
                    .catch(() => { /* 错误已由 loader/toast 呈现 */ });
                }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function NavDot() { return <span className="nav-dot" title="有未读" style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--accent, #2563eb)', display: 'inline-block' }} />; }
