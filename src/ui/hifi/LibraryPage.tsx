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
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './components/Icon';
import { Tag } from './components/ui';
import { useStore, toast } from './shell';
import { command } from './bridge';
import { openExternalDeepLink } from './loader';
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
  const [tab, setTab] = useState<'search' | 'saved'>('search');
  const [scope, setScope] = useState<'project' | 'all'>('project');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | 'message' | 'thread' | 'task'>('all');
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
    if (text.length === 0) { setResult(null); setSearchErr(null); return; }
    if (scope === 'project' && (projectId == null || projectId === '')) { setSearchErr('尚未打开项目——先在侧栏打开项目，或把范围切到「全部可访问项目」'); return; }
    const gen = ++genRef.current;
    setSearching(true); setSearchErr(null);
    try {
      const r = await command<SearchData>('search.query', { text, scope, ...(scope === 'project' ? { projectId } : {}), kind, page: nextPage, pageSize: 20 });
      if (gen !== genRef.current) return;
      setResult(r); setPage(nextPage);
    } catch (e) {
      if (gen === genRef.current) setSearchErr((e as Error).message);
    } finally {
      if (gen === genRef.current) setSearching(false);
    }
  }, [q, scope, projectId, kind]);

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

  // 范围/类型变化即回到第 1 页重新检索（依赖 runSearch 的变化触发）。
  useEffect(() => { setPage(1); }, [scope, kind, q]);

  const locate = (link: string | null) => {
    if (link == null) return;
    void openExternalDeepLink(link).catch((e: unknown) => toast(`定位失败：${(e as Error).message}`, 'error'));
  };
  const removeSaved = async (it: SavedItem) => {
    setBusyRef(`${it.kind}:${it.ref}`);
    try {
      await command('saved.remove', { kind: it.kind, ref: it.ref });
      recordWrite('saved.remove', `取消收藏${SAVED_KIND_LABEL[it.kind] ?? it.kind}「${it.title ?? it.ref.slice(0, 16)}…」（原内容不动）`);
      toast('已取消收藏（原内容不受影响）', 'success');
      await loadSaved();
    } catch (e) { toast(`取消收藏失败：${(e as Error).message}`, 'error'); }
    finally { setBusyRef(null); }
  };

  const rows: Array<SearchRow> = result == null ? [] : [...result.messages, ...result.threads, ...result.tasks]
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const total = rows.length;

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 16px' }} className="page-stack" data-zs-library="hifi">
      <div className="thread-tabs" style={{ marginBottom: 10 }}>
        <button role="tab" aria-selected={tab === 'search'} className={`thread-tab${tab === 'search' ? ' on' : ''}`} onClick={() => setTab('search')}>
          <Icon name="search" size={13} /> 搜索
        </button>
        <button role="tab" aria-selected={tab === 'saved'} className={`thread-tab${tab === 'saved' ? ' on' : ''}`} onClick={() => setTab('saved')}>
          <Icon name="bookmark" size={13} /> 收藏 {saved != null ? <span className="faint">{saved.length}</span> : null}
        </button>
      </div>

      <div className="row tight wrap" style={{ marginBottom: 10 }}>
        <label className="field inline" title="范围：当前项目 / 全部可访问项目（同 mine.pending 口径——正式链无隐藏位）">
          <span className="field-label">范围</span>
          <select className="select" value={scope} onChange={(e) => setScope(e.target.value as 'project' | 'all')}>
            <option value="project">当前项目</option>
            <option value="all">全部可访问项目</option>
          </select>
        </label>
        {tab === 'search' ? (
          <>
            <label className="field inline">
              <span className="field-label">类型</span>
              <select className="select" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                {KIND_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </label>
            <div style={{ flex: '1 1 220px', minWidth: 180 }}>
              <input
                className="composer-input"
                style={{ width: '100%' }}
                placeholder={scope === 'project' ? '在当前项目搜消息/线程/任务标题…（Enter 检索）' : '在全部可访问项目搜消息/线程/任务标题…（Enter 检索）'}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void runSearch(1); } }}
              />
            </div>
            <button className="btn ghost sm" disabled={searching || q.trim().length === 0} onClick={() => void runSearch(1)}>{searching ? '检索中…' : '检索'}</button>
          </>
        ) : null}
      </div>

      {tab === 'search' ? (
        <>
          {searchErr != null ? <div className="panel warning">搜索失败：{searchErr}——结果保持上次事实（可重试）</div> : null}
          {result == null && searchErr == null ? (
            <div className="panel info">{q.trim().length === 0 ? '输入关键词后检索——消息正文/线程锚文本/任务标题（附件按所在消息的文件名检索）。' : '正在检索…'}</div>
          ) : null}
          {result != null ? (
            <>
              {total === 0 ? <div className="panel info">本页没有命中（第 {result.page} 页）——换关键词或范围再试；没有结果不等于内容不存在（附件正文提取未实施）。</div> : null}
              {rows.map((r) => (
                <button key={`${r.kind}-${r.messageId ?? r.threadId ?? r.taskId}`} className="root-card" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 6, padding: 8 }} onClick={() => locate(r.locate)} title={`定位：${r.locate}`}>
                  <div className="row tight">
                    <Tag tone={r.kind === 'task' ? 'info' : r.kind === 'thread' ? 'neutral' : 'neutral'} icon={r.kind === 'task' ? 'list' : r.kind === 'thread' ? 'message-circle' : 'message-square'}>
                      {r.kind === 'message' ? '消息' : r.kind === 'thread' ? '线程' : '任务'}
                    </Tag>
                    <span className="faint small">{r.projectName}</span>
                    {r.kind === 'task' && r.status != null ? <span className="faint small">· {r.status}</span> : null}
                    <span style={{ flex: 1 }} />
                    <span className="faint small">{r.createdAt != null ? new Date(r.createdAt).toLocaleString() : ''}</span>
                    <span className="faint small" style={{ color: 'var(--accent,#2563eb)' }}>定位 ↗</span>
                  </div>
                  <div className="small" style={{ marginTop: 4 }}>{r.kind === 'task' ? r.title : r.snippet}</div>
                </button>
              ))}
              <div className="row tight" style={{ marginTop: 8 }}>
                <button className="btn ghost sm" disabled={result.page <= 1 || searching} onClick={() => void runSearch(result.page - 1)}>上一页</button>
                <span className="faint small">第 {result.page} 页（本页 {total} 条 · 每页 {result.pageSize}）</span>
                <button className="btn ghost sm" disabled={total < result.pageSize || searching} onClick={() => void runSearch(result.page + 1)}>下一页</button>
              </div>
              <div className="faint small" style={{ marginTop: 6 }}>{result.attachmentNote}</div>
            </>
          ) : null}
        </>
      ) : (
        <>
          {savedErr != null ? <div className="panel warning">收藏读取失败：{savedErr}——列表保持上次事实（可刷新重试）</div> : null}
          {saved == null && savedErr == null ? <div className="panel info">正在读取收藏…</div> : null}
          {saved != null && saved.length === 0 ? <div className="panel info">还没有收藏——在线程回复消息上点书签按钮收藏（saved.add 独立保存，不改动原内容）。</div> : null}
          {saved != null && saved.length > 0 ? saved.map((it) => (
            <div key={`${it.kind}:${it.ref}`} className="row tight" style={{ padding: '6px 8px', border: '1px solid var(--border,#dbe2ea)', borderRadius: 6, marginBottom: 6 }}>
              <Icon name="bookmark" size={13} />
              <Tag tone="neutral">{SAVED_KIND_LABEL[it.kind] ?? it.kind}</Tag>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={it.title ?? it.ref}>{it.title ?? it.ref}</span>
              <span className="faint small">{new Date(it.createdAt).toLocaleString()}</span>
              {it.status === 'ok' ? (
                <button className="btn ghost sm" title={`定位：${it.locate}`} onClick={() => locate(it.locate)}>定位</button>
              ) : it.status === 'missing' ? (
                <Tag tone="warning" icon="alert-triangle">目标已不存在</Tag>
              ) : (
                <Tag tone="danger" icon="eye-off">当前无权访问</Tag>
              )}
              <button className="btn ghost sm" disabled={busyRef != null} onClick={() => void removeSaved(it)} title="取消收藏（只删收藏行——原内容不动）">取消收藏</button>
            </div>
          )) : null}
          {saved != null && saved.some((x) => x.status !== 'ok') ? <div className="faint small" style={{ marginTop: 6 }}>missing=收藏目标已被删除；forbidden=会话归属/可见性变化——均如实呈现，不伪装可点。</div> : null}
        </>
      )}
    </div>
  );
}
