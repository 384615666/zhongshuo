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
 * 说明面板；配置 runtime 从卡片进弹窗（不再行内铺表单）。「添加成员」按钮**不设**：成员由
 * 项目注册建立（member.create 属 DEV-10 后续批次）——不放一个点了会假成功的按钮。
 * 人的关注（阅读订阅）不属于成员管理——在「待我处理」分列（原型同判）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './components/Icon';
import { Avatar, Modal, Tag, memberColor } from './components/ui';
import { useStore, toast } from './shell';
import { refreshMembers } from './loader';
import { navigate } from './lib/router';
import { command } from './bridge';
import { recordWrite } from './data/store';

interface MemberRow { id: string; displayName: string; principalType: string; enabled: boolean }
/** member.runtime DTO：binding/installation/effective（R66 P5 有效来源）/environment。 */
interface RuntimeInfo {
  binding?: { installationId?: string | null; model?: string | null; permissionMode?: string | null };
  installation?: { id: string; kind: string; executable: string; capabilities_json: string | null } | null;
  effective?: { source: 'binding' | 'global-default' | 'unresolved'; kind: string | null; model: string | null; defaultKindEnv: string | null };
  environment?: { realDispatchGuard?: boolean; allowFake?: boolean };
}

const runtimeAuthOf = (raw: string | null): string => {
  if (raw == null) return '未认证';
  try {
    const caps = JSON.parse(raw) as { permissionAuth?: string; modelAvailability?: string };
    return caps.permissionAuth === 'unverified' ? '未认证' : String(caps.permissionAuth ?? '未认证');
  } catch { return '未认证'; }
};

