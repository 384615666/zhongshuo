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
import { command } from './bridge';
import { recordWrite } from './data/store';

interface MemberRow { id: string; displayName: string; principalType: string; enabled: boolean }
/** member.runtime DTO：{ binding: { installationId|null, … }, installation: { kind, capabilities_json }|null, environment } */
interface RuntimeInfo { binding?: { installationId?: string | null }; installation?: { id: string; kind: string; executable: string; capabilities_json: string | null } | null; environment?: { realDispatchGuard?: boolean; allowFake?: boolean } }

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
      await Promise.all(r.items.map(async (m) => {
        try {
          const info = await command<RuntimeInfo>('member.runtime', { memberId: m.id });
          if (gen === genRef.current) rt[m.id] = info;
        } catch { /* 未绑定/查询失败如实缺省——不阻塞列表 */ }
      }));
      if (gen !== genRef.current) return;
      setRuntimes(rt);
      const perRoom: Record<string, MemberRow[]> = {};
      await Promise.all(rooms.map(async (room) => {
        try {
          const rr = await command<{ items: MemberRow[] }>('member.list', { projectId, roomId: room.id });
          if (gen === genRef.current) perRoom[room.id] = rr.items;
        } catch { /* 房间名单失败如实缺省 */ }
      }));
      if (gen !== genRef.current) return;
      setRoomMembers(perRoom);
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

  const runtimeLabel = (m: MemberRow): string => {
    const rt = runtimes[m.id];
    if (rt == null || rt.binding == null) return '未绑定';
    if (rt.installation == null) return '已绑定（安装信息缺失）';
    return `${rt.installation.kind} · ${runtimeAuthOf(rt.installation.capabilities_json)}`;
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
          {members.map((m) => (
            <div key={m.id} className="row tight" style={{ marginTop: 8, padding: '6px 8px', border: '1px solid var(--border,#dbe2ea)', borderRadius: 6 }}>
              <Icon name={m.principalType === 'agent' ? 'sparkles' : 'users'} size={13} />
              <span style={{ fontWeight: 600, minWidth: 90 }}>{m.displayName}</span>
              <Tag tone="neutral">{m.principalType === 'agent' ? 'Agent' : '人类'}</Tag>
              {coordinatorIds.has(m.id) ? <Tag tone="info" icon="star">协调者</Tag> : null}
              <span className="faint small">runtime：{runtimeLabel(m)}</span>
              <span style={{ flex: 1 }} />
              {m.principalType === 'agent' ? (
                <button className="btn ghost sm" disabled={busyId === m.id} onClick={() => void toggle(m)}
                  title={m.enabled ? '停用：不再参与之后派发（在途不受影响）' : '启用：恢复参与之后的派发'}>
                  {busyId === m.id ? '处理中…' : m.enabled ? '停用' : '启用'}
                </button>
              ) : <span className="faint small">（本地用户——不可停用）</span>}
            </div>
          ))}
        </div>
      ) : null}
      <div className="panel info">
        <div className="row tight"><strong>房间名单</strong><span className="faint small">（成员参与派发的实际边界；建房默认全加入）</span></div>
        {rooms.map((room) => {
          const list = roomMembers[room.id];
          return (
            <div key={room.id} style={{ marginTop: 8 }}>
              <div className="row tight">
                <Icon name="message-circle" size={12} />
                <span className="small" style={{ fontWeight: 600 }}>{room.name}</span>
                <span className="faint small">{list == null ? '（装载中/失败）' : `${list.length} 位`}</span>
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
      <div className="faint small">runtime 绑定与模型配置在「原界面 → 项目设置」（正式命令 member.setRuntime；配置成功≠已认证——能力状态分列如实）。人的关注（阅读订阅）在「待我处理」。</div>
    </div>
  );
}
