/**
 * 展示口径一致性工具。
 * 这里的规则对应设计报告里的硬约束，不是普通格式化函数：
 *  - §10.4 费用未知不得显示为 0（RT-17）
 *  - §6.5 有缺席/分歧时绝不能写「全体一致」（AT-05）
 *  - §17.5 状态必须文字 + 图标，不能只靠颜色
 */

import type { Consensus, ErrorCode, RouteMode, TaskStatus, TurnStatus, RunStatus } from '../data/types.js';

/* ---------- 费用（RT-17） ---------- */

export function formatCost(quality: 'reported' | 'estimated' | 'unknown', amount: number | null): string {
  if (quality === 'unknown' || amount === null) return '费用未知';
  const prefix = quality === 'estimated' ? '约 ' : '';
  return `${prefix}$${amount.toFixed(4)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/* ---------- 运行模型展示 ---------- */

export type RuntimeModelMetadata = {
  id: string;
  label: string;
  source: 'reported' | 'configured';
};

function modelNameWithoutRepeatedId(label: string, id: string): string {
  const clean = label.trim();
  const repeated = ` · ${id}`;
  return clean.endsWith(repeated) ? clean.slice(0, -repeated.length).trim() : clean;
}

function shortModelChannel(id: string, fallbackChannel: string): string {
  const separator = id.indexOf('/');
  return (separator > 0 ? id.slice(0, separator) : fallbackChannel).trim();
}

/** 常规界面只展示一次可读名称；模型 ID 相等时只去掉渠道前缀，不猜模型清单。 */
export function runtimeModelDisplayName(model: Pick<RuntimeModelMetadata, 'id' | 'label'>): string {
  const label = modelNameWithoutRepeatedId(model.label, model.id);
  if (label !== '' && label !== model.id) return label;
  const leaf = model.id.split('/').filter(Boolean).at(-1)?.trim();
  return leaf || model.id || '未命名模型';
}

/**
 * 选项的 value 始终是目录返回的完整 ID，label 只承担展示。
 * 仅当两个可读名称相同时，才追加短渠道帮助区分。
 */
export function runtimeModelPickerOptions(
  models: RuntimeModelMetadata[],
  { currentValue = '', channelFallback = '' }: { currentValue?: string; channelFallback?: string } = {},
): Array<{ value: string; label: string }> {
  const names = models.map(runtimeModelDisplayName);
  const nameCounts = new Map<string, number>();
  for (const name of names) {
    const key = name.toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  const options = models.map((model, index) => {
    const name = names[index] ?? runtimeModelDisplayName(model);
    if ((nameCounts.get(name.toLowerCase()) ?? 0) < 2) return { value: model.id, label: name };
    const channel = shortModelChannel(model.id, channelFallback);
    return { value: model.id, label: channel === '' ? name : `${name} · ${channel}` };
  });
  if (currentValue !== '' && !models.some((model) => model.id === currentValue)) {
    options.push({
      value: currentValue,
      label: runtimeModelDisplayName({ id: currentValue, label: currentValue }),
    });
  }
  return options;
}

/* ---------- 共识（AT-05 / §6.5） ---------- */

export const consensusCopy: Record<Consensus, { label: string; icon: string; tone: Tone }> = {
  unanimous: { label: '全体确认一致', icon: 'check-circle', tone: 'success' },
  qualified: { label: '有条件同意（保留条件）', icon: 'alert-circle', tone: 'warning' },
  disputed: { label: '存在未解决反对', icon: 'scale', tone: 'danger' },
  unconfirmed: { label: '有成员未确认', icon: 'help-circle', tone: 'neutral' },
};

/**
 * 带缺席或迟到成员时，任何输入都不能渲染成「全体一致」。
 * 这是程序性约束，不是文案偏好。
 */
export function consensusLabel(
  consensus: Consensus,
  absentMemberIds: string[] = [],
  lateMemberIds: string[] = [],
): string {
  if (absentMemberIds.length > 0) return '有成员缺席，不构成全体一致';
  if (consensus === 'unanimous' && lateMemberIds.length > 0) return '全体确认（含迟到纳入）';
  return consensusCopy[consensus]?.label ?? consensus;
}

/**
 * 结果卡的共识标签。
 * 只有共同研讨（DELIBERATE）才计算共识状态（§6.5 的确认矩阵）；
 * DIRECT / AUTO 不适用时返回 null，界面改为显示"无共识语义"。
 * 把这条判断放在这里，是为了让任何调用点都无法渲染出假共识。
 */
export function resultConsensusLabel(
  mode: RouteMode | undefined,
  consensus: Consensus | undefined,
  absentMemberIds: string[] = [],
  lateMemberIds: string[] = [],
): string | null {
  // mode 为空 = 讨论串或未知任务归属，同样不渲染共识
  if (mode !== 'DELIBERATE') return null;
  if (!consensus) return null;
  // 研讨模式下若出现缺席，无论如何都不能显示"全体一致"
  return consensusLabel(consensus, absentMemberIds, lateMemberIds);
}

/* ---------- 状态（§17.5：文字 + 图标） ---------- */

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

export const taskStatusCopy: Record<TaskStatus, { label: string; icon: string; tone: Tone }> = {
  OPEN: { label: '待开始', icon: 'circle', tone: 'neutral' },
  ACTIVE: { label: '执行中', icon: 'play', tone: 'info' },
  WAITING_USER: { label: '等你处理', icon: 'hand', tone: 'warning' },
  BLOCKED: { label: '阻塞', icon: 'octagon', tone: 'danger' },
  REVIEW: { label: '待审阅', icon: 'eye', tone: 'accent' },
  DONE: { label: '已完成', icon: 'check-circle', tone: 'success' },
  CANCELLED: { label: '已取消', icon: 'slash', tone: 'neutral' },
};

export const runStatusCopy: Record<RunStatus, { label: string; icon: string; tone: Tone }> = {
  QUEUED: { label: '排队中', icon: 'clock', tone: 'neutral' },
  RUNNING: { label: '运行中', icon: 'play', tone: 'info' },
  WAITING: { label: '等待成员', icon: 'pause', tone: 'warning' },
  STOPPING: { label: '正在停止', icon: 'loader', tone: 'warning' },
  SUCCEEDED: { label: '成功', icon: 'check-circle', tone: 'success' },
  PARTIAL: { label: '部分完成', icon: 'alert-circle', tone: 'warning' },
  FAILED: { label: '失败', icon: 'x-circle', tone: 'danger' },
  CANCELLED: { label: '已取消', icon: 'slash', tone: 'neutral' },
  INTERRUPTED: { label: '中断', icon: 'octagon', tone: 'danger' },
};

export const turnStatusCopy: Record<TurnStatus, { label: string; icon: string; tone: Tone }> = {
  PENDING: { label: '待派发', icon: 'clock', tone: 'neutral' },
  DISPATCHING: { label: '正在派发', icon: 'loader', tone: 'info' },
  RUNNING: { label: '运行中', icon: 'play', tone: 'info' },
  WAITING_APPROVAL: { label: '等待授权', icon: 'hand', tone: 'warning' },
  WAITING_INPUT: { label: '等待输入', icon: 'pause', tone: 'warning' },
  STOPPING: { label: '正在停止', icon: 'loader', tone: 'warning' },
  SUCCEEDED: { label: '成功', icon: 'check-circle', tone: 'success' },
  FAILED: { label: '失败', icon: 'x-circle', tone: 'danger' },
  CANCELLED: { label: '已取消', icon: 'slash', tone: 'neutral' },
  UNKNOWN: { label: '结果不明', icon: 'help-circle', tone: 'danger' },
};

export const memberWorkCopy: Record<string, { label: string; icon: string; tone: Tone }> = {
  running: { label: '工作中', icon: 'play', tone: 'info' },
  idle: { label: '空闲', icon: 'circle', tone: 'neutral' },
  waiting: { label: '等待中', icon: 'pause', tone: 'warning' },
  error: { label: '出错', icon: 'x-circle', tone: 'danger' },
  offline: { label: '离线', icon: 'wifi-off', tone: 'neutral' },
  stopped: { label: '已停止', icon: 'slash', tone: 'neutral' },
};

/* ---------- 路由模式（§4.2） ---------- */

export const routeModeCopy: Record<RouteMode, { label: string; detail: string }> = {
  AUTO: { label: '自动', detail: '无 @：默认协调者接单，可自行决定是否分工' },
  DELIBERATE: { label: '共同研讨', detail: '@全体 或多个 @：冻结名单、阶段推进' },
  DIRECT: { label: '指定成员', detail: '单个 @：仅该成员被调用，其他成员零调用' },
};

/* ---------- 19 个错误码（§16.5） ---------- */

export const errorCopy: Record<ErrorCode, { title: string; action: string }> = {
  RUNTIME_NOT_FOUND: { title: '找不到该 CLI', action: '指定 CLI 路径，或安装后重新检测' },
  AUTH_REQUIRED: { title: '需要登录', action: '按 CLI 官方方式登录后重试' },
  CAPABILITY_UNSUPPORTED: { title: '能力不支持', action: '本模式所需能力不支持，已列出可用方案' },
  PROVIDER_LIMITED: { title: 'provider 限流或额度受限', action: '任务已保留，稍后重试' },
  PROJECT_MISSING: { title: '项目目录不存在', action: '重新定位项目目录' },
  // v1.9 §14.1 / E20：并行模式下要显示写入者名单、策略与上限，而非笼统说"被占用"
  WORKSPACE_BUSY: {
    title: '写入目录被占用',
    action: '单写者策略：显示锁持有者与排队位置；并行策略：显示当前写入者名单、策略与写入者上限，超出上限的任务排队',
  },
  BASELINE_CHANGED: { title: '基线已变化', action: '重新生成分析基线或整合' },
  OUTPUT_INVALID: { title: '输出格式无效', action: '查看原始报告，有限修复或重试' },
  STALE_REVISION: { title: '版本已过期', action: '获取最新状态再提交修改' },
  STORAGE_UNAVAILABLE: { title: '存储不可用', action: '已停止新派发，修复磁盘或数据库后恢复' },
  WORKER_STILL_RUNNING: { title: '仍在停止中', action: '不能释放写入锁' },
  RECONCILE_REQUIRED: { title: '调用结果不确定', action: '先核对实际状态，不能盲目重派' },
  BUDGET_EXHAUSTED: { title: '预算已耗尽', action: '显示已有成果和未完成项，可增加预算继续' },
  ARTIFACT_MISSING: { title: '成果缺失', action: '恢复备份或重新生成' },
  THREAD_SCOPE_MISMATCH: { title: '回复目标与任务不一致', action: '已拒绝提交，草稿保留' },
  CONTEXT_NOT_GRANTED: { title: '未获准读取该引用', action: '不能自动扩大范围' },
  ROOM_ARCHIVED: { title: '房间已归档', action: '不能新增任务，可查看既有记录' },
  IDEMPOTENCY_CONFLICT: { title: '命令重复冲突', action: '同一 commandId 以不同内容重复提交，请用新 commandId' },
  SNAPSHOT_REQUIRED: { title: '事件游标过旧', action: '重新拉取快照与读取水位后再订阅' },
  PROJECT_NOT_FOUND: { title: '项目不存在或不可访问', action: '检查链接里的项目 ID；不会回退到当前项目的同号对象' },
};

/* ---------- 研讨阶段：内部枚举 → 面向用户的中文名 ---------- */

export const stageCopy: Record<string, string> = {
  PREPARE: '准备',
  INDEPENDENT: '独立分析',
  CROSS_REVIEW: '互评',
  ISSUE_DISCUSSION: '分歧讨论',
  SYNTHESIS: '整合',
  RATIFY: '确认',
  PUBLISH: '发布',
};

/** 主界面不裸露 ISSUE_DISCUSSION 这类内部枚举（评审意见 5） */
export function stageLabel(stage: string): string {
  return stageCopy[stage] ?? stage;
}

/* ---------- 时间 ---------- */

export function relTime(ts: number, now = Date.now()): string {
  const d = now - ts;
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

export function clockTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fullTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${clockTime(ts)}`;
}

export function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
