/**
 * 外部 AI 连接（MCP）动作（§31.5 / §31.8）。
 *
 * 边界必须如实（任务书 §3.3）：
 *  - 原型**没有 MCP 服务端**：这里改的是内存状态（创建 → 配范围 → 轮换/吊销），
 *    界面必须标注"后台尚未接入"，不得只补几个按钮就当作能力已完成；
 *  - 审批与验收类命令**永远只属于用户**（§10.5）：`approval.respond` /
 *    `task.delivery.review` 不出现在可授予的操作集里，也不在界面承诺；
 *  - 令牌沿用 §8.3 配对与设备管理的惯例：创建时显示一次、可轮换、可逐个吊销，
 *    吊销后立即失效 —— 不新造第二套凭据流程（数据仍是独立的两份，见 types.ts）。
 */

import { getState, recordLocalOnly, setState, toast } from './store';
import type { McpConnection, McpOperation } from './types';

/** 令牌明文只在创建/轮换的那一次返回，之后只留前缀（与设备配对同一惯例） */
export interface McpTokenOnce {
  token: string;
  connectionId: string;
}

/** 授权范围草稿（创建与编辑共用同一形状，避免两套字段名） */
export interface McpScopeDraft {
  targets: string[];
  operations: McpOperation[];
  memberIds: string[];
  budgetCapCalls: number | null;
}

export const MCP_OPERATION_LABELS: Record<McpOperation, { label: string; detail: string }> = {
  read: {
    label: '读取项目、房间、成员、线程与成果',
    detail: 'projects_list / rooms_list / members_list / threads_read / artifacts_list / artifacts_read / tasks_get / events_list',
  },
  'task.write': {
    label: '创建任务、补充要求',
    detail: 'tasks_create / tasks_steer（补充要求是提交型操作，重试必须带 idempotencyKey）',
  },
  'task.stop': {
    label: '停止任务',
    detail: 'tasks_stop —— 只限这个连接自己发起、或你显式登记过「获准跟进」的任务；能读不等于能停',
  },
  'message.send': {
    label: '以你的名义代发消息',
    detail: 'messages_send —— 消息会带「经外部助手 X 代发」标记，不显示为你亲发',
  },
};

/**
 * 首批**不开放**的命令（§31.3）。
 * 列在界面上是如实说明"哪些事外部 AI 做不到"，不是可以勾掉的选项。
 */
export const MCP_NOT_GRANTABLE = [
  '审批与验收（approval.respond、task.delivery.review）—— 永远只属于你',
  '推送、撤销改动、Git 全部操作（含 git.push）',
  '成员配置、房间创建与成员增删',
  '项目全停、上下文授权与撤销',
  '提高预算、扩大范围',
];

/**
 * 授权范围草稿的校验（**创建与编辑共用同一套规则**）。
 *
 * 为什么单独抽出来：原来创建按钮只看"名称是否为空"，预算输入框的 `min` 只是浏览器提示，
 * 于是预算填 `-2` 也能创建成功、列表显示 `0 / -2`（评审复现）。校验必须能被
 * 两个入口复用，也必须在动作层再兜一次（界面漏了也不会写进状态）。
 */
export function validateScopeDraft(draft: McpScopeDraft): string | null {
  if (draft.targets.length === 0) {
    return '至少要选一个项目或房间：没有范围的外部连接连不上任何东西。';
  }
  if (draft.operations.length === 0) {
    return '至少要选中一项操作：只给范围不给操作等于什么都做不了。';
  }
  const cap = draft.budgetCapCalls;
  if (cap !== null) {
    if (!Number.isFinite(cap)) return '预算上限要填数字（或留空表示不限）。';
    if (!Number.isInteger(cap)) return '预算上限只能是整数（次），不接受小数。';
    if (cap < 1) return '预算上限至少为 1 次；不想限制就留空表示不限。';
    if (cap > 9999) return '预算上限最多 9999 次（原型上限）。';
  }
  return null;
}

function newToken(): string {
  return `zs_mcp_${Math.random().toString(36).slice(2, 8)}`;
}

