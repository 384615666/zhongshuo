/**
 * 活动流（r55 H3 真实接线——沿批准原型 /activity 的聚合列表布局）：activity.list 正式命令
 * （domain_events 只读聚合——房间事件随项目可达、DM 事件仅本人参与可见；kind 中文映射+
 * 轻量摘要）。稳定游标分页 (created_at, seq) 双键——「加载更早」带 before/beforeSeq 成对
 * 取上一页末条；零运行零唤醒。
 *
 * 定位分列（r55）：taskId → #task=（服务端 deepLink.resolve 定位，跨项目自动打开）；
 * DM 会话 → #dm=；房间会话无任务/线程 → 本地按 conversationId 匹配已装载房间落主池
 * （#conv= 不在正式深链族——不用未支持的形式）；都查不到=不显示定位按钮（如实，不猜）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './components/Icon';
import { Tag } from './components/ui';
import { useStore, toast } from './shell';
import { command } from './bridge';
import { openExternalDeepLink } from './loader';
import { navigate } from './lib/router';

interface ActivityItem {
  eventId: string; seq: number; kind: string; kindLabel: string; at: number; summary: string;
  projectId: string; projectName: string; conversationId: string | null; threadId: string | null; taskId: string | null;
  locate: string | null;
}

const PAGE_LIMIT = 60;

export function ActivityPage() {
  const projectId = useStore((s) => s.activeProjectId);
  const rooms = useStore((s) => s.rooms);
  const [scope, setScope] = useState<'all' | 'project'>('all'); // §17.7：聚合流默认全部可访问项目
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const genRef = useRef(0);

  const load = useCallback(async (mode: 'reset' | 'more') => {
    if (scope === 'project' && (projectId == null || projectId === '')) { setErr('尚未打开项目——先在侧栏打开项目，或把范围切到「全部可访问项目」'); setItems([]); return; }
    const gen = ++genRef.current;
    setLoading(true);
    if (mode === 'reset') setErr(null);
    try {
      const tail = mode === 'more' && items != null && items.length > 0 ? items[items.length - 1] : null;
      const r = await command<{ items: ActivityItem[]; note?: string }>('activity.list', {
        scope, ...(scope === 'project' ? { projectId } : {}), limit: PAGE_LIMIT,
        ...(tail != null ? { before: tail.at, beforeSeq: tail.seq } : {}),
      });
      if (gen !== genRef.current) return;
      setItems((prev) => (mode === 'reset' ? r.items : [...(prev ?? []), ...r.items]));
      setHasMore(r.items.length === PAGE_LIMIT);
    } catch (e) {
      if (gen === genRef.current) setErr((e as Error).message); // 失败保留已加载事实
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, [scope, projectId, items]);

  useEffect(() => { setItems(null); setHasMore(false); void load('reset'); }, [scope, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 定位分列：taskId→#task=（服务端解析）；DM→#dm=；房间会话无任务→本地房间主池。
   *  注意 daemon 的 locate 在「有线程但任务号缺失」时可能是 `#task=`（空 id）——按长度
   *  过滤，空身份不当深链用（如实落到会话/房间路径）。 */
  const locateOf = (it: ActivityItem): { label: string; go: () => void } | null => {
    if (it.taskId != null && it.locate != null && it.locate.length > '#task='.length && it.locate.startsWith('#task=')) {
      return { label: '定位任务', go: () => { void openExternalDeepLink(it.locate!).catch((e: unknown) => toast(`定位失败：${(e as Error).message}`, 'error')); } };
    }
    if (it.conversationId != null) {
      if (it.locate != null && it.locate.length > '#dm='.length && it.locate.startsWith('#dm=')) {
        return { label: '定位会话', go: () => { void openExternalDeepLink(it.locate!).catch((e: unknown) => toast(`定位失败：${(e as Error).message}`, 'error')); } };
      }
      const room = rooms.find((r) => r.conversationId === it.conversationId);
      if (room != null) return { label: '打开房间', go: () => navigate(`/room/${room.id}`) };
    }
    return null;
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 16px' }} className="page-stack" data-zs-activity="hifi">
      <div className="row tight wrap" style={{ marginBottom: 8 }}>
        <Icon name="activity" size={14} />
        <strong>活动流</strong>
        <span className="faint small">domain_events 只读聚合——DM 事件仅本人参与可见；读活动≠执行动作</span>
        <label className="field inline" style={{ marginLeft: 'auto' }}>
          <span className="field-label">范围</span>
          <select className="select" value={scope} onChange={(e) => setScope(e.target.value as 'all' | 'project')}>
            <option value="all">全部可访问项目</option>
            <option value="project">当前项目</option>
          </select>
        </label>
        <button className="btn ghost sm" onClick={() => void load('reset')}>刷新</button>
      </div>
      {err != null ? <div className="panel warning">活动流读取失败：{err}——已加载内容保持（可刷新重试）</div> : null}
      {items == null && err == null ? <div className="panel info">正在装载…</div> : null}
      {items != null && items.length === 0 && err == null ? <div className="panel info">当前范围内还没有活动事件。</div> : null}
      {items != null && items.length > 0 ? (
        <>
          <div className="faint small" style={{ marginBottom: 6 }}>共已加载 {items.length} 条 · 按发生时间倒序（同毫秒按 seq 决定性排序——不漏同刻事件）</div>
          {items.map((it) => {
            const loc = locateOf(it);
            return (
              <div key={`${it.eventId}:${it.seq}`} className="row tight" style={{ padding: '6px 8px', border: '1px solid var(--border,#dbe2ea)', borderRadius: 6, marginBottom: 6 }} data-zs-activity-item={it.kind}>
                <Tag tone="neutral" icon="clock">{it.kindLabel}</Tag>
                <span className="faint small">{it.projectName}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.summary.length > 0 ? it.summary : `（无摘要事件 ${it.eventId.slice(0, 10)}…）`}</span>
                <span className="faint small">{new Date(it.at).toLocaleString()}</span>
                {loc != null ? <button className="btn ghost sm" onClick={loc.go}>{loc.label}</button> : null}
              </div>
            );
          })}
          <div className="row tight" style={{ marginTop: 8 }}>
            <button className="btn ghost sm" disabled={!hasMore || loading} onClick={() => void load('more')}>
              {loading ? '加载中…' : hasMore ? '加载更早' : '没有更早的事件了'}
            </button>
          </div>
          <div className="faint small" style={{ marginTop: 6 }}>游标分页 (created_at, seq) 双键——同毫秒多条不漏；事件正文摘要来自服务端白名单字段（残缺不虚构）。</div>
        </>
      ) : null}
    </div>
  );
}
