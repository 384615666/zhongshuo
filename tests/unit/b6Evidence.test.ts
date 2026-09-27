/**
 * 修复轮 4 · B6 证据绑定负例（零额度）：语法错误/无关工具/unknown/口头拒/错路径
 * 均不能通过沙箱认证（共享验证函数 verifySandboxRejectionEvidence）。
 */
import { describe, expect, it } from 'vitest';
import { verifySandboxRejectionEvidence } from '../../src/adapter/codex/evidence.ts';
import type { NormalizedRuntimeEvent } from '../../src/contracts/runtime.ts';

function toolStarted(toolCallId: string, toolName: string, argumentsSummary: string): NormalizedRuntimeEvent {
  return { kind: 'tool.started', eventKey: `k-${toolCallId}`, sessionId: 's', turnId: 't', receivedAt: 0, toolCallId, toolName, argumentsSummary };
}
function toolCompleted(toolCallId: string, outcome: 'success' | 'failure' | 'unknown', resultRef?: string): NormalizedRuntimeEvent {
  return { kind: 'tool.completed', eventKey: `kc-${toolCallId}`, sessionId: 's', turnId: 't', receivedAt: 0, toolCallId, outcome, ...(resultRef != null ? { resultRef } : {}) };
}

describe('B6 证据绑定负例（修复轮 4）', () => {
  it('口头拒绝（无工具活动）不通过', () => {
    const v = verifySandboxRejectionEvidence(
      [{ kind: 'message.completed', eventKey: 'm', sessionId: 's', turnId: 't', receivedAt: 0, messageId: 'm1', text: '我没有权限写入' }],
      'fileChange', 'notes.md',
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('未发现');
  });

  it('无关工具失败（mcpToolCall 指向别的文件）不通过', () => {
    const v = verifySandboxRejectionEvidence(
      [toolStarted('x1', 'mcpToolCall', 'other.txt'), toolCompleted('x1', 'failure', 'status:declined')],
      'fileChange', 'notes.md',
    );
    expect(v.ok).toBe(false);
  });

  it('目标路径不匹配不通过', () => {
    const v = verifySandboxRejectionEvidence(
      [toolStarted('x2', 'fileChange', 'D:/other/别的文件.txt'), toolCompleted('x2', 'failure', 'status:declined')],
      'fileChange', 'notes.md',
    );
    expect(v.ok).toBe(false);
  });

  it('unknown 结局不通过', () => {
    const v = verifySandboxRejectionEvidence(
      [toolStarted('x3', 'fileChange', 'notes.md'), toolCompleted('x3', 'unknown')],
      'fileChange', 'notes.md',
    );
    expect(v.ok).toBe(false);
  });

  it('status:failed（无沙箱签名=可能是语法错误）不构成权限拒绝', () => {
    const v = verifySandboxRejectionEvidence(
      [toolStarted('x4', 'commandExecution', 'echo > b6.txt'), toolCompleted('x4', 'failure', 'status:failed;exit:1')],
      'commandExecution', 'b6.txt',
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('不构成权限拒绝');
  });

  it('status:failed 带沙箱拒绝签名（;sandbox-denial）构成可辨识拒绝', () => {
    const v = verifySandboxRejectionEvidence(
      [toolStarted('x4b', 'commandExecution', 'echo > b6.txt'), toolCompleted('x4b', 'failure', 'status:failed;exit:1;sandbox-denial')],
      'commandExecution', 'b6.txt',
    );
    expect(v).toMatchObject({ ok: true, matchedToolCallIds: ['x4b'] });
  });

  it('无配对 completed 不通过', () => {
    const v = verifySandboxRejectionEvidence(
      [toolStarted('x5', 'fileChange', 'notes.md')],
      'fileChange', 'notes.md',
    );
    expect(v.ok).toBe(false);
  });

  it('正例：指定工具+目标路径+同 toolCallId+status:declined 通过', () => {
    const v = verifySandboxRejectionEvidence(
      [toolStarted('ok1', 'fileChange', 'D:/proj/notes.md'), toolCompleted('ok1', 'failure', 'status:declined')],
      'fileChange', 'notes.md',
    );
    expect(v).toMatchObject({ ok: true, matchedToolCallIds: ['ok1'] });
  });
});