function nextId(): string {
  return `mcp_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 创建一个外部 AI 连接。
 *
 * 返回**令牌明文**（只此一次）；范围四维一并写入，未授予范围时连接不可用 ——
 * 不默认给全范围，避免"创建即全权"。
 */
export function createMcpConnection(input: {
  name: string;
  clientType: string;
  transfer: McpConnection['transfer'];
  scope: McpScopeDraft;
}): McpTokenOnce | null {
  const name = input.name.trim();
  if (!name) {
    toast('请给这个连接起一个名字（用于在列表与代发标记里识别它）', 'error');
    return null;
  }
  const bad = validateScopeDraft(input.scope);
  if (bad) {
    toast(bad, 'error');
    return null;
  }
  const token = newToken();
  const id = nextId();
  const conn: McpConnection = {
    id,
    name,
    clientType: input.clientType,
    transfer: input.transfer,
    tokenPrefix: token.slice(0, 12),
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    callCount: 0,
    scope: { ...input.scope, usedCalls: 0 },
  };
  setState((s) => ({ ...s, mcpConnections: [...s.mcpConnections, conn] }));
  recordLocalOnly(
    'external.connection.created',
    `connection=${id} name=${name} transfer=${input.transfer} 范围=项目/房间 ${input.scope.targets.length} 个、操作 ${input.scope.operations.join('+')}、成员 ${input.scope.memberIds.length} 个、预算 ${input.scope.budgetCapCalls ?? '不限'}（原型只改内存状态，后台 MCP 未接入）`,
  );
  return { token, connectionId: id };
}

/** 改范围（乐观并发在正式实现里按 revision 校验，原型只改内存值） */
export function updateMcpScope(connectionId: string, scope: McpScopeDraft): string | null {
  const s = getState();
  const cur = s.mcpConnections.find((c) => c.id === connectionId);
  if (!cur) return '这个连接不存在或已删除。';
  const bad = validateScopeDraft(scope);
  if (bad) return bad; // 非法值不写入状态，由界面留在编辑态显示行内错误
  setState((st) => ({
    ...st,
    mcpConnections: st.mcpConnections.map((c) =>
      c.id === connectionId ? { ...c, scope: { ...c.scope, ...scope } } : c,
    ),
  }));
  recordLocalOnly(
    'external.grant.changed',
    `connection=${connectionId} 目标 ${scope.targets.length} · 操作 ${scope.operations.join('+') || '（空）'} · 成员 ${scope.memberIds.length} · 预算 ${scope.budgetCapCalls ?? '不限'}`,
  );
  toast('范围已更新：超出范围的调用会被逐次校验拒绝，不是靠缓存里的旧工具列表', 'success');
  return null;
}

/** 轮换令牌：已配对的客户端需要重新配置，已吊销的不受影响 */
export function rotateMcpToken(connectionId: string): McpTokenOnce | null {
  const token = newToken();
  setState((s) => ({
    ...s,
    mcpConnections: s.mcpConnections.map((c) =>
      c.id === connectionId ? { ...c, tokenPrefix: token.slice(0, 12) } : c,
    ),
  }));
  /**
   * 留痕**不记录令牌**（连掩码后的前缀也不记）：
   * 令牌是"创建/轮换时只显示一次"的凭据，而写操作留痕是任何页面都能翻到的记录 ——
   * 原来把明文拼进留痕文本，等于给了一个"隐藏后还能看到"的旁路（评审复现）。
   * 这里只记连接与动作，凭据本身不落任何日志。
   */
  recordLocalOnly(
    'external.connection.rotated',
    `connection=${connectionId} → 令牌已轮换，旧令牌立即失效；新令牌只在弹窗里显示一次，需要在该客户端重新配置`,
  );
  return { token, connectionId };
}

/** 吊销：立即失效，记录保留（审计仍在，§31.7） */
export function revokeMcpConnection(connectionId: string) {
  const s = getState();
  const conn = s.mcpConnections.find((c) => c.id === connectionId);
  if (!conn) return;
  if (conn.revokedAt) return;
  setState((st) => ({
    ...st,
    mcpConnections: st.mcpConnections.map((c) =>
      c.id === connectionId ? { ...c, revokedAt: Date.now() } : c,
    ),
  }));
  recordLocalOnly(
    'external.connection.revoked',
    `connection=${connectionId}（${conn.name}）→ 既有会话的后续调用立即失效；审计记录保留`,
  );
  toast(`已吊销「${conn.name}」：该连接的调用立即失效，其他连接不受影响`, 'success');
}

/**
 * 删除已吊销的连接记录。
 * 与"吊销"分开：吊销是立即失效但留审计，删除才是把这条记录清掉（§31.7 可观察性）。
 */
export function deleteMcpConnection(connectionId: string) {
  const s = getState();
  const conn = s.mcpConnections.find((c) => c.id === connectionId);
  if (!conn) return;
  if (!conn.revokedAt) {
    toast('先吊销再删除：直接删掉一条还在生效的连接，会让"谁在代操作"查不到', 'error');
    return;
  }
  setState((st) => ({ ...st, mcpConnections: st.mcpConnections.filter((c) => c.id !== connectionId) }));
  recordLocalOnly('external.connection.deleted', `connection=${connectionId}（${conn.name}）审计记录随之移除`);
}
