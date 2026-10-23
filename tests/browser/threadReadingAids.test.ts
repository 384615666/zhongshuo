import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownView, groupSpecBlocks, outlineOf, parseBlocks } from '../../src/ui/hifi/preview/MarkdownView.tsx';
import { MessageView } from '../../src/ui/hifi/components/MessageView.tsx';
import type { Message, ProjectMember } from '../../src/ui/hifi/data/types.ts';

const FIELDS = ['**做什么**：新增 3 个 Tab。', '**验收**：', '- Tab 名称可配置；', '- 数据互不影响。', '**待确认**：等级名称。'].join('\n');
const DOC = ['# 总述', '', '## 甲', '正文甲', '', '## 乙', '正文乙', '', '## 丙', '正文丙'].join('\n');
const LONG = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行需求`).join('\n');
const LONG_PARAGRAPH = '这是一段没有换行但足够长的回复。'.repeat(40);

const human = (body: string, extra: Partial<Message> = {}): Message => ({
  id: 'h1', projectId: 'p', roomId: 'r', authorType: 'human', authorId: 'you', kind: 'text', body, createdAt: 1, ...extra,
});
const agent = (body: string, extra: Partial<Message> = {}): Message => ({ ...human(body), id: 'a1', authorType: 'agent', authorId: 'member_x', ...extra });
const member: ProjectMember = {
  id: 'member_x', projectId: 'p', profileId: 'member_x', displayName: 'Claude', ordinal: 1, enabled: true,
  workState: 'unknown', model: 'm', effort: 'medium', internalSubagents: false, isCoordinatorDefault: false,
};
const render = (message: Message, readingAids?: boolean): string =>
  renderToStaticMarkup(createElement(MessageView, { message, author: message.authorType === 'human' ? undefined : member, readingAids }));

describe('spec-table grouping (opt-in, never drops text)', () => {
  it('merges consecutive label lines, attaches the list to its field and absorbs the next label paragraph', () => {
    const grouped = groupSpecBlocks(parseBlocks(FIELDS));
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.kind).toBe('spec');
    expect(grouped[0]?.fields?.map((f) => f.label)).toEqual(['做什么', '验收', '待确认']);
    expect(grouped[0]?.fields?.[1]?.list?.items).toEqual(['Tab 名称可配置；', '数据互不影响。']);
  });

  it('leaves a lone label, a lead-in paragraph and fenced code alone', () => {
    expect(groupSpecBlocks(parseBlocks('**优先级**：P0 先做。')).map((b) => b.kind)).toEqual(['p']);
    expect(groupSpecBlocks(parseBlocks('先说结论。\n**做什么**：A\n**验收**：B')).map((b) => b.kind)).toEqual(['p']);
    expect(groupSpecBlocks(parseBlocks('```md\n**做什么**：A\n**验收**：B\n```')).map((b) => b.kind)).toEqual(['code']);
  });

  it('closes the group at a heading and starts a fresh one afterwards', () => {
    const kinds = groupSpecBlocks(parseBlocks('**做什么**：A\n**验收**：B\n\n## 下一节\n\n**风险**：C\n**待确认**：D')).map((b) => b.kind);
    expect(kinds).toEqual(['spec', 'h', 'spec']);
  });

  it('is off by default: file-preview rendering keeps plain paragraphs and no anchors', () => {
    const plain = renderToStaticMarkup(createElement(MarkdownView, { text: `${FIELDS}\n\n## 标题` }));
    expect(plain).not.toContain('md-spec');
    expect(plain).not.toContain('data-md-heading');
    const aided = renderToStaticMarkup(createElement(MarkdownView, { text: `${FIELDS}\n\n## 标题`, specTables: true, headingAnchors: true }));
    expect(aided).toContain('<dt>做什么</dt>');
    expect(aided).toContain('数据互不影响。');
    expect(aided).toContain('data-md-heading="0"');
  });
});

describe('outlineOf', () => {
  it('uses the shallowest level that appears at least 3 times, indexed over all headings', () => {
    expect(outlineOf(DOC)).toEqual([
      { index: 1, level: 2, title: '甲' }, { index: 2, level: 2, title: '乙' }, { index: 3, level: 2, title: '丙' },
    ]);
  });

  it('returns nothing for fewer than 3, ignores fenced headings, strips inline markup and caps at 12', () => {
    expect(outlineOf('## 甲\n\n## 乙')).toEqual([]);
    expect(outlineOf('```\n## X\n## Y\n## Z\n```')).toEqual([]);
    expect(outlineOf('## **粗** `码` [链](http://x)\n## b\n## c')[0]?.title).toBe('粗 码 链');
    expect(outlineOf(Array.from({ length: 15 }, (_, i) => `## 节${i}`).join('\n\n'))).toHaveLength(12);
  });
});

