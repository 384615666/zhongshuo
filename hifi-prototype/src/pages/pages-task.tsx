/**
 * 任务详情 / 研讨详情 / 运行详情 / 任务看板
 *
 * 关键口径：
 *  - §10.1 业务状态与执行状态分离：Task 状态与 WorkflowRun 状态同时展示，不合并
 *  - §6.1 研讨阶段矩阵：PREPARE/INDEPENDENT/CROSS_REVIEW/ISSUE_DISCUSSION/SYNTHESIS/RATIFY/PUBLISH
 *  - §6.5 共识状态由程序按确认记录计算；有缺席/迟到时绝不写"全体一致"（AT-05）
 *  - §18.1 每条诊断带 projectId/taskId/runId/turnId/dispatchKey/adapterVersion
 *  - 费用未知不得显示为 0（RT-17）
 */

import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import {
  Avatar, ConsensusTag, CostText, EmptyState, ErrorState, Meter, Tag, TaskStatusTag,
  RunStatusTag, TurnStatusTag, memberColor, hostClass, type DetailHost,
} from '../components/ui';
import { useStore, toast } from '../data/store';
import {
  artifactsOfTask, byId, childTasksOf, memberLabel, taskOf, threadOf,
} from '../data/selectors';
import { allowMissing, retryTask, steerSubtask, stopTask } from '../data/actions';
import { focusProject } from '../data/actions-nav';
import { consensusLabel, formatDuration, formatTokens, relTime, routeModeCopy, stageLabel } from '../lib/format';
import { navigate } from '../lib/router';
import type { StageKey, TaskStatus } from '../data/types';

const STAGES: { key: StageKey; label: string; note: string }[] = [
  { key: 'PREPARE', label: '准备', note: '程序执行，不调用模型：生成基线、冻结名单、预算预估' },
  { key: 'INDEPENDENT', label: '独立', note: '同一题目与基线，各自不见他人报告' },
  { key: 'CROSS_REVIEW', label: '互评', note: '收齐初稿后开放，带引用地互相评审' },
  { key: 'ISSUE_DISCUSSION', label: '分歧讨论', note: '第 3 轮为强制复核检查点，硬停由预算承担' },
  { key: 'SYNTHESIS', label: '整合', note: '主持者整合稿，程序校验格式与引用' },
  { key: 'RATIFY', label: '确认', note: '每人对同一版本确认或提出异议' },
  { key: 'PUBLISH', label: '发布', note: '程序执行：不伪造缺席意见或共识' },
];

/* ============================================================
   任务详情（§17.2：目标、模式、参与者、阶段、子任务；阻塞原因与下一动作）
   ============================================================ */

