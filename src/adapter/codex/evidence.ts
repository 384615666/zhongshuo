/**
 * B6/RT-23 沙箱拒绝证据验证（共享纯函数：e2e 认证与协议回放负例共用）。
 *
 * 证据必须绑定到具体写入工具（修复轮 4）：
 * - 指定写入类工具（fileChange=直接编辑 / commandExecution=shell）的 tool.started，
 *   argumentsSummary 含目标路径/文件名；
 * - 同一 toolCallId 配对 tool.completed：outcome=failure 且 resultRef 带 status:declined
 *   （权限拒绝）——status:failed 只是执行失败状态，不构成权限拒绝原因；
 * - unknown / 语法错误 / 无关工具失败 / 口头拒绝（无工具活动）均不通过。
 */
import type { NormalizedRuntimeEvent } from '../../contracts/runtime.ts';

export type WriteToolKind = 'fileChange' | 'commandExecution';

export interface SandboxEvidenceVerdict {
  ok: boolean
  reason?: string
  matchedToolCallIds: string[]
}

export function verifySandboxRejectionEvidence(
  events: readonly NormalizedRuntimeEvent[],
  expectedTool: WriteToolKind,
  targetToken: string,
): SandboxEvidenceVerdict {
  const started = events.filter((e): e is Extract<NormalizedRuntimeEvent, { kind: 'tool.started' }> => e.kind === 'tool.started');
  const relevant = started.filter((e) => e.toolName === expectedTool && e.argumentsSummary.includes(targetToken));
  if (relevant.length === 0) {
    // 直接编辑路径（fileChange）在审批模式下不产生 tool.started：写尝试以
    // item/fileChange/requestApproval（ServerRequest）形式出现——审批请求携带
    // 目标文件清单，本身就是可辨识的权限门（修复轮 4 的直接编辑仪器化路径）。
    if (expectedTool === 'fileChange') {
      const approvals = events.filter(
        (e): e is Extract<NormalizedRuntimeEvent, { kind: 'approval.requested' }> => e.kind === 'approval.requested',
      );
      const hit = approvals.find((a) => JSON.stringify(a.request).includes(targetToken));
      if (hit != null) {
        return { ok: true, matchedToolCallIds: [hit.approvalId] };
      }
      return {
        ok: false,
        reason: `未发现 fileChange 指向 ${targetToken} 的工具事件或含该目标的审批请求`,
        matchedToolCallIds: [],
      };
    }
    return {
      ok: false,
      reason: `未发现 ${expectedTool} 指向 ${targetToken} 的真实尝试`,
      matchedToolCallIds: [],
    };
  }
  const matched: string[] = [];
  for (const start of relevant) {
    const completed = events.find(
      (e): e is Extract<NormalizedRuntimeEvent, { kind: 'tool.completed' }> =>
        e.kind === 'tool.completed' && e.toolCallId === start.toolCallId,
    );
    if (completed == null) {
      return { ok: false, reason: `toolCallId=${start.toolCallId} 无配对 completed`, matchedToolCallIds: matched };
    }
    if (completed.outcome !== 'failure') {
      return { ok: false, reason: `toolCallId=${start.toolCallId} outcome=${completed.outcome}（须 failure）`, matchedToolCallIds: matched };
    }
    // 权限拒绝原因（可辨识）：status:declined（审批/沙箱明确拒绝）或
    // status:failed;...;sandbox-denial（失败输出命中沙箱/权限拒绝签名）。
    // 纯 status:failed 是执行失败（可能是语法错误），不能单独当作权限拒绝。
    const ref = completed.resultRef ?? '';
    if (ref !== 'status:declined' && !ref.startsWith('status:failed;') ) {
      return { ok: false, reason: `toolCallId=${start.toolCallId} resultRef=${ref || '(无)'}——无可辨识拒绝原因`, matchedToolCallIds: matched };
    }
    if (ref.startsWith('status:failed;') && !ref.includes(';sandbox-denial')) {
      return { ok: false, reason: `toolCallId=${start.toolCallId} resultRef=${ref}——failed 无沙箱拒绝签名，不构成权限拒绝`, matchedToolCallIds: matched };
    }
    matched.push(start.toolCallId);
  }
  return { ok: true, matchedToolCallIds: matched };
}
