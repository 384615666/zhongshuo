/**
 * 导出生成器（第三十轮五建；第三十一轮一重写）。
 * 完整性链（第三十一轮一）：
 * - 附件**不再**裸 stat/copyFile——走 readVerifiedBlob（字符串层布局+realpath 实身份+
 *   受控句柄+实际字节 sha256 核对，blobRoot 参与校验），**校验后的字节**才落 assets/；
 * - 逐项核对源会话（artifacts.conversation_id 必须等于导出会话——防 message_attachments
 *   串线引用把别的会话资源带进导出包）；
 * - out-of-store/损坏（hash 不符）= 整笔明确失败（EXPORT_ATTACHMENT_INTEGRITY，清理半截
 *   产物）——不当作正常随包副本也不冒充缺失；不可读/不存在按合同列 missing；
 * - manifest.json 与最终 assets 字节一致：写后**重读文件**逐件复核 sha256+体积；
 * - system 消息保留「系统」来源（human=用户 / agent=成员 / system=系统，不统一贴成员）；
 * - 预算显式：消息数超限 EXPORT_TOO_LARGE 明确失败；文件不设件数或字节上限（提示收窄范围），
 *   不静默缩小导出范围；
 * - 重活异步分步：逐件 await 让出事件循环——复制/校验不长期堵 daemon IPC 与停止命令。
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { readVerifiedStoreRaw, ATT_TEXT_KINDS } from './attachments.ts';

export const TEXT_PREVIEW_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.rs', '.rb', '.php', '.swift', '.kt', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.sql', '.html', '.htm', '.css', '.scss', '.vue', '.svelte', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.lua', '.r', '.m', '.pl']);

export const EXPORT_MAX_MESSAGES = 2000;

export class ExportWriterError extends Error {
  code: 'EXPORT_TOO_LARGE' | 'EXPORT_ATTACHMENT_CONFLICT' | 'EXPORT_ATTACHMENT_INTEGRITY' | 'EXPORT_VERIFY_FAILED';
  constructor(code: ExportWriterError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

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
  /** 附件资源的源会话（artifacts.conversation_id——逐项核对，防串线引用）。 */
  conversation_id: string;
}

export interface ExportInput {
  conv: { id: string; kind: string; room_id: string | null; archived_at: number | null };
  target: { kind: 'conversation' | 'thread'; threadId?: string };
  messages: ExportMessage[];
  attachments: ExportAttachment[];
  format: 'md' | 'html' | 'docx';
  exportDir: string;
  /** 本次 appData 的 blobstore 实际托管根（参与路径校验——不信任裸 blob_path）。 */
  blobRoot: string;
}

const esc = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
// XML 1.0 字符数据禁大多数控制字符（\t\n\r 除外）——消息正文可能含粘贴控制符；不清洗
// 会产出非法 document.xml（Word 打开触发修复提示）。清洗=丢弃（如实保真其余字符）。
const XML_INVALID_CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
const escXml = (s: string): string => esc(s.replaceAll(XML_INVALID_CTRL, ''));

interface Prepared {
  title: string;
  subtitle: string;
  rows: Array<{ at: string; author: string; text: string; threadNote: string | null; attachments: ExportAttachment[]; missing: string[] }>;
  assets: Array<{ file: string; att: ExportAttachment }>;
  stats: { messages: number; attachments: number; missing: number };
}

/** 让出事件循环（重活分步——不长期堵 daemon 主循环/IPC/停止命令）。 */
const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