export function TaskDetailPage({
  taskId,
  host,
  embedded,
}: {
  taskId: string;
  host?: DetailHost;
  /**
   * 内嵌在「详情 → 任务概况」里渲染（减负第二轮 §1）。
   *
   * 任务概况自己已经给出标题、任务号、状态、方式、阶段、派发摘要与完整原始要求，
   * 所以这里**不再重复**同一份 identity 与那排操作（定向跟进 / 研讨详情 / 停止任务）：
   *  · 身份区整块不渲染（避免"标题、状态、方式"两遍）；
   *  · 操作只保留**别处没有**的「定向跟进」（停止在输入区、研讨详情在详情分组里已有入口）；
   *  · 「任务属性」里去掉与概况重复的"模式"行；
   *  · 容器加 `detail-embed` 类 → 两列网格在面板宽度下改单列，成员名不再逐字断行。
   */
  embedded?: boolean;
}) {
  const s = useStore((x) => x);
  const task = taskOf(s, taskId);
  const [steerOpen, setSteerOpen] = useState(false);
  const [steerBody, setSteerBody] = useState('');

  if (!task) {
    return (
      <div className={hostClass(host, 'main')}>
        <div className={hostClass(host, 'page')}>
          <ErrorState code="ARTIFACT_MISSING" detail="找不到该任务。" />
        </div>
      </div>
    );
  }

  const thread = threadOf(s, task.conversationThreadId);
  const run = s.runs.find((r) => r.taskId === task.id);
  const parent = task.parentTaskId ? taskOf(s, task.parentTaskId) : undefined;
  const children = childTasksOf(s, task.id);
  const owner = byId(s.members, task.ownerMemberId);
  const arts = artifactsOfTask(s, task.id);
  const changes = s.changeSets.filter((c) => c.taskId === task.id);
  const turns = run ? s.turns.filter((t) => t.runId === run.id) : [];
  const participants = run ? s.members.filter((m) => turns.some((t) => t.memberId === m.id)) : [];
  const absent = run ? s.members.filter((m) => !turns.some((t) => t.memberId === m.id)) : [];

  return (
    <div className={`${hostClass(host, 'main')}${embedded ? ' detail-embed' : ''}`}>
      <div className={hostClass(host, 'page')}>
        {embedded ? (
          /* 内嵌形态：身份与那排操作都已在任务概况里，这里只留"别处没有"的一个动作 */
          <div className="row tight" style={{ marginBottom: 10 }}>
            <button className="btn ghost sm" onClick={() => setSteerOpen(true)}>
              <Icon name="corner-down-right" size={12} /> 定向跟进
            </button>
          </div>
        ) : (
        <div className="page-head">
          <div style={{ minWidth: 0 }}>
            <div className="row tight wrap">
              <span className="root-task-no">#{task.roomTaskNumber}</span>
              <TaskStatusTag status={task.status} />
              {run ? <RunStatusTag status={run.status} /> : null}
              <Tag plain icon="git-commit">{routeModeCopy[task.mode].label}</Tag>
              {parent ? <Tag plain icon="layers">子任务 of #{parent.roomTaskNumber}</Tag> : null}
            </div>
            <div className="page-title" style={{ marginTop: 8 }}>{task.title}</div>
            <div className="page-sub">{task.objective}</div>
          </div>
          <div className="page-head-actions">
            <button className="btn sm" onClick={() => setSteerOpen(true)}>
              <Icon name="corner-down-right" size={12} /> 定向跟进
            </button>
            {/* 面板形态下已经能看到回复串，不再需要"打开回复串"跳转 */}
            {host !== 'panel' ? (
              <button className="btn sm" onClick={() => thread && navigate(`/project/${s.activeProjectId}/room/${task.roomId}?thread=${thread.id}`)}>
                <Icon name="message-square" size={12} /> 打开回复串
              </button>
            ) : null}
            {run ? (
              <button className="btn sm" onClick={() => navigate(`/deliberation/${run.id}`)}>
                <Icon name="layers" size={12} /> 研讨详情
              </button>
            ) : null}
            {(['ACTIVE', 'WAITING_USER', 'BLOCKED'] as TaskStatus[]).includes(task.status) ? (
              <button className="btn danger sm" onClick={() => stopTask(task.id)}>
                <Icon name="stop" size={12} /> 停止任务
              </button>
            ) : null}
          </div>
        </div>
        )}

        {task.status === 'BLOCKED' ? (
          <ErrorState
            code="WORKSPACE_BUSY"
            detail="缺失的子任务是完成目标的必要条件，根任务进入阻塞并保留了已有部分成果。"
            actions={
              <>
                <button className="btn primary sm" onClick={() => retryTask(task.id, 'strict')}>重试失败子任务</button>
                <button className="btn sm" onClick={() => run && allowMissing(run.id, [])}>按现有成员继续</button>
              </>
            }
          />
        ) : null}

        <div className="grid grid-2" style={{ marginTop: 16 }}>
          <div className="card">
            <div className="card-title" style={{ marginBottom: 10 }}>任务属性</div>
            <dl className="kv">
              <dt>负责人</dt>
              <dd className="row tight">
                <Avatar name={owner?.displayName ?? '?'} ordinal={owner?.ordinal} color={memberColor(task.ownerMemberId ?? '', owner?.ordinal)} size={16} />
                <span className="kv-name">{memberLabel(owner)}</span>
                <span className="faint">（交付责任，不排斥多名参与者）</span>
              </dd>
              {/* 内嵌在任务概况里时不再重复"模式"（概况的方式一行已给出） */}
              {embedded ? null : (
                <>
                  <dt>模式</dt>
                  <dd>{routeModeCopy[task.mode].label} · {routeModeCopy[task.mode].detail}</dd>
                </>
              )}
              <dt>验收策略</dt>
              <dd
                title={task.reviewPolicy === 'user_review'
                  ? '需人工验收：完成进入待验收，你确认后才 DONE。由项目「任务验收」开关在创建时决定，改开关只影响之后新建的任务。'
                  : '无需验收：满足交付要求即完成。由项目「任务验收」开关在创建时决定，改开关只影响之后新建的任务。'}
              >
                {task.reviewPolicy === 'user_review' ? '需人工验收' : '无需验收'}
              </dd>
              <dt>当前交付</dt>
              <dd>
                {(() => {
                  const d = task.currentDeliveryId
                    ? s.taskDeliveries.find((x) => x.id === task.currentDeliveryId)
                    : undefined;
                  if (!d) return <span className="faint">尚无交付版本（任务仍在执行）</span>;
                  const label =
                    d.status === 'pending' ? '待验收'
                      : d.status === 'accepted' ? '已验收'
                        : d.status === 'changes_requested' ? '已要求修改'
                          : '已完成 · 无需验收';
                  return (
                    <span className="row tight wrap">
                      <Tag
                        tone={d.status === 'pending' ? 'warning' : d.status === 'accepted' ? 'success' : d.status === 'changes_requested' ? 'danger' : 'neutral'}
                      >
                        {label}
                      </Tag>
                      <span className="mono-sm">r{d.revision}</span>
                      <button className="btn ghost sm" onClick={() => navigate(`/project/${s.activeProjectId}/room/${task.roomId}?thread=${task.conversationThreadId}&tab=delivery`)}>
                        <Icon name="corner-down-right" size={11} /> 查看交付
                      </button>
                    </span>
                  );
                })()}
              </dd>
            </dl>

            {/**
             * 技术信息（用户收尾项②）：`关联串 thread_t12`、`taskRevision 5`
             * 这类**内部标识**不再和产品信息挤在同一张表里，收进折叠区。
             * 需要排查/对账时展开即可，日常默认不可见（诊断与审计记录里仍有全量字段）。
             */}
            <details className="kv-tech">
              <summary>技术信息（内部标识）</summary>
              <dl className="kv">
                <dt>关联串</dt>
                <dd className="mono-sm">{task.conversationThreadId}</dd>
                <dt>taskRevision</dt>
                <dd className="mono-sm">{task.revision}</dd>
                <dt>任务 ID</dt>
                <dd className="mono-sm">{task.id}</dd>
              </dl>
            </details>
          </div>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 10 }}>运行与预算</div>
            {run ? (
              <>
                {/* 产品信息只留"现在到哪一步、预算用了多少"；runId 与 rosterRevision
                    这类内部字段进下面的「技术信息」（用户收尾项②）。 */}
                <dl className="kv">
                  <dt>阶段</dt>
                  <dd title={`内部阶段枚举：${run.stage}`}>{stageLabel(run.stage)} · 第 {run.roundNo} 轮</dd>
                </dl>
                <div className="divider soft" />
                <div className="row tight baseline">
                  <span className="small strong">预算 {run.budget.usedAgentTurns}/{run.budget.maxAgentTurns}</span>
                  <span className="small faint">{run.budget.formula}</span>
                </div>
                <div style={{ marginTop: 7 }}>
                  <Meter
                    segments={[
                      { value: run.budget.usedAgentTurns - run.budget.reservedTail > 0 ? run.budget.usedAgentTurns - run.budget.reservedTail : 0, color: 'var(--accent)', label: '已用' },
                      { value: run.budget.reservedTail, color: 'var(--warning)', label: '尾部预留' },
                      { value: Math.max(0, run.budget.maxAgentTurns - run.budget.usedAgentTurns), color: 'var(--bg-surface-3)', label: '余量' },
                    ]}
                    legend
                  />
                </div>
                {run.budget.mustReserve ? (
                  <div className="small faint" style={{ marginTop: 7 }}>
                    为 {run.budget.mustReserve} 预留尾部配额：前面阶段最多占用总额减 {run.budget.reservedTail}，
                    不足则发布带异议版本，程序拼接为最后兜底。
                  </div>
                ) : null}
                <details className="kv-tech">
                  <summary>技术信息（内部标识）</summary>
                  <dl className="kv">
                    <dt>运行 ID</dt>
                    <dd className="mono-sm">{run.id}</dd>
                    <dt>阶段枚举</dt>
                    <dd className="mono-sm">{run.stage}</dd>
                    <dt>名单版本</dt>
                    <dd className="mono-sm">rosterRevision {run.rosterRevision}</dd>
                  </dl>
                </details>
              </>
            ) : (
              <div className="small faint">该任务还没有运行记录。</div>
            )}
          </div>
        </div>

        {/* 参与者 */}
        <div className="section-title" style={{ marginTop: 20 }}>
          参与者<span className="count">{participants.length}</span>
        </div>
        <div className="grid grid-3">
          {participants.map((m) => {
            const mt = turns.filter((t) => t.memberId === m.id);
            const last = mt[mt.length - 1];
            return (
              <div key={m.id} className="card tight">
                <div className="row tight">
                  <Avatar name={m.displayName} ordinal={m.ordinal} color={memberColor(m.id, m.ordinal)} size={22} state={m.workState} />
                  <span className="strong kv-name" style={{ fontSize: 12 }}>{memberLabel(m)}</span>
                  <div className="spacer" />
                  {last ? <TurnStatusTag status={last.status} /> : null}
                </div>
                <div className="small faint" style={{ marginTop: 6 }}>
                  {mt.length} 次调用
                  {last?.durationMs ? ` · 上次 ${formatDuration(last.durationMs)}` : ''}
                </div>
              </div>
            );
          })}
          {absent.map((m) => (
            <div key={m.id} className="card tight" style={{ opacity: 0.7 }}>
              <div className="row tight">
                <Avatar name={m.displayName} ordinal={m.ordinal} color={memberColor(m.id, m.ordinal)} size={22} />
                <span className="strong" style={{ fontSize: 12 }}>{memberLabel(m)}</span>
                <div className="spacer" />
                <Tag tone="neutral" icon="user-minus">未参与</Tag>
              </div>
              <div className="small faint" style={{ marginTop: 6 }}>本任务没有它的调用记录</div>
            </div>
          ))}
        </div>

        {/* 子任务 */}
        {children.length > 0 ? (
          <>
            <div className="section-title" style={{ marginTop: 20 }}>
              子任务<span className="count">{children.length}</span>
            </div>
            <div className="panel" style={{ marginBottom: 10 }}>
              子任务默认绑定根任务的同一 thread_id，在串内以子任务卡展示。
              首版最多 6 个子任务、拆分深度最多 1 层；成员需要再拆分时向协调者提交提案。
            </div>
            {children.map((c) => (
              <div
                key={c.id}
                className="card tight"
                style={{ marginBottom: 8, cursor: 'pointer' }}
                onClick={() => navigate(`/project/${c.projectId}/room/${c.roomId}?thread=${c.conversationThreadId}&tab=task`)}
              >
                <div className="row tight wrap">
                  <span className="root-task-no">#{c.roomTaskNumber}</span>
                  <TaskStatusTag status={c.status} />
                  <span className="strong" style={{ fontSize: 12 }}>{c.title}</span>
                  <div className="spacer" />
                  <Tag plain icon="user">{memberLabel(byId(s.members, c.ownerMemberId))}</Tag>
                </div>
                <div className="small muted" style={{ marginTop: 4 }}>{c.objective}</div>
              </div>
            ))}
          </>
        ) : null}

        {/* 成果与改动 */}
        <div className="grid grid-2" style={{ marginTop: 20 }}>
          <div>
            <div className="section-title">相关成果<span className="count">{arts.length}</span></div>
            {arts.length === 0 ? (
              <div className="small faint">还没有成果。</div>
            ) : (
              arts.map((a) => (
                <div key={a.id} className="card tight" style={{ marginBottom: 8, cursor: 'pointer' }} onClick={() => navigate(`/project/${s.activeProjectId}/room/${thread?.roomId ?? ''}?thread=${thread?.id ?? ''}&tab=artifacts&artifact=${a.id}`)}>
                  <div className="row tight">
                    <Icon name="file-text" size={14} className="faint" />
                    <span className="strong truncate" style={{ fontSize: 12 }}>{a.title}</span>
                    <div className="spacer" />
                    <Tag plain>R{a.revision}</Tag>
                  </div>
                </div>
              ))
            )}
          </div>
          <div>
            <div className="section-title">改动集<span className="count">{changes.length}</span></div>
            {changes.length === 0 ? (
              <div className="small faint">该任务没有产生文件改动。</div>
            ) : (
              changes.map((c) => (
                <div key={c.id} className="card tight" style={{ marginBottom: 8, cursor: 'pointer' }} onClick={() => navigate(`/project/${s.activeProjectId}/changes`)}>
                  <div className="row tight">
                    <Icon name="diff" size={14} className="faint" />
                    <span className="strong" style={{ fontSize: 12 }}>{c.files.length} 个文件</span>
                    <div className="spacer" />
                    <Tag
                      tone={c.applicationStatus === 'reverted' ? 'neutral' : c.applicationStatus === 'applied' ? 'success' : 'warning'}
                      icon={c.applicationStatus === 'reverted' ? 'corner-up-left' : c.applicationStatus === 'applied' ? 'check-circle' : 'eye'}
                      title="文件应用状态；人工验收在任务交付里"
                    >
                      {c.applicationStatus === 'reverted' ? '已还原' : c.applicationStatus === 'applied' ? '已应用' : c.applicationStatus === 'partial' ? '部分应用' : '未应用'}
                    </Tag>
                  </div>
                  <div className="mono-sm" style={{ marginTop: 4 }}>after {c.afterRef}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {steerOpen ? (
        <div className="scrim center" onClick={() => setSteerOpen(false)}>
          <div className="modal md" onClick={(e) => e.stopPropagation()}>
            <div className="overlay-head">
              <div style={{ flex: 1 }}>
                <div className="overlay-title">定向跟进子任务</div>
                <div className="small muted" style={{ marginTop: 2 }}>
                  经 task.steer 交付该子任务负责人，不经协调者转述
                </div>
              </div>
              <button className="icon-btn" onClick={() => setSteerOpen(false)}><Icon name="x" size={15} /></button>
            </div>
            <div className="overlay-body">
              <div className="field">
                <label className="field-label">内容</label>
                <textarea
                  className="textarea"
                  rows={4}
                  value={steerBody}
                  onChange={(e) => setSteerBody(e.target.value)}
                  placeholder="例如：先只改 scripts/ 下的两个文件，不要动 src/"
                />
              </div>
              <div className="panel">
                支持实时 steering 的 adapter 会把内容送入当前 turn 并回执；不支持时排到本轮结束后处理，
                界面会显示"将在本轮结束后处理"。不会向任意 CLI 的 stdin 追加文字并假设它接收了新指令。
              </div>
            </div>
            <div className="overlay-foot">
              <div className="spacer" />
              <button className="btn" onClick={() => setSteerOpen(false)}>取消</button>
              <button
                className="btn primary"
                disabled={!steerBody.trim()}
                onClick={() => {
                  steerSubtask(task.id, steerBody.trim(), 'after_turn');
                  setSteerBody('');
                  setSteerOpen(false);
                }}
              >
                <Icon name="send" size={12} /> 交付该子任务
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ============================================================
   研讨详情（§17.2：初稿、互评、争议、确认矩阵；缺席、超时、未确认明确展示）
   ============================================================ */

export function DeliberationPage({ runId, host }: { runId: string; host?: DetailHost }) {
  const s = useStore((x) => x);
  const run = s.runs.find((r) => r.id === runId);
  if (!run) {
    return (
      <div className={hostClass(host, 'main')}>
        <div className={hostClass(host, 'page')}>
          <ErrorState code="ARTIFACT_MISSING" detail="找不到该运行。" />
        </div>
      </div>
    );
  }
  const task = taskOf(s, run.taskId);
  const turns = s.turns.filter((t) => t.runId === run.id);
  const issues = s.issues.filter((i) => i.runId === run.id);
  const participants = Array.from(new Set(turns.map((t) => t.memberId))).map((id) => byId(s.members, id)!).filter(Boolean);
  const absent = s.members.filter((m) => !turns.some((t) => t.memberId === m.id));
  const stageIndex = STAGES.findIndex((x) => x.key === run.stage);
  const absence = s.absence[run.threadId];
  const timeoutReached = Boolean(absence && Date.now() - absence.since >= absence.graceMs);
  const timedOut = Boolean(absence && (absence.continued || timeoutReached));
  const timeoutHandled = Boolean(absence?.continued);
  const absenceMinutes = absence ? Math.max(0, Math.round((Date.now() - absence.since) / 60000)) : 0;

  // 缺席与迟到（E4 / AT-05/06）
  const absentIds = absent.map((m) => m.id);
  const lateIds = turns.filter((t) => t.status === 'SUCCEEDED' && t.attempt > 1).map((t) => t.memberId);

  return (
    <div className={hostClass(host, 'main')}>
      <div className={hostClass(host, 'page')}>
        <div className="page-head">
          <div>
            <div className="row tight wrap">
              <Tag tone="accent" icon="layers">研讨详情</Tag>
              <RunStatusTag status={run.status} />
              <Tag plain icon="git-commit">{run.mode}</Tag>
              {task ? <span className="root-task-no">#{task.roomTaskNumber}</span> : null}
            </div>
            <div className="page-title" style={{ marginTop: 8 }}>{task?.title ?? '研讨运行'}</div>
            <div className="page-sub mono">runId {run.id} · taskRevision {run.taskRevision} · rosterRevision {run.rosterRevision}</div>
          </div>
          <div className="page-head-actions">
            <ConsensusTag
              consensus={run.consensus ?? 'unconfirmed'}
              // 有缺席成员时绝不显示"全体一致"
              label={consensusLabel(run.consensus ?? 'unconfirmed', absentIds, lateIds)}
            />
            {timedOut ? <Tag tone="warning" icon="clock">{timeoutHandled ? '已超时 · 按缺席继续' : '已超时 · 待处理'}</Tag> : null}
          </div>
        </div>

        {timedOut && absence ? (
          <div className="panel warning" style={{ marginBottom: 16 }}>
            <div className="panel-title"><Icon name="clock" size={13} /> {timeoutHandled ? '超时已处理' : '已达到缺席容忍时间'}</div>
            {memberLabel(byId(s.members, absence.memberId))} 等待了 {absenceMinutes} 分钟，超过缺席容忍 {Math.round(absence.graceMs / 60000)} 分钟。
            {timeoutHandled
              ? '本阶段已按缺席继续，不打断仍在运行的成员；迟到成果到达后会按阶段规则并入，并在确认矩阵中保留迟到标记。'
              : '等待调度器确认继续或重试；不会把缺席成员静默算作已完成。'}
          </div>
        ) : null}

        {absentIds.length > 0 ? (
          <div className="panel warning" style={{ marginBottom: 16 }}>
            <div className="panel-title"><Icon name="user-minus" size={13} /> 有成员未参与本轮</div>
            {absent.map((m) => (
              <div key={m.id} className="row tight" style={{ marginTop: 3 }}>
                <span className="strong">{memberLabel(m)}</span>
                <span className="faint">{m.workStateReason ?? '本运行没有它的调用记录'}</span>
              </div>
            ))}
            阶段屏障不默认把缺席者当作已完成。最终报告会列出缺席成员，不会标注"全体一致"。
            <div className="panel-actions">
              <button className="btn sm" onClick={() => retryTask(run.taskId, 'strict')}>重试缺席成员</button>
              <button className="btn sm" onClick={() => allowMissing(run.id, absentIds)}>按现有成员继续</button>
            </div>
          </div>
        ) : null}

        {/* 阶段条 */}
        <div className="section-title">阶段推进</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 0, alignItems: 'stretch', overflowX: 'auto', paddingBottom: 4 }}>
            {STAGES.map((st, i) => {
              const state = i < stageIndex ? 'done' : i === stageIndex ? 'current' : 'todo';
              const stageTurns = turns.filter((t) => t.stageKey === st.key);
              return (
                <div
                  key={st.key}
                  style={{
                    flex: '1 1 0', minWidth: 132, padding: '10px 11px',
                    borderRight: i < STAGES.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                    background: state === 'current' ? 'var(--accent-soft)' : 'transparent',
                  }}
                >
                  <div className="row tight">
                    <Icon
                      name={state === 'done' ? 'check-circle' : state === 'current' ? 'play' : 'circle'}
                      size={13}
                      style={{ color: state === 'done' ? 'var(--success)' : state === 'current' ? 'var(--accent)' : 'var(--text-4)' }}
                    />
                    <span className="strong" style={{ fontSize: 12 }}>{st.label}</span>
                  </div>
                  <div className="small faint" style={{ marginTop: 4, lineHeight: 1.55 }}>{st.note}</div>
                  <div className="small faint" style={{ marginTop: 5 }}>{stageTurns.length} 次调用</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 确认矩阵 */}
        <div className="section-title">确认矩阵<span className="count">{issues.length} 条争议</span></div>
        <div className="card" style={{ padding: 0, marginBottom: 18 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ minWidth: 260 }}>争议 / 结论</th>
                <th style={{ width: 90 }}>状态</th>
                {participants.map((p) => (
                  <th key={p.id} style={{ width: 96, textAlign: 'center' }}>{memberLabel(p)}</th>
                ))}
                {absent.map((p) => (
                  <th key={p.id} style={{ width: 96, textAlign: 'center', opacity: 0.6 }}>{memberLabel(p)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {issues.map((iss) => {
                return (
                  <tr key={iss.id}>
                    <td>
                      <div className="small">{iss.statement}</div>
                      <div className="small faint" style={{ marginTop: 3 }}>
                        修订 r{iss.revision} · 证据 {iss.evidenceRefs.length} 项
                      </div>
                    </td>
                    <td>
                      <Tag
                        tone={iss.status === 'open' ? 'danger' : iss.status === 'needs_user' ? 'warning' : iss.status === 'resolved' ? 'success' : 'neutral'}
                        icon={iss.status === 'open' ? 'alert-circle' : iss.status === 'needs_user' ? 'hand' : iss.status === 'resolved' ? 'check-circle' : 'help-circle'}
                      >
                        {iss.status === 'open' ? '开放' : iss.status === 'needs_user' ? '需你决定' : iss.status === 'resolved' ? '已解决' : '证据不足'}
                      </Tag>
                    </td>
                    {participants.map((p) => {
                      const pos = iss.positions.find((x) => x.memberId === p.id);
                      return (
                        <td key={p.id} style={{ textAlign: 'center' }}>
                          {pos ? (
                            <Tag
                              tone={pos.stance === 'agree' ? 'success' : pos.stance === 'disagree' ? 'danger' : pos.stance === 'needs_evidence' ? 'warning' : 'neutral'}
                              icon={pos.stance === 'agree' ? 'check' : pos.stance === 'disagree' ? 'x' : 'help-circle'}
                              title={pos.reason}
                            >
                              {pos.stance === 'agree' ? '同意' : pos.stance === 'disagree' ? '反对' : pos.stance === 'needs_evidence' ? '要证据' : '未确认'}
                            </Tag>
                          ) : (
                            <span className="small faint" title="该成员对这一修订版没有记录立场">—</span>
                          )}
                        </td>
                      );
                    })}
                    {absent.map((p) => (
                      <td key={p.id} style={{ textAlign: 'center' }}>
                        <Tag tone="neutral" icon="user-minus">未参与</Tag>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="panel info" style={{ marginBottom: 18 }}>
          <div className="panel-title"><Icon name="scale" size={13} /> 共识状态是算出来的，不是写出来的</div>
          <code>unanimous</code> 要求所有预期成员明确同意该版本且无保留异议；存在条件性同意是
          <code> qualified</code>，必须保留条件；有未解决反对是 <code>disputed</code>；
          有成员未回复、失败或缺席则是 <code>unconfirmed</code>。主持者不能单方面把反对标成同意。
        </div>

        {/* 独立初稿 */}
        <div className="section-title">独立初稿（INDEPENDENT）</div>
        <div className="panel" style={{ marginBottom: 10 }}>
          首轮建立新的任务专用会话，不复用已经看过同题其他报告的会话。上下文装配、消息读取、搜索与成果读取都按阶段过滤，
          不是只在提示词里写"不要看其他报告"。三份初稿的 baselineId 相同，说明大家分析的是同一份内容而不是同一批路径。
        </div>
        <div className="grid grid-3">
          {participants.map((p) => {
            const turn = turns.find((t) => t.memberId === p.id && t.stageKey === 'INDEPENDENT');
            return (
              <div key={p.id} className="card tight">
                <div className="row tight">
                  <Avatar name={p.displayName} ordinal={p.ordinal} color={memberColor(p.id, p.ordinal)} size={22} state={p.workState} />
                  <span className="strong" style={{ fontSize: 12 }}>{memberLabel(p)}</span>
                  <div className="spacer" />
                  {turn ? <TurnStatusTag status={turn.status} /> : <Tag tone="neutral" icon="user-minus">未参与</Tag>}
                </div>
                <div className="small faint" style={{ marginTop: 6 }}>
                  {turn ? `baseline baseline_a1f9 · 同一题目与基线 · ${turn.durationMs ? formatDuration(turn.durationMs) : ''}` : '无调用记录'}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   运行详情（§17.2：工具活动、用量、错误、原始诊断；已停止、结果不确定分别显示）
   ============================================================ */

export function RunDetailPage({ runId, host }: { runId: string; host?: DetailHost }) {
  const s = useStore((x) => x);
  const run = s.runs.find((r) => r.id === runId);
  if (!run) {
    return (
      <div className={hostClass(host, 'main')}>
        <div className={hostClass(host, 'page')}>
          <ErrorState code="ARTIFACT_MISSING" detail="找不到该运行。" />
        </div>
      </div>
    );
  }
  const turns = s.turns.filter((t) => t.runId === run.id);
  const task = taskOf(s, run.taskId);
  const diags = s.diagnostics.filter((d) => d.trace.runId === run.id);

  const totals = turns.reduce(
    (acc, t) => {
      if (!t.usage) return acc;
      acc.input += t.usage.inputTokens;
      acc.cached += t.usage.cachedInputTokens;
      acc.output += t.usage.outputTokens;
      acc.cost += t.usage.costAmount ?? 0;
      if (t.usage.costQuality === 'unknown') acc.unknownCost += 1;
      else acc.knownCost += 1;
      return acc;
    },
    { input: 0, cached: 0, output: 0, cost: 0, unknownCost: 0, knownCost: 0 },
  );

  return (
    <div className={hostClass(host, 'main')}>
      <div className={hostClass(host, 'page')}>
        <div className="page-head">
          <div>
            <div className="row tight wrap">
              <Tag tone="accent" icon="terminal">运行详情</Tag>
              <RunStatusTag status={run.status} />
              {task ? <span className="root-task-no">#{task.roomTaskNumber}</span> : null}
            </div>
            <div className="page-title" style={{ marginTop: 8 }}>{task?.title ?? '运行'}</div>
            <div className="page-sub mono">
              runId {run.id} · stage {run.stage} · round {run.roundNo} · rosterRevision {run.rosterRevision}
            </div>
          </div>
          <div className="page-head-actions">
            <button className="btn sm" onClick={() => navigate(`/deliberation/${run.id}`)}>
              <Icon name="layers" size={12} /> 研讨详情
            </button>
          </div>
        </div>

        {run.status === 'INTERRUPTED' ? (
          <ErrorState
            code="RECONCILE_REQUIRED"
            detail="调用结果不确定：不能盲目重派，需要先核对实际状态（进程、会话、文件与成果散列）。"
            actions={<button className="btn primary sm" onClick={() => retryTask(run.taskId, 'summary')}>按摘要新建会话重试</button>}
          />
        ) : null}

        {/* 用量 */}
        <div className="section-title" style={{ marginTop: 14 }}>用量与费用</div>
        <div className="grid grid-4">
          <div className="card tight">
            <div className="small faint">输入 token</div>
            <div className="strong" style={{ fontSize: 17 }}>{formatTokens(totals.input)}</div>
            <div className="small faint">其中缓存 {formatTokens(totals.cached)}</div>
          </div>
          <div className="card tight">
            <div className="small faint">输出 token</div>
            <div className="strong" style={{ fontSize: 17 }}>{formatTokens(totals.output)}</div>
            <div className="small faint">区分输入/缓存/输出，不把累计值当增量相加</div>
          </div>
          <div className="card tight">
            <div className="small faint">费用（已上报）</div>
            <div className="strong" style={{ fontSize: 17 }}>{formatCostSum(totals.cost, totals.knownCost)}</div>
            <div className="small faint">{totals.knownCost} 次有可比账单数据</div>
          </div>
          <div className="card tight">
            <div className="small faint">费用未知</div>
            <div className="strong" style={{ fontSize: 17 }}>{totals.unknownCost} 次</div>
            <div className="small faint">未知显示为未知，绝不折算成 0</div>
          </div>
        </div>

        <div className="panel" style={{ marginTop: 10 }}>
          费用字段区分 <code>reported / estimated / unknown</code>：不同 CLI 不具备可比的真实账单能力。
          token 区分输入、缓存、输出并保存原始口径；累计 usage 事件不会重复求和。
          费用预算若无 runtime 硬限额只能标成软控制，严格停止依靠调用次数、工具权限与时间约束。
        </div>

        {/* turn 列表 */}
        <div className="section-title" style={{ marginTop: 20 }}>成员调用<span className="count">{turns.length}</span></div>
        <div className="card" style={{ padding: 0 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>成员</th>
                <th>阶段</th>
                <th>状态</th>
                <th>尝试 / epoch</th>
                <th>时长</th>
                <th>用量</th>
                <th>费用</th>
                <th>dispatchKey</th>
              </tr>
            </thead>
            <tbody>
              {turns.map((t) => (
                <tr key={t.id}>
                  <td>
                    <span className="row tight">
                      <Avatar name={byId(s.members, t.memberId)?.displayName ?? '?'} ordinal={byId(s.members, t.memberId)?.ordinal} color={memberColor(t.memberId)} size={16} />
                      {memberLabel(byId(s.members, t.memberId))}
                    </span>
                  </td>
                  <td className="small">{t.stageKey}</td>
                  <td><TurnStatusTag status={t.status} /></td>
                  <td className="mono-sm">{t.attempt} / {t.epoch}</td>
                  <td className="small">{t.durationMs ? formatDuration(t.durationMs) : t.status === 'RUNNING' ? `已 ${formatDuration(Date.now() - t.startedAt)}` : '—'}</td>
                  <td className="mono-sm">
                    {t.usage ? `入 ${formatTokens(t.usage.inputTokens)} · 出 ${formatTokens(t.usage.outputTokens)}` : '—'}
                  </td>
                  <td>
                    {t.usage ? <CostText quality={t.usage.costQuality} amount={t.usage.costAmount} /> : <span className="faint">—</span>}
                  </td>
                  <td className="mono-sm">{t.dispatchKey}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 诊断 */}
        <div className="section-title" style={{ marginTop: 20 }}>
          诊断<span className="count">{diags.length}</span>
        </div>
        <div className="panel" style={{ marginBottom: 10 }}>
          每条诊断带 projectId、taskId、runId、turnId、dispatchKey、adapterVersion，便于从结果追溯到报告、输入清单与工具验证记录。
          导出时默认脱敏凭据、环境变量值和敏感路径片段。
        </div>
        {diags.length === 0 ? (
          <div className="small faint">本运行没有额外诊断。</div>
        ) : (
          diags.map((d) => (
            <div key={d.id} className="card tight" style={{ marginBottom: 6 }}>
              <div className="row tight wrap">
                <Tag tone={d.level === 'error' ? 'danger' : d.level === 'warn' ? 'warning' : 'neutral'} icon={d.level === 'error' ? 'x-circle' : d.level === 'warn' ? 'alert-triangle' : 'info'}>
                  {d.level}
                </Tag>
                <span className="small">{d.message}</span>
                <div className="spacer" />
                <span className="small faint">{relTime(d.at)}</span>
              </div>
              <div className="mono-sm" style={{ marginTop: 4 }}>
                {Object.entries(d.trace).map(([k, v]) => `${k}=${v}`).join('  ')}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatCostSum(sum: number, knownCount: number) {
  if (knownCount === 0) return '—';
  return `$${sum.toFixed(4)}`;
}

/* ============================================================
   任务看板（第十五批 §17.7：外层项目分组 → 内层状态分组）
   ============================================================ */

/**
 * 范围三态：
 *  - visible（默认）：侧栏可见项目，按侧栏保存的顺序分组
 *  - project：单个项目；选它要**同步焦点**并确保在侧栏可见
 *  - all：全部可访问项目
 *
 * 原实现只按房间过滤、任务取全量，副标题却写"当前项目的全部任务"——
 * 两个项目的数据混在一张列表里，同名房间与同号任务无法区分。
 * 现在外层按项目分组，卡片自带项目与房间来源。
 */
type BoardScope = 'visible' | 'project' | 'all';

export function TasksBoardPage({ query }: { query?: Record<string, string> }) {
  const s = useStore((x) => x);
  const q = query ?? {};
  const scope: BoardScope =
    q.scope === 'project' ? 'project' : q.scope === 'all' ? 'all' : 'visible';
  const scopeProjectId = q.projectId ?? s.activeProjectId;
  const [roomFilter, setRoomFilter] = useState(q.roomId ?? 'all');

  const setParam = (patch: Record<string, string>) => {
    const qs = new URLSearchParams({ scope, projectId: scopeProjectId, roomId: roomFilter, ...patch });
    navigate(`/tasks?${qs.toString()}`, { replace: true });
  };

  /** 当前范围包含的项目，按侧栏保存的顺序（§17.7：不因切焦点而重排） */
  const boardProjects = useMemo(() => {
    if (scope === 'all') return s.projects;
    if (scope === 'project') {
      const p = s.projects.find((x) => x.id === scopeProjectId);
      return p ? [p] : [];
    }
    return s.visibleProjectIds
      .map((id) => s.projects.find((p) => p.id === id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p));
  }, [scope, scopeProjectId, s.projects, s.visibleProjectIds]);

  const boardProjectIds = boardProjects.map((p) => p.id);

  /**
   * 房间下拉只取**当前范围内**的房间（§17.7）。
   * 否则切 scope 后旧 roomId 仍在下拉里，会继续展示上一个范围的数据。
   */
  const scopeRooms = s.rooms.filter((r) => boardProjectIds.includes(r.projectId));

  // 范围变化后失效的 roomId 必须清空并提示，不能继续展示旧房间数据
  const roomStillValid = roomFilter === 'all' || scopeRooms.some((r) => r.id === roomFilter);
  useEffect(() => {
    if (!roomStillValid) {
      setRoomFilter('all');
      toast('筛选范围已变化，原来的房间筛选已清空', 'info');
    }
  }, [roomStillValid]);

  /** 默认列根任务；子任务在父任务展开区看，不重复计为另一项交付（§17.7） */
  const tasksOf = (projectId: string) =>
    s.tasks.filter(
      (t) =>
        t.projectId === projectId &&
        !t.parentTaskId &&
        (roomFilter === 'all' || t.roomId === roomFilter),
    );

  const groups: { label: string; statuses: TaskStatus[] }[] = [
    { label: '待开始', statuses: ['OPEN'] },
    { label: '执行中', statuses: ['ACTIVE'] },
    { label: '等我处理', statuses: ['WAITING_USER'] },
    { label: '阻塞', statuses: ['BLOCKED'] },
    { label: '待审阅', statuses: ['REVIEW'] },
    { label: '已完成', statuses: ['DONE'] },
    { label: '已取消', statuses: ['CANCELLED'] },
  ];

  const totalCount = boardProjectIds.reduce((n, pid) => n + tasksOf(pid).length, 0);

  return (
    <div className="main">
      <div className="page">
        <div className="page-head">
          <div>
            <div className="page-title">任务看板</div>
            <div className="page-sub">
              按项目分组，项目内再按状态分组。两处同名房间、同号任务也能区分——
              卡片自带来源项目；房间内看板只看本房间。点击卡片打开所属回复串的「任务详情」tab；
              编号只用于显示，稳定 ID 才是主键。
            </div>
          </div>
        </div>

        {/* 筛选控件统一放内容区左上角（不塞进页头右侧）：
            从侧栏进来后鼠标就在左侧，不必横跨整屏去操作；
            也避免筛选控件把标题挤窄。所有筛选行共用 .page-filters 的统一样式。 */}
        <div className="page-filters">
          <label className="field inline">
            <span className="field-label">范围</span>
            <select
              className="select"
              value={scope}
              onChange={(e) => {
                const next = e.target.value as BoardScope;
                // 选"单个项目"时同步焦点并确保它在侧栏可见（§17.7）
                if (next === 'project') focusProject(scopeProjectId, { announce: true });
                setParam({ scope: next, roomId: 'all' });
              }}
            >
              <option value="visible">侧栏可见项目</option>
              <option value="project">单个项目</option>
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
                  focusProject(next, { announce: true });
                  setParam({ projectId: next, roomId: 'all' });
                }}
              >
                {s.projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.displayName}</option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="field inline">
            <span className="field-label">房间</span>
            <select
              className="select"
              value={roomFilter}
              onChange={(e) => setRoomFilter(e.target.value)}
            >
              <option value="all">当前范围全部房间</option>
              {scopeRooms.map((r) => {
                const p = s.projects.find((x) => x.id === r.projectId);
                // 同名房间必须带项目名才能区分
                return (
                  <option key={r.id} value={r.id}>
                    {p?.displayName} · {r.name}
                  </option>
                );
              })}
            </select>
          </label>

          <span className="filter-note">
            共 {totalCount} 项 · 范围与侧栏勾选一致
          </span>
        </div>

        {totalCount === 0 ? (
          <EmptyState
            icon="list"
            title="这个范围里还没有任务"
            detail="在对话池发布一条任务后，看板会按项目与状态自动分组。"
          />
        ) : (
          boardProjects.map((p) => {
            const list = tasksOf(p.id);
            return (
              <div key={p.id} className="section" style={{ marginBottom: 22 }}>
                <div className="section-title">
                  <Icon name="folder" size={14} />
                  {p.displayName}
                  <span className="count">{list.length} 项</span>
                  {p.id === s.activeProjectId ? <Tag tone="accent">当前</Tag> : null}
                  {p.status === 'missing' ? <Tag tone="danger">目录失效</Tag> : null}
                </div>

                {list.length === 0 ? (
                  <div className="panel">
                    这个项目在当前筛选下没有任务。
                    {p.status === 'missing' ? '（项目目录已失效，仍保留历史记录）' : ''}
                  </div>
                ) : (
                  groups.map((g) => {
                    const inGroup = list.filter((t) => g.statuses.includes(t.status));
                    if (inGroup.length === 0) return null;
                    return (
                      <div key={g.label} style={{ marginBottom: 12 }}>
                        <div className="row tight" style={{ marginBottom: 6 }}>
                          <span className="small strong">{g.label}</span>
                          <span className="small faint">{inGroup.length}</span>
                        </div>
                        <div className="grid grid-3">
                          {inGroup.map((t) => {
                            const room = s.rooms.find((r) => r.id === t.roomId);
                            const owner = s.members.find((m) => m.id === t.ownerMemberId);
                            const run = s.runs.find((r) => r.taskId === t.id);
                            const subs = s.tasks.filter((x) => x.parentTaskId === t.id);
                            return (
                              <div
                                key={t.id}
                                className="card"
                                style={{ cursor: 'pointer' }}
                                // 用任务自己的 projectId/roomId/threadId 导航，
                                // 不能拿全局 activeProjectId 拼链接（§17.7）
                                onClick={() => {
                                  focusProject(t.projectId, { announce: false });
                                  navigate(
                                    `/project/${t.projectId}/room/${t.roomId}?thread=${t.conversationThreadId}&tab=task`,
                                  );
                                }}
                              >
                                <div className="row tight wrap">
                                  <span className="root-task-no">#{t.roomTaskNumber}</span>
                                  <TaskStatusTag status={t.status} />
                                  {run ? <Tag plain icon="git-commit">{run.mode}</Tag> : null}
                                </div>
                                <div className="strong" style={{ marginTop: 6, fontSize: 12.5 }}>{t.title}</div>
                                <div className="row tight wrap small faint" style={{ marginTop: 8 }}>
                                  {/* 项目名与房间名都标出：同名房间靠项目名区分 */}
                                  <Tag tone="accent" icon="folder">{p.displayName}</Tag>
                                  <Tag plain icon="hash">{room?.name ?? t.roomId}</Tag>
                                  {owner ? <Tag plain icon="user">{memberLabel(owner)}</Tag> : null}
                                  {subs.length > 0 ? <Tag plain>{subs.length} 个子任务</Tag> : null}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* 文件到此结束：不要把 store 或 format 的符号从这里再导出一次，
   否则 Vite Fast Refresh 会因"混用了组件与非组件导出"而整页失效。 */
