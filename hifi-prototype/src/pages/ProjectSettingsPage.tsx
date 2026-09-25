/**
 * 项目设置（第十六批 §17.8 / RT-27）
 *
 * 为什么独立成页：此前项目设置与应用设置挤在同一个 `/settings` 里，
 * 只能反复用「当前项目 / 应用」分组与副标题去解释"这项影响项目、那项影响应用"。
 * 用户提出"项目的设置合并一个页面后，就不要和整个软件的设置在一起了" ——
 * 拆开后语义变得直接：**想改某个项目，去那个项目旁边；想改整个软件，点底部设置**。
 *
 * 三条硬约束（§17.8）：
 *  1. **路由绑定项目**：目标只来自 URL 里经校验的 projectId。
 *     不使用 `projects[0]` 或"当前项目"回退 —— 无效项目报错，不假装成功（RT-27 ④）。
 *  2. **单页分节**，且**没有页内二级分类导航、没有项目下拉**：
 *     切项目走顶栏/侧栏，不在这里再放一套。
 *  3. **保存绑定页面接收的 projectId**：数字输入用本地草稿状态，
 *     失焦/Enter 才校验提交，避免"每输一位就被钳回默认值"（RT-27 ⑦）。
 */

import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { ErrorState, Modal, Switch, Tag } from '../components/ui';
import { useStore } from '../data/store';
import { lockOfProject } from '../data/selectors';
import { setTaskReviewEnabled } from '../data/actions-delivery';
import { setWriteConcurrencyPolicy, stopAll, updateLoopSettings } from '../data/actions';
import { navigate } from '../lib/router';

/** 分节锚点：只用于滚动定位，不生成第二张页面（§17.8 兼容表） */
export type ProjectSettingsAnchor = 'collab' | 'write' | 'delivery';

export function anchorOf(raw: string | undefined): ProjectSettingsAnchor {
  if (raw === 'write' || raw === 'files') return 'write';
  if (raw === 'delivery' || raw === 'task') return 'delivery';
  return 'collab';
}

/**
 * 数字输入框：**保留编辑态**。
 *
 * 为什么不能直接受控于 store：原实现把 value 绑到 store 并在 onChange 里
 * `Math.max(1, Math.min(240, Number(v) || 20))` —— 用户一清空就立刻变回 20，
 * 于是没法把「20」改成「45」（得先选中再输，或慢慢删）。
 * 实测确认：清空输入框后值立刻回到 20。
 *
 * 现在：本地草稿字符串 → 失焦或 Enter 时才校验提交；Escape 恢复已保存值；
 * 无效值不写入并显示行内提示。
 */
function NumberField({
  label,
  hint,
  value,
  min,
  max,
  unit,
  onCommit,
}: {
  label: string;
  hint: React.ReactNode;
  value: number;
  min: number;
  max: number;
  unit: string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);

  // store 里的值被别处改动（如切项目）时同步过来，但不要在编辑中被覆盖
  useEffect(() => {
    setDraft(String(value));
    setError(null);
  }, [value]);

  const commit = () => {
    const raw = draft.trim();
    if (raw === '') {
      setError(`请填 ${min}–${max} 之间的数字`);
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
      setError(`只能是 ${min}–${max} 之间的数字`);
      return;
    }
    setError(null);
    if (n !== value) onCommit(n);
  };

  return (
    <div className="pset-row">
      <div className="pset-row-label">
        <div className="pset-row-name">{label}</div>
        <div className="pset-row-hint">{hint}</div>
        {error ? <div className="pset-row-error">{error}</div> : null}
      </div>
      <div className="pset-row-control">
        <input
          className="input pset-number"
          type="number"
          min={min}
          max={max}
          value={draft}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            // 只改草稿，不钳制、不提交 —— 让用户能把数字敲完
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(String(value));
              setError(null);
            }
          }}
        />
        <span className="pset-unit">{unit}</span>
      </div>
    </div>
  );
}

