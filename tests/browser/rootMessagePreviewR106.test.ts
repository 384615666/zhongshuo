import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RootMessagePreview, rootMessagePreviewOverflows } from '../../src/ui/hifi/components/MessageView.tsx';
import type { Message } from '../../src/ui/hifi/data/types.ts';

const message = (body: string): Message => ({
  id: 'root-r106',
  projectId: 'project',
  roomId: 'room',
  authorType: 'human',
  authorId: 'you',
  kind: 'text',
  body,
  createdAt: 1,
});

const render = (body: string): string =>
  renderToStaticMarkup(createElement(RootMessagePreview, { message: message(body) }));

describe('R106 room-pool message preview', () => {
  it('keeps a short body complete and untruncated', () => {
    const html = render('短结论，直接读完。');
    expect(html).toContain('data-zs-root-message-preview="complete"');
    expect(html).not.toContain('root-message-preview is-folded');
    expect(html).not.toContain('进入对话串查看全文与回复');
    expect(html).toContain('短结论，直接读完。');
  });

  it('marks a long body as a visual preview while retaining every source line', () => {
    const lines = Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 行，完整原文`);
    const html = render(lines.join('\n'));
    expect(html).toContain('root-message-preview is-folded');
    expect(html).toContain('data-zs-root-message-preview="folded"');
    expect(html).toContain('第 1 行，完整原文');
    expect(html).toContain('第 12 行，完整原文');
    expect(html).toContain('进入对话串查看全文与回复');
    expect(html).toContain('data-zs-root-message-preview-prompt="1"');
  });

  it('uses a layout measurement for sub-threshold text that wraps beyond five lines', () => {
    const nearThreshold = '窄窗中的长中文段落。'.repeat(25);
    const html = render(nearThreshold);
    expect(nearThreshold.length).toBeLessThan(360);
    expect(html).toContain('data-zs-root-message-preview="complete"');

    const lineHeight = 24.75;
    expect(rootMessagePreviewOverflows(lineHeight * 5, lineHeight)).toBe(false);
    expect(rootMessagePreviewOverflows(lineHeight * 6, lineHeight)).toBe(true);
  });

  it('has no inline expand button and keeps Markdown rendering with a visible prompt', () => {
    const html = render(`**完整原文**：${'长正文内容。'.repeat(80)}`);
    expect(html).toContain('<strong>完整原文</strong>');
    expect(html).toContain('root-message-preview is-folded');
    expect(html).toContain('进入对话串查看全文与回复');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('msg-fold-toggle');
  });
});
