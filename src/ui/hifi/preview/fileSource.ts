/**
 * 统一文件字节/文本适配器（R69 §A）：所有入口（会话附件/项目工作区/AI 交付）打开同一文件
 * 走同一读取链，按 FormatKind 分发渲染。字节读取走**已存在的正式命令**（audience/版本/hash
 * 完整性合同不变）：附件=attachment.originalFile（全类原件字节）/readFull（文本解码全文）；
 * 工作区=project.file.readFull（includeBytes 原字节快照）；交付=delivery.document（文本）。
 */
import { command } from '../bridge';
import type { PreviewResource } from '../data/types';

export type FormatKind = 'image' | 'pdf' | 'pptx' | 'docx' | 'xlsx' | 'markdown' | 'html' | 'csv' | 'code' | 'text' | 'binary';

const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const CODE_EXTS = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|c|h|cpp|hpp|cs|rb|php|swift|kt|sh|bash|zsh|ps1|bat|cmd|sql|css|scss|vue|svelte|yaml|yml|toml|ini|cfg|lua|r|pl|json)$/i;

/** 按文件名/附件 kind 推导阅读格式（与上传分类、文件树支持面同口径）。 */
export function formatKindOf(filename: string, attachmentKind?: string): FormatKind {
  const lower = filename.toLowerCase();
  if (IMAGE_EXTS.test(lower)) return 'image';
  if (/\.pdf$/.test(lower) || attachmentKind === 'pdf_file') return 'pdf';
  if (/\.pptx?$/.test(lower) || attachmentKind === 'slides_file') return 'pptx';
  if (/\.docx$/.test(lower) || attachmentKind === 'docx_file') return 'docx';
  if (/\.(xlsx|xlsm)$/.test(lower) || attachmentKind === 'sheet_file') {
    // CSV 走表格提取链（sheet_file 但 sourceFormat=csv）——由调用方按 sheets[0] 判别；这里
    // 按扩展名优先：.csv/.tsv=text 网格风味。
    return 'xlsx';
  }
  if (/\.(csv|tsv)$/.test(lower)) return 'csv';
  if (/\.md$/.test(lower) || /\.markdown$/.test(lower)) return 'markdown';
  if (/\.html?$/.test(lower)) return 'html';
  if (CODE_EXTS.test(lower) || attachmentKind === 'code_file') return 'code';
  if (attachmentKind === 'text_file' || attachmentKind == null || attachmentKind === '') {
    return /\.(txt|log)$/i.test(lower) ? 'text' : 'text';
  }
  return 'binary';
}

export interface LoadedFile {
  kind: FormatKind;
  /** 原件字节（二进制格式渲染用——image 例外：dataUrl 直出）。 */
  bytes: Uint8Array | null;
  /** 解码文本（文本/MD/HTML/CSV/交付——readFull/delivery.document 同源）。 */
  text: string | null;
  /** 编码元信息（utf-8/utf-8-bom/utf-16le-bom/gb18030/empty…）。 */
  encoding?: string;
  originalBytes: number;
  hash: string;
  revision: number;
  filename: string;
  /** Office 提取分列状态（P1-D：失败=本地渲染可继续、注入 fail-closed）。 */
  extraction?: 'ok' | 'failed';
  extractionError?: string;
  /** Office 提取数据（信息面板/Excel 回退网格用）。 */
  office?: {
    sheets?: Array<{ name: string; rowCount: number; colCount: number; cells: string[][]; rowTruncated?: boolean; colTruncated?: boolean; merges?: unknown[]; formulaMissing?: boolean }>;
    slides?: Array<{ slide: number; text: string; notes: string; truncated?: boolean }>;
    totalSlides?: number;
    html?: string;
    paragraphCount?: number;
    parser?: string;
  };
  /** 交付文档事实（R70 F8：hashMatch/bytes 来自 delivery.document 回执——不得丢弃或用
   *  字符串长度冒充 UTF-8 字节数）。 */
  delivery?: { hashMatch: boolean | null; bytes: number };
  /** 工作区读取快照元数据（mtimeMs——脏检测/保存快照对账用）。 */
  mtimeMs?: number;
  /** 图片直通（previewImage dataUrl+尺寸）。 */
  image?: { dataUrl: string; mime: string; width: number; height: number; bytes: number };
}

type OfficePreviewData = {
  filename: string | null; kind: string; revision: number; hash: string; parser?: string;
  extraction?: string; sheets?: LoadedFile['office'] extends { sheets?: infer S } | undefined ? S : never;
  slides?: Array<{ slide: number; text: string; notes: string; truncated?: boolean }>;
  totalSlides?: number; html?: string; paragraphCount?: number;
  visualBytesAvailable?: boolean; visualBytesReason?: string | null; bytesBase64?: string;
};

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
  return u8;
}

/**
 * 装载一个资源的当前版本（按来源分链——身份/权限合同在各命令内）。
 * 二进制格式（pdf/pptx/docx/xlsx）优先一次 previewOffice/originalFile 取全量字节；
 * 文本类走 readFull（解码+encoding）；图片走 previewImage（dataUrl）。
 */
