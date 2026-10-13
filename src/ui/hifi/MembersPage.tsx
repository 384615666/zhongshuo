/**
 * 成员管理（第五十四轮 H3 §4 → R66 P4 原型布局还原）：正式命令接线——`member.list`
 * （项目/房间两级：项目成员全量 vs 房间名单子集；协调者=房间 AUTO 路由依赖，不可停用）、
 * `member.setEnabled`（停用=不再参与**之后**派发；在途不受影响）、`member.runtime`+
 * `member.setRuntime`（绑定/安装/能力如实分列）。
 *
 * R66 P5：**有效派发来源**分列（member.runtime.effective）——「未绑定」≠「没有渠道」：
 * 未绑定成员派发时回落全局默认（ZS_RUNTIME），界面分别显示 绑定渠道 / 全局默认渠道 /
 * 查询失败 / 未解析，不把「未绑定」显示成"不会用任何渠道"。
 *
 * 布局=原型 pages-misc MembersPage：筛选行（项目选择+计数）+ 成员卡片 grid + 房间名单 +
 * 说明面板；配置 runtime 从卡片进弹窗。R67 已接正式创建，R81 接资料编辑和独立配置模板。
 * 人的关注（阅读订阅）不属于成员管理——在「待我处理」分列（原型同判）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './components/Icon';
import { Avatar, Modal, Select, Tag, memberColor, memberShortId } from './components/ui';
import { useStore, toast, getState } from './shell';
import { refreshMembers, switchFocusProject } from './loader';
import { navigate, currentNavSeq } from './lib/router';
import { command } from './bridge';
import { recordWrite } from './data/store';
import { useMemberWorkload } from './components/useMemberWorkload';
import { memberWrite } from './data/memberWrites';
import { fullTime } from './lib/format';
import { EditMemberModal, SaveMemberTemplateModal, TemplatePanel, UnknownMemberOperations, useFormGuard } from './components/MemberManagementForms';

export interface MemberRow { id: string; displayName: string; principalType: string; enabled: boolean; description?: string; revision:number }
/** member.runtime DTO：binding/installation/effective（R66 P5 有效来源）/environment。 */
export interface RuntimeInfo {
  binding?: { installationId?: string | null; model?: string | null; permissionMode?: string | null };
  installation?: { id: string; kind: string; executable: string; capabilities_json: string | null } | null;
  effective?: { source: 'binding' | 'global-default' | 'unresolved'; kind: string | null; model: string | null; defaultKindEnv: string | null };
  executableStatus?:{status:'found'|'missing'|'unknown';reason:string};
  permissionExecution?:{effective:string;reason:string}|null;
  environment?: { realDispatchGuard?: boolean; allowFake?: boolean };
  imageInput?: { status: string; model: string | null; channel: string; reason: string; configuration: string; protocol: string; permissionMode: string };
}

export const runtimeAuthOf = (raw: string | null): string => {
  if (raw == null) return '未认证';
  try {
    const caps = JSON.parse(raw) as { permissionAuth?: string; modelAvailability?: string };
    return caps.permissionAuth === 'unverified' ? '未认证' : String(caps.permissionAuth ?? '未认证');
  } catch { return '未认证'; }
};

