/**
 * 任务看板（R65 原型还原·TasksBoardPage 同源）：范围（全部项目/单项目）+房间筛选+
 * 项目分组×状态分组卡片。数据=board.view 权威只读聚合（业务状态 taskStatus 与执行状态
 * runStatus 分列；exitUnconfirmed/停止未确认/待验收版本如实标注）。卡片点击定位所属线程
 * （用任务自己的 projectId/roomId/threadId——不拿全局焦点拼链接）；操作（停止/验收/返工）
 * 在线程内按三重身份执行——看板不拖卡改状态（原型语义）。
 *
 * R170（用户反馈第 3、4 项）：卡片改为「#编号 + 状态标签 / 标题两行 / 房间·项目·原因小字」。
 * R172（用户第 2 项）：单卡 ×、项目「归档本项目」、筛选栏「归档全部」统一叫**归档**——
 * 归档**只从看板收起卡片**（localStorage `zs.board.hidden.v1`），不删任务、不改状态、
 * 不发写命令，任务本身保留、仍可在原对话串打开（不是任务归档/删除）。
 * 界面不再显示「已隐藏 N 项」计数；归档后在筛选栏出现**撤销**，只回退最近一次归档操作
 * （内存记录 taskIds，刷新/重开即无撤销入口），不做恢复全部。
 *
 * R183（用户 2026-11-04 第 9 项）：左侧改成和成员管理一样的项目卡列——第一张固定
 * 「全部项目」（即原来的范围「侧栏可见项目」），下面每个未移除项目一张卡。点卡只换**本页**
 * 数据范围（scope/projectId 仍同步进 URL，深链照旧可分享），**不** switchFocusProject、
 * 不改侧栏 active 项目——与成员管理页同一语义。原来的「范围」「项目」两个下拉随之删除，
 * 房间筛选仍留在右栏筛选行；切换范围/项目时房间筛选重置为全部（沿用 roomStillValid 逻辑）。
 */
import { userFacingSystemText } from '../../../contracts/userFacingText';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { Select, EmptyState, Tag, TaskStatusTag } from '../components/ui';
import { useStore, toast } from '../shell';
import { command } from '../bridge';
import { openExternalDeepLink } from '../loader';
import { navigate } from '../lib/router';
import { hiddenTaskIds, hideTask, hideTasks, unhideTasks, subscribe } from '../lib/boardHidden';
import { orderProjectIds, useListOrderVersion } from '../data/listOrder';

type BoardScope = 'project' | 'all';

interface BoardCard {
  taskId: string; title: string; roomTaskNumber: number | null; threadId: string | null;
  projectId: string; roomId: string; ownerMemberId: string | null;
  taskStatus: string; runStatus: string | null; runId: string | null; stopGeneration: number;
  column: string; exitUnconfirmed: boolean; statusReason: string | null;
  pendingDelivery: { deliveryId: string; revision: number; manifestHash: string } | null;
  locate: string;
}
interface BoardGroup { projectId: string; displayName: string; rooms: Array<{ roomId: string; name: string; cards: BoardCard[] }> }

const STATUS_GROUPS: { label: string; statuses: string[] }[] = [
  { label: '待开始', statuses: ['OPEN'] },
  { label: '进行中', statuses: ['ACTIVE'] },
  { label: '等我处理', statuses: ['WAITING_USER'] },
  { label: '阻塞', statuses: ['BLOCKED'] },
  { label: '待审阅', statuses: ['REVIEW'] },
  { label: '已完成', statuses: ['DONE'] },
  { label: '失败', statuses: ['FAILED'] },
  { label: '已停止', statuses: ['CANCELLED'] },
];

const RUN_STATUS_COPY: Record<string, string> = {
  QUEUED: '运行已排队', RUNNING: '运行中', WAITING: '运行等待中', FAILED: '本轮运行失败',
  SUCCEEDED: '本轮运行成功', STOPPING: '正在停止', INTERRUPTED: '运行中断', CANCELLED: '运行已停止',
};

