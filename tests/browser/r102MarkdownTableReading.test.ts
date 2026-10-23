import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {MarkdownView, parseBlocks} from '../../src/ui/hifi/preview/MarkdownView';

const render = (text: string) => renderToStaticMarkup(createElement(MarkdownView, {text}));

describe('R102 Markdown table reading', () => {
  it('keeps all five prose columns and renders explicit cell line breaks without losing emphasis', () => {
    const source = [
      '| 场景 | 事实<br>与判断 | 处理方式 | 验收条件 | 备注 |',
      '| --- | --- | --- | --- | --- |',
      '| A | 第一项<br/>第二项<BR />第三项 | **先检查<br>再处理** | 核对金额与状态，保留完整记录。 | [说明<br />链接](https://example.com) |',
    ].join('\n');
    expect(parseBlocks(source)[0]?.rows?.[0]).toHaveLength(5);
    const html = render(source);
    expect(html.match(/<th>/g)).toHaveLength(5);
    expect(html.match(/<td>/g)).toHaveLength(5);
    expect(html).toContain('<th>事实<br/>与判断</th>');
    expect(html).toContain('<td>第一项<br/>第二项<br/>第三项</td>');
    expect(html).toContain('<strong>先检查<br/>再处理</strong>');
    expect(html).toContain('说明<br/>链接');
    expect(html).toContain('核对金额与状态，保留完整记录。');
  });

  it('only recognizes attribute-free br tags and leaves scripts, image handlers and other HTML inert', () => {
    const html = render([
      '| 名称 | 内容 |', '| --- | --- |',
      '| 检查 | 安全<br>换行 <br onclick="bad()"> <img src=x onerror="bad()"> <script>bad()</script> <div>原文</div> |',
    ].join('\n'));
    expect(html.match(/<br\/>/g)).toHaveLength(1);
    expect(html).toContain('&lt;br onclick=&quot;bad()&quot;&gt;');
    expect(html).toContain('&lt;img src=x onerror=&quot;bad()&quot;&gt;');
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(html).toContain('&lt;div&gt;原文&lt;/div&gt;');
    expect(html).not.toMatch(/<(?:script|img|div>原文|br onclick)/);
  });

  it('keeps br literals and long identifiers intact in inline code, fenced source and ordinary prose', () => {
    const token = 'opaque_identifier_'.repeat(80);
    const html = render([
      '| 例子 | 标识 |', '| --- | --- |', `| \`<br>\` | \`${token}\` |`, '',
      '正文里的 <br> 保持原文。', '', '```txt', '<br>', token, '```',
    ].join('\n'));
    expect(html).toContain('<code class="md-code">&lt;br&gt;</code>');
    expect(html).toContain(`<code class="md-code">${token}</code>`);
    expect(html).toContain('正文里的 &lt;br&gt; 保持原文。');
    expect(html).toContain(`<code>&lt;br&gt;\n${token}</code>`);
    expect(html).not.toContain('<br/>');
  });
});
