/**
 * 任务交付与可选验收（v1.12 §10.5 / RT-25，第十四批）。
 *
 * 命令名全部来自 §15.2 新增命令面：
 *   project.reviewPolicy.set / task.delivery.review / task.delivery.get
 *
 * 四条不可违反的规则（来自 §10.5，本文件逐条体现）：
 *  1. **开关只影响新任务**：改设置不动已有任务的 reviewPolicy，也不清理待验收卡。
 *  2. **验收决定必须针对具体版本**：校验 deliveryId + revision + manifestHash，
 *     被替代版本的按钮必须失败并刷新，不能批准新版本。
 *  3. **验收通过不做任何文件/Git 操作**：不改 applicationStatus、不 stage、不 commit、
 *     不 push，也不顺带批准权限请求。要求修改同理：不 reset、不撤销提交、不删成果。
 *  4. **一个任务最多一个 pending 交付**：返工递增 revision 并替换当前待办，不追加。
 */

import { getState, setState, recordWrite, toast } from './store';
import type { TaskDelivery } from './types';

const now = () => Date.now();

/* ============================================================
   project.reviewPolicy.set —— 项目设置里的「任务验收」开关
   ============================================================ */

export function setTaskReviewEnabled(projectId: string, enabled: boolean) {
  const s = getState();
  const project = s.projects.find((p) => p.id === projectId);
  if (!project) return;

  const pendingElsewhere = s.taskDeliveries.filter(
    (d) => d.status === 'pending' && s.tasks.some((t) => t.id === d.taskId && t.projectId === projectId),
  ).length;

  setState((st) => ({
    ...st,
    projects: st.projects.map((p) =>
      p.id === projectId
        ? { ...p, taskReviewEnabled: enabled, taskReviewMigrated: false, revision: p.revision + 1 }
        : p,
    ),
  }));

  recordWrite(
    'project.reviewPolicy.set',
    `project=${projectId} taskReviewEnabled=${enabled} → 仅影响新任务；已有任务 reviewPolicy 不变，未批量变更待验收卡`,
  );

  /*
   * 提示必须点明两件事，否则用户会以为开关能追溯：
   *  - 只影响新任务
   *  - 已有待验收卡仍在（依据它创建时的规则）
   * §10.5 明确要求这一句，且不提供隐式「全部同意」。
   */
  if (!enabled && pendingElsewhere > 0) {
    toast(
      `已关闭任务验收：仅影响新任务。还有 ${pendingElsewhere} 个已有任务按创建时的规则等待验收，不会被自动通过`,
      'warn',
    );
  } else {
    toast('已保存：仅影响新任务，已有任务保持原规则', 'success');
  }
}

/* ============================================================
   task.delivery.review —— 验收通过 / 要求修改
   ============================================================ */

export type ReviewDecision = 'accept' | 'request_changes';

