/**
 * 导出生成器（第三十轮五）：Markdown / 静态 HTML / DOCX。
 * - 范围快照：消息与附件清单按导出目标固定（audience 已在命令层逐项校验——不因导出扩大
 *   私信范围）；附件**托管副本**按 hash 拷入导出包 assets/（原件变化不影响导出内容；
 *   副本缺失=清单如实标注，不中断导出）。
 * - HTML：静态化+净化（全部转义后仅生成受控标签；无脚本/事件属性/远程资源——图片以
 *   assets 相对路径引用，离线可读）；DOCX：手写 OOXML（段落/表格/来源说明）经 zip 打包。
 * - 失败：抛错由命令层清理半截目录；成功返回文件清单与统计。
 */
import { mkdirSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { zipSync } from 'fflate';

export const TEXT_PREVIEW_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.rs', '.rb', '.php', '.swift', '.kt', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.sql', '.html', '.htm', '.css', '.scss', '.vue', '.svelte', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.lua', '.r', '.m', '.pl']);

export interface ExportMessage {
  id: string;
  conversation_id: string;
  thread_id: string | null;
  thread_message_seq: number | null;
  author_type: string;
  author_id: string;
  body_json: string;
  created_at: number;
}

export interface ExportAttachment {
  message_id: string;
  display_name: string | null;
  artifact_id: string;
  kind: string;
  hash: string;
  revision: number;
  blob_path: string;
  source_name: string | null;
}

export interface ExportInput {
  conv: { id: string; kind: string; room_id: string | null; archived_at: number | null };
  target: { kind: 'conversation' | 'thread'; threadId?: string };
  messages: ExportMessage[];
  attachments: ExportAttachment[];
  format: 'md' | 'html' | 'docx';
  exportDir: string;
  blobRoot: string;
}

const esc = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const escXml = esc;

interface Prepared {
  title: string;
  subtitle: string;
  rows: Array<{ at: string; author: string; text: string; threadNote: string | null; attachments: ExportAttachment[]; missing: string[] }>;
  assets: Array<{ file: string; att: ExportAttachment }>;
  stats: { messages: number; attachments: number; missing: number };
}

function prepare(input: ExportInput): Prepared {
  const byMsg = new Map<string, ExportAttachment[]>();
  for (const a of input.attachments) {
    const list = byMsg.get(a.message_id) ?? [];
    list.push(a);
    byMsg.set(a.message_id, list);
  }
  const assets: Array<{ file: string; att: ExportAttachment }> = [];
  const rows: Prepared['rows'] = [];
  const missing: string[] = [];
  for (const m of input.messages) {
    const body = JSON.parse(m.body_json) as { text?: string };
    const atts = byMsg.get(m.id) ?? [];
    const missingHere: string[] = [];
    const kept: ExportAttachment[] = [];
    for (const a of atts) {
      try {
        statSync(a.blob_path);
        kept.push(a);
        const file = `assets/${a.hash.slice(0, 16)}-${(a.display_name ?? a.artifact_id).replace(/[\\/:*?"<>|]/g, '_')}`;
        assets.push({ file, att: a });
      } catch {
        missingHere.push(a.display_name ?? a.artifact_id);
        missing.push(a.display_name ?? a.artifact_id);
      }
    }
    rows.push({
      at: new Date(m.created_at).toLocaleString('sv-SE').replace('T', ' '),
      author: `${m.author_type === 'human' ? '用户' : '成员'} ${m.author_id.slice(0, 8)}…`,
      text: body.text ?? '',
      threadNote: input.target.kind === 'conversation' && m.thread_id != null ? `线程消息（#${m.thread_message_seq ?? '?'}）` : null,
      attachments: kept,
      missing: missingHere,
    });
  }
  return {
    title: input.target.kind === 'thread' ? `线程导出（${input.target.threadId?.slice(0, 14)}…）` : `会话导出（${input.conv.id.slice(0, 14)}…）`,
    subtitle: `${input.conv.kind === 'dm' ? '私信会话' : '房间会话'} · ${input.messages.length} 条消息 · ${new Date().toISOString()}`,
    rows,
    assets,
    stats: { messages: input.messages.length, attachments: assets.length, missing: missing.length },
  };
}

/** 拷贝附件托管副本到导出包 assets/（hash 内容寻址——导出即快照）。 */
function copyAssets(exportDir: string, prepared: Prepared): void {
  if (prepared.assets.length === 0) return;
  mkdirSync(join(exportDir, 'assets'), { recursive: true });
  for (const { file, att } of prepared.assets) {
    copyFileSync(att.blob_path, join(exportDir, file.replaceAll('/', '\\')));
  }
}

export function writeExport(input: ExportInput): { files: string[]; stats: { messages: number; attachments: number; missing: number } } {
  const prepared = prepare(input);
  mkdirSync(input.exportDir, { recursive: true });
  copyAssets(input.exportDir, prepared);
  if (input.format === 'md') {
    const md = renderMarkdown(prepared);
    writeFileSync(join(input.exportDir, 'index.md'), md, 'utf8');
    return { files: ['index.md', ...prepared.assets.map((a) => a.file)], stats: prepared.stats };
  }
  if (input.format === 'html') {
    const html = renderHtml(prepared);
    writeFileSync(join(input.exportDir, 'index.html'), html, 'utf8');
    return { files: ['index.html', ...prepared.assets.map((a) => a.file)], stats: prepared.stats };
  }
  const docx = renderDocx(prepared);
  writeFileSync(join(input.exportDir, 'export.docx'), docx);
  return { files: ['export.docx', ...prepared.assets.map((a) => a.file)], stats: prepared.stats };
}

function attachmentLineMd(a: ExportAttachment, file: string | null): string {
  return `- 📎 ${a.display_name ?? a.artifact_id}（${a.kind} · v${a.revision} · sha256=${a.hash.slice(0, 12)}…${file != null ? ` · [随包副本](./${file.replaceAll('\\', '/')})` : ''}）`;
}

function renderMarkdown(p: Prepared): string {
  const NL = String.fromCharCode(10);
  let out = `# ${p.title}${NL}${NL}> ${p.subtitle}${NL}${NL}`;
  if (p.stats.missing > 0) out += `> ⚠ ${p.stats.missing} 个附件原件缺失（清单如实标注）${NL}${NL}`;
  for (const r of p.rows) {
    out += `## ${r.at} · ${r.author}${r.threadNote != null ? ` · ${r.threadNote}` : ''}${NL}${NL}${r.text}${NL}${NL}`;
    const fileOf = new Map(p.assets.map((a) => [a.att.artifact_id, a.file]));
    for (const a of r.attachments) out += attachmentLineMd(a, fileOf.get(a.artifact_id) ?? null) + NL;
    for (const name of r.missing) out += `- ⚠ 附件原件缺失：${name}${NL}`;
    out += NL;
  }
  out += `---${NL}来源说明：本导出为范围快照（消息与附件清单按导出时点固定；附件为托管副本的按 hash 拷贝，源文件后续变化不影响本文件）。${NL}`;
  return out;
}

function renderHtml(p: Prepared): string {
  const NL = String.fromCharCode(10);
  const fileOf = new Map(p.assets.map((a) => [a.att.artifact_id, a.file.replaceAll('\\', '/')]));
  let body = '';
  if (p.stats.missing > 0) body += `<p class="warn">⚠ ${p.stats.missing} 个附件原件缺失（清单如实标注）</p>${NL}`;
  for (const r of p.rows) {
    body += `<section class="msg"><div class="meta">${esc(r.at)} · ${esc(r.author)}${r.threadNote != null ? ` · ${esc(r.threadNote)}` : ''}</div><pre>${esc(r.text)}</pre>`;
    for (const a of r.attachments) {
      const file = fileOf.get(a.artifact_id);
      const isImage = a.kind === 'image_file';
      body += `<div class="att">📎 ${isImage && file != null ? `<img src="${esc(file)}" alt="${esc(a.display_name ?? a.artifact_id)}" loading="lazy">` : ''}${esc(a.display_name ?? a.artifact_id)}（${esc(a.kind)} · v${a.revision} · sha256=${esc(a.hash.slice(0, 12))}…${file != null ? ` · 随包副本 ${esc(file)}` : ''}）</div>`;
    }
    for (const name of r.missing) body += `<div class="att warn">⚠ 附件原件缺失：${esc(name)}</div>`;
    body += '</section>';
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(p.title)}</title><style>
body{font-family:system-ui,'Microsoft YaHei',sans-serif;margin:0;background:#f6f7fa;color:#20242c}
main{max-width:860px;margin:0 auto;padding:24px}
h1{font-size:20px}.sub{color:#68708a;font-size:13px}
.msg{background:#fff;border:1px solid #e3e6ee;border-radius:8px;padding:12px 16px;margin:12px 0}
.meta{color:#68708a;font-size:12px;margin-bottom:6px}
pre{white-space:pre-wrap;word-break:break-word;font-family:inherit;margin:0;font-size:14px}
.att{font-size:12px;color:#47506a;margin-top:6px}.att img{max-width:100%;max-height:260px;display:block;margin-top:6px;border:1px solid #e3e6ee}
.warn{color:#a05a00}
</style></head><body><main><h1>${esc(p.title)}</h1><div class="sub">${esc(p.subtitle)}</div>${body}
<p class="sub">来源说明：范围快照——附件为托管副本按 hash 拷贝（离线可读）；本页静态无脚本。</p></main></body></html>${NL}`;
}

/** 手写最小合法 DOCX（段落/表格/来源说明——中文与表格由 mammoth 回读验证）。 */
function renderDocx(p: Prepared): Buffer {
  const NL = String.fromCharCode(10);
  let body = `<w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escXml(p.title)}</w:t></w:r></w:p>`;
  body += `<w:p><w:r><w:rPr><w color="68708A"/></w:rPr><w:t xml:space="preserve">${escXml(p.subtitle)}</w:t></w:r></w:p>`;
  if (p.stats.missing > 0) body += `<w:p><w:r><w:rPr><w color="A05A00"/></w:rPr><w:t xml:space="preserve">⚠ ${p.stats.missing} 个附件原件缺失（清单如实标注）</w:t></w:r></w:p>`;
  const fileOf = new Map(p.assets.map((a) => [a.att.artifact_id, a.file.replaceAll('\\', '/')]));
  for (const r of p.rows) {
    body += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t xml:space="preserve">${escXml(`${r.at} · ${r.author}${r.threadNote != null ? ` · ${r.threadNote}` : ''}`)}</w:t></w:r></w:p>`;
    for (const line of r.text.split(NL)) body += `<w:p><w:r><w:t xml:space="preserve">${escXml(line)}</w:t></w:r></w:p>`;
    if (r.attachments.length > 0 || r.missing.length > 0) {
      body += '<w:tbl>';
      for (const a of r.attachments) {
        body += '<w:tr>' + `<w:tc><w:p><w:r><w:t xml:space="preserve">${escXml(a.display_name ?? a.artifact_id)}</w:t></w:r></w:p></w:tc>` +
          `<w:tc><w:p><w:r><w:t xml:space="preserve">${escXml(a.kind)} v${a.revision} sha256=${escXml(a.hash.slice(0, 12))}…${fileOf.get(a.artifact_id) != null ? ` 随包副本 ${escXml(fileOf.get(a.artifact_id)!)}` : ''}</w:t></w:r></w:p></w:tc></w:tr>`;
      }
      for (const name of r.missing) {
        body += `<w:tr><w:tc><w:p><w:r><w:t xml:space="preserve">${escXml(name)}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:rPr><w color="A05A00"/></w:rPr><w:t xml:space="preserve">⚠ 原件缺失</w:t></w:r></w:p></w:tc></w:tr>`;
      }
      body += '</w:tbl>';
    }
  }
  body += `<w:p><w:r><w:rPr><w color="68708A"/></w:rPr><w:t xml:space="preserve">来源说明：范围快照——附件为托管副本按 hash 拷贝（assets/ 目录）；源文件后续变化不影响本导出。</w:t></w:r></w:p>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const files: Record<string, Buffer | string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="word/styles.xml"/></Relationships>`,
    'word/document.xml': document,
    'word/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style></w:styles>`,
  };
  const zippable: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) zippable[k] = typeof v === 'string' ? Buffer.from(v, 'utf8') : v;
  return Buffer.from(zipSync(zippable, { level: 6 }));
}
void basename;
