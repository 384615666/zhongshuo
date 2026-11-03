import { userFacingSystemText } from '../../../contracts/userFacingText';
/**
 * 任务看板（R65 原型还原·TasksBoardPage 同源）：范围（侧栏可见/单项目/全部）+房间筛选+
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
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { Select, EmptyState, Tag, TaskStatusTag } from '../components/ui';
import { useStore, toast } from '../shell';
import { command } from '../bridge';
import { switchFocusProject, openExternalDeepLink } from '../loader';
import { navigate } from '../lib/router';
import { hiddenTaskIds, hideTask, hideTasks, unhideTasks, subscribe } from '../lib/boardHidden';

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
    if(scope==='project'&&!scopeProjectId){setReading(false);setReadError({key:scopeKey,message:'尚未选择项目，请先选择一个项目或切换到侧栏可见项目'});return()=>{disposed=true;++readGeneration.current;};}
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
        <div className="page-filters">
          <label className="field inline">
            <span className="field-label">范围</span>
            <Select
              value={scope}
              ariaLabel="看板范围"
              onChange={(v) => {
                const next = v as BoardScope;
                if (next === 'project') void switchFocusProject(scopeProjectId);
                setParam({ scope: next, roomId: 'all' });
                setGen((v) => v + 1);
              }}
              options={[
                { value: 'project', label: '当前项目' },
                { value: 'all', label: '侧栏可见项目' },
              ]}
            />
          </label>
          {scope === 'project' ? (
            <label className="field inline">
              <span className="field-label">项目</span>
              <Select
                value={scopeProjectId}
                ariaLabel="看板项目"
                onChange={(next) => {
                  void switchFocusProject(next);
                  setParam({ projectId: next, roomId: 'all' });
                  setGen((v) => v + 1);
                }}
                options={s.projects.filter((p) => p.removedAt == null).map((p) => ({ value: p.id, label: p.displayName }))}
              />
            </label>
          ) : null}
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
      </div>
    </div>
  );
}
