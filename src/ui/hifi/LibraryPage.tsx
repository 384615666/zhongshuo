/**
 * 搜索与收藏（r55 H3 真实接线——沿批准原型 /library 的「搜索/收藏」合页与筛选行布局）：
 *  - 搜索：search.query 正式命令（消息/线程锚文本/任务标题——附件只随所在消息检索；范围
 *    project=当前项目 / all=全部可访问项目；kind/页码分页）。结果带正式 locate 深链
 *    （#msg=/#task=）——点击经 deepLink.resolve 服务端定位，跨项目自动打开；不猜归属。
 *  - 收藏：saved.list（逐条 ok/missing/forbidden 如实——目标被删/越权不伪装可点）；
 *    取消收藏=saved.remove（只删收藏行，原内容不动）。收藏入口在线程回复消息的书签按钮
 *    （saved.add 幂等）。
 * 失败反馈真实：装载失败保留旧结果并上屏；空态与失败分开。请求代次收口：切标签/范围/
 * 项目的迟到响应不污染当前页。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './components/Icon';
import { EmptyState, Select, Tag } from './components/ui';
import { useStore, toast } from './shell';
import { command } from './bridge';
import { openExternalDeepLink, refreshSavedMessageRefs } from './loader';
import { recordWrite } from './data/store';

interface SearchRow {
  kind: string; snippet?: string; title?: string; status?: string;
  messageId?: string; threadId?: string; taskId?: string;
  projectId: string; projectName: string; conversationId: string; createdAt?: number | null;
  locate: string;
}
interface SearchData {
  page: number; pageSize: number; scope: 'project' | 'all';
  messages: Array<SearchRow & { kind: 'message'; snippet: string; createdAt: number }>;
  threads: Array<SearchRow & { kind: 'thread'; snippet: string; createdAt: number; taskId: string | null }>;
  tasks: Array<SearchRow & { kind: 'task'; title: string; status: string; createdAt: number | null }>;
  attachmentNote: string;
}
interface SavedItem { kind: 'message' | 'task' | 'delivery' | 'link'; ref: string; title: string | null; projectId: string | null; createdAt: number; status: 'ok' | 'missing' | 'forbidden'; locate: string | null }

const KIND_FILTERS: Array<{ value: 'all' | 'message' | 'thread' | 'task'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'message', label: '消息' },
  { value: 'thread', label: '线程' },
  { value: 'task', label: '任务' },
];
const SAVED_KIND_LABEL: Record<string, string> = { message: '消息', task: '任务', delivery: '交付', link: '链接' };

export function LibraryPage() {
  const projectId = useStore((s) => s.activeProjectId);
  const allRooms = useStore((s) => s.rooms);
  const rooms = useMemo(() => (projectId != null && projectId !== '' ? allRooms.filter((r) => r.projectId === projectId) : allRooms), [allRooms, projectId]);
  const [tab, setTab] = useState<'search' | 'saved'>('search');
  const [scope, setScope] = useState<'project' | 'visible' | 'all'>('project');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | 'message' | 'thread' | 'task'>('all');
  /** 既有筛选（r56 H4 §5）：作者显示名/日期窗（本机时区）/会话（当前项目房间）——与
   * search.query 正式参数一一对应；服务端对全部类型统一生效（线程=锚消息、任务=根消息）。 */
  const [author, setAuthor] = useState('');
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [convId, setConvId] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<SearchData | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedItem[] | null>(null);
  const [savedErr, setSavedErr] = useState<string | null>(null);
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const genRef = useRef(0);

  const runSearch = useCallback(async (nextPage: number) => {
    const text = q.trim();
    if (text.length === 0) {
      // r56（review-r55 §2）：清空关键词必须**作废在途请求**——旧实现直接 return，清空前发出
      // 的合法旧响应回来时 q 已空，6 条旧结果倒灌回页面。同时结束旧加载态、清结果与错误。
      genRef.current += 1;
      setResult(null);
      setSearchErr(null);
      setSearching(false);
      return;
    }
    if (scope === 'project' && (projectId == null || projectId === '')) {
      genRef.current += 1; // 同判：切换到无效范围也作废在途（迟到结果不归属新上下文）
      setSearching(false);
      setSearchErr('尚未打开项目——先在侧栏打开项目，或把范围切到「全部可访问项目」');
      return;
    }
    const gen = ++genRef.current;
    setSearching(true); setSearchErr(null);
    try {
      const r = await command<SearchData>('search.query', {
        text, scope, ...(scope === 'project' ? { projectId } : {}), kind, page: nextPage, pageSize: 20,
        ...(author.trim().length > 0 ? { authorDisplayName: author.trim() } : {}),
        ...(fromDay !== '' ? { fromDay } : {}),
        ...(toDay !== '' ? { toDay } : {}),
        ...(convId !== '' ? { conversationId: convId } : {}),
      });
      if (gen !== genRef.current) return;
      setResult(r); setPage(nextPage);
    } catch (e) {
      if (gen === genRef.current) setSearchErr((e as Error).message);
    } finally {
      if (gen === genRef.current) setSearching(false);
    }
  }, [q, scope, projectId, kind, author, fromDay, toDay, convId]);

  const loadSaved = useCallback(async () => {
    const gen = ++genRef.current;
    setSavedErr(null);
    try {
      const r = await command<{ items: SavedItem[] }>('saved.list', {});
      if (gen !== genRef.current) return;
      setSaved(r.items ?? []);
    } catch (e) {
      if (gen === genRef.current) setSavedErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (tab === 'saved') void loadSaved();
    else { void runSearch(1); }
  }, [tab, loadSaved, runSearch, scope, kind, projectId]);

  // 范围/类型/筛选变化即回到第 1 页重新检索（依赖 runSearch 的变化触发）。
  useEffect(() => { setPage(1); }, [scope, kind, q, author, fromDay, toDay, convId]);

  const locate = (link: string | null) => {
    if (link == null) return;
    void openExternalDeepLink(link).catch((e: unknown) => toast(`定位失败：${(e as Error).message}`, 'error'));
  };
  const removeSaved = async (it: SavedItem) => {
    setBusyRef(`${it.kind}:${it.ref}`);
    try {
      await command('saved.remove', { kind: it.kind, ref: it.ref });
      recordWrite('saved.remove', `取消收藏${SAVED_KIND_LABEL[it.kind] ?? it.kind}「${it.title ?? it.ref.slice(0, 16)}…」（原消息不动）`);
      toast('已取消收藏（原内容不受影响）', 'success');
      await loadSaved();
      // r61 G6：消息行书签按钮与收藏页同步——取消后线程/私信里的已收藏标记同批消失。
      if (it.kind === 'message') void refreshSavedMessageRefs();
    } catch (e) { toast(`取消收藏失败：${(e as Error).message}`, 'error'); }
    finally { setBusyRef(null); }
  };

  const rows: Array<SearchRow> = result == null ? [] : [...result.messages, ...result.threads, ...result.tasks]
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const total = rows.length;

  return (
    <div className="main" style={{ overflow: 'auto' }} data-zs-library="hifi">
      <div className="page">
        {/* 标签在上、一个筛选行在下（原型 §17.7：范围对两个标签都生效；关键词/类型/作者/
            日期/会话只对搜索生效——同一行里各自可辨，控件样式与看板/成员/归档同套）。 */}
        <div className="thread-tabs" style={{ marginBottom: 12 }}>
          <button role="tab" aria-selected={tab === 'search'} className={`thread-tab${tab === 'search' ? ' on' : ''}`} onClick={() => setTab('search')}>
            <Icon name="search" size={13} /> 搜索
          </button>
          <button role="tab" aria-selected={tab === 'saved'} className={`thread-tab${tab === 'saved' ? ' on' : ''}`} onClick={() => setTab('saved')}>
            <Icon name="bookmark" size={13} /> 收藏 {saved != null ? <span className="faint">{saved.length}</span> : null}
          </button>
        </div>

        <div className="page-filters">
          <label className="field inline" title="范围：当前项目 / 侧栏可见项目（navigation 偏好，无偏好=全部）/ 全部可访问项目">
            <span className="field-label">范围</span>
            <Select
              value={scope}
              ariaLabel="搜索范围"
              onChange={(v) => setScope(v as 'project' | 'visible' | 'all')}
              options={[
                { value: 'project', label: '当前项目' },
                { value: 'visible', label: '侧栏可见项目' },
                { value: 'all', label: '全部可访问项目' },
              ]}
            />
          </label>
          {tab === 'search' ? (
            <>
              <label className="field inline">
                <span className="field-label">类型</span>
                <Select value={kind} ariaLabel="类型" onChange={(v) => setKind(v as typeof kind)} options={KIND_FILTERS.map((f) => ({ value: f.value, label: f.label }))} />
              </label>
              <div className="row tight" style={{ flex: '1 1 220px', minWidth: 180, border: '1px solid var(--border)', borderRadius: 7, padding: '0 8px', background: 'var(--bg-surface)' }}>
                <Icon name="search" size={13} className="faint" style={{ flex: 'none' }} />
                <input
                  className="input"
                  style={{ border: 'none', boxShadow: 'none', flex: 1, minWidth: 0, background: 'transparent' }}
                  placeholder={scope === 'project' ? '在当前项目搜消息/线程/任务标题…（Enter 检索）' : '在全部可访问项目搜消息/线程/任务标题…（Enter 检索）'}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void runSearch(1); } }}
                />
              </div>
              <label className="field inline" title="按作者显示名过滤（跨项目同名都收——文本匹配如实）">
                <span className="field-label">作者</span>
                <input className="input sm" style={{ width: 110 }} placeholder="显示名" value={author} onChange={(e) => setAuthor(e.target.value)} />
              </label>
              <label className="field inline" title="日期按本机时区解释（toDay 含当日）">
                <span className="field-label">日期</span>
                <input className="input sm" type="date" style={{ width: 132 }} value={fromDay} onChange={(e) => setFromDay(e.target.value)} />
                <span className="faint small">至</span>
                <input className="input sm" type="date" style={{ width: 132 }} value={toDay} onChange={(e) => setToDay(e.target.value)} />
              </label>
              {scope === 'project' && rooms.length > 0 ? (
                <label className="field inline" title="限定会话（当前项目的房间）——线程=锚消息、任务=根消息统一生效">
                  <span className="field-label">会话</span>
                  <Select value={convId} ariaLabel="会话" onChange={setConvId} options={[{ value: '', label: '全部会话' }, ...rooms.map((r) => ({ value: r.conversationId ?? '', label: `#${r.name}` }))]} />
                </label>
              ) : null}
              <button className="btn ghost sm" disabled={searching || q.trim().length === 0} onClick={() => void runSearch(1)}>{searching ? '检索中…' : '检索'}</button>
            </>
          ) : null}
          <span className="filter-note">
            {tab === 'search' ? '搜索不覆盖文件正文，附件按所在消息的文件名检索' : `收藏共 ${saved?.length ?? 0} 条`}
          </span>
        </div>

      {tab === 'search' ? (
        <>
          {searchErr != null ? <div className="panel warning">搜索失败：{searchErr}——结果保持上次事实（可重试）</div> : null}          {result == null && searchErr == null && q.trim().length === 0 && !searching ? (
            <EmptyState icon="search" title="输入关键词开始搜索" detail="结果会标出来源项目与房间，点击回原处并聚焦该项目；附件按所在消息的文件名检索（正文提取未实施——如实）。" />
          ) : null}
          {result == null && searchErr == null && (q.trim().length > 0 || searching) ? (
            <div className="panel info">{searching ? '正在检索…' : '按 Enter 或点「检索」开始'}</div>
          ) : null}
          {result != null ? (
            <>
              {total === 0 ? (
                <EmptyState icon="search" title="本页没有命中" detail={`第 ${result.page} 页——换关键词或范围再试；没有结果不等于内容不存在（附件正文提取未实施）。`} />
              ) : null}
              <div className="col" style={{ gap: 8 }}>
                {rows.map((r) => (
                  <button key={`${r.kind}-${r.messageId ?? r.threadId ?? r.taskId}`} className="card tight" style={{ cursor: 'pointer', textAlign: 'left' }} onClick={() => locate(r.locate)} title={`定位：${r.locate}`}>
                    <div className="row tight wrap">
                      <Tag tone="accent" icon="folder">{r.projectName}</Tag>
                      <Tag tone={r.kind === 'task' ? 'info' : 'neutral'} icon={r.kind === 'task' ? 'list' : r.kind === 'thread' ? 'message-circle' : 'message-square'}>
                        {r.kind === 'message' ? '消息' : r.kind === 'thread' ? '线程' : '任务'}
                      </Tag>
                      {r.kind === 'task' && r.status != null ? <span className="faint small">{r.status}</span> : null}
                      <div className="spacer" />
                      <span className="faint small">{r.createdAt != null ? new Date(r.createdAt).toLocaleString() : ''}</span>
                      <span className="faint small" style={{ color: 'var(--accent,#2563eb)' }}>回原处 ↗</span>
                    </div>
                    <div className="small" style={{ marginTop: 4, lineHeight: 1.65 }}>{r.kind === 'task' ? r.title : r.snippet}</div>
                  </button>
                ))}
              </div>
              <div className="row tight" style={{ marginTop: 10 }}>
                <button className="btn ghost sm" disabled={result.page <= 1 || searching} onClick={() => void runSearch(result.page - 1)}>上一页</button>
                <span className="faint small">第 {result.page} 页（本页 {total} 条 · 每页 {result.pageSize}）</span>
                <button className="btn ghost sm" disabled={total < result.pageSize || searching} onClick={() => void runSearch(result.page + 1)}>下一页</button>
              </div>
              <div className="faint small" style={{ marginTop: 6 }}>{result.attachmentNote}</div>
            </>
          ) : null}
        </>
      ) : (
        (() => {
          // r56（review-r55 §2）：收藏「当前项目」范围此前不生效（saved.list 后不按 projectId
          // 过滤——别的项目的收藏仍显示）。按收藏行的 projectId 过滤；无项目关联的链接不属
          // 任何项目，收窄范围时明确计数说明（不静默消失），并给「复制链接」可用动作（定位
          // 按钮对链接本来就无落点——不再无声）。
          const inScope = scope === 'project' && projectId != null && projectId !== ''
            ? (saved ?? []).filter((it) => it.projectId === projectId)
            : saved ?? [];
          const linksHidden = scope === 'project' ? (saved ?? []).filter((it) => it.projectId == null).length : 0;
          const otherHidden = scope === 'project' ? (saved ?? []).filter((it) => it.projectId != null && it.projectId !== projectId).length : 0;
          return (
            <>
              {savedErr != null ? <div className="panel warning">收藏读取失败：{savedErr}——列表保持上次事实（可刷新重试）</div> : null}
              {saved == null && savedErr == null ? <div className="panel info">正在读取收藏…</div> : null}
              {saved != null && saved.length === 0 ? (
                <EmptyState icon="bookmark" title="还没有收藏" detail="在线程回复消息上点书签按钮收藏（saved.add 独立保存，不改动原内容；收藏本身不把内容共享给其他成员）。" />
              ) : null}
              {saved != null && saved.length > 0 && inScope.length === 0 && (linksHidden > 0 || otherHidden > 0) ? (
                <div className="panel info">当前项目没有收藏{otherHidden > 0 ? `（另有 ${otherHidden} 条其它项目的收藏）` : ''}{linksHidden > 0 ? `；${linksHidden} 条链接收藏无项目关联` : ''}——切「全部可访问项目」可见。</div>
              ) : null}
              <div className="col" style={{ gap: 8 }}>
                {inScope.map((it) => (
                  <div key={`${it.kind}:${it.ref}`} className="card tight">
                    <div className="row tight wrap">
                      <Icon name="bookmark" size={13} />
                      <Tag tone="neutral">{SAVED_KIND_LABEL[it.kind] ?? it.kind}</Tag>
                      <span className="small strong" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={it.title ?? it.ref}>{it.title ?? it.ref}</span>
                      <div className="spacer" />
                      <span className="faint small">{new Date(it.createdAt).toLocaleString()}</span>
                      {it.kind === 'link' ? (
                        <button
                          className="btn ghost sm"
                          title={`复制链接（${it.ref}）——应用内不自动打开外部网址`}
                          onClick={() => { void navigator.clipboard?.writeText(it.ref).then(() => toast('链接已复制', 'success'), () => toast('复制失败——链接见按钮提示', 'error')); }}
                        >复制链接</button>
                      ) : it.status === 'ok' ? (
                        <button className="btn ghost sm" title={`定位：${it.locate}`} onClick={() => locate(it.locate)}>回原处</button>
                      ) : it.status === 'missing' ? (
                        <Tag tone="warning" icon="alert-triangle">目标已不存在</Tag>
                      ) : (
                        <Tag tone="danger" icon="eye-off">当前无权访问</Tag>
                      )}
                      <button className="btn ghost sm" disabled={busyRef != null} onClick={() => void removeSaved(it)} title="取消收藏（只删收藏行——原内容不动）">取消收藏</button>
                    </div>
                  </div>
                ))}
              </div>
              {saved != null && saved.some((x) => x.status !== 'ok') ? <div className="faint small" style={{ marginTop: 6 }}>missing=收藏目标已被删除；forbidden=会话归属/可见性变化——均如实呈现，不伪装可点。</div> : null}
            </>
          );
        })()
      )}
      </div>
    </div>
  );
}