export async function loadFileForResource(resource: PreviewResource, revision: number): Promise<LoadedFile> {
  const title = resource.relativePath ?? resource.title;
  const kind = formatKindOf(title, resource.formalAttachment?.kind);
  if (resource.formalWorktree != null) {
    const wt = resource.formalWorktree;
    const r = await command<{ content: string | null; bytesBase64?: string; sha256: string; bytes: number; encoding?: string; binaryKind?: string; mtimeMs?: number }>('project.file.readFull', { projectId: wt.projectId, path: wt.path, includeBytes: true });
    // 工作区图片：由原字节构造 dataUrl（尺寸交给 <img> naturalWidth——本地解码）。
    let image: LoadedFile['image'] | undefined;
    if (kind === 'image' && r.bytesBase64 != null) {
      const lower = title.toLowerCase();
      const ext = lower.slice(lower.lastIndexOf('.'));
      const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : ext === '.bmp' ? 'image/bmp' : ext === '.svg' ? 'image/svg+xml' : 'application/octet-stream';
      image = { dataUrl: `data:${mime};base64,${r.bytesBase64}`, mime, width: 0, height: 0, bytes: r.bytes };
    }
    return {
      kind,
      bytes: r.bytesBase64 != null ? base64ToBytes(r.bytesBase64) : null,
      text: r.content ?? null,
      encoding: r.encoding,
      originalBytes: r.bytes,
      hash: r.sha256,
      revision,
      filename: title,
      mtimeMs: r.mtimeMs,
      ...(image != null ? { image } : {}),
    };
  }
  if (resource.formalDelivery != null) {
    const d = await command<{ text: string | null; bytes: number; hashMatch: boolean | null; note?: string }>('delivery.document', { deliveryId: resource.formalDelivery.deliveryId });
    return {
      kind: d.text != null && /^\s*\{/.test(d.text) ? 'markdown' : kind === 'binary' ? 'markdown' : kind,
      bytes: null,
      text: d.text,
      originalBytes: d.bytes,
      hash: resource.formalDelivery.manifestHash,
      revision,
      filename: title,
      delivery: { hashMatch: d.hashMatch, bytes: d.bytes },
    };
  }
  const fa = resource.formalAttachment;
  const attachmentId = fa?.attachmentId ?? resource.id;
  const conversationId = fa?.conversationId ?? '';
  if (kind === 'image') {
    const r = await command<{ filename: string | null; mime: string; width: number; height: number; bytes: number; hash: string; revision: number; dataUrl: string }>('attachment.previewImage', { attachmentId });
    return { kind, bytes: null, text: null, originalBytes: r.bytes, hash: r.hash, revision: r.revision, filename: r.filename ?? title, image: { dataUrl: r.dataUrl, mime: r.mime, width: r.width, height: r.height, bytes: r.bytes } };
  }
  if (kind === 'text' || kind === 'code' || kind === 'markdown' || kind === 'html' || kind === 'csv') {
    const r = await command<{ text: string; originalBytes: number; hash: string; revision: number; encoding?: string }>('attachment.readFull', { attachmentId, conversationId });
    return { kind, bytes: null, text: r.text, encoding: r.encoding, originalBytes: r.originalBytes, hash: r.hash, revision: r.revision, filename: title };
  }
  // pdf：previewPdf 一次取字节+文本层页码（服务端页数事实）。
  if (kind === 'pdf') {
    const r = await command<{ totalPages: number; hash: string; revision: number | string; bytesBase64?: string; parser?: string }>('attachment.previewPdf', { attachmentId, page: 1, includeBytes: true });
    return {
      kind, bytes: r.bytesBase64 != null ? base64ToBytes(r.bytesBase64) : null, text: null,
      originalBytes: r.bytesBase64 != null ? base64ToBytes(r.bytesBase64).length : 0,
      hash: r.hash, revision: typeof r.revision === 'number' ? r.revision : revision, filename: title,
      office: { parser: r.parser },
    };
  }
  // office（docx/xlsx/pptx）：previewOffice includeBytes 一次取提取+字节（P1-D 分列态含字节）。
  const r = await command<OfficePreviewData>('attachment.previewOffice', { attachmentId, includeBytes: true });
  return {
    kind,
    bytes: r.bytesBase64 != null ? base64ToBytes(r.bytesBase64) : null,
    text: null,
    originalBytes: r.bytesBase64 != null ? base64ToBytes(r.bytesBase64).length : 0,
    hash: r.hash,
    revision: typeof r.revision === 'number' ? r.revision : revision,
    filename: r.filename ?? title,
    extraction: r.extraction === 'failed' ? 'failed' : 'ok',
    extractionError: r.extraction === 'failed' ? `${r.parser ?? '提取不可用'}` : undefined,
    office: {
      sheets: r.sheets, slides: r.slides, totalSlides: r.totalSlides,
      html: r.html, paragraphCount: r.paragraphCount, parser: r.parser,
    },
  };
}
