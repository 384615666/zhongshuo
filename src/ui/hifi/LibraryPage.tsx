import { userFacingSystemText } from '../../contracts/userFacingText';
/**
 * 搜索与收藏（r55 H3 真实接线——沿批准原型 /library 的「搜索/收藏」合页与筛选行布局）：
 *  - 搜索：search.query 正式命令（消息/线程锚文本/任务标题——附件只随所在消息检索；范围
 *    project=当前项目 / visible=侧栏可见项目；kind/页码分页）。结果带正式 locate 深链
 *    （#msg=/#task=）——点击经 deepLink.resolve 服务端定位，跨项目自动打开；不猜归属。
 *  - 收藏：saved.list（逐条 ok/missing/forbidden 如实——目标被删/越权不伪装可点）；
 *    取消收藏=saved.remove（只删收藏行，原内容不动）。收藏入口在线程回复消息的书签按钮
 *    （saved.add 幂等）。
 * 失败反馈真实：装载失败保留旧结果并上屏；空态与失败分开。请求代次收口：切标签/范围/
 * 项目的迟到响应不污染当前页。
 *
 * R188（用户 2026-11-07 第 7 项）：本页改成和任务看板一样的左侧项目卡列，替换原来的
 * 「范围」三选一下拉（当前项目 / 侧栏可见项目 / 全部可访问项目）。用户确认两条语义：
 *  ① 点项目卡**同时切换当前项目**（`focusProject`——侧栏高亮与标题栏同步），不做成看板那种
 *     「只换本页范围」；
 *  ② 第一张固定卡「全部项目」= 原来的 `scope='visible'`（侧栏当前可见的项目），不是全部可访问项目。
 * 于是范围只剩「某个项目 / 全部项目（侧栏可见）」两档；页签行、筛选行与结果区都留在右列，
 * 左栏项目卡承担范围选择，页面本身仍正常滚动（不是文件页那种整页不滚动的 fg-page）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './components/Icon';
import { EmptyState, SearchField, Select, Tag } from './components/ui';
import { useStore, toast } from './shell';
import { command } from './bridge';
import { openExternalDeepLink, refreshSavedMessageRefs } from './loader';
import { recordWrite } from './data/store';
import { focusProject } from './data/actions-nav';
import { orderProjectIds, useListOrderVersion } from './data/listOrder';

interface SearchRow {
  kind: string; snippet?: string; title?: string; status?: string;
  messageId?: string; threadId?: string; taskId?: string;
  projectId: string; projectName: string; conversationId: string; createdAt?: number | null;
  locate: string;
}
interface SearchData {
  page: number; pageSize: number; scope: 'project' | 'visible';
  messages: Array<SearchRow & { kind: 'message'; snippet: string; createdAt: number }>;
  threads: Array<SearchRow & { kind: 'thread'; snippet: string; createdAt: number; taskId: string | null }>;
  tasks: Array<SearchRow & { kind: 'task'; title: string; status: string; createdAt: number | null }>;
  attachmentNote: string;
}
export interface SavedItem { kind: 'message' | 'task' | 'delivery' | 'link'; ref: string; title: string | null; projectId: string | null; createdAt: number; status: 'ok' | 'missing' | 'forbidden'; locate: string | null }

const KIND_FILTERS: Array<{ value: 'all' | 'message' | 'thread' | 'task'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'message', label: '消息' },
  { value: 'thread', label: '线程' },
  { value: 'task', label: '任务' },
];
const SAVED_KIND_LABEL: Record<string, string> = { message: '消息', task: '任务', delivery: '交付', link: '链接' };

/**
 * R192（用户第 2 项）：收藏页只需要一个「按文字匹配」的搜索——不引入作者/日期/类型等
 * 额外检索维度，也不改 saved.list 合同。标题、链接和目标引用都参与匹配；空关键词=全显示。
 * 单独导出便于浏览器测试固定这个最小口径。
 */
export function savedItemMatchesText(item: SavedItem, query: string): boolean {
  const keyword = query.trim().toLocaleLowerCase();
  if (keyword.length === 0) return true;
  const haystack = [item.title ?? '', item.ref, SAVED_KIND_LABEL[item.kind] ?? item.kind].join('\n').toLocaleLowerCase();
  return haystack.includes(keyword);
}

/** R68 §6：任务状态中文口径（与看板 STATUS_GROUPS 同义）——检索结果不把原始 DONE 当
 * 最终用户呈现；未知状态原样显示（不猜）。 */
