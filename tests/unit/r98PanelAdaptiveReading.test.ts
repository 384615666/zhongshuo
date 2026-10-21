import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string): string =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');

const componentsCss = read('src/ui/hifi/styles/components.css');
const previewCss = read('src/ui/hifi/styles/preview.css');
const previewPane = read('src/ui/hifi/preview/PreviewPane.tsx');

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
}

describe('R98 panel-adaptive message layout', () => {
  it('uses the message panel as the width source and removes the old fixed caps', () => {
    const list = rule(componentsCss, '.msg-list');
    const message = rule(componentsCss, '.msg');
    const human = rule(componentsCss, '.msg.msg-human');
    const text = rule(componentsCss, '.msg-text');
    const bubble = rule(componentsCss, '.msg-list.is-replies .msg-human-bubble');

    expect(list).toContain('width: 100%');
    expect(list).toContain('container-type: inline-size');
    expect(list).toContain('container-name: zs-message-panel');
    expect(message).toContain('width: 100%');
    expect(message).toContain('max-width: none');
    expect(human).toContain('align-self: flex-end');
    expect(human).toContain('width: auto');
    expect(human).toContain('max-width: 78%');
    expect(text).toContain('width: 100%');
    expect(text).toContain('max-width: none');
    expect(bubble).toContain('max-width: 100%');
    expect(message).not.toContain('920px');
    expect(componentsCss).not.toContain('max-width: 76ch');
    expect(componentsCss).not.toContain('max-width: min(600px, 100%)');
    expect(componentsCss).not.toContain('max-width: min(78%, 760px)');
  });

  it('links attachments to the same width and changes narrow action rows by panel width', () => {
    expect(rule(componentsCss, '.msg-attachment-footer')).toContain('width: 100%');
    expect(rule(componentsCss, '.msg-inline-attachments')).toContain('width: 100%');
    expect(rule(componentsCss, '.inline-file-chip')).toContain('max-width: 100%');
    expect(componentsCss).toContain('@container zs-message-panel (max-width: 560px)');
    expect(componentsCss).toContain('.msg-list.is-replies .msg.msg-human .msg-body > .msg-actions { grid-column: 2; }');
  });
});

describe('R98 preview reading width and action order', () => {
  it('defaults Markdown to the preview panel and gates 82ch behind the explicit option', () => {
    expect(rule(previewCss, '.preview-pane')).toContain('container-type: inline-size');
    expect(rule(previewCss, '.preview-pane')).toContain('container-name: preview-pane');
    expect(rule(previewCss, '.md-view')).toContain('width: 100%');
    expect(rule(previewCss, '.md-view')).toContain('max-width: none');
    expect(rule(previewCss, '.preview-read-doc')).toContain('max-width: none');
    expect(previewCss).toContain('.preview-pane.is-reading-measure .preview-body');
    expect(previewCss).toContain('max-width: 82ch');
    expect(rule(previewCss, '.md-table-wrap')).toContain('width: 100%');
    expect(rule(previewCss, '.md-code-card')).toContain('width: 100%');
    expect(previewCss).toContain('@container preview-pane (max-width: 520px)');
  });

  it('orders the primary controls as More -> maximize/restore -> collapse', () => {
    const more = previewPane.indexOf('data-preview-action="more"');
    const maximize = previewPane.indexOf('data-preview-action="maximize"');
    const restore = previewPane.indexOf('data-preview-action="restore"');
    const collapse = previewPane.indexOf('data-preview-action="collapse"');
    const resize = Math.min(...[maximize, restore].filter((index) => index >= 0));

    expect(more).toBeGreaterThanOrEqual(0);
    expect(resize).toBeGreaterThan(more);
    expect(collapse).toBeGreaterThan(resize);
    expect(previewPane).toContain('aria-label="更多文件操作"');
    expect(previewPane).toContain('aria-label="放大预览"');
    expect(previewPane).toContain('aria-label="还原预览大小"');
    expect(previewPane).toContain('aria-label="收起预览区"');
    expect(previewPane).toContain('title="收起预览区（保留全部标签与阅读位置）"');
  });

  it('exposes the optional reading measure without replacing document content', () => {
    expect(previewPane).toContain("const [readingMeasure, setReadingMeasure] = useState(false)");
    expect(previewPane).toContain('data-zs-reading-measure');
    expect(previewPane).toContain('限宽阅读');
    expect(previewPane).toContain('铺满阅读');
    expect(previewPane).toContain('setReadingMeasure');
    expect(previewPane).toContain('<MarkdownView text={text} />');
  });
});
