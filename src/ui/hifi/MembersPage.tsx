import { userFacingSystemText } from '../../contracts/userFacingText';
import { RUNTIME_CHANNELS, isRuntimeKind, runtimeExecutable, type RuntimeKind, type RealRuntimeKind } from '../../contracts/runtimeKinds';
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
 * 布局（R170 → R171 → R183）：两栏——左栏是一列**独立项目卡**（每项目一张卡，像私信会话列表；
 * 卡间 7px，与右栏之间一条细分隔），右栏=**页内选中项目**的 AI 列表：搜索/状态筛选与
 * 刷新/添加 AI 同一行、成员卡片、模板面板、房间名单；AI 设置 从卡片进弹窗。
 * 原顶部「项目」下拉已移除（R170 用户反馈第 2 项）。R67 已接正式创建，R81 接资料编辑和
 * 独立配置模板。人的关注（阅读订阅）不属于成员管理——在活动流中保留。
 *
 * R171：页内 `selectedProjectId` 与左侧栏全局焦点**解耦**——点项目卡只换本页数据范围
 * （不 switchFocusProject、不改侧栏 active 高亮）。成员/房间名单/模板/工作量都按它取数；
 * 房间名单改用本项目自己的 `room.list`，不再依赖只属于侧栏 active 项目的全局 `store.rooms`。
 * 左栏项目卡的「N 个房间」在真实数据就绪前**不显示数字**（不把未加载写成 0）。
 *
 * R183（用户第 2-8 项）：
 *  - 左栏改用共享项目卡列（`styles/r183-project-rail.css`）：卡片左右留白对齐，本页不再
 *    自带一套几何；项目顺序跟随侧栏的本地排序偏好（`data/listOrder.ts`）。
 *  - 删除右栏顶部「项目名 + N 名成员」大标题（第 3 项）：成员数并进左栏当前项目卡的 meta 行；
 *    成员数按项目缓存（沿用房间数缓存的做法），切回看过的项目不闪。
 *  - 删除「扫描本机 AI」按钮（第 4 项）：改由点「添加 AI」时先扫描本机已有渠道，再打开
 *    添加弹窗；扫描失败也继续打开（说明保留在页面上）。
 *  - 「刷新」「添加 AI」与搜索/状态筛选同一行（第 5 项）。
 *  - AI 卡片去掉自动生成的说明、协调者标签与「编辑资料」（第 6 项）：名称/说明编辑移进
 *    「AI 设置」弹窗（`allowProfileEdit`，成员详情页行为不变）。
 *  - 模板卡片只留名称、渠道/模型、编辑与「在本项目创建…」（第 7 项）；从模板创建走同一个
 *    添加 AI 弹窗并预填（第 8 项，提交仍是正式 `member.create`）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './components/Icon';
import {RuntimeModel} from './components/RuntimeModel';
import {RuntimeEffort} from './components/RuntimeEffort';
import { Avatar, Modal, Select, Tag, memberColor, memberShortId } from './components/ui';
import { useStore, toast } from './shell';
import { refreshMembers,refreshRooms } from './loader';
import { navigate } from './lib/router';
import { command } from './bridge';
import { recordWrite } from './data/store';
import { useMemberWorkload } from './components/useMemberWorkload';
import { memberWrite } from './data/memberWrites';
import { fullTime, runtimeModelDisplayName } from './lib/format';
import { runtimePermissionHint, runtimePermissionOptions } from './lib/runtimePermissions';
import { RuntimeChannelHelp } from './components/RuntimeChannelHelp';
import { AvatarPicker } from './components/AvatarPicker';
import { defaultAiAvatarPreset, findAvatarPreset } from './data/avatarPresets';
import { saveAvatar } from './data/memberAvatar';
import { SaveMemberTemplateModal, TemplatePanel, UnknownMemberOperations, type ConfigTemplate } from './components/MemberManagementForms';
import { useFormGuard } from './lib/useFormGuard';
import { AddMemberModal, type AddMemberPrefill } from './components/AddMemberModal';
import { orderProjectIds, useListOrderVersion } from './data/listOrder';

export interface MemberRow { id: string; displayName: string; principalType: string; enabled: boolean; description?: string; revision:number }
/** room.list 行：R171 起成员页自己按页内项目取房间名单（不再用全局 store.rooms）。 */
export interface PageRoomRow { id: string; name: string; conversationId?: string; coordinatorMemberId?: string | null; description?: string | null; archivedAt?: number | null; revision?: number }
const EMPTY_ROOMS: PageRoomRow[] = [];
/** member.runtime DTO：binding/installation/effective（R66 P5 有效来源）/environment。 */
export interface RuntimeInfo {
  binding?: { installationId?: string | null; model?: string | null; permissionMode?: string | null;effort?:string|null };
  installation?: { id: string; kind: string; executable: string; capabilities_json: string | null } | null;
  effective?: { source: 'binding' | 'global-default' | 'unresolved'; kind: string | null; model: string | null; defaultKindEnv: string | null };
  executableStatus?:{status:'found'|'missing'|'unknown';reason:string};
  permissionExecution?:{effective:string;reason:string}|null;
  writeCapability?:{status:string;reason:string};
  environment?: { realDispatchGuard?: boolean; allowFake?: boolean };
  imageInput?: { status: string; evidence?:string|null; model: string | null; channel: string; reason: string; configuration: string; protocol: string; permissionMode: string; effort?:string };
}

export const runtimeAuthOf = (raw: string | null): string => {
  if (raw == null) return '未认证';
  try {
    const caps = JSON.parse(raw) as { permissionAuth?: string; modelAvailability?: string };
    return caps.permissionAuth === 'unverified' ? '未认证' : String(caps.permissionAuth ?? '未认证');
  } catch { return '未认证'; }
};

/**
 * R183 第 6 项：自动添加成员时由 daemon 写入的固定说明。
 * 这是给人看的模板文案，不是成员的真实职责描述——卡片上不显示，
 * 用户手填的说明照常显示（只比对文案本身，不做模糊判断）。
 */
const AUTO_ADDED_MEMBER_DESCRIPTION = '由本机默认配置自动添加，可随时修改';

/** R183 第 4/8 项：添加 AI 弹窗的打开参数——项目 + 可选的模板预填值。 */
interface AddMemberTarget { projectId: string; prefill?: AddMemberPrefill; templateName?: string }