const TASK_STATUS_ZH: Record<string, string> = {
  OPEN: '待开始', ACTIVE: '执行中', WAITING_USER: '等我处理', BLOCKED: '阻塞',
  REVIEW: '待审阅', DONE: '已完成', FAILED: '失败', CANCELLED: '已停止',
};
function taskStatusZh(status: string): string {
  return TASK_STATUS_ZH[status] ?? status;
}

export function LibraryPage() {
  const projectId = useStore((s) => s.activeProjectId);
  const projects = useStore((s) => s.projects);
  const visibleProjectIds = useStore((s) => s.visibleProjectIds);
  const pinnedProjectIds = useStore((s) => s.pinnedProjectIds);
  const allRooms = useStore((s) => s.rooms);
  const rooms = useMemo(() => (projectId != null && projectId !== '' ? allRooms.filter((r) => r.projectId === projectId) : allRooms), [allRooms, projectId]);
  const [tab, setTab] = useState<'search' | 'saved'>('search');
  /** R192：收藏页的文字搜索（本地过滤已装载的 saved.list 结果）。 */
  const [savedQuery, setSavedQuery] = useState('');
  /** R188 第 7 项：范围只剩两档——'project'（左栏某张项目卡）与 'visible'（「全部项目」卡，
   *  =原来的侧栏可见集）。默认沿用原来的「当前项目」（=activeProjectId），由页内项目卡表达。 */
  const [scope, setScope] = useState<'project' | 'visible'>('project');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | 'message' | 'thread' | 'task'>('all');
  /** R189（用户 2026-11-07 第 2 项）：作者/日期/会话收进「更多筛选」，默认收起。
   *  为什么：本页控件最多，全部平铺会让工具栏换成两行、比另外三页高出一大截，
   *  正是用户说的「四个页面顶部栏风格不一致」。收起后工具栏与其它页同高同宽，
   *  展开时是同一个工具栏盒子里的第二排（背景/边框不变），功能一个不少。 */
  const [moreFilters, setMoreFilters] = useState(false);
  /** 既有筛选（r56 H4 §5）：作者显示名/日期窗（本机时区）/会话（当前项目房间）——与
   * search.query 正式参数一一对应；服务端对全部类型统一生效（线程=锚消息、任务=根消息）。 */
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [convId, setConvId] = useState('');
  const [result, setResult] = useState<SearchData | null>(null);
  const [resultKey, setResultKey] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [searchErrKey, setSearchErrKey] = useState('');
  const [saved, setSaved] = useState<SavedItem[] | null>(null);
  const [savedErr, setSavedErr] = useState<string | null>(null);
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const searchGenRef = useRef(0);
  const savedGenRef = useRef(0);
  const mountedRef = useRef(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 左栏项目卡（R188 第 7 项）：与成员管理/看板/文件页共用共享类，顺序跟随侧栏拖动偏好
   * （R183 第 1 项的本机显示顺序，`orderProjectIds` + 事件订阅）。已移除项目不出卡——
   * 它们也不在任何项目范围里；新项目按原顺序追加在末尾。
   */
  const listOrderVersion = useListOrderVersion();
  const railProjects = useMemo(() => {
    const list = projects.filter((p) => p.removedAt == null);
    const byId = new Map(list.map((p) => [p.id, p] as const));
    return orderProjectIds(list.map((p) => p.id)).flatMap((id) => {
      const p = byId.get(id);
      return p == null ? [] : [p];
    });
  }, [projects, listOrderVersion]);
  /** 还没打开任何项目：scope='project' 不可用（和服务端「scope=project 需要 projectId」一致），
   *  界面明确引导去点「全部项目」，而不是静默搜出空结果。 */
  const noActiveProject = projectId == null || projectId === '';
  /**
   * R189：没有「当前项目」时不要停在 scope='project' 显示「尚未打开项目」——
   * 左栏明明列着项目卡，却要用户先点一次「全部项目」才能用，像是页面坏了。
   * 这里自动落到「全部项目」（侧栏可见项目），用户点任意项目卡会再切回 project 范围。
   */
  useEffect(() => {
    if (noActiveProject) setScope('visible');
  }, [noActiveProject]);
  /**
   * 侧栏「可见项目」集合 = 可见 ∪ 置顶（与看板左栏、侧栏房间列表同口径），去掉已移除项目。
   * 「全部项目」卡的搜索与收藏过滤都用它；searchKey 也带上它，侧栏可见集变化时旧响应作废。
   */
  const visibleProjectSet = useMemo(() => {
    const removed = new Set(projects.filter((p) => p.removedAt != null).map((p) => p.id));
    return new Set([...visibleProjectIds, ...pinnedProjectIds].filter((id) => !removed.has(id)));
  }, [projects, visibleProjectIds, pinnedProjectIds]);

  const searchKey = JSON.stringify([q.trim(), scope,
    scope === 'project' ? projectId : [...visibleProjectSet].sort(),
    kind, fromDay, toDay, scope === 'project' ? convId : '']);
  const visibleResult = resultKey === searchKey ? result : null;
  const visibleSearchErr = searchErrKey === searchKey ? searchErr : null;
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; searchGenRef.current += 1; savedGenRef.current += 1; };
  }, []);

  /**
   * 点「全部项目」卡 = 原来的范围「侧栏可见项目」（scope='visible'）。
   * 只换本页范围，不切当前项目——用户确认的第 7 项语义②。
   */
  const selectAllProjects = () => {
    if (scope !== 'visible') setScope('visible');
  };
  /**
   * 点项目卡 = 本页只看该项目 + **同时切换当前项目**（用户 2026-11-07 确认的第 7 项语义①）：
   * 走唯一入口 focusProject，侧栏高亮与标题栏同步；announce:false 是因为这是明确的用户点击
   * （不是深链补选），不必每次弹「已在侧栏显示」。
   * 会话筛选用的是「当前项目的房间」，切项目后旧会话属于旧项目，必须清空（否则会拿旧项目
   * 的 conversationId 去搜新项目，结果只会是空）。
   */
  const selectProject = (pid: string) => {
    if (pid === projectId && scope === 'project') return;
    if (pid !== projectId) {
      setConvId('');
      focusProject(pid, { announce: false });
    }
    setScope('project');
  };
  /** 本页点卡之外切项目（侧栏/标题栏/深链）时同样清掉旧会话筛选——理由同上。 */
  useEffect(() => { setConvId(''); }, [projectId]);

  const runSearch = useCallback(async (nextPage: number) => {
    if (!mountedRef.current) return;
    const text = q.trim();
    if (text.length === 0) {
      // r56（review-r55 §2）：清空关键词必须**作废在途请求**——旧实现直接 return，清空前发出
      // 的合法旧响应回来时 q 已空，6 条旧结果倒灌回页面。同时结束旧加载态、清结果与错误。
      searchGenRef.current += 1;
      setResult(null);
      setResultKey('');
      setSearchErr(null);
      setSearching(false);
      return;
    }
    if (scope === 'project' && (projectId == null || projectId === '')) {
      searchGenRef.current += 1; // 同判：切换到无效范围也作废在途（迟到结果不归属新上下文）
      setSearching(false);
      setSearchErr('尚未打开项目——左栏点「全部项目」查看侧栏可见项目，或先在侧栏打开一个项目');
      setSearchErrKey(searchKey);
      return;
    }
    const gen = ++searchGenRef.current;
    setSearching(true);
    try {
      const r = await command<SearchData>('search.query', {
        text, scope, ...(scope === 'project' ? { projectId } : {}), kind, page: nextPage, pageSize: 20,
          ...(fromDay !== '' ? { fromDay } : {}),
        ...(toDay !== '' ? { toDay } : {}),
        ...(scope === 'project' && convId !== '' ? { conversationId: convId } : {}),
      });
      if (!mountedRef.current || gen !== searchGenRef.current) return;
      setResult(r); setResultKey(searchKey); setSearchErr(null); setSearchErrKey(searchKey);
    } catch (e) {
      if (mountedRef.current && gen === searchGenRef.current) { setSearchErr((e as Error).message); setSearchErrKey(searchKey); }
    } finally {
      if (mountedRef.current && gen === searchGenRef.current) setSearching(false);
    }
  }, [q, scope, projectId, kind, fromDay, toDay, convId, searchKey]);

  const loadSaved = useCallback(async () => {
    if (!mountedRef.current) return;
    const gen = ++savedGenRef.current;
    try {
      const r = await command<{ items: SavedItem[] }>('saved.list', {});
      if (!mountedRef.current || gen !== savedGenRef.current) return;
      setSaved(r.items ?? []);
      setSavedErr(null);
    } catch (e) {
      if (mountedRef.current && gen === savedGenRef.current) setSavedErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (tab !== 'search') return;
    searchTimerRef.current = setTimeout(() => { searchTimerRef.current = null; void runSearch(1); }, 250);
    return () => { if (searchTimerRef.current != null) clearTimeout(searchTimerRef.current); searchTimerRef.current = null; searchGenRef.current += 1; };
  }, [tab, runSearch]);
  useEffect(() => {
    if (tab === 'saved') void loadSaved();
    return () => { savedGenRef.current += 1; };
  }, [tab, loadSaved]);
  const searchNow = (nextPage: number) => {
    if (searchTimerRef.current != null) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = null;
    void runSearch(nextPage);
  };

  // 范围/类型/筛选变化即回到第 1 页重新检索（依赖 runSearch 的变化触发）。
  const locate = (link: string | null) => {
    if (link == null) return;
    void openExternalDeepLink(link).catch((e: unknown) => toast(`定位失败：${userFacingSystemText((e as Error).message ?? '')}`, 'error'));
  };
  const removeSaved = async (it: SavedItem) => {
    setBusyRef(`${it.kind}:${it.ref}`);
    try {
      await command('saved.remove', { kind: it.kind, ref: it.ref });
      recordWrite('saved.remove', `取消收藏${SAVED_KIND_LABEL[it.kind] ?? it.kind}「${it.title ?? it.ref.slice(0, 16)}…」（原消息不动）`);
      toast('已取消收藏，原内容不受影响', 'success');
      await loadSaved();
      // r61 G6：消息行书签按钮与收藏页同步——取消后线程/私信里的已收藏标记同批消失。
      if (it.kind === 'message') void refreshSavedMessageRefs();
    } catch (e) { toast(`取消收藏失败：${userFacingSystemText((e as Error).message ?? '')}`, 'error'); }
    finally { if (mountedRef.current) setBusyRef(null); }
  };

  const rows: Array<SearchRow> = visibleResult == null ? [] : [...visibleResult.messages, ...visibleResult.threads, ...visibleResult.tasks]
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const total = rows.length;
  /** R190（用户第 4 项）：删掉「范围：「X」· 搜索范围为消息、线程和任务标题，不含文件正文」
   *  这类说明文字——当前范围已由左栏选中卡表达，正式版不再在页面上重复开发口径。
   *  占位符只写「搜什么」，与成员页搜索框保持一致。 */
  const searchPlaceholder = '搜消息 / 线程 / 任务标题…';

  return (
    <div className="main" style={{ overflow: 'auto' }} data-zs-library="hifi">
      <div className="page library-page">
        {/* R188 第 7 项：左栏项目卡列（与成员管理/看板/文件页同一套 .project-split /
            .project-rail / .project-card，见 styles/r183-project-rail.css），替代原来的「范围」
            下拉——范围不再是抽象三选一，而是「看哪个项目」，与看板同一种操作。 */}
        <div className="project-split">
          <aside className="project-rail" aria-label="项目">
            <div className="project-rail-title">项目</div>
            <div className="project-rail-list">
              {/* 第一张固定卡「全部项目」=侧栏当前可见的项目（原 scope='visible'）。
                  点它只换本页范围，不切当前项目（与看板「全部项目」一致）。 */}
              <button
                type="button"
                className={`project-card is-all-scope${scope === 'visible' ? ' is-current' : ''}`}
                data-zs-library-scope-all="1"
                aria-current={scope === 'visible' ? 'page' : undefined}
                title="在全部项目里搜索或查看收藏；只含侧栏当前可见的项目，不切换当前项目"
                onClick={selectAllProjects}
              >
                <span className="project-card-name">
                  <Icon name="grid" size={12} />
                  <span className="project-card-name-text">全部项目</span>
                </span>
                {/* meta 行常驻（共享 CSS min-height）：卡片高度不因有无说明而跳。 */}
                <span className="project-card-meta">侧栏可见项目</span>
              </button>
              {railProjects.map((p) => {
                const current = scope === 'project' && p.id === projectId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`project-card${current ? ' is-current' : ''}`}
                    data-zs-library-project={p.id}
                    aria-current={current ? 'page' : undefined}
                    title={current ? `${p.displayName}，搜索与收藏页当前项目` : `只看「${p.displayName}」，并把当前项目切到它`}
                    onClick={() => selectProject(p.id)}
                  >
                    <span className="project-card-name" title={p.displayName}>{p.displayName}</span>
                    {/* R189（用户 2026-11-07 第 1 项）：四页项目卡统一「名称 + 一行小字」。
                        本页小字说明项目的 Git 类型（与文件与 Git 页一致），不再留空行；
                        目录失效/已归档仍以 flag 追加在后面，如实提示但不改变字体与间距。 */}
                    <span className="project-card-meta">
                      <span>{p.isGit ? 'Git 仓库' : '非 Git 目录'}</span>
                      {p.status === 'missing' ? (
                        <span className="project-card-flag"><Icon name="alert-triangle" size={11} />目录失效</span>
                      ) : null}
                      {p.archivedAt != null ? (
                        <span className="project-card-flag muted"><Icon name="archive" size={11} />已归档</span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
              {railProjects.length === 0 ? <div className="project-rail-empty faint small">还没有项目。点侧栏「工作区」右侧的按钮添加。</div> : null}
            </div>
          </aside>

          <section className="project-content">
            {/* R189（用户 2026-11-07 第 2 项）：四页顶部栏统一为同一条灰底圆角工具栏。
                本页原来「页签一行 + 筛选行一行」，现在把 搜索/收藏 页签并进工具栏（共享规则
                r189-consistency.css 的 `.page-filters > .thread-tabs` 负责高度对齐），
                搜索框换成共享 <SearchField>（放大镜+外框，与成员管理页同一个组件）。 */}
            <div className="page-filters">
              <div className="thread-tabs">
                <button role="tab" aria-selected={tab === 'search'} className={`thread-tab${tab === 'search' ? ' on' : ''}`} onClick={() => setTab('search')}>
                  <Icon name="search" size={13} /> 搜索
                </button>
                <button role="tab" aria-selected={tab === 'saved'} className={`thread-tab${tab === 'saved' ? ' on' : ''}`} onClick={() => setTab('saved')}>
                  <Icon name="bookmark" size={13} /> 收藏 {saved != null ? <span className="faint">{saved.length}</span> : null}
                </button>
              </div>
              {tab === 'saved' ? (
                <SearchField
                  ariaLabel="搜索收藏"
                  value={savedQuery}
                  onChange={setSavedQuery}
                  placeholder="搜收藏标题或链接…"
                  maxWidth={280}
                />
              ) : null}
              {tab === 'search' ? (
                <>
                  <label className="field inline">
                    <span className="field-label">类型</span>
                    <Select value={kind} ariaLabel="类型" onChange={(v) => setKind(v as typeof kind)} options={KIND_FILTERS.map((f) => ({ value: f.value, label: f.label }))} />
                  </label>
                  <SearchField
                    ariaLabel="搜索关键词"
                    value={q}
                    onChange={setQ}
                    placeholder={searchPlaceholder}
                    onEnter={() => searchNow(1)}
                  />
                  <button className="btn ghost sm" disabled={searching || q.trim().length === 0} onClick={() => searchNow(1)}>{searching ? '检索中…' : '检索'}</button>
                  {/* R189：日期/会话默认收起，保证工具栏与另外三页同高；展开后是同一盒子的第二排。
                      R190（用户第 2 项）：作者名筛选按用户要求去掉（不再提供按作者过滤）。 */}
                  <button
                    className="btn ghost sm"
                    data-zs-library-more={moreFilters ? 'open' : 'closed'}
                    aria-expanded={moreFilters}
                    title="日期 / 会话筛选"
                    onClick={() => setMoreFilters((v) => !v)}
                  >
                    <Icon name="filter" size={12} /> {moreFilters ? '收起筛选' : '更多筛选'}
                  </button>
                  {moreFilters ? (
                    /* R195（用户图6）：展开行重排。原来四个控件直接塞在灰工具栏的第二行：
                       日期输入写死宽度、标签与控件各按自己的行高排、日期与会话之间没有分组，
                       整条工具栏像被临时挤出来的一行。现在拆成「日期」「会话」两组，组内
                       控件与标签同一 30px 基线、两个日期输入等宽，两组之间用竖线分开；
                       具体尺寸/分隔/间距在 styles/r195-pages.css。收起时这一块不渲染，
                       工具栏仍是单行 48px（R189/R190 门禁口径）。 */
                    <div className="toolbar-more library-more-panel" data-zs-library-more-panel="1">
                      <label className="field inline library-more-group" data-zs-library-more-group="date" title="日期按本机时区；结束日期当天包含在内">
                        <span className="field-label">日期</span>
                        <span className="library-more-range">
                          <input className="input library-more-date" type="date" aria-label="开始日期" value={fromDay} onChange={(e) => setFromDay(e.target.value)} />
                          <span className="library-more-sep">至</span>
                          <input className="input library-more-date" type="date" aria-label="结束日期" value={toDay} onChange={(e) => setToDay(e.target.value)} />
                        </span>
                      </label>
                      {scope === 'project' && rooms.length > 0 ? (
                        <label className="field inline library-more-group" data-zs-library-more-group="conversation" title="限定会话，仅当前项目的房间">
                          <span className="field-label">会话</span>
                          <Select value={convId} ariaLabel="会话" onChange={setConvId} options={[{ value: '', label: '全部会话' }, ...rooms.map((r) => ({ value: r.conversationId ?? '', label: `#${r.name}` }))]} />
                        </label>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
            {/* R190（用户第 4 项）：删掉「范围：「X」· 搜索范围为消息、线程和任务标题，不含文件正文」
                与「… 收藏总计 N 条」这类开发口径说明——当前范围已由左栏选中卡表达，正式版不再重复提示。 */}

            {tab === 'search' ? (
              <>
                {visibleSearchErr != null ? <div className="panel warning">搜索失败：{userFacingSystemText(visibleSearchErr ?? '')}。可重试</div> : null}
                {visibleResult == null && visibleSearchErr == null && q.trim().length === 0 && !searching ? (
                  scope === 'project' && noActiveProject
                    ? <div className="panel info">尚未打开项目——点左栏「全部项目」查看侧栏可见项目，或先在侧栏打开一个项目。</div>
                    : <EmptyState icon="search" title="输入关键词开始搜索" />
                ) : null}
                {/* R190（用户第 3 项）：输入过程中不再弹「按 Enter 或点「检索」开始」提示块；
                    检索中状态由「检索」按钮自身（检索中…）表达。 */}
                {visibleResult != null ? (
                  <>
                    {total === 0 ? (
                      <EmptyState icon="search" title="本页没有命中" detail={`第 ${visibleResult.page} 页没有匹配结果，换关键词或范围再试。`} />
                    ) : null}
                    <div className="col" style={{ gap: 8 }}>
                      {rows.map((r) => (
                        <button key={`${r.kind}-${r.messageId ?? r.threadId ?? r.taskId}`} className="card tight" style={{ cursor: 'pointer', textAlign: 'left' }} onClick={() => locate(r.locate)} title="点击回到原处">
                          <div className="row tight wrap">
                            <Tag tone="accent" icon="folder">{r.projectName}</Tag>
                            <Tag tone={r.kind === 'task' ? 'info' : 'neutral'} icon={r.kind === 'task' ? 'list' : r.kind === 'thread' ? 'message-circle' : 'message-square'}>
                              {r.kind === 'message' ? '消息' : r.kind === 'thread' ? '线程' : '任务'}
                            </Tag>
                            {r.kind === 'task' && r.status != null ? <span className="faint small">{taskStatusZh(r.status)}</span> : null}
                            <div className="spacer" />
                            <span className="faint small">{r.createdAt != null ? new Date(r.createdAt).toLocaleString() : ''}</span>
                            <span className="faint small" style={{ color: 'var(--accent,#2563eb)' }}>回原处 ↗</span>
                          </div>
                          <div className="small" style={{ marginTop: 4, lineHeight: 1.65 }}>{r.kind === 'task' ? r.title : r.snippet}</div>
                        </button>
                      ))}
                    </div>
                    <div className="row tight" style={{ marginTop: 10 }}>
                      <button className="btn ghost sm" disabled={visibleResult.page <= 1 || searching} onClick={() => searchNow(visibleResult.page - 1)}>上一页</button>
                      <span className="faint small">第 {visibleResult.page} 页 · 本页 {total} 条</span>
                      <button className="btn ghost sm" disabled={total < visibleResult.pageSize || searching} onClick={() => searchNow(visibleResult.page + 1)}>下一页</button>
                    </div>
                  </>
                ) : null}
              </>
            ) : (
              (() => {
                // r56（review-r55 §2）：收藏「当前项目」范围此前不生效（saved.list 后不按 projectId
                // 过滤——别的项目的收藏仍显示）。按收藏行的 projectId 过滤；无项目关联的链接不属
                // 任何项目，收窄范围时明确计数说明（不静默消失），并给「复制链接」可用动作（定位
                // 按钮对链接本来就无落点——不再无声）。
                // R188 第 7 项：范围只剩「某个项目 / 全部项目（侧栏可见）」两档，过滤口径不变；
                // 链接收藏（无项目关联）在两档里都不可见，只如实计数说明（收藏本身不删）。
                const inScope = scope === 'project'
                  ? (saved ?? []).filter((it) => !noActiveProject && it.projectId === projectId)
                  : (saved ?? []).filter((it) => it.projectId != null && visibleProjectSet.has(it.projectId));
                const linksHidden = (saved ?? []).filter((it) => it.projectId == null).length;
                const otherHidden = scope === 'project'
                  ? (saved ?? []).filter((it) => it.projectId != null && it.projectId !== projectId).length
                  : (saved ?? []).filter((it) => it.projectId != null && !visibleProjectSet.has(it.projectId)).length;
                /** R192：搜索只在当前范围的结果里做文字过滤，不改变收藏本身与范围口径。 */
                const filtered = inScope.filter((it) => savedItemMatchesText(it, savedQuery));
                return (
                  <>
                    {scope === 'project' && noActiveProject ? <div className="panel info">尚未打开项目——点左栏「全部项目」查看侧栏可见项目，或先在侧栏打开一个项目。收藏不会丢失。</div> : null}
                    {savedErr != null ? <div className="panel warning">收藏读取失败：{userFacingSystemText(savedErr ?? '')}。可刷新重试</div> : null}
                    {saved == null && savedErr == null ? <div className="panel info">正在读取收藏…</div> : null}
                    {saved != null && saved.length === 0 ? (
                      <EmptyState icon="bookmark" title="还没有收藏" />
                    ) : null}
                    {saved != null && inScope.length > 0 && filtered.length === 0 ? (
                      <EmptyState icon="bookmark" title="没有匹配的收藏" />
                    ) : null}
                    {saved != null && saved.length > 0 && inScope.length === 0 && (linksHidden > 0 || otherHidden > 0) && !(scope === 'project' && noActiveProject) ? (
                      <div className="panel info">
                        当前范围没有收藏{otherHidden > 0 ? `，另有 ${otherHidden} 条其它项目的收藏` : ''}
                        {linksHidden > 0 ? `；${linksHidden} 条链接收藏无项目关联，不在项目范围显示，收藏仍保留` : ''}。
                        {otherHidden > 0 ? '可点左栏「全部项目」查看侧栏可见项目。' : ''}
                      </div>
                    ) : null}
                    <div className="col" style={{ gap: 8 }}>
                      {filtered.map((it) => (
                        <div key={`${it.kind}:${it.ref}`} className="card tight">
                          <div className="row tight wrap">
                            <Icon name="bookmark" size={13} />
                            <Tag tone="neutral">{SAVED_KIND_LABEL[it.kind] ?? it.kind}</Tag>
                            <span className="small strong" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={it.title ?? it.ref}>{it.title ?? it.ref}</span>
                            <div className="spacer" />
                            <span className="faint small">{new Date(it.createdAt).toLocaleString()}</span>
                            {it.kind === 'link' ? (
                              <button className="btn ghost sm" title="复制链接，应用内不自动打开外部网址" onClick={() => { void navigator.clipboard?.writeText(it.ref).then(() => toast('链接已复制', 'success'), () => toast('复制失败——链接见按钮提示', 'error')); }}>复制链接</button>
                            ) : it.status === 'ok' ? (
                              <button className="btn ghost sm" title="回到原处" onClick={() => locate(it.locate)}>回原处</button>
                            ) : it.status === 'missing' ? (
                              <Tag tone="warning" icon="alert-triangle">目标已不存在</Tag>
                            ) : (
                              <Tag tone="danger" icon="eye-off">当前无权访问</Tag>
                            )}
                            <button className="btn ghost sm" disabled={busyRef != null} onClick={() => void removeSaved(it)} title="取消收藏，不会删除原内容">取消收藏</button>
                          </div>
                        </div>
                      ))}
                    </div>
                    {saved != null && saved.some((x) => x.status !== 'ok') ? <div className="faint small" style={{ marginTop: 6 }}>部分收藏内容已删除或无法访问。</div> : null}
                  </>
                );
              })()
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
