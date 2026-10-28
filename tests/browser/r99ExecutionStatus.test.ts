import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TaskExecutionBlocker } from '../../src/contracts/executionBlockers.ts';
import type { TaskDetailsResult } from '../../src/contracts/taskDetails.ts';
import { RunExtraFacts, taskRunGuidance } from '../../src/ui/hifi/components/TaskDetailsFacts.tsx';
import { GeneratedFiles } from '../../src/ui/hifi/components/GeneratedFiles.tsx';
import { taskRunHint } from '../../src/ui/hifi/lib/taskRunHint.ts';
import { OPEN_RECOVERY_EVENT, requestRecoveryOpen } from '../../src/ui/hifi/lib/recovery.ts';
import { TurnDeadlineField } from '../../src/ui/hifi/pages/ProjectSettingsPage.tsx';

const blocker: TaskExecutionBlocker = {
  reason: 'unknown-turn',
  note: '待执行队列 1 项；甲 的上一轮结果未知，当前任务不会越过这项占用自动执行。',
  pendingOutboxCount: 1,
  outboxId: 7,
  outboxStatus: 'pending',
  dispatchKey: 'task:waiter:initial',
  leaseUntil: null,
  stage: null,
  runId: null,
  turnId: null,
  memberId: 'm1',
  memberName: '甲',
  blockingTaskId: 'holder',
  blockingTaskTitle: '前序任务',
  blockingTaskNumber: 11,
  blockingRootTaskId: 'root_holder',
  blockingRootTaskTitle: '前序根任务',
  blockingRootTaskNumber: 12,
  blockingMemberId: 'm1',
  blockingMemberName: '甲',
  blockingTurnId: 'turn_unknown',
  blockingTurnStatus: 'UNKNOWN',
  protectionState: 'retained',
  writeRootKey: null,
};

const detail: TaskDetailsResult = {
  executionBlocker: blocker,
  task: { id: 'waiter', projectId: 'p1', conversationId: 'c1', title: '等待任务', objective: null,
    status: 'ACTIVE', reviewPolicy: 'auto_deliver', revision: 1, stopGeneration: 0, roomTaskNumber: 2,
    ownerMemberId: 'm1', ownerDisplayName: '甲', parentTaskId: null, currentDeliveryId: null },
  failedRetry: { available: false, pending: false, blockReason: null },
  children: [], latestRunId: 'run_hint', currentRunId: null, selectedRunId: 'run_hint',
  runs: [{ id: 'run_hint', mode: 'DIRECT', status: 'RUNNING', stage: null, roundNo: null, revision: 0,
    budget: null, participants: [], turns: [], turnsTruncated: false, events: [], eventsTruncated: false }],
  events: [], deliveries: [], changeSets: [], artifacts: [],
  truncated: { children: false, runs: false, events: false, deliveries: false, changeSets: false, artifacts: false },
};

describe('R99 queued work and non-final evidence presentation', () => {
  it('RUNNING without an active turn uses the exact blocker instead of claiming a member is processing', () => {
    const hint = taskRunHint('RUNNING', blocker);
    expect(hint.label).toBe('等待确认上次回复');
    expect(hint.detail).toContain('甲 的上次回复尚未确认结束');
    expect(hint.detail).not.toContain('正在处理');
    expect(taskRunGuidance(detail)).toContain('等待确认上次回复');
    const html = renderToStaticMarkup(createElement(RunExtraFacts, { detail }));
    expect(html).toContain('data-zs-execution-blocker="unknown-turn"');
    expect(html).toContain('前序根任务');
    expect(html).toContain('占用任务 #12');
    expect(html).toContain('data-zs-open-recovery="1"');
    expect(html).toContain('不会自动释放或重放');
    expect(html).not.toContain('成员正在处理');
  });

  it('observed attachment chips expose a native non-final marker with version and size', () => {
    const html = renderToStaticMarkup(createElement(GeneratedFiles, {
      nonFinal: true,
      attachments: [{ artifactId: 'art_observed', filename: '观察稿.md', kind: 'text_file', revision: 2, sizeBytes: 20_480, hash: 'a'.repeat(64), sourcePath: '观察稿.md' }],
    }));
    expect(html).toContain('data-zs-non-final-file="1"');
    expect(html).toContain('观察稿.md');
    expect(html).toContain('v2');
    expect(html).toContain('20 KB');
  });

  it('recovery action emits the existing app event without navigating away from the task', () => {
    const target = new EventTarget();
    class TestCustomEvent extends Event {
      readonly detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        super(type);
        this.detail = init?.detail;
      }
    }
    const events: Array<{ type: string; detail: unknown }> = [];
    target.addEventListener(OPEN_RECOVERY_EVENT, (event) => events.push({
      type: event.type,
      detail: (event as TestCustomEvent).detail,
    }));
    vi.stubGlobal('window', { dispatchEvent: (event: Event) => target.dispatchEvent(event) });
    vi.stubGlobal('CustomEvent', TestCustomEvent);
    try {
      requestRecoveryOpen();
      expect(events).toEqual([{ type: OPEN_RECOVERY_EVENT, detail: { origin: 'runtime' } }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('disables the deadline input while save/read-back is in flight', () => {
    const html = renderToStaticMarkup(createElement(TurnDeadlineField, {
      value: 10_000,
      effective: { ms: 10_000, source: 'project' },
      disabled: true,
      onCommit: () => {},
    }));
    expect(html).toContain('value="10"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('正在保存，完成后可继续编辑');
  });
});
