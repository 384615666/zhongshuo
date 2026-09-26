/**
 * 欢迎页 / 项目主页 / 待我处理 / 收藏与搜索
 * 依据 §17.2 页面清单，含各自的空状态与失败状态。
 */

import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { Avatar, EmptyState, ErrorState, Modal, Switch, Tag, TaskStatusTag, memberColor } from '../components/ui';
import { useStore, toast } from '../data/store';
import {
  activeTasksOfProject, byId, coordinatorOfRoom, memberLabel,
  projectUnread, roomsOfProject,
} from '../data/selectors';
import { createReminder, openProjectAt, relocateProject, saveMessage, toggleReminder } from '../data/actions';
import { focusProject } from '../data/actions-nav';
import { isDesktop, pickDirectory } from '../lib/desktop';
import { fullTime, relTime, stageLabel } from '../lib/format';
import { navigate } from '../lib/router';
import { NewRoomButton } from './Room';

/* ============================================================
   欢迎页（§17.2：打开文件夹、最近项目；没有 CLI 时显示连接配置入口）
   ============================================================ */

/**
 * 「打开文件夹」流程 —— 欢迎页按钮、顶栏项目管理菜单、空态入口**共用同一个组件**。
 *
 * 为什么抽出来并且默认 `autoPick`：入口文案写的是"打开文件夹"，用户点下去就应该
 * **直接看到系统目录选择器**。原来顶栏菜单项只做了 `navigate('/welcome')`，用户到了
 * 欢迎页还得再点一次「打开文件夹」才弹对话框 —— 用户实测点名为"多此一举"。
 * 现在凡"点了就该弹系统对话框"的入口（顶栏项目菜单、空态、项目缺失页）挂载即调起选择器
 * —— 用户取消也不会连弹第二次，取消后在弹窗里可以重选。
 */
