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

import { Fragment, useId, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';

/** 「**标签**：内容」字段；list 是紧跟在标签行后面的列表（如「**验收**：」下面的要点）。 */
export interface SpecField {
  label: string;
  text: string;
  list?: { ordered: boolean; items: string[] };
}

export interface Block {
  kind: 'h' | 'p' | 'ul' | 'ol' | 'code' | 'quote' | 'table' | 'hr' | 'spec';
  level?: number;
  text?: string;
  items?: string[];
  rows?: string[][];
  header?: string[];
  lang?: string;
  fields?: SpecField[];
}

export function parseBlocks(src: string): Block[] {
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

/* ---------------- 聊天消息阅读辅助（仅 specTables / headingAnchors 开启时使用，文件预览不走这里） ---------------- */

/** 「**标签**：内容」或「**标签：**内容」；标签 1–8 个字，不含星号与冒号。 */
const SPEC_LABEL = /^\s*\*\*([^*\n：:]{1,8})(?:\*\*[：:]|[：:]\*\*)\s*(.*)$/;

/**
 * 把一个段落拆成字段。首行不是标签行、或标签行少于 minLabels 时返回 null。
 * 非标签行并入上一个字段（折行续写），不丢字。
 */
function specFieldsOf(text: string, minLabels: number): SpecField[] | null {
  const fields: SpecField[] = [];
  for (const line of text.split('\n')) {
    const m = SPEC_LABEL.exec(line);
    if (m) { fields.push({ label: m[1]!, text: m[2]! }); continue; }
    const last = fields[fields.length - 1];
    if (!last) return null;
    last.text = last.text ? `${last.text}\n${line}` : line;
  }
  return fields.length >= minLabels ? fields : null;
}

/**
 * 把「连续 ≥2 个标签行」的段落合成字段表；其后紧跟的列表挂到最后一个字段，
 * 紧跟的标签段落并入同一张表。其它块原样保留，任何文字都不丢。
 */
export function groupSpecBlocks(blocks: Block[]): Block[] {
  const out: Block[] = [];
  let open: SpecField[] | null = null;
  for (const b of blocks) {
    if (b.kind === 'p') {
      const fields = specFieldsOf(b.text ?? '', open ? 1 : 2);
      if (fields) {
        if (open) open.push(...fields);
        else { open = fields; out.push({ kind: 'spec', fields: open }); }
        continue;
      }
    }
    if (open && (b.kind === 'ul' || b.kind === 'ol')) {
      const last = open[open.length - 1];
      if (last && !last.list) {
        last.list = { ordered: b.kind === 'ol', items: b.items ?? [] };
        continue;
      }
    }
    open = null;
    out.push(b);
  }
  return out;
}

/** 去掉行内标记，得到可放进目录芯片的纯文本。 */
export function plainInline(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .trim();
}

export interface OutlineItem {
  /** 与 MarkdownView 的 data-md-heading 同一口径：文档里第几个标题（含代码块外的全部层级）。 */
  index: number;
  level: number;
  title: string;
}

/**
 * 长回复的章节目录：取「出现 ≥3 次的最浅层标题」（h1→h3 依次试），最多 12 项。
 * 基于 parseBlocks，代码块里的 `## xxx` 不会被当成标题。
 */
export function outlineOf(text: string): OutlineItem[] {
  const heads: OutlineItem[] = [];
  let index = 0;
  for (const b of parseBlocks(text)) {
    if (b.kind !== 'h') continue;
    heads.push({ index, level: b.level ?? 1, title: plainInline(b.text ?? '') });
    index += 1;
  }
  for (const level of [1, 2, 3]) {
    const same = heads.filter((h) => h.level === level && h.title !== '');
    if (same.length >= 3) return same.slice(0, 12);
  }
  return [];
}

/**
 * 行内标记：**粗体**、`代码`、[文本](链接)。
 *
 * 顺序很重要：先切代码段，避免代码里的 `**` 被当成粗体
 * （这正是原型里曾经出现过的"字面星号被渲染"那类缺陷）。
 */
function renderInline(text: string, tableCell = false): React.ReactNode[] {
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
        out.push(<strong key={`b${pi}-${si}`}>{tableCell ? renderInline(seg.slice(2, -2), true) : seg.slice(2, -2)}</strong>);
        return;
      }
      // 链接：只显示文本 + 外链标记，不自动打开
      const linkSplit = seg.split(/(\[[^\]]+\]\([^)]+\))/g);
      linkSplit.forEach((piece, li) => {
        const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(piece);
        if (m) {
          out.push(
            <span className="md-link" key={`l${pi}-${si}-${li}`} title={`外部链接（原型不自动打开）：${m[2]}`}>
              {tableCell ? renderInline(m[1], true) : m[1]}<span className="md-link-mark">↗</span>
            </span>,
          );
        } else if (piece) {
          // Table-only whitelist; code spans were handled first and all other
          // HTML (including attributed <br>) remains ordinary escaped text.
          const fragments = tableCell ? piece.split(/(<br\s*\/?\s*>)/gi) : [piece];
          fragments.forEach((fragment, fi) => {
            out.push(tableCell && /^<br\s*\/?\s*>$/i.test(fragment)
              ? <br key={`br${pi}-${si}-${li}-${fi}`} />
              : <Fragment key={`t${pi}-${si}-${li}-${fi}`}>{fragment}</Fragment>);
          });
        }
      });
    });
  });
  return out;
}

