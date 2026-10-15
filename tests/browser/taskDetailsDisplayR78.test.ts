import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskDetailRun, TaskDetailsResult } from '../../src/contracts/taskDetails.ts';
import { RunExtraFacts, taskRunGuidance } from '../../src/ui/hifi/components/TaskDetailsFacts.tsx';

const run = (id: string, status: string): TaskDetailRun => ({
  id, mode: 'DIRECT', status, stage: null, roundNo: null, revision: 0, budget: null,
  participants: [], turns: [], turnsTruncated: false, events: [], eventsTruncated: false,
});
const detail = (status: string, runs: TaskDetailRun[], selectedRunId?: string): TaskDetailsResult => ({
  task: { id: 'task_1', projectId: 'p1', conversationId: 'c1', title: '任务', objective: null,
    status, reviewPolicy: 'user_review', revision: 1, stopGeneration: 0, roomTaskNumber: 1, ownerMemberId: null,
    ownerDisplayName: null, parentTaskId: null, currentDeliveryId: null },
  failedRetry: { available: status === 'ACTIVE' && runs[0]?.status === 'FAILED', pending: false, blockReason: null },
  children: [], latestRunId: runs[0]?.id ?? null,
  currentRunId: runs[0] != null && ['QUEUED', 'RUNNING', 'WAITING', 'STOPPING'].includes(runs[0].status) ? runs[0].id : null,
  selectedRunId: selectedRunId ?? runs[0]?.id ?? null,
  runs, events: [], deliveries: [], changeSets: [], artifacts: [],
  truncated: { children: false, runs: false, events: false, deliveries: false, changeSets: false, artifacts: false },
});

describe('R78 run detail rendering', () => {
  it('keeps failed attempt separate from still active task and points to an explicit next step', () => {
    const d = detail('ACTIVE', [run('failed_run', 'FAILED')]);
    expect(taskRunGuidance(d)).toContain('最近一次运行失败；任务仍是待继续处理');
    const html = renderToStaticMarkup(createElement(RunExtraFacts, { detail: d }));
    expect(html).toContain('最近运行');
    expect(html).not.toContain('当前运行');
    expect(html).toContain('无预算记录');
    expect(renderToStaticMarkup(createElement(RunExtraFacts, { detail: d, onRetryFailed: () => {} }))).toContain('继续最近失败运行');
    d.failedRetry = { available: false, pending: true, blockReason: null };
    const pending = renderToStaticMarkup(createElement(RunExtraFacts, { detail: d, onRetryFailed: () => {} }));
    expect(pending).toContain('继续已入队');
    expect(pending).not.toContain('>继续最近失败运行</button>');
    const interrupted = detail('ACTIVE', [run('unknown', 'INTERRUPTED')]);
    expect(renderToStaticMarkup(createElement(RunExtraFacts, { detail: interrupted, onRetryFailed: () => {} }))).not.toContain('继续最近失败运行');
  });

  it('explains authoritative AUTO dependency waiting without inventing a human input request',()=>{
    const r=run('coord','WAITING');r.mode='AUTO';r.stage='分工执行';
    const text=taskRunGuidance(detail('ACTIVE',[r]));expect(text).toContain('分工步骤完成');expect(text).not.toContain('输入或批准');
    r.mode='DIRECT';expect(taskRunGuidance(detail('ACTIVE',[r]))).toContain('输入或批准');
  });
  it('renders queued/blocked guidance and surfaces selected historical tools and usage', () => {
    const queued = detail('ACTIVE', [run('queued', 'QUEUED')]);
    expect(taskRunGuidance(queued)).toContain('已排队');
    expect(renderToStaticMarkup(createElement(RunExtraFacts, { detail: queued }))).toContain('当前运行');
    queued.task.status = 'BLOCKED';
    expect(taskRunGuidance(queued)).toContain('任务受阻');

    const old = run('old', 'FAILED');
    old.events.push({ seq: 1, kind: 'tool.completed', at: 1000, runId: 'old', turnId: 't1', toolCallId: 'read_1', summary: 'failure' });
    old.events.push({seq:2,kind:'turn.statusChanged',status:'FAILED',code:'PROVIDER_ERROR',at:1001,runId:'old',turnId:'t1',toolCallId:null,summary:'工程失败说明，需先修复渠道'});
    old.events.push({seq:3,kind:'input.requested',at:1002,runId:'old',turnId:'t1',toolCallId:null,summary:'请确认输出目录'});
    old.turns.push({ id: 't1', memberId: 'm1', displayName: '执行甲', status: 'FAILED', stageKey: 'direct.work', purpose: 'stage_work', attempt: 1,
      usage: [{ normalized: { accounting: 'cumulative', inputTokens: 7, outputTokens: 3 }, quality: 'reported' }], usageTruncated: false });
    const newest = run('new', 'SUCCEEDED'); newest.eventsTruncated = true;
    const d = detail('REVIEW', [newest, old], 'old');
    const html = renderToStaticMarkup(createElement(RunExtraFacts, { detail: d }));
    expect(html.indexOf('历史运行 · 已定位')).toBeLessThan(html.indexOf('最近运行'));
    expect(html).toContain('工具结束 · failure');
    expect(html).toContain('工具 read_1');
    expect(html).toContain('输入 7 tokens');
    expect(html).toContain('工程失败说明，需先修复渠道');expect(html).toContain('等待补充输入 · 请确认输出目录');
    const latestHtml = renderToStaticMarkup(createElement(RunExtraFacts, { detail: detail('REVIEW', [newest, old]) }));
    expect(latestHtml).toContain('仅显示这次运行最近 120 条事件');
  });
});
