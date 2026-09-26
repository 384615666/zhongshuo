/**
 * 归档管理（第十七批 §八 / §九）。
 *
 * **一个页面、三个入口**（用户明确要求"不要实现三套独立归档页面或三份状态"）：
 *  1. 侧栏「项目」分区标题旁的 ⋯ → 归档管理
 *  2. 应用设置 → 归档管理（正式管理入口）
 *  3. 项目 ⋯ → 查看本项目归档 → `/archive?project=<id>`（进入同一页并定位筛选）
 *
 * 组织方式是"一级项目、二级房间"，并且兼容两种来源：
 *  - **已归档项目**：它下面的房间整体"随项目只读"（房间自己没归档）；
 *  - **活跃项目**：只展示它里面**各自归档**的房间。
 *
 * 归档不是删除：这里只做"查看历史 + 恢复"，任何操作都不动磁盘文件与历史数据。
 */

import { useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { EmptyState, Tag } from '../components/ui';
import { useStore } from '../data/store';
import { restoreProject } from '../data/actions-project';
import { unarchiveRoom } from '../data/actions';
import { navigate } from '../lib/router';

/**
 * `/archive` 路由：归档管理独立页面。
 * 与「应用设置 → 归档管理」共用下面同一个 `ArchiveManager` —— 用户要求三个入口
 * 进的是同一个页面、同一份状态，**不做三套**。
 */
export function ArchivePage({ query }: { query: Record<string, string> }) {
  return (
    <div className="main">
      <div className="page">
        <ArchiveManager query={query} />
      </div>
    </div>
  );
}

/** 归档管理主体（不带页面外壳，便于嵌进设置分区） */
export function ArchiveManager({ query, embedded }: { query: Record<string, string>; embedded?: boolean }) {
  const s = useStore((x) => x);
  const [keyword, setKeyword] = useState('');
  /**
   * 项目筛选的归属：**嵌入模式下是组件内状态**（任务书 §2.3）。
   *
   * 原实现里「清除项目筛选」与项目下拉都是 `navigate('/archive…')` ——
   * 嵌进应用设置后，点这两个控件会把用户从设置页拽到独立归档页。
   * 现在：嵌进设置时只更新局部渲染；独立路由仍以 URL 为准（深链语义不变），
   * 只有「打开项目主页 / 查看历史」这类明确钻取才导航。
   */
  const [localProject, setLocalProject] = useState('all');
  const projectFilter = embedded ? (localProject === 'all' ? undefined : localProject) : query.project;
  const setProject = (v: string) => {
    if (embedded) {
      setLocalProject(v);
      return;
    }
    navigate(v === 'all' ? '/archive' : `/archive?project=${v}`);
  };

  /** 已归档项目（不含已移除的） */
  const archivedProjects = useMemo(
    () => s.projects.filter((p) => p.archivedAt && !p.removedAt),
    [s.projects],
  );
  /** 日常项目里带归档房间的（活跃项目也要能看到自己的归档房间） */
  const activeWithArchivedRooms = useMemo(
    () => s.projects.filter((p) => !p.archivedAt && !p.removedAt && s.rooms.some((r) => r.projectId === p.id && r.archivedAt)),
    [s.projects, s.rooms],
  );

  type Group = {
    project: (typeof s.projects)[number];
    /** 'project' = 项目整体归档（房间随项目只读）；'rooms' = 活跃项目里的归档房间 */
    kind: 'project' | 'rooms';
    rooms: typeof s.rooms;
  };

  const groups: Group[] = [
    ...archivedProjects.map((p) => ({
      project: p,
      kind: 'project' as const,
      rooms: s.rooms.filter((r) => r.projectId === p.id),
    })),
    ...activeWithArchivedRooms.map((p) => ({
      project: p,
      kind: 'rooms' as const,
      rooms: s.rooms.filter((r) => r.projectId === p.id && r.archivedAt),
    })),
  ]
    .filter((g) => (projectFilter ? g.project.id === projectFilter : true))
    .map((g) => ({
      ...g,
      rooms: keyword.trim()
        ? g.rooms.filter((r) => r.name.toLowerCase().includes(keyword.trim().toLowerCase()))
        : g.rooms,
    }))
    .filter((g) => (keyword.trim() ? g.rooms.length > 0 : true));

  const totalRooms = groups.reduce((n, g) => n + g.rooms.length, 0);

  return (
    <>
      {/**
       * 页头整个删掉（用户 2026-09-26 要求"界面顶部的头部去掉"）。
       * 原来它只在独立路由（/archive）渲染、嵌进设置时不渲染（§2.3 双标题）；
       * 现在独立路由也不再有标题与说明：当前筛到哪个项目由筛选行的下拉显示，
       * 归档语义由各行的「恢复」动作与卡片标签表达。
       */}
      {/**
       * 注意：这里**不能**留下 `{!embedded ? ( … ) : null}` 的空壳 ——
       * 三元分支里只放注释会变成"渲染一个空对象"，整棵树会因 React #31 白屏（实测踩到）。
       */}

        {/* 筛选行：搜索与项目下拉**同高同宽基准**，窄窗换行；清除筛选就地在行内（§2.3） */}
        <div className="page-filters archive-filters">
          <div className="row tight archive-filter-search">
            <Icon name="search" size={13} className="faint" />
            <input
              className="input sm"
              placeholder="搜索归档里的房间名…"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
          <select
            className="select sm archive-filter-project"
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
            <button
              className="btn sm"
              onClick={() => setProject('all')}
              title={
                embedded
                  ? '清除项目筛选，查看全部归档内容（留在应用设置内）'
                  : '清除项目筛选，查看全部归档内容'
              }
            >
              <Icon name="x" size={12} /> {embedded ? '清除项目筛选' : '返回全部归档'}
            </button>
          ) : null}
          <div className="spacer" />
          <span className="small faint">
            {groups.length} 个项目 · {totalRooms} 个房间
          </span>
        </div>

        {groups.length === 0 ? (
          <EmptyState
            icon="archive"
            title={projectFilter ? '这个项目没有归档内容' : '没有归档内容'}
              detail={
                projectFilter
                  ? `这个项目当前既没有整体归档，也没有单独归档的房间。可以点上方「${embedded ? '清除项目筛选' : '返回全部归档'}」看别的项目。`
                  : '还没有项目或房间被归档。归档后的项目与房间会出现在这里，随时可以恢复。'
              }
          />
        ) : (
          <div className="col" style={{ gap: 14 }}>
            {groups.map((g) => (
              <div key={g.project.id} className="card" data-archive-project={g.project.id}>
                <div className="row tight wrap">
                  <Icon name={g.project.archivedAt ? 'archive' : 'folder'} size={15} className="faint" />
                  <span className="strong">{g.project.displayName}</span>
                  {g.project.archivedAt ? (
                    <Tag tone="neutral" icon="archive">已归档项目</Tag>
                  ) : (
                    <Tag tone="neutral">使用中</Tag>
                  )}
                  <div className="spacer" />
                  <button
                    className="btn sm"
                    title={`在私信/归档之外查看该项目主页（只读历史）`}
                    onClick={() => navigate(`/project/${g.project.id}`)}
                  >
                    打开项目主页
                  </button>
                  {g.project.archivedAt ? (
                    <button
                      className="btn sm primary"
                      title="恢复项目：项目重新进入日常列表；原本单独归档的房间仍保持归档"
                      onClick={() => restoreProject(g.project.id)}
                    >
                      <Icon name="refresh" size={12} /> 恢复项目
                    </button>
                  ) : null}
                </div>

                <div className="col" style={{ gap: 6, marginTop: 10 }}>
                  {g.rooms.map((r) => {
                    /* 房间状态要分清两种：自己归档的 / 随项目只读的（§九） */
                    const ownArchive = Boolean(r.archivedAt);
                    const viaProject = !ownArchive && Boolean(g.project.archivedAt);
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
                            title="取消归档这个房间：房间恢复可写"
                            onClick={() => unarchiveRoom(r.id)}
                          >
                            恢复房间
                          </button>
                        ) : viaProject ? (
                          <span className="small faint" title="项目恢复后，这个房间会自动回到可写状态">
                            随项目恢复
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                  {g.rooms.length === 0 ? (
                    <div className="small faint">没有匹配的房间</div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
      )}
    </>
  );
}
