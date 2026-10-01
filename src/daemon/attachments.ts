/**
 * 文本附件共享读取/截断/完整性（第二十七轮二·四）。
 * - previewText（能力②③）与 turnInput 装配（能力④经授权交给模型）共用同一读取路径：
 *   路径限定托管存储（内容寻址 {appData}/blobstore/{hash}.txt——basename 必须 == `{hash}.txt`
 *   且父目录名 == `blobstore`）、**读取时核对 sha256(实际字节)==artifacts.hash**——
 *   副本被改写/损坏明确拒绝，不注入新文本却标旧 hash。
 * - UTF-8 **字节**截断（保留完整字符）：中文 3 字节/字符，字符串 slice 按字符数截会远超字节
 *   预算（64KB 规则原实现即此缺陷）。截断说明分别给出原始大小/提取大小。
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const ATT_MAX_BYTES = 256 * 1024; // 上传上限（明确规则：超限拒绝不静默截断）
export const ATT_EXCERPT_BYTES = 64 * 1024; // 预览/注入截断预算（字节）

/** 文本类附件的两种 kind（第二十七轮六：代码附件=文本链路的第二类）：text_file=文本/
 * Markdown；code_file=源代码（按扩展名推导——同一读取/截断/完整性/注入链路，仅类别
 * 与提示语义不同）。其余五类（图片/PDF/Office）仍随后续批次，不以本清单冒充支持。 */
export const ATT_TEXT_KINDS = ['text_file', 'code_file'] as const;
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.rs', '.rb', '.php', '.swift', '.kt', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.sql', '.html', '.htm', '.css', '.scss', '.vue', '.svelte', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.lua', '.r', '.m', '.pl']);
export function kindForFilename(filename: string): 'text_file' | 'code_file' {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  return CODE_EXTENSIONS.has(ext) ? 'code_file' : 'text_file';
}

export type AttachmentReadError =
  | { code: 'attachment-out-of-store'; message: string }
  | { code: 'attachment-unreadable'; message: string }
  | { code: 'attachment-corrupted'; message: string };

export interface VerifiedCopy {
  /** 副本全文（截断前）。 */
  text: string;
  originalBytes: number;
  truncated: boolean;
  /** 截断后实际提取的字节数（未截断时 == originalBytes）。 */
  excerptBytes: number;
  hash: string;
}

/** UTF-8 字节截断（保留完整字符）：落在多字节序列中间时回退到序列起点。 */
export function truncateUtf8Bytes(text: string, maxBytes: number): { text: string; truncated: boolean; excerptBytes: number } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false, excerptBytes: buf.length };
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1; // 尾部续字节=不完整序列起点
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true, excerptBytes: end };
}

// ---------- 图片附件首包（第二十八轮四）----------
// 服务端零像素解码依赖：内容类型按 **magic bytes**（不只扩展名）；尺寸/完整性按格式头
// 解析（PNG IHDR/JPEG SOF/GIF 头/WebP VP8X）——超尺寸/截断/头部损坏明确拒绝；像素级
// 解码与缩略图在 renderer <img>（浏览器沙箱）；OCR=未实现（明确不可用）；模型图片输入=
// 未认证（注入链路只注入文本——runtime 图片输入能力认证属后续批次，不发文件路径冒充已读）。
export const ATT_IMAGE_MAX_BYTES = 8 * 1024 * 1024; // 原件上限
export const ATT_IMAGE_MAX_DIM = 12_000; // 单边上限
export const ATT_IMAGE_MAX_PIXELS = 40_000_000; // 面积上限

export interface ImageMeta { mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; width: number; height: number }

/** magic bytes 内容类型+尺寸解析（头部级）：null=不识别/损坏/截断。 */
export function parseImageMeta(buf: Buffer): ImageMeta | null {
  if (buf.length < 16) return null;
  // PNG：签名 + IHDR（宽高 BE @16/@20）
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49_48_44_52) return null; // 首 chunk 非 IHDR=损坏
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG：SOI + 扫 SOFn（C0-CF 除 C4/C8/CC）取高宽
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < Math.min(buf.length, 256 * 1024)) {
      if (buf[off] !== 0xff) { off += 1; continue; }
      const marker = buf[off + 1]!;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue; }
      const len = buf.readUInt16BE(off + 2);
      if ((marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)) {
        return { mime: 'image/jpeg', height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      if (len < 2) return null;
      off += 2 + len;
    }
    return null; // 未找到 SOF=损坏/非常规
  }
  // GIF：头 + 屏幕描述（宽高 LE @6/@8）
  if (buf.slice(0, 4).toString('latin1') === 'GIF8' && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) {
    return { mime: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // WebP：RIFF....WEBP；VP8X（24bit 宽高-1 @24/@27）或 VP8/VP8L 简化取 VP8X，缺 VP8X=损坏（动画/基础帧至少有其一——首包按 VP8X 严格，简单帧回落 null）
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    if (buf.slice(12, 16).toString('latin1') === 'VP8X' && buf.length >= 30) {
      const w = 1 + ((buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)) & 0xffffff);
      const h = 1 + ((buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)) & 0xffffff);
      return { mime: 'image/webp', width: w, height: h };
    }
    return null;
  }
  return null;
}