export function TasksBoardPage({ query }: { query?: Record<string, string> }) {
  const s = useStore((x) => x);
  const q = query ?? {};
  /** 本页数据范围来自 URL（scope/projectId）——由左侧项目卡写入，不回写全局焦点项目。 */
  const scope: BoardScope = q.scope === 'project' ? 'project' : 'all';
  const scopeProjectId = q.projectId ?? s.activeProjectId;
  const roomFilter = q.roomId || 'all';
  const scopeKey = scope === 'project' ? `project:${scopeProjectId}` : `visible:${s.visibleProjectIds.slice().sort().join(',')}`;
  const [snapshot, setSnapshot] = useState<{ key: string; groups: BoardGroup[] } | null>(null);
  const data = snapshot?.key === scopeKey ? snapshot : null;
  const readGeneration = useRef(0);
  const [readError, setReadError] = useState<{ key: string; message: string } | null>(null);
  const err = readError?.key === scopeKey ? readError.message : null;
  const [gen, setGen] = useState(0);
  const [reading, setReading] = useState(false);

  /** 本地归档集合（只影响看板显示）：随 CustomEvent / 其它标签页 storage 变化刷新。 */
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => hiddenTaskIds());
  useEffect(() => subscribe(() => setHiddenIds(hiddenTaskIds())), []);

  /**
   * 最近一次归档操作（仅内存，刷新/重开页面后没有撤销入口）：
   * 单卡 ×、归档本项目、归档全部各算一次操作；撤销只恢复这一批 taskIds。
   */
  const [lastArchive, setLastArchive] = useState<{ taskIds: string[] } | null>(null);

  /**
   * 二次确认：第一次点击变成「确认归档…？」，3 秒内再点才执行，超时自动收回。
   * key 形如 `all` 或 `project:<projectId>`。
   */
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const confirmTimer = useRef<number | null>(null);
  const dropConfirm = () => {
    if (confirmTimer.current != null) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = null;
    setConfirmKey(null);
  };
  const armConfirm = (key: string) => {
    if (confirmTimer.current != null) window.clearTimeout(confirmTimer.current);
    setConfirmKey(key);
    confirmTimer.current = window.setTimeout(() => {
      confirmTimer.current = null;
      setConfirmKey(null);
    }, 3000);
  };
  useEffect(() => () => {
    if (confirmTimer.current != null) window.clearTimeout(confirmTimer.current);
  }, []);

  const setParam = (patch: Record<string, string>,replace=false) => {
    const qs = new URLSearchParams({ scope, projectId: scopeProjectId, roomId: roomFilter, ...patch });
    navigate(`/board?${qs.toString()}`,{replace});
  };

  /** board.view 权威装载（scope=project 显式项目；visible/all 走服务端可见集——与导航偏好一致）。 */
  useEffect(() => {
    const ticket = ++readGeneration.current;
    let disposed = false;
    let inFlight = false;
    setReadError(null);
    if(scope==='project'&&!scopeProjectId){setReading(false);setReadError({key:scopeKey,message:'尚未选择项目，请先在左侧选择一个项目，或切到「全部项目」'});return()=>{disposed=true;++readGeneration.current;};}
    const params = scope === 'project'
      ? { scope: 'project' as const, projectId: scopeProjectId }
      : { scope: 'all' as const };
    const reload = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      setReading(true);
      try {
        const r = await command<{ groups: BoardGroup[] }>('board.view', params);
        if (!disposed && ticket === readGeneration.current) {
          setSnapshot({ key: scopeKey, groups: r.groups ?? [] });
          setReadError(null);
        }
      } catch (e: unknown) {
        if (!disposed && ticket === readGeneration.current) setReadError({key: scopeKey, message: (e as Error).message});
      } finally { inFlight = false; if (!disposed && ticket === readGeneration.current) setReading(false); }
    };
    void reload();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void reload();
    }, 5000);
    return () => { disposed = true; ++readGeneration.current; window.clearInterval(timer); };
  }, [scope, scopeProjectId, scopeKey, gen]);

  /** 范围内的房间（来自聚合自带 groups.rooms——同名房间带项目名区分）。 */
  const scopeRooms = useMemo(() => (data?.groups ?? []).flatMap((g) => (g.rooms ?? []).map((r) => ({ ...r, projectId: g.projectId, projectName: g.displayName }))), [data]);
  const roomStillValid = roomFilter === 'all' || scopeRooms.some((r) => r.roomId === roomFilter);
  useEffect(() => {
    if (data != null && !roomStillValid) { setParam({roomId:'all'},true); toast('筛选范围已变化，原来的房间筛选已清空', 'info'); }
  }, [roomStillValid, data]);

  const cardsOf = (g: BoardGroup) => g.rooms.flatMap((r) => r.cards).filter((c) => roomFilter === 'all' || c.roomId === roomFilter);
  const visibleCardsOf = (g: BoardGroup) => cardsOf(g).filter((c) => !hiddenIds.has(c.taskId));
  const totalCount = (data?.groups ?? []).reduce((n, g) => n + visibleCardsOf(g).length, 0);
  const visibleTaskIds = (data?.groups ?? []).flatMap((g) => visibleCardsOf(g).map((c) => c.taskId));
  /** 当前范围里已归档的项数（只用于决定空态文案，界面不显示这个数量）。 */
  const archivedInScope = (data?.groups ?? []).flatMap((g) => cardsOf(g)).filter((c) => hiddenIds.has(c.taskId)).length;
  /* 有卡片但全部已归档的项目整段不显示（避免误显示成「这个项目没有任务」）；
     本来就没任务的项目仍按原逻辑显示占位说明。 */
  const sections = (data?.groups ?? [])
    .map((g) => ({ g, list: visibleCardsOf(g), all: cardsOf(g) }))
    .filter(({ list, all }) => list.length > 0 || (all.length === 0 && roomFilter === 'all'));

  /**
   * R183 项目卡上的任务数：按 projectId 缓存，避免切换项目的空窗期把数字闪成 0。
   *  - 未知（还没装载过这个项目）→ null，卡片不显示数字，**不显示 0**；
   *  - scope=all 一次能拿到每个项目的可见卡片数，顺手写进缓存；
   *  - scope=project 只用当次数据更新当前项目，其它项目保留上次真值（不因不在当次数据里清零）。
   * 口径与筛选行「共 N 项」一致：已从看板归档的不计，房间筛选生效时按筛选后口径。
   * 缓存在 effect 里写（不在 render 里写 ref），写完 bump 一次让卡片读到新值。
   */
  const projectCountCache = useRef<Map<string, number>>(new Map());
  /** 「全部项目」卡的总数：切到单项目后当次数据只有该项目，所以保留上次 scope=all 的总数。 */
  const allScopeCountCache = useRef<number | null>(null);
  const [, bumpCounts] = useState(0);
  useEffect(() => {
    if (data == null) return;
    let changed = false;
    for (const g of data.groups) {
      const count = visibleCardsOf(g).length;
      if (projectCountCache.current.get(g.projectId) !== count) {
        projectCountCache.current.set(g.projectId, count);
        changed = true;
      }
    }
    if (scope === 'all' && allScopeCountCache.current !== totalCount) {
      allScopeCountCache.current = totalCount;
      changed = true;
    }
    if (changed) bumpCounts((v) => v + 1);
  }, [scope, data, hiddenIds, roomFilter]);

  /** 「全部项目」卡显示的数字：scope=all 用当次真值（同「共 N 项」），其它范围用上次已知总数。 */
  const allScopeCount = scope === 'all' && data != null ? totalCount : allScopeCountCache.current;

  /**
   * 左栏项目卡顺序跟随侧栏「项目/房间」拖动偏好（R183 第 1 项）：
   * 只排已装载的未移除项目，已移除项目不显示；订阅事件后列表立即重排。
   */
  const listOrderVersion = useListOrderVersion();
  const railProjects = useMemo(() => {
    const list = s.projects.filter((p) => p.removedAt == null);
    const rank = new Map(orderProjectIds(list.map((p) => p.id)).map((id, index) => [id, index]));
    return [...list].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  }, [s.projects, listOrderVersion]);

  /** 点「全部项目」卡=原「范围=侧栏可见项目」；切范围时房间筛选回到全部（新范围房间集不同）。
   *  URL 用 replace 同步（同成员管理页切项目）：不把每次切范围都堆进浏览器历史。 */
  const selectAllScope = () => {
    if (scope === 'all') return;
    setParam({ scope: 'all', roomId: 'all' }, true);
  };
  /** 点项目卡=只看该项目（scope=project）；只换本页数据范围，不切侧栏 active 项目。 */
  const selectProjectScope = (projectId: string) => {
    if (scope === 'project' && scopeProjectId === projectId) return;
    setParam({ scope: 'project', projectId, roomId: 'all' }, true);
  };

  const openCard = (c: BoardCard) => {
    if (c.threadId == null) { toast('该任务没有可打开的线程', 'warn'); return; }
    void openExternalDeepLink(c.locate).catch((e: unknown) => toast(`定位失败：${userFacingSystemText((e as Error).message ?? '')}`, 'error'));
  };
  /** 单卡「归档」：直接收起这张卡片并给出撤销入口（撤销只回退这一张）。 */
  const archiveCard = (c: BoardCard) => {
    hideTask(c.taskId);
    setLastArchive({ taskIds: [c.taskId] });
    toast('已从看板归档（任务本身保留，仍可在原对话串打开）', 'info');
  };
  /** 「撤销」：只恢复最近一次归档操作涉及的卡片；撤销后入口消失，不做恢复全部。 */
  const undoLastArchive = () => {
    if (lastArchive == null) return;
    unhideTasks(lastArchive.taskIds);
    setLastArchive(null);
    toast('已撤销上一次归档，卡片已放回看板（任务本身一直保留）', 'info');
  };
  /** 「归档本项目」：二次确认后归档该项目当前全部可见卡片（不删任务）。 */
  const archiveProject = (projectId: string, taskIds: string[]) => {
    const key = `project:${projectId}`;
    if (confirmKey !== key) { armConfirm(key); return; }
    dropConfirm();
    if (taskIds.length === 0) return;
    hideTasks(taskIds);
    setLastArchive({ taskIds });
    toast(`已从看板归档 ${taskIds.length} 项（任务本身保留，仍可在原对话串打开）`, 'info');
  };
  /** 「归档全部」：二次确认后归档当前范围内所有可见卡片（不删任务）。 */
  const archiveAllCards = () => {
    if (confirmKey !== 'all') { armConfirm('all'); return; }
    dropConfirm();
    if (visibleTaskIds.length === 0) return;
    hideTasks(visibleTaskIds);
    setLastArchive({ taskIds: visibleTaskIds });
    toast(`已从看板归档 ${visibleTaskIds.length} 项（任务本身保留，仍可在原对话串打开）`, 'info');
  };

  return (
    <div className="main">
      <div className="page tasks-board-page">
        {/* 左栏项目卡列（与成员管理共用 styles/r183-project-rail.css）+ 右栏看板内容。 */}
        <div className="project-split">
          <aside className="project-rail" aria-label="项目">
            <div className="project-rail-title">项目</div>
            <div className="project-rail-list">
              {/* 第一张固定「全部项目」：代替原来的「范围」下拉（=侧栏可见项目集）。 */}
              <button
                type="button"
                className={`project-card is-all-scope${scope === 'all' ? ' is-current' : ''}`}
                data-zs-board-scope-all="1"
                aria-current={scope === 'all' ? 'page' : undefined}
                title="显示全部项目的任务（只含侧栏当前可见的项目）"
                onClick={selectAllScope}
              >
                <span className="project-card-name">
                  <Icon name="grid" size={12} />
                  <span className="project-card-name-text">全部项目</span>
                </span>
                {/* meta 行常驻（CSS min-height）：数字就绪前不显示，但卡片高度不跳。 */}
                <span className="project-card-meta">
                  {allScopeCount != null ? <span className="project-card-count">共 {allScopeCount} 项</span> : null}
                </span>
              </button>
              {railProjects.map((p) => {
                const current = scope === 'project' && p.id === scopeProjectId;
                const count = projectCountCache.current.get(p.id) ?? null;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`project-card${current ? ' is-current' : ''}`}
                    data-zs-board-project={p.id}
                    aria-current={current ? 'page' : undefined}
                    title={current ? `${p.displayName}（看板当前项目）` : `只看 ${p.displayName} 的任务`}
                    onClick={() => selectProjectScope(p.id)}
                  >
                    <span className="project-card-name" title={p.displayName}>{p.displayName}</span>
                    <span className="project-card-meta">
                      {count != null ? <span className="project-card-count">{count} 项</span> : null}
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
              {railProjects.length === 0 ? <div className="project-rail-empty faint small">还没有项目。先从侧栏「打开/切换项目」添加。</div> : null}
            </div>
          </aside>

          <section className="project-content">
            {/* 筛选行：范围/项目已由左栏卡片承担，这里只留房间、计数、撤销、刷新、归档全部。 */}
            <div className="page-filters">
              <label className="field inline">
                <span className="field-label">房间</span>
                <Select
                  value={roomFilter}
                  ariaLabel="房间筛选"
                  onChange={v=>setParam({roomId:v})}
                  options={[{ value: 'all', label: '当前范围全部房间' }, ...scopeRooms.map((r) => ({ value: r.roomId, label: `${r.projectName} · ${r.name}` }))]}
                />
              </label>
              <span className="filter-note">{data == null ? '正在读取任务' : `共 ${totalCount} 项`}</span>
              {lastArchive != null ? (
                <button
                  type="button"
                  className="btn ghost sm board-undo"
                  data-zs-board-undo="1"
                  title="撤销上一次归档：只把那次归档的卡片放回看板；归档只影响看板显示，任务本身保留"
                  onClick={undoLastArchive}
                >
                  撤销
                </button>
              ) : null}
              <button className="btn ghost" disabled={reading} onClick={() => setGen((v) => v + 1)}>{reading ? '读取中…' : '刷新'}</button>
              <button
                type="button"
                className={`btn sm board-archive-all${confirmKey === 'all' ? ' danger' : ' ghost'}`}
                data-zs-board-archive-all="1"
                disabled={data == null || totalCount === 0}
                title="只从看板归档这些卡片，不删除任务（任务本身保留，仍可在原对话串打开）"
                onClick={archiveAllCards}
              >
                {confirmKey === 'all' ? '确认归档全部？' : '归档全部'}
              </button>
            </div>

            {err != null ? (
              <div className="panel warning">看板读取失败：{userFacingSystemText(err ?? '')}。{data != null ? '保留上次读取的任务；可点击刷新重试。' : '可点击刷新重试。'}</div>
            ) : null}
            {data == null ? (
              <div className="panel info">{err?'尚未取得这个范围的看板。':'正在读取看板…'}</div>
            ) : totalCount === 0 ? (
              archivedInScope > 0 ? (
                <EmptyState
                  icon="archive"
                  title="这个范围的卡片都已归档"
                  detail="归档只影响看板显示：任务本身保留，仍可在原对话串打开。"
                />
              ) : (
                <EmptyState icon="list" title="这个范围里还没有任务" detail="在对话池发布任务后，看板会显示在这里。" />
              )
            ) : (
              sections.map(({ g, list }) => {
                const project = s.projects.find((p) => p.id === g.projectId);
                const projectName = project?.displayName ?? g.displayName;
                const armed = confirmKey === `project:${g.projectId}`;
                return (
                  <div key={g.projectId} className="section board-project">
                    <div className="board-project-head">
                      <div className="section-title board-project-title">
                        <Icon name="folder" size={14} />
                        <span className="board-project-name" title={projectName}>{projectName}</span>
                        <span className="count">{list.length} 项</span>
                        {g.projectId === s.activeProjectId ? <Tag tone="accent">当前</Tag> : null}
                        {project?.status === 'missing' ? <Tag tone="danger">目录失效</Tag> : null}
                      </div>
                      {list.length > 0 ? (
                        <button
                          type="button"
                          className={`btn sm board-archive-btn ${armed ? 'danger' : 'ghost'}`}
                          data-zs-board-archive-project={g.projectId}
                          title="只从看板归档这些卡片，不删除任务（任务本身保留，仍可在原对话串打开）"
                          onClick={() => archiveProject(g.projectId, list.map((c) => c.taskId))}
                        >
                          {armed ? '确认归档本项目？' : '归档本项目'}
                        </button>
                      ) : null}
                    </div>
                    {list.length === 0 ? (
                      <div className="panel">这个项目在当前筛选下没有任务。</div>
                    ) : (
                      STATUS_GROUPS.map((grp) => {
                        const inGroup = list.filter((c) => grp.statuses.includes(c.taskStatus));
                        if (inGroup.length === 0) return null;
                        return (
                          <div key={grp.label} className="board-status-group">
                            <div className="board-status-head">
                              <span className="board-status-name">{grp.label}</span>
                              <span className="board-status-count">{inGroup.length}</span>
                            </div>
                            <div className="board-cards">
                              {inGroup.map((c) => {
                                const room = scopeRooms.find((r) => r.roomId === c.roomId);
                                const roomName = room?.name ?? c.roomId;
                                return (
                                  <article
                                    key={c.taskId}
                                    className="card board-card"
                                    data-zs-task-id={c.taskId}
                                    role="link"
                                    tabIndex={0}
                                    title="打开这个任务的对话串"
                                    onClick={(e) => {
                                      if ((e.target as HTMLElement).closest('button, a, input, select, summary')) return;
                                      openCard(c);
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.target !== e.currentTarget) return;
                                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(c); }
                                    }}
                                  >
                                    <button
                                      type="button"
                                      className="icon-btn sm board-card-remove"
                                      data-zs-board-remove={c.taskId}
                                      aria-label={c.roomTaskNumber != null ? `归档看板卡片 #${c.roomTaskNumber}` : '归档看板卡片'}
                                      title="归档（只从看板归档，任务本身保留，仍可在原对话串打开）"
                                      onClick={(e) => { e.stopPropagation(); archiveCard(c); }}
                                    >
                                      <Icon name="x" size={13} />
                                    </button>
                                    <div className="board-card-top">
                                      {c.roomTaskNumber != null ? <span className="root-task-no">#{c.roomTaskNumber}</span> : null}
                                      <TaskStatusTag status={c.taskStatus as 'OPEN'} />
                                      {c.runStatus != null && c.runStatus !== c.taskStatus ? <Tag plain icon="activity">{RUN_STATUS_COPY[c.runStatus] ?? c.runStatus}</Tag> : null}
                                      {c.exitUnconfirmed ? <Tag tone="warning" icon="help-circle" title="运行已中断，结果未确认；可在线程详情中确认">退出未确认</Tag> : null}
                                      {c.pendingDelivery != null ? <Tag tone="warning" icon="eye" title={`待验收交付 v${c.pendingDelivery.revision}——在对话串详情验收`}>待验收 v{c.pendingDelivery.revision}</Tag> : null}
                                    </div>
                                    <div className="board-card-title clamp-2">{c.title || '（标题暂不可用，进线程查看）'}</div>
                                    <div className="board-card-meta">
                                      {scope === 'all' ? (
                                        <>
                                          <span className="board-card-project" title={projectName}>{projectName}</span>
                                          <span className="board-card-sep" aria-hidden="true">·</span>
                                        </>
                                      ) : null}
                                      <span className="board-card-room" title={roomName}>{roomName}</span>
                                      {c.statusReason != null ? (
                                        <>
                                          <span className="board-card-sep" aria-hidden="true">·</span>
                                          <span className="board-card-reason" title={c.statusReason}>{c.statusReason}</span>
                                        </>
                                      ) : null}
                                    </div>
                                  </article>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                );
              })
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
