import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Composer } from '../../src/ui/hifi/components/Composer.tsx';
import {
  latestReadableAgentMessageId,
  MessageView,
} from '../../src/ui/hifi/components/MessageView.tsx';
import { NavTaskMark } from '../../src/ui/hifi/components/NavMarks.tsx';
import {
  addConversationQuoteToDraft,
  getState,
  setDraftFull,
  setState,
} from '../../src/ui/hifi/data/store.ts';
import type { Message, ProjectMember } from '../../src/ui/hifi/data/types.ts';

const initial = getState();
const LONG = Array.from({ length: 20 }, (_, index) => `第 ${index + 1} 行；请确认采用方案甲。`).join('\n');
const member: ProjectMember = {
  id: 'm1', projectId: 'p1', profileId: 'profile_m1', displayName: '成员甲', ordinal: 1,
  enabled: true, principalType: 'agent', workState: 'idle', model: 'fixture', effort: 'medium',
  internalSubagents: false, isCoordinatorDefault: false,
};

const message = (
  id: string,
  authorType: Message['authorType'],
  body: string,
  extra: Partial<Message> = {},
): Message => ({
  id, projectId: 'p1', roomId: 'r1', threadId: 't1', threadMessageSeq: 1,
  authorType, authorId: authorType === 'human' ? 'you' : authorType === 'agent' ? 'm1' : 'system',
  kind: authorType === 'system' ? 'system' : 'text', body, createdAt: 1, ...extra,
});

beforeEach(() => {
  setState(() => initial);
});

afterEach(() => {
  setState(() => initial);
});

describe('R128 latest message and navigation marks', () => {
  it('uses render order and ignores later system notices when selecting the latest readable AI reply', () => {
    const rendered = [
      message('older', 'agent', '较早回答'),
      message('human', 'human', '随后补充'),
      message('latest-agent', 'agent', LONG),
      message('empty-agent', 'agent', ''),
      message('system', 'system', '后台任务已完成'),
    ];
    expect(latestReadableAgentMessageId(rendered)).toBe('latest-agent');
  });

  it('forces only the latest AI reply open while older long replies keep the normal fold', () => {
    const history = renderToStaticMarkup(createElement(MessageView, {
      message: message('history', 'agent', LONG),
      author: member,
      readingAids: true,
    }));
    const latest = renderToStaticMarkup(createElement(MessageView, {
      message: message('latest', 'agent', LONG, {
        delivery: { status: 'needs_user', question: '请确认采用方案甲，还是继续使用方案乙。' },
      }),
      author: member,
      readingAids: true,
      forceExpanded: true,
    }));
    expect(history).toContain('msg-fold is-folded');
    expect(history).toContain('展开全文');
    expect(latest).not.toContain('msg-fold is-folded');
    expect(latest).not.toContain('展开全文');
    expect(latest).toContain('data-zs-reading-mode="latest-expanded"');
    expect(latest).toContain('请确认采用方案甲，还是继续使用方案乙。');
    expect(latest).toContain('第 20 行；请确认采用方案甲。');
  });

  it('keeps idle empty while blocked octagon and active triangle use the accent path', () => {
    const idle = renderToStaticMarkup(createElement(NavTaskMark, {
      summary: { state: undefined, counts: [], total: 0 },
      where: '空闲房间',
    }));
    const blocked = renderToStaticMarkup(createElement(NavTaskMark, {
      summary: { state: 'BLOCKED', counts: [{ state: 'BLOCKED', count: 1 }], total: 1 },
      where: '受阻房间',
    }));
    const active = renderToStaticMarkup(createElement(NavTaskMark, {
      summary: { state: 'ACTIVE', counts: [{ state: 'ACTIVE', count: 1 }], total: 1 },
      where: '运行房间',
    }));
    const review = renderToStaticMarkup(createElement(NavTaskMark, {
      summary: { state: 'REVIEW', counts: [{ state: 'REVIEW', count: 1 }], total: 1 },
      where: '待验收房间',
    }));
    expect(idle).toBe('');
    expect(blocked).toContain('class="side-state accent"');
    expect(blocked).toContain('data-zs-nav-task-state="BLOCKED"');
    expect(blocked).toContain('data-icon="octagon"');
    expect(active).toContain('class="side-state active"');
    expect(active).toContain('data-zs-nav-task-state="ACTIVE"');
    expect(active).toContain('data-icon="play"');
    expect(active).toContain('<polygon');
    expect(active).not.toContain('running');
    expect(review).toContain('class="side-state alert"');
    expect(review).toContain('data-icon="eye"');
  });

  it('puts a persistent type=button delete control at the tail of a two-quote chip group', () => {
    const draftKey = 'thread:r128-quote-group';
    setDraftFull(draftKey, { body: '保留正文', mentions: [], attachments: [], access: 'default', sendAs: 'ai' });
    addConversationQuoteToDraft(draftKey, { messageId: 'q1', authorLabel: '成员甲', text: '第一条引用' });
    addConversationQuoteToDraft(draftKey, { messageId: 'q2', authorLabel: '成员乙', text: '第二条引用' });
    const html = renderToStaticMarkup(createElement(Composer, {
      target: { kind: 'thread', roomId: 'r1', threadId: 't1' },
      draftKey,
      onSend: () => undefined,
    }));
    expect(html).toContain('role="group" aria-label="2 条对话引用" data-zs-conversation-quote-count="2"');
    expect(html).toContain('aria-label="2 条对话引用；查看详情"');
    expect(html).toContain('type="button"');
    expect(html).toContain('class="composer-quote-remove-all"');
    expect(html).toContain('aria-label="删除全部 2 条对话引用"');
    expect(html).toContain('data-zs-conversation-quote-remove-all="2"');
  });
});