function prepare(input: ExportInput): Prepared {
  if (input.messages.length > EXPORT_MAX_MESSAGES) {
    throw new ExportWriterError('EXPORT_TOO_LARGE', `导出消息数 ${input.messages.length} 超上限 ${EXPORT_MAX_MESSAGES}——请收窄范围（按线程导出）或分批导出，不静默缩小范围`);
  }
  const byMsg = new Map<string, ExportAttachment[]>();
  for (const a of input.attachments) {
    if (a.conversation_id !== input.conv.id) {
      // 串线引用（message_attachments 指向其他会话的 artifact）= 数据完整性冲突——整笔拒绝。
      throw new ExportWriterError('EXPORT_ATTACHMENT_CONFLICT', `附件 ${a.display_name ?? a.artifact_id} 的资源记录归属会话 ${a.conversation_id} ≠ 导出会话 ${input.conv.id}——串线引用整笔拒绝`);
    }
    const list = byMsg.get(a.message_id) ?? [];
    list.push(a);
    byMsg.set(a.message_id, list);
  }
  const assets: Array<{ file: string; att: ExportAttachment }> = [];
  const seenAssetFiles = new Set<string>(); // 同内容多引用（同 hash）→ 同一随包文件只入列一次
  const rows: Prepared['rows'] = [];
  const missing: string[] = [];
  for (const m of input.messages) {
    const body = JSON.parse(m.body_json) as { text?: string };
    const atts = byMsg.get(m.id) ?? [];
    const missingHere: string[] = [];
    const kept: ExportAttachment[] = [];
    for (const a of atts) {
      // 不可读的先按 missing 走（readVerifiedBlob 三态在拷贝阶段定谳：out-of-store/corrupted
      // 到那时整笔失败；unreadable 留在 missing 清单）。
      kept.push(a);
      const file = `assets/${a.hash.slice(0, 16)}-${(a.display_name ?? a.artifact_id).replace(/[\\/:*?"<>|]/g, '_')}`;
      if (!seenAssetFiles.has(file)) {
        seenAssetFiles.add(file);
        assets.push({ file, att: a });
      }
    }
    rows.push({
      at: new Date(m.created_at).toLocaleString('sv-SE').replace('T', ' '),
      author: m.author_type === 'human' ? `用户 ${m.author_id.slice(0, 8)}…` : m.author_type === 'system' ? '系统' : `成员 ${m.author_id.slice(0, 8)}…`,
      text: body.text ?? '',
      threadNote: input.target.kind === 'conversation' && m.thread_id != null ? `线程消息（#${m.thread_message_seq ?? '?'}）` : null,
      attachments: kept,
      missing: missingHere,
    });
  }
  void missing;
  return {
    title: input.target.kind === 'thread' ? `线程导出（${input.target.threadId?.slice(0, 14)}…）` : `会话导出（${input.conv.id.slice(0, 14)}…）`,
    subtitle: `${input.conv.kind === 'dm' ? '私信会话' : '房间会话'} · ${input.messages.length} 条消息 · ${new Date().toISOString()}`,
    rows,
    assets,
    stats: { messages: input.messages.length, attachments: assets.length, missing: 0 },
  };
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  // 分块异步读+hash（大文件不一次性进内存——校验用，不复制）。
  const h = createHash('sha256');
  const fh = await fsp.open(path, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- 逐块让出
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, null);
      if (bytesRead <= 0) break;
      bytes += bytesRead;
      h.update(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
    }
    return { sha256: h.digest('hex'), bytes };
  } finally {
    await fh.close().catch(() => { /* 尽力 */ });
  }
}

/**
 * 校验并拷贝附件托管副本到导出包 assets/（内容寻址——导出即快照）。
 * 逐件：readVerifiedBlob（实根/实身份/受控句柄/实际字节 sha256）→ 写入校验字节 →
 * 记录清单项。out-of-store/corrupted → 整笔失败（调用方清理目录）；unreadable →
 * 转记 missing（从随包清单移除，消息行如实标注）。
 */
