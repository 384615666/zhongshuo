/**
 * 成员管理（第五十四轮 H3 §4）：正式命令接线——`member.list`（项目/房间两级，保持原有
 * 区别：项目成员全量 vs 房间名单子集；协调者=房间 AUTO 路由依赖，不可停用）、
 * `member.setEnabled`（停用=不再参与**之后**派发——在途不受影响；协调者明确拒绝）、
 * `member.runtime`+`runtime.status`（绑定与能力如实分列：配置成功≠已认证）。
 * 人的关注（阅读订阅）不属于成员管理——在「待我处理」分列（原型同判）。
 * 请求代次收口：切换项目/房间时迟到响应不污染当前页。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './components/Icon';
import { Tag } from './components/ui';
import { useStore, toast } from './shell';
import { navigate } from './lib/router';
import { command } from './bridge';
import { recordWrite } from './data/store';

interface MemberRow { id: string; displayName: string; principalType: string; enabled: boolean }
/** member.runtime DTO：{ binding: { installationId|null, … }, installation: { kind, capabilities_json }|null, environment } */
interface RuntimeInfo { binding?: { installationId?: string | null; model?: string | null; permissionMode?: string | null }; installation?: { id: string; kind: string; executable: string; capabilities_json: string | null } | null; environment?: { realDispatchGuard?: boolean; allowFake?: boolean } }

const runtimeAuthOf = (raw: string | null): string => {
  if (raw == null) return '未认证';
  try {
    const caps = JSON.parse(raw) as { permissionAuth?: string; modelAvailability?: string };
    return caps.permissionAuth === 'unverified' ? '未认证' : String(caps.permissionAuth ?? '未认证');
  } catch { return '未认证'; }
};

