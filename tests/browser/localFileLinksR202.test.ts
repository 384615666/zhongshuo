import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownView } from '../../src/ui/hifi/preview/MarkdownView.tsx';
import { localPathFromFileHref } from '../../src/ui/hifi/lib/localFileHref.ts';

describe('R202 local file links', () => {
  it('shows the actual filename even when the Markdown label disguises an executable', () => {
    const html = renderToStaticMarkup(createElement(MarkdownView, {
      text: '[报告.pdf](file:///C:/exports/run.cmd)',
    }));
    expect(html).toContain('data-zs-local-file-link="C:\\exports\\run.cmd"');
    expect(html).toContain('class="md-file-link-name truncate">run.cmd</span>');
    expect(html).not.toContain('报告.pdf');
  });

  it('resolves localhost and ignores URL query/fragment without changing encoded filename characters', () => {
    expect(localPathFromFileHref('file://localhost/C:/exports/a%23b.txt#page=2')).toBe('C:\\exports\\a#b.txt');
    expect(localPathFromFileHref('file:///C:/exports/a.txt?download=1')).toBe('C:\\exports\\a.txt');
  });

  it('rejects malformed file URLs instead of inventing UNC paths', () => {
    for (const href of ['file://', 'file://server', 'file:///relative.png', 'file:///C:/a%00b.txt', 'file:///C:/bad%ZZ.txt', 'file:///C:/a%2fb.txt', 'file:///C:/a%5cb.txt']) {
      expect(localPathFromFileHref(href), href).toBeNull();
    }
  });

  it('keeps HTML and script links inert in rendered Markdown', () => {
    const html = renderToStaticMarkup(createElement(MarkdownView, {
      text: '<img src=x onerror=alert(1)> [click](javascript:alert(1))',
    }));
    expect(html).toContain('&lt;img');
    expect(html).not.toMatch(/<img|<script|href="javascript:/);
    expect(html).not.toContain('data-zs-local-file-link');
  });
});
