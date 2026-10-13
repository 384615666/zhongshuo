/** 成员详情：批准原型的单成员两列布局，字段来自明确项目的 member.list/member.runtime。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { Avatar, ErrorState, Tag, memberColor, memberShortId } from '../components/ui';
import { useStore, toast } from '../shell';
import { command } from '../bridge';
import { navigate, currentNavSeq } from '../lib/router';
import { refreshMembers, switchFocusProject } from '../loader';
import { memberWrite } from '../data/memberWrites';
import { recordWrite } from '../data/store';
import { EditMemberModal, SaveMemberTemplateModal, UnknownMemberOperations } from '../components/MemberManagementForms';
import { BindRuntimeModal, runtimeAuthOf, type MemberRow, type RuntimeInfo } from '../MembersPage';

export function MemberDetailPage({ projectId, memberId }: { projectId: string; memberId: string }) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId) ?? null);
  const activeId = useStore((s) => s.activeProjectId);
  const opening=useStore(s=>s.openInFlightTarget);
  const navSequence=currentNavSeq();
  const [member, setMember] = useState<MemberRow | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bindOpen, setBindOpen] = useState(false);
  const [editOpen,setEditOpen]=useState(false);
  const [templateOpen,setTemplateOpen]=useState(false);
  const seq = useRef(0);
  const mounted = useRef(false);
  const togglePending = useRef(false);

  const reload = useCallback(async () => {
    if (!mounted.current) return;
    const current = ++seq.current;
    setError(null);
    try {
      const list = await command<{ items: MemberRow[] }>('member.list', { projectId });
      if (current !== seq.current) return;
      const found = list.items.find((m) => m.id === memberId);
      if (found == null) { setMember(null); setError('此成员不属于地址中的项目，或成员已不存在；不会回退到同名成员。'); return; }
      setMember(found);
      try {
        const info = await command<RuntimeInfo>('member.runtime', { memberId });
        if (current !== seq.current) return;
        setRuntime(info); setRuntimeError(null);
      } catch (e) {
        if (current === seq.current) setRuntimeError((e as Error).message); // 保留同一成员的上次确认事实
      }
    } catch (e) { if (current === seq.current) setError((e as Error).message); }
  }, [projectId, memberId]);

  useEffect(() => { mounted.current = true; setMember(null);setRuntime(null);setRuntimeError(null);setBindOpen(false);setEditOpen(false);setTemplateOpen(false);void reload(); return () => { mounted.current = false; seq.current += 1; }; }, [reload]);
  useEffect(() => { if (project != null && activeId !== projectId && !(opening!=null&&opening.projectId!==projectId&&opening.urlSeqAtStart>=navSequence)) void switchFocusProject(projectId).catch((e: unknown) => toast(`聚焦项目失败：${(e as Error).message}`, 'error')); }, [project, projectId, activeId,opening,navSequence]);

  const toggle = async () => {
    if (member == null || member.principalType !== 'agent' || togglePending.current) return;
    togglePending.current = true;
    setBusy(true);
    try {
      const version=seq.current;
      const outcome=await memberWrite(`member.setEnabled:${projectId}:${member.id}`,'member.setEnabled',{projectId,memberId:member.id,expectedRevision:member.revision,enabled:!member.enabled});
      if(!mounted.current||seq.current!==version)return;
      if(outcome.status!=='ok')throw Error(outcome.status==='unknown'?`结果未知：${outcome.error}；请在未知成员操作区人工同号重放`:`${outcome.code}：${outcome.error}`);
      recordWrite('member.setEnabled', `${member.displayName} → ${member.enabled ? '停用' : '启用'}（之后新派发）`);
      if (mounted.current) await reload();
      toast(`已${member.enabled ? '停用' : '启用'}「${member.displayName}」——只影响之后的新派发`, 'success');
    } catch (e) { toast(`成员状态修改失败：${(e as Error).message}`, 'error'); }
    finally { togglePending.current = false; if (mounted.current) setBusy(false); }
  };

  const currentKind = runtime?.installation?.kind;
  const initial: { kind: 'claude' | 'codex' | 'fake'; model: string; executable: string; permissionMode: string } = {
    kind: currentKind === 'codex' || currentKind === 'fake' ? currentKind : 'claude',
    model: runtime?.binding?.model ?? '',
    executable: runtime?.installation?.executable ?? '',
    permissionMode: runtime?.binding?.permissionMode ?? '',
  };
  const guard = runtime?.environment != null ? { fakeAllowed: runtime.environment.allowFake === true, realDispatchGuard: runtime.environment.realDispatchGuard === true } : null;
  const effective = runtime?.effective;

  if (project == null) return <div className="main"><div className="page"><ErrorState code="PROJECT_NOT_FOUND" detail={`项目不存在或不可访问：${projectId}。`} /></div></div>;
  return (
    <div className="main" data-zs-member-detail={memberId}>
      <div className="page">
        <div className="page-head">
          {member != null ? <Avatar name={member.displayName} color={memberColor(member.id)} size={36} round /> : null}
          <div style={{ minWidth: 0 }}>
            <div className="page-title" style={{ fontSize: 18 }}>{member != null ? `${member.displayName} #${memberShortId(member.id)}` : '成员详情'}</div>
            <div className="page-sub">{project.displayName} · {member?.description ?? '项目级成员实例'}</div>
          </div>
          <div className="page-head-actions">
            <button className="btn sm" onClick={() => navigate(`/project/${projectId}/members`)}><Icon name="arrow-left" size={12} /> 返回成员管理</button>
            {member?.principalType === 'agent' ? <button className="btn sm" disabled={busy || member == null} onClick={() => void toggle()}><Icon name={member.enabled ? 'pause' : 'play'} size={12} /> {member.enabled ? '停用成员' : '启用成员'}</button> : null}
          </div>
        </div>

        <UnknownMemberOperations/>
        {error != null ? <div className="panel warning">成员读取失败：{error} <button className="btn sm" onClick={() => void reload()}>重试读取</button></div> : null}
        {member == null && error == null ? <div className="panel info">正在读取成员身份…</div> : null}
        {member != null ? <>
          <div className="grid grid-2">
            <div className="card">
              <div className="card-title" style={{ marginBottom: 12 }}>身份与执行程序</div>
              <div className="strong">{member.displayName} <span className="mono-sm faint">#{memberShortId(member.id)}</span></div>
              <div className="small faint" style={{margin:'6px 0 10px'}}>{member.description||'尚未填写说明'}</div>
              <div className="row tight wrap"><button className="btn sm" data-zs-member-edit={member.id} disabled={project.archivedAt!=null||project.removedAt!=null} onClick={()=>setEditOpen(true)}>编辑名称与说明…</button>
              {member.principalType==='agent'?<button className="btn sm" data-zs-member-template={member.id} disabled={project.archivedAt!=null||project.removedAt!=null||runtimeError!=null||runtime?.installation==null} onClick={()=>setTemplateOpen(true)}>保存配置模板…</button>:null}</div>
              <dl className="kv">
                <dt>项目</dt><dd>{project.displayName}</dd>
                <dt>成员 ID</dt><dd className="mono-sm" style={{ overflowWrap: 'anywhere' }}>{member.id}</dd>
                <dt>类型</dt><dd>{member.principalType === 'agent' ? 'AI 成员' : '本地用户'}</dd>
                <dt>状态</dt><dd>{member.enabled ? '启用' : '停用'}</dd>
                <dt>Runtime</dt><dd>{runtimeError != null ? <Tag tone="warning">配置读取失败</Tag> : runtime == null ? '读取中…' : runtime.installation != null ? `${runtime.installation.kind} · 已绑定` : effective?.source === 'global-default' ? `${effective.kind ?? '未知'} · 全局默认（未绑定）` : '未绑定／来源未解析'}</dd>
                <dt>程序可用性</dt><dd>{runtime?.executableStatus?.status==='missing'?`不可派工：${runtime.executableStatus.reason}`:runtime?.executableStatus?.status==='found'?'已找到程序引用（未执行认证）':'尚未确认'}</dd>
                <dt>可执行文件</dt><dd className="mono-sm">{runtime?.installation?.executable ?? '（未获确认）'}</dd>
              </dl>
              {runtimeError != null ? <div className="panel warning">runtime 读取失败：{runtimeError}（保留上次已确认事实） <button className="btn sm" onClick={() => void reload()}>重试</button></div> : null}
              <div className="panel" style={{ marginTop: 10 }}>成员身份属于此项目；runtime 渠道是执行程序。配置成功不等于模型或识图能力已经认证。</div>
            </div>

            <div className="card">
              <div className="card-title" style={{ marginBottom: 12 }}>模型与能力</div>
              <dl className="kv">
                <dt>模型</dt><dd>{runtime?.binding?.model ?? effective?.model ?? '（未指定／未获确认）'}</dd>
                <dt>模型来源</dt><dd>{effective?.source === 'binding' ? '成员绑定' : effective?.source === 'global-default' ? '全局默认' : '未解析'}</dd>
                <dt>保存的权限模式</dt><dd>{runtime?.binding?.permissionMode ?? '未指定'}</dd>
                <dt>正式执行权限档</dt><dd>{runtime?.permissionExecution?.effective??'未提供'}{runtime?.permissionExecution?.reason?<div className="small faint">{runtime.permissionExecution.reason}</div>:null}</dd>
                <dt>工具权限认证</dt><dd>{runtime?.installation != null ? runtimeAuthOf(runtime.installation.capabilities_json) : '未认证'}</dd>
                <dt>项目文件编辑认证</dt><dd>{runtime?.writeCapability?.status==='supported'?'当前组合已验证':'未认证'}<div className="small faint">{runtime?.writeCapability?.reason??'未提供证据'}</div></dd>
                <dt>真实识图</dt><dd>{runtime?.imageInput?.status === 'supported' ? '已认证' : '未认证'}{runtime?.imageInput?.reason != null ? ` · ${runtime.imageInput.reason}` : ''}</dd>
              </dl>
              {runtime?.imageInput != null ? <details style={{ marginTop: 8 }}><summary>识图配置依据</summary><div className="small mono" style={{ overflowWrap: 'anywhere' }}>配置 {runtime.imageInput.configuration} · 模型 {runtime.imageInput.model ?? '未指定'} · 权限 {runtime.imageInput.permissionMode} · 渠道 {runtime.imageInput.channel} · 协议 {runtime.imageInput.protocol}</div></details> : null}
              {member.principalType === 'agent' ? <button className="btn primary sm" data-zs-member-detail-bind={member.id} onClick={() => setBindOpen(true)} style={{ marginTop: 12 }}>配置 runtime 与模型…</button> : null}
              <div className="pset-divider" />
              <div className="small faint">思考强度、内部子助手与成员级生命周期重置尚无正式配置命令；本页不显示可切换的假开关。</div>
            </div>
          </div>

          <div className="section-title" style={{ marginTop: 20 }}>生命周期动作</div>
          <div className="grid grid-3">
            {[
              ['重启 runtime', '尚无成员级进程重启正式命令'],
              ['重置任务会话', '尚无成员级会话代次重置正式命令'],
              ['清理托管私有资料', '尚无成员级私有资料清理正式命令'],
            ].map(([label, reason]) => <div className="card tight" key={label}><div className="strong">{label}</div><div className="small faint" style={{ marginTop: 4 }}>{reason}</div><button className="btn sm" disabled title={reason} style={{ marginTop: 9 }}>未接入</button></div>)}
          </div>
        </> : null}
      </div>
      {member!=null&&editOpen?<EditMemberModal key={`${projectId}:${memberId}`} projectId={projectId} member={member} onClose={()=>setEditOpen(false)} onSaved={async()=>{setEditOpen(false);await reload();}}/>:null}
      {member!=null&&templateOpen?<SaveMemberTemplateModal key={`${projectId}:${memberId}`} projectId={projectId} member={member} onClose={()=>setTemplateOpen(false)} onSaved={()=>{setTemplateOpen(false);toast('配置模板已保存；成员管理页可查看与复用','success');}}/>:null}
      {member != null && bindOpen ? <BindRuntimeModal member={member} projectId={projectId} initial={initial} guard={guard} onClose={() => setBindOpen(false)} onSaved={async () => { if (!mounted.current) return; setBindOpen(false); await reload(); void refreshMembers(projectId).catch(() => {}); }} /> : null}
    </div>
  );
}