async function verifyAndCopyAssets(
  exportDir: string,
  prepared: Prepared,
  blobRoot: string,
): Promise<{ manifestFiles: Array<{ file: string; bytes: number; sha256: string; artifactId: string; kind: string; revision: number; sourceName: string | null }>; droppedUnreadable: Set<string> }> {
  const droppedUnreadable = new Set<string>();
  if (prepared.assets.length === 0) return { manifestFiles: [], droppedUnreadable };
  mkdirSync(join(exportDir, 'assets'), { recursive: true });
  const manifestFiles: Array<{ file: string; bytes: number; sha256: string; artifactId: string; kind: string; revision: number; sourceName: string | null }> = [];
  for (const { file, att } of prepared.assets) {
    // 按资源 kind 的实际存储扩展名读取（text_file/code_file={hash}.txt；其余={hash}.bin）。
    const verified = readVerifiedStoreRaw(att.blob_path, att.hash, (ATT_TEXT_KINDS as readonly string[]).includes(att.kind) ? 'txt' : 'bin', blobRoot);
    if (!verified.ok) {
      if (verified.error.code === 'attachment-unreadable') {
        droppedUnreadable.add(att.artifact_id); // 合同口径：不可读=missing（消息行如实标注）
        continue;
      }
      // out-of-store / corrupted：不当作正常随包副本——整笔明确失败。
      throw new ExportWriterError('EXPORT_ATTACHMENT_INTEGRITY', `附件 ${att.display_name ?? att.artifact_id} 托管副本校验失败（${verified.error.code}）：${verified.error.message}——整笔拒绝，不以未核对字节随包`);
    }
    writeFileSync(join(exportDir, file.replaceAll('/', String.fromCharCode(92))), verified.raw);
    // 最终字节一致性（第三十一轮一）：写后重读实际文件复核——清单必须与磁盘字节一致。
    const onDisk = await hashFile(join(exportDir, file.replaceAll('/', String.fromCharCode(92))));
    if (onDisk.bytes !== verified.raw.length || onDisk.sha256 !== att.hash) {
      throw new ExportWriterError('EXPORT_VERIFY_FAILED', `随包副本写后复核不符（${file}：磁盘 ${onDisk.bytes}B/${onDisk.sha256.slice(0, 12)}… ≠ 校验 ${verified.raw.length}B/${att.hash.slice(0, 12)}…）——整笔拒绝`);
    }
    manifestFiles.push({ file: file.replaceAll('\\', '/'), bytes: onDisk.bytes, sha256: onDisk.sha256, artifactId: att.artifact_id, kind: att.kind, revision: att.revision, sourceName: att.source_name });
    await yieldLoop();
  }
  return { manifestFiles, droppedUnreadable };
}

export interface ExportOutcome {
  files: string[];
  stats: { messages: number; attachments: number; missing: number };
  manifest: {
    generatedAt: string;
    format: 'md' | 'html' | 'docx';
    conversationId: string;
    targetKind: 'conversation' | 'thread';
    threadId: string | null;
    stats: { messages: number; attachments: number; missing: number };
    /** 主输出文件（index.md/index.html/export.docx）——字节与哈希入清单（下载端完整性对账）。 */
    primary: { file: string; bytes: number; sha256: string };
    files: Array<{ file: string; bytes: number; sha256: string; artifactId: string; kind: string; revision: number; sourceName: string | null }>;
  };
}