export function MembersPage() {
  const projectId = useStore((s) => s.activeProjectId);
  // selector 必须返回稳定引用（useSyncExternalStore 契约——filter 新数组会造成快照死循环，
  // R46 实证）：先取整份 rooms，再按项目 memo 过滤。
  const allRooms = useStore((s) => s.rooms);
  const rooms = useMemo(() => (projectId != null && projectId !== '' ? allRooms.filter((r) => r.projectId === projectId) : allRooms), [allRooms, projectId]);
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [roomMembers, setRoomMembers] = useState<Record<string, MemberRow[]>>({});
  const [runtimes, setRuntimes] = useState<Record<string, RuntimeInfo>>({});
  /** runtime/房间名单的逐项读取失败（r55，review-r54 §5：查询失败≠未绑定——分列如实，
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

  /** r63：绑定编辑行（member.setRuntime——正式命令；fake 仅在环境显式允许时可选）。 */
  const guard = useStore((st) => st.dispatchGuard);
  const storeRuntimes = useStore((st) => st.memberRuntimes);
  const [editAt, setEditAt] = useState<string | null>(null);
  const [bindBusy, setBindBusy] = useState(false);
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
    setEditAt(m.id);
  };
  const saveBind = async (m: MemberRow) => {
    if (bindForm.kind === 'claude' && bindForm.model.trim().length === 0) { toast('claude 绑定必须显式指定模型（服务端同判）', 'warn'); return; }
    setBindBusy(true);
    try {
      await command('member.setRuntime', {
        memberId: m.id, kind: bindForm.kind,
        ...(bindForm.model.trim().length > 0 ? { model: bindForm.model.trim() } : {}),
        ...(bindForm.executable.trim().length > 0 ? { executable: bindForm.executable.trim() } : {}),
        ...(bindForm.permissionMode.length > 0 ? { permissionMode: bindForm.permissionMode } : {}),
      });
      recordWrite('member.setRuntime', `${m.displayName} → ${bindForm.kind}${bindForm.model ? `（${bindForm.model}）` : ''}——配置成功≠能力已认证`);
      toast(`已保存 ${m.displayName} 的 runtime 绑定（${bindForm.kind}${bindForm.model ? ' · ' + bindForm.model : ''}）——能力认证状态以成员页回读为准`, 'success');
      setEditAt(null);
      await reload();
    } catch (e) {
      toast(`绑定失败：${(e as Error).message}`, 'error'); // 防护模式拒真实绑定/模型缺失等真实原因上屏
    } finally { setBindBusy(false); }
  };

  /**
   * runtime 档位四态分列（r55）：查询失败≠未绑定≠已绑定·安装缺失≠正常——
   *  · 查询失败：保留上一次已有事实，显示失败原因（可刷新重试）；
   *  · binding.installationId=null：**未绑定**（此前被显示成「已绑定」——与事实相反）；
   *  · installation=null：绑定在但安装信息缺失（runtime 安装被移除/不可读）；
   *  · 正常：kind + 能力认证状态（配置成功≠已认证）。
   */
  const runtimeLabel = (m: MemberRow): { text: string; problem?: boolean } => {
    const rt = runtimes[m.id];
    if (rt == null) {
      const failure = runtimeErrs[m.id];
      if (failure != null) return { text: `查询失败（${failure}）——保留上次事实`, problem: true };
      return { text: '读取中…' };
    }
    if (rt.binding == null) return { text: '绑定信息缺失（member.runtime 响应异常）', problem: true };
    if (rt.binding.installationId == null || rt.binding.installationId === '') return { text: '未绑定（点「配置 runtime」选择渠道与模型）', problem: true };
    if (rt.installation == null) return { text: '已绑定，但安装信息缺失（runtime 安装不可读/已移除）', problem: true };
    return { text: `${rt.installation.kind} · ${runtimeAuthOf(rt.installation.capabilities_json)}` };
  };

  const coordinatorIds = new Set(rooms.map((r) => r.coordinatorMemberId).filter((x): x is string => x != null));

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 16px' }} className="page-stack" data-zs-members="hifi">
      <div className="row tight" style={{ marginBottom: 8 }}>
        <Icon name="users" size={14} />
        <strong>成员管理</strong>
        <span className="faint small">项目成员（全量）与房间名单分列；停用只影响之后的新派发——在途 turn 不受影响</span>
        <button className="btn ghost sm" onClick={() => void reload()}>刷新</button>
      </div>
      {err != null ? <div className="panel warning">成员装载失败：{err}（可刷新重试）</div> : null}
      {members == null && err == null ? <div className="panel info">正在装载…</div> : null}
      {members != null ? (
        <div className="panel info">
          <div className="row tight"><strong>项目成员</strong><span className="faint small">{members.length} 位</span></div>
          {members.map((m) => {
            const rt = runtimeLabel(m);
            return (
              <div key={m.id} style={{ marginTop: 8, padding: '6px 8px', border: '1px solid var(--border,#dbe2ea)', borderRadius: 6 }}>
              <div className="row tight">
                <Icon name={m.principalType === 'agent' ? 'sparkles' : 'users'} size={13} />
                <span style={{ fontWeight: 600, minWidth: 90 }}>{m.displayName}</span>
                <Tag tone="neutral">{m.principalType === 'agent' ? 'Agent' : '人类'}</Tag>
                {coordinatorIds.has(m.id) ? <Tag tone="info" icon="star">协调者</Tag> : null}
                <span className="faint small" style={rt.problem ? { color: 'var(--warning,#b45309)' } : undefined}>runtime：{rt.text}</span>
                <span style={{ flex: 1 }} />
                {m.principalType === 'agent' ? (
                  <>
                    <button className="btn ghost sm" disabled={busyId === m.id} onClick={() => void toggle(m)}
                      title={m.enabled ? '停用：不再参与之后派发（在途不受影响）' : '启用：恢复参与之后的派发'}>
                      {busyId === m.id ? '处理中…' : m.enabled ? '停用' : '启用'}
                    </button>
                    <button className="btn ghost sm" data-zs-member-bind={m.id} title="配置该成员的 runtime 与模型（member.setRuntime——配置成功≠能力已认证）" onClick={() => (editAt === m.id ? setEditAt(null) : openBind(m))}>
                      配置 runtime
                    </button>
                  </>
                ) : <span className="faint small">（本地用户——不可停用）</span>}
              </div>
              {editAt === m.id && m.principalType === 'agent' ? (
                <div className="row tight wrap" style={{ marginTop: 4, padding: '6px 8px', background: 'var(--bg-surface-2,#f1f5f9)', borderRadius: 6 }} data-zs-member-bindform={m.id}>
                  <label className="field inline" title="runtime 渠道（派发侧按此选 adapter）">
                    <span className="field-label">渠道</span>
                    <select className="select" value={bindForm.kind} onChange={(e) => setBindForm((f) => ({ ...f, kind: e.target.value as typeof f.kind }))}>
                      <option value="claude">claude（CLI）</option>
                      <option value="codex">codex</option>
                      {guard?.fakeAllowed === true ? <option value="fake">fake（仅演练环境）</option> : null}
                    </select>
                  </label>
                  {bindForm.kind === 'claude' ? (
                    <label className="field inline" title="claude 必须显式指定模型（服务端同判拒绝空模型）">
                      <span className="field-label">模型（必填）</span>
                      <input className="composer-input" style={{ width: 160 }} placeholder="如 deepseek-flash" value={bindForm.model} onChange={(e) => setBindForm((f) => ({ ...f, model: e.target.value }))} />
                    </label>
                  ) : null}
                  <label className="field inline" title="可执行文件（留空=渠道默认名：claude/codex）">
                    <span className="field-label">可执行文件</span>
                    <input className="composer-input" style={{ width: 180 }} placeholder="留空=默认（claude/codex）" value={bindForm.executable} onChange={(e) => setBindForm((f) => ({ ...f, executable: e.target.value }))} />
                  </label>
                  <label className="field inline" title="权限模式（可选——默认按 runtime 自身配置）">
                    <span className="field-label">权限模式</span>
                    <select className="select" value={bindForm.permissionMode} onChange={(e) => setBindForm((f) => ({ ...f, permissionMode: e.target.value }))}>
                      <option value="">（默认）</option>
                      <option value="plan">plan</option>
                      <option value="manual">manual</option>
                      <option value="acceptEdits">acceptEdits</option>
                      <option value="auto">auto</option>
                      <option value="dontAsk">dontAsk</option>
                      <option value="bypassPermissions">bypassPermissions</option>
                    </select>
                  </label>
                  <button className="btn sm" disabled={bindBusy} data-zs-member-bindsave={m.id} onClick={() => void saveBind(m)}>{bindBusy ? '保存中…' : '保存绑定'}</button>
                  <button className="btn ghost sm" onClick={() => setEditAt(null)}>取消</button>
                  <span className="faint small">{guard?.realDispatchGuard === true ? '（当前为验收防护环境：真实渠道绑定会被拒绝）' : '保存后回读显示能力状态；配置成功≠已认证'}</span>
                </div>
              ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="panel info">
        <div className="row tight"><strong>房间名单</strong><span className="faint small">（成员参与派发的实际边界；建房默认全加入）</span></div>
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
      <div className="faint small">runtime 绑定/模型在本页「配置 runtime」（member.setRuntime；配置成功≠已认证——能力状态以回读分列如实）；fake 渠道仅演练环境可选。人的关注（阅读订阅）在「待我处理」。</div>
    </div>
  );
}
