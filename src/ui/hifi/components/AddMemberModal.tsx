import { userFacingSystemText } from '../../../contracts/userFacingText';
/**
 * R183「添加 AI」弹窗（从 MembersPage 抽出，用户第 4、8 项）。
 *
 * 为什么单独成文件：R183 起有两个入口——成员页筛选行的「添加 AI」和模板卡片的
 * 「在本项目创建…」。两条入口必须落到**同一个**表单（同一套字段、校验与提交），
 * 模板只是把值预填进来。若弹窗留在 MembersPage 里，模板面板就得反向依赖页面组件；
 * 抽成独立文件后，模板面板只回传「用这个模板预填」，页面统一打开本弹窗。
 *
 * 约束：本文件不 import MemberManagementForms（那边 import 了 MembersPage 的成员类型，
 * 双向依赖会成环）。
 */
import { useRef, useState } from 'react';
import { Modal, Select } from './ui';
import { RUNTIME_CHANNELS, runtimeExecutable, type RealRuntimeKind } from '../../../contracts/runtimeKinds';
import { RuntimeModel } from './RuntimeModel';
import { RuntimeEffort } from './RuntimeEffort';
import { RuntimeChannelHelp } from './RuntimeChannelHelp';
import { AvatarPicker } from './AvatarPicker';
import { defaultAiAvatarPreset } from '../data/avatarPresets';
import { saveAvatar } from '../data/memberAvatar';
import { toast } from '../shell';
import { recordWrite } from '../data/store';
import { useFormGuard } from '../lib/useFormGuard';
import { memberWrite } from '../data/memberWrites';
import { runtimePermissionHint, runtimePermissionOptions } from '../lib/runtimePermissions';

/** 弹窗只需要房间的这几个字段（实际数据来自本项目 room.list 的完整行）。 */
export interface AddMemberRoom { id: string; name: string; archivedAt?: number | null }

/**
 * 模板预填值：模板只保存渠道配置与名称/说明，不包含账号、会话和任务；
 * 头像保留的是预设标识，由调用方解析成 dataUrl 再传进来。
 */
export interface AddMemberPrefill {
  displayName?: string;
  description?: string;
  kind?: RealRuntimeKind;
  model?: string;
  executable?: string;
  permissionMode?: string;
  effort?: string;
  avatar?: string | null;
}

