/**
 * 任务看板（R65 原型还原·TasksBoardPage 同源）：范围（侧栏可见/单项目/全部）+房间筛选+
 * 项目分组×状态分组卡片。数据=board.view 权威只读聚合（业务状态 taskStatus 与执行状态
 * runStatus 分列；exitUnconfirmed/停止未确认/待验收版本如实标注）。卡片点击定位所属线程
 * （用任务自己的 projectId/roomId/threadId——不拿全局焦点拼链接）；操作（停止/验收/返工）
 * 在线程内按三重身份执行——看板不拖卡改状态（原型语义）。
 */
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { EmptyState, Tag, TaskStatusTag } from '../components/ui';
import { useStore, toast } from '../shell';
import { command } from '../bridge';
import { switchFocusProject } from '../loader';
import { navigate } from '../lib/router';

type BoardScope = 'visible' | 'project' | 'all';

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
  { label: '执行中', statuses: ['ACTIVE'] },
  { label: '等我处理', statuses: ['WAITING_USER'] },
  { label: '阻塞', statuses: ['BLOCKED'] },
  { label: '待审阅', statuses: ['REVIEW'] },
  { label: '已完成', statuses: ['DONE', 'FAILED'] },
  { label: '已停止', statuses: ['CANCELLED'] },
];

export function TasksBoardPage({ query }: { query?: Record<string, string> }) {
  const s = useStore((x) => x);
  const q = query ?? {};
  const scope: BoardScope = q.scope === 'project' ? 'project' : q.scope === 'all' ? 'all' : 'visible';
  const scopeProjectId = q.projectId ?? s.activeProjectId;
  const [roomFilter, setRoomFilter] = useState(q.roomId ?? 'all');
  const [data, setData] = useState<{ groups: BoardGroup[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gen, setGen] = useState(0);

  const setParam = (patch: Record<string, string>) => {
    const qs = new URLSearchParams({ scope, projectId: scopeProjectId, roomId: roomFilter, ...patch });
    navigate(`/board?${qs.toString()}`, { replace: true });
  };

  /** board.view 权威装载（scope=project 显式项目；visible/all 走服务端可见集——与导航偏好一致）。 */
  useEffect(() => {
    const myGen = gen;
    setData(null); setErr(null);
    // scope=project 走显式项目；visible 走服务端可见集（board.view scope=all 按导航偏好过滤，
    // 无偏好行=全量——与侧栏一致）。s 只用于取 activeProjectId 兜底。
    const params = scope === 'project' && scopeProjectId !== ''
      ? { scope: 'project' as const, projectId: scopeProjectId }
      : { scope: 'all' as const };
    void command<{ groups: BoardGroup[] }>('board.view', params)
      .then((r) => { if (myGen === gen) setData({ groups: r.groups ?? [] }); })
      .catch((e: unknown) => { if (myGen === gen) setErr((e as Error).message); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, scopeProjectId, gen]);

  /** 范围内的房间（来自聚合自带 groups.rooms——同名房间带项目名区分）。 */
  const scopeRooms = useMemo(() => (data?.groups ?? []).flatMap((g) => (g.rooms ?? []).map((r) => ({ ...r, projectId: g.projectId, projectName: g.displayName }))), [data]);
  const roomStillValid = roomFilter === 'all' || scopeRooms.some((r) => r.roomId === roomFilter);
  useEffect(() => {
    if (!roomStillValid) { setRoomFilter('all'); toast('筛选范围已变化，原来的房间筛选已清空', 'info'); }
  }, [roomStillValid]);

  const cardsOf = (g: BoardGroup) => g.rooms.flatMap((r) => r.cards).filter((c) => roomFilter === 'all' || c.roomId === roomFilter);
  const totalCount = (data?.groups ?? []).reduce((n, g) => n + cardsOf(g).length, 0);

  return (
    <div className="main">
      <div className="page">
        <div className="page-filters">
          <label className="field inline">
            <span className="field-label">范围</span>
            <select
              className="select"
              value={scope}
              onChange={(e) => {
                const next = e.target.value as BoardScope;
                if (next === 'project') void switchFocusProject(scopeProjectId);
                setParam({ scope: next, roomId: 'all' });
                setGen((v) => v + 1);
              }}
            >
              <option value="project">当前项目</option>
              <option value="all">侧栏可见项目</option>
            </select>
          </label>
          {scope === 'project' ? (
            <label className="field inline">
              <span className="field-label">项目</span>
              <select
                className="select"
                value={scopeProjectId}
                onChange={(e) => {
                  const next = e.target.value;
                  void switchFocusProject(next);
                  setParam({ projectId: next, roomId: 'all' });
                  setGen((v) => v + 1);
                }}
              >
                {s.projects.filter((p) => p.removedAt == null).map((p) => (
                  <option key={p.id} value={p.id}>{p.displayName}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="field inline">
            <span className="field-label">房间</span>
            <select className="select" value={roomFilter} onChange={(e) => setRoomFilter(e.target.value)}>
              <option value="all">当前范围全部房间</option>
              {scopeRooms.map((r) => (
                <option key={r.roomId} value={r.roomId}>{r.projectName} · {r.name}</option>
              ))}
            </select>
          </label>
          <span className="filter-note">共 {totalCount} 项 · board.view 只读聚合（操作走线程内正式命令）</span>
        </div>

        {err != null ? (
          <div className="panel warning">看板读取失败：{err}（切换筛选或稍后自动重试可恢复）</div>
        ) : data == null ? (
          <div className="panel info">正在读取看板（board.view）…</div>
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
                                style={{ cursor: 'pointer' }}
                                onClick={() => {
                                  if (c.threadId == null) { toast('该任务无线程（异常形态）——不定位', 'warn'); return; }
                                  void switchFocusProject(c.projectId);
                                  navigate(`/project/${c.projectId}/room/${c.roomId}?thread=${c.threadId}&tab=task`);
                                }}
                              >
                                <div className="row tight wrap">
                                  {c.roomTaskNumber != null ? <span className="root-task-no">#{c.roomTaskNumber}</span> : null}
                                  <TaskStatusTag status={c.taskStatus as 'OPEN'} />
                                  {c.runStatus != null && c.runStatus !== c.taskStatus ? <Tag plain icon="activity">{c.runStatus}</Tag> : null}
                                  {c.exitUnconfirmed ? <Tag tone="warning" icon="help-circle" title="运行中断且存在结果未知的 turn（恢复中心/详情取证）">退出未确认</Tag> : null}
                                  {c.pendingDelivery != null ? <Tag tone="warning" icon="eye" title={`待验收交付 v${c.pendingDelivery.revision}（manifest ${c.pendingDelivery.manifestHash.slice(0, 8)}…）——在线程详情按冻结三重身份验收`}>待验收 v{c.pendingDelivery.revision}</Tag> : null}
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