export function MembersPage() {
  const projectId = useStore((s) => s.activeProjectId);
  const projects = useStore((s) => s.projects);
  // selector 必须返回稳定引用（useSyncExternalStore 契约——filter 新数组会造成快照死循环，
  // R46 实证）：先取整份 rooms/tasks，再按项目 memo 过滤。
  const allRooms = useStore((s) => s.rooms);
  const allTasks = useStore((s) => s.tasks);
  const rooms = useMemo(() => (projectId != null && projectId !== '' ? allRooms.filter((r) => r.projectId === projectId) : allRooms), [allRooms, projectId]);
  const tasks = useMemo(() => (projectId != null && projectId !== '' ? allTasks.filter((t) => t.projectId === projectId) : allTasks), [allTasks, projectId]);
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [roomMembers, setRoomMembers] = useState<Record<string, MemberRow[]>>({});
  const [runtimes, setRuntimes] = useState<Record<string, RuntimeInfo>>({});
  /** runtime/房间名单的逐项读取失败（r55：查询失败≠未绑定——分列如实，
   *  读失败的已有事实保留，不把 installationId=null 显示成「已绑定」）。 */
  const [runtimeErrs, setRuntimeErrs] = useState<Record<string, string>>({});
  const [roomMemberErrs, setRoomMemberErrs] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const genRef = useRef(0);

  const reload = useCallback(async () => {
    if (projectId == null || projectId === '') return;
    const gen = ++genRef.current;
    setErr(null);
    try {
      const r = await command<{ items: MemberRow[] }>('member.list', { projectId });
      if (gen !== genRef.current) return; // 已切换——迟到响应不污染
      setMembers(r.items);
      const rt: Record<string, RuntimeInfo> = {};
      const rtErr: Record<string, string> = {};
      await Promise.all(r.items.map(async (m) => {
        try {
          const info = await command<RuntimeInfo>('member.runtime', { memberId: m.id });
          if (gen === genRef.current) rt[m.id] = info;
        } catch (e) {
          if (gen === genRef.current) rtErr[m.id] = (e as Error).message; // 查询失败如实记录
        }
      }));
      if (gen !== genRef.current) return;
      setRuntimes(rt);
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
      setRoomMembers(perRoom);
      setRoomMemberErrs(roomErr);
    } catch (e) {
      if (gen === genRef.current) setErr((e as Error).message);
    }
  }, [projectId, rooms]);

  useEffect(() => { void reload(); }, [reload]);

  const toggle = async (m: MemberRow) => {
    setBusyId(m.id);
    try {
      await command('member.setEnabled', { memberId: m.id, enabled: !m.enabled });
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
  const [bindFor, setBindFor] = useState<MemberRow | null>(null);
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
    setBindFor(m);
  };

  const coordinatorIds = new Set(rooms.map((r) => r.coordinatorMemberId).filter((x): x is string => x != null));

  /**
   * runtime 分列（R66 P5 修订）：查询失败 / 未绑定（有效=全局默认）/ 已绑定·安装缺失 / 正常。
   * 未绑定时同时给出**有效来源**（effective.kind——全局默认渠道），不再让「未绑定」
   * 被读成"不会用任何渠道"。
   */
  const runtimeLabel = (m: MemberRow): { text: string; problem?: boolean; effective?: string } => {
    const rt = runtimes[m.id];
    if (rt == null) {
      const failure = runtimeErrs[m.id];
      if (failure != null) return { text: `查询失败（${failure}）——保留上次事实`, problem: true };
      return { text: '读取中…' };
    }
    if (rt.binding == null) return { text: '绑定信息缺失（member.runtime 响应异常）', problem: true };
    if (rt.binding.installationId == null || rt.binding.installationId === '') {
      const eff = rt.effective;
      if (eff != null && eff.source === 'global-default' && eff.kind != null) {
        return {
          text: `未绑定 → 实际用全局默认（${eff.kind}${eff.model != null ? ` · ${eff.model}` : ''}${eff.defaultKindEnv != null ? `，ZS_RUNTIME=${eff.defaultKindEnv}` : ''}）`,
          problem: true,
          effective: eff.kind,
        };
      }
      return { text: '未绑定（点「配置 runtime」选择渠道与模型）', problem: true };
    }
    if (rt.installation == null) return { text: '已绑定，但安装信息缺失（runtime 安装不可读/已移除）', problem: true };
    return { text: `${rt.installation.kind} · ${runtimeAuthOf(rt.installation.capabilities_json)}` };
  };

  return (
    <div className="main" style={{ overflow: 'auto' }} data-zs-members="hifi">
      <div className="page">
        {/* 筛选行（原型：项目选择与顶栏同源——切换即聚焦并路由；「添加成员」按钮不设：
            成员由项目注册建立（member.create 属 DEV-10 后续批次），不放假成功入口）。 */}
        <div className="page-filters">
          <label className="field inline">
            <span className="field-label">项目</span>
            <select
              className="select"
              value={projectId}
              title="成员是项目级实例：同一个渠道/模型在不同项目里是不同成员，身份与会话不合并"
              onChange={(e) => { const next = e.target.value; if (next !== projectId) { void import('./loader').then((m) => m.switchFocusProject(next)); navigate(`/project/${next}/members`); } }}
            >
              {projects.filter((p) => p.removedAt == null).map((p) => (
                <option key={p.id} value={p.id}>{p.displayName}</option>
              ))}
            </select>
          </label>
          <span className="filter-note">
            {members?.length ?? '…'} 名成员 · 成员是项目级实例，同名成员不合并
          </span>
          <div className="spacer" />
          <button className="btn ghost sm" onClick={() => void reload()} title="重新装载成员/绑定/房间名单（迟到响应不污染当前项目）">刷新</button>
        </div>

        {projectId == null || projectId === '' ? (
          <div className="panel info">尚未打开项目——从侧栏项目菜单或顶栏「项目管理」进入（成员按项目分列）。</div>
        ) : null}
        {err != null ? <div className="panel warning">成员装载失败：{err}（可刷新重试）</div> : null}
        {members == null && err == null && projectId != null && projectId !== '' ? <div className="panel info">正在装载…</div> : null}

        {members != null && members.length === 0 ? (
          <div className="panel info">这个项目还没有成员。成员在项目注册时建立；添加新成员的界面入口属后续批次（不放假成功按钮）。</div>
        ) : null}

        {/* 成员卡片（原型 grid-2：头像+名称+身份标签 / runtime 有效来源 / 在跑任务） */}
        <div className="grid grid-2">
          {members?.map((m) => {
            const rt = runtimeLabel(m);
            const running = tasks.filter((t) => t.ownerMemberId === m.id && ['ACTIVE', 'WAITING_USER', 'BLOCKED', 'REVIEW'].includes(t.status));
            return (
              <div key={m.id} className="card" data-zs-member-card={m.id}>
                <div className="row tight">
                  <Avatar name={m.displayName} color={memberColor(m.id)} size={36} round />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row tight">
                      <span className="strong">{m.displayName}</span>
                      {coordinatorIds.has(m.id) ? <Tag tone="accent" icon="star">协调者</Tag> : null}
                      {m.principalType === 'agent' ? null : <Tag plain icon="users">人类</Tag>}
                      {!m.enabled ? <Tag tone="neutral" icon="slash">已停用</Tag> : null}
                    </div>
                    <div className="small faint" style={{ marginTop: 3 }}>
                      {rt.problem ? <span style={{ color: 'var(--warning,#b45309)' }}>runtime：{rt.text}</span> : <>runtime：{rt.text}</>}
                    </div>
                  </div>
                </div>
                <div className="small faint" style={{ marginTop: 8, lineHeight: 1.6 }}>
                  {running.length > 0 ? `负责任务 ${running.map((t) => `#${t.roomTaskNumber}`).join('、')}` : '当前没有负责的未结束任务'}
                  {m.principalType === 'agent' ? '' : '（本地用户——不可停用）'}
                </div>
                {m.principalType === 'agent' ? (
                  <div className="row tight" style={{ marginTop: 10 }}>
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
                      <span key={m.id} className="chip" title={`${m.displayName}${m.enabled ? '' : '（已停用）'}`} style={{ opacity: m.enabled ? 1 : 0.5 }}>
                        {m.displayName}{room.coordinatorMemberId === m.id ? ' ★' : ''}
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

      {/* 配置 runtime 弹窗（R66 P4：从行内表单收进弹窗——字段与命令不变） */}
      {bindFor != null && bindFor.principalType === 'agent' ? (
        <BindRuntimeModal
          member={bindFor}
          initial={bindForm}
          guard={guard}
          onClose={() => setBindFor(null)}
          onSaved={async () => { setBindFor(null); await reload(); void refreshMembers().catch(() => { /* 投影刷新失败=发送区提示按旧事实多显示一轮，下次装载自对 */ }); }}
        />
      ) : null}
    </div>
  );
}

function BindRuntimeModal({ member, initial, guard, onClose, onSaved }: {
  member: MemberRow;
  initial: { kind: 'claude' | 'codex' | 'fake'; model: string; executable: string; permissionMode: string };
  guard: { fakeAllowed: boolean; realDispatchGuard: boolean } | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (form.kind === 'claude' && form.model.trim().length === 0) { toast('claude 绑定必须显式指定模型（服务端同判）', 'warn'); return; }
    setBusy(true);
    try {
      await command('member.setRuntime', {
        memberId: member.id, kind: form.kind,
        ...(form.model.trim().length > 0 ? { model: form.model.trim() } : {}),
        ...(form.executable.trim().length > 0 ? { executable: form.executable.trim() } : {}),
        ...(form.permissionMode.length > 0 ? { permissionMode: form.permissionMode } : {}),
      });
      recordWrite('member.setRuntime', `${member.displayName} → ${form.kind}${form.model ? `（${form.model}）` : ''}——配置成功≠能力已认证`);
      toast(`已保存 ${member.displayName} 的 runtime 绑定（${form.kind}${form.model ? ' · ' + form.model : ''}）——能力认证状态以成员页回读为准`, 'success');
      await onSaved();
    } catch (e) {
      toast(`绑定失败：${(e as Error).message}`, 'error'); // 防护模式拒真实绑定/模型缺失等真实原因上屏
    } finally { setBusy(false); }
  };
  return (
    <Modal
      size="md"
      title={`配置 runtime · ${member.displayName}`}
      subtitle="member.setRuntime——配置成功≠能力已认证；未绑定时该成员派发用全局默认渠道"
      onClose={onClose}
      footer={
        <>
          <span className="small faint">{guard?.realDispatchGuard === true ? '当前为验收防护环境：真实渠道绑定会被拒绝' : '保存后回读显示能力状态'}</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary sm" disabled={busy} data-zs-member-bindsave={member.id} onClick={() => void save()}>{busy ? '保存中…' : '保存绑定'}</button>
        </>
      }
    >
      <div className="col" style={{ gap: 10 }}>
        <label className="field" title="runtime 渠道（派发侧按此选 adapter）">
          <span className="field-label">渠道</span>
          <select className="select" value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as typeof f.kind }))}>
            <option value="claude">claude（CLI）</option>
            <option value="codex">codex</option>
            {guard?.fakeAllowed === true ? <option value="fake">fake（仅演练环境）</option> : null}
          </select>
        </label>
        {form.kind === 'claude' ? (
          <label className="field" title="claude 必须显式指定模型（服务端同判拒绝空模型）">
            <span className="field-label">模型（必填）</span>
            <input className="input" placeholder="如 deepseek-flash" value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} />
          </label>
        ) : null}
        <label className="field" title="可执行文件（留空=渠道默认名：claude/codex）">
          <span className="field-label">可执行文件</span>
          <input className="input" placeholder="留空=默认（claude/codex）" value={form.executable} onChange={(e) => setForm((f) => ({ ...f, executable: e.target.value }))} />
        </label>
        <label className="field" title="权限模式（可选——默认按 runtime 自身配置）">
          <span className="field-label">权限模式</span>
          <select className="select" value={form.permissionMode} onChange={(e) => setForm((f) => ({ ...f, permissionMode: e.target.value }))}>
            <option value="">（默认）</option>
            <option value="plan">plan</option>
            <option value="manual">manual</option>
            <option value="acceptEdits">acceptEdits</option>
            <option value="auto">auto</option>
            <option value="dontAsk">dontAsk</option>
            <option value="bypassPermissions">bypassPermissions</option>
          </select>
        </label>
      </div>
    </Modal>
  );
}