export function AddMemberModal({ projectId, projectName, scopeProjectId, rooms, prefill, templateName, onClose, onCreated }: {
  projectId: string;
  projectName: string;
  /** R171：页内项目作用域（成员管理页里不切换全局焦点也能保存）；省略=按全局 active 校验。 */
  scopeProjectId: string;
  rooms: AddMemberRoom[] | null;
  prefill?: AddMemberPrefill;
  /** 从模板进入时的模板名，仅用于说明「已预填」，普通添加不传。 */
  templateName?: string;
  onClose: () => void;
  onCreated: (memberId: string) => void | Promise<void>;
}) {
  const formGuard = useFormGuard(projectId, { scopeProjectId });
  const inFlight = useRef(false);
  const initialKind: RealRuntimeKind = prefill?.kind ?? 'claude';
  const [name, setName] = useState(prefill?.displayName ?? '');
  const [desc, setDesc] = useState(prefill?.description ?? '');
  const [runtime, setRuntime] = useState({
    kind: initialKind,
    model: prefill?.model ?? '',
    executable: prefill?.executable?.trim() ? prefill.executable : runtimeExecutable(initialKind),
    // 手动添加沿用原来的「完整权限」默认；模板预填时如实沿用模板值（空=渠道默认）。
    permissionMode: prefill != null ? (prefill.permissionMode ?? '') : 'bypassPermissions',
    effort: prefill?.effort ?? '',
  });
  const [useAsDefault, setUseAsDefault] = useState(true);
  // 头默认跟随所选渠道；模板带了预设头像就以模板为准，用户明确选图后不再被渠道切换覆盖。
  const avatarTouched = useRef(prefill?.avatar !== undefined);
  const [avatar, setAvatar] = useState<string | null>(() => prefill?.avatar !== undefined ? prefill.avatar : defaultAiAvatarPreset(initialKind).dataUrl);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // R171：加入房间的说明用**本页按项目取到的房间名单**（不再读只属于侧栏 active 项目的 store.rooms）。
  const joinable = (rooms ?? []).filter((r) => r.archivedAt == null);
  const stale = formGuard.invalid || scopeProjectId !== projectId; // 打开后本页切走——旧表单作废
  const submit = async () => {
    if (inFlight.current) return;
    if (stale || !formGuard.valid()) { setErr('项目已切换——本表单已作废（针对旧项目的输入不再提交；关闭后在新项目重新添加）'); return; }
    if (runtime.kind === 'claude' && !runtime.model.trim()) { setErr('请选择模型；若渠道未返回清单，可在高级设置指定模型 ID。'); return; }
    if (name.trim().length === 0) { setErr('请填写成员名称（不能为空白）'); return; }
    inFlight.current = true; setBusy(true); setErr(null);
    try {
      const outcome = await memberWrite<{ memberId: string; roomsJoined: number }>(`member.create:${projectId}`, 'member.create', {
        projectId,
        displayName: name.trim(),
        ...(desc.trim().length > 0 ? { description: desc.trim() } : {}),
        runtime: {
          kind: runtime.kind,
          model: runtime.model.trim() || null,
          executable: runtime.executable.trim() || runtimeExecutable(runtime.kind),
          // 空字符串=渠道默认（合同要求 null，不能把 '' 当权限模式发出去）。
          permissionMode: runtime.permissionMode.length > 0 ? runtime.permissionMode : null,
          effort: runtime.effort || null,
        },
        useAsDefault,
      });
      if (outcome.status !== 'ok') throw Error(outcome.status === 'unknown' ? `结果未知：${userFacingSystemText(outcome.error ?? '')}；原操作请求已保存，可在成员页重试` : `${outcome.code}：${userFacingSystemText(outcome.error ?? '')}`);
      const r = outcome.data;
      if (!formGuard.valid()) return;
      recordWrite('member.create', `添加成员「${name.trim()}」到 ${projectName}（加入 ${r.roomsJoined} 个未归档房间）`);
      // 成员已创建，头像单独写；写失败只提示，不让已经建好的成员变成"添加未确认"。
      try {
        await saveAvatar(`member:${r.memberId}`, avatar);
        recordWrite('app.appearance.set', `新成员「${name.trim()}」头像${avatar == null ? '使用默认头像' : '已设置'}`);
      } catch (avatarError) {
        toast(`成员已创建，但头像未保存：${userFacingSystemText((avatarError as Error).message ?? '')}`, 'error');
      }
      await onCreated(r.memberId);
    } catch (e) {
      if (formGuard.valid()) setErr(`添加未确认：${userFacingSystemText((e as Error).message ?? '')}`); // 归档/移除守卫等真实原因上屏
    } finally { inFlight.current = false; if (formGuard.alive.current) setBusy(false); }
  };
  return (
    <Modal
      size="md"
      title="添加 AI"
      subtitle={`添加到 ${projectName}${templateName != null ? ` · 已按模板「${templateName}」预填` : ''}`}
      onClose={onClose}
      footer={
        <>
          <span className="small faint">{stale ? '本页已切到别的项目——表单作废' : rooms == null ? '正在读取本项目的房间名单…' : `创建后自动加入 ${joinable.length} 个未归档房间${joinable.length > 0 ? `（${joinable.map((r) => r.name).join('、')}）` : ''}`}</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary sm" disabled={busy || stale} data-zs-member-addsave={projectId} onClick={() => void submit()}>{busy ? '创建中…' : '添加成员'}</button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        {stale ? (
          <div className="panel warning" data-zs-member-addstale={projectId}>本页已切换到别的项目（不再是 {projectName}）——本表单已作废：为避免把旧输入写进别的项目，提交已禁用。请关闭后在新项目重新「添加成员」。</div>
        ) : null}
        <div className="field">
          <label className="field-label">成员名称</label>
          <input className="input" value={name} autoFocus placeholder="例如 审查者、实现者" onChange={(e) => { setName(e.target.value); if (err != null) setErr(null); }} />
          <div className="field-hint">名称可以重复；同名成员各自独立。</div>
        </div>
        <div className="field">
          <label className="field-label">说明（它会做什么）</label>
          <input className="input" value={desc} placeholder="例如 实现与重构，偏好直接给结论" onChange={(e) => setDesc(e.target.value)} />
          <div className="field-hint">出现在成员卡与 @ 选择里，帮模型判断该找谁。</div>
        </div>
        <label className="field"><span className="field-label">运行渠道</span><Select ariaLabel="运行渠道" value={runtime.kind} disabled={busy} onChange={kind => { setRuntime(f => ({ ...f, kind: kind as RealRuntimeKind, model: '', executable: runtimeExecutable(kind), effort: '' })); if (!avatarTouched.current) setAvatar(defaultAiAvatarPreset(kind).dataUrl); }} options={[...RUNTIME_CHANNELS]} /></label>
        <RuntimeChannelHelp kind={runtime.kind} />
        <RuntimeModel projectId={projectId} kind={runtime.kind} executable={runtime.executable} value={runtime.model} disabled={busy} onChange={model => setRuntime(f => ({ ...f, model, effort: '' }))} />
        <RuntimeEffort projectId={projectId} kind={runtime.kind} executable={runtime.executable} model={runtime.model} value={runtime.effort} onChange={effort => setRuntime(f => ({ ...f, effort }))} />
        <AvatarPicker
          value={avatar}
          disabled={busy}
          onChange={value => { avatarTouched.current = true; setAvatar(value); }}
        />
        <label className="row tight"><input type="checkbox" checked={useAsDefault} disabled={busy} onChange={e => setUseAsDefault(e.target.checked)} />在没有可用协调者的房间中，默认由它接收消息</label>
        <details><summary>高级：执行程序与权限</summary>
          <label className="field"><span className="field-label">执行程序（自动查找）</span><input className="input" disabled={busy} value={runtime.executable} placeholder="留空使用本机 CLI" onChange={e => setRuntime(f => ({ ...f, executable: e.target.value }))} /></label>
          <label className="field"><span className="field-label">执行权限</span><Select ariaLabel="新成员执行权限" value={runtime.permissionMode} disabled={busy} onChange={permissionMode => setRuntime(f => ({ ...f, permissionMode }))} options={runtimePermissionOptions(runtime.permissionMode, runtime.kind)} /></label>
          <div className="field-hint">{runtimePermissionHint(runtime.kind)}</div>
        </details>
        {err != null ? <div className="panel warning">{userFacingSystemText(err ?? '')}</div> : null}
      </div>
    </Modal>
  );
}
