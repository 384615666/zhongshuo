import { useEffect, useRef, useState } from 'react';
import { Modal, Select, memberShortId } from './ui';
import { command } from '../bridge';
import { refreshDms, refreshMembers,refreshRooms } from '../loader';
import { getState, useStore } from '../shell';
import { currentNavSeq } from '../lib/router';
import { memberWrite, pendingMemberWrites, memberWriteState, memberWriteStorageError, type MemberWrite } from '../data/memberWrites';
import type { MemberRow } from '../MembersPage';
export interface ConfigTemplate {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    revision: number;
    config: {
        kind: 'claude' | 'codex' | 'fake';
        model: string | null;
        executable: string;
        permissionMode: string | null;
    };
}
export async function refreshMemberIdentity(projectId: string) {
  await Promise.all([refreshMembers(projectId),refreshRooms(projectId),refreshDms(projectId)]);
  const state=getState();
  if(state.activeProjectId===projectId) {
    const failed=state.rooms.find(r=>r.projectId===projectId&&state.readErrors[`roster:${r.id}`]);
    if(failed)throw Error(`房间名单回读失败：${state.readErrors[`roster:${failed.id}`]}；成员已保存，原名单保留，请重试读取`);
  }
  window.dispatchEvent(new CustomEvent('zs-member-changed',{detail:{projectId}}));
}
/** Capture target and navigation generation. A -> B -> A does not revive the original form. */
export function useFormGuard(projectId?: string) {
    const active = useStore(s => s.activeProjectId);
    const origin = useRef(currentNavSeq());
    const [invalid, setInvalid] = useState(false);
    const alive = useRef(false);
    useEffect(() => { alive.current = true; const changed = () => { if (currentNavSeq() !== origin.current)
        setInvalid(true); }; window.addEventListener('hashchange', changed); return () => { alive.current = false; window.removeEventListener('hashchange', changed); }; }, []);
    useEffect(() => { if (projectId && active !== projectId)
        setInvalid(true); }, [projectId, active]);
    return { alive, invalid: invalid || (projectId != null && active !== projectId), valid: () => alive.current && currentNavSeq() === origin.current && (projectId == null || getState().activeProjectId === projectId) };
}
function useWriteForm(scope: string, projectId?: string) {
  const guard=useFormGuard(projectId);
  const [busy,setBusy]=useState(false),[committed,setCommitted]=useState(false),[error,setError]=useState<string|null>(null);
  const pending=useRef(false),readBack=useRef<((isCurrent:()=>boolean)=>void|Promise<void>)|null>(null);
  const retryRead=async()=>{
    if(pending.current||!guard.valid()||!readBack.current)return;
    pending.current=true;setBusy(true);setError(null);
    try{await readBack.current(guard.valid);}catch(e){if(guard.valid())setError(`已提交；回读失败：${(e as Error).message}。只重试读取，不会重新创建或修改。`);}
    finally{pending.current=false;if(guard.alive.current)setBusy(false);}
  };
  const save=async(method:string,params:Record<string,unknown>,done:(isCurrent:()=>boolean)=>void|Promise<void>)=>{
    if(pending.current||committed||!guard.valid())return;
    pending.current=true;setBusy(true);setError(null);
    const result=await memberWrite(scope,method,params);
    if(guard.valid()){
      if(result.status==='ok'){
        setCommitted(true);readBack.current=done;
        try{await done(guard.valid);}catch(e){if(guard.valid())setError(`已提交；回读失败：${(e as Error).message}。只重试读取，不会重新创建或修改。`);}
      }else setError(result.status==='unknown'?`结果未知：${result.error}。原信封已保留，可在成员页「未知成员操作」人工同号重放。`:`${result.code}：${result.error}。输入已保留。`);
    }
    pending.current=false;if(guard.alive.current)setBusy(false);
  };
  return{save,retryRead,busy,committed,error,invalid:guard.invalid};
}
function FormFeedback({state:f}:{state:ReturnType<typeof useWriteForm>}){
  return f.error?<div className="panel warning">{f.error}{f.committed?<button className="btn sm" data-zs-member-readretry disabled={f.busy||f.invalid} onClick={()=>void f.retryRead()}>重试读取已提交结果</button>:null}</div>:null;
}
export function EditMemberModal({ projectId, member, onClose, onSaved }: {
    projectId: string;
    member: MemberRow;
    onClose: () => void;
    onSaved: () => void | Promise<void>;
}) {
    const [name, setName] = useState(member.displayName), [desc, setDesc] = useState(member.description ?? '');
    const f = useWriteForm(`member.update:${projectId}:${member.id}`, projectId);
    return <Modal title={`编辑成员 · #${memberShortId(member.id)}`} size="md" onClose={onClose} subtitle="只修改显示资料；成员身份、任务、会话与 runtime 保持原绑定" footer={<><button className="btn" onClick={onClose}>取消</button><div className="spacer"/><button className="btn primary" data-zs-member-edit-save={member.id} disabled={f.busy || f.invalid || f.committed || !name.trim()} onClick={() => void f.save('member.update', { projectId, memberId: member.id, expectedRevision: member.revision, displayName: name, description: desc }, async (isCurrent) => { await refreshMemberIdentity(projectId); if(isCurrent())await onSaved(); })}>{f.busy ? '保存中…' : '保存资料'}</button></>}>
    {f.invalid ? <div className="panel warning">目标已切换，本表单作废；关闭后重新打开。</div> : null}<FormFeedback state={f}/>
    <label className="field"><span className="field-label">名称</span><input className="input" disabled={f.busy||f.committed} data-zs-member-name value={name} maxLength={60} onChange={e => setName(e.target.value)}/></label>
    <label className="field"><span className="field-label">说明</span><textarea className="input" disabled={f.busy||f.committed} data-zs-member-description value={desc} maxLength={200} onChange={e => setDesc(e.target.value)}/></label><div className="field-hint">名称 1–60 字，说明最多 200 字；历史正文保持原文。同名成员由短 ID 区分。</div>
  </Modal>;
}
export function SaveMemberTemplateModal({ projectId, member, onClose, onSaved }: {
    projectId: string;
    member: MemberRow;
    onClose: () => void;
    onSaved: () => void | Promise<void>;
}) {
    const [name, setName] = useState(`${member.displayName} 配置`.slice(0, 60)), [desc, setDesc] = useState(member.description ?? '');
    const f = useWriteForm(`memberTemplate.saveFromMember:${projectId}:${member.id}`, projectId);
    return <Modal title={`保存配置模板 · ${member.displayName} #${memberShortId(member.id)}`} size="md" onClose={onClose} subtitle="读取此成员当前明确绑定的配置；不复制凭据、认证结论、会话、任务或项目路径" footer={<><button className="btn" onClick={onClose}>取消</button><div className="spacer"/><button className="btn primary" data-zs-template-save disabled={f.busy || f.invalid || f.committed || !name.trim()} onClick={() => void f.save('memberTemplate.saveFromMember', { projectId, memberId: member.id, expectedRevision: member.revision, name, description: desc }, onSaved)}>保存模板</button></>}>
    {f.invalid ? <div className="panel warning">目标已切换，表单作废。</div> : null}<FormFeedback state={f}/>
    <label className="field"><span className="field-label">模板名</span><input className="input" disabled={f.busy||f.committed} data-zs-template-name maxLength={60} value={name} onChange={e => setName(e.target.value)}/></label><label className="field"><span className="field-label">说明</span><textarea className="input" disabled={f.busy||f.committed} maxLength={200} value={desc} onChange={e => setDesc(e.target.value)}/></label>
    <div className="panel info">创建新成员时复制配置快照；以后编辑模板只影响后续创建。未绑定全局默认的成员需先明确配置 runtime。</div>
  </Modal>;
}
export function EditTemplateModal({ template: t, onClose, onSaved }: {
    template: ConfigTemplate;
    onClose: () => void;
    onSaved: () => void | Promise<void>;
}) {
    const [form, setForm] = useState(t);
    const f = useWriteForm(`memberTemplate.update:${t.id}`);
    const fake = useStore(s => s.dispatchGuard?.fakeAllowed === true);
    const config = (patch: Partial<ConfigTemplate['config']>) => setForm(s => ({ ...s, config: { ...s.config, ...patch } }));
    return <Modal title={`编辑模板 · ${t.name}`} size="md" onClose={onClose} subtitle="保存只影响后续创建，已有成员继续使用独立配置" footer={<><button className="btn" onClick={onClose}>取消</button><div className="spacer"/><button className="btn primary" data-zs-template-edit-save disabled={f.busy || f.invalid || f.committed || !form.name.trim()} onClick={() => void f.save('memberTemplate.update', { templateId: t.id, expectedRevision: t.revision, name: form.name, description: form.description, enabled: form.enabled, config: form.config }, onSaved)}>保存模板</button></>}>
    <FormFeedback state={f}/>{f.invalid ? <div className="panel warning">页面已切换，表单作废。</div> : null}
    <label className="field"><span className="field-label">模板名</span><input className="input" disabled={f.busy||f.committed} maxLength={60} value={form.name} onChange={e => setForm(s => ({ ...s, name: e.target.value }))}/></label><label className="field"><span className="field-label">说明</span><textarea className="input" disabled={f.busy||f.committed} maxLength={200} value={form.description} onChange={e => setForm(s => ({ ...s, description: e.target.value }))}/></label>
    <label className="field"><span className="field-label">模板状态</span><Select disabled={f.busy||f.committed} value={form.enabled ? 'enabled' : 'disabled'} ariaLabel="模板状态" options={[{ value: 'enabled', label: '启用 · 可创建' }, { value: 'disabled', label: '停用 · 已有成员不变' }]} onChange={v => setForm(s => ({ ...s, enabled: v === 'enabled' }))}/></label>
    <label className="field"><span className="field-label">渠道</span><Select disabled={f.busy||f.committed} value={form.config.kind} ariaLabel="模板渠道" options={[{ value: 'claude', label: 'claude' }, { value: 'codex', label: 'codex' }, ...(fake ? [{ value: 'fake', label: 'fake · 工程夹具' }] : [])]} onChange={v => config({ kind: v as ConfigTemplate['config']['kind'] })}/></label>
    <label className="field"><span className="field-label">模型 ID</span><input className="input" disabled={f.busy||f.committed} value={form.config.model ?? ''} maxLength={200} onChange={e => config({ model: e.target.value || null })}/></label>
    <label className="field"><span className="field-label">执行程序引用</span><input className="input" disabled={f.busy||f.committed} value={form.config.executable} maxLength={1024} onChange={e => config({ executable: e.target.value })}/></label>
    <label className="field"><span className="field-label">现有权限模式</span><Select disabled={f.busy||f.committed} value={form.config.permissionMode ?? ''} ariaLabel="模板权限" options={['', 'plan', 'manual', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'].map(value => ({ value, label: value || '渠道默认 · 未认证' }))} onChange={v => config({ permissionMode: v || null })}/></label><div className="field-hint">权限沿显式配置保存，不增加认证。程序不可用仍可保存，创建后需回读实际可用性。</div>
  </Modal>;
}
export function CreateFromTemplateModal({ projectId, template: t, onClose, onSaved }: {
    projectId: string;
    template: ConfigTemplate;
    onClose: () => void;
    onSaved: () => void | Promise<void>;
}) {
    const project = useStore(s => s.projects.find(p => p.id === projectId));
    const [name, setName] = useState(t.name), [desc, setDesc] = useState(t.description);
    const f = useWriteForm(`memberTemplate.createMember:${projectId}:${t.id}`, projectId);
    return <Modal title="从模板创建独立成员" size="md" onClose={onClose} subtitle={`目标项目：${project?.displayName ?? projectId} · 模板：${t.name} · 第 ${t.revision + 1} 个配置版本`} footer={<><button className="btn" onClick={onClose}>取消</button><div className="spacer"/><button className="btn primary" data-zs-template-create-save disabled={f.busy || f.invalid || f.committed || !name.trim()} onClick={() => void f.save('memberTemplate.createMember', { projectId, templateId: t.id, expectedRevision: t.revision, displayName: name, description: desc }, async (isCurrent) => { await refreshMemberIdentity(projectId); if(isCurrent())await onSaved(); })}>创建独立成员</button></>}>
    {f.invalid ? <div className="panel warning">目标项目已切换，本表单作废。</div> : null}<FormFeedback state={f}/>
    <label className="field"><span className="field-label">成员名</span><input className="input" disabled={f.busy||f.committed} data-zs-template-member-name maxLength={60} value={name} onChange={e => setName(e.target.value)}/></label><label className="field"><span className="field-label">成员说明</span><textarea className="input" disabled={f.busy||f.committed} maxLength={200} value={desc} onChange={e => setDesc(e.target.value)}/></label>
    <div className="panel">{t.config.kind} · {t.config.model ?? '模型由渠道默认'} · 保存权限档 {t.config.permissionMode ?? '未指定'}<br />程序：{t.config.executable}<br />{t.config.kind==='codex'?'Codex 项目沙箱协议已映射；文件写入尚无真实认证，不能继承 Claude 证据。':null}<br/>配置成功不等于可派工或识图认证。不自动派发、不成为协调者，不复用旧会话；加入未归档房间只影响之后派发。</div>
  </Modal>;
}
export function TemplatePanel({ projectId, readOnly, onChanged }: {
    projectId: string;
    readOnly: boolean;
    onChanged: () => void | Promise<void>;
}) {
    const [rows, setRows] = useState<ConfigTemplate[] | null>(null), [cursor, setCursor] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [edit, setEdit] = useState<ConfigTemplate | null>(null), [create, setCreate] = useState<{
        projectId: string;
        template: ConfigTemplate;
    } | null>(null);
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
    <div className="small faint">从选定成员的「保存配置模板」建立；模板在此数据根内跨项目复用，创建时取快照。列表按页显示；“刷新模板”回到首批。</div>{error ? <div className="panel warning">模板读取失败：{error}（保留已确认事实）</div> : null}
    {rows === null && !error ? <div className="panel info">正在读取模板…</div> : rows?.length === 0 ? <div className="panel">暂无配置模板。先配置成员，再从该成员保存模板。</div> : null}
    <div className="grid grid-3" data-zs-template-list>{rows?.map(t => <div className="card tight" key={t.id} data-zs-template={t.id}><div className="strong">{t.name} · {t.enabled ? '启用' : '停用'}</div><div className="small faint">{t.description}</div><div className="small" style={{ marginTop: 8 }}>{t.config.kind} · {t.config.model ?? '渠道默认模型'} · {t.config.permissionMode ?? '渠道默认权限'}</div><details><summary>配置快照</summary><div className="small mono">{t.config.executable}</div><div className="small faint">第 {t.revision + 1} 个版本 · 未复制认证结论</div></details><div className="row tight wrap" style={{ marginTop: 10 }}><button className="btn ghost sm" data-zs-template-edit={t.id} onClick={() => setEdit(t)}>编辑 / 停用</button><button className="btn primary sm" data-zs-template-create={t.id} disabled={!t.enabled || readOnly || !projectId} onClick={() => setCreate({ projectId, template: t })}>在本项目创建…</button></div></div>)}</div>
    {cursor ? <button className="btn sm" onClick={() => void load(true)}>加载下一页模板（每页最多 50 项）</button> : null}
    {edit ? <EditTemplateModal key={edit.id} template={edit} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null);await load(); }}/> : null}
    {create ? <CreateFromTemplateModal key={`${create.projectId}:${create.template.id}`} projectId={create.projectId} template={create.template} onClose={() => setCreate(null)} onSaved={async () => { setCreate(null);await onChanged(); }}/> : null}
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
            setError(r.status === 'failed' ? `${r.code}：${r.error}` : `结果仍未知：${r.error}`);
    } };
    if (!items.length && !error)
        return null;
    return <div className="panel warning" data-zs-member-unknown><div className="strong">待确认与未知成员操作</div><div className="small">待确认或未知结果保留在此；重连、重开不会自动执行或换新身份。人工重放使用原 commandId 与原参数。</div>{error ? <div>{error}</div> : null}{memberWriteStorageError?<div>{memberWriteStorageError}</div>:null}{items.map(p => <div className="row tight wrap" key={p.commandId}><span className="small">{memberWriteState(p)==='pending'?'等待回执':memberWriteState(p)==='ok'?'已成功 · 本地账本未收口':memberWriteState(p)==='failed'?'服务端明确拒绝 · 本地账本未收口':'结果未知'} · {p.method} · {String(p.params.displayName ?? p.params.name ?? p.params.templateId ?? (typeof p.params.memberId==='string'?`#${memberShortId(p.params.memberId)}`:'成员操作'))} · 项目 {String(p.params.projectId ?? '全局模板')}</span><details className="small faint"><summary>原操作与目标</summary><div className="mono-sm">{p.commandId}</div><div>项目：{String(p.params.projectId??'全局模板')} · 成员：{String(p.params.memberId??'创建新身份')} · 模板：{String(p.params.templateId??'未引用模板')} · 基线版本：{String(p.params.expectedRevision??'原合同未提供')}</div>{p.method==='member.setRuntime'?<div>渠道 {String(p.params.kind)} · 模型 {String(p.params.model??'渠道默认')} · 权限 {String(p.params.permissionMode??'渠道默认')} · 程序 {String(p.params.executable??'渠道默认')}</div>:null}{p.method==='member.setEnabled'?<div>原意图：{p.params.enabled===true?'启用':'停用'}</div>:null}</details><button className="btn sm" data-zs-member-replay={p.commandId} disabled={busy !== null||memberWriteState(p)==='pending'} onClick={() => void replay(p)}>同号重放原操作</button></div>)}</div>;
}