/** 图片元数据校验：不识别/损坏/超限明确错误码（上传与预览共用）。 */
export function validateImageBuffer(buf: Buffer): { ok: true; meta: ImageMeta } | { ok: false; message: string } {
  const meta = parseImageMeta(buf);
  if (meta == null) return { ok: false, message: '内容不是可识别的图片（PNG/JPEG/GIF/WebP magic 与格式头校验失败——不以扩展名冒充；损坏/截断同样拒绝）' };
  if (meta.width <= 0 || meta.height <= 0) return { ok: false, message: `图片尺寸无效（${meta.width}×${meta.height}）——损坏或声明异常` };
  if (meta.width > ATT_IMAGE_MAX_DIM || meta.height > ATT_IMAGE_MAX_DIM) return { ok: false, message: `图片单边超限（${meta.width}×${meta.height} > ${ATT_IMAGE_MAX_DIM}px）——明确规则拒绝，不静默缩放` };
  if (meta.width * meta.height > ATT_IMAGE_MAX_PIXELS) return { ok: false, message: `图片面积超限（${meta.width}×${meta.height} > ${ATT_IMAGE_MAX_PIXELS}px²）` };
  return { ok: true, meta };
}

/** 二进制获准副本读取（图片原件——内容寻址 {hash}.bin）：实根+sha256 核对同文本路径；
 * 无截断（原件全量——渲染由 <img> 完成）。 */
export function readVerifiedBlob(blobPath: string, expectedHash: string, storeRoot?: string): { ok: true; raw: Buffer } | { ok: false; error: AttachmentReadError } {
  const resolved = resolve(blobPath);
  const nameOk = basename(resolved) === `${expectedHash}.bin`;
  const layoutOk = nameOk && basename(dirname(resolved)) === 'blobstore';
  const rootOk = storeRoot == null ? true : resolved === resolve(join(storeRoot, `${expectedHash}.bin`));
  if (!nameOk || !layoutOk || !rootOk) {
    return { ok: false, error: { code: 'attachment-out-of-store', message: `图片副本路径越出托管存储（${blobPath}${storeRoot != null ? `；本次存储根=${storeRoot}` : ''}）——拒绝读取` } };
  }
  let raw: Buffer;
  try {
    raw = readFileSync(resolved);
  } catch {
    return { ok: false, error: { code: 'attachment-unreadable', message: `图片副本不可读（${blobPath}）——如实报错，不以路径冒充已读` } };
  }
  const actualHash = createHash('sha256').update(raw).digest('hex');
  if (actualHash !== expectedHash) {
    return { ok: false, error: { code: 'attachment-corrupted', message: `图片副本完整性不符（sha256 ${actualHash.slice(0, 12)}… ≠ 记录 ${expectedHash.slice(0, 12)}…）——副本可能被改写` } };
  }
  return { ok: true, raw };
}

/**
 * 读获准副本并核对完整性。expectedHash=artifacts.hash（上传时内容寻址写入）。
 * storeRoot（可选，第二十八轮三）：**本次 appData 的实际托管根**（{appData}/blobstore）——
 * 提供时路径必须 resolve 后落在该根内（外部同名 blobstore 目录与符号链接越界都检出——
 * resolve 解析链接目标）；缺省降级为布局校验（父目录名 blobstore+内容寻址文件名）。
 * 失败三态：out-of-store（路径越界）、unreadable（读失败）、corrupted（字节的 sha256 ≠
 * 记录 hash——副本被改写）。
 */
export function readVerifiedCopy(blobPath: string, expectedHash: string, storeRoot?: string): { ok: true; copy: VerifiedCopy } | { ok: false; error: AttachmentReadError } {
  const resolved = resolve(blobPath);
  const nameOk = basename(resolved) === `${expectedHash}.txt`;
  const layoutOk = nameOk && basename(dirname(resolved)) === 'blobstore';
  const rootOk = storeRoot == null ? true : resolved === resolve(join(storeRoot, `${expectedHash}.txt`));
  if (!nameOk || !layoutOk || !rootOk) {
    return { ok: false, error: { code: 'attachment-out-of-store', message: `附件副本路径越出托管存储（${blobPath}${storeRoot != null ? `；本次存储根=${storeRoot}` : ''}）——拒绝读取` } };
  }
  let raw: Buffer;
  try {
    raw = readFileSync(resolved);
  } catch {
    return { ok: false, error: { code: 'attachment-unreadable', message: `附件副本不可读（${blobPath}）——如实报错，不以路径冒充已读` } };
  }
  const actualHash = createHash('sha256').update(raw).digest('hex');
  if (actualHash !== expectedHash) {
    return { ok: false, error: { code: 'attachment-corrupted', message: `附件副本完整性不符（sha256 ${actualHash.slice(0, 12)}… ≠ 记录 ${expectedHash.slice(0, 12)}…）——副本可能被改写，拒绝以旧 hash 注入新文本` } };
  }
  const text = raw.toString('utf8');
  const cut = truncateUtf8Bytes(text, ATT_EXCERPT_BYTES);
  return { ok: true, copy: { text: cut.text, originalBytes: raw.length, truncated: cut.truncated, excerptBytes: cut.excerptBytes, hash: expectedHash } };
}
