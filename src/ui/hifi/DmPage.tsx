/**
 * 私信页（H1 首包，第四十七轮修订）：真实 conversation.list/history/create/markRead +
 * Composer 正式异步发送。已读水位继承既有合同——**前台+贴底+当前路由**才推进（页面判定）；
 * 读取失败保留旧快照+就地错误；可见时轻量刷新（会话列表+当前历史）。
 * 执行态按钮（停止/继续/恢复/取消归档）与验收/返工属 H2——本包如实显示 execState 文案与
 * 「未接通」说明，不放不可用按钮。
 */
import { useEffect, useMemo, useRef } from 'react';
import { MessageView } from './components/MessageView';
import { Composer } from './components/Composer';
import type { FormalSendOutcome } from './components/Composer';
import { useStore, loadDmHistory, sendDmMessage, createDm, refreshDms, toast } from './shell';
import { navigate, pathOf, useHashRoute } from './lib/router';

const EXEC_TEXT: Record<string, string> = {
  idle: '', running: '运行中…', queued: '排队等待（串行）', paused: '队列已暂停（停止后）', interrupted: '有中断待恢复的任务',
};
const EMPTY: never[] = [];
const FORMAL_LIMITS = {
  attachments: '附件上传 H2 接入——本包请用纯文本或「仅记录」；需要发文件请经「原界面」',
  access: '权限档位声明尚未接入本包（H3 按已认证能力开放）——私信按成员默认权限执行',
} as const;

export function DmPage() {
  const route = useHashRoute();
  const path = pathOf(route);
  const dms = useStore((s) => s.dms);
  const membersAll = useStore((s) => s.members);
  const historyMap = useStore((s) => s.dmHistory);
  const members = useMemo(() => membersAll.filter((m) => m.principalType === 'agent'), [membersAll]);
  const activeId = path.startsWith('/dm/') ? path.slice('/dm/'.length) : dms[0]?.id ?? '';
  const active = useMemo(() => dms.find((d) => d.id === activeId), [dms, activeId]);
  const msgs = historyMap[activeId] ?? EMPTY;
  const readError = useStore((s) => s.readErrors[activeId]);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 历史装载+已读水位（前台+贴底才推进——装载前记录贴底状态）。
  useEffect(() => {
    if (activeId === '') return;
    const box = listRef.current;
    const nearBottom = box != null ? (box.scrollHeight - box.scrollTop - box.clientHeight < 80) : true;
    void loadDmHistory(activeId, { markRead: document.visibilityState === 'visible' && nearBottom });
  }, [activeId]);

  // 可见时轻量刷新：执行态/新消息可见（隐藏/接管时暂停）。
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || document.body.classList.contains('legacy-on')) return;
      const box = listRef.current;
      const nearBottom = box != null ? (box.scrollHeight - box.scrollTop - box.clientHeight < 80) : true;
      if (activeId !== '') void loadDmHistory(activeId, { markRead: nearBottom });
      void refreshDms();
    }, 5000);
    return () => { window.clearInterval(t); };
  }, [activeId]);

  return (
    <div style={{ display: 'flex', height: '100%', minWidth: 0, flex: 1 }}>
      <div className="sidebar-scroll" style={{ width: 224, borderRight: '1px solid var(--border)', padding: 8, minHeight: 0, overflow: 'auto' }}>
        <div className="side-heading">私信</div>
        {dms.length === 0 ? <div className="side-empty">本项目暂无私信会话</div> : null}
        {dms.map((d) => (
          <button
            key={d.id}
            className={`side-item${d.id === activeId ? ' active' : ''}`}
            title={d.title !== '' ? d.title : `${d.peerDisplayName ?? '成员'} 的一对一私信`}
            onClick={() => navigate(`/dm/${d.id}`)}
          >
            <span className="side-item-label" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {d.peerDisplayName ?? '成员'}{d.title != null && d.title.length > 0 ? ` · ${d.title}` : ''}
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
              <span className="section-title">{active.peerDisplayName ?? '成员'}{active.title != null && active.title.length > 0 ? ` · ${active.title}` : ''}</span>
              <span className="faint small">
                {active.archivedAt != null ? '已归档（只读）' : EXEC_TEXT[active.execState ?? 'idle'] ?? ''}
              </span>
            </div>
            <div className="msg-list" ref={listRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 14px' }}>
              {readError != null ? <div className="panel info" style={{ borderColor: 'var(--warning)' }}>读取失败：{readError}（保留上次快照）</div> : null}
              {msgs.length === 0 && readError == null ? <div className="panel info">会话暂无消息。</div> : null}
              {msgs.map((m) => (
                <MessageView key={m.id} message={m} author={m.authorType === 'human' ? undefined : members.find((x) => x.id === m.authorId)} />
              ))}
            </div>
            {active.archivedAt != null ? (
              <div className="panel info" style={{ margin: '0 14px 12px' }}>已归档会话禁止新发（取消归档入口 H2 接入——当前经「原界面」操作）。</div>
            ) : (
              <Composer
                target={{ kind: 'dm', roomId: `dm:${active.id}`, dmId: active.id }}
                draftKey={`dm:${active.id}`}
                showMentions={false}
                formalLimits={FORMAL_LIMITS}
                onSend={(p): Promise<FormalSendOutcome> => (async () => {
                  const r = await sendDmMessage(p.commandId, active.id, p.body, p.sendAs === 'record' ? 'record_only' : 'default');
                  if (r.status === 'ok') {
                    void loadDmHistory(active.id, { markRead: true });
                    void refreshDms();
                    toast(p.sendAs === 'record' ? '已仅记录（不派发）' : '已发送', 'success');
                    return { status: 'ok' };
                  }
                  return r.status === 'failed' ? { status: 'failed', error: `${r.code}: ${r.error}` } : { status: 'unknown', error: r.error };
                })()}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function NavDot() { return <span className="nav-dot" title="有未读" style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--accent, #2563eb)', display: 'inline-block' }} />; }
