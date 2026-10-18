import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownView } from '../../src/ui/hifi/preview/MarkdownView.tsx';
import { MessageView } from '../../src/ui/hifi/components/MessageView.tsx';
import type { Message } from '../../src/ui/hifi/data/types.ts';

const message = (overrides: Partial<Message>): Message => ({
  id: 'm1',
  projectId: 'p1',
  roomId: 'r1',
  authorType: 'human',
  authorId: 'u_local',
  kind: 'text',
  body: '正文',
  createdAt: 1,
  ...overrides,
});

describe('R88 chat reading and safe rich content', () => {
  it('renders readable tables, bounded code controls, safe flowchart SVG and bounded chart JSON without raw HTML', () => {
    const source = [
      '# 结果',
      '',
      '| 项目 | 状态 |',
      '| --- | --- |',
      '| 构建 | 通过 |',
      '',
      '```ts',
      'const answer = 42;',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  A[开始] --> B{检查}',
      '  B -->|通过| C[完成]',
      '```',
      '',
      '```chart',
      '{"title":"通过数","type":"bar","data":[{"label":"A","value":3},{"label":"B","value":5}]}',
      '```',
      '',
      '<script>alert(1)</script>',
    ].join('\n');
    const html = renderToStaticMarkup(createElement(MarkdownView, { text: source }));
    expect(html).toContain('class="md-table-wrap"');
    expect(html).toContain('data-md-code="ts"');
    expect(html).toContain('aria-label="复制代码"');
    expect(html).toContain('data-md-diagram="flowchart"');
    expect(html).toContain('data-flow-node="B"');
    expect(html).toContain('data-md-diagram="chart"');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('shows copy, quote and favorite directly and keeps human messages on the right with readable Markdown', () => {
    const html = renderToStaticMarkup(createElement(MessageView, {
      message: message({ body: '## 我的要求\n\n| 项 | 值 |\n| --- | --- |\n| 交付 | 可读 |' }),
      onQuote: () => {},
      onSave: () => {},
    }));
    expect(html).toContain('msg msg-human');
    expect(html).toContain('复制');
    expect(html).toContain('引用');
    expect(html).toContain('收藏');
    expect(html).toContain('md-table-wrap');
    expect(html).not.toContain('more-horizontal');
    expect(html).not.toContain('消息操作');
  });

  it('keeps unknown diagram source inert and labels the fallback', () => {
    const html = renderToStaticMarkup(createElement(MarkdownView, { text: '```mermaid\nflowchart LR\nA --> B --> C\n```' }));
    expect(html).toContain('data-md-code="mermaid"');
    expect(html).toContain('不会加载远程 Mermaid');
    expect(html).not.toContain('data-md-diagram="flowchart"');
  });
});
