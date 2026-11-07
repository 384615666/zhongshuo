import { userFacingSystemText } from '../../../contracts/userFacingText';
import { useEffect, useRef, useState } from 'react';
import { Modal, Select, memberShortId } from './ui';
import { command } from '../bridge';
import { RUNTIME_CHANNELS, runtimeExecutable, type RuntimeKind } from '../../../contracts/runtimeKinds';
import {runtimeChannelPatch} from '../../../contracts/runtimeSelection';
import {RuntimeModel} from './RuntimeModel';
import {RuntimeEffort} from './RuntimeEffort';
import { runtimePermissionHint, runtimePermissionLabel, runtimePermissionOptions } from '../lib/runtimePermissions';
import { effortLabel, runtimeChannelLabel } from '../lib/format';
import { RuntimeChannelHelp } from './RuntimeChannelHelp';
import { AvatarPicker } from './AvatarPicker';
import { findAvatarPreset, presetForDataUrl } from '../data/avatarPresets';
import { refreshDms, refreshMembers,refreshRooms } from '../loader';
import { getState, useStore } from '../shell';
import { useFormGuard } from '../lib/useFormGuard';
export { useFormGuard } from '../lib/useFormGuard';
import { memberWrite, pendingMemberWrites, memberWriteState, memberWriteStorageError, type MemberWrite } from '../data/memberWrites';
import type { MemberRow } from '../MembersPage';
export interface ConfigTemplate {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    revision: number;
    config: {
        kind: RuntimeKind;
        model: string | null;
        executable: string;
        permissionMode: string | null;
        effort?:string|null;
        /** 预设头像标识；模板只存标识，图片在 renderer 里。 */
        avatarPresetId?: string;
    };
}
export async function refreshMemberIdentity(projectId: string) {
  await Promise.all([refreshMembers(projectId),refreshRooms(projectId),refreshDms(projectId)]);
  const state=getState();
  if(state.activeProjectId===projectId) {
    const failed=state.rooms.find(r=>r.projectId===projectId&&state.readErrors[`roster:${r.id}`]);
    if(failed)throw Error(`房间成员读取失败：${state.readErrors[`roster:${failed.id}`]}；成员已保存，原名单保留，请重试读取`);
  }
  window.dispatchEvent(new CustomEvent('zs-member-changed',{detail:{projectId}}));
}
function useWriteForm(scope: string, projectId?: string, scopeProjectId?: string) {
  // R171：成员管理页可以在页内切项目（不切全局焦点）——表单绑定页内选中项目；
  // 其它入口不传 scopeProjectId，行为与以前完全一致（按全局 activeProjectId 校验）。
  const guard=useFormGuard(projectId,{scopeProjectId});
  const [busy,setBusy]=useState(false),[committed,setCommitted]=useState(false),[error,setError]=useState<string|null>(null);
  const pending=useRef(false),readBack=useRef<((isCurrent:()=>boolean,data?:unknown)=>void|Promise<void>)|null>(null);  const retryRead=async()=>{
    if(pending.current||!guard.valid()||!readBack.current)return;
    pending.current=true;setBusy(true);setError(null);
    try{await readBack.current(guard.valid);}catch(e){if(guard.valid())setError(`已提交，但最新状态读取失败：${userFacingSystemText((e as Error).message ?? '')}。只重试读取，不会重新创建或修改。`);}
    finally{pending.current=false;if(guard.alive.current)setBusy(false);}
  };
  const save=async(method:string,params:Record<string,unknown>,done:(isCurrent:()=>boolean,data?:unknown)=>void|Promise<void>)=>{
    if(pending.current||committed||!guard.valid())return;
    pending.current=true;setBusy(true);setError(null);
    const result=await memberWrite(scope,method,params);
    if(guard.valid()){
      if(result.status==='ok'){
        setCommitted(true);readBack.current=done;
        try{await done(guard.valid,result.data);}catch(e){if(guard.valid())setError(`已提交，但最新状态读取失败：${userFacingSystemText((e as Error).message ?? '')}。只重试读取，不会重新创建或修改。`);}
      }else setError(result.status==='unknown'?`结果未知：${userFacingSystemText(result.error ?? '')}。原操作请求已保留，可在成员页「未知成员操作」中重试。`:`${userFacingSystemText(result.error ?? '') || '操作未完成'}。输入已保留。`);
    }
    pending.current=false;if(guard.alive.current)setBusy(false);
  };
  return{save,retryRead,busy,committed,error,invalid:guard.invalid};
}
function FormFeedback({state:f}:{state:ReturnType<typeof useWriteForm>}){
  return f.error?<div className="panel warning">{userFacingSystemText(f.error ?? '')}{f.committed?<button className="btn sm" data-zs-member-readretry disabled={f.busy||f.invalid} onClick={()=>void f.retryRead()}>重试读取已提交结果</button>:null}</div>:null;
}
export function EditMemberModal({ projectId, scopeProjectId, member, onClose, onSaved }: {
    projectId: string;
    /** R171：页内项目作用域（成员管理页用）；省略=按全局 activeProjectId 校验。 */
    scopeProjectId?: string;
    member: MemberRow;
    onClose: () => void;
    onSaved: () => void | Promise<void>;
}) {
    const [name, setName] = useState(member.displayName), [desc, setDesc] = useState(member.description ?? '');
    const f = useWriteForm(`member.update:${projectId}:${member.id}`, projectId, scopeProjectId);
    return <Modal title="编辑成员" size="md" onClose={onClose} subtitle="只修改名称和说明；任务与会话不受影响" footer={<><button className="btn" onClick={onClose}>取消</button><div className="spacer"/><button className="btn primary" data-zs-member-edit-save={member.id} disabled={f.busy || f.invalid || f.committed || !name.trim()} onClick={() => void f.save('member.update', { projectId, memberId: member.id, expectedRevision: member.revision, displayName: name, description: desc }, async (isCurrent) => { await refreshMemberIdentity(projectId); if(isCurrent())await onSaved(); })}>{f.busy ? '保存中…' : '保存资料'}</button></>}>
    {f.invalid ? <div className="panel warning">目标已切换，本表单作废；关闭后重新打开。</div> : null}<FormFeedback state={f}/>
    <label className="field"><span className="field-label">名称</span><input className="input" disabled={f.busy||f.committed} data-zs-member-name value={name} maxLength={60} onChange={e => setName(e.target.value)}/></label>
    <label className="field"><span className="field-label">说明</span><textarea className="input" disabled={f.busy||f.committed} data-zs-member-description value={desc} maxLength={200} onChange={e => setDesc(e.target.value)}/></label><div className="field-hint">名称 1–60 字，说明最多 200 字。</div>
  </Modal>;
}
export function SaveMemberTemplateModal({ projectId, scopeProjectId, member, onClose, onSaved }: {
    projectId: string;
    /** R171：页内项目作用域（成员管理页用）；省略=按全局 activeProjectId 校验。 */
    scopeProjectId?: string;
    member: MemberRow;
    onClose: () => void;
    onSaved: () => void | Promise<void>;
}) {
    const [name, setName] = useState(`${member.displayName} 配置`.slice(0, 60)), [desc, setDesc] = useState(member.description ?? '');
    const savedAvatars = useStore((s) => s.ui.avatars ?? {});
    const [avatar, setAvatar] = useState<string | null>(() => savedAvatars[`member:${member.id}`] ?? null);
    const avatarPreset = presetForDataUrl(avatar);
    const f = useWriteForm(`memberTemplate.saveFromMember:${projectId}:${member.id}`, projectId, scopeProjectId);
    return <Modal title={`保存配置模板 · ${member.displayName}`} size="md" onClose={onClose} subtitle="保存此成员当前的渠道、模型和权限设置；不包含账号、会话和任务" footer={<><button className="btn" onClick={onClose}>取消</button><div className="spacer"/><button className="btn primary" data-zs-template-save disabled={f.busy || f.invalid || f.committed || !name.trim()} onClick={() => void f.save('memberTemplate.saveFromMember', { projectId, memberId: member.id, expectedRevision: member.revision, name, description: desc, ...(avatarPreset ? { avatarPresetId: avatarPreset.id } : {}) }, onSaved)}>保存模板</button></>}>
    {f.invalid ? <div className="panel warning">目标已切换，表单作废。</div> : null}<FormFeedback state={f}/>
    <label className="field"><span className="field-label">模板名</span><input className="input" disabled={f.busy||f.committed} data-zs-template-name maxLength={60} value={name} onChange={e => setName(e.target.value)}/></label><label className="field"><span className="field-label">说明</span><textarea className="input" disabled={f.busy||f.committed} maxLength={200} value={desc} onChange={e => setDesc(e.target.value)}/></label>
    <AvatarPicker value={avatar} disabled={f.busy || f.committed} allowCustom={false} onChange={setAvatar}/>
    <div className="panel info">创建新成员时会使用这里的设置；之后修改模板只影响新建的成员。</div>
  </Modal>;
}
export function EditTemplateModal({ template: t, scopeProjectId, onClose, onSaved }: {
    template: ConfigTemplate;
    /** R171：用页内选中项目做模型/思考等级的目录上下文（不切全局焦点）；省略=全局 active 项目。 */
    scopeProjectId?: string;
    onClose: () => void;
    onSaved: () => void | Promise<void>;
}) {
    const [form, setForm] = useState(t);
    const [avatar, setAvatar] = useState<string | null>(() => findAvatarPreset(t.config.avatarPresetId ?? '')?.dataUrl ?? null);
    const avatarPreset = presetForDataUrl(avatar);
    const activeProjectId = useStore(s => s.activeProjectId);
    const projectId = scopeProjectId ?? activeProjectId;
    const f = useWriteForm(`memberTemplate.update:${t.id}`);
    const fake = useStore(s => s.dispatchGuard?.fakeAllowed === true);
    const config = (patch: Partial<ConfigTemplate['config']>) => setForm(s => ({ ...s, config: { ...s.config, ...patch } }));
    return <Modal title={`编辑模板 · ${t.name}`} size="md" onClose={onClose} subtitle="保存只影响后续创建，已有成员继续使用独立配置" footer={<><button className="btn" onClick={onClose}>取消</button><div className="spacer"/><button className="btn primary" data-zs-template-edit-save disabled={f.busy || f.invalid || f.committed || !form.name.trim()} onClick={() => void f.save('memberTemplate.update', { templateId: t.id, expectedRevision: t.revision, name: form.name, description: form.description, enabled: form.enabled, config: {...form.config,executable:form.config.executable.trim()||runtimeExecutable(form.config.kind), ...(avatarPreset?{avatarPresetId:avatarPreset.id}:{avatarPresetId:undefined})} }, onSaved)}>保存模板</button></>}>
    <FormFeedback state={f}/>{f.invalid ? <div className="panel warning">页面已切换，表单作废。</div> : null}
    <label className="field"><span className="field-label">模板名</span><input className="input" disabled={f.busy||f.committed} maxLength={60} value={form.name} onChange={e => setForm(s => ({ ...s, name: e.target.value }))}/></label><label className="field"><span className="field-label">说明</span><textarea className="input" disabled={f.busy||f.committed} maxLength={200} value={form.description} onChange={e => setForm(s => ({ ...s, description: e.target.value }))}/></label>
    <label className="field"><span className="field-label">模板状态</span><Select disabled={f.busy||f.committed} value={form.enabled ? 'enabled' : 'disabled'} ariaLabel="模板状态" options={[{ value: 'enabled', label: '启用 · 可创建' }, { value: 'disabled', label: '停用 · 已有成员不变' }]} onChange={v => setForm(s => ({ ...s, enabled: v === 'enabled' }))}/></label>
    <label className="field"><span className="field-label">渠道</span><Select disabled={f.busy||f.committed} value={form.config.kind} ariaLabel="模板渠道" options={[...RUNTIME_CHANNELS.map(channel => ({ value: channel.value, label: runtimeChannelLabel(channel.value) })), ...(fake ? [{ value: 'fake', label: '测试 AI' }] : [])]} onChange={v => config(runtimeChannelPatch(v as RuntimeKind))}/></label>
    <RuntimeChannelHelp kind={form.config.kind}/>
    {projectId&&form.config.kind!=='fake'?<RuntimeModel projectId={projectId} kind={form.config.kind} executable={form.config.executable} value={form.config.model??''} disabled={f.busy||f.committed} onChange={model=>config({model:model||null,effort:null})}/>:<label className="field"><span className="field-label">模型标识</span><input className="input" disabled={f.busy||f.committed} value={form.config.model??''} onChange={e=>config({model:e.target.value||null})}/></label>}
    <label className="field"><span className="field-label">执行程序引用</span><input className="input" disabled={f.busy||f.committed} value={form.config.executable} maxLength={1024} onChange={e => config({ executable: e.target.value })}/></label>
    {projectId?<RuntimeEffort projectId={projectId} kind={form.config.kind} model={form.config.model??''} executable={form.config.executable} value={form.config.effort??''} onChange={effort=>config({effort:effort||null})}/>:<div className="small faint">思考等级：{form.config.effort!=null?effortLabel(form.config.effort):'渠道默认'}；打开项目后可选</div>}
    <label className="field"><span className="field-label">新成员权限模式</span><Select disabled={f.busy||f.committed} value={form.config.permissionMode ?? ''} ariaLabel="模板权限" options={runtimePermissionOptions(form.config.permissionMode,form.config.kind)} onChange={v => config({ permissionMode: v || null })}/></label><div className="field-hint">{runtimePermissionHint(form.config.kind)}</div>
    <AvatarPicker value={avatar} disabled={f.busy||f.committed} allowCustom={false} onChange={setAvatar}/>
  </Modal>;
}
export function TemplatePanel({ projectId, scopeProjectId, readOnly, onCreateFromTemplate }: {
    projectId: string;
    /** R171：页内项目作用域（成员管理页用）；省略=按全局 activeProjectId 校验。 */
    scopeProjectId?: string;
    readOnly: boolean;
    /** R183 第 8 项：创建入口交回页面——打开与其他入口一致的「添加 AI」弹窗并预填模板值。
     *  不在模板面板里再挂一个弹窗（两套创建表单会各自漂移）。 */
    onCreateFromTemplate?: (template: ConfigTemplate) => void;
}) {
    const [rows, setRows] = useState<ConfigTemplate[] | null>(null), [cursor, setCursor] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [edit, setEdit] = useState<ConfigTemplate | null>(null);
    const seq = useRef(0), pending = useRef(false), queued=useRef(false),alive=useRef(false);
    const load = async (more = false) => { if (pending.current){queued.current=true;return;} pending.current = true; const n = ++seq.current; try {
        const r = await command<{
            items: ConfigTemplate[];
            nextCursor: string | null;
        }>('memberTemplate.list', { ...(more && cursor ? { afterId: cursor } : {}) });
        if (seq.current === n) {
            setRows(r.items); // A bounded page, not an accumulating template cache.
            setCursor(r.nextCursor);
            setError(null);
        }
    }
    catch (e) {
        if (seq.current === n)
            setError((e as Error).message);
    }
    finally {
        pending.current = false;
        if(alive.current&&queued.current){queued.current=false;void load();}
    } };
    useEffect(() => { alive.current=true;void load(); const changed = () => void load(); window.addEventListener('zs-member-changed', changed); return () => { alive.current=false;queued.current=false;seq.current++; window.removeEventListener('zs-member-changed', changed); }; }, []);
    return <><div className="section-title" style={{ marginTop: 22 }}>可复用的成员模板 <button className="btn ghost sm" onClick={() => void load()}>刷新模板</button></div>
    {error ? <div className="panel warning">模板读取失败：{userFacingSystemText(error ?? '')}；保留上次结果</div> : null}
    {rows === null && !error ? <div className="panel info">正在读取模板…</div> : rows?.length === 0 ? <div className="panel">暂无配置模板。先配置成员，再从该成员保存模板。</div> : null}
    <div className="grid grid-3" data-zs-template-list>{rows?.map(t => (
      /* R183 第 7 项：卡片只留名称、渠道/模型和两个入口——启用态不写「启用」，
         停用态用极轻的「已停用」保留可读性（停用模板不能创建新成员，服务端同判）。 */
      <div className="card tight" key={t.id} data-zs-template={t.id}>
        <div className="row tight">
          <span className="strong" style={{ flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }} title={t.name}>{t.name}</span>
          {t.enabled ? null : <span className="faint small" title="已停用：不能用来创建新成员；已有成员不受影响">已停用</span>}
        </div>
        <div className="small faint">{runtimeChannelLabel(t.config.kind)} · {t.config.model ?? '渠道默认模型'}</div>
        <div className="row tight wrap" style={{ marginTop: 10 }}>
          <button className="btn ghost sm" data-zs-template-edit={t.id} onClick={() => setEdit(t)}>编辑…</button>
          <button
            className="btn primary sm"
            data-zs-template-create={t.id}
            disabled={!t.enabled || readOnly || !projectId || onCreateFromTemplate == null}
            title={!t.enabled ? '模板已停用，不能创建新成员；已有成员不受影响' : readOnly ? '项目已归档或移除——不能添加成员' : undefined}
            onClick={() => onCreateFromTemplate?.(t)}
          >在本项目创建…</button>
        </div>
      </div>))}</div>
    {cursor ? <button className="btn sm" onClick={() => void load(true)}>加载更多模板</button> : null}
    {edit ? <EditTemplateModal key={edit.id} template={edit} scopeProjectId={scopeProjectId} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null);await load(); }}/> : null}
  </>;
}
export function UnknownMemberOperations() {
    const [items, setItems] = useState<MemberWrite[]>([]), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState<string | null>(null);
    const mounted = useRef(false);
    const read = () => { try {
        setItems(pendingMemberWrites());
        setError(null);
    }
    catch (e) {
        setError((e as Error).message);
    } };
    useEffect(() => { mounted.current = true; read(); window.addEventListener('zs-member-writes', read); return () => { mounted.current = false; window.removeEventListener('zs-member-writes', read); }; }, []);
    const replay = async (p: MemberWrite) => { if (busy)
        return; setBusy(p.scope); const r = await memberWrite(p.scope, p.method, p.params, true); if (mounted.current) {
        setBusy(null);
        if (r.status === 'ok') {
            read();
            if (typeof p.params.projectId === 'string')
                await refreshMemberIdentity(p.params.projectId);
            else
                window.dispatchEvent(new CustomEvent('zs-member-changed'));
        }
        else
            setError(r.status === 'failed' ? `${userFacingSystemText(r.error ?? '') || '操作未完成'}` : `结果仍未知：${userFacingSystemText(r.error ?? '')}`);
    } };
    if (!items.length && !error)
        return null;
    return <div className="panel warning" data-zs-member-unknown><div className="strong">待确认与未知成员操作</div><div className="small">这里保留结果待确认的成员操作。重新连接或打开页面后，可查看原操作记录并决定是否重试。</div>{error ? <div>{userFacingSystemText(error ?? '')}</div> : null}{memberWriteStorageError?<div>{userFacingSystemText(memberWriteStorageError ?? '')}</div>:null}{items.map(p => <div className="row tight wrap" key={p.commandId}><span className="small">{memberWriteState(p)==='pending'?'等待确认':memberWriteState(p)==='ok'?'已成功':memberWriteState(p)==='failed'?'已拒绝':'结果未知'} · {({ 'project.writeAccess.set': '修改项目授权', 'member.create': '添加成员', 'member.update': '修改成员资料', 'member.setRuntime': '修改 AI 配置', 'member.setEnabled': '更改成员启用状态', 'memberTemplate.saveFromMember': '保存成员模板', 'memberTemplate.update': '修改成员模板', 'memberTemplate.createMember': '从模板添加成员' } as Record<string, string>)[p.method] ?? '成员操作'} · {String(p.params.displayName ?? p.params.name ?? p.params.templateId ?? (typeof p.params.memberId==='string'?`#${memberShortId(p.params.memberId)}`:'成员操作'))} · 项目 {String(p.params.projectId ?? '全局模板')}</span><details className="small faint"><summary>原操作与目标</summary><div>项目：{String(p.params.projectId??'全局模板')} · 成员：{String(p.params.memberId??'创建新身份')} · 模板：{String(p.params.templateId??'未引用模板')}</div>{p.method==='member.setRuntime'?<div>渠道 {runtimeChannelLabel(String(p.params.kind))} · 模型 {String(p.params.model??'渠道默认')} · 权限 {runtimePermissionLabel(typeof p.params.permissionMode==='string'?p.params.permissionMode:null, typeof p.params.kind==='string'?p.params.kind:null)} · 程序 {String(p.params.executable??'渠道默认')}</div>:null}{p.method==='member.setEnabled'?<div>原操作：{p.params.enabled===true?'启用':'停用'}</div>:null}</details><button className="btn sm" data-zs-member-replay={p.commandId} disabled={busy !== null||memberWriteState(p)==='pending'} onClick={() => void replay(p)}>使用原记录重试</button></div>)}</div>;
}