export function MembersPage({projectId:routeProjectId}:{projectId?:string}={}) {
  const activeProjectId = useStore((s) => s.activeProjectId);
  const projectId=routeProjectId??activeProjectId;
  const projects = useStore((s) => s.projects);
  const opening=useStore(s=>s.openInFlightTarget);
  const navSequence=currentNavSeq();
  useEffect(()=>{if(routeProjectId&&routeProjectId!==activeProjectId&&projects.some(p=>p.id===routeProjectId)&&!(opening!=null&&opening.projectId!==routeProjectId&&opening.urlSeqAtStart>=navSequence))void switchFocusProject(routeProjectId).catch((e:unknown)=>{if(getState().activeProjectId===routeProjectId)toast(`成员项目聚焦失败：${(e as Error).message}`,'error');});},[routeProjectId,activeProjectId,projects,opening,navSequence]);
  // selector 必须返回稳定引用（useSyncExternalStore 契约——filter 新数组会造成快照死循环，
  // R46 实证）：先取整份 rooms，再按项目 memo 过滤。
  const allRooms = useStore((s) => s.rooms);
  const rooms = useMemo(() => (projectId != null && projectId !== '' ? allRooms.filter((r) => r.projectId === projectId) : allRooms), [allRooms, projectId]);
  const workload = useMemberWorkload(projectId);
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [membersProjectId, setMembersProjectId] = useState<string | null>(null);
  const membersInScope = membersProjectId === projectId ? members : null;
  const [roomMembers, setRoomMembers] = useState<Record<string, MemberRow[]>>({});
  const [runtimes, setRuntimes] = useState<Record<string, RuntimeInfo>>({});
  /** runtime/房间名单的逐项读取失败（r55：查询失败≠未绑定——分列如实，
   *  读失败的已有事实保留，不把 installationId=null 显示成「已绑定」）。 */
  const [runtimeErrs, setRuntimeErrs] = useState<Record<string, string>>({});
  const [roomMemberErrs, setRoomMemberErrs] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const genRef = useRef(0);
  const [query,setQuery]=useState('');
  const [statusFilter,setStatusFilter]=useState('all');
  const [editFor,setEditFor]=useState<{projectId:string;member:MemberRow}|null>(null);
  const [saveTemplateFor,setSaveTemplateFor]=useState<{projectId:string;member:MemberRow}|null>(null);
  const visibleMembers=membersInScope?.filter(m => `${m.displayName} ${m.description??''} ${memberShortId(m.id)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (statusFilter==='all'||(statusFilter==='enabled'?m.enabled:!m.enabled)));


  const reload = useCallback(async () => {
    if (projectId == null || projectId === '') return;
    const gen = ++genRef.current;
    setErr(null);
    try {
      const r = await command<{ items: MemberRow[] }>('member.list', { projectId });
      if (gen !== genRef.current) return; // 已切换——迟到响应不污染
      setMembers(r.items);
      setMembersProjectId(projectId);
      const rt: Record<string, RuntimeInfo> = {};
      const rtErr: Record<string, string> = {};
      const chunks = Array.from({ length: Math.ceil(r.items.length / 500) }, (_, n) => r.items.slice(n * 500, (n + 1) * 500));
      await Promise.all(chunks.map(async (chunk) => {
        try {
          const batch = await command<{ projectId: string; items: Array<{memberId:string;info?:RuntimeInfo;error?:{message:string}}> }>('member.runtimes', { projectId, memberIds: chunk.map(m => m.id) });
          if (gen !== genRef.current || batch.projectId !== projectId) return;
          for (const row of batch.items) {
            if (row.info != null) rt[row.memberId] = row.info;
            else rtErr[row.memberId] = row.error?.message ?? '成员配置未提供';
          }
        } catch (e) {
          if (gen === genRef.current) for (const m of chunk) rtErr[m.id] = (e as Error).message;
        }
      }));
      if (gen !== genRef.current) return;
      setRuntimes(prev => Object.fromEntries(r.items.flatMap(m => rt[m.id] != null ? [[m.id, rt[m.id]]] : prev[m.id] != null ? [[m.id, prev[m.id]]] : [])));
      setRuntimeErrs(rtErr);
      const perRoom: Record<string, MemberRow[]> = {};
      const roomErr: Record<string, string> = {};
      await Promise.all(rooms.map(async (room) => {
        try {
          const rr = await command<{ items: MemberRow[] }>('member.list', { projectId, roomId: room.id });
          if (gen === genRef.current) perRoom[room.id] = rr.items;
        } catch (e) {
          if (gen === genRef.current) roomErr[room.id] = (e as Error).message; // 房间名单失败≠装载中
        }
      }));
      if (gen !== genRef.current) return;
      setRoomMembers(prev => Object.fromEntries(rooms.flatMap(room => perRoom[room.id] != null ? [[room.id, perRoom[room.id]]] : prev[room.id] != null ? [[room.id, prev[room.id]]] : [])));
      setRoomMemberErrs(roomErr);
    } catch (e) {
      if (gen === genRef.current) setErr((e as Error).message);
    }
  }, [projectId, rooms]);

  useEffect(() => { void reload(); return () => { genRef.current += 1; }; }, [reload]);

  const toggle = async (m: MemberRow) => {
    setBusyId(m.id);
    try {
      const outcome=await memberWrite(`member.setEnabled:${projectId}:${m.id}`,'member.setEnabled',{projectId,memberId:m.id,expectedRevision:m.revision,enabled:!m.enabled});
      if(outcome.status!=='ok')throw Error(outcome.status==='unknown'?`结果未知：${outcome.error}；请在未知成员操作区同号重放`:`${outcome.code}：${outcome.error}`);
      if(getState().activeProjectId!==projectId)return;
      recordWrite('member.setEnabled', `${m.displayName} → ${!m.enabled ? '启用' : '停用'}（作用=之后的派发；在途不受影响）`);
      toast(`已${!m.enabled ? '启用' : '停用'} ${m.displayName}（作用范围：之后的新派发）`, 'success');
      await reload();
    } catch (e) {
      toast(`操作失败：${(e as Error).message}`, 'error'); // 协调者拒绝等真实原因上屏
    } finally {
      setBusyId(null);
    }
  };

  /** r63→R66：绑定编辑弹窗（member.setRuntime——正式命令；fake 仅环境显式允许时可选）。 */
  const guard = useStore((st) => st.dispatchGuard);
  const [bindFor, setBindFor] = useState<{projectId:string;member:MemberRow}|null>(null);
  /** R67：添加成员（member.create 正式合同——已批准原型入口，无用户延期依据）。
   * R68 §5B：捕获**打开时**的 projectId（addFor）——弹窗存续期间全局项目切换（标题栏菜单/
   * 深链/受控事件）时旧表单作废，不再出现「旧 A 输入随全局 activeProjectId 写进 B」。 */
  const [addFor, setAddFor] = useState<string | null>(null);
  const [bindForm, setBindForm] = useState<{ kind: 'claude' | 'codex' | 'fake'; model: string; executable: string; permissionMode: string }>({ kind: 'claude', model: '', executable: '', permissionMode: '' });
  const openBind = (m: MemberRow) => {
    const cur = runtimes[m.id];
    const curKind = cur?.installation?.kind;
    setBindForm({
      kind: curKind === 'codex' || curKind === 'fake' ? curKind : 'claude',
      model: cur?.binding?.model ?? '',
      executable: cur?.installation?.executable ?? '',
      permissionMode: cur?.binding?.permissionMode ?? '',
    });
    setBindFor({projectId,member:m});
  };

  useEffect(()=>{const changed=(event:Event)=>{const p=(event as CustomEvent<{projectId?:string}>).detail?.projectId;if(p==null||p===projectId)void reload();};window.addEventListener('zs-member-changed',changed);return()=>window.removeEventListener('zs-member-changed',changed);},[reload,projectId]);

  const coordinatorIds = new Set(rooms.map((r) => r.coordinatorMemberId).filter((x): x is string => x != null));
  /** R68 §5A：当前项目归档/移除——添加入口禁用+说明（服务端同判拒绝，双保险）。 */
  const projState = projects.find((x) => x.id === projectId);
  const projArchived = projState?.archivedAt != null;
  const projRemoved = projState?.removedAt != null;

  /**
   * runtime 分列（R66 P5 修订）：查询失败 / 未绑定（有效=全局默认）/ 已绑定·安装缺失 / 正常。
   * 未绑定时同时给出**有效来源**（effective.kind——全局默认渠道），不再让「未绑定」
   * 被读成"不会用任何渠道"。
   */
  const runtimeLabel = (m: MemberRow): { text: string; problem?: boolean; effective?: string } => {
    const rt = runtimes[m.id];
    if (runtimeErrs[m.id] != null) return { text: `配置读取失败（${runtimeErrs[m.id]}）${rt != null ? '——保留已确认的配置，可刷新重试' : '——暂无已确认配置，可刷新重试'}`, problem: true };
    if (rt == null) {
      const failure = runtimeErrs[m.id];
      if (failure != null) return { text: `查询失败（${failure}）——保留上次事实`, problem: true };
      return { text: '读取中…' };
    }
    if (rt.binding == null) return { text: '绑定信息缺失（member.runtime 响应异常）', problem: true };
    if (rt.binding.installationId == null || rt.binding.installationId === '') {
      const eff = rt.effective;
      if (eff != null && eff.source === 'global-default' && eff.kind != null) {
        // R67：全局默认 **claude 未配置模型名**（ZS_CLAUDE_MODEL 缺省——CLI 拒绝默认配置，
        // 用户 v3 实测 startupFailed 根因）时必须明示发送会失败及解法，不等到派发失败。
        const noModel = eff.kind === 'claude' && (eff.model == null || eff.model.length === 0);
        return {
          text: `未绑定 · 默认 ${eff.kind}${eff.model?` · ${eff.model}`:''}${noModel?' · 未指定模型，请配置后派工':''}`,
          problem: true,
          effective: eff.kind,
        };
      }
      return { text: '未绑定（点「配置 runtime」选择渠道与模型）', problem: true };
    }
    if (rt.installation == null) return { text: '已绑定，但安装信息缺失（runtime 安装不可读/已移除）', problem: true };
    if(rt.executableStatus?.status==='missing')return {text:`配置已保存 · ${rt.installation.kind}${rt.binding?.model?' · '+rt.binding.model:''} · 程序不可用，请配置后派工`,problem:true};
    return { text: `配置已保存 · ${rt.installation.kind}${rt.binding?.model?' · '+rt.binding.model:''} · 工具权限：${runtimeAuthOf(rt.installation.capabilities_json)}` };
  };

  return (
    <div className="main" style={{ overflow: 'auto' }} data-zs-members="hifi">
      <div className="page">
        {/* 筛选行：项目与顶栏同源，名称/说明/短ID搜索不改变任何成员状态。 */}
        <UnknownMemberOperations/>
        <div className="page-filters">
          <label className="field inline">
            <span className="field-label">项目</span>
            <Select
              value={projectId}
              ariaLabel="成员所属项目"
              title="成员是项目级实例：同一个渠道/模型在不同项目里是不同成员，身份与会话不合并"
              onChange={(next) => { if (next !== projectId) { void import('./loader').then((m) => m.switchFocusProject(next)); navigate(`/project/${next}/members`); } }}
              options={projects.filter((p) => p.removedAt == null).map((p) => ({ value: p.id, label: p.displayName }))}
            />
          </label>
          <input className="input" aria-label="查找成员" data-zs-member-search placeholder="名称 / 说明 / 短ID" value={query} onChange={e=>setQuery(e.target.value)} style={{maxWidth:240}}/>
          <label className="field inline"><span className="field-label">状态</span><Select value={statusFilter} ariaLabel="成员启用状态筛选" options={[{value:'all',label:'全部状态'},{value:'enabled',label:'启用'},{value:'disabled',label:'停用'}]} onChange={setStatusFilter}/></label>
          <span className="filter-note">
            {membersInScope?.length ?? '…'} 名成员 · 成员是项目级实例，同名成员不合并
          </span>
          <div className="spacer" />
          <button
            className="btn ghost sm" onClick={() => { workload.refresh(); void reload(); }} title="重新装载成员/工作量/绑定/房间名单（迟到响应不污染当前项目）">刷新</button>
          {projArchived ? (
            <span className="filter-note" style={{ color: 'var(--warning,#b45309)' }}>项目已归档（只读）——不能添加成员</span>
          ) : projRemoved ? (
            <span className="filter-note" style={{ color: 'var(--warning,#b45309)' }}>项目已移除——不能添加成员</span>
          ) : (
            <button className="btn primary sm" disabled={projectId == null || projectId === ''} onClick={() => setAddFor(projectId)} title="添加成员实例（member.create——自动加入未归档房间；不自动成为协调者；runtime 绑定随后配置；归档/移除项目服务端同判拒绝）">
              <Icon name="user-plus" size={12} /> 添加成员
            </button>
          )}
        </div>

        {projectId == null || projectId === '' ? (
          <div className="panel info">尚未打开项目——从侧栏项目菜单或顶栏「项目管理」进入（成员按项目分列）。</div>
        ) : null}
        {err != null ? <div className="panel warning">成员装载失败：{err}（可刷新重试）</div> : null}
        {workload.error ? <div className="panel warning">成员工作量读取失败：{workload.error}。{workload.updatedAt ? `保留 ${fullTime(workload.updatedAt)} 的事实。` : '尚未取得工作量快照。'}</div> : null}
        {workload.updatedAt ? <div className="faint small">工作量更新于 {fullTime(workload.updatedAt)}；负责的任务与实际在途执行分开统计。</div> : null}
        {workload.data?.truncated ? <div className="faint small">工作量仅覆盖前 500 名成员；未读取的成员不推断为空。</div> : null}
        {membersInScope == null && err == null && projectId != null && projectId !== '' ? <div className="panel info">正在装载…</div> : null}

        {membersInScope != null && membersInScope.length === 0 ? (
          <div className="panel info">这个项目还没有成员。成员在项目注册时建立；添加新成员的界面入口属后续批次（不放假成功按钮）。</div>
        ) : null}

        {/* 成员卡片（原型 grid-2：头像+名称+身份标签 / runtime 有效来源 / 在跑任务） */}
        <div className="grid grid-2">
          {visibleMembers?.map((m) => {
            const rt = runtimeLabel(m);
            const running = workload.data?.items.find(row=>row.memberId===m.id);
            return (
              <div key={m.id} className="card" data-zs-member-card={m.id} title={`查看 ${m.displayName} #${memberShortId(m.id)} 的成员详情（完整 ID ${m.id}）`}
                role="link" tabIndex={0} style={{ cursor: 'pointer' }}
                onClick={(e) => { if ((e.target as HTMLElement).closest('button, a, input, select, summary')) return; navigate(`/project/${projectId}/member/${m.id}`); }}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); navigate(`/project/${projectId}/member/${m.id}`); } }}>
                <div className="row tight">
                  <Avatar name={m.displayName} color={memberColor(m.id)} size={36} round />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row tight">
                      <span className="strong">{m.displayName}</span>
                      <span className="mono-sm faint" data-zs-member-short={m.id}>#{memberShortId(m.id)}</span>
                      {coordinatorIds.has(m.id) ? <Tag tone="accent" icon="star">协调者</Tag> : null}
                      {m.principalType === 'agent' ? null : <Tag plain icon="users">人类</Tag>}
                      {m.enabled ? <Tag plain>启用</Tag> : <Tag tone="neutral" icon="slash">停用</Tag>}
                    </div>
                    <div className="small faint" style={{ marginTop: 3 }}>
                      {m.description != null && m.description !== '' ? <div>{m.description}</div> : null}
                      {rt.problem ? <span style={{ color: 'var(--warning,#b45309)' }}>runtime：{rt.text}</span> : <>runtime：{rt.text}</>}
                    </div>
                  </div>
                </div>
                <div className="small faint" style={{ marginTop: 8, lineHeight: 1.6 }}>
                  {running ? `负责未结束任务 ${running.unfinishedTasks} · 在途执行 ${running.activeTurns} · 待核对结果 ${running.unknownTurns}` : '成员工作量尚未读到'}
                  {m.principalType === 'agent' ? '' : '（本地用户——不可停用）'}
                  {m.principalType === 'agent' && runtimes[m.id]?.imageInput ? <details data-zs-image-capability={m.id} style={{ marginTop: 5 }}>
                    <summary>识图能力：{runtimes[m.id]!.imageInput!.status === 'supported' ? '已认证' : '未认证'} · 查看配置依据</summary>
                    <div style={{ marginTop: 4 }}>
                    配置：{runtimes[m.id]!.imageInput!.configuration} · 模型ID：{runtimes[m.id]!.imageInput!.model ?? '未指定'} · 权限：{runtimes[m.id]!.imageInput!.permissionMode}<br />
                    渠道：{runtimes[m.id]!.imageInput!.channel}<br />
                    协议：{runtimes[m.id]!.imageInput!.protocol}<br />
                    真实识图：{runtimes[m.id]!.imageInput!.reason}
                    </div>
                  </details> : null}
                </div>
                {m.principalType === 'agent' ? (
                  <div className="row tight wrap" style={{ marginTop: 10 }}>
                    <button className="btn ghost sm" data-zs-member-edit={m.id} disabled={projArchived||projRemoved} onClick={()=>setEditFor({projectId,member:m})}>编辑资料</button>
                    <button className="btn ghost sm" data-zs-member-template={m.id} disabled={projArchived||projRemoved||runtimeErrs[m.id]!=null||runtimes[m.id]?.installation==null} onClick={()=>setSaveTemplateFor({projectId,member:m})}>保存配置模板</button>
                    <button className="btn ghost sm" disabled={busyId === m.id} onClick={() => void toggle(m)}
                      title={m.enabled ? '停用：不再参与之后派发（在途不受影响）' : '启用：恢复参与之后的派发'}>
                      {busyId === m.id ? '处理中…' : m.enabled ? '停用' : '启用'}
                    </button>
                    <button className="btn ghost sm" data-zs-member-bind={m.id} title="配置该成员的 runtime 与模型（member.setRuntime——配置成功≠能力已认证）" onClick={() => openBind(m)}>
                      配置 runtime…
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {membersInScope!=null && visibleMembers?.length===0 && membersInScope.length>0 ? <div className="panel">没有匹配的成员；筛选不会修改成员或任务。</div>:null}
        <TemplatePanel projectId={projectId} readOnly={projArchived||projRemoved} onChanged={reload}/>
        <div className="section-title" style={{ marginTop: 22 }}>房间名单</div>
        <div className="panel">
          <div className="faint small" style={{ marginBottom: 8 }}>成员参与派发的实际边界；建房默认全加入（★=该房间协调者）。</div>
          {rooms.map((room) => {
            const list = roomMembers[room.id];
            const failure = roomMemberErrs[room.id];
            return (
              <div key={room.id} style={{ marginTop: 8 }}>
                <div className="row tight">
                  <Icon name="message-circle" size={12} />
                  <span className="small" style={{ fontWeight: 600 }}>{room.name}</span>
                  <span className="faint small">{failure != null ? `名单读取失败（${failure}——保留上次事实，可刷新重试）` : list == null ? '（装载中…）' : `${list.length} 位`}</span>
                </div>
                {list != null ? (
                  <div className="row tight wrap" style={{ marginTop: 4 }}>
                    {list.map((m) => (
                      <span key={m.id} className="chip" title={`${m.displayName} #${memberShortId(m.id)}（完整 ID ${m.id}）${m.enabled ? '' : '（已停用）'}`} style={{ opacity: m.enabled ? 1 : 0.5 }}>
                        {m.displayName}<span className="mono-sm faint">#{memberShortId(m.id)}</span>{room.coordinatorMemberId === m.id ? ' ★' : ''}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
          {rooms.length === 0 ? <div className="faint small" style={{ marginTop: 4 }}>（本项目没有房间）</div> : null}
        </div>

        <div className="panel" style={{ marginTop: 18 }}>
          <div className="panel-title"><Icon name="info" size={13} /> 身份与渠道不要混用</div>
          <div className="small muted" style={{ lineHeight: 1.7, marginTop: 4 }}>
            成员是项目级实例（同一渠道/模型在不同项目是不同成员）；runtime 绑定属于成员，未绑定时
            派发回落<strong>全局默认渠道</strong>（本包由启动器 ZS_RUNTIME 决定——卡片上分列显示，不默默换渠道）。
            配置成功≠能力已认证（认证状态以回读为准）；fake 渠道仅演练环境可选。
            人的关注（阅读订阅）在「待我处理」。
          </div>
        </div>
      </div>

      {editFor ? <EditMemberModal key={`${editFor.projectId}:${editFor.member.id}`} projectId={editFor.projectId} member={editFor.member} onClose={()=>setEditFor(null)} onSaved={async()=>{setEditFor(null);await reload();}}/>:null}
      {saveTemplateFor ? <SaveMemberTemplateModal key={`${saveTemplateFor.projectId}:${saveTemplateFor.member.id}`} projectId={saveTemplateFor.projectId} member={saveTemplateFor.member} onClose={()=>setSaveTemplateFor(null)} onSaved={()=>{setSaveTemplateFor(null);window.dispatchEvent(new CustomEvent('zs-member-changed',{detail:{projectId}}));}}/>:null}
      {addFor != null ? (
        <AddMemberModal
          projectId={addFor}
          projectName={projects.find((x) => x.id === addFor)?.displayName ?? addFor}
          activeProjectId={activeProjectId}
          onClose={() => setAddFor(null)}
          onCreated={async () => {
            setAddFor(null);
            toast(`已添加成员（自动加入未归档房间；协调者与 runtime 不变——随后可「配置 runtime」）`, 'success');
            // 迟到回执：只刷新**提交目标项目**的名单（当前焦点若已切到别的项目，不覆盖其视图）。
            if (getState().activeProjectId === addFor) await reload();
            else await refreshMembers(addFor).catch(() => { /* 焦点已切走——store 投影按目标项目刷新即可 */ });
          }}
        />
      ) : null}

      {/* 配置 runtime 弹窗（R66 P4：从行内表单收进弹窗——字段与命令不变） */}
      {bindFor != null && bindFor.member.principalType === 'agent' ? (
        <BindRuntimeModal
          member={bindFor.member}
          projectId={bindFor.projectId}
          initial={bindForm}
          guard={guard}
          onClose={() => setBindFor(null)}
          onSaved={async () => { setBindFor(null); await reload(); void refreshMembers().catch(() => { /* 投影刷新失败=发送区提示按旧事实多显示一轮，下次装载自对 */ }); }}
        />
      ) : null}
    </div>
  );
}

export function BindRuntimeModal({ member, projectId, initial, guard, onClose, onSaved }: {
  member: MemberRow;
  projectId:string;
  initial: { kind: 'claude' | 'codex' | 'fake'; model: string; executable: string; permissionMode: string };
  guard: { fakeAllowed: boolean; realDispatchGuard: boolean } | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const targetProject=useRef(projectId).current;
  const formGuard=useFormGuard(targetProject);
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const mounted = useRef(false);
  const savePending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const save = async () => {
    if (savePending.current||!formGuard.valid()) return;
    if (form.kind === 'claude' && form.model.trim().length === 0) { toast('claude 绑定必须显式指定模型（服务端同判）', 'warn'); return; }
    savePending.current = true; setBusy(true); setSaveError(null);
    try {
      const outcome=await memberWrite(`member.setRuntime:${targetProject}:${member.id}`,'member.setRuntime', {projectId:targetProject,expectedRevision:member.revision,
        memberId: member.id, kind: form.kind,
        ...(form.model.trim().length > 0 ? { model: form.model.trim() } : {}),
        ...(form.executable.trim().length > 0 ? { executable: form.executable.trim() } : {}),
        ...(form.permissionMode.length > 0 ? { permissionMode: form.permissionMode } : {}),
      });
      if(outcome.status!=='ok')throw Error(outcome.status==='unknown'?`结果未知：${outcome.error}；原信封已保存，在成员页人工同号重放`:`${outcome.code}：${outcome.error}`);
      if(!formGuard.valid())return;
      recordWrite('member.setRuntime', `${member.displayName} → ${form.kind}${form.model ? `（${form.model}）` : ''}——配置成功≠能力已认证`);
      toast(`已保存 ${member.displayName} 的 runtime 绑定（${form.kind}${form.model ? ' · ' + form.model : ''}）——能力认证状态以成员页回读为准`, 'success');
      if (mounted.current) await onSaved();
    } catch (e) {
      if (!formGuard.valid())return;
      if (mounted.current) setSaveError((e as Error).message);
      toast(`绑定失败：${(e as Error).message}`, 'error'); // 防护模式拒真实绑定/模型缺失等真实原因上屏
    } finally { savePending.current = false; if (mounted.current) setBusy(false); }
  };
  return (
    <Modal
      size="md"
      title={`配置 runtime · ${member.displayName} #${memberShortId(member.id)}`}
      subtitle={`member.setRuntime——配置成功≠能力已认证；未绑定时该成员派发用全局默认渠道（实例 ${member.id}）`}
      onClose={onClose}
      footer={
        <>
          <span className="small faint">{guard?.realDispatchGuard === true ? '当前为验收防护环境：真实渠道绑定会被拒绝' : '保存后回读显示能力状态'}</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary sm" disabled={busy||formGuard.invalid} data-zs-member-bindsave={member.id} onClick={() => void save()}>{busy ? '保存中…' : '保存绑定'}</button>
        </>
      }
    >
      <div className="col" style={{ gap: 10 }}>
        {formGuard.invalid?<div className="panel warning">目标已切换，本表单作废；请关闭后重新配置。</div>:null}
        {saveError != null ? <div className="panel warning">绑定失败：{saveError}。输入已保留，可调整后重试。</div> : null}
        <label className="field" title="runtime 渠道（派发侧按此选 adapter）">
          <span className="field-label">渠道</span>
          <Select
            value={form.kind}
            ariaLabel="runtime 渠道"
            onChange={(v) => setForm((f) => ({ ...f, kind: v as typeof f.kind }))}
            options={[
              { value: 'claude', label: 'claude（CLI）' },
              { value: 'codex', label: 'codex' },
              ...(guard?.fakeAllowed === true ? [{ value: 'fake', label: 'fake（仅演练环境）' }] : []),
            ]}
          />
        </label>
        {form.kind !== 'fake' ? (
          <label className="field" title="claude 必须显式指定模型（服务端同判拒绝空模型）">
            <span className="field-label">{form.kind === 'claude' ? '模型（必填）' : '模型 ID（可选）'}</span>
            <input className="input" placeholder={form.kind === 'claude' ? '如 deepseek-flash' : '如 gpt-6-luna；留空使用渠道默认'} value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} />
          </label>
        ) : null}
        <label className="field" title="可执行文件（留空=渠道默认名：claude/codex）">
          <span className="field-label">可执行文件</span>
          <input className="input" placeholder="留空=默认（claude/codex）" value={form.executable} onChange={(e) => setForm((f) => ({ ...f, executable: e.target.value }))} />
        </label>
        <label className="field" title="权限模式（可选——默认按 runtime 自身配置）">
          <span className="field-label">保存的权限模式</span>
          <Select
            value={form.permissionMode}
            ariaLabel="权限模式"
            onChange={(v) => setForm((f) => ({ ...f, permissionMode: v }))}
            options={[
              { value: '', label: '（默认）' },
              { value: 'plan', label: 'plan' },
              { value: 'manual', label: 'manual' },
              { value: 'acceptEdits', label: 'acceptEdits' },
              { value: 'auto', label: 'auto' },
              { value: 'dontAsk', label: 'dontAsk' },
              { value: 'bypassPermissions', label: 'bypassPermissions' },
            ]}
          />
          <div className="field-hint">{form.kind==='codex'?'Codex 正式执行保持 read-only，审批 never；此权限档仅保存，尚未映射。':'Claude 留空时正式 CLI 请求 plan；保存与实际工具权限认证分别判定。'}</div>
        </label>
      </div>
    </Modal>
  );
}

/** R67 P4 → R68 §5B：添加成员（member.create——同名可重复=项目级实例）。弹窗**捕获打开时的
 * projectId**：存续期间全局项目切换（标题栏/深链/受控事件）→ 表单作废（提交禁用+可见说明），
 * 提交前再核对一次；迟到回执只刷新提交目标项目（onCreated 侧门控）。 */
function AddMemberModal({ projectId, projectName, activeProjectId, onClose, onCreated }: { projectId: string; projectName: string; activeProjectId: string; onClose: () => void; onCreated: (memberId: string) => void | Promise<void> }) {
  const formGuard=useFormGuard(projectId);
  const inFlight=useRef(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rooms = useStore((s) => s.rooms);
  const joinable = rooms.filter((r) => r.projectId === projectId && r.archivedAt == null);
  const stale = formGuard.invalid||activeProjectId !== projectId; // 打开后全局项目被切走——旧表单作废
  const submit = async () => {
    if(inFlight.current)return;
    if (stale||!formGuard.valid()) { setErr('项目已切换——本表单已作废（针对旧项目的输入不再提交；关闭后在新项目重新添加）'); return; }
    if (name.trim().length === 0) { setErr('请填写成员名称（不能为空白）'); return; }
    inFlight.current=true;setBusy(true); setErr(null);
    try {
      const outcome = await memberWrite<{ memberId: string; roomsJoined: number }>(`member.create:${projectId}`,'member.create', { projectId, displayName: name.trim(), ...(desc.trim().length > 0 ? { description: desc.trim() } : {}) });
      if(outcome.status!=='ok')throw Error(outcome.status==='unknown'?`结果未知：${outcome.error}；原信封已保存，在成员页人工同号重放`:`${outcome.code}：${outcome.error}`);
      const r=outcome.data;
      if(!formGuard.valid())return;
      recordWrite('member.create', `添加成员「${name.trim()}」到 ${projectName}（加入 ${r.roomsJoined} 个未归档房间；不自动协调者）`);
      await onCreated(r.memberId);
    } catch (e) {
      if(formGuard.valid())setErr(`添加未确认：${(e as Error).message}`); // 归档/移除守卫等真实原因上屏
    } finally { inFlight.current=false;if(formGuard.alive.current)setBusy(false); }
  };
  return (
    <Modal
      size="md"
      title="添加成员"
      subtitle={`添加到 ${projectName}（成员是项目级实例，同名成员不合并——runtime 绑定随后在卡片「配置 runtime」设置）`}
      onClose={onClose}
      footer={
        <>
          <span className="small faint">{stale ? '项目已切换——表单作废' : `名称可重复；创建后自动加入 ${joinable.length} 个未归档房间${joinable.length > 0 ? `（${joinable.map((r) => r.name).join('、')}）` : ''}`}</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary sm" disabled={busy || stale} data-zs-member-addsave={projectId} onClick={() => void submit()}>{busy ? '创建中…' : '添加成员'}</button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        {stale ? (
          <div className="panel warning" data-zs-member-addstale={projectId}>项目已切换（当前焦点不再是 {projectName}）——本表单已作废：为避免把旧输入写进别的项目，提交已禁用。请关闭后在新项目重新「添加成员」。</div>
        ) : null}
        <div className="field">
          <label className="field-label">成员名称</label>
          <input className="input" value={name} autoFocus placeholder="例如 审查者、实现者" onChange={(e) => { setName(e.target.value); if (err != null) setErr(null); }} />
          <div className="field-hint">稳定 ID 与显示名分开——改名不断历史引用；同名成员按实例短标识区分（卡片/名单/@/配置处都带 #短标识）。</div>
        </div>
        <div className="field">
          <label className="field-label">说明（它会做什么）</label>
          <input className="input" value={desc} placeholder="例如 实现与重构，偏好直接给结论" onChange={(e) => setDesc(e.target.value)} />
          <div className="field-hint">出现在成员卡与 @ 选择里，帮模型判断该找谁。</div>
        </div>
        <div className="panel">
          <div className="panel-title"><Icon name="info" size={13} /> 添加后会怎样</div>
          <div className="col small" style={{ gap: 5, marginTop: 4, lineHeight: 1.6 }}>
            <div>· 自动加入本项目 <strong>{joinable.length}</strong> 个未归档房间；归档房间保持只读不复活。</div>
            <div>· <strong>不会</strong>自动成为协调者（房间级设置，需在房间设置显式指定）。</div>
            <div>· <strong>不会</strong>加入正在运行的研讨：新成员只影响之后的派发。</div>
            <div className="faint">· runtime 未配置时派发回落全局默认渠道；全局默认缺模型名会启动失败——建好后请「配置 runtime」。</div>
          </div>
        </div>
        {err != null ? <div className="panel warning">{err}</div> : null}
      </div>
    </Modal>
  );
}