export function OpenFolderModal({ onClose, autoPick = false }: { onClose: () => void; autoPick?: boolean }) {
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [pickReason, setPickReason] = useState<string | null>(null);
  const desktopHost = isDesktop();

  /** 走原生目录选择器；浏览器宿主会返回原因而不是假装成功（§8.2） */
  const doPick = async () => {
    const res = await pickDirectory();
    if (res.path) {
      setPickedPath(res.path);
      setPickReason(null);
      return;
    }
    setPickReason(res.reason ?? '已取消。');
  };

  // 只自动调起一次：之后由「浏览…」手动重选，避免反复弹出对话框
  useEffect(() => {
    if (autoPick) void doPick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal
      size="sm"
      title="打开文件夹"
      subtitle="选择一个本地目录作为项目"
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            onClick={async () => {
              if (pickedPath) {
                // 已选到真实路径：登记为项目
                onClose();
                toast(`已选择 ${pickedPath}。原型不实际扫描磁盘：真实版本会解析目录身份（卷/文件 ID、junction）并建立索引`, 'success');
                return;
              }
              await doPick();
            }}
          >
            <Icon name="folder" size={12} />
            {pickedPath ? '打开这个目录' : '浏览…'}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label">目录路径</label>
        <div className="row wrap" style={{ gap: 8 }}>
          <input
            className="input mono"
            style={{ flex: '1 1 260px' }}
            value={pickedPath ?? ''}
            readOnly
            placeholder={desktopHost ? '点「浏览…」调用系统目录选择器' : '浏览器宿主无法打开本地目录'}
          />
          <button className="btn" onClick={doPick}>
            <Icon name="folder" size={12} /> 浏览…
          </button>
        </div>
        {pickReason ? (
          <div className="panel warning" style={{ marginTop: 8 }}>{pickReason}</div>
        ) : null}
        <div className="field-hint">
          打开后自动创建默认房间与隐式空间，不要求注册云端账号。不会向项目目录写入任何配置文件，
          也不会自动 git init。
        </div>
      </div>

      <div className={`panel ${desktopHost ? 'success' : 'warning'}`}>
        <div className="panel-title">
          <Icon name={desktopHost ? 'check-circle' : 'info'} size={13} />
          {desktopHost ? '正在桌面客户端中运行' : '正在浏览器宿主中运行'}
        </div>
        {desktopHost ? (
          <>
            「浏览…」会调起 Windows 原生目录选择对话框（Electron 的 dialog.showOpenDialog）。
            选定后会解析 junction、符号链接、盘符与大小写规则来确定目录身份，
            用于识别"再次打开同一目录"与"移动后重新定位"。
          </>
        ) : (
          <>
            浏览器里没有原生目录选择器，也没有托盘与窗口控制。桌面客户端（Electron）才有这些能力；
            浏览器入口用于查看与操作已有项目。启动桌面客户端：<code>pnpm run desktop</code>
          </>
        )}
      </div>
    </Modal>
  );
}

export function WelcomePage() {
  const s = useStore((x) => x);
  const [openFolder, setOpenFolder] = useState(false);
  const runtimes = s.runtimeInstallations;
  const notReady = runtimes.filter((r) => r.health !== 'ready');

  return (
    <div className="main">
      <div className="page narrow">
        <div style={{ textAlign: 'center', padding: '38px 0 26px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
            <span className="brand-mark" style={{ width: 46, height: 46, fontSize: 22, borderRadius: 12 }}>众</span>
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em' }}>
            打开一个本地文件夹，让多个 agent 在这里协作
          </h1>
          <p className="muted" style={{ marginTop: 10, fontSize: 13, maxWidth: '62ch', marginInline: 'auto', lineHeight: 1.75 }}>
            不需要复制路径、不需要开多个终端、不需要手动转发报告。每次协作都有明确的参与者、执行状态、文件依据和最终成果。
          </p>
          <div className="row" style={{ justifyContent: 'center', marginTop: 18, gap: 10 }}>
            {/* 点下去直接调起系统目录选择器（autoPick），不再先弹一层"浏览…"的中间步 */}
            <button className="btn primary lg" onClick={() => setOpenFolder(true)}>
              <Icon name="folder" size={14} /> 打开文件夹
            </button>
            {/* 「进入当前项目」已按用户要求删除（2026-09-26）：
                欢迎页只回答"打开一个本地文件夹"；要回项目走侧栏或下面的最近项目卡片，
                这两处本来就是常驻入口，不必在这里再放一个按钮。 */}
          </div>
        </div>

        {notReady.length > 0 ? (
          <div className="panel warning" style={{ marginBottom: 18 }}>
            <div className="panel-title"><Icon name="alert-triangle" size={13} /> 有 runtime 尚未就绪</div>
            {notReady.map((r) => (
              <div key={r.id} className="row tight" style={{ marginTop: 4 }}>
                <span className="strong">{r.label}</span>
                <Tag tone={r.health === 'not_installed' ? 'danger' : r.health === 'not_logged_in' ? 'warning' : 'neutral'} icon={r.health === 'not_installed' ? 'x-circle' : 'help-circle'}>
                  {r.health === 'not_installed' ? '未安装' : r.health === 'not_logged_in' ? '未登录' : r.health === 'incompatible' ? '版本不兼容' : '未验证'}
                </Tag>
              </div>
            ))}
            <div className="panel-actions">
              <button className="btn sm" onClick={() => navigate('/runtimes')}>
                <Icon name="settings" size={12} /> 连接配置
              </button>
            </div>
            <div className="small faint" style={{ marginTop: 6 }}>
              注册 CLI 不代表自动启动登录或消耗额度；首次验证调用由你主动发送任务或点击连接测试触发。
            </div>
          </div>
        ) : null}

        <div className="section-title">最近项目<span className="count">{s.projects.length}</span></div>
        <div className="grid grid-auto">
          {s.projects.map((p) => {
            const unread = projectUnread(s, p.id);
            const rooms = roomsOfProject(s, p.id);
            const active = activeTasksOfProject(s, p.id).length;
            return (
              <div
                key={p.id}
                className="card"
                style={{ cursor: p.status === 'missing' ? 'default' : 'pointer' }}
                onClick={() => {
                  if (p.status === 'missing') return;
                  openProjectAt(p.id);
                  const first = rooms.find((r) => !r.archivedAt);
                  navigate(first ? `/project/${p.id}/room/${first.id}` : `/project/${p.id}`);
                }}
              >
                <div className="row tight">
                  <Icon name={p.status === 'missing' ? 'alert-triangle' : p.isGit ? 'git-branch' : 'folder'} size={15} className={p.status === 'missing' ? '' : 'faint'} />
                  <span className="strong">{p.displayName}</span>
                  <div className="spacer" />
                  {unread > 0 ? <Tag tone="info" icon="message-square">{unread}</Tag> : null}
                </div>
                <div className="mono-sm" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>{p.rootPath}</div>
                <div className="row tight wrap" style={{ marginTop: 9 }}>
                  {p.status === 'missing' ? (
                    <Tag tone="danger" icon="alert-triangle">目录失效 · 需重新定位</Tag>
                  ) : (
                    <>
                      <Tag plain icon="hash">{rooms.length} 房间</Tag>
                      <Tag plain icon="activity">{active} 活跃任务</Tag>
                      {p.isGit ? <Tag plain icon="git-branch">{p.gitBranch}</Tag> : null}
                    </>
                  )}
                </div>
                {p.status === 'missing' ? (
                  <div className="panel-actions" style={{ marginTop: 10 }}>
                    <button
                      className="btn sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        relocateProject(p.id, 'D:\\archive\\legacy-docs-moved');
                      }}
                    >
                      <Icon name="refresh" size={12} /> 重新定位
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="panel" style={{ marginTop: 20 }}>
          <div className="panel-title"><Icon name="info" size={13} /> 关于项目边界</div>
          一个本地目录就是一个项目（完整目标支持多根与项目切换，v0.1 即支持切换）。
          同一物理目录可被不同房间打开，但会被识别为同一锁域——同目录最多 1 个受管理写入者。
          原型不写盘：这里的"打开文件夹"不会真的读取磁盘。
        </div>
      </div>

      {/* 打开文件夹弹窗（与顶栏项目菜单、空态入口共用同一个组件）。
          这里**不**自动调起系统选择器：欢迎页本身就是"打开文件夹"的自述页面，
          先给用户看路径框与边界说明，再由他点「浏览…」；
          顶栏菜单那种"点了就该弹系统对话框"的入口才用 autoPick。 */}
      {openFolder ? <OpenFolderModal onClose={() => setOpenFolder(false)} /> : null}
    </div>
  );
}

/* ============================================================
   项目主页（§17.2：默认房间、成员、活跃任务；目录失效显示重新定位）
   ============================================================ */

export function ProjectHomePage({ projectId }: { projectId: string }) {
  const s = useStore((x) => x);
  const p = s.projects.find((x) => x.id === projectId);
  const rooms = roomsOfProject(s, projectId);
  const members = s.members.filter((m) => m.projectId === projectId);
  const tasks = activeTasksOfProject(s, projectId);

  if (!p) return <div className="main"><div className="page"><ErrorState code="PROJECT_MISSING" /></div></div>;

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
            actions={
              <button className="btn primary sm" onClick={() => relocateProject(p.id, 'D:\\archive\\legacy-docs-moved')}>
                <Icon name="refresh" size={12} /> 重新定位项目目录
              </button>
            }
          />
          <div className="panel" style={{ marginTop: 14 }}>
            不会因为在错误目录运行而丢数据：定位失败时保持暂停派发，等你确认新路径。
            重新定位后所有 threadId、任务号与成果引用保持不变。
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="main">
      <div className="page">
        <div className="page-head">
          {/* 项目名与路径已按用户要求删除（2026-09-26）：顶栏一直显示当前项目名，
              路径在「文件与 Git」「项目设置」里都有。这里保留的是**只有这一页才有的**概览标签与操作。 */}
          <div>
            <div className="row tight wrap">
              {p.isGit ? <Tag plain icon="git-branch">{p.gitBranch}</Tag> : <Tag plain icon="folder">普通目录</Tag>}
              <Tag plain icon="layers">{rooms.length} 个房间</Tag>
              <Tag plain icon="users">{members.length} 名成员</Tag>
              <Tag plain icon="activity">{tasks.length} 个活跃任务</Tag>
              <span className="small faint">projectId {p.id} · revision {p.revision}</span>
            </div>
          </div>
          <div className="page-head-actions">
            <NewRoomButton projectId={projectId} />
            <button className="btn sm" onClick={() => navigate(`/project/${projectId}/changes`)}>
              <Icon name="diff" size={12} /> 文件与改动
            </button>
          </div>
        </div>

        <div className="grid grid-2">
          <div>
            <div className="section-title">房间<span className="count">{rooms.length}</span></div>
            {rooms.map((r) => {
              const coord = coordinatorOfRoom(s, r);
              return (
                <div
                  key={r.id}
                  className="card tight"
                  style={{ marginBottom: 8, cursor: 'pointer' }}
                  onClick={() => navigate(`/project/${projectId}/room/${r.id}`)}
                >
                  <div className="row tight">
                    <Icon name={r.archivedAt ? 'archive' : 'hash'} size={14} className="faint" />
                    <span className="strong">{r.name}</span>
                    {r.archivedAt ? <Tag tone="neutral" icon="archive">已归档</Tag> : null}
                    <div className="spacer" />
                    <Icon name="chevron-right" size={13} className="faint" />
                  </div>
                  <div className="small muted" style={{ marginTop: 3 }}>{r.description}</div>
                  <div className="row tight wrap small faint" style={{ marginTop: 6 }}>
                    <span>协调者 {memberLabel(coord)}</span>
                    <span>· {r.memberIds.length} 名成员</span>
                  </div>
                </div>
              );
            })}
          </div>

          <div>
            <div className="section-title">活跃任务<span className="count">{tasks.length}</span></div>
            {tasks.length === 0 ? (
              <div className="panel">当前没有活跃任务。房间里的任务看板会保留已完成与已取消的记录。</div>
            ) : (
              tasks.map((t) => {
                const run = s.runs.find((r) => r.taskId === t.id);
                return (
                  <div
                    key={t.id}
                    className="card tight"
                    style={{ marginBottom: 8, cursor: 'pointer' }}
                    onClick={() => navigate(`/project/${t.projectId}/room/${t.roomId}?thread=${t.conversationThreadId}&tab=task`)}
                  >
                    <div className="row tight wrap">
                      <span className="root-task-no">#{t.roomTaskNumber}</span>
                      <TaskStatusTag status={t.status} />
                      {/* 显示阶段的中文名，不要裸露 ISSUE_DISCUSSION 这类内部枚举 */}
                      {run ? <Tag plain icon="layers">{stageLabel(run.stage)}</Tag> : null}
                      <div className="spacer" />
                      <span className="small faint">{relTime(Date.now() - t.revision * 3_600_000)}</span>
                    </div>
                    <div className="strong" style={{ marginTop: 5, fontSize: 12.5 }}>{t.title}</div>
                    <div className="small faint clamp-2" style={{ marginTop: 3 }}>{t.objective}</div>
                  </div>
                );
              })
            )}

            <div className="section-title" style={{ marginTop: 18 }}>成员<span className="count">{members.length}</span></div>
            {members.map((m) => (
              <div key={m.id} className="member-row" onClick={() => navigate(`/member/${m.id}`)}>
                <Avatar name={m.displayName} ordinal={m.ordinal} color={memberColor(m.id, m.ordinal)} size={22} state={m.workState} stateTitle={m.workStateReason} />
                <span className="member-row-name">{memberLabel(m)}</span>
                <span className="member-row-state">{m.model}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   待我处理（§25.4）：人的注意力管理
   ============================================================ */

export function ActivityPage() {
  const s = useStore((x) => x);
  const [filter, setFilter] = useState<'action' | 'all' | 'unread' | 'mentions'>('action');

  const items = useMemo(() => {
    const all = [...s.attention].sort((a, b) => b.createdAt - a.createdAt);
    // 「需要我处理」只应含"需要动作且尚未处理"的项。
    // 原实现只看 requiresAction、忽略 readAt —— 授权处理完仍挂在待办里出不去。
    if (filter === 'action') return all.filter((a) => a.requiresAction && !a.readAt);
    if (filter === 'unread') return all.filter((a) => !a.readAt);
    if (filter === 'mentions') return all.filter((a) => a.kind === 'mention');
    return all;
  }, [s.attention, filter]);

  const actionCount = s.attention.filter((a) => a.requiresAction && !a.readAt).length;
  const writeLog = s.ui.writeLog;

  return (
    <div className="main">
      <div className="page">
        {/* 页头（「待我处理」+ 一段说明）已按用户要求删除（2026-09-26）。
            这一段里真正有用的两条信息留下了：**范围**（下面是范围标签）与**筛选**（右侧分段控件）——
            其余解释性文字（"不复制一份可以另行回复的新会话"）属于文档语气。 */}
        <div className="page-head">
          <div>
            <div className="row tight wrap">
              {/*
                §17.7「底部范围固定」：待我处理**默认汇总当前用户全部可访问项目**，
                即使项目被隐藏也不算丢，页头必须写明范围、卡片必须标来源 ——
                否则用户无法判断"这里没显示"是因为没有，还是被筛掉了。
              */}
              <Tag plain icon="layers">范围：全部可访问项目（{s.projects.length}）</Tag>
              <Tag plain icon="eye-off">
                侧栏隐藏的项目也计入；隐藏只收起导航，不停止任务、不清待办
              </Tag>
            </div>
          </div>
          <div className="page-head-actions">
            <div className="seg">
              {([
                ['action', `需要我处理 ${actionCount}`],
                ['all', '全部动态'],
                ['unread', '未读'],
                ['mentions', '提及'],
              ] as const).map(([k, label]) => (
                <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {items.length === 0 ? (
          <EmptyState
            icon="check-circle"
            title="没有需要你处理的事情"
            detail="打开项目不会消费 agent 队列；这里安静意味着确实没有待办，而不是漏了通知。"
          />
        ) : (
          <div className="col" style={{ gap: 8 }}>
            {items.map((a) => {
              /*
               * v1.12 §10.5：交付待办必须深链携带 taskId + deliveryId + revision。
               * 只带 threadId 会让用户落到线程后不知道该看哪个交付版本，
               * 也拿不到版本号去做"旧版本按钮不批准新结果"的校验。
               * 权限请求（approval）与阻塞项保持各自独立，不混进交付队列。
               */
              const target =
                a.kind === 'review' && a.deliveryId
                  ? `/project/${a.projectId}/room/${a.roomId}?thread=${a.threadId}&tab=delivery`
                  : `/project/${a.projectId}/room/${a.roomId}?thread=${a.threadId}`;
              const srcProject = s.projects.find((p) => p.id === a.projectId);
              const srcRoom = s.rooms.find((r) => r.id === a.roomId);
              const hidden = !s.visibleProjectIds.includes(a.projectId);
              return (
              <div
                key={a.id}
                className="card tight"
                style={{ cursor: 'pointer', opacity: a.readAt ? 0.72 : 1 }}
                // 点卡先聚焦来源项目：若该项目被隐藏，会按 §17.7 自动补选并提示，
                // 否则用户点完发现侧栏里根本没有这个项目，会以为链接坏了。
                onClick={() => {
                  focusProject(a.projectId, { announce: hidden });
                  navigate(target);
                }}
              >
                <div className="row tight wrap">
                  {/* 来源项目必须标出：这是"聚合列表"而不是"当前项目列表"的证据 */}
                  <Tag tone="accent" icon="folder">
                    {srcProject?.displayName ?? a.projectId}
                  </Tag>
                  {srcRoom ? <Tag plain icon="hash">{srcRoom.name}</Tag> : null}
                  {hidden ? <Tag plain icon="eye-off">侧栏已隐藏</Tag> : null}
                  <Tag
                    tone={
                      a.kind === 'approval' || a.kind === 'decision' ? 'warning'
                        : a.kind === 'review' ? 'warning'
                          : a.kind === 'blocked' || a.kind === 'failed' ? 'danger'
                            : a.kind === 'done' ? 'success'
                              : a.kind === 'absence' ? 'warning' : 'info'
                    }
                    icon={
                      a.kind === 'approval' ? 'hand'
                        : a.kind === 'decision' ? 'scale'
                          : a.kind === 'review' ? 'eye'
                            : a.kind === 'blocked' ? 'octagon'
                              : a.kind === 'done' ? 'check-circle'
                                : a.kind === 'absence' ? 'user-minus'
                                  : a.kind === 'mention' ? 'at-sign' : 'message-square'
                    }
                  >
                    {a.kind === 'approval' ? '授权请求'
                      : a.kind === 'decision' ? '需要你决定'
                        : a.kind === 'review' ? '任务交付验收'
                          : a.kind === 'blocked' ? '阻塞'
                            : a.kind === 'done' ? '已完成'
                              : a.kind === 'absence' ? '成员缺席'
                                : a.kind === 'mention' ? '提及' : '未读'}
                  </Tag>
                  <span className="strong">{a.title}</span>
                  {/* 交付版本号：让用户知道这条待办针对哪一版；返工后版本会变 */}
                  {a.kind === 'review' && a.deliveryRevision ? (
                    <Tag plain icon="layers">交付 r{a.deliveryRevision}</Tag>
                  ) : null}
                  {a.requiresAction ? <Tag tone="danger" icon="alert-circle">需要动作</Tag> : null}
                  {a.readAt ? <Tag plain icon="eye">已读</Tag> : null}
                  <div className="spacer" />
                  <span className="small faint">{relTime(a.createdAt)}</span>
                </div>
                <div className="small muted" style={{ marginTop: 4, lineHeight: 1.65 }}>{a.detail}</div>
              </div>
              );
            })}
          </div>
        )}

        {/* ================= 我设的提醒 =================
            从设置页搬来（用户反馈"设置界面感觉好奇怪"后重构的一部分）。
            为什么不并进上面的待办流：**待我处理是"别人给我的、要我现在响应的"收件箱，
            提醒是"我设的定时器，到点唤醒某个成员"** —— 两者方向相反。
            混在一起会让待办列表变成杂物间，所以这里独立成节并写明区别。 */}
        <div className="section-title" style={{ marginTop: 26 }}>
          <Icon name="clock" size={14} /> 我设的提醒<span className="count">{s.reminders.length}</span>
        </div>
        <div className="panel" style={{ marginBottom: 10 }}>
          提醒是<strong>到点唤醒指定成员</strong>，和上面的待办方向相反：上面是别人找你，这里是你定时间。
          只唤醒指定的人；应用关闭时错过的提醒不补跑，恢复后标记为过期。
        </div>
        <div className="card">
          {s.reminders.length === 0 ? (
            <div className="small faint">
              还没有提醒。提醒属于 M3 批次，原型里的写操作用 <code>LOCAL_ONLY:</code> 标注。
            </div>
          ) : (
            <div className="col" style={{ gap: 10 }}>
              {s.reminders.map((r) => {
                const th = s.threads.find((t) => t.id === r.threadId);
                const tk = s.tasks.find((t) => t.id === th?.rootTaskId);
                return (
                  <div key={r.id} className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="strong" style={{ fontSize: 12 }}>{r.schedule}</div>
                      <div className="small faint" style={{ marginTop: 2 }}>
                        {tk ? `任务 #${tk.roomTaskNumber} · ` : ''}只唤醒 {memberLabel(byId(s.members, r.ownerMemberId))}
                      </div>
                      <div className="small faint">
                        下次 {fullTime(r.nextRunAt)} · {r.timezone}
                      </div>
                    </div>
                    <Switch checked={r.enabled} onChange={() => toggleReminder(r.id)} />
                  </div>
                );
              })}
            </div>
          )}
          <div className="panel-actions">
            {/* 「新建提醒」是待我处理页唯一的创建动作，该页此前**一个主按钮都没有**
                （`audit-all-primaries.mjs` 实测 primary 0），按规范 §5.8 应为 --grad。 */}
            <button
              className="btn primary sm"
              onClick={() => {
                const first = s.threads[0];
                if (first) createReminder(first.id, '每工作日 09:30', s.members[0]?.id ?? '');
              }}
            >
              <Icon name="plus" size={12} /> 新建提醒
            </button>
          </div>
          <div className="small faint" style={{ marginTop: 10, lineHeight: 1.7 }}>
            提醒会持久保存归属成员、线程、时区、计划与授权范围；停止任务或归档房间会让相关提醒暂停。
            循环提醒把错过的多次合并成一次，不会补跑几十次。
          </div>
        </div>

        {/* 原型留痕：便于评审时回看每一步写操作 */}
        <div className="section-title" style={{ marginTop: 26 }}>
          原型写入留痕<span className="count">{writeLog.length}</span>
        </div>
        <div className="panel">
          这里记录你在原型里触发的每一次写操作，命令名与实际命令清单一致；
          表里还没有的功能以 <code>LOCAL_ONLY:</code> 前缀标出，避免界面假装已有正式契约。
          刷新页面即回到初始种子。
        </div>
        {writeLog.length > 0 ? (
          <div className="card" style={{ marginTop: 10, padding: 0 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 84 }}>时间</th>
                  <th style={{ width: 230 }}>命令</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {writeLog.slice(0, 24).map((w, i) => (
                  <tr key={i}>
                    <td className="mono-sm">{relTime(w.at)}</td>
                    <td className="mono-sm" style={{ color: w.api.startsWith('LOCAL_ONLY') ? 'var(--warning)' : 'var(--accent-text)' }}>
                      {w.api}
                    </td>
                    <td className="small">{w.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="small faint" style={{ marginTop: 8 }}>
            还没有写操作。试着在主池发一条任务、打开一个线程、回复一次或点一次表情。
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   搜索与收藏（第十五批 §17.7：同页两个标签 + 明确的展示范围）
   ============================================================ */

/**
 * 范围三态（§17.7）：
 *  - project：单个项目（**必须显式带 projectId**，不靠"临时当前项目"猜）
 *  - visible：侧栏可见项目
 *  - all：全部可访问项目
 *
 * 为什么范围要显式呈现：以前范围隐含在"当前项目"里，用户看不出
 * 自己在搜一个项目还是全部；切项目时结果集悄悄变化也没提示。
 */
type LibraryScope = 'project' | 'visible' | 'all';

export function LibraryPage({ query }: { query: Record<string, string> }) {
  const s = useStore((x) => x);
  const tab: 'search' | 'saved' = query.tab === 'saved' ? 'saved' : 'search';
  const scope: LibraryScope =
    query.scope === 'visible' ? 'visible' : query.scope === 'all' ? 'all' : 'project';
  const scopeProjectId = query.projectId ?? s.activeProjectId;

  const [q, setQ] = useState('');
  const [author, setAuthor] = useState('all');

  const setParam = (patch: Record<string, string>) => {
    const qs = new URLSearchParams({ tab, scope, projectId: scopeProjectId, ...query, ...patch });
    navigate(`/library?${qs.toString()}`, { replace: true });
  };

  /** 当前范围包含的项目 ID */
  const scopeProjectIds = useMemo(() => {
    if (scope === 'all') return s.projects.map((p) => p.id);
    if (scope === 'visible') return s.visibleProjectIds;
    return [scopeProjectId];
  }, [scope, scopeProjectId, s.projects, s.visibleProjectIds]);

  const scopeLabel =
    scope === 'all'
      ? '全部项目'
      : scope === 'visible'
        ? `侧栏可见项目（${scopeProjectIds.length}）`
        : s.projects.find((p) => p.id === scopeProjectId)?.displayName ?? scopeProjectId;

  const projectName = (pid: string) => s.projects.find((p) => p.id === pid)?.displayName ?? pid;
  const roomName = (roomId: string) => s.rooms.find((r) => r.id === roomId)?.name ?? '—';

  const saved = s.messages.filter((m) => m.saved && scopeProjectIds.includes(m.projectId));
  const searchResults = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return s.messages
      .filter((m) => scopeProjectIds.includes(m.projectId))
      .filter((m) => m.body.toLowerCase().includes(needle))
      .filter((m) => author === 'all' || m.authorId === author)
      .slice(0, 30);
  }, [q, author, s.messages, scopeProjectIds]);

  /**
   * 跳到来源：必须用**消息自己的 projectId**，不能用全局 activeProjectId 拼链接
   * （§17.7：点结果再聚焦来源项目；跨项目结果才不会跳到当前项目的同号对象）。
   */
  const gotoSource = (m: { projectId: string; roomId: string; threadId?: string }) => {
    focusProject(m.projectId, { announce: false });
    if (m.threadId) navigate(`/project/${m.projectId}/room/${m.roomId}?thread=${m.threadId}`);
    else navigate(`/project/${m.projectId}/room/${m.roomId}`);
  };

  return (
    <div className="main">
      <div className="page">
        {/* 页头（「搜索与收藏」+ 一段说明）已按用户要求删除（2026-09-26）：
            这个页面的身份由侧栏高亮 + 下面的页签（搜索/收藏）承担，
            页头那段话是重复叙述。 */}

        {/* 标签在上、**一个**筛选行在下。
            此前是"范围条 → 标签 → 搜索条"两条分开的横条夹着标签，
            看起来像两套互不相干的控件；合并成一条更清楚，
            也让"范围"（对两个标签都生效）和"关键词/作者"（只对搜索生效）
            在同一行里各自可辨。 */}
        <div className="thread-tabs" style={{ marginBottom: 12 }}>
          <button className={`thread-tab${tab === 'search' ? ' on' : ''}`} onClick={() => setParam({ tab: 'search' })}>
            <Icon name="search" size={13} /> 搜索
          </button>
          <button className={`thread-tab${tab === 'saved' ? ' on' : ''}`} onClick={() => setParam({ tab: 'saved' })}>
            <Icon name="bookmark" size={13} /> 收藏
            <span className="faint">{saved.length}</span>
          </button>
        </div>

        {/* 范围控件与"当前项目"分开显示：看板/搜索选多个项目时，顶栏仍只显示一个当前项目（§17.1）。
            控件统一放内容区左上角，与看板/成员/合页的筛选行同一套样式。 */}
        <div className="page-filters">
          <label className="field inline">
            <span className="field-label">范围</span>
            <select
              className="select"
              value={scope}
              onChange={(e) => setParam({ scope: e.target.value })}
            >
              <option value="project">单个项目</option>
              <option value="visible">侧栏可见项目</option>
              <option value="all">全部项目</option>
            </select>
          </label>

          {scope === 'project' ? (
            <label className="field inline">
              <span className="field-label">项目</span>
              <select
                className="select"
                value={scopeProjectId}
                onChange={(e) => {
                  const next = e.target.value;
                  focusProject(next, { announce: false });
                  setParam({ projectId: next });
                }}
              >
                {s.projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.displayName}</option>
                ))}
              </select>
            </label>
          ) : null}

          {tab === 'search' ? (
            <>
              <div style={{ flex: '1 1 240px', minWidth: 180 }}>
                <input
                  className="input"
                  placeholder={`在「${scopeLabel}」范围内搜索关键词…`}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
              <label className="field inline">
                <span className="field-label">作者</span>
                <select className="select" value={author} onChange={(e) => setAuthor(e.target.value)}>
                  <option value="all">全部作者</option>
                  <option value="you">我</option>
                  {s.members
                    .filter((m) => scopeProjectIds.includes(m.projectId))
                    .map((m) => (
                      <option key={m.id} value={m.id}>{projectName(m.projectId)} · {memberLabel(m)}</option>
                    ))}
                </select>
              </label>
            </>
          ) : null}

          {/* 范围标签必须始终可见：用户要能确认"我搜的是哪几个项目" */}
          <span className="filter-note">
            当前范围：{scopeLabel}
            {tab === 'search' ? ' · 搜索不覆盖文件正文，附件需打开文件查看' : ''}
          </span>
        </div>

        {tab === 'search' ? (
          <>
            {q.trim() ? (
              <>
                <div className="section-title">搜索结果<span className="count">{searchResults.length}</span></div>
                {searchResults.length === 0 ? (
                  <EmptyState icon="search" title="没有命中" detail="换一个关键词，换一个范围，或者在具体线程里限定搜索。" />
                ) : (
                  <div className="col" style={{ gap: 8 }}>
                    {searchResults.map((m) => (
                      <div key={m.id} className="card tight" style={{ cursor: 'pointer' }} onClick={() => gotoSource(m)}>
                        <div className="row tight wrap">
                          {/* 来源项目必须标出：跨项目结果里，"开发大厅"可能有两个 */}
                          <Tag tone="accent" icon="folder">{projectName(m.projectId)}</Tag>
                          <Tag plain icon="hash">{roomName(m.roomId)}</Tag>
                          <span className="small strong">
                            {m.authorType === 'human' ? '你' : m.authorType === 'system' ? '系统' : memberLabel(byId(s.members, m.authorId))}
                          </span>
                          {m.threadId ? <Tag plain>串内</Tag> : <Tag plain>主池</Tag>}
                          <div className="spacer" />
                          <span className="small faint">{relTime(m.createdAt)}</span>
                        </div>
                        <div className="small" style={{ marginTop: 4, lineHeight: 1.65 }}>{m.body}</div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <EmptyState icon="search" title="输入关键词开始搜索" detail="结果会标出来源项目与房间，点击回原处并聚焦该项目。" />
            )}
          </>
        ) : (
          <>
            <div className="section-title">已收藏<span className="count">{saved.length}</span></div>
            {saved.length === 0 ? (
              <EmptyState
                icon="bookmark"
                title="还没有收藏"
                detail="在消息上点书签图标即可收藏。收藏本身不把内容共享给其他成员，也不改变任务上下文。"
              />
            ) : (
              <div className="col" style={{ gap: 8 }}>
                {saved.map((m) => (
                  <div key={m.id} className="card tight">
                    <div className="row tight wrap">
                      <Tag tone="accent" icon="folder">{projectName(m.projectId)}</Tag>
                      <Tag plain icon="hash">{roomName(m.roomId)}</Tag>
                      <Tag plain icon="user">
                        {m.authorType === 'human' ? '你' : memberLabel(byId(s.members, m.authorId))}
                      </Tag>
                      <div className="spacer" />
                      <button className="btn ghost sm" onClick={() => saveMessage(m.id)}>取消收藏</button>
                      <button className="btn ghost sm" onClick={() => gotoSource(m)}>回原处</button>
                    </div>
                    <div className="small" style={{ marginTop: 4, lineHeight: 1.65 }}>{m.body}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* 文件到此结束：不要把非组件符号从这里再导出一次，
   否则 Vite Fast Refresh 会因"混用了组件与非组件导出"而整页失效。 */
