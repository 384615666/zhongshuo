import { userFacingSystemText } from '../../../contracts/userFacingText';
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
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { EmptyState, Select, Tag } from '../components/ui';
import { useStore, toast } from '../shell';
import { projectLifecycleReal, roomArchiveReal } from '../loader';
import { navigate } from '../lib/router';
import { recordWrite } from '../data/store';
import {useArchiveIndex} from '../data/useArchiveIndex';
import {fullTime} from '../lib/format';
import {readingNamespace} from '../data/readingPositions';

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
  const index=useArchiveIndex(projectFilter);
  const actionKey=`${readingNamespace()}:${projectFilter??'*'}`,actionTarget=useRef({key:actionKey,generation:0}),alive=useRef(false),inFlight=useRef(false);
  if(actionTarget.current.key!==actionKey)actionTarget.current={key:actionKey,generation:actionTarget.current.generation+1};
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);

  /** 已归档项目（不含已移除）与「活跃项目里带归档房间」两组。 */
  const projects=useStore(s=>s.projects);
  type Group = { project: {id:string;displayName:string;revision:number;archived:boolean}; rooms:Array<{id:string;name:string;revision:number;archivedAt:number|null}> };
  const groups: Group[] = useMemo(() => {
    const map=new Map<string,Group>();
    for(const row of index.data?.items??[]){let g=map.get(row.projectId);if(!g){g={project:{id:row.projectId,displayName:row.projectName,revision:row.projectRevision,archived:row.projectArchived},rooms:[]};map.set(row.projectId,g);}if(row.roomId!=null)g.rooms.push({id:row.roomId,name:row.roomName??row.roomId,revision:row.roomRevision!,archivedAt:row.roomArchivedAt});}
    const base=[...map.values()];
    const kw = keyword.trim().toLowerCase();
    return base
      .filter((g) => (projectFilter ? g.project.id === projectFilter : true))
      .map((g) => ({ ...g, rooms: kw ? g.rooms.filter((r) => r.name.toLowerCase().includes(kw)) : g.rooms }))
      .filter((g) => (kw ? g.rooms.length > 0 : true));
  }, [index.data, projectFilter, keyword]);

  const totalRooms = groups.reduce((n, g) => n + g.rooms.length, 0);

  const restoreProject = async (projectId: string) => {
    const p = groups.find((x) => x.project.id === projectId)?.project;
    if (p == null||inFlight.current||index.reading) return;
    inFlight.current=true;const target=actionTarget.current.generation;
    setBusy(`project:${projectId}`);
    try {
      const r = await projectLifecycleReal(projectId, p.revision, 'unarchive');
      if(!alive.current||actionTarget.current.generation!==target)return;
      if (r.ok) {
        recordWrite('project.lifecycle', `恢复项目「${p.displayName}」（原单独归档的房间不跟着恢复）`);
        toast('项目已恢复（原单独归档的房间仍保持归档；不重放旧任务）', 'success');
        void index.load();
      } else toast(`恢复未确认：${userFacingSystemText(r.error ?? '')}`, 'error');
    } finally { inFlight.current=false;if(alive.current)setBusy(null); }
  };
  const restoreRoom = async (roomId: string) => {
    const group=groups.find(g=>g.rooms.some(r=>r.id===roomId));
    const room = group?.rooms.find((r) => r.id === roomId);
    if (room == null||inFlight.current||index.reading) return;
    inFlight.current=true;const target=actionTarget.current.generation;
    setBusy(`room:${roomId}`);
    try {
      const r = await roomArchiveReal(roomId, room.revision ?? 0, 'unarchive');
      if(!alive.current||actionTarget.current.generation!==target)return;
      if (r.ok) {
        const result=group?.project.archived?'已解除房间的单独归档；项目仍归档，恢复项目后才可写':'房间已恢复可写';
        recordWrite('room.archive', `恢复房间「${room.name}」：${result}`);
        toast(result ?? '', 'success');
        void index.load();
      } else toast(`恢复未确认：${userFacingSystemText(r.error ?? '')}`, 'error');
    } finally { inFlight.current=false;if(alive.current)setBusy(null); }
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
        <Select
          value={projectFilter ?? 'all'}
          ariaLabel="归档项目筛选"
          title="按项目筛选归档内容"
          onChange={setProject}
          options={[{ value: 'all', label: '全部项目' }, ...projects.filter(p=>p.removedAt==null).map((p) => ({ value: p.id, label: p.displayName }))]}
        />
        {projectFilter ? (
          <button className="btn sm" onClick={() => setProject('all')} title="清除项目筛选，查看全部归档内容">
            <Icon name="x" size={12} /> {embedded ? '清除项目筛选' : '返回全部归档'}
          </button>
        ) : null}
        <div className="spacer" />
        <span className="small faint">{index.data?`已读取 ${groups.length} 个项目 · ${totalRooms} 个房间${index.data.nextCursor?'（还有更早内容）':''}`:'尚未读取'}</span>
        <button className="btn sm" disabled={index.reading||busy!=null} onClick={()=>void index.load()}>{index.reading?'读取中…':'刷新归档'}</button>
      </div>
      {index.error?<div className="panel warning" role="alert">归档读取失败：{userFacingSystemText(index.error ?? '')}。{index.data?'保留上次已确认内容。':'尚未取得归档清单。'}可点击刷新重试。</div>:null}
      {index.data?<div className="small faint">读取于 {fullTime(index.data.readAt)}；搜索只筛选已读取内容。刷新会重新读取首页，不切换当前项目。</div>:null}
      {!index.data?<div className="panel">{index.error?'归档尚未读取成功':'正在读取归档…'}</div>:groups.length === 0 ? (
        <EmptyState
          icon="archive"
          title={keyword.trim()||index.data.nextCursor?'已读取内容中没有匹配房间':projectFilter ? '这个项目没有归档内容' : '没有归档内容'}
          detail={keyword.trim()||index.data.nextCursor?'可清除搜索，或继续加载更多归档。搜索范围限于已读取清单。':projectFilter
            ? '这个项目当前既没有整体归档，也没有单独归档的房间。可以点上方「清除项目筛选」看别的项目。'
            : '还没有项目或房间被归档。归档后的项目与房间会出现在这里，随时可以恢复（归档不删除任何记录与磁盘文件）。'}
        />
      ) : (
        <div className="col" style={{ gap: 14 }}>
          {groups.map((g) => (
            <div key={g.project.id} className="card" data-archive-project={g.project.id}>
              <div className="row tight wrap">
                <Icon name={g.project.archived ? 'archive' : 'folder'} size={15} className="faint" />
                <span className="strong">{g.project.displayName}</span>
                {g.project.archived ? (
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
                {g.project.archived ? (
                  <button
                    className="btn sm primary"
                    disabled={busy!=null||index.reading}
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
                  const viaProject = !ownArchive && g.project.archived;
                  return (
                    <div key={r.id} className="row tight archive-row" data-archive-room={r.id}>
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
                          disabled={busy!=null||index.reading}
                          title={g.project.archived?'解除房间单独归档；项目仍保持归档，只读，恢复项目后才可写':'解除房间归档，恢复可写'}
                          onClick={() => void restoreRoom(r.id)}
                        >
                          {busy === `room:${r.id}` ? '恢复中…' : g.project.archived?'解除单独归档':'恢复房间'}
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
      {index.data?.nextCursor?<div className="row" style={{marginTop:12}}><button className="btn" disabled={index.reading||index.capped} onClick={()=>void index.load(true)}>{index.reading?'读取中…':'加载更多归档'}</button><span className="small faint">{index.capped?'本次已读取1200条；请按项目缩小范围后继续。':'当前清单尚未读完，请继续加载。'}</span></div>:null}
    </>
  );
}
