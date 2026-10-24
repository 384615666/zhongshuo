import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  PreDispatchFailureProjection,
  TaskDetailRun,
  TaskDetailsResult,
} from '../../src/contracts/taskDetails.ts';
import {
  PreDispatchFailureFacts,
  RunExtraFacts,
  taskRunGuidance,
} from '../../src/ui/hifi/components/TaskDetailsFacts.tsx';

const failure: PreDispatchFailureProjection = {
  state: 'NOT_STARTED',
  taskId: 'task_993d7e3e',
  conversationId: 'conv_r107',
  threadId: 'thread_r107',
  memberId: 'member_claude',
  memberName: 'Claude',
  memberEnabled: true,
  event: {
    seq: 437,
    kind: 'task.contextAssemblyFailed',
    at: 1792840367829,
    reason: 'write-baseline-incomplete',
    message: '写入基线不完整：目录扫描失败、路径被拒绝或文件清单超出安全范围，未启动模型',
  },
  runCount: 0,
  turnCount: 0,
  callCount: 0,
  callStarted: false,
  outbox: {
    id: 24,
    dispatchKey: 'task:task_993d7e3e:initial',
    status: 'done',
  },
  action: {
    kind: 'resubmit-original-message',
    instruction: '处理目录扫描失败、越界路径或超限清单（例如项目外 junction/symlink、生成目录），再按原消息重新提交；不会自动重放。',
  },
};

function detail(runs: TaskDetailRun[] = [], preDispatchFailure: PreDispatchFailureProjection | null = null): TaskDetailsResult {
  return {
    preDispatchFailure,
    executionBlocker: null,
    task: {
      id: 'task_993d7e3e',
      projectId: 'p_r107',
      conversationId: 'conv_r107',
      title: '比较两个项目',
      objective: null,
      status: 'BLOCKED',
      reviewPolicy: 'auto_deliver',
      revision: 1,
      stopGeneration: 0,
      roomTaskNumber: 1,
      ownerMemberId: 'member_claude',
      ownerDisplayName: 'Claude',
      parentTaskId: null,
      currentDeliveryId: null,
    },
    failedRetry: { available: false, pending: false, blockReason: null },
    children: [],
    latestRunId: runs[0]?.id ?? null,
    currentRunId: runs[0]?.id ?? null,
    selectedRunId: runs[0]?.id ?? null,
    runs,
    events: [],
    deliveries: [],
    changeSets: [],
    artifacts: [],
    truncated: {
      children: false,
      runs: false,
      events: false,
      deliveries: false,
      changeSets: false,
      artifacts: false,
    },
  };
}

describe('R107 pre-dispatch failure detail display', () => {
  it('shows member, NOT_STARTED, exact cause, and a factual next step without a fake recovery action', () => {
    const value = detail([], failure);
    const html = renderToStaticMarkup(createElement(PreDispatchFailureFacts, { detail: value }));
    expect(html).toContain('data-zs-pre-dispatch-state="NOT_STARTED"');
    expect(html).toContain('data-zs-pre-dispatch-failure="write-baseline-incomplete"');
    expect(html).toContain('<strong>Claude</strong> · NOT_STARTED · 模型尚未被调用');
    expect(html).toContain(failure.event.message);
    expect(html).toContain(failure.action.instruction);
    expect(html).toContain('事件 #437 · task.contextAssemblyFailed');
    expect(html).toContain('运行 0 · 执行轮次 0 · 真实模型调用 0');
    expect(html).toContain('outbox done');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('href="#run');

    const guidance = taskRunGuidance(value);
    expect(guidance).toContain('Claude尚未开始调用（NOT_STARTED）');
    expect(guidance).toContain(failure.event.message);
    expect(guidance).toContain('按原消息重新提交');
    expect(guidance).not.toContain('查看活动与运行诊断中的具体原因');
    const runHtml = renderToStaticMarkup(createElement(RunExtraFacts, { detail: value }));
    expect(runHtml).toContain('任务尚无运行记录');
    expect(runHtml).not.toContain('查看活动与运行诊断中的具体原因');
  });

  it('keeps UNKNOWN/running work distinct from a not-started pre-dispatch failure', () => {
    const run: TaskDetailRun = {
      id: 'run_unknown',
      mode: 'AUTO',
      status: 'RUNNING',
      stage: null,
      roundNo: null,
      revision: 0,
      budget: null,
      participants: [],
      turns: [{
        id: 'turn_unknown',
        memberId: 'member_claude',
        displayName: 'Claude',
        status: 'UNKNOWN',
        stageKey: 'direct.work',
        purpose: 'stage_work',
        attempt: 1,
        usage: [],
        usageTruncated: false,
      }],
      turnsTruncated: false,
      events: [],
      eventsTruncated: false,
    };
    const value = detail([run], null);
    const guidance = taskRunGuidance(value);
    expect(guidance).toContain('任务受阻');
    expect(guidance).not.toContain('NOT_STARTED');
    expect(guidance).not.toContain('模型尚未被调用');
    expect(renderToStaticMarkup(createElement(PreDispatchFailureFacts, { detail: value }))).toBe('');
  });
});
