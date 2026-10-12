/**
 * 项目主页 / 欢迎页 / 打开文件夹弹窗（R65 原型还原·pages-secondary 同源）：
 * 数据=真实注册表（project.list）与已装载房间/成员/任务；打开文件夹=真实 pickFolder+
 * project.open（注册幂等·合并不替换）；最近项目卡片点击=焦点切换（不重开目录）。
 * 目录失效卡给「重新定位」（project.lifecycle relocate——保留 projectId/历史）。
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, Modal, Tag, TaskStatusTag, Avatar, memberColor } from '../components/ui';
import { useStore, toast } from '../shell';
import { coordinatorOfRoom, memberLabel, roomsOfProject } from '../data/selectors';
import { switchFocusProject, projectLifecycleReal, openProjectByPath } from '../loader';
import { command } from '../bridge';
import { refreshGitState } from '../data/actions-git';
import type { TaskStatus } from '../data/types';
import { relTime } from '../lib/format';
import { navigate, currentNavSeq } from '../lib/router';
import { beginUserNavIntent, cancelNavIntent, navIntentActive, releaseNavIntent, type NavIntent } from '../lib/navIntent';
import { CreateRoomModal } from './Room';

/* ============================================================
   打开文件夹（真实：pickFolder → project.open 注册/幂等重开）
   ============================================================ */