function CodeCard({ text, lang, safeNote }: { text: string; lang?: string; safeNote?: string }) {
  const [wrapped, setWrapped] = useState(false);
  const [feedback, setFeedback] = useState('');
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setFeedback('已复制');
      window.setTimeout(() => setFeedback(''), 1400);
    } catch {
      setFeedback('复制失败');
    }
  };
  const language = lang?.trim() || 'text';
  return (
    <div className="md-code-card" data-md-code={language}>
      <div className="md-code-head">
        <span className="md-code-lang">{language}</span>
        <span className="small faint" aria-live="polite">{feedback}</span>
        <button type="button" className="btn ghost sm" onClick={() => setWrapped((value) => !value)} title={wrapped ? '保持代码原行宽' : '让长代码在栏内换行'}>
          <Icon name="align-left" size={12} /> {wrapped ? '不换行' : '换行'}
        </button>
        <button type="button" className="icon-btn sm" onClick={() => void copy()} aria-label="复制代码" title="复制代码">
          <Icon name="copy" size={12} />
        </button>
      </div>
      {safeNote ? <div className="md-safe-note">{safeNote}</div> : null}
      <pre className="md-pre" data-wrap={wrapped ? '1' : '0'}><code>{text}</code></pre>
    </div>
  );
}

type FlowNode = { id: string; label: string; shape: 'rect' | 'round' | 'diamond' };
type FlowEdge = { from: string; to: string; label?: string };
type ParsedFlowchart = { direction: 'TD' | 'LR'; nodes: FlowNode[]; edges: FlowEdge[]; depths: Map<string, number> };