export function MembersPage({projectId:routeProjectId}:{projectId?:string}={}) {
  const activeProjectId = useStore((s) => s.activeProjectId);
  const projects = useStore((s) => s.projects);
  /**
   * R171：本页选中的项目——与左侧栏全局焦点**解耦**。
   * 点项目卡只改这里（本页数据范围），不 switchFocusProject、不改侧栏 active 高亮。
   * 初值：显式路由项目 > 全局 active；`/members`（无路由项目）时继续跟随全局焦点，
   * 深链/侧栏入口（`/project/:id/members`）以路由为准。
   */
  const [selectedProjectId, setSelectedProjectId] = useState<string>(() => routeProjectId ?? activeProjectId ?? '');
  const projectId = selectedProjectId;
  const selectedRef = useRef(projectId);
  useEffect(() => { selectedRef.current = projectId; }, [projectId]);
  // 路由变化=页面切换意图（深链 / 侧栏「成员管理」）：只跟随路由，不再反向切换全局项目。
  useEffect(() => { if (routeProjectId != null && routeProjectId !== '') setSelectedProjectId(routeProjectId); }, [routeProjectId]);
  // 无路由项目（/members）时跟随全局焦点：从侧栏/标题栏切项目后本页跟过去。
  useEffect(() => { if ((routeProjectId == null || routeProjectId === '') && activeProjectId !== '') setSelectedProjectId(activeProjectId); }, [activeProjectId, routeProjectId]);

  /**
   * R171：房间名单**按页内项目本地取数**（room.list）。全局 store.rooms 只属于侧栏
   * active 项目，页内切到别的项目时它会给出别的项目的名单——因此这里一律不读它。
   * 读取失败保留同项目上次名单并如实提示（不把未知写成「没有房间」）。
   */
  const sidebarRoomIndexes = useStore((s) => s.sidebarRoomIndexes);
  /**
   * R172 第 3/4 项：按项目缓存**最后已知真值**——切项目时先用缓存渲染，后台读取到达后再替换。
   * 这样已看过的项目切回时，「N 个房间」与右侧成员列表不会先消失再出现；
   * 缓存严格按 projectId（房间名单按 projectId+roomId）隔离，绝不把别的项目数据显示到当前项目。
   */
  const roomCountCache = useRef(new Map<string, number>());
  /** R183 第 3 项：成员数按项目缓存——当前项目用本次读取结果，切回看过的项目先用缓存（不闪）。 */
  const memberCountCache = useRef(new Map<string, number>());
  const roomsCache = useRef(new Map<string, PageRoomRow[]>());
  const membersCache = useRef(new Map<string, MemberRow[]>());
  const roomMembersCache = useRef(new Map<string, MemberRow[]>());
  /** runtime 配置同样按成员缓存：切回已看过的项目时配置行不闪「正在读取配置…」。 */
  const runtimeCache = useRef(new Map<string, RuntimeInfo>());
  const [pageRooms, setPageRooms] = useState<{ projectId: string; items: PageRoomRow[] } | null>(null);
  const [roomsErr, setRoomsErr] = useState<{ projectId: string; message: string } | null>(null);
  const rooms = pageRooms != null && pageRooms.projectId === projectId ? pageRooms.items : (roomsCache.current.get(projectId) ?? EMPTY_ROOMS);
  const roomsReady = pageRooms != null && pageRooms.projectId === projectId;
  /** 该项目是否已经有过房间名单真值（含缓存）——用于决定是否还显示“正在读取”。 */
  const hasRoomsTruth = roomsReady || roomsCache.current.has(projectId);
  const workload = useMemberWorkload(projectId);
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [membersProjectId, setMembersProjectId] = useState<string | null>(null);
  /** 本页当前项目的成员：新数据未到先用该项目上次缓存（不会显示别的项目）→ 切换不闪空列表。 */
  const membersInScope = membersProjectId === projectId ? members : (membersCache.current.get(projectId) ?? null);
  const [roomMembers, setRoomMembers] = useState<Record<string, MemberRow[]>>({});
  const [runtimes, setRuntimes] = useState<Record<string, RuntimeInfo>>({});
  /** runtime/房间名单的逐项读取失败（r55：查询失败≠未绑定——分列如实，
   *  读失败的已有事实保留，不把 installationId=null 显示成「已绑定」）。 */
  const [runtimeErrs, setRuntimeErrs] = useState<Record<string, string>>({});
  const [roomMemberErrs, setRoomMemberErrs] = useState<Record<string, string>>({});
  /** R172：错误也按项目归属，切项目首帧不会闪出别的项目的失败原因。 */
  const [err, setErr] = useState<{ projectId: string; message: string } | null>(null);
  /** 只显示属于当前项目的装载失败原因（别的项目失败不串到本页）。 */
  const scopeErr = err != null && err.projectId === projectId ? err.message : null;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{projectId: string; summary: string; notes: string[]} | null>(null);
  const genRef = useRef(0);
  const [query,setQuery]=useState('');
  const [statusFilter,setStatusFilter]=useState('all');
  const [saveTemplateFor,setSaveTemplateFor]=useState<{projectId:string;member:MemberRow}|null>(null);
  const visibleMembers=membersInScope?.filter(m => `${m.displayName} ${m.description??''} ${memberShortId(m.id)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (statusFilter==='all'||(statusFilter==='enabled'?m.enabled:!m.enabled)));


  const reload = useCallback(async () => {
    if (projectId == null || projectId === '') return;
    const gen = ++genRef.current;
    setErr(null);
    // R171：本项目房间名单**本地取数**（room.list，和成员并行发出——房间数尽早就绪）。
    // 读失败保留同项目上次名单并如实提示，不把未知写成「没有房间」，也不凭旧房间列表取成员。
    const roomTask = (async (): Promise<PageRoomRow[] | null> => {
      try {
        const roomData = await command<{ items: PageRoomRow[] }>('room.list', { projectId });
        if (gen !== genRef.current) return null;
        const rows = roomData.items ?? [];
        roomsCache.current.set(projectId, rows);
        roomCountCache.current.set(projectId, rows.length);
        setPageRooms({ projectId, items: rows });
        setRoomsErr(null);
        return rows;
      } catch (e) {
        if (gen !== genRef.current) return null;
        setRoomsErr({ projectId, message: (e as Error).message });
        return null;
      }
    })();
    try {
      const r = await command<{ items: MemberRow[] }>('member.list', { projectId });
      if (gen !== genRef.current) return; // 已切换——迟到响应不污染
      membersCache.current.set(projectId, r.items);
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
            if (row.info != null) { rt[row.memberId] = row.info; runtimeCache.current.set(row.memberId, row.info); }
            else rtErr[row.memberId] = row.error?.message ?? '成员配置未提供';
          }
        } catch (e) {
          if (gen === genRef.current) for (const m of chunk) rtErr[m.id] = (e as Error).message;
        }
      }));
      if (gen !== genRef.current) return;
      setRuntimes(prev => Object.fromEntries(r.items.flatMap(m => rt[m.id] != null ? [[m.id, rt[m.id]]] : prev[m.id] != null ? [[m.id, prev[m.id]]] : [])));
      setRuntimeErrs(rtErr);
      const roomRows = await roomTask;
      if (gen !== genRef.current || roomRows == null) return;
      const perRoom: Record<string, MemberRow[]> = {};
      const roomErr: Record<string, string> = {};
      await Promise.all(roomRows.map(async (room) => {
        try {
          const rr = await command<{ items: MemberRow[] }>('member.list', { projectId, roomId: room.id });
          if (gen === genRef.current) {
            perRoom[room.id] = rr.items;
            roomMembersCache.current.set(`${projectId}:${room.id}`, rr.items);
          }
        } catch (e) {
          if (gen === genRef.current) roomErr[`${projectId}:${room.id}`] = (e as Error).message; // 房间名单失败≠装载中
        }
      }));
      if (gen !== genRef.current) return;
      setRoomMembers(prev => Object.fromEntries(roomRows.flatMap(room => perRoom[room.id] != null ? [[room.id, perRoom[room.id]]] : prev[room.id] != null ? [[room.id, prev[room.id]]] : [])));
      setRoomMemberErrs(roomErr);
    } catch (e) {
      if (gen === genRef.current) setErr({ projectId, message: (e as Error).message });
    }
  }, [projectId]);

  useEffect(() => { void reload(); return () => { genRef.current += 1; }; }, [reload]);

  const toggle = async (m: MemberRow) => {
    setBusyId(m.id);
    try {
      const outcome=await memberWrite(`member.setEnabled:${projectId}:${m.id}`,'member.setEnabled',{projectId,memberId:m.id,expectedRevision:m.revision,enabled:!m.enabled});
      if(outcome.status!=='ok')throw Error(outcome.status==='unknown'?`结果未知：${userFacingSystemText(outcome.error ?? '')}；请在未知成员操作区使用原记录重试`:`${outcome.code}：${userFacingSystemText(outcome.error ?? '')}`);
      // R171：页内独立——只要本页还停在这个项目就回读，不因全局 active 不同而丢弃结果。
      if(selectedRef.current!==projectId)return;
      recordWrite('member.setEnabled', `${m.displayName} → ${!m.enabled ? '启用' : '停用'}（只影响之后的新派发）`);
      toast(`已${!m.enabled ? '启用' : '停用'} ${m.displayName}（作用范围：之后的新派发）`, 'success');
      await reload();
    } catch (e) {
      toast(`操作失败：${userFacingSystemText((e as Error).message ?? '')}`, 'error'); // 协调者拒绝等真实原因上屏
    } finally {
      setBusyId(null);
    }
  };

  /** r63→R66：绑定编辑弹窗（member.setRuntime——正式命令；fake 仅环境显式允许时可选）。 */
  const guard = useStore((st) => st.dispatchGuard);
  const [bindFor, setBindFor] = useState<{projectId:string;member:MemberRow}|null>(null);
  /** R67：添加成员（member.create 正式合同——已批准原型入口，无用户延期依据）。
   * R68 §5B：捕获**打开时**的 projectId（addFor）——弹窗存续期间全局项目切换（标题栏菜单/
   * 深链/受控事件）时旧表单作废，不再出现「旧 A 输入随全局 activeProjectId 写进 B」。
   * R183 第 8 项：从模板进入时同一次打开携带预填值（模板只带配置，不带账号/会话）。 */
  const [addFor, setAddFor] = useState<AddMemberTarget | null>(null);
  const [bindForm, setBindForm] = useState<{ kind: RuntimeKind; model: string; executable: string; permissionMode: string; effort?:string }>({ kind: 'claude', model: '', executable: runtimeExecutable('claude'), permissionMode: '' });
  const openBind = (m: MemberRow) => {
    const cur = runtimes[m.id];
    const curKind = cur?.installation?.kind;
    setBindForm({
      kind: isRuntimeKind(curKind) ? curKind : 'claude',
      model: cur?.binding?.model ?? '',
      executable: cur?.installation?.executable || runtimeExecutable(isRuntimeKind(curKind) ? curKind : 'claude'),
      permissionMode: cur?.binding?.permissionMode ?? '',effort:cur?.binding?.effort??'',
    });
    setBindFor({projectId,member:m});
  };

  useEffect(()=>{const changed=(event:Event)=>{const p=(event as CustomEvent<{projectId?:string}>).detail?.projectId;if(p==null||p===projectId)void reload();};window.addEventListener('zs-member-changed',changed);return()=>window.removeEventListener('zs-member-changed',changed);},[reload,projectId]);

  /** R68 §5A：当前项目归档/移除——添加入口禁用+说明（服务端同判拒绝，双保险）。 */
  const projState = projects.find((x) => x.id === projectId);
  const projArchived = projState?.archivedAt != null;
  const projRemoved = projState?.removedAt != null;
  /** R183 第 2 项：左栏项目顺序跟随侧栏的本地拖动偏好（新项目/未记录的项目追加在末尾）。
   *  用 useListOrderVersion 订阅变动，拖动后本页与侧栏一起重排，不需要刷新页面。 */
  const listOrderVersion = useListOrderVersion();
  const visibleProjects = useMemo(() => {
    const visible = projects.filter((p) => p.removedAt == null);
    const byId = new Map(visible.map((p) => [p.id, p] as const));
    return orderProjectIds(visible.map((p) => p.id)).flatMap((id) => { const p = byId.get(id); return p == null ? [] : [p]; });
  }, [projects, listOrderVersion]);
  /** R171：房间数在**真值就绪前不显示数字**（不能把未加载写成 0，用户实测切项目会闪 0）：
   *  页内选中项目只用本项目 `room.list` 的结果；其它项目用侧栏房间索引（`ready` 直接用，
   *  正在刷新/读取失败时沿用**上次真实列表**的计数，避免每 5 秒刷新时数字闪没）；
   *  任何一方都没有真值就返回 null（卡片上不显示数字）。 */
  const roomCountOf = (id: string): number | null => {
    // 顺序：本项目本地 room.list 真值 → 侧栏索引 ready（同一项目通常是 active）→ 该项目上次已知值。
    if (id === projectId && roomsReady) return rooms.length;
    const index = sidebarRoomIndexes[id];
    if (index?.status === 'ready') return index.rooms.length;
    // 侧栏索引正在刷新/失败时沿用该项目上次真实计数（不把已知数字闪没；未知仍不显示）。
    return roomCountCache.current.get(id) ?? null;
  };
  /** 缓存只在数据变化时写入（不在 render 里写 ref）。 */
  useEffect(() => {
    if (roomsReady) {
      roomsCache.current.set(projectId, rooms);
      roomCountCache.current.set(projectId, rooms.length);
    }
    for (const [id, index] of Object.entries(sidebarRoomIndexes)) {
      if (index?.status === 'ready') roomCountCache.current.set(id, index.rooms.length);
    }
  }, [projectId, roomsReady, rooms, sidebarRoomIndexes]);
  /**
   * R183 第 3 项：成员数（原来是右栏大标题里的「N 名成员」，现在并进左栏项目卡）。
   * 当前项目用本次读取结果（`membersInScope`）——这是最新真值；其它项目只可能来自缓存：
   * 本页只为选中的项目取成员名单，没看过的项目没有真值就**不写数字**（不把未知写成 0）。
   */
  const memberCountOf = (id: string): number | null => {
    if (id === projectId && membersInScope != null) return membersInScope.length;
    return memberCountCache.current.get(id) ?? null;
  };
  /** 成员数缓存只在数据变化时写入（不在 render 里写 ref）。 */
  useEffect(() => {
    if (membersInScope != null) memberCountCache.current.set(projectId, membersInScope.length);
  }, [projectId, membersInScope]);
  /** R171：选项目=只换本页数据范围；URL 用 replace 记录（刷新/分享后仍停在本页同一项目），
   *  **不** switchFocusProject、不改变侧栏 active 高亮。 */
  const openProject = (next: string) => {
    if (next === projectId) return;
    setSelectedProjectId(next);
    navigate(`/project/${next}/members`, { replace: true });
  };

  /**
   * R183 第 4 项：「扫描本机 AI」原来是独立按钮，现在**点「添加 AI」时先扫描**。
   * 顺序是刻意的：先 discovery 让本机已有渠道出现在添加弹窗里，再刷新成员/房间投影，
   * 最后才打开弹窗；扫描失败也继续打开（用户仍可手动填写），说明留在页面上。
   */
  const beginAdd = async () => {
    if (!projectId || scanning || projArchived || projRemoved) return;
    const targetProjectId = projectId;
    setScanning(true);
    try {
      const result = await command<{created: unknown[]; existing: unknown[]; notes: string[]; skipped: Array<{reason: string}>}>('member.discoverDefaults', {projectId: targetProjectId});
      // R171：页内独立——全局投影读失败不影响本页刷新，如实记进扫描说明。
      const refreshNotes: string[] = [];
      await Promise.all([
        refreshMembers(targetProjectId).catch((e: unknown) => { refreshNotes.push(`成员投影刷新失败：${userFacingSystemText((e as Error).message ?? '')}（将在下次装载时重试）`); }),
        refreshRooms(targetProjectId).catch((e: unknown) => { refreshNotes.push(`房间索引刷新失败：${userFacingSystemText((e as Error).message ?? '')}（将在下次装载时重试）`); }),
      ]);
      // R183：discoverDefaults 对每个未创建的真实渠道各回一条 skipped 说明，内容常常相同
      // （如「真实派发防护已开启…」），直接平铺会在页面重复 4 行；按内容去重、保留首次出现顺序。
      const scanNotes = [...new Set([...result.notes, ...result.skipped.map(item => item.reason), ...refreshNotes])];
      setScanResult({projectId: targetProjectId, summary: `扫描完成：新增 ${result.created.length} 位 AI，已有 ${result.existing.length} 位。`, notes: scanNotes});
      // 只刷新本页仍需显示的项目；不因全局 active 不同而跳过（页内独立）。
      if (selectedRef.current === targetProjectId) await reload();
    } catch (error) {
      setScanResult({projectId: targetProjectId, summary: '扫描未完成', notes: [userFacingSystemText((error as Error).message)]});
    } finally {
      setScanning(false);
      // 扫描失败也继续打开添加弹窗；项目已切走则不打开（避免把弹窗开在旧项目上）。
      if (selectedRef.current === targetProjectId) setAddFor({ projectId: targetProjectId });
    }
  };

  /** R183 第 8 项：模板卡片「在本项目创建…」= 打开同一个添加 AI 弹窗，只把模板值预填进去。
   *  提交仍走 `member.create`（模板面板不再调用 `memberTemplate.createMember`）。 */
  const openAddFromTemplate = (template: ConfigTemplate) => {
    if (!projectId || projArchived || projRemoved) return;
    const rawKind = template.config.kind;
    // 模板渠道可能是只存在于独立工程环境的 fake；添加弹窗只列真实渠道，退回默认渠道并清掉假配置。
    const kind: RealRuntimeKind = isRuntimeKind(rawKind) && rawKind !== 'fake' ? rawKind : 'claude';
    const executable = kind === rawKind && template.config.executable.trim().length > 0 ? template.config.executable : runtimeExecutable(kind);
    const avatar = findAvatarPreset(template.config.avatarPresetId ?? '')?.dataUrl ?? defaultAiAvatarPreset(kind).dataUrl;
    setAddFor({
      projectId,
      templateName: template.name,
      prefill: {
        displayName: template.name,
        description: template.description,
        kind,
        model: kind === rawKind ? (template.config.model ?? '') : '',
        executable,
        permissionMode: template.config.permissionMode ?? '',
        effort: template.config.effort ?? '',
        avatar,
      },
    });
  };

  /**
   * runtime 分列（R66 P5 修订）：查询失败 / 未绑定（有效=全局默认）/ 已绑定·安装缺失 / 正常。
   * 未绑定时同时给出**有效来源**（effective.kind——全局默认渠道），不再让「未绑定」
   * 被读成"不会用任何渠道"。R172：优先用当前读取结果，其次用该成员上次缓存。
   */
  const runtimeOf = (memberId: string): RuntimeInfo | undefined => runtimes[memberId] ?? runtimeCache.current.get(memberId);
  const runtimeLabel = (m: MemberRow): { text: string; problem?: boolean; effective?: string; modelId?: string } => {
    const rt = runtimeOf(m.id);
    if (runtimeErrs[m.id] != null) return { text: '配置暂时读取失败，打开成员详情可重试', problem: true };
    if (rt == null) {
      const failure = runtimeErrs[m.id];
      if (failure != null) return { text: '配置暂时读取失败，保留上次结果', problem: true };
      return { text: '正在读取配置…' };
    }
    if (rt.binding == null) return { text: '尚未读到配置，打开成员详情可重试', problem: true };
    if (rt.binding.installationId == null || rt.binding.installationId === '') {
      const eff = rt.effective;
      if (eff != null && eff.source === 'global-default' && eff.kind != null) {
        // R67：全局默认 **claude 未配置模型名**（ZS_CLAUDE_MODEL 缺省——CLI 拒绝默认配置，
        // 用户 v3 实测 startupFailed 根因）时必须明示发送会失败及解法，不等到派发失败。
        const noModel = eff.kind === 'claude' && (eff.model == null || eff.model.length === 0);
        const modelName = eff.model ? runtimeModelDisplayName({ id: eff.model, label: eff.model }) : '';
        return {
          text: `使用本机默认 ${eff.kind}${modelName?` · ${modelName}`:''}${noModel?' · 需要选择模型':''}`,
          problem: true,
          effective: eff.kind,
          modelId: eff.model ?? undefined,
        };
      }
      return { text: '尚未单独配置，打开「AI 设置」选择模型', problem: true };
    }
    if (rt.installation == null) return { text: '配置暂不可用，打开成员详情查看', problem: true };
    const kind = rt.installation.kind === 'fake' ? '测试环境' : rt.installation.kind;
    const modelId = rt.binding?.model ?? '';
    const modelName = modelId ? runtimeModelDisplayName({ id: modelId, label: modelId }) : '';
    if(rt.executableStatus?.status==='missing')return {text:`${kind}${modelName?' · '+modelName:''} · 执行程序未找到`,problem:true,modelId};
    return { text: `${kind}${modelName?' · '+modelName:''}`, modelId };
  };

  return (
    <div className="main" style={{ overflow: 'auto' }} data-zs-members="hifi">
      <div className="page members-page">
        {/* R183 第 2 项：左栏项目卡列改用全站共享几何（.project-split / .project-rail /
            .project-card …，见 styles/r183-project-rail.css）——本页不再自带一套宽度与间距，
            卡片到页面左缘的留白才与到右栏内容的一致；这里**不覆盖** --project-rail-gap。 */}
        <UnknownMemberOperations/>
        <div className="project-split members-split">
          <aside className="project-rail members-projects" aria-label="项目列表" data-zs-members-projects="hifi">
            <div className="project-rail-title">项目</div>
            <div className="project-rail-list">
              {visibleProjects.map((p) => {
                const current = p.id === projectId;
                const roomCount = roomCountOf(p.id);
                const memberCount = memberCountOf(p.id);
                const missing = p.status === 'missing';
                const archived = p.archivedAt != null;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`project-card${current ? ' is-current' : ''}`}
                    data-zs-members-project={p.id}
                    aria-current={current ? 'page' : undefined}
                    title={current ? `${p.displayName}（本页当前项目）` : `在成员管理里查看 ${p.displayName}（不切换侧栏项目）`}
                    onClick={() => openProject(p.id)}
                  >
                    <span className="project-card-name">{p.displayName}</span>
                    {/* meta 行常驻（CSS min-height）：数字就绪前后卡片高度不跳。
                        R183 第 3 项：成员数从右栏大标题搬到这里；未知（没看过的项目）不写数字。 */}
                    <span className="project-card-meta">
                      {roomCount != null ? <span className="project-card-count">{roomCount} 个房间</span> : null}
                      {roomCount != null && memberCount != null ? <span aria-hidden="true">{' · '}</span> : null}
                      {memberCount != null ? <span className="project-card-count" data-zs-members-card-members={p.id}>{memberCount} 名成员</span> : null}
                      {missing ? <span className="project-card-flag"><Icon name="alert-triangle" size={11} /> 目录失效</span> : null}
                      {archived ? <span className="project-card-flag muted"><Icon name="archive" size={11} /> 已归档</span> : null}
                    </span>
                  </button>
                );
              })}
              {visibleProjects.length === 0 ? <div className="project-rail-empty faint small">还没有项目。先从侧栏「打开/切换项目」添加。</div> : null}
            </div>
          </aside>

          <section className="project-content members-content">
            {/* R183 第 3、5 项：右栏不再有「项目名 + N 名成员」标题块；筛选与两个动作同一行。 */}
            <div className="page-filters">
              <input className="input" aria-label="查找成员" data-zs-member-search placeholder="名称 / 说明" value={query} onChange={e=>setQuery(e.target.value)} style={{maxWidth:260}}/>
              <label className="field inline"><span className="field-label">状态</span><Select value={statusFilter} ariaLabel="成员启用状态筛选" options={[{value:'all',label:'全部状态'},{value:'enabled',label:'启用'},{value:'disabled',label:'停用'}]} onChange={setStatusFilter}/></label>
              <button
                className="btn ghost sm" data-zs-members-refresh onClick={() => { workload.refresh(); void reload(); }} title="刷新成员、工作量与房间名单">刷新</button>
              <button
                className="btn primary sm"
                data-zs-members-add
                disabled={scanning || !projectId || projArchived || projRemoved}
                onClick={() => void beginAdd()}
                title={projArchived || projRemoved ? '项目已归档或移除——不能添加成员' : '先扫描本机已有渠道，再打开添加弹窗'}
              >
                <Icon name="user-plus" size={12} /> {scanning ? '扫描本机 AI…' : '添加 AI'}
              </button>
            </div>

            {/* R183 第 3 项：归档/移除仍要如实提示，但用轻量 note，不再恢复项目名大标题。 */}
            {projArchived || projRemoved ? (
              <div className="faint small" data-zs-members-readonly-note={projectId}>
                {projArchived ? '项目已归档（只读）——不能添加成员或修改成员配置。' : '项目已移除——不能添加成员或修改成员配置。'}
              </div>
            ) : null}

            {/* R183 第 4 项：扫描结果说明留在页面上（入口变成「添加 AI」后的可读反馈）。 */}
            {scanResult?.projectId === projectId ? <div className="panel info" role="status" data-zs-members-scan-result={scanResult.projectId}>
              <div>{scanResult.summary}</div>
              {scanResult.notes.map((note, index) => <div className="small" key={index}>{note}</div>)}
            </div> : null}

            {projectId == null || projectId === '' ? (
              <div className="panel info">尚未选择项目——从左侧选择一个项目，或从侧栏项目菜单进入。</div>
            ) : null}
            {scopeErr != null ? <div className="panel warning">成员装载失败：{userFacingSystemText(scopeErr)}（可刷新重试）</div> : null}
            {workload.error ? <div className="panel warning">成员工作量读取失败：{userFacingSystemText(workload.error ?? '')}。{workload.updatedAt ? `保留 ${fullTime(workload.updatedAt)} 的数据。` : '尚未取得工作量数据。'}</div> : null}
            {workload.data?.truncated ? <div className="faint small">工作量仅统计前 500 名成员。</div> : null}
            {membersInScope == null && scopeErr == null && projectId != null && projectId !== '' ? <div className="panel info">正在装载…</div> : null}

            {membersInScope != null && membersInScope.length === 0 ? (
              <div className="panel info">这个项目还没有 AI。点上方「添加 AI」，选择已有渠道和模型即可开始。</div>
            ) : null}

            {/* 成员卡片（头像+名称+身份标签 / runtime 有效来源 / 在跑任务；右栏自适应列数）。
                R183 第 6 项：去掉自动生成的说明与 ★协调者 标签；名称/说明编辑移进「AI 设置」弹窗。 */}
            <div className="grid members-cards">
              {visibleMembers?.map((m) => {
                const rt = runtimeLabel(m);
                const running = workload.data?.items.find(row=>row.memberId===m.id);
                const description = m.description != null && m.description !== '' && m.description !== AUTO_ADDED_MEMBER_DESCRIPTION ? m.description : null;
                return (
                  <div key={m.id} className="card" data-zs-member-card={m.id} title={`查看 ${m.displayName} 的成员详情`}
                    role="link" tabIndex={0} style={{ cursor: 'pointer' }}
                    onClick={(e) => { if ((e.target as HTMLElement).closest('button, a, input, select, summary')) return; navigate(`/project/${projectId}/member/${m.id}`); }}
                    onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); navigate(`/project/${projectId}/member/${m.id}`); } }}>
                    <div className="row tight">
                      <Avatar name={m.displayName} color={memberColor(m.id)} size={36} round subject={`member:${m.id}`} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="row tight">
                          <span className="strong">{m.displayName}</span>
                          {m.principalType === 'agent' ? null : <Tag plain icon="users">人类</Tag>}
                          {m.enabled ? <Tag plain>启用</Tag> : <Tag tone="neutral" icon="slash">停用</Tag>}
                        </div>
                        <div className="small faint" style={{ marginTop: 3 }}>
                          {description != null ? <div>{description}</div> : null}
                          {rt.problem ? <span style={{ color: 'var(--warning,#b45309)' }} title={rt.modelId?`完整模型 ID：${rt.modelId}`:undefined}>当前配置：{rt.text}</span> : <span title={rt.modelId?`完整模型 ID：${rt.modelId}`:undefined}>当前配置：{rt.text}</span>}
                        </div>
                      </div>
                    </div>
                    <div className="small faint" style={{ marginTop: 8, lineHeight: 1.6 }}>
                      {running ? `负责未结束任务 ${running.unfinishedTasks} · 在途执行 ${running.activeTurns} · 待核对结果 ${running.unknownTurns}` : '成员工作量尚未读到'}
                      {m.principalType === 'agent' ? '' : '（本地用户——不可停用）'}
                    </div>
                    {m.principalType === 'agent' ? (
                      <div className="row tight wrap" style={{ marginTop: 10 }}>
                        <button className="btn ghost sm" data-zs-member-template={m.id} disabled={projArchived||projRemoved||runtimeErrs[m.id]!=null||runtimeOf(m.id)?.installation==null} onClick={()=>setSaveTemplateFor({projectId,member:m})}>保存配置模板</button>
                        <button className="btn ghost sm" disabled={busyId === m.id} onClick={() => void toggle(m)}
                          title={m.enabled ? '停用：不再参与之后派发（在途不受影响）' : '启用：恢复参与之后的派发'}>
                          {busyId === m.id ? '处理中…' : m.enabled ? '停用' : '启用'}
                        </button>
                        <button className="btn ghost sm" data-zs-member-bind={m.id} title="配置该成员的渠道与模型；名称与说明也在这里修改" onClick={() => openBind(m)}>
                          AI 设置…
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {membersInScope!=null && visibleMembers?.length===0 && membersInScope.length>0 ? <div className="panel">没有匹配的成员；筛选不会修改成员或任务。</div>:null}
            <TemplatePanel projectId={projectId} scopeProjectId={projectId} readOnly={projArchived||projRemoved} onCreateFromTemplate={openAddFromTemplate}/>
            <div className="section-title" style={{ marginTop: 22 }}>房间名单</div>
            <div className="panel">
              <div className="faint small" style={{ marginBottom: 8 }}>各房间的成员（★=该房间协调者；新建房间默认全员加入）。</div>
              {roomsErr?.projectId === projectId ? <div className="small" style={{ marginBottom: 8, color: 'var(--warning)' }}>房间名单读取失败：{userFacingSystemText(roomsErr.message)}（保留上次结果，可点「刷新」重试）</div> : null}
              {!hasRoomsTruth && roomsErr?.projectId !== projectId ? <div className="faint small">正在读取本项目的房间名单…</div> : null}
              {rooms.map((room) => {
                const list = roomMembers[room.id] ?? roomMembersCache.current.get(`${projectId}:${room.id}`);
                const failure = roomMemberErrs[`${projectId}:${room.id}`];
                return (
                  <div key={room.id} style={{ marginTop: 8 }}>
                    <div className="row tight">
                      <Icon name="message-circle" size={12} />
                      <span className="small" style={{ fontWeight: 600 }}>{room.name}</span>
                      <span className="faint small">{failure != null ? `名单读取失败（${failure}——保留上次结果，可刷新重试）` : list == null ? '（装载中…）' : `${list.length} 位`}</span>
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
              {hasRoomsTruth && rooms.length === 0 ? <div className="faint small" style={{ marginTop: 4 }}>（本项目没有房间）</div> : null}
            </div>
          </section>
        </div>
      </div>

      {saveTemplateFor ? <SaveMemberTemplateModal key={`${saveTemplateFor.projectId}:${saveTemplateFor.member.id}`} projectId={saveTemplateFor.projectId} scopeProjectId={projectId} member={saveTemplateFor.member} onClose={()=>setSaveTemplateFor(null)} onSaved={()=>{setSaveTemplateFor(null);window.dispatchEvent(new CustomEvent('zs-member-changed',{detail:{projectId}}));}}/>:null}
      {addFor != null ? (
        <AddMemberModal
          key={`${addFor.projectId}:${addFor.templateName ?? 'manual'}`}
          projectId={addFor.projectId}
          projectName={projects.find((x) => x.id === addFor.projectId)?.displayName ?? addFor.projectId}
          scopeProjectId={projectId}
          rooms={hasRoomsTruth ? rooms : null}
          prefill={addFor.prefill}
          templateName={addFor.templateName}
          onClose={() => setAddFor(null)}
          onCreated={async () => {
            const addedProjectId = addFor.projectId;
            setAddFor(null);
            toast('已添加 AI 并保存配置', 'success');
            await Promise.all([refreshRooms(addedProjectId).catch(() => {}), refreshMembers(addedProjectId).catch(() => {})]);
            // R171：页内独立——只刷新本页仍在显示的项目；不因全局 active 不同而跳过或误刷别的项目。
            if (selectedRef.current === addedProjectId) await reload();
            // R183 第 8 项：从模板创建后让模板面板也回读一次（模板本身没变，但列表与计数保持最新）。
            window.dispatchEvent(new CustomEvent('zs-member-changed', { detail: { projectId: addedProjectId } }));
          }}
        />
      ) : null}

      {/* AI 设置 弹窗（R66 P4：从行内表单收进弹窗——字段与命令不变）。
          R183 第 6 项：名称/说明编辑也并进这里（allowProfileEdit），成员管理页不再单独开「编辑资料」。 */}
      {bindFor != null && bindFor.member.principalType === 'agent' ? (
        <BindRuntimeModal
          member={bindFor.member}
          projectId={bindFor.projectId}
          scopeProjectId={projectId}
          initial={bindForm}
          guard={guard}
          allowProfileEdit
          onClose={() => setBindFor(null)}
          onSaved={async () => { setBindFor(null); await reload(); void refreshMembers(projectId).catch(() => { /* 投影刷新失败=发送区提示按旧事实多显示一轮，下次装载自对 */ }); }}
        />
      ) : null}
    </div>
  );
}

export function BindRuntimeModal({ member, projectId, scopeProjectId, initial, guard, onClose, onSaved, allowProfileEdit = false }: {
  member: MemberRow;
  projectId:string;
  /** R171：页内项目作用域（成员管理页里不切换全局焦点也能保存）；省略=按全局 active 校验。 */
  scopeProjectId?:string;
  initial: { kind: RuntimeKind; model: string; executable: string; permissionMode: string; effort?:string };
  guard: { fakeAllowed: boolean; realDispatchGuard: boolean } | null;
  /**
   * R183 第 6 项：成员管理页把名称/说明编辑并进「AI 设置」弹窗（卡片上不再有「编辑资料」）；
   * 成员详情页仍保留自己的「编辑名称与说明」入口，因此默认 false 时行为与以前一致。
   */
  allowProfileEdit?: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const targetProject=useRef(projectId).current;
  const formGuard=useFormGuard(targetProject,{scopeProjectId});
  const [form, setForm] = useState(initial);
  /** 配置基线：只在打开时取一次，用来判断「配置是否真的改了」——没改就不发 member.setRuntime。 */
  const initialForm = useRef(initial).current;
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // R183：名称/说明编辑（可选）——保存基线 + 最新 revision，供「先资料、后配置」两步写使用。
  // 两步写不能共用打开时的 revision：member.update 成功后 settings_revision 会 +1，
  // 后续 member.setRuntime 必须带**新** revision，否则会被 CAS 拒绝。
  const [name, setName] = useState(member.displayName);
  const [description, setDescription] = useState(member.description ?? '');
  const [savedProfile, setSavedProfile] = useState({ name: member.displayName, description: member.description ?? '' });
  const revisionRef = useRef(member.revision);
  // 头像与 AI 配置同一个弹窗保存：初始值取已存头像，没存过就是默认首字母头像。
  const memberSubject = `member:${member.id}`;
  const savedAvatars = useStore((s) => s.ui.avatars ?? {});
  const [avatar, setAvatar] = useState<string | null>(() => savedAvatars[memberSubject] ?? null);
  const mounted = useRef(false);
  const savePending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const nextName = name.trim();
  const nextDescription = description.trim();
  // 名称清空时按钮禁用，不算「改了资料」，这样只调配置时不会被空名称卡住。
  const profileChanged = allowProfileEdit && nextName.length > 0 && (nextName !== savedProfile.name || nextDescription !== savedProfile.description);
  const normalizedExecutable = form.executable.trim() || runtimeExecutable(form.kind);
  const initialExecutable = initialForm.executable.trim() || runtimeExecutable(initialForm.kind);
  const configChanged = form.kind !== initialForm.kind
    || form.model.trim() !== initialForm.model.trim()
    || normalizedExecutable !== initialExecutable
    || form.permissionMode !== initialForm.permissionMode
    || (form.effort ?? '') !== (initialForm.effort ?? '');
  const avatarChanged = (savedAvatars[memberSubject] ?? null) !== avatar;
  /** 成员管理页：两项与头像都没改就没有可保存的内容；成员详情页保持旧行为（点保存即写配置）。 */
  const nothingChanged = !profileChanged && !configChanged && !avatarChanged;
  const shouldWriteConfig = !allowProfileEdit || configChanged;

  const save = async () => {
    if (savePending.current || !formGuard.valid() || (allowProfileEdit && nothingChanged)) return;
    if (allowProfileEdit && nextName.length === 0) { toast('成员名称不能为空白', 'warn'); return; }
    // 只在配置真的要写时才要求 claude 有模型：只改名称/说明不应被未绑定的配置挡住。
    if (shouldWriteConfig && form.kind === 'claude' && form.model.trim().length === 0) { toast('claude 需要选择模型', 'warn'); return; }
    savePending.current = true; setBusy(true); setSaveError(null);
    let profileSaved = false;
    try {
      let revision = revisionRef.current;
      if (profileChanged) {
        const outcome = await memberWrite<{ revision?: number }>(`member.update:${targetProject}:${member.id}`, 'member.update', {
          projectId: targetProject, memberId: member.id, expectedRevision: revision,
          displayName: nextName, description: nextDescription,
        });
        if (outcome.status !== 'ok') throw Error(outcome.status === 'unknown' ? `结果未知：${userFacingSystemText(outcome.error ?? '')}；请在未知成员操作区使用原记录重试` : `${outcome.code}：${userFacingSystemText(outcome.error ?? '')}`);
        if (!formGuard.valid()) return;
        revision = typeof outcome.data?.revision === 'number' ? outcome.data.revision : revision + 1;
        revisionRef.current = revision;
        setSavedProfile({ name: nextName, description: nextDescription });
        profileSaved = true;
        recordWrite('member.update', `${nextName} → 名称与说明已更新`);
        // 资料已经落库：先让页面背后的列表回读一次（弹窗可能随后因配置失败而保留，别让卡片显示旧名）。
        window.dispatchEvent(new CustomEvent('zs-member-changed', { detail: { projectId: targetProject } }));
      }
      let configSaved = false;
      if (shouldWriteConfig) {
        const outcome = await memberWrite(`member.setRuntime:${targetProject}:${member.id}`, 'member.setRuntime', {
          projectId: targetProject, expectedRevision: revision,
          memberId: member.id, kind: form.kind,
          ...(form.model.trim().length > 0 ? { model: form.model.trim() } : {}),
          executable: normalizedExecutable,
          ...(form.permissionMode.length > 0 ? { permissionMode: form.permissionMode } : {}),
          ...(form.effort ? { effort: form.effort } : {}),
        });
        if (outcome.status !== 'ok') throw Error(outcome.status === 'unknown' ? `结果未知：${userFacingSystemText(outcome.error ?? '')}；原操作请求已保存，可在成员页重试` : `${outcome.code}：${userFacingSystemText(outcome.error ?? '')}`);
        if (!formGuard.valid()) return;
        configSaved = true;
        const modelName = form.model ? runtimeModelDisplayName({ id: form.model, label: form.model }) : '';
        recordWrite('member.setRuntime', `${member.displayName} → ${form.kind}${modelName ? `（${modelName}）` : ''}`);
      }
      // 头像与资料/配置一起保存。头像写失败不回滚已保存的内容——如实提示，别让用户以为整单都没存。
      if (avatarChanged) {
        try {
          await saveAvatar(memberSubject, avatar);
          recordWrite('app.appearance.set', `${member.displayName} 头像${avatar == null ? '已恢复默认' : '已更新'}`);
        } catch (avatarError) {
          toast(`已保存的内容不会丢，但头像未保存：${userFacingSystemText((avatarError as Error).message ?? '')}`, 'error');
        }
      }
      if (mounted.current) {
        const modelName = form.model ? runtimeModelDisplayName({ id: form.model, label: form.model }) : '';
        if (profileSaved && configSaved) toast(`已保存 ${nextName} 的资料与 AI 设置（${form.kind}${modelName ? ' · ' + modelName : ''}）`, 'success');
        else if (profileSaved) toast(`已保存成员名称与说明：${nextName}`, 'success');
        else if (configSaved) toast(`已保存 ${member.displayName} 的 AI 设置（${form.kind}${modelName ? ' · ' + modelName : ''}）`, 'success');
        else toast(`已更新 ${member.displayName} 的头像`, 'success');
        await onSaved();
      }
    } catch (e) {
      if (!formGuard.valid()) return;
      const failure = userFacingSystemText((e as Error).message ?? '');
      if (mounted.current) {
        // 部分成功必须如实分开说：资料已保存、配置没保存，弹窗保留且重试不会重复写资料。
        setSaveError(profileSaved ? `名称与说明已保存，但 AI 设置未保存：${failure}。弹窗保留；重试只补保存 AI 设置，不会重复保存资料。` : `保存失败：${failure}`);
      }
      toast(profileSaved ? `资料已保存，但 AI 设置未保存：${failure}` : `保存失败：${failure}`, 'error'); // 防护模式拒真实绑定等真实原因上屏
    } finally { savePending.current = false; if (mounted.current) setBusy(false); }
  };
  return (
    <Modal
      size="md"
      title={`AI 设置 · ${member.displayName}`}
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary sm" disabled={busy||formGuard.invalid||(allowProfileEdit&&nothingChanged)} title={allowProfileEdit&&nothingChanged ? '没有需要保存的修改' : undefined} data-zs-member-bindsave={member.id} onClick={() => void save()}>{busy ? '保存中…' : allowProfileEdit ? '保存' : '保存 AI 设置'}</button>
        </>
      }
    >
      <div className="col" style={{ gap: 10 }}>
        {formGuard.invalid?<div className="panel warning">目标已切换，本表单作废；请关闭后重新配置。</div>:null}
        {saveError != null ? <div className="panel warning">{userFacingSystemText(saveError ?? '')}。输入已保留，可调整后重试。</div> : null}
        {allowProfileEdit ? <>
          <label className="field"><span className="field-label">名称</span><input className="input" data-zs-member-name value={name} maxLength={60} disabled={busy} onChange={e => { setName(e.target.value); if (saveError != null) setSaveError(null); }}/></label>
          <label className="field"><span className="field-label">说明</span><textarea className="input" data-zs-member-description value={description} maxLength={200} disabled={busy} onChange={e => { setDescription(e.target.value); if (saveError != null) setSaveError(null); }}/></label>
          <div className="field-hint">名称 1–60 字，说明最多 200 字；保存时先更新资料，再保存下面的 AI 设置。</div>
        </> : null}
        <label className="field" title="选择本机已有的 AI 渠道">
          <span className="field-label">渠道</span>
          <Select
            value={form.kind}
            ariaLabel="runtime 渠道"
            disabled={busy}
            onChange={(v) => setForm((f) => ({ ...f, kind: v as typeof f.kind,model:'',executable:runtimeExecutable(v),effort:'' }))}
            options={[
              ...RUNTIME_CHANNELS,
              ...(guard?.fakeAllowed === true ? [{ value: 'fake', label: 'fake（仅演练环境）' }] : []),
            ]}
          />
        </label>
        <RuntimeChannelHelp kind={form.kind}/>
        {form.kind!=='fake'?<RuntimeModel projectId={projectId} kind={form.kind} executable={form.executable} value={form.model} disabled={busy} onChange={model=>setForm(f=>({...f,model,effort:''}))}/>:null}
        <RuntimeEffort projectId={projectId} kind={form.kind} model={form.model} executable={form.executable} value={form.effort??''} onChange={effort=>setForm(f=>({...f,effort}))}/>
        <AvatarPicker
          value={avatar}
          disabled={busy}
          onChange={setAvatar}
        />
        <details><summary>高级：执行程序与权限</summary>
        <label className="field"><span className="field-label">执行程序（自动查找）</span><input className="input" placeholder="留空使用本机 CLI" value={form.executable} onChange={e=>setForm(f=>({...f,executable:e.target.value}))}/></label>
        <label className="field" title="只影响之后新建的任务；已有任务保持原权限">
          <span className="field-label">保存的权限模式</span>
          <Select
            value={form.permissionMode}
            ariaLabel="权限模式"
            onChange={(v) => setForm((f) => ({ ...f, permissionMode: v }))}
            options={runtimePermissionOptions(form.permissionMode, form.kind)}
          />
          <div className="field-hint">{runtimePermissionHint(form.kind)}</div>
        </label>
        </details>
      </div>
    </Modal>
  );
}