export function reviewDelivery(input: {
  deliveryId: string;
  /** 页面上按钮所针对的版本；与当前版本不符即拒绝 */
  expectedRevision: number;
  expectedManifestHash: string;
  decision: ReviewDecision;
  /** 「要求修改」必填 */
  note?: string;
}) {
  const s = getState();
  const d = s.taskDeliveries.find((x) => x.id === input.deliveryId);
  if (!d) {
    toast('找不到该交付版本，可能已被更新', 'error');
    return;
  }

  /* ---- 版本校验：防止旧页面按钮批准新结果（RT-25 ⑥） ---- */
  if (d.revision !== input.expectedRevision || d.manifestHash !== input.expectedManifestHash) {
    recordWrite(
      'task.delivery.review',
      `delivery=${input.deliveryId} 版本冲突：页面 r${input.expectedRevision} vs 当前 r${d.revision} → 拒绝，要求重新查看`,
    );
    toast('交付版本已更新，请重新查看后再决定', 'warn');
    return;
  }

  /* ---- 幂等：已处理过的重复点击不重复生效 ---- */
  if (d.status !== 'pending') {
    const label = d.status === 'accepted' ? '已验收' : d.status === 'changes_requested' ? '已要求修改' : '无需验收';
    recordWrite('task.delivery.review', `delivery=${input.deliveryId} 重复提交 → 幂等返回（当前状态 ${d.status}）`);
    toast(`该交付已经是「${label}」状态，重复操作已忽略`, 'info');
    return;
  }

  if (input.decision === 'request_changes' && !input.note?.trim()) {
    toast('要求修改必须填写意见', 'warn');
    return;
  }

  if (input.decision === 'accept') {
    /*
     * 通过 = 只改三件事：交付状态、任务状态、待办。
     * 刻意**不碰**：changeSets.applicationStatus、git index/HEAD、approval。
     */
    setState((st) => ({
      ...st,
      taskDeliveries: st.taskDeliveries.map((x) =>
        x.id === d.id
          ? { ...x, status: 'accepted' as const, reviewedBy: 'you', reviewedAt: now() }
          : x,
      ),
      tasks: st.tasks.map((t) => (t.id === d.taskId ? { ...t, status: 'DONE' as const } : t)),
      attention: st.attention.filter((a) => a.deliveryId !== d.id),
    }));

    recordWrite(
      'task.delivery.review',
      `delivery=${d.id} revision=${d.revision} decision=accept manifestHash=${d.manifestHash} → task DONE；未改文件应用状态、未 stage/commit/push、未批准任何权限请求`,
    );
    toast('已验收通过。未提交或推送任何 Git 改动，也未批准权限请求', 'success');
    return;
  }

  /* ---- 要求修改：记录意见、关闭本轮待办、任务回 ACTIVE；不撤销提交、不删文件 ---- */
  setState((st) => ({
    ...st,
    taskDeliveries: st.taskDeliveries.map((x) =>
      x.id === d.id
        ? { ...x, status: 'changes_requested' as const, reviewedBy: 'you', reviewedAt: now(), reviewNote: input.note!.trim() }
        : x,
    ),
    tasks: st.tasks.map((t) => (t.id === d.taskId ? { ...t, status: 'ACTIVE' as const } : t)),
    attention: st.attention.filter((a) => a.deliveryId !== d.id),
  }));

  recordWrite(
    'task.delivery.review',
    `delivery=${d.id} revision=${d.revision} decision=request_changes → 任务回 ACTIVE；未 reset、未撤销提交、未删除成果。意见：${input.note!.trim().slice(0, 40)}`,
  );
  toast('已要求修改：交付内容与提交都原样保留，任务回到执行中继续返工', 'info');
}

/* ============================================================
   返工：发布新交付版本（原型用模拟按钮演示）
   ============================================================ */

/**
 * 发布返工后的新交付版本。
 *
 * §10.5 第 5 条：新版本**递增 revision 并替换当前待办目标**，
 * 不追加第二条未处理卡；旧版与意见保留。
 * 这里保留旧版本记录（status 仍为 changes_requested），只把 task.currentDeliveryId 指过去。
 */
/**
 * 发布返工后的新交付版本（模拟）。
 *
 * 关键：项目归属**从任务实体推导**，不由调用方传。
 * 早先签名是 `publishRework(projectId, taskId)`，调用处传的是全局
 * `s.activeProjectId` —— 若用户是在另一个项目上下文里打开这个任务
 * （聚合看板、跨项目搜索、深链），新待办就会带上**错误项目的 projectId**，
 * 于是"点待办跳转/补选项目"会指向错的项目的（§17.7 的异步与目标绑定要求）。
 * 改成只传 taskId，从 task.projectId 取，从根上消除这一类误用。
 */