/** 开关行：名称 + 一句说明在左，开关在右 */
function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  children,
}: {
  label: string;
  hint: React.ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="pset-row">
      <div className="pset-row-label">
        <div className="pset-row-name">{label}</div>
        <div className="pset-row-hint">{hint}</div>
        {children}
      </div>
      <div className="pset-row-control">
        <Switch checked={checked} onChange={onChange} label={<span className="visually-hidden">{label}</span>} />
      </div>
    </div>
  );
}

export function ProjectSettingsPage({
  projectId,
  query,
}: {
  projectId: string;
  query: Record<string, string>;
}) {
  const s = useStore((x) => x);
  const project = s.projects.find((p) => p.id === projectId);

  const anchor = anchorOf(query.anchor);
  /** 项目全停的确认弹窗（第二十六批第二轮从侧栏底部移来） */
  const [stopAllOpen, setStopAllOpen] = useState(false);

  /**
   * 锚点只用于**滚动定位分节**（§17.8 兼容表：anchor 不产生第二张页面）。
   *
   * 但默认锚点 collab 不该在刚进页面时就把标题滚出视野 —— 用户第一眼
   * 应该看到"这是哪个项目的设置"。所以只在**显式非默认锚点**时才滚。
   */
  useEffect(() => {
    if (!project) return;
    if (anchor === 'collab') return;
    const el = document.getElementById(`pset-${anchor}`);
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [anchor, project]);

  /**
   * 无效项目：**报错，不回退**（RT-27 ④）。
   * 不能用 projects[0] 或当前项目代替 —— 那会让用户以为在改 A，实际改了 B。
   * 这里也刻意不渲染任何设置控件。
   */
  if (!project) {
    return (
      <div className="main">
        <div className="page">
          <ErrorState
            code="PROJECT_NOT_FOUND"
            detail={`项目不存在或不可访问：${projectId}。为避免改错项目，这里不回退到其他项目。请从侧栏项目菜单进入。`}
          />
          <div className="panel-actions">
            <button className="btn sm" onClick={() => navigate('/welcome')}>回到欢迎页</button>
          </div>
        </div>
      </div>
    );
  }

  const policy = project.writeConcurrencyPolicy ?? 'single_writer';
  const maxWriters = project.maxParallelWriters ?? 2;
  const reviewEnabled = project.taskReviewEnabled ?? false;
  const pendingElsewhere = s.taskDeliveries.filter(
    (d) => d.status === 'pending' && s.tasks.some((t) => t.id === d.taskId && t.projectId === project.id),
  ).length;
  const loop = project.loopSettings ?? {
    absenceGraceMin: 20,
    analysisTurnDeadlineMin: 20,
    modifyTurnDeadlineMin: 60,
    maxConcurrentTurns: 3,
  };
  const lease = lockOfProject(s, project.id);

  /**
   * 「项目全停」确认弹窗要列出的数字，**必须按本项目算**。
   * 原来这两个数在 App.tsx 里算，其中 runningCount 是全局的（没按项目过滤）；
   * 这里按项目重算，避免"众说的弹窗里显示别的项目的 turn 数"。
   */
  const projectRoomIds = new Set(s.rooms.filter((r) => r.projectId === project.id).map((r) => r.id));
  const activeTaskCount = s.tasks.filter(
    (t) => projectRoomIds.has(t.roomId) && ['ACTIVE', 'WAITING_USER', 'BLOCKED', 'REVIEW'].includes(t.status),
  ).length;
  const runningTurnCount = s.turns.filter((t) => {
    if (!['RUNNING', 'DISPATCHING', 'WAITING_APPROVAL'].includes(t.status)) return false;
    const th = s.threads.find((x) => x.id === t.threadId);
    const room = th ? s.rooms.find((r) => r.id === th.roomId) : undefined;
    return room ? room.projectId === project.id : false;
  }).length;

  return (
    <div className="main">
      <div className="page">
        <div className="page-head">
          <div>
            {/* 标题含项目名 + 真实路径；不放项目下拉（切项目走顶栏/侧栏） */}
            <div className="page-title">{project.displayName} · 项目设置</div>
            <div className="page-sub mono">{project.rootPath}</div>
          </div>
        </div>

        {project.status === 'missing' ? (
          <div className="panel warning" style={{ marginBottom: 14 }}>
            <div className="panel-title"><Icon name="alert-triangle" size={13} /> 目录已失效，配置仍可查看</div>
            这个项目的记录还在，但路径 {project.rootPath} 当前不可访问。下面的设置可以查看和修改，
            但让成员读写这个目录会失败 —— 请先用顶栏项目菜单重新定位目录。
          </div>
        ) : null}

        <div className="pset">
          {/* ==================== 任务交付 ==================== */}
          <section className="pset-section" id="pset-delivery">
            <div className="pset-section-title">任务交付</div>

            <div className="card">
              <SwitchRow
                label="任务交付后需要我确认"
                hint="开启后，任务交付会等你验收才算完成；关闭后，满足交付要求即完成。仅影响新任务。"
                checked={reviewEnabled}
                onChange={(v) => setTaskReviewEnabled(project.id, v)}
              >
                {pendingElsewhere > 0 ? (
                  <button
                    className="pset-link"
                    onClick={() => navigate('/activity')}
                    title="去「待我处理」逐条验收"
                  >
                    还有 {pendingElsewhere} 个已有任务等待验收 → 查看
                  </button>
                ) : null}
              </SwitchRow>

              {/* 迁移说明：中性、可关闭，不做成永久橙色警告（§17.8 表单与反馈） */}
              {project.taskReviewMigrated ? (
                <MigrationNote
                  text={`这个项目升级前缺少该设置，且原本按「代码人工审阅」运行，因此保守地设为开启。已有任务保持创建时的规则。`}
                />
              ) : null}

              <div className="pset-note">
                关闭验收不等于自动批准权限、自动提交或推送 Git；「已完成 · 无需验收」与「已验收」是两个状态。
                {/* 非 Git 项目的用户需要立刻确认这个开关对自己同样有效（RT-25） */}
                与是否 Git 仓库无关：本项目{project.isGit ? '是' : '不是'} Git 仓库，开关照常可用。
              </div>
            </div>
          </section>

          {/* ==================== 协作限制 ==================== */}
          <section className="pset-section" id="pset-collab">
            <div className="pset-section-title">协作限制</div>

            <div className="card">
              <NumberField
                label="成员无响应后继续"
                hint="超过这个时间就按在场成员继续，不再干等。迟到成果仍会并入。"
                value={loop.absenceGraceMin}
                min={1}
                max={240}
                unit="分钟"
                onCommit={(v) => updateLoopSettings(project.id, { absenceGraceMin: v })}
              />

              <div className="pset-divider" />

              <NumberField
                label="单次分析最长运行"
                hint="到点强制结束这一轮，避免成员卡住一直消耗预算。"
                value={loop.analysisTurnDeadlineMin}
                min={1}
                max={480}
                unit="分钟"
                onCommit={(v) => updateLoopSettings(project.id, { analysisTurnDeadlineMin: v })}
              />

              <NumberField
                label="单次修改最长运行"
                hint="改文件比分析慢，所以这里通常比上面长。与「无响应后继续」是两件事。"
                value={loop.modifyTurnDeadlineMin}
                min={1}
                max={480}
                unit="分钟"
                onCommit={(v) => updateLoopSettings(project.id, { modifyTurnDeadlineMin: v })}
              />

              <details className="settings-why">
                <summary>了解更多：这两个时限和「无响应」的区别</summary>
                <div className="small faint" style={{ lineHeight: 1.7, marginTop: 8 }}>
                  「成员无响应后继续」管的是<strong>等不到人</strong>：超过时间就带现在的人往下走。
                  「单次执行最长运行」管的是<strong>一轮跑太久</strong>：到点强制收尾。
                  前者避免项目卡住，后者避免预算被单轮吃光。默认 20 / 20 / 60 分钟。
                </div>
              </details>
            </div>
          </section>

          {/* ==================== 文件修改 ==================== */}
          <section className="pset-section" id="pset-write">
            <div className="pset-section-title">文件修改</div>

            <div className="card">
              <div className="pset-row">
                <div className="pset-row-label">
                  <div className="pset-row-name">同时修改文件的任务</div>
                  <div className="pset-row-hint">两种互斥，只能选一个。</div>
                </div>
              </div>

              <div className="col" style={{ gap: 10 }}>
                <label className={`wpolicy${policy === 'single_writer' ? ' on' : ''}`}>
                  <input
                    type="radio"
                    name="write-policy"
                    checked={policy === 'single_writer'}
                    onChange={() => setWriteConcurrencyPolicy(project.id, 'single_writer')}
                  />
                  <div>
                    <div className="row tight">
                      <span className="strong">一个任务（推荐）</span>
                      <Tag tone="success" icon="check-circle">推荐</Tag>
                    </div>
                    <div className="small faint" style={{ marginTop: 3, lineHeight: 1.6 }}>
                      减少任务之间的并发冲突；其他写入任务排队。撤销前仍会检查文件变化。
                    </div>
                  </div>
                </label>

                <label className={`wpolicy${policy === 'parallel_writers' ? ' on' : ''}`}>
                  <input
                    type="radio"
                    name="write-policy"
                    checked={policy === 'parallel_writers'}
                    onChange={() => setWriteConcurrencyPolicy(project.id, 'parallel_writers', maxWriters)}
                  />
                  <div>
                    <div className="row tight">
                      <span className="strong">多个任务</span>
                      <Tag tone="warning" icon="alert-triangle">有风险</Tag>
                    </div>
                    <div className="small faint" style={{ marginTop: 3, lineHeight: 1.6 }}>
                      更快，但同一个文件被同时修改时无法自动撤销，需要你手动处理冲突。
                    </div>
                  </div>
                </label>
              </div>

              {/* 只在选了"多个任务"时展开上限与影响说明（§17.8：需要时才展开） */}
              {policy === 'parallel_writers' ? (
                <>
                  <div className="pset-divider" />
                  <NumberField
                    label="最多同时修改的任务数"
                    hint="超过这个数量的任务会排队等待。"
                    value={maxWriters}
                    min={2}
                    max={6}
                    unit="个"
                    onCommit={(v) => setWriteConcurrencyPolicy(project.id, 'parallel_writers', v)}
                  />
                  <div className="panel warning" style={{ marginTop: 12 }}>
                    <div className="panel-title"><Icon name="alert-triangle" size={13} /> 开启后这些行为会改变</div>
                    <div className="col" style={{ gap: 5, marginTop: 4 }}>
                      {[
                        '同一个文件被同时修改时，无法自动撤销',
                        '撤销会降级为手动比对，不再有一键回滚',
                        '你用自己的编辑器改的文件，不在这个保护范围内',
                      ].map((t, i) => (
                        <div key={i} className="row tight" style={{ alignItems: 'flex-start' }}>
                          <Icon name="check" size={12} style={{ color: 'var(--warning)', marginTop: 4, flex: 'none' }} />
                          <span className="small" style={{ lineHeight: 1.65 }}>{t}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : null}

              {/* 当前写入情况：简短状态 + 运行详情链接，不展示只读大表与内部锁域 ID */}
              <div className="pset-status">
                {lease ? (
                  <>
                    当前有{' '}
                    {(lease.parallelHolders ?? [lease.ownerTaskId]).length} 个任务正在修改文件
                    <button
                      className="pset-link"
                      onClick={() => {
                        const t = s.tasks.find((x) => x.id === lease.ownerTaskId);
                        const th = t ? s.threads.find((x) => x.id === t.conversationThreadId) : undefined;
                        if (th) navigate(`/project/${project.id}/room/${th.roomId}?thread=${th.id}&tab=run`);
                        else navigate('/tasks?scope=project&projectId=' + project.id);
                      }}
                    >
                      → 查看运行详情
                    </button>
                  </>
                ) : (
                  '当前没有任务在修改文件'
                )}
              </div>
            </div>
          </section>

          <div className="pset-foot">
            改动会立即保存。这些设置只影响 <strong>{project.displayName}</strong>，不影响其他项目。
          </div>

          {/* ============================================================
              高级操作：项目全停（第二十六批第二轮从侧栏底部移来）
              ============================================================
              用户担心它在侧栏底部容易被误触。归属上这里也更自洽 ——
              它是**项目级**动作，而 §17.8 要求应用设置不含项目配置。
              刻意保持两步：先点这里，再在弹窗里点"停止本项目全部任务"，
              且弹窗会先列出将影响的任务与 turn 数量。 */}
          <div className="settings-advanced">
            <div className="settings-advanced-head">
              <Icon name="alert-triangle" size={13} />
              高级操作
              <span className="small faint">停止是不可逆的动作，请确认后再用</span>
            </div>
            <div className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div className="strong" style={{ fontSize: 12 }}>停止这个项目的全部任务</div>
                <div className="small faint" style={{ marginTop: 2, lineHeight: 1.6 }}>
                  覆盖 <strong>{project.displayName}</strong> 的所有房间与子任务，新增停止代次。
                  只影响本项目，其他项目正在运行的任务不受影响。
                </div>
              </div>
              <button className="btn sm danger" onClick={() => setStopAllOpen(true)}>
                <Icon name="octagon" size={12} /> 项目全停
              </button>
            </div>
          </div>
        </div>
      </div>

      {stopAllOpen ? (
        <Modal
          size="sm"
          title="项目全停"
          subtitle={`覆盖 ${project.displayName} 的所有房间和子任务，为项目增加停止代次`}
          onClose={() => setStopAllOpen(false)}
          footer={
            <>
              <div className="spacer" />
              <button className="btn" onClick={() => setStopAllOpen(false)}>取消</button>
              <button
                className="btn danger"
                onClick={() => {
                  stopAll(project.id);
                  setStopAllOpen(false);
                }}
              >
                <Icon name="octagon" size={12} /> 停止本项目全部任务
              </button>
            </>
          }
        >
          <div className="panel warning">
            <div className="panel-title"><Icon name="alert-triangle" size={13} /> 停止不是撤销</div>
            已写入磁盘的改动会保留，界面会展示残留 diff。撤销是带版本检查的独立操作（changes.revert）。
          </div>
          <div style={{ marginTop: 12 }}>
            <dl className="kv">
              <dt>将要停止</dt>
              <dd>
                {activeTaskCount} 个活跃任务 · {runningTurnCount} 个正在运行的 turn
              </dd>
              <dt>作用范围</dt>
              <dd>只限本项目；其他项目的任务、租约与成员状态都不受影响</dd>
              <dt>写入锁</dt>
              <dd>无论谁持有都会被释放；释放前会确认相关工具已停止</dd>
              <dt>迟到事件</dt>
              <dd>可以留审计记录，但不会启动下一阶段</dd>
            </dl>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * 迁移说明：**中性、可关闭**的一次性提示。
 * 原实现用永久橙色警告面板，会让真正的风险提示（如并行写入）失去分量（§17.8）。
 */
function MigrationNote({ text }: { text: string }) {
  const [closed, setClosed] = useState(false);
  if (closed) return null;
  return (
    <div className="pset-migration">
      <Icon name="info" size={13} />
      <span>{text}</span>
      <button className="pset-migration-close" onClick={() => setClosed(true)} aria-label="知道了，关闭这条说明">
        知道了
      </button>
    </div>
  );
}
