import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DmInterruptedNotice } from '../../src/ui/hifi/components/DmInterruptedNotice.tsx';
import type { DmConversation } from '../../src/ui/hifi/data/types.ts';

type InterruptedTask = NonNullable<DmConversation['interruptedTasks']>[number];

function render(task: InterruptedTask): string {
  return renderToStaticMarkup(createElement(DmInterruptedNotice, {
    tasks: [task],
    memberName: 'Codex',
    onRecover: () => {},
  }));
}

describe('R106 DM interrupted notice', () => {
  it('shows a persisted pre-dispatch failure with product-language recovery', () => {
    const html = render({
      taskId: 'task_80cdd',
      title: 'R106 现场请求',
      lastRunId: null,
      lastRunStatus: null,
      recoverable: true,
      blockReason: null,
      lastFailureReason: 'write-authorization-changed',
    });
    expect(html).toContain('data-zs-dm-interrupted-kind="pre-dispatch"');
    expect(html).toContain('这条消息尚未发给 AI，原消息已保留。处理下面原因后可重新提交。');
    expect(html).toContain('尚未发给 AI');
    expect(html).toContain('失败原因：write-authorization-changed');
    expect(html).toContain('按当前配置重新提交');
    expect(html).not.toContain('授权或设置');
    expect(html).not.toContain('继续这次请求');
  });

  it('keeps the existing run-failure recovery label and evidence chain', () => {
    const html = render({
      taskId: 'task_existing_run',
      title: '已有运行',
      lastRunId: 'run_failed',
      lastRunStatus: 'FAILED',
      recoverable: true,
      blockReason: null,
      lastFailureReason: 'provider exited after one turn',
    });
    expect(html).toContain('data-zs-dm-interrupted-kind="executed"');
    expect(html).toContain('继续这次请求');
    expect(html).toContain('中断记录：provider exited after one turn');
    expect(html).not.toContain('按当前配置重新提交');
  });

  it('keeps UNKNOWN non-recoverable and routes the user to recovery evidence', () => {
    const html = render({
      taskId: 'task_unknown',
      title: '结果不确定',
      lastRunId: 'run_unknown',
      lastRunStatus: 'UNKNOWN',
      recoverable: false,
      blockReason: '存在结果不确定且未闭环的执行',
      lastFailureReason: 'process exit unconfirmed',
    });
    expect(html).toContain('检查上次回复');
    expect(html).toContain('目前还不能继续这次请求');
    expect(html).toContain('当前限制：存在结果不确定且未闭环的执行');
    expect(html).not.toMatch(/>继续这次请求<\/button>/);
    expect(html).not.toContain('按当前配置重新提交');
  });
});
