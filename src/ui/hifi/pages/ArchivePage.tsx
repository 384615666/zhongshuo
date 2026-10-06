/**
 * 归档管理（R66 P4——原型 ArchivePage 的正式接线版）：**一个页面、多个入口**（原型 §八/§九）：
 *  · 路由 /archive（项目 ⋯ 菜单「归档项目…」确认后的落点 / 项目设置归档入口）；
 *  · 应用设置嵌入同一组件（SettingsPage 数据与存储分区）。
 * 组织方式=一级项目、二级房间；兼容两种来源：已归档项目（房间随项目只读）与
 * 活跃项目里各自归档的房间。
 *
 * 正式命令（R65 起）：恢复项目=project.lifecycle unarchive（revision CAS）；恢复房间=
 * room.archive unarchive（revision CAS）。归档动作本身在各自主场（项目 ⋯ 菜单/项目设置/
 * 房间设置）发起——本页只做**查看历史 + 恢复**，不动磁盘文件与历史数据。
 */
import { useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { EmptyState, Tag } from '../components/ui';
import { useStore, toast } from '../shell';
import { projectLifecycleReal, roomArchiveReal } from '../loader';
import { navigate } from '../lib/router';
import { recordWrite } from '../data/store';

export function ArchivePage({ query }: { query: Record<string, string> }) {
  return (
    <div className="main" style={{ overflow: 'auto' }}>
      <div className="page">
        <ArchiveManager query={query} />
      </div>
    </div>
  );
}

export function ArchiveManager({ query, embedded }: { query?: Record<string, string>; embedded?: boolean }) {
  const s = useStore((x) => x);
  const [keyword, setKeyword] = useState('');
  /** 项目筛选归属：嵌入模式=组件内状态（不把用户从设置页拽走）；独立路由以 URL 为准。 */
  const [localProject, setLocalProject] = useState('all');
  const projectFilter = embedded
    ? (localProject === 'all' ? undefined : localProject)
    : (query?.project != null && query.project !== '' ? query.project : undefined);
  const setProject = (v: string) => {
    if (embedded) { setLocalProject(v); return; }
    navigate(v === 'all' ? '/archive' : `/archive?project=${v}`);
  };
  const [busy, setBusy] = useState<string | null>(null);

  /** 已归档项目（不含已移除）与「活跃项目里带归档房间」两组。 */
  const archivedProjects = useMemo(() => s.projects.filter((p) => p.archivedAt != null && p.removedAt == null), [s.projects]);
  const activeWithArchivedRooms = useMemo(
    () => s.projects.filter((p) => p.archivedAt == null && p.removedAt == null && s.rooms.some((r) => r.projectId === p.id && r.archivedAt != null)),
    [s.projects, s.rooms],
  );

  type Group = { project: (typeof s.projects)[number]; kind: 'project' | 'rooms'; rooms: typeof s.rooms };
  const groups: Group[] = useMemo(() => {
    const base: Group[] = [
      ...archivedProjects.map((p) => ({ project: p, kind: 'project' as const, rooms: s.rooms.filter((r) => r.projectId === p.id) })),
      ...activeWithArchivedRooms.map((p) => ({ project: p, kind: 'rooms' as const, rooms: s.rooms.filter((r) => r.projectId === p.id && r.archivedAt != null) })),
    ];
    const kw = keyword.trim().toLowerCase();
    return base
      .filter((g) => (projectFilter ? g.project.id === projectFilter : true))
      .map((g) => ({ ...g, rooms: kw ? g.rooms.filter((r) => r.name.toLowerCase().includes(kw)) : g.rooms }))
      .filter((g) => (kw ? g.rooms.length > 0 : true));
  }, [archivedProjects, activeWithArchivedRooms, s.rooms, projectFilter, keyword]);

  const totalRooms = groups.reduce((n, g) => n + g.rooms.length, 0);

  const restoreProject = async (projectId: string) => {
    const p = s.projects.find((x) => x.id === projectId);
    if (p == null) return;
    setBusy(`project:${projectId}`);
    try {
      const r = await projectLifecycleReal(projectId, p.revision, 'unarchive');
      if (r.ok) {
        recordWrite('project.lifecycle', `恢复项目「${p.displayName}」（原单独归档的房间不跟着恢复）`);
        toast('项目已恢复（原单独归档的房间仍保持归档；不重放旧任务）', 'success');
      } else toast(`恢复被拒：${r.error}`, 'error');
    } finally { setBusy(null); }
  };
  const restoreRoom = async (roomId: string) => {
    const room = s.rooms.find((r) => r.id === roomId);
    if (room == null) return;
    setBusy(`room:${roomId}`);
    try {
      const r = await roomArchiveReal(roomId, room.revision ?? 0, 'unarchive');
      if (r.ok) {
        recordWrite('room.archive', `恢复房间「${room.name}」（房间恢复可写）`);
        toast('房间已恢复可写', 'success');
      } else toast(`恢复被拒：${r.error}`, 'error');
    } finally { setBusy(null); }
  };

  return (
    <>
      {/* 筛选行（原型：搜索与项目下拉同基准；清除筛选就地）。 */}
      <div className="page-filters archive-filters">
        <div className="row tight archive-filter-search" style={{ border: '1px solid var(--border)', borderRadius: 7, padding: '0 8px', background: 'var(--bg-surface)', flex: '1 1 220px', maxWidth: 300 }}>
          <Icon name="search" size={13} className="faint" style={{ flex: 'none' }} />
          <input
            className="input"
            style={{ border: 'none', boxShadow: 'none', flex: 1, minWidth: 0, background: 'transparent' }}
            placeholder="搜索归档里的房间名…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <select
          className="select"
          value={projectFilter ?? 'all'}
          title="按项目筛选归档内容"
          onChange={(e) => setProject(e.target.value)}
        >
          <option value="all">全部项目</option>
          {[...archivedProjects, ...activeWithArchivedRooms].map((p) => (
            <option key={p.id} value={p.id}>{p.displayName}</option>
          ))}
        </select>
        {projectFilter ? (
          <button className="btn sm" onClick={() => setProject('all')} title="清除项目筛选，查看全部归档内容">
            <Icon name="x" size={12} /> {embedded ? '清除项目筛选' : '返回全部归档'}
          </button>
        ) : null}
        <div className="spacer" />
        <span className="small faint">{groups.length} 个项目 · {totalRooms} 个房间</span>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          icon="archive"
          title={projectFilter ? '这个项目没有归档内容' : '没有归档内容'}
          detail={projectFilter
            ? '这个项目当前既没有整体归档，也没有单独归档的房间。可以点上方「清除项目筛选」看别的项目。'
            : '还没有项目或房间被归档。归档后的项目与房间会出现在这里，随时可以恢复（归档不删除任何记录与磁盘文件）。'}
        />
      ) : (
        <div className="col" style={{ gap: 14 }}>
          {groups.map((g) => (
            <div key={g.project.id} className="card" data-archive-project={g.project.id}>
              <div className="row tight wrap">
                <Icon name={g.project.archivedAt != null ? 'archive' : 'folder'} size={15} className="faint" />
                <span className="strong">{g.project.displayName}</span>
                {g.project.archivedAt != null ? (
                  <Tag tone="neutral" icon="archive">已归档项目</Tag>
                ) : (
                  <Tag tone="neutral">使用中</Tag>
                )}
                <div className="spacer" />
                <button
                  className="btn sm"
                  title="查看该项目主页（只读历史）"
                  onClick={() => navigate(`/project/${g.project.id}`)}
                >
                  打开项目主页
                </button>
                {g.project.archivedAt != null ? (
                  <button
                    className="btn sm primary"
                    disabled={busy === `project:${g.project.id}`}
                    title="恢复项目（project.lifecycle unarchive——revision CAS）：项目重新进入日常列表；原本单独归档的房间仍保持归档"
                    onClick={() => void restoreProject(g.project.id)}
                  >
                    {busy === `project:${g.project.id}` ? '恢复中…' : '恢复项目'}
                  </button>
                ) : null}
              </div>

              <div className="col" style={{ gap: 6, marginTop: 10 }}>
                {g.rooms.map((r) => {
                  const ownArchive = r.archivedAt != null;
                  const viaProject = !ownArchive && g.project.archivedAt != null;
                  return (
                    <div key={r.id} className="row tight archive-row">
                      <Icon name={ownArchive ? 'archive' : 'eye'} size={13} className="faint" />
                      <span className={ownArchive ? '' : 'muted'}>{r.name}</span>
                      {ownArchive ? (
                        <Tag tone="neutral" icon="archive">已归档房间</Tag>
                      ) : (
                        <Tag tone="neutral" icon="lock">随项目只读</Tag>
                      )}
                      <div className="spacer" />
                      <button
                        className="btn ghost sm"
                        title="打开这个房间（只读历史，不会唤醒任何成员）"
                        onClick={() => navigate(`/project/${g.project.id}/room/${r.id}`)}
                      >
                        查看历史
                      </button>
                      {ownArchive ? (
                        <button
                          className="btn sm"
                          disabled={busy === `room:${r.id}`}
                          title="恢复房间（room.archive unarchive——revision CAS）：房间恢复可写"
                          onClick={() => void restoreRoom(r.id)}
                        >
                          {busy === `room:${r.id}` ? '恢复中…' : '恢复房间'}
                        </button>
                      ) : viaProject ? (
                        <span className="small faint" title="项目恢复后，这个房间会自动回到可写状态">
                          随项目恢复
                        </span>
                      ) : null}
                    </div>
                  );
                })}
                {g.rooms.length === 0 ? <div className="small faint">没有匹配的房间</div> : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