export function publishRework(taskId: string) {
  const s = getState();
  const task = s.tasks.find((t) => t.id === taskId);
  if (!task) return;
  /** 归属以任务自身为准，绝不用调用方的当前项目 */
  const projectId = task.projectId;

  const history = s.taskDeliveries.filter((d) => d.taskId === taskId);
  const latest = history.reduce((max, d) => Math.max(max, d.revision), 0);
  const prev = history.find((d) => d.revision === latest);
  const nextRevision = latest + 1;
  const newId = `delivery_${taskId.replace(/[^a-z0-9]/gi, '')}_r${nextRevision}`;

  const delivery: TaskDelivery = {
    id: newId,
    taskId,
    runId: prev?.runId ?? `run_${taskId}`,
    revision: nextRevision,
    manifestHash: `sha256:mock${nextRevision}${Math.random().toString(16).slice(2, 8)}（原型伪摘要）`,
    status: 'pending',
    summary: prev
      ? `按你的意见返工后的第 ${nextRevision} 版交付。上一版意见：${prev.reviewNote ?? '（无）'}`
      : `第 ${nextRevision} 版交付。`,
    preview: [{ label: '改动范围', detail: '原型为模拟返工，不声称真实调用 runtime' }],
    verification: [
      {
        label: '返工后的验证',
        result: 'not_run',
        detail: '原型不执行真实命令，这里如实标记为未执行，不写成通过',
      },
    ],
    residuals: ['原型用模拟按钮演示返工流程，未接入真实 runtime'],
    artifactRefs: prev?.artifactRefs ?? [],
    changeSetRefs: prev?.changeSetRefs ?? [],
    commitRefs: [],
    createdAt: now(),
  };

  setState((st) => ({
    ...st,
    taskDeliveries: [...st.taskDeliveries, delivery],
    tasks: st.tasks.map((t) => (t.id === taskId ? { ...t, status: 'REVIEW' as const, currentDeliveryId: newId } : t)),
    // 旧待办已被上一轮 reviewDelivery 移除；这里为**新版本**新建唯一一条
    attention: [
      ...st.attention.filter((a) => !(a.deliveryId && a.deliveryId.startsWith(`delivery_${taskId.replace(/[^a-z0-9]/gi, '')}_r`))),
      {
        id: `att_${newId}`,
        kind: 'review' as const,
        projectId,
        roomId: task.roomId,
        threadId: task.conversationThreadId,
        deliveryId: newId,
        deliveryRevision: nextRevision,
        title: `任务 #${task.roomTaskNumber} 的返工交付等你验收`,
        detail: `第 ${nextRevision} 版交付已替换上一版待办；旧版与你的意见仍可查看。`,
        createdAt: now(),
        requiresAction: true,
      },
    ],
  }));

  recordWrite(
    'task.delivery.publish',
    `task=${taskId} → delivery=${newId} revision=${nextRevision}；替换当前待办（不是追加），旧版 r${latest} 与意见保留`,
  );
  toast(`已发布第 ${nextRevision} 版交付：它替换了上一版待办，旧版仍可查看`, 'success');
}

/* ============================================================
   只读选择器
   ============================================================ */

/** 任务的所有交付版本，按 revision 降序（最新在前） */
export function deliveriesOfTask(taskId: string): TaskDelivery[] {
  return getState()
    .taskDeliveries.filter((d) => d.taskId === taskId)
    .sort((a, b) => b.revision - a.revision);
}

/** 当前 pending 交付；没有则 undefined */
export function pendingDeliveryOfTask(taskId: string): TaskDelivery | undefined {
  return getState().taskDeliveries.find((d) => d.taskId === taskId && d.status === 'pending');
}

/**
 * 验收待办去重计数（侧栏角标用）。
 *
 * 按 deliveryId 去重 —— 这是 §10.5 第 7 条的要求：
 * 同一交付的多个文件 / ChangeSet / commit **不能各算一次**。
 * 权限请求（kind='approval'）单独由 pendingAction 统计，不混进这里。
 */
export function pendingReviewCount(): number {
  const s = getState();
  const ids = new Set(
    s.attention
      .filter((a) => a.kind === 'review' && a.requiresAction && !a.readAt && a.deliveryId)
      .map((a) => a.deliveryId!),
  );
  return ids.size;
}
