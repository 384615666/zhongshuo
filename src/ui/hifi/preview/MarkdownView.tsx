/**
 * Markdown 渲染（原型自实现，无第三方依赖）。
 *
 * 覆盖 fixture 实际用到的结构：标题、段落、无序/有序列表、表格、
 * 行内代码、粗体、引用块、代码块、分割线。
 *
 * **安全边界（§8.3 必须遵守）**：
 *  - 不渲染原始 HTML —— 它按纯文本显示，绝不注入 DOM；
 *  - 不用 dangerouslySetInnerHTML，因此天然没有脚本执行路径；
 *  - 链接不自动打开，只标注为外部链接（外部协议白名单属正式实现范围）。
 *
 * 为什么自己写而不是引库：本原型依赖已锁定（package.json），
 * 施工说明 §3 要求"必要依赖应最小化"。渲染需求很窄，自实现可控且可测。
 */

import { Fragment, useMemo } from 'react';

interface Block {
  kind: 'h' | 'p' | 'ul' | 'ol' | 'code' | 'quote' | 'table' | 'hr';
  level?: number;
  text?: string;
  items?: string[];
  rows?: string[][];
  header?: string[];
  lang?: string;
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过结束标记
      blocks.push({ kind: 'code', text: buf.join('\n'), lang });
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ kind: 'h', level: h[1].length, text: h[2] });
      i++;
      continue;
    }

    // 分割线
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行
    if (line.includes('|') && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1] ?? '')) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    // 引用块
    if (line.trimStart().startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('>')) {
        buf.push(lines[i].trimStart().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ kind: 'quote', text: buf.join('\n') });
      continue;
    }

    // 列表（无序 / 有序）
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const ordered = Boolean(ol);
      const items: string[] = [];
      const re = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      while (i < lines.length) {
        const m = re.exec(lines[i]);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      blocks.push({ kind: ordered ? 'ol' : 'ul', items });
      continue;
    }

    // 空行
    if (line.trim() === '') { i++; continue; }

    // 段落：连续非空行合并
    const buf: string[] = [];
    while (
      i < lines.length && lines[i].trim() !== ''
      && !/^(#{1,6})\s/.test(lines[i])
      && !lines[i].trimStart().startsWith('```')
      && !lines[i].trimStart().startsWith('>')
      && !/^\s*[-*+]\s+/.test(lines[i])
      && !/^\s*\d+[.)]\s+/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ kind: 'p', text: buf.join('\n') });
  }
  return blocks;
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/**
 * 行内标记：**粗体**、`代码`、[文本](链接)。
 *
 * 顺序很重要：先切代码段，避免代码里的 `**` 被当成粗体
 * （这正是原型里曾经出现过的"字面星号被渲染"那类缺陷）。
 */
function renderInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // 用捕获组切分，奇数下标是代码内容
  const parts = text.split(/(`[^`]*`)/g);
  parts.forEach((part, pi) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      out.push(<code className="md-code" key={`c${pi}`}>{part.slice(1, -1)}</code>);
      return;
    }
    // 粗体
    const boldSplit = part.split(/(\*\*[^*]+\*\*)/g);
    boldSplit.forEach((seg, si) => {
      if (seg.startsWith('**') && seg.endsWith('**') && seg.length > 4) {
        out.push(<strong key={`b${pi}-${si}`}>{seg.slice(2, -2)}</strong>);
        return;
      }
      // 链接：只显示文本 + 外链标记，不自动打开
      const linkSplit = seg.split(/(\[[^\]]+\]\([^)]+\))/g);
      linkSplit.forEach((piece, li) => {
        const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(piece);
        if (m) {
          out.push(
            <span className="md-link" key={`l${pi}-${si}-${li}`} title={`外部链接（原型不自动打开）：${m[2]}`}>
              {m[1]}<span className="md-link-mark">↗</span>
            </span>,
          );
        } else if (piece) {
          out.push(<Fragment key={`t${pi}-${si}-${li}`}>{piece}</Fragment>);
        }
      });
    });
  });
  return out;
}

export function MarkdownView({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);

  return (
    <div className="md-view">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'h': {
            const Tag = (`h${Math.min(b.level ?? 1, 6)}`) as 'h1';
            return <Tag className={`md-h md-h${b.level}`} key={i}>{renderInline(b.text ?? '')}</Tag>;
          }
          case 'p':
            return <p className="md-p" key={i}>{renderInline(b.text ?? '')}</p>;
          case 'ul':
            return (
              <ul className="md-ul" key={i}>
                {(b.items ?? []).map((it, j) => <li key={j}>{renderInline(it)}</li>)}
              </ul>
            );
          case 'ol':
            return (
              <ol className="md-ol" key={i}>
                {(b.items ?? []).map((it, j) => <li key={j}>{renderInline(it)}</li>)}
              </ol>
            );
          case 'quote':
            return <blockquote className="md-quote" key={i}>{renderInline(b.text ?? '')}</blockquote>;
          case 'code':
            return (
              <pre className="md-pre" key={i} data-lang={b.lang}>
                <code>{b.text}</code>
              </pre>
            );
          case 'table':
            return (
              <div className="md-table-wrap" key={i}>
                <table className="md-table">
                  <thead>
                    <tr>{(b.header ?? []).map((h, j) => <th key={j}>{renderInline(h)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {(b.rows ?? []).map((r, ri) => (
                      <tr key={ri}>{r.map((c, ci) => <td key={ci}>{renderInline(c)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'hr':
            return <hr className="md-hr" key={i} />;
        }
      })}
    </div>
  );
}
