/**
 * 待我处理（第五十四轮 H3 §4）：消费 `mine.pending` **权威业务状态汇总**（纯读——零新增
 * 运行/零预算；读卡片≠完成事项）。分列保持原有区别：
 *  - 待验收任务（REVIEW）：绑定当前交付三重身份；actionable=false（无 pending 交付）如实
 *    置灰说明——不把已处理/被替代交付伪装成可批准；**定位与验收分离**：本页只定位到线程
 *    详情（验收在详情内按冻结三重身份执行）。
 *  - DM 未读 / 线程未读 / 关注线程（人的阅读订阅，与 Agent 执行名单分列）。
 *  - 阻塞任务（可见≠审批——处理入口=线程本身）。
 *  - 待确认提醒：**确认执行**走正式 reminder.confirm（状态/授权/预算事务内重读核对——同号
 *    重放恰一条获准）；与「定位」分列两个按钮。
 * 失败反馈真实：装载失败整页可见，不伪清待办；确认失败原因上屏。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './components/Icon';
import { Tag } from './components/ui';
import { useStore, toast } from './shell';
import { command } from './bridge';
import { navigate } from './lib/router';
import { openExternalDeepLink } from './loader';
import { recordWrite } from './data/store';

interface PendingData {
  projects: Array<{
    projectId: string; displayName: string;
    reviewTasks: Array<{ task_id: string; title?: string; conversation_id: string | null; status: string; delivery_id: string | null; revision: number | null; manifest_hash: string | null; actionable: boolean }>;
    dmUnread: Array<{ conversation_id: string; title: string | null; unread: number }>;
    threadUnread: Array<{ thread_id: string; unread: number }>;
    followedThreads: Array<{ thread_id: string; unread: number }>;
    blockedTasks: Array<{ task_id: string; title: string; conversation_kind: string; reason: string | null }>;
    reminderAwaits: Array<{ reminderId: string; scheduledAt: number; missedCount: number; title: string | null; conversationId: string; locate: string; notifyMuted: boolean }>;
  }>;
  generatedAt: number;
}

const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="row tight" style={{ marginTop: 8, padding: '6px 8px', border: '1px solid var(--border,#dbe2ea)', borderRadius: 6 }}>{children}</div>
);

export function PendingPage() {
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [data, setData] = useState<PendingData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** 确认忙锁按**完整 occurrence 身份**（reminderId+scheduledAt——同提醒多项待确认分别可点，
   *  r55：只按 reminderId 会把同提醒的其它 occurrence 一并锁成「确认中」）。 */
  const [confirming, setConfirming] = useState<string | null>(null);
  /** 范围显式分列（r55，review-r54 §5）：服务返回**全部可访问项目**的汇总，此前本页静默过滤
   *  当前项目——其它项目的待办无提示消失。默认仍按 §17.7=全部可访问项目（不因切项目丢待办），
   *  「当前项目」是显式收窄，页头写明范围。 */
  const [scope, setScope] = useState<'all' | 'project'>('all');
  const genRef = useRef(0);

  const reload = useCallback(async () => {
    const gen = ++genRef.current;
    setErr(null);
    try {
      const r = await command<PendingData>('mine.pending', {});
      if (gen !== genRef.current) return;
      setData(r);
    } catch (e) {
      if (gen === genRef.current) setErr((e as Error).message);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const locate = (link: string) => {
    void openExternalDeepLink(link).catch((e: unknown) => toast(`定位失败：${(e as Error).message}`, 'error'));
  };
  /** occurrence 身份键：同 reminderId 不同 scheduledAt 是两行待确认——key/忙锁同键。 */
  const occKey = (r: { reminderId: string; scheduledAt: number }): string => `${r.reminderId}:${r.scheduledAt}`;
  const confirmReminder = async (r: { reminderId: string; scheduledAt: number; title: string | null }) => {
    setConfirming(occKey(r));
    try {
      await command('reminder.confirm', { reminderId: r.reminderId, scheduledAt: r.scheduledAt });
      recordWrite('reminder.confirm', `确认提醒「${r.title ?? r.reminderId}」→ 正式执行派发`);
      toast('已确认：经正式执行链派发（任务+预占，author=system）', 'success');
      await reload();
    } catch (e) {
      toast(`确认失败：${(e as Error).message}`, 'error');
    } finally {
      setConfirming(null);
    }
  };

  const sections = scope === 'project' && activeProjectId !== ''
    ? (data?.projects.filter((p) => p.projectId === activeProjectId) ?? [])
    : (data?.projects ?? []);
  const omittedProjects = scope === 'project' && data != null
    ? data.projects.filter((p) => p.projectId !== activeProjectId)
    : [];
  const empty = sections.every((p) => p.reviewTasks.length === 0 && p.dmUnread.length === 0 && p.threadUnread.length === 0 && p.blockedTasks.length === 0 && p.reminderAwaits.length === 0 && p.followedThreads.length === 0);
  const totalCount = (sections: PendingData['projects']): number =>
    sections.reduce((n, p) => n + p.reviewTasks.length + p.dmUnread.length + p.threadUnread.length + p.blockedTasks.length + p.reminderAwaits.length + p.followedThreads.length, 0);

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 16px' }} className="page-stack" data-zs-pending="hifi">
      <div className="row tight wrap" style={{ marginBottom: 8 }}>
        <Icon name="inbox" size={14} />
        <strong>待我处理</strong>
        <span className="faint small">权威业务状态汇总（mine.pending 纯读）——读卡片≠完成事项；确认执行/验收与定位分开</span>
        <div className="row tight" style={{ marginLeft: 'auto' }} data-zs-pending-scope={scope}>
          <button className="btn ghost sm" style={scope === 'all' ? { fontWeight: 700 } : undefined} onClick={() => setScope('all')} title="§17.7：汇总当前用户全部可访问项目——项目隐藏只收起导航，不清待办">
            全部可访问项目{data != null ? `（${totalCount(data.projects)}）` : ''}
          </button>
          <button className="btn ghost sm" style={scope === 'project' ? { fontWeight: 700 } : undefined} onClick={() => setScope('project')} title="只看当前项目——其它项目的待办仍在（切回全部可见）">
            当前项目{scope === 'project' && data != null ? `（${totalCount(sections)}）` : ''}
          </button>
        </div>
        <button className="btn ghost sm" onClick={() => void reload()}>刷新</button>
      </div>
      {scope === 'project' && omittedProjects.length > 0 ? (
        <div className="faint small">范围=当前项目——另有 {omittedProjects.length} 个项目的待办未显示（切「全部可访问项目」可见，不会因此清掉）。</div>
      ) : null}
      {err != null ? <div className="panel warning">装载失败：{err}——列表保持上次事实，不伪清（可刷新重试）</div> : null}
      {data != null && empty ? <div className="panel info">{scope === 'project' ? '当前项目没有待处理事项。' : '全部可访问项目都没有待处理事项。'}</div> : null}
      {sections.map((p) => (
        <div key={p.projectId}>
          <div className="faint small" style={{ marginTop: 6 }}>项目：{p.displayName}</div>
          {p.reviewTasks.map((t) => (
            <Row key={t.task_id}>
              <Icon name="package" size={13} />
              <span style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>待验收{t.title != null ? `：${t.title}` : `任务 ${t.task_id.slice(0, 12)}…`}</span>
              {t.actionable && t.revision != null ? <Tag tone="info">交付 v{t.revision} · {String(t.manifest_hash ?? '').slice(0, 8)}…</Tag> : <Tag tone="neutral" >无可批准交付</Tag>}
              <button className="btn ghost sm" disabled={!t.actionable} title={t.actionable ? '定位到线程详情（验收在详情内按冻结三重身份执行）' : '没有 pending 交付（已处理/被替代）——不可批准，进线程查看事实'} onClick={() => locate(`#task=${t.task_id}`)}>定位</button>
              {!t.actionable ? <span className="faint small">已处理/被替代交付不因聚合成为可批准对象</span> : null}
            </Row>
          ))}
          {p.reminderAwaits.map((r) => (
            <Row key={occKey(r)}>
              <Icon name="clock" size={13} />
              <span style={{ flex: 1 }}>待确认提醒{r.title != null ? `：「${r.title}」` : ''}<span className="faint small">（{new Date(r.scheduledAt).toLocaleString()}{r.missedCount > 0 ? ` · 错过 ${r.missedCount} 次` : ''}{r.notifyMuted ? ' · 通知已静音（待办保留）' : ''}）</span></span>
              <button className="btn ghost sm" onClick={() => locate(r.locate)}>定位</button>
              <button className="btn sm" disabled={confirming === occKey(r)} title="确认执行：经正式执行链派发（状态/授权/预算事务内核对——author=system）；同提醒多次待确认按本次时间分别确认" onClick={() => void confirmReminder(r)}>{confirming === occKey(r) ? '确认中…' : '确认执行'}</button>
            </Row>
          ))}
          {p.dmUnread.map((d) => (
            <Row key={d.conversation_id}>
              <Icon name="message-square" size={13} />
              <span style={{ flex: 1 }}>私信未读{d.title != null ? `：${d.title}` : ''}</span>
              <Tag tone="warning">{d.unread} 条</Tag>
              <button className="btn ghost sm" onClick={() => locate(`#dm=${d.conversation_id}`)}>定位</button>
            </Row>
          ))}
          {p.threadUnread.map((t) => (
            <Row key={t.thread_id}>
              <Icon name="message-circle" size={13} />
              <span style={{ flex: 1 }}>线程有新回复</span>
              <Tag tone="warning">{t.unread} 条</Tag>
              <button className="btn ghost sm" title="打开线程（贴底后推进阅读水位）" onClick={() => navigate(`/thread/${t.thread_id}`)}>定位</button>
            </Row>
          ))}
          {p.followedThreads.map((t) => (
            <Row key={t.thread_id}>
              <Icon name="star" size={13} />
              <span style={{ flex: 1 }}>关注的线程有新回复<span className="faint small">（我的阅读订阅——与 Agent 执行名单分列）</span></span>
              <Tag tone="warning">{t.unread} 条</Tag>
              <button className="btn ghost sm" onClick={() => navigate(`/thread/${t.thread_id}`)}>定位</button>
            </Row>
          ))}
          {p.blockedTasks.map((b) => (
            <Row key={b.task_id}>
              <Icon name="alert-triangle" size={13} />
              <span style={{ flex: 1 }}>受阻：{b.title}</span>
              {b.reason != null ? <span className="faint small" style={{ maxWidth: '40vw', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.reason}</span> : null}
              <button className="btn ghost sm" title="可见≠审批——处理入口=线程本身" onClick={() => locate(`#task=${b.task_id}`)}>定位</button>
            </Row>
          ))}
        </div>
      ))}
      {data != null ? <div className="faint small" style={{ marginTop: 10 }}>汇总时间 {new Date(data.generatedAt).toLocaleTimeString()} · 纯读聚合（零运行零预算）；确认执行经 reminder.confirm 正式链（并发争用恰一条获准——失败原因如实上屏）。</div> : null}
    </div>
  );
}
