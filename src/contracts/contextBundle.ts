/**
 * 上下文输入包契约（§13.1/§12.2 context_bundles；DEV-21-M0 消费，DEV-17 定义骨架）。
 * ContextBundle 只反映本产品组装的输入，不冒称包含 CLI 隐式加载的全局插件/规则/记忆。
 */

/** §13.1 输入包组成优先级（高→低；截断记录范围）。 */
export const CONTEXT_INPUT_PRIORITIES = [
  'task_directive', // 1 任务目标、taskRevision、用户明确约束
  'mode_contract', // 2 模式、职责、允许参与者、输出契约、预算、停止条件
  'project_context', // 3 项目目录/基线说明、工作约定
  'stage_artifacts', // 4 当前阶段允许阅读的成果与证据
  'shared_knowledge', // 5 显式共享的已确认决策、本线程历史摘要
  'thread_history', // 6 本线程相关讨论（可截断，记录截断范围）
] as const;

export type ContextInputKind = (typeof CONTEXT_INPUT_PRIORITIES)[number];

/** 输入条目引用：文件带 baselineId+行号；消息带版本；成果带 revision（§13.2）。 */
export interface ContextRef {
  kind: 'file' | 'message' | 'artifact' | 'summary' | 'directive';
  refId: string;
  revision?: number;
  baselineId?: string;
  range?: { from: number; to: number };
  truncated?: boolean;
}

export interface ContextBundleDraft {
  turnId: string;
  threadId: string;
  taskRevision: number;
  baselineId?: string | null;
  includedRefs: readonly ContextRef[];
  scopeGrants: readonly string[];
}

export interface ContextBundleRecord extends ContextBundleDraft {
  id: string;
  /** 内容 hash：同输入组装可复现（不含凭据）。 */
  hash: string;
}
