import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {DmInterruptedNotice} from '../../src/ui/hifi/components/DmInterruptedNotice';
import {ExecutionBlockerFacts} from '../../src/ui/hifi/components/TaskDetailsFacts';
import {RecoveryPanel} from '../../src/ui/hifi/components/RecoveryPanel';
import {ExecutionWaitActions} from '../../src/ui/hifi/components/ExecutionWaitActions';
import {executionBlockerHint} from '../../src/ui/hifi/lib/taskRunHint';
import type {TaskExecutionBlocker} from '../../src/contracts/executionBlockers';
import type {TaskDetailsResult} from '../../src/contracts/taskDetails';

const raw = 'UNKNOWN turn_123 租约 retained recovery.releaseProtection 人工退款 物理写入保护';
const task = {taskId: 'old_task', title: '上次请求', lastRunId: 'run_123', lastRunStatus: 'INTERRUPTED', recoverable: false, blockReason: raw, lastFailureReason: raw};
const blocker: TaskExecutionBlocker = {
  reason: 'unknown-turn', note: raw, blockingMemberName: 'Codex', memberName: 'Claude',
  blockingRootTaskId: 'root_task', blockingRootTaskTitle: '上次写作', blockingRootTaskNumber: 12,
  pendingOutboxCount: 1, protectionState: 'retained',
} as TaskExecutionBlocker;
const visible = (html: string) => html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, '');

describe('R102 recovery next steps in human language', () => {
  it('names the interrupted DM member and queued messages, gives direct continuation and keeps audit folded', () => {
    const html = renderToStaticMarkup(createElement(DmInterruptedNotice, {
      tasks: [task], memberName: 'Codex', queuedCount: 2, onRecover: () => {},
    }));
    const top = visible(html);
    expect(top).toContain('Codex 上次回复中断');
    expect(top).toContain('Codex 的上次回复未完成');
    expect(top).toContain('本对话有 2 条消息在等待');
    expect(top).toContain('data-zs-continue-task=');
    expect(top).toContain('继续任务');
    expect(top).not.toContain('继续这次请求');
    for (const term of ['UNKNOWN', 'turn_123', '租约', 'releaseProtection', '人工退款', '物理写入']) expect(top).not.toContain(term);
    expect(html).toContain(raw);
    expect(html).toContain('<details');
    expect(html).not.toMatch(/<details[^>]*\bopen/);
  });

  it('offers a retry only when the existing backend projection explicitly permits it', () => {
    const html = renderToStaticMarkup(createElement(DmInterruptedNotice, {
      tasks: [{...task, recoverable: true}], memberName: 'Codex', busy: true, onRecover: () => {},
    }));
    expect(visible(html)).toContain('原消息和已有文件都已保留');
    expect(html).toContain('disabled=""');
    expect(html).toContain('继续这次请求');
    expect(html).not.toContain('data-zs-open-recovery=');
    expect(html).not.toContain('直接发送一条新消息');
  });

  it('describes the actual blocking member rather than the target member or raw technical note', () => {
    expect(executionBlockerHint(blocker).detail).toContain('Codex 的上次回复未完成');
    const html = renderToStaticMarkup(createElement(ExecutionBlockerFacts, {detail: {executionBlocker: blocker,task:{id:'queued-current',projectId:'p',revision:4,stopGeneration:2}} as TaskDetailsResult}));
    const top = visible(html);
    expect(top).toContain('Codex');
    expect(top).toContain('href="#task=root_task"');
    expect(top).toContain('上次写作');
    expect(top).toContain('继续任务');
    expect(top).toContain('data-zs-continue-task="queued-current"');
    expect(top).not.toContain('data-zs-continue-task="root_task"');
    expect(top).not.toContain('retained');
    expect(top).not.toContain('UNKNOWN');
    expect(html).toContain(raw);
    expect(html).toContain('retained');
  });

  it('keeps live member occupancy distinct from interrupted/unknown work', () => {
    const hint = executionBlockerHint({...blocker, reason: 'member-occupied'});
    expect(hint.detail).toContain('Codex 正在处理其他请求');
    expect(hint.detail).not.toContain('中断');
    expect(hint.detail).not.toContain('尚未确认结束');
    expect(hint.detail).not.toContain('已完成');
  });

  it.each([
    { blockReason: '会话已归档', canContinue: false },
    { blockReason: raw, canContinue: true },
  ])('uses only an explicit retained fact for direct continuation: %j', ({blockReason, canContinue}) => {
    const html = visible(renderToStaticMarkup(createElement(DmInterruptedNotice, {
      tasks: [{...task, lastRunStatus: 'FAILED', blockReason}], memberName: 'Codex', onRecover: () => {},
    })));
    expect(html).toContain('上次回复没有完成');
    expect(html).toContain(canContinue ? '可以继续任务' : '已有文件都已保留');
    expect(html).toContain(canContinue ? 'data-zs-continue-task="old_task"' : 'data-zs-dm-interrupted-task="old_task"');
    expect(html).not.toContain('尚未确认 Codex 已结束');
    expect(html).not.toContain('上次回复中断');
    if (!canContinue) {
      expect(html).not.toContain('data-zs-continue-task=');
      expect(html).not.toContain('继续这次请求');
      expect(html).not.toContain('新请求可能需要等待');
      expect(html).not.toContain('条消息在等待');
    }
  });

  it('identifies a room-root blocker from a DM title without inventing a room task number', () => {
    const dmBlocker = {...blocker, blockingRootTaskTitle: 'Codex 私信上次回复', blockingRootTaskNumber: null, blockingTaskNumber: null};
    const html = renderToStaticMarkup(createElement(ExecutionWaitActions, {blocker: dmBlocker,taskId:'queued-current'}));
    const top = visible(html);
    expect(top).toContain('Codex 私信上次回复');
    expect(top).toContain('继续任务');
    expect(top).toContain('data-zs-continue-task="queued-current"');
    expect(top).not.toContain('data-zs-continue-task="root_task"');
    expect(top).not.toContain('#?');
    expect(top).not.toContain('租约');
    expect(top).not.toContain('UNKNOWN');
    expect(top).not.toContain('退出与保护');
    expect(html).toContain(raw);
    expect(html).not.toMatch(/<details[^>]*\bopen/);
    const numbered = renderToStaticMarkup(createElement(ExecutionWaitActions, {blocker}));
    expect(visible(numbered)).toContain('上次写作 · #12');
    expect(visible(numbered)).toContain('href="#task=root_task"');
    expect(visible(numbered)).toContain('查看上次任务');
    expect(visible(numbered)).not.toContain('继续任务');
    expect(visible(numbered)).not.toContain('data-zs-continue-task=');
  });

  it('opens the recovery task list without a check workflow', () => {
    const html = renderToStaticMarkup(createElement(RecoveryPanel, {onClose: () => {}, origin: 'runtime'}));
    expect(html).toContain('恢复任务');
    expect(html).toContain('刷新');
    expect(html).not.toContain('textarea');
    expect(html).not.toContain('重启');
    expect(html).not.toContain('租约');
    expect(html).not.toContain('UNKNOWN');
    expect(html).not.toContain('releaseProtection');
  });
});