export async function writeExport(input: ExportInput): Promise<ExportOutcome> {
  const prepared = prepare(input);
  mkdirSync(input.exportDir, { recursive: true });
  const { manifestFiles, droppedUnreadable } = await verifyAndCopyAssets(input.exportDir, prepared, input.blobRoot);
  // unreadable → missing：消息行随包清单移除并如实标注（行级 ⚠ 原件不可读）。
  let missingTotal = 0;
  for (const r of prepared.rows) {
    const dropped = r.attachments.filter((a) => droppedUnreadable.has(a.artifact_id));
    r.missing = dropped.map((a) => a.display_name ?? a.artifact_id);
    r.attachments = r.attachments.filter((a) => !droppedUnreadable.has(a.artifact_id));
    missingTotal += dropped.length;
  }
  prepared.assets = prepared.assets.filter((a) => !droppedUnreadable.has(a.att.artifact_id));
  const stats = {
    messages: prepared.stats.messages,
    attachments: manifestFiles.length,
    missing: missingTotal,
  };
  const files: string[] = [];
  if (input.format === 'md') {
    writeFileSync(join(input.exportDir, 'index.md'), renderMarkdown(prepared, stats.missing), 'utf8');
    files.push('index.md');
  } else if (input.format === 'html') {
    writeFileSync(join(input.exportDir, 'index.html'), renderHtml(prepared, stats.missing), 'utf8');
    files.push('index.html');
  } else {
    writeFileSync(join(input.exportDir, 'export.docx'), renderDocx(prepared, stats.missing));
    files.push('export.docx');
  }
  const primaryName = input.format === 'md' ? 'index.md' : input.format === 'html' ? 'index.html' : 'export.docx';
  const primaryBytes = readFileSync(join(input.exportDir, primaryName));
  const manifest: ExportOutcome['manifest'] = {
    generatedAt: new Date().toISOString(),
    format: input.format,
    conversationId: input.conv.id,
    targetKind: input.target.kind,
    threadId: input.target.threadId ?? null,
    stats,
    primary: { file: primaryName, bytes: primaryBytes.length, sha256: createHash('sha256').update(primaryBytes).digest('hex') },
    files: manifestFiles,
  };
  writeFileSync(join(input.exportDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  files.push('manifest.json', ...manifestFiles.map((f) => f.file));
  return { files, stats, manifest };
}

function attachmentLineMd(a: ExportAttachment, file: string | null): string {
  return `- 📎 ${a.display_name ?? a.artifact_id}（${a.kind} · v${a.revision} · sha256=${a.hash.slice(0, 12)}…${file != null ? ` · [随包副本](./${file.replaceAll('\\', '/')})` : ''}）`;
}

function renderMarkdown(p: Prepared, missingTotal: number): string {
  const NL = String.fromCharCode(10);
  let out = `# ${p.title}${NL}${NL}> ${p.subtitle}${NL}${NL}`;
  if (missingTotal > 0) out += `> ⚠ ${missingTotal} 个附件副本不可读（清单如实标注）${NL}${NL}`;
  const fileOf = new Map(p.assets.map((a) => [a.att.artifact_id, a.file.replaceAll('\\', '/')]));
  for (const r of p.rows) {
    out += `## ${r.at} · ${r.author}${r.threadNote != null ? ` · ${r.threadNote}` : ''}${NL}${NL}${r.text}${NL}${NL}`;
    for (const a of r.attachments) out += attachmentLineMd(a, fileOf.get(a.artifact_id) ?? null) + NL;
    for (const name of r.missing) out += `- ⚠ 附件原件不可读（未随包）：${name}${NL}`;
    out += NL;
  }
  out += `---${NL}来源说明：本导出为范围快照（消息与附件清单按导出时点固定；附件为托管副本的按 hash 校验拷贝，源文件后续变化不影响本文件；system 消息保留系统来源）。${NL}`;
  return out;
}

function renderHtml(p: Prepared, missingTotal: number): string {
  const NL = String.fromCharCode(10);
  const fileOf = new Map(p.assets.map((a) => [a.att.artifact_id, a.file.replaceAll('\\', '/')]));
  let body = '';
  if (missingTotal > 0) body += `<p class="warn">⚠ ${missingTotal} 个附件副本不可读（清单如实标注）</p>${NL}`;
  for (const r of p.rows) {
    body += `<section class="msg"><div class="meta">${esc(r.at)} · ${esc(r.author)}${r.threadNote != null ? ` · ${esc(r.threadNote)}` : ''}</div><pre>${esc(r.text)}</pre>`;
    for (const a of r.attachments) {
      const file = fileOf.get(a.artifact_id);
      const isImage = a.kind === 'image_file';
      body += `<div class="att">📎 ${isImage && file != null ? `<img src="${esc(file)}" alt="${esc(a.display_name ?? a.artifact_id)}" loading="lazy">` : ''}${esc(a.display_name ?? a.artifact_id)}（${esc(a.kind)} · v${a.revision} · sha256=${esc(a.hash.slice(0, 12))}…${file != null ? ` · 随包副本 ${esc(file)}` : ''}）</div>`;
    }
    for (const name of r.missing) body += `<div class="att warn">⚠ 附件原件不可读（未随包）：${esc(name)}</div>`;
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
<p class="sub">来源说明：范围快照——附件为托管副本按 hash 校验拷贝（离线可读）；本页静态无脚本。</p></main></body></html>${NL}`;
}

/**
 * 手写最小合法 DOCX（第三十一轮二 OOXML 修复）：段落/表格/来源说明。
 * 规范写法修正（Word 实开无修复提示的必要项）：
 * - `<w:color w:val="RRGGBB"/>`（旧写法 `<w color=…>` 是非法元素——Word 触发修复）；
 * - 表格必须带 `<w:tblPr>`（边框可见）与 `<w:tblGrid><w:gridCol/>`（缺 tblGrid 是已知
 *   修复触发器）；
 * - styles 关系放 word/_rels/document.xml.rels（包级 .rels 只留 officeDocument——旧把
 *   styles 挂在包级 .rels 属非标准关系位置）。
 */
function renderDocx(p: Prepared, missingTotal: number): Buffer {
  const NL = String.fromCharCode(10);
  const gray = '<w:rPr><w:color w:val="68708A"/></w:rPr>';
  const warnColor = '<w:rPr><w:color w:val="A05A00"/></w:rPr>';
  let body = `<w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escXml(p.title)}</w:t></w:r></w:p>`;
  body += `<w:p><w:r>${gray}<w:t xml:space="preserve">${escXml(p.subtitle)}</w:t></w:r></w:p>`;
  if (missingTotal > 0) body += `<w:p><w:r>${warnColor}<w:t xml:space="preserve">⚠ ${missingTotal} 个附件副本不可读（清单如实标注）</w:t></w:r></w:p>`;
  const fileOf = new Map(p.assets.map((a) => [a.att.artifact_id, a.file.replaceAll('\\', '/')]));
  for (const r of p.rows) {
    body += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t xml:space="preserve">${escXml(`${r.at} · ${r.author}${r.threadNote != null ? ` · ${r.threadNote}` : ''}`)}</w:t></w:r></w:p>`;
    for (const line of r.text.split(NL)) body += `<w:p><w:r><w:t xml:space="preserve">${escXml(line)}</w:t></w:r></w:p>`;
    if (r.attachments.length > 0 || r.missing.length > 0) {
      body += '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="A6A6A6"/><w:left w:val="single" w:sz="4" w:color="A6A6A6"/><w:bottom w:val="single" w:sz="4" w:color="A6A6A6"/><w:right w:val="single" w:sz="4" w:color="A6A6A6"/><w:insideH w:val="single" w:sz="4" w:color="A6A6A6"/><w:insideV w:val="single" w:sz="4" w:color="A6A6A6"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="4400"/><w:gridCol w:w="4400"/></w:tblGrid>';
      for (const a of r.attachments) {
        body += '<w:tr>' + `<w:tc><w:tcPr><w:tcW w:w="4400" w:type="dxa"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">${escXml(a.display_name ?? a.artifact_id)}</w:t></w:r></w:p></w:tc>` +
          `<w:tc><w:tcPr><w:tcW w:w="4400" w:type="dxa"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">${escXml(a.kind)} v${a.revision} sha256=${escXml(a.hash.slice(0, 12))}…${fileOf.get(a.artifact_id) != null ? ` 随包副本 ${escXml(fileOf.get(a.artifact_id)!)}` : ''}</w:t></w:r></w:p></w:tc></w:tr>`;
      }
      for (const name of r.missing) {
        body += `<w:tr><w:tc><w:tcPr><w:tcW w:w="4400" w:type="dxa"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">${escXml(name)}</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="4400" w:type="dxa"/></w:tcPr><w:p><w:r>${warnColor}<w:t xml:space="preserve">⚠ 原件不可读（未随包）</w:t></w:r></w:p></w:tc></w:tr>`;
      }
      body += '</w:tbl>';
    }
  }
  body += `<w:p><w:r>${gray}<w:t xml:space="preserve">来源说明：范围快照——附件为托管副本按 hash 校验拷贝（assets/ 目录，清单见 manifest.json）；源文件后续变化不影响本导出。</w:t></w:r></w:p>`;
  body += '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>';
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const files: Record<string, Buffer | string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'word/document.xml': document,
    'word/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style></w:styles>`,
  };
  const zippable: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) zippable[k] = typeof v === 'string' ? Buffer.from(v, 'utf8') : v;
  return Buffer.from(zipSync(zippable, { level: 6 }));
}
