/** 成员详情：批准原型的单成员两列布局，字段来自明确项目的 member.list/member.runtime。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { Avatar, ErrorState, Tag, memberColor, memberShortId } from '../components/ui';
import { useStore, toast } from '../shell';
import { command } from '../bridge';
import { navigate } from '../lib/router';
import { refreshMembers, switchFocusProject } from '../loader';
import { recordWrite } from '../data/store';
import { BindRuntimeModal, runtimeAuthOf, type MemberRow, type RuntimeInfo } from '../MembersPage';

export function MemberDetailPage({ projectId, memberId }: { projectId: string; memberId: string }) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId) ?? null);
  const activeId = useStore((s) => s.activeProjectId);
  const [member, setMember] = useState<MemberRow | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bindOpen, setBindOpen] = useState(false);
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

  useEffect(() => { mounted.current = true; void reload(); return () => { mounted.current = false; seq.current += 1; }; }, [reload]);
  useEffect(() => { if (project != null && activeId !== projectId) void switchFocusProject(projectId).catch((e: unknown) => toast(`聚焦项目失败：${(e as Error).message}`, 'error')); }, [project, projectId, activeId]);

  const toggle = async () => {
    if (member == null || member.principalType !== 'agent' || togglePending.current) return;
    togglePending.current = true;
    setBusy(true);
    try {
      await command('member.setEnabled', { memberId: member.id, enabled: !member.enabled });
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

        {error != null ? <div className="panel warning">成员读取失败：{error} <button className="btn sm" onClick={() => void reload()}>重试读取</button></div> : null}
        {member == null && error == null ? <div className="panel info">正在读取成员身份…</div> : null}
        {member != null ? <>
          <div className="grid grid-2">
            <div className="card">
              <div className="card-title" style={{ marginBottom: 12 }}>身份与执行程序</div>
              <label className="field">
                <span className="field-label">显示名</span>
                <input className="input" value={member.displayName} disabled title="成员改名命令尚未接入，历史身份不能由本页模拟修改" readOnly />
                <span className="field-hint">成员改名命令未接入；同名成员依稳定 ID 区分，不能用名称推断身份。</span>
              </label>
              <dl className="kv">
                <dt>项目</dt><dd>{project.displayName}</dd>
                <dt>成员 ID</dt><dd className="mono-sm" style={{ overflowWrap: 'anywhere' }}>{member.id}</dd>
                <dt>类型</dt><dd>{member.principalType === 'agent' ? 'AI 成员' : '本地用户'}</dd>
                <dt>状态</dt><dd>{member.enabled ? '启用' : '停用'}</dd>
                <dt>Runtime</dt><dd>{runtimeError != null ? <Tag tone="warning">配置读取失败</Tag> : runtime == null ? '读取中…' : runtime.installation != null ? `${runtime.installation.kind} · 已绑定` : effective?.source === 'global-default' ? `${effective.kind ?? '未知'} · 全局默认（未绑定）` : '未绑定／来源未解析'}</dd>
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
                <dt>权限模式</dt><dd>{runtime?.binding?.permissionMode ?? '（渠道默认／未获确认）'}</dd>
                <dt>工具权限认证</dt><dd>{runtime?.installation != null ? runtimeAuthOf(runtime.installation.capabilities_json) : '未认证'}</dd>
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
      {member != null && bindOpen ? <BindRuntimeModal member={member} initial={initial} guard={guard} onClose={() => setBindOpen(false)} onSaved={async () => { if (!mounted.current) return; setBindOpen(false); await reload(); void refreshMembers(projectId).catch(() => {}); }} /> : null}
    </div>
  );
}