function flowchartNode(id: string, square?: string, diamond?: string, round?: string, into?: Map<string, FlowNode>): void {
  if (into == null || into.has(id)) return;
  const raw = square ?? diamond ?? round ?? id;
  const label = raw.replace(/^["']|["']$/g, '').trim().slice(0, 80) || id;
  into.set(id, { id, label, shape: diamond != null ? 'diamond' : round != null ? 'round' : 'rect' });
}

function parseFlowchart(source: string): ParsedFlowchart | null {
  if (source.length > 12_000) return null;
  const lines = source.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith('%%'));
  const header = lines.shift() ?? '';
  const directionMatch = /^(?:flowchart|graph)\s+(TD|TB|LR)$/i.exec(header);
  if (directionMatch == null) return null;
  const direction = directionMatch[1]!.toUpperCase() === 'LR' ? 'LR' : 'TD';
  if (lines.length === 0 || lines.length > 80) return null;
  const nodeMap = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const edgePattern = /^([A-Za-z0-9_-]{1,40})(?:\[([^\]\r\n]{0,80})\]|\{([^}\r\n]{0,80})\}|\(([^)\r\n]{0,80})\))?\s*-->\s*(?:\|([^|\r\n]{0,40})\|\s*)?([A-Za-z0-9_-]{1,40})(?:\[([^\]\r\n]{0,80})\]|\{([^}\r\n]{0,80})\}|\(([^)\r\n]{0,80})\))?$/;
  const nodePattern = /^([A-Za-z0-9_-]{1,40})(?:\[([^\]\r\n]{0,80})\]|\{([^}\r\n]{0,80})\}|\(([^)\r\n]{0,80})\))$/;
  for (const line of lines) {
    const edge = edgePattern.exec(line);
    if (edge != null) {
      flowchartNode(edge[1]!, edge[2], edge[3], edge[4], nodeMap);
      flowchartNode(edge[6]!, edge[7], edge[8], edge[9], nodeMap);
      edges.push({ from: edge[1]!, to: edge[6]!, ...(edge[5] != null ? { label: edge[5].trim().slice(0, 40) } : {}) });
      if (nodeMap.size > 24 || edges.length > 40) return null;
      continue;
    }
    const node = nodePattern.exec(line);
    if (node != null) {
      flowchartNode(node[1]!, node[2], node[3], node[4], nodeMap);
      if (nodeMap.size > 24) return null;
      continue;
    }
    return null;
  }
  if (nodeMap.size === 0 || edges.length === 0) return null;
  const depths = new Map<string, number>();
  const incoming = new Set(edges.map((edge) => edge.to));
  for (const node of nodeMap.values()) if (!incoming.has(node.id)) depths.set(node.id, 0);
  if (depths.size === 0) return null;
  for (let pass = 0; pass < nodeMap.size; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      const from = depths.get(edge.from);
      if (from == null) continue;
      const next = from + 1;
      if (next > 12) return null;
      if ((depths.get(edge.to) ?? -1) < next) {
        depths.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  if ([...nodeMap.keys()].some((id) => !depths.has(id))) return null;
  return { direction, nodes: [...nodeMap.values()], edges, depths };
}

function FlowchartView({ source }: { source: string }) {
  const parsed = useMemo(() => parseFlowchart(source), [source]);
  const markerId = `md-arrow-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  if (parsed == null) {
    return <CodeCard text={source} lang="mermaid" safeNote="未识别的流程图保持为安全文本；不会加载远程 Mermaid 或执行脚本。" />;
  }
  const layers = new Map<number, FlowNode[]>();
  for (const node of parsed.nodes) {
    const depth = parsed.depths.get(node.id) ?? 0;
    layers.set(depth, [...(layers.get(depth) ?? []), node]);
  }
  const layerCount = Math.max(...layers.keys()) + 1;
  const widest = Math.max(...[...layers.values()].map((items) => items.length));
  const nodeW = 150;
  const nodeH = 46;
  const gapX = 62;
  const gapY = 34;
  const margin = 22;
  const width = margin * 2 + (parsed.direction === 'LR' ? layerCount * nodeW + (layerCount - 1) * gapX : widest * nodeW + (widest - 1) * gapX);
  const height = margin * 2 + (parsed.direction === 'TD' ? layerCount * nodeH + (layerCount - 1) * (gapY + 20) : widest * nodeH + (widest - 1) * gapY);
  const positions = new Map<string, { x: number; y: number }>();
  for (const [depth, items] of layers.entries()) {
    items.forEach((node, index) => {
      const x = parsed.direction === 'LR' ? margin + depth * (nodeW + gapX) : margin + index * (nodeW + gapX);
      const y = parsed.direction === 'LR' ? margin + index * (nodeH + gapY) : margin + depth * (nodeH + gapY + 20);
      positions.set(node.id, { x, y });
    });
  }
  return (
    <div className="md-diagram-wrap" data-md-diagram="flowchart">
      <svg className="md-diagram" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="流程图">
        <defs>
          <marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L8,4 L0,8 z" fill="var(--text-3)" />
          </marker>
        </defs>
        {parsed.edges.map((edge, index) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (from == null || to == null) return null;
          const x1 = parsed.direction === 'LR' ? from.x + nodeW : from.x + nodeW / 2;
          const y1 = parsed.direction === 'LR' ? from.y + nodeH / 2 : from.y + nodeH;
          const x2 = parsed.direction === 'LR' ? to.x : to.x + nodeW / 2;
          const y2 = parsed.direction === 'LR' ? to.y + nodeH / 2 : to.y;
          const midX = (x1 + x2) / 2;
          const midY = (y1 + y2) / 2;
          const path = parsed.direction === 'LR'
            ? `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`
            : `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
          return (
            <g key={`${edge.from}-${edge.to}-${index}`}>
              <path className="md-diagram-edge" d={path} markerEnd={`url(#${markerId})`} />
              {edge.label ? <text className="md-diagram-edge-label" x={midX} y={midY - 5}>{edge.label}</text> : null}
            </g>
          );
        })}
        {parsed.nodes.map((node) => {
          const pos = positions.get(node.id)!;
          return (
            <g key={node.id} data-flow-node={node.id}>
              {node.shape === 'diamond' ? (
                <polygon
                  className={`md-diagram-node${(parsed.depths.get(node.id) ?? 0) === 0 ? ' accent' : ''}`}
                  points={`${pos.x + nodeW / 2},${pos.y} ${pos.x + nodeW},${pos.y + nodeH / 2} ${pos.x + nodeW / 2},${pos.y + nodeH} ${pos.x},${pos.y + nodeH / 2}`}
                />
              ) : (
                <rect
                  className={`md-diagram-node${(parsed.depths.get(node.id) ?? 0) === 0 ? ' accent' : ''}`}
                  x={pos.x}
                  y={pos.y}
                  width={nodeW}
                  height={nodeH}
                  rx={node.shape === 'round' ? nodeH / 2 : 9}
                />
              )}
              <text className="md-diagram-label" x={pos.x + nodeW / 2} y={pos.y + nodeH / 2}>
                {node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label}
                <title>{node.label}</title>
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

type ChartDatum = { label: string; value: number };
type ChartSpec = { title: string | null; data: ChartDatum[] };

function parseChart(source: string): ChartSpec | null {
  if (source.length > 20_000) return null;
  try {
    const parsed = JSON.parse(source) as unknown;
    const record = parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    const type = record?.type;
    if (typeof type === 'string' && !['bar', 'column', 'horizontal-bar'].includes(type.toLowerCase())) return null;
    const rows = Array.isArray(parsed) ? parsed : record != null && Array.isArray(record.data) ? record.data : null;
    if (rows == null || rows.length === 0 || rows.length > 24) return null;
    const data: ChartDatum[] = [];
    for (const row of rows) {
      if (Array.isArray(row)) {
        const value = Number(row[1]);
        if (typeof row[0] === 'string' && Number.isFinite(value)) data.push({ label: row[0].slice(0, 80), value });
        continue;
      }
      if (row == null || typeof row !== 'object') continue;
      const item = row as Record<string, unknown>;
      const label = [item.label, item.name, item.category, item.x].find((value) => typeof value === 'string');
      const value = Number([item.value, item.y, item.count].find((candidate) => Number.isFinite(Number(candidate))));
      if (typeof label === 'string' && Number.isFinite(value)) data.push({ label: label.slice(0, 80), value });
    }
    if (data.length === 0) return null;
    const title = record != null && typeof record.title === 'string' && record.title.trim().length > 0 ? record.title.trim().slice(0, 100) : null;
    return { title, data };
  } catch {
    return null;
  }
}

function ChartView({ source }: { source: string }) {
  const chart = useMemo(() => parseChart(source), [source]);
  if (chart == null) {
    return <CodeCard text={source} lang="chart" safeNote="图表数据未通过有界 JSON 校验，保留为安全文本；不会执行配置或脚本。" />;
  }
  const max = Math.max(...chart.data.map((item) => Math.abs(item.value)), 1);
  return (
    <div className="md-diagram-wrap" data-md-diagram="chart" role="img" aria-label={chart.title ?? '数据图表'}>
      <div className="md-chart">
        {chart.title ? <div className="md-chart-title">{chart.title}</div> : null}
        <div className="md-chart-bars">
          {chart.data.map((item, index) => (
            <div className="md-chart-row" key={`${item.label}-${index}`}>
              <span className="truncate" title={item.label}>{item.label}</span>
              <span className="md-chart-track"><span className="md-chart-fill" style={{ width: `${Math.max(2, Math.abs(item.value) / max * 100)}%` }} /></span>
              <span className="mono-sm">{item.value.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * specTables / headingAnchors 默认关闭：文件预览（PreviewPane）与历史行为保持逐字一致，
 * 只有聊天消息显式开启后才会把「**标签**：内容」段落渲染成字段表、给标题打目录锚点。
 */
export function MarkdownView({ text, specTables = false, headingAnchors = false }: { text: string; specTables?: boolean; headingAnchors?: boolean }) {
  const blocks = useMemo(() => {
    const parsed = parseBlocks(text);
    return specTables ? groupSpecBlocks(parsed) : parsed;
  }, [text, specTables]);
  /* 标题序号与 outlineOf 同口径：按文档顺序数所有标题块（字段表合并不改变标题块） */
  const headingIndex = useMemo(() => {
    let n = 0;
    return blocks.map((b) => (b.kind === 'h' ? n++ : -1));
  }, [blocks]);

  return (
    <div className="md-view">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'h': {
            const Tag = (`h${Math.min(b.level ?? 1, 6)}`) as 'h1';
            return <Tag className={`md-h md-h${b.level}`} key={i} data-md-heading={headingAnchors ? headingIndex[i] : undefined}>{renderInline(b.text ?? '')}</Tag>;
          }
          case 'spec':
            return (
              <dl className="md-spec" key={i}>
                {(b.fields ?? []).map((f, j) => (
                  <div className="md-spec-row" key={j}>
                    <dt>{f.label}</dt>
                    <dd>
                      {f.text ? <span className="md-spec-text">{renderInline(f.text)}</span> : null}
                      {f.list ? (
                        f.list.ordered
                          ? <ol className="md-ol">{f.list.items.map((it, k) => <li key={k}>{renderInline(it)}</li>)}</ol>
                          : <ul className="md-ul">{f.list.items.map((it, k) => <li key={k}>{renderInline(it)}</li>)}</ul>
                      ) : null}
                    </dd>
                  </div>
                ))}
              </dl>
            );
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
            if ((b.lang ?? '').toLowerCase() === 'mermaid') return <FlowchartView key={i} source={b.text ?? ''} />;
            if (['chart', 'vega', 'vega-lite'].includes((b.lang ?? '').toLowerCase())) return <ChartView key={i} source={b.text ?? ''} />;
            return <CodeCard key={i} text={b.text ?? ''} lang={b.lang} />;
          case 'table':
            return (
              <div className="md-table-wrap" key={i}>
                <table className="md-table">
                  <thead>
                    <tr>{(b.header ?? []).map((h, j) => <th key={j}>{renderInline(h, true)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {(b.rows ?? []).map((r, ri) => (
                      <tr key={ri}>{r.map((c, ci) => <td key={ci}>{renderInline(c, true)}</td>)}</tr>
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