describe('MessageView readingAids', () => {
  it('folds a long human paste only when enabled, keeps the full text and the actions row', () => {
    const on = render(human(LONG), true);
    expect(on).toContain('msg-fold is-folded');
    expect(on).toContain('aria-expanded="false"');
    expect(on).toContain('展开全文');
    expect(on).not.toContain('共 20 行');
    expect(on).toContain('第 20 行需求');
    expect(on).toContain('msg-actions');
    expect(render(human(LONG))).not.toContain('msg-fold');
    expect(render(human('好'), true)).not.toContain('msg-fold');
  });

  it('folds legacy over-budget AI prose but never folds, outlines or tables while streaming', () => {
    const legacy = render(agent(LONG), true);
    expect(legacy).toContain('msg-fold is-folded');
    expect(legacy).toContain('展开全文');
    expect(legacy).not.toContain('共 20 行');
    expect(render(human(LONG, { streaming: true }), true)).not.toContain('msg-fold');
    const live = render(agent(`${DOC}\n\n${FIELDS}`, { streaming: true }), true);
    expect(live).not.toContain('msg-outline');
    expect(live).not.toContain('md-spec');
  });

  it('uses an unambiguous long-paragraph fold label without a logical line count', () => {
    const html = render(human(LONG_PARAGRAPH), true);
    expect(html).toContain('msg-fold is-folded');
    expect(html).toContain('展开全文');
    expect(html).not.toContain('共 1 行');
  });

  it('gives long AI replies outline chips whose anchors exist, and field tables, only when enabled', () => {
    const on = render(agent(`${DOC}\n\n${FIELDS}`), true);
    expect(on.match(/msg-outline-chip/g)).toHaveLength(3);
    for (const item of outlineOf(DOC)) expect(on).toContain(`data-md-heading="${item.index}"`);
    expect(on).toContain('md-spec');
    const off = render(agent(`${DOC}\n\n${FIELDS}`));
    for (const marker of ['msg-outline', 'data-md-heading', 'md-spec']) expect(off).not.toContain(marker);
  });

  it('keeps ordinary files before the one detail card in the shared bottom footer', () => {
    const message = agent('短结论。', {
      formalAttachments: [
        { artifactId: 'art_gf_report', filename: '报告.txt', kind: 'text_file' },
        { artifactId: 'art_detail_complete', filename: '完整详情.md', kind: 'text_file', detailMarkdown: true },
      ],
    });
    const html = renderToStaticMarkup(createElement(MessageView, {
      message, author: member, readingAids: true, onOpenAttachment: () => {},
    }));
    expect(html.match(/class="message-document-card"/g)).toHaveLength(2);
    expect(html).toContain('msg-attachment-footer');
    const footer = html.slice(html.indexOf('msg-attachment-footer'));
    expect(footer.indexOf('data-zs-artifact-id="art_gf_report"')).toBeLessThan(footer.indexOf('data-zs-artifact-id="art_detail_complete"'));
    for (const [id, filename] of [['art_gf_report', '报告.txt'], ['art_detail_complete', '完整详情.md']]) {
      const button = footer.match(new RegExp(`<button[^>]*data-zs-attachment-open="${id}"[^>]*>`))?.[0];
      expect(button).toBeDefined();
      expect(button).toContain(`aria-label="打开 ${filename}"`);
      expect(button).not.toContain('disabled');
      expect(footer.match(new RegExp(`data-zs-artifact-id="${id}"`, 'g'))).toHaveLength(1);
    }
    expect(html).toContain('完整详情');
    expect(footer).not.toContain('查看变更');
    const withoutOpen = render(message, true);
    expect(withoutOpen.match(/data-zs-attachment-open="[^"]+"[^>]*disabled=""/g)).toHaveLength(2);
  });

  it('keeps an inline detail fallback readable after the folded prose', () => {
    const html = render(agent(LONG, { detailMarkdown: '# 完整详情\n\nR93_INLINE_FALLBACK_TAIL' }), true);
    expect(html).toContain('msg-fold is-folded');
    expect(html).toContain('完整详情（附件不可用，原文已保留）');
    expect(html).toContain('R93_INLINE_FALLBACK_TAIL');
    expect(html.indexOf('msg-fold-toggle')).toBeLessThan(html.indexOf('msg-detail-fallback'));
  });

  it('renders the member colour dot for agents only', () => {
    expect(render(agent('hi'), true)).toContain('msg-dot');
    expect(render(human('hi'), true)).not.toContain('msg-dot');
  });
});
