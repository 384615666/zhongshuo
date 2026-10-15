/**
 * 活动流（r55 H3 真实接线——沿批准原型 /activity 的聚合列表布局）：activity.list 正式命令
 * （domain_events 只读聚合——房间事件随项目可达、DM 事件仅本人参与可见；kind 中文映射+
 * 轻量摘要）。稳定游标分页 (created_at, seq) 双键——「加载更早」带 before/beforeSeq 成对
 * 取上一页末条；零运行零唤醒。
 *
 * 定位分列（r55）：taskId → #task=（服务端 deepLink.resolve 定位，跨项目自动打开）；
 * DM 会话 → #dm=；房间会话无任务/线程 → 使用服务端返回的所属项目/房间身份落主池
 * （#conv= 不在正式深链族——不用未支持的形式）；都查不到=不显示定位按钮（如实，不猜）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState, Tag } from './components/ui';
import { useStore, toast } from './shell';
import { command } from './bridge';
import { openExternalDeepLink } from './loader';
import { navigate } from './lib/router';

interface ActivityItem {
  eventId: string; seq: number; kind: string; kindLabel: string; at: number; summary: string;
  projectId: string; projectName: string; conversationId: string | null; threadId: string | null; taskId: string | null;
  locate: string | null; roomId:string|null;
}

const PAGE_LIMIT = 60;

export function ActivityPage() {
  const projectId = useStore((s) => s.activeProjectId);
  const [scope, setScope] = useState<'all' | 'project'>('all'); // §17.7：聚合流默认全部可访问项目
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [itemsKey, setItemsKey] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [errKey, setErrKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [gapNotice, setGapNotice] = useState(false);
  const genRef = useRef(0);
  const moreFlight = useRef<string | null>(null);
  const flightRef = useRef<string | null>(null);
  const scopeKey = scope === 'project' ? `project:${projectId ?? ''}` : 'all';
  const visibleItems = itemsKey === scopeKey ? items : null;
  const visibleErr = errKey === scopeKey ? err : null;

  const load = useCallback(async (mode: 'reset' | 'more' | 'head') => {
    if (scope === 'project' && (projectId == null || projectId === '')) {
      genRef.current += 1;
      setLoading(false);
      setErr('尚未打开项目——先在侧栏打开项目，或把范围切到「全部可访问项目」');
      setErrKey(scopeKey);
      return;
    }
    if (mode === 'head' && (visibleItems == null || flightRef.current != null)) return;
    if (mode === 'more' && (visibleItems == null || visibleItems.length === 0 || flightRef.current != null || moreFlight.current === scopeKey)) return;
    if (mode === 'reset' && flightRef.current?.startsWith(`${scopeKey}:`)) return;
    if (mode === 'more') moreFlight.current = scopeKey;
    const gen = ++genRef.current;
    flightRef.current = `${scopeKey}:${gen}`;
    setLoading(true);
    try {
      const tail = mode === 'more' && visibleItems != null && visibleItems.length > 0 ? visibleItems[visibleItems.length - 1] : null;
      const r = await command<{ items: ActivityItem[]; note?: string }>('activity.list', {
        scope, ...(scope === 'project' ? { projectId } : {}), limit: PAGE_LIMIT,
        ...(tail != null ? { before: tail.at, beforeSeq: tail.seq } : {}),
      });
      if (gen !== genRef.current) return;
      setErr(null); setErrKey(scopeKey);
      const headKeys = new Set(r.items.map((it) => `${it.eventId}:${it.seq}`));
      const headGap = mode === 'head' && visibleItems != null && visibleItems.length > 0
        && r.items.length === PAGE_LIMIT && !headKeys.has(`${visibleItems[0]!.eventId}:${visibleItems[0]!.seq}`);
      if (mode === 'reset') setGapNotice(false);
      if (headGap) setGapNotice(true);
      setItems((prev) => {
        if (mode === 'reset') return r.items;
        const old = itemsKey === scopeKey ? prev ?? [] : [];
        if (mode === 'more') return [...old, ...r.items];
        if (headGap) return r.items; // no overlap: retaining old tail would create an invisible cursor gap
        return [...r.items, ...old.filter((it) => !headKeys.has(`${it.eventId}:${it.seq}`))];
      });
      setItemsKey(scopeKey);
      setHasMore((old) => mode === 'head' ? headGap || old || r.items.length === PAGE_LIMIT : r.items.length === PAGE_LIMIT);
    } catch (e) {
      if (gen === genRef.current) { setErr((e as Error).message); setErrKey(scopeKey); } // 失败保留同范围事实
    } finally {
      if (gen === genRef.current) setLoading(false);
      if (mode === 'more' && moreFlight.current === scopeKey) moreFlight.current = null;
      if (flightRef.current === `${scopeKey}:${gen}`) flightRef.current = null;
    }
  }, [scope, projectId, visibleItems, itemsKey, scopeKey]);

  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    void loadRef.current('reset');
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !document.body.classList.contains('legacy-on')) void loadRef.current('head');
    }, 5000);
    return () => { window.clearInterval(timer); genRef.current += 1; moreFlight.current = null; flightRef.current = null; };
  }, [scopeKey]);

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
      if (it.roomId != null) return { label: '打开房间', go: () => navigate(`/project/${it.projectId}/room/${it.roomId}`) };
    }
    return null;
  };

  return (
    <div className="main" style={{ overflow: 'auto' }} data-zs-activity="hifi">
      <div className="page">
        {/* 筛选行（R66 P4：与其他页同一套控件——范围显式呈现，控件在内容区左上角）。 */}
        <div className="page-filters">
          <label className="field inline">
            <span className="field-label">范围</span>
            <select className="select" value={scope} onChange={(e) => setScope(e.target.value as 'all' | 'project')}>
              <option value="all">全部可访问项目</option>
              <option value="project">当前项目</option>
            </select>
          </label>
          <span className="filter-note">domain_events 只读聚合——DM 事件仅本人参与可见；读活动≠执行动作</span>
          <div className="spacer" />
          <button className="btn ghost sm" onClick={() => void load('reset')}>刷新</button>
        </div>
        {visibleErr != null ? <div className="panel warning">活动流读取失败：{visibleErr}——同范围已加载内容保持；其它范围旧结果未冒充当前结果（可刷新重试）</div> : null}
        {gapNotice && visibleItems != null ? <div className="panel info">刷新期间新增活动超过首页窗口；已从最新事件重新定位。点“加载更早”可按游标补读，中间历史未被假装连续。</div> : null}
        {visibleItems == null && visibleErr == null ? <div className="panel info">正在装载…</div> : null}
        {visibleItems != null && visibleItems.length === 0 && visibleErr == null ? (
          <EmptyState icon="activity" title="当前范围内还没有活动事件" detail="任务派发、交付、恢复等事件会按时间倒序出现在这里（零运行零唤醒的只读聚合）。" />
        ) : null}
        {visibleItems != null && visibleItems.length > 0 ? (
          <>
            <div className="faint small" style={{ marginBottom: 6 }}>共已加载 {visibleItems.length} 条 · 按发生时间倒序（同毫秒按 seq 决定性排序——不漏同刻事件）</div>
            <div className="col" style={{ gap: 6 }}>
              {visibleItems.map((it) => {
                const loc = locateOf(it);
                return (
                  <div key={`${it.eventId}:${it.seq}`} className="card tight" data-zs-activity-item={it.kind} data-zs-activity-id={it.eventId}>
                    <div className="row tight wrap">
                      <Tag tone="neutral" icon="clock">{it.kindLabel}</Tag>
                      <Tag tone="accent" icon="folder">{it.projectName}</Tag>
                      <span className="small" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.summary.length > 0 ? it.summary : `（无摘要事件 ${it.eventId.slice(0, 10)}…）`}</span>
                      <span className="faint small">{new Date(it.at).toLocaleString()}</span>
                      {loc != null ? <button className="btn ghost sm" onClick={loc.go}>{loc.label}</button> : null}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="row tight" style={{ marginTop: 10 }}>
              <button className="btn ghost sm" disabled={!hasMore || loading || itemsKey !== scopeKey} onClick={() => void load('more')}>
                {loading ? '加载中…' : hasMore ? '加载更早' : '没有更早的事件了'}
              </button>
            </div>
            <div className="faint small" style={{ marginTop: 6 }}>游标分页 (created_at, seq) 双键——同毫秒多条不漏；事件正文摘要来自服务端白名单字段（残缺不虚构）。</div>
          </>
        ) : null}
      </div>
    </div>
  );
}