export function OpenFolderModal({ onClose, autoPick = false }: { onClose: () => void; autoPick?: boolean }) {
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [pickReason, setPickReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operation = useRef<NavIntent | null>(null);
  const pickerSeq = useRef(0);
  const mounted = useRef(true);
  const cancelOpen = () => {
    pickerSeq.current += 1;
    if (operation.current != null) { cancelNavIntent(operation.current); releaseNavIntent(operation.current); operation.current = null; }
  };
  const close = () => { cancelOpen(); onClose(); };

  const doPick = async () => {
    const seq = ++pickerSeq.current;
    const urlSeq = currentNavSeq();
    const { bridge } = await import('../bridge');
    const dir = await bridge().pickFolder();
    if (!mounted.current || pickerSeq.current !== seq || currentNavSeq() !== urlSeq) return;
    if (dir != null && dir.length > 0) { setPickedPath(dir); setPickReason(null); return; }
    setPickReason(dir == null ? '已取消选择。' : '当前宿主没有系统目录选择器。');
  };
  useEffect(() => {
    mounted.current = true;
    if (autoPick) void doPick();
    return () => { mounted.current = false; cancelOpen(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = async () => {
    if (pickedPath == null || operation.current != null) return;
    const intent = beginUserNavIntent();
    operation.current = intent;
    setBusy(true);
    try {
      // R75（review-r74 §P1）：落位按**本次打开目标**（返回 id）——不读异步结束时的
      // activeProjectId（旧房间路由/其它装载可能已改写它）。取消/被取代时 id=''：不落位。
      const opened = await openProjectByPath(pickedPath, { intent, navigateToRoom: true });
      if (!mounted.current || operation.current !== intent || !opened.isCurrent()) return;
      onClose();
    } catch (e) {
      if (mounted.current && operation.current === intent && navIntentActive(intent)) {
        toast(`打开项目失败：${(e as Error).message}（选择保留，可重试或换目录）`, 'error');
      }
    } finally {
      releaseNavIntent(intent);
      if (operation.current === intent) { operation.current = null; if (mounted.current) setBusy(false); }
    }
  };

  return (
    <Modal
      size="sm"
      title="打开文件夹"
      subtitle="选择一个本地目录作为项目（已打开过则幂等重开——不会重复注册）"
      onClose={close}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={close}>取消</button>
          <button className="btn primary" disabled={busy} onClick={pickedPath != null ? () => void open() : () => void doPick()}>
            <Icon name="folder" size={12} />
            {pickedPath != null ? (busy ? '正在打开…' : '打开这个目录') : '浏览…'}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label">目录路径</label>
        <div className="row wrap" style={{ gap: 8 }}>
          <input className="input mono" style={{ flex: '1 1 260px' }} value={pickedPath ?? ''} readOnly placeholder="点「浏览…」调用系统目录选择器" />
          <button className="btn" disabled={busy} onClick={() => void doPick()}><Icon name="folder" size={12} /> 浏览…</button>
        </div>
        {pickReason != null ? <div className="panel warning" style={{ marginTop: 8 }}>{pickReason}</div> : null}
        <div className="field-hint">
          打开后自动创建默认房间与执行成员；不写项目目录配置文件、不自动 git init、不自动调用模型。
          再次打开同一目录按目录身份幂等识别（不产生第二个项目）。
        </div>
      </div>
      <div className="panel success">
        <div className="panel-title"><Icon name="check-circle" size={13} /> 正在桌面客户端中运行</div>
        「浏览…」调起系统目录选择器；选定后解析目录身份用于识别重复打开与移动后重新定位。
        打开失败（目录无效等）会如实报错并保留你的选择。
      </div>
    </Modal>
  );
}

/* ============================================================
   欢迎页（真实注册表最近项目 + 打开文件夹）
   ============================================================ */

export function WelcomePage() {
  const s = useStore((x) => x);
  const [openFolder, setOpenFolder] = useState(false);
  return (
    <div className="main" data-zs-welcome="hifi">
      <div className="page narrow">
        <div style={{ textAlign: 'center', padding: '38px 0 26px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
            <span className="brand-mark" style={{ width: 46, height: 46, fontSize: 22, borderRadius: 12 }}>众</span>
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em' }}>打开一个本地文件夹，让多个 agent 在这里协作</h1>
          <p className="muted" style={{ marginTop: 10, fontSize: 13, maxWidth: '62ch', marginInline: 'auto', lineHeight: 1.75 }}>
            不需要复制路径、不需要开多个终端、不需要手动转发报告。每次协作都有明确的参与者、执行状态、文件依据和最终成果。
          </p>
          <div className="row" style={{ justifyContent: 'center', marginTop: 18, gap: 10 }}>
            <button className="btn primary lg" onClick={() => setOpenFolder(true)}>
              <Icon name="folder" size={14} /> 打开文件夹
            </button>
          </div>
        </div>

        <div className="section-title">最近项目<span className="count">{s.projects.filter((p) => !p.removedAt).length}</span></div>
        {s.projects.filter((p) => !p.removedAt).length === 0 ? (
          <div className="panel">还没有注册的项目——点上面「打开文件夹」选择一个目录开始。</div>
        ) : (
          <div className="grid grid-auto">
            {s.projects.filter((p) => !p.removedAt).map((p) => {
              const rooms = roomsOfProject(s, p.id);
              return (
                <div
                  key={p.id}
                  className="card"
                  style={{ cursor: p.status === 'missing' ? 'default' : 'pointer' }}
                  onClick={() => {
                    if (p.status === 'missing') return;
                    void switchFocusProject(p.id).then((ok) => {
                      if (!ok) { toast('项目不可用（未注册？）——重新打开', 'error'); return; }
                      const first = rooms.find((r) => !r.archivedAt);
                      navigate(first != null ? `/project/${p.id}/room/${first.id}` : `/project/${p.id}`);
                    });
                  }}
                >
                  <div className="row tight">
                    <Icon name={p.status === 'missing' ? 'alert-triangle' : p.isGit ? 'git-branch' : 'folder'} size={15} className={p.status === 'missing' ? '' : 'faint'} />
                    <span className="strong">{p.displayName}</span>
                    {p.archivedAt != null ? <Tag tone="neutral" icon="archive">已归档</Tag> : null}
                    <div className="spacer" />
                  </div>
                  <div className="mono-sm" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>{p.rootPath}</div>
                  <div className="row tight wrap" style={{ marginTop: 9 }}>
                    {p.status === 'missing' ? (
                      <Tag tone="danger" icon="alert-triangle">目录失效 · 需重新定位</Tag>
                    ) : (
                      <>
                        <Tag plain icon="hash">{rooms.length} 房间</Tag>
                        <Tag plain icon="activity">打开后查看任务</Tag>
                        {p.isGit ? <Tag plain icon="git-branch">Git</Tag> : null}
                      </>
                    )}
                  </div>
                  {p.status === 'missing' ? (
                    <div className="panel-actions" style={{ marginTop: 10 }}>
                      <RelocateButton projectId={p.id} />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        <div className="panel" style={{ marginTop: 20 }}>
          <div className="panel-title"><Icon name="info" size={13} /> 关于项目边界</div>
          一个本地目录就是一个项目；同一物理目录重复打开按目录身份幂等识别。同一目录同时只有一个受管理写入者（单写者锁域）。
        </div>
      </div>
      {openFolder ? <OpenFolderModal onClose={() => setOpenFolder(false)} /> : null}
    </div>
  );
}

/** 重新定位（目录失效后）：真实 project.lifecycle relocate——threadId/任务号/成果引用不变。 */
export function RelocateButton({ projectId }: { projectId: string }) {
  const s = useStore((x) => x);
  const [busy, setBusy] = useState(false);
  const p = s.projects.find((x) => x.id === projectId);
  return (
    <button
      className="btn sm"
      disabled={busy}
      onClick={() => {
        void (async () => {
          const { bridge } = await import('../bridge');
          const d = await bridge().pickFolder();
          if (d == null || d.length === 0) { toast('已取消重新定位', 'info'); return; }
          setBusy(true);
          const r = await projectLifecycleReal(projectId, p?.revision ?? 0, 'relocate', d);
          setBusy(false);
          if (r.ok) toast('已重新定位（projectId 与历史保持不变）', 'success');
          else toast(`重新定位失败：${r.error}`, 'error');
        })();
      }}
    >
      <Icon name="refresh" size={12} /> 重新定位
    </button>
  );
}

/* ============================================================
   项目主页（§17.2：房间/成员/活跃任务概览 + 新建房间 + 文件与改动入口）
   ============================================================ */

export function ProjectHomePage({ projectId }: { projectId: string }) {
  const s = useStore((x) => x);
  const activeId = useStore((x) => x.activeProjectId);
  const openTarget = useStore((x) => x.openInFlightTarget);
  useEffect(() => {
    // 深链/直开项目主页=聚焦该项目（原型语义：项目页上下文即该项目；已聚焦则不重复刷新）。
    // R75（review-r74 §P1）：在途用户打开的落位目标≠本页项目且 URL 自打开发起未再变——
    // 本页是**打开前的陈旧路由**，不抢焦点（打开动作自身按目标落位）；用户其后主动导航
    // 过（代次前进）或目标正是本页项目 → 照常聚焦。
    if (activeId !== projectId) {
      if (openTarget != null && openTarget.projectId !== projectId && openTarget.urlSeqAtStart >= currentNavSeq()) return;
      void switchFocusProject(projectId);
    }
  }, [projectId, activeId, openTarget]);
  // R68（与 DmPage 同判）：重载/偏好恢复后 activeProjectId 已=本项目时 switchFocusProject
  // 早退——房间/成员投影无人装载，页面会停在空态。挂载即补一次轻量装载。
  useEffect(() => {
    if (activeId !== projectId) return;
    void import('../loader').then((m) => { m.refreshRooms(projectId).catch(() => { /* 下次进入重试 */ }); m.refreshMembers(projectId).catch(() => { /* 同上 */ }); });
  }, [projectId, activeId]);
  type ActiveTask = { id: string; projectId: string; roomId: string; threadId: string | null; roomTaskNumber: number | null; status: TaskStatus; title: string };
  const [boardTasks, setBoardTasks] = useState<{ projectId: string; items: ActiveTask[] } | null>(null);
  const [boardError, setBoardError] = useState<{ projectId: string; message: string } | null>(null);
  const refreshBoard = useRef<() => void>(() => {});
  useEffect(() => {
    let current = true;
    let seq = 0;
    let inFlight = false;
    const load = () => {
      if (inFlight) return; // 慢读期间合并定时/手动刷新，避免每 10 秒作废上一条而永远不落事实。
      inFlight = true;
      const request = ++seq;
      void command<{ groups: Array<{ rooms: Array<{ cards: Array<{ taskId: string; projectId: string; roomId: string; threadId: string | null; roomTaskNumber: number | null; taskStatus: string; title: string }> }> }> }>('board.view', { scope: 'project', projectId })
        .then((response) => {
          if (!current || request !== seq) return;
          const active = response.groups.flatMap((g) => g.rooms.flatMap((r) => r.cards)).filter((c) => ['ACTIVE', 'WAITING_USER', 'BLOCKED', 'REVIEW'].includes(c.taskStatus));
          setBoardTasks({ projectId, items: active.map((c) => ({ id: c.taskId, projectId: c.projectId, roomId: c.roomId, threadId: c.threadId, roomTaskNumber: c.roomTaskNumber, status: c.taskStatus as TaskStatus, title: c.title })) });
          setBoardError(null);
        })
        .catch((e: unknown) => { if (current && request === seq) setBoardError({ projectId, message: (e as Error).message }); })
        .finally(() => { if (current && request === seq) inFlight = false; });
    };
    refreshBoard.current = load;
    load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') load(); }, 10_000);
    return () => { current = false; seq += 1; window.clearInterval(timer); };
  }, [projectId]);
  useEffect(() => { void refreshGitState(projectId); }, [projectId]);
  const p = s.projects.find((x) => x.id === projectId);
  const rooms = roomsOfProject(s, projectId);
  const members = s.members.filter((m) => m.projectId === projectId);
  const tasks = boardTasks?.projectId === projectId ? boardTasks.items : null;
  const taskError = boardError?.projectId === projectId ? boardError.message : null;
  const [createRoom, setCreateRoom] = useState(false);

  if (p == null) {
    return (
      <div className="main"><div className="page">
        <ErrorState code="PROJECT_NOT_FOUND" detail={`项目不存在或不可访问：${projectId}。不回退到其它项目。`} />
      </div></div>
    );
  }
  if (p.status === 'missing') {
    return (
      <div className="main">
        <div className="page narrow">
          <div className="page-head">
            <div>
              <div className="page-title">{p.displayName}</div>
              <div className="page-sub mono">{p.rootPath}</div>
            </div>
          </div>
          <ErrorState
            code="PROJECT_MISSING"
            detail="磁盘上找不到这个目录。历史任务、成果与报告都还在，重新定位会保留原 projectId。"
            actions={<RelocateButton projectId={p.id} />}
          />
          <div className="panel" style={{ marginTop: 14 }}>
            不会因为在错误目录运行而丢数据：定位失败时保持暂停派发；重新定位后所有 threadId、任务号与成果引用保持不变。
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="main">
      <div className="page">
        <div className="page-head">
          <div>
            <div className="row tight wrap">
              {s.git[projectId]?.notARepo === true ? <Tag plain icon="folder">普通目录</Tag> : p.isGit ? <Tag plain icon="git-branch">Git 仓库</Tag> : <Tag plain icon="folder">目录类型读取中…</Tag>}
              <Tag plain icon="layers">{rooms.length} 个房间</Tag>
              <Tag plain icon="users">{members.length} 名成员</Tag>
              <Tag plain icon="activity">{tasks?.length ?? '…'} 个活跃任务</Tag>
            </div>
          </div>
          <div className="page-head-actions">
            <button className="btn primary sm" onClick={() => setCreateRoom(true)}>
              <Icon name="plus" size={12} /> 新建房间
            </button>
            <button className="btn sm" onClick={() => navigate(`/project/${projectId}/files`)}>
              <Icon name="diff" size={12} /> 文件与改动
            </button>
          </div>
        </div>

        <div className="grid grid-2">
          <div>
            <div className="section-title">房间<span className="count">{rooms.length}</span></div>
            {rooms.length === 0 ? <EmptyState icon="hash" title="还没有房间" detail="点右上「新建房间」创建第一个对话池。" /> : rooms.map((r) => {
              const coord = coordinatorOfRoom(s, r);
              return (
                <div key={r.id} className="card tight" style={{ marginBottom: 8, cursor: 'pointer' }} onClick={() => navigate(`/project/${projectId}/room/${r.id}`)}>
                  <div className="row tight">
                    <Icon name={r.archivedAt ? 'archive' : 'hash'} size={14} className="faint" />
                    <span className="strong">{r.name}</span>
                    {r.archivedAt ? <Tag tone="neutral" icon="archive">已归档</Tag> : null}
                    <div className="spacer" />
                    <Icon name="chevron-right" size={13} className="faint" />
                  </div>
                  <div className="row tight wrap small faint" style={{ marginTop: 6 }}>
                    <span>协调者 {coord != null ? memberLabel(coord) : '（未设置——首个成员接单）'}</span>
                    <span>· {r.memberIds.length} 名成员</span>
                  </div>
                </div>
              );
            })}
          </div>

          <div>
            <div className="section-title">活跃任务<span className="count">{tasks?.length ?? '…'}</span><button className="btn ghost sm" onClick={() => refreshBoard.current()}>刷新</button></div>
            {taskError != null ? <div className="panel warning">任务概况读取失败：{taskError}（保留本项目上次已确认的任务列表，可刷新重试）</div> : null}
            {tasks == null && taskError == null ? <div className="panel info">正在读取本项目任务概况…</div> : tasks != null && tasks.length === 0 ? (
              <div className="panel">当前没有活跃任务。房间里的任务看板会保留已完成与已取消的记录。</div>
            ) : tasks != null ? (
              tasks.map((t) => (
                <div
                  key={t.id}
                  className="card tight"
                  style={{ marginBottom: 8, cursor: 'pointer' }}
                  onClick={() => { if (t.threadId == null) { toast('任务无线程定位信息；请从任务看板查看', 'warn'); return; } navigate(`/project/${t.projectId}/room/${t.roomId}?thread=${t.threadId}&tab=task`); }}
                >
                  <div className="row tight wrap">
                    {t.roomTaskNumber != null ? <span className="root-task-no">#{t.roomTaskNumber}</span> : null}
                    <TaskStatusTag status={t.status} />
                    <div className="spacer" />
                  </div>
                  <div className="strong" style={{ marginTop: 5, fontSize: 12.5 }}>{t.title || '（标题未装载——进线程查看）'}</div>
                </div>
              ))
            ) : null}

            <div className="section-title" style={{ marginTop: 18 }}>成员<span className="count">{members.length}</span></div>
            {members.map((m) => (
              <div key={m.id} className="member-row" onClick={() => navigate(projectId !== '' ? `/project/${projectId}/members` : '/members')}>
                <Avatar name={m.displayName} color={memberColor(m.id)} size={22} />
                <span className="member-row-name">{memberLabel(m)}</span>
                <span className="member-row-state">{m.model || ''}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      {createRoom ? <CreateRoomModal projectId={projectId} onClose={() => setCreateRoom(false)} /> : null}
    </div>
  );
}
