/**
 * R204：设置页「我的名字」行排版合同。
 *
 * 用户反馈：该行输入框/保存按钮比其它行更靠右、贴到卡片边缘（因为名字行包在
 * `[data-zs-viewer-name]` 里，漏掉了 `.settings-card-body > .pset-row` 的 20px 内边距）。
 * 运行期几何由 scripts/capture-r204-settings-ui.cjs 在 1360/1324/1200/1100/1024/900/700
 * 七个宽度断言：控件不越界、按钮与主题行右对齐、名字行有内边距、输入/按钮同行。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('R204 settings viewer-name row layout', () => {
  it('gives the wrapped viewer-name row the same horizontal card padding as other rows', () => {
    const css = read('src/ui/hifi/styles/r170-settings.css');
    expect(css).toMatch(/\.settings-card-body > \[data-zs-viewer-name\] > \.pset-row\s*\{[^}]*padding: 13px 20px;/);
    // 窄窗同一行必须跟随其它行收窄到 14px，否则 700px 档又会出现贴边。
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*?\[data-zs-viewer-name\] > \.pset-row/);
  });

  it('keeps the viewer-name row inside the card content box in the capture harness', () => {
    const script = read('scripts/capture-r204-settings-ui.cjs');
    expect(script).toContain('保存按钮与其它行的控件右对齐');
    expect(script).toContain('名字行有卡片内边距');
    expect(script).toContain('[700, 760]');
    expect(script).toContain('rowPaddingRight');
    expect(script).toContain('themeControlRight');
  });
});
