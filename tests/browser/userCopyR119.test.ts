import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { TaskExecutionStatus } from '../../src/contracts/executionStatus';
import { ExecutionStatus, taskExecutionStatusSummary } from '../../src/ui/hifi/components/ExecutionStatus';
import { ErrorState, IntentTag } from '../../src/ui/hifi/components/ui';
import { MarkdownView } from '../../src/ui/hifi/preview/MarkdownView';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/ui/hifi');
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(dir, entry.name)) : entry.name.endsWith('.tsx') ? [join(dir, entry.name)] : []);
}
const businessText = '请按文档（§6.4）核对 INDEPENDENT / RATIFY；R119 是业务编号。';
function status(): TaskExecutionStatus {
  return {
    schemaVersion: 'task-execution-status-v1', taskId: 'task_R119',
    scope: { projectId: 'p', conversationId: 'c', roomId: 'r', threadId: 'th', taskKind: 'room_task', surfaces: ['room', 'thread'] },
    phase: 'FAILED',
    reason: { code: 'RUN_FAILED', message: '全员无有效输入（§6.4）；不合成虚构研讨报告', source: 'run', taskId: 'task_R119', runId: 'run_RATIFY', turnId: null, eventSeq: 9 },
    actualPerformingMembers: [], waitingMembers: [], waitingForUser: null, lastBusinessActivity: null,
    existingResults: { hasResults: false, currentDelivery: null, pendingReviewDelivery: null, deliveries: [], artifacts: [], changeSets: [], truncated: { deliveries: false, artifacts: false, changeSets: false } },
    actions: [], observedAt: 100,
    evidence: { sourceHighWatermark: 9, taskStatus: 'BLOCKED', taskRevision: 3, stopGeneration: 2, runCount: 1, turnCount: 0, activeRunIds: [], unknownTurnIds: [], latestRun: null, outbox: null, executionBlocker: null, preDispatchFailure: null, recovery: null, heartbeatUsedAsActivity: false },
  };
}
function visible(html: string): string { return html.replace(/<[^>]*>/g, ''); }

describe('R119 program-generated UI copy', () => {
  it('checks TSX literals, excluding source comments, SVG paths and operation audit records', () => {
    const found: string[] = [];
    for (const file of files(root)) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      function visit(node: ts.Node): void {
        if (ts.isImportDeclaration(node)) return;
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['recordWrite', 'recordLocalOnly'].includes(node.expression.text)) return;
        if (ts.isJsxAttribute(node) && node.name.getText(source) === 'd') return;
        if ((ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
          && /§|\bR\d+\b|\bM0\b|(?:DEV|RT)-\d+|不伪造|不冒充|正式合同|冻结信封|幂等|代次|乐观锁|终结规则|不合成虚构|命令面：|正式执行链|原信封|冻结名单|按正式附件合同/.test(node.text)) {
          found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${node.text.trim()}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(found).toEqual([]);
  });

  it('rewrites historical system failure reasons without changing the execution object', () => {
    const input = status();
    const before = structuredClone(input);
    const html = renderToStaticMarkup(createElement(ExecutionStatus, { status: input, density: 'detail' }));
    expect(visible(html)).toContain('所有 AI 都未返回有效结果');
    expect(visible(html)).not.toMatch(/§|不合成虚构研讨报告|stop generation|未闭环 UNKNOWN/);
    expect(visible(html)).toContain('停止次数 2');
    expect(input).toEqual(before);
  });

  it.each(['WAITING_CLARIFICATION', 'WAITING_REWORK', 'WAITING_INPUT'] as const)('preserves copied business reasons for %s', code => {
    const input = status();
    input.phase = 'WAITING_FOR_USER';
    input.reason = { ...input.reason, code, message: businessText };
    input.waitingForUser = { kind: 'clarification', message: businessText, memberIds: [], runId: null, turnId: null, deliveryId: null, eventSeq: null, since: null };
    const html = visible(renderToStaticMarkup(createElement(ExecutionStatus, { status: input, density: 'detail' })));
    expect(html).toContain(businessText);
    expect(taskExecutionStatusSummary(input).detail).toBe(businessText);
    // The reason remains verbatim even when a historical row has no wait projection.
    input.waitingForUser = null;
    expect(visible(renderToStaticMarkup(createElement(ExecutionStatus, { status: input, density: 'detail' })))).toContain(businessText);
    input.phase = 'FAILED';
    expect(taskExecutionStatusSummary(input).detail).toBe(businessText);
  });

  it('translates stage labels while retaining raw IDs, statuses and tool activity', () => {
    const input = status();
    input.reason.message = '执行失败，请检查配置';
    input.waitingMembers = [{ memberId: 'member_R119', displayName: '成员', state: 'waiting-peer', status: 'UNKNOWN', taskId: input.taskId, runId: 'run_RATIFY', turnId: null, stage: 'RATIFY', since: null, lastActivityAt: null, reason: '等待同伴', activity: null }];
    input.lastBusinessActivity = { kind: 'tool', summary: businessText, memberId: null, taskId: null, runId: null, turnId: null, toolCallId: 'tool_R119', source: 'tool-event', sourceEventSeq: 8, at: 100 };
    const html = visible(renderToStaticMarkup(createElement(ExecutionStatus, { status: input, density: 'detail' })));
    expect(html).toContain('成员 · 确认');
    expect(html).toContain(businessText);
    expect(input.waitingMembers[0]?.stage).toBe('RATIFY');
    expect(input.waitingMembers[0]?.runId).toBe('run_RATIFY');
    expect(input.waitingMembers[0]?.status).toBe('UNKNOWN');
  });

  it('keeps document text intact and excludes raw message/file/protocol payloads from conversion', () => {
    expect(visible(renderToStaticMarkup(createElement(MarkdownView, { text: businessText })))).toContain(businessText);
    expect(readFileSync(join(root, 'components/MessageView.tsx'), 'utf8')).not.toContain('userFacingSystemText');
    for (const file of files(root)) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node) && node.expression.getText(source) === 'userFacingSystemText') {
          expect(node.arguments[0]?.getText(source), file).not.toMatch(/(?:\.(?:body|text|feedback|reviewNote|question)\b|JSON\.stringify|toolEventText)/);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  });

  it('uses actual permission copy and human error labels', () => {
    const intent = renderToStaticMarkup(createElement(IntentTag, { intent: 'analyze' }));
    expect(intent).toContain('任务使用当前成员配置的文件访问权限。');
    expect(intent).not.toMatch(/DEV-|ADR-|选择分析仍需/);
    const error = renderToStaticMarkup(createElement(ErrorState, { code: 'OUTPUT_INVALID', detail: '全员无有效输入（§6.4）' }));
    expect(visible(error)).not.toMatch(/OUTPUT_INVALID|§/);
    expect(error).toContain('data-zs-error-code="OUTPUT_INVALID"');
  });
});
