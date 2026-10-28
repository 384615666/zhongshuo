import { userFacingSystemText } from '../../../contracts/userFacingText';
/**
 * 任务看板（R65 原型还原·TasksBoardPage 同源）：范围（侧栏可见/单项目/全部）+房间筛选+
 * 项目分组×状态分组卡片。数据=board.view 权威只读聚合（业务状态 taskStatus 与执行状态
 * runStatus 分列；exitUnconfirmed/停止未确认/待验收版本如实标注）。卡片点击定位所属线程
 * （用任务自己的 projectId/roomId/threadId——不拿全局焦点拼链接）；操作（停止/验收/返工）
 * 在线程内按三重身份执行——看板不拖卡改状态（原型语义）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { Select, EmptyState, Tag, TaskStatusTag } from '../components/ui';
import { useStore, toast } from '../shell';
import { command } from '../bridge';
import { switchFocusProject, openExternalDeepLink } from '../loader';
import { navigate } from '../lib/router';

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
  const totalCount = (data?.groups ?? []).reduce((n, g) => n + cardsOf(g).length, 0);

  return (
    <div className="main">
      <div className="page">
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
          <span className="filter-note">{data == null ? '正在读取任务' : `共 ${totalCount} 项`} · 在任务详情中处理</span>
          <button className="btn ghost" disabled={reading} onClick={() => setGen((v) => v + 1)}>{reading ? '读取中…' : '刷新'}</button>
        </div>

        {err != null ? (
          <div className="panel warning">看板读取失败：{userFacingSystemText(err ?? '')}。{data != null ? '保留上次已确认的任务；可点击刷新重试。' : '可点击刷新重试。'}</div>
        ) : null}
        {data == null ? (
          <div className="panel info">{err?'尚未取得这个范围的看板。':'正在读取看板…'}</div>
        ) : totalCount === 0 ? (
          <EmptyState icon="list" title="这个范围里还没有任务" detail="在对话池发布一条任务后，看板会按项目与状态自动分组。" />
        ) : (
          data.groups.filter((g) => cardsOf(g).length > 0 || roomFilter === 'all').map((g) => {
            const list = cardsOf(g);
            const project = s.projects.find((p) => p.id === g.projectId);
            return (
              <div key={g.projectId} className="section" style={{ marginBottom: 22 }}>
                <div className="section-title">
                  <Icon name="folder" size={14} />
                  {project?.displayName ?? g.displayName}
                  <span className="count">{list.length} 项</span>
                  {g.projectId === s.activeProjectId ? <Tag tone="accent">当前</Tag> : null}
                  {project?.status === 'missing' ? <Tag tone="danger">目录失效</Tag> : null}
                </div>
                {list.length === 0 ? (
                  <div className="panel">这个项目在当前筛选下没有任务。</div>
                ) : (
                  STATUS_GROUPS.map((grp) => {
                    const inGroup = list.filter((c) => grp.statuses.includes(c.taskStatus));
                    if (inGroup.length === 0) return null;
                    return (
                      <div key={grp.label} style={{ marginBottom: 12 }}>
                        <div className="row tight" style={{ marginBottom: 6 }}>
                          <span className="small strong">{grp.label}</span>
                          <span className="small faint">{inGroup.length}</span>
                        </div>
                        <div className="grid grid-3">
                          {inGroup.map((c) => {
                            const room = scopeRooms.find((r) => r.roomId === c.roomId);
                            return (
                              <div
                                key={c.taskId}
                                className="card"
                                data-zs-task-id={c.taskId}
                                style={{ cursor: 'pointer' }}
                                onClick={() => {
                                  if (c.threadId == null) { toast('该任务无线程（异常形态）——不定位', 'warn'); return; }
                                  void openExternalDeepLink(c.locate).catch((e: unknown) => toast(`定位失败：${userFacingSystemText((e as Error).message ?? '')}`, 'error'));
                                }}
                              >
                                <div className="row tight wrap">
                                  {c.roomTaskNumber != null ? <span className="root-task-no">#{c.roomTaskNumber}</span> : null}
                                  <TaskStatusTag status={c.taskStatus as 'OPEN'} />
                                  {c.runStatus != null && c.runStatus !== c.taskStatus ? <Tag plain icon="activity">{({ QUEUED: '运行已排队', RUNNING: '运行中', WAITING: '运行等待中', FAILED: '本轮运行失败', SUCCEEDED: '本轮运行成功', STOPPING: '正在停止', INTERRUPTED: '运行中断', CANCELLED: '运行已停止' } as Record<string, string>)[c.runStatus] ?? c.runStatus}</Tag> : null}
                                  {c.exitUnconfirmed ? <Tag tone="warning" icon="help-circle" title="运行中断且存在结果未知的 turn（恢复中心/详情取证）">退出未确认</Tag> : null}
                                  {c.pendingDelivery != null ? <Tag tone="warning" icon="eye" title={`待验收交付 v${c.pendingDelivery.revision}（交付校验值 ${c.pendingDelivery.manifestHash.slice(0, 8)}…）——在对话串详情验收当前交付`}>待验收 v{c.pendingDelivery.revision}</Tag> : null}
                                </div>
                                <div className="strong" style={{ marginTop: 6, fontSize: 12.5 }}>{c.title || '（标题未装载——进线程查看）'}</div>
                                {c.statusReason != null ? <div className="small faint clamp-2" style={{ marginTop: 3 }}>{c.statusReason}</div> : null}
                                <div className="row tight wrap small faint" style={{ marginTop: 8 }}>
                                  <Tag tone="accent" icon="folder">{project?.displayName ?? g.displayName}</Tag>
                                  <Tag plain icon="hash">{room?.name ?? c.roomId}</Tag>
                                </div>
                              </div>
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
