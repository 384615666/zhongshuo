/**
 * 文本附件共享读取/截断/完整性（第二十七轮二·四）。
 * - previewText（能力②③）与 turnInput 装配（能力④经授权交给模型）共用同一读取路径：
 *   路径限定托管存储（内容寻址 {appData}/blobstore/{hash}.txt——basename 必须 == `{hash}.txt`
 *   且父目录名 == `blobstore`）、**读取时核对 sha256(实际字节)==artifacts.hash**——
 *   副本被改写/损坏明确拒绝，不注入新文本却标旧 hash。
 * - UTF-8 **字节**截断（保留完整字符）：中文 3 字节/字符，字符串 slice 按字符数截会远超字节
 *   预算（64KB 规则原实现即此缺陷）。截断说明分别给出原始大小/提取大小。
 */
import { openSync, readSync, closeSync, fstatSync, realpathSync } from 'node:fs';
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
  // WebP：RIFF....WEBP——VP8X（扩展头 24bit 宽高-1 @24/@27）/ VP8（有损帧：帧头后同步码
  // 0x9D012A，宽高 LE14 @26/@28）/ VP8L（无损：签名 0x2F 后 14bit 宽-1/高-1 位打包）。
  // 三种首块都取宽高（第二十九轮三：VP8/VP8L 是有效 WebP——不因缺 VP8X 误报损坏）。
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    const chunk = buf.slice(12, 16).toString('latin1');
    if (chunk === 'VP8X' && buf.length >= 30) {
      const w = 1 + ((buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)) & 0xffffff);
      const h = 1 + ((buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)) & 0xffffff);
      return { mime: 'image/webp', width: w, height: h };
    }
    if (chunk === 'VP8 ' && buf.length >= 30) {
      // VP8 未编码帧头：3 字节帧标签 + 3 字节同步码（0x9D 0x01 0x2A）+ 宽/高 LE14。
      if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null; // 同步码缺失=损坏
      const w = buf.readUInt16LE(26) & 0x3fff;
      const h = buf.readUInt16LE(28) & 0x3fff;
      if (w === 0 || h === 0) return null;
      return { mime: 'image/webp', width: w, height: h };
    }
    if (chunk === 'VP8L' && buf.length >= 21) {
      if (buf[20] !== 0x2f) return null; // 无损签名
      const bits = buf.readUInt32LE(21);
      const w = (bits & 0x3fff) + 1;
      const h = ((bits >> 14) & 0x3fff) + 1;
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

// ---------- 托管副本读取核心（第二十九轮二加固）----------
// 三层路径身份 + 受控句柄完整性读取：
// 1) 字符串层：内容寻址文件名 + 父目录 blobstore + 落在本次 appData 托管根（resolve）；
// 2) **实际文件身份层**：realpathSync 全程核对——路径任何组件是符号链接/junction（含
//    blobstore 根本身被换成指向外部的 junction）都检出（resolve 只做字符串归一化，不解析
//    链接——第二十九轮二修正）；realpath(resolved)≠resolved 或 realpath(根)≠resolve(根)
//    =链接越界拒绝；
// 3) **受控句柄层**：openSync 一次打开→fstat→从该 fd 读全部字节→hash **实际读到的字节**——
//    读取期间路径被替换不影响本句柄内容（内容不符=corrupted 拒绝，绝不返回未核对数据）。
const STORE_READ_MAX_BYTES = 64 * 1024 * 1024; // 单副本读取硬界（现有各 kind 上限远小于此）

function readStoreBytes(
  blobPath: string,
  expectedHash: string,
  storeRoot: string | undefined,
  ext: 'txt' | 'bin',
): { ok: true; raw: Buffer } | { ok: false; error: AttachmentReadError } {
  const expectedName = `${expectedHash}.${ext}`;
  let resolved = resolve(blobPath);
  const nameOk = basename(resolved) === expectedName;
  const layoutOk = nameOk && basename(dirname(resolved)) === 'blobstore';
  if (!nameOk || !layoutOk) {
    return { ok: false, error: { code: 'attachment-out-of-store', message: `附件副本路径越出托管存储（${blobPath}${storeRoot != null ? `；本次存储根=${storeRoot}` : ''}）——拒绝读取` } };
  }
  // r61 位置无关重定位：上传时内容寻址写入的是**当时数据根的绝对路径**——数据根/交付包整体
  // 搬移或复制后，记录的绝对位置不再等于当前存储根（旧实现一律 out-of-store，包挪个目录所有
  // 附件预览即失效）。重定位规则：文件名必须本就是 {hash}.{ext} 且父层为 blobstore（上面已核），
  // 记录位置不在当前根时改读**当前存储根**下的同名文件，随后走同一套 realpath 实际文件身份 +
  // 受控句柄 + 实际字节 sha256 校验——校验强度不变（绝不读越出当前根的文件），只消除对旧
  // 绝对位置的依赖。
  if (storeRoot != null && resolved !== resolve(join(storeRoot, expectedName))) {
    resolved = resolve(join(storeRoot, expectedName));
  }
  // 实际文件身份（第二十九轮二）：realpath 与字符串 resolve 必须一致——任何组件（含
  // blobstore 根自身）是 symlink/junction 即检出（外部同名目录/链接越界不靠字符串可比对）。
  if (storeRoot != null) {
    let realStore: string;
    let realBlob: string;
    try {
      realStore = realpathSync(resolve(storeRoot));
      realBlob = realpathSync(resolved);
    } catch {
      return { ok: false, error: { code: 'attachment-unreadable', message: `附件副本不可读（${blobPath}）——如实报错，不以路径冒充已读` } };
    }
    if (realStore !== resolve(storeRoot) || realBlob !== resolved) {
      return { ok: false, error: { code: 'attachment-out-of-store', message: `托管存储路径含符号链接/junction（realpath ${realBlob} ≠ ${resolved} 或存储根被链接）——按实际文件身份拒绝，不读链接目标` } };
    }
  }
  // 受控句柄读取：open→fstat→读 fd→核对实际字节（读取期间被替换=内容不符拒绝）。
  let fd: number;
  try {
    fd = openSync(resolved, 'r');
  } catch {
    return { ok: false, error: { code: 'attachment-unreadable', message: `附件副本不可读（${blobPath}）——如实报错，不以路径冒充已读` } };
  }
  try {
    const size = fstatSync(fd).size;
    if (size > STORE_READ_MAX_BYTES) {
      return { ok: false, error: { code: 'attachment-corrupted', message: `副本体积 ${size}B 超读取硬界 ${STORE_READ_MAX_BYTES}B——拒绝` } };
    }
    const raw = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, raw, read, size - read, read);
      if (n <= 0) break;
      read += n;
    }
    if (read !== size) {
      return { ok: false, error: { code: 'attachment-corrupted', message: `副本读取不完整（${read}/${size}B）——拒绝` } };
    }
    const actualHash = createHash('sha256').update(raw).digest('hex');
    if (actualHash !== expectedHash) {
      return { ok: false, error: { code: 'attachment-corrupted', message: `附件副本完整性不符（sha256 ${actualHash.slice(0, 12)}… ≠ 记录 ${expectedHash.slice(0, 12)}…）——副本可能被改写，拒绝以旧 hash 交付新内容` } };
    }
    return { ok: true, raw };
  } finally {
    try { closeSync(fd); } catch { /* 尽力关闭 */ }
  }
}

/** 二进制获准副本读取（图片/PDF 原件——内容寻址 {hash}.bin）：实根+实身份+sha256 核对；
 * 无截断（原件全量——渲染由 renderer 完成）。 */
/**
 * 受控原始字节读取（第三十一轮一：导出随包拷贝用）——与 readVerifiedBlob 同链（实根/
 * 实身份/受控句柄/实际字节 sha256），但按资源 kind 的实际存储扩展名（text_file/code_file
 * ={hash}.txt；其余={hash}.bin）读取。失败三态同 readStoreBytes。
 */
export function readVerifiedStoreRaw(blobPath: string, expectedHash: string, ext: 'txt' | 'bin', storeRoot?: string): { ok: true; raw: Buffer } | { ok: false; error: AttachmentReadError } {
  return readStoreBytes(blobPath, expectedHash, storeRoot, ext);
}

export function readVerifiedBlob(blobPath: string, expectedHash: string, storeRoot?: string): { ok: true; raw: Buffer } | { ok: false; error: AttachmentReadError } {
  const r = readStoreBytes(blobPath, expectedHash, storeRoot, 'bin');
  if (!r.ok) {
    // 图片类历史文案口径保留（消息含「图片」便于定位）。
    const message = r.error.code === 'attachment-corrupted' ? r.error.message.replace('附件副本', '图片副本') : r.error.message;
    return { ok: false, error: { ...r.error, message } };
  }
  return r;
}

/**
 * 读获准副本并核对完整性。expectedHash=artifacts.hash（上传时内容寻址写入）。
 * storeRoot（可选，第二十八轮三）：**本次 appData 的实际托管根**（{appData}/blobstore）——
 * 提供时路径必须 resolve 后落在该根内；第二十九轮二再加 realpath 实际文件身份核对
 * （symlink/junction 越界与「blobstore 根被换成外部目录的 junction」都按实际身份检出）
 * 与受控句柄读取（fd 一次打开读全部字节——读取期间被替换=内容不符拒绝）。
 * 失败三态：out-of-store（路径越界/链接越界）、unreadable（读失败）、corrupted（实际
 * 读取字节的 sha256 ≠ 记录 hash——副本被改写）。
 */
export function readVerifiedCopy(blobPath: string, expectedHash: string, storeRoot?: string): { ok: true; copy: VerifiedCopy } | { ok: false; error: AttachmentReadError } {
  const r = readStoreBytes(blobPath, expectedHash, storeRoot, 'txt');
  if (!r.ok) return r;
  // R69 P1-C：托管副本可能以**原字节**保存（BOM/UTF-16/GB18030——uploadTextRaw 起不再
  // 重编码）。读取时按同一检测链解码（与上传时确定性一致）；旧副本=纯 UTF-8 不受影响。
  const dec = decodeTextBytes(r.raw);
  if (!dec.ok) return { ok: false, error: { code: 'attachment-corrupted', message: `文本副本解码失败（${dec.error.message}）——原件字节完整（另存原文件仍逐字节一致），仅阅读/提取通道不可用` } };
  const cut = truncateUtf8Bytes(dec.text, ATT_EXCERPT_BYTES);
  return { ok: true, copy: { text: cut.text, originalBytes: r.raw.length, truncated: cut.truncated, excerptBytes: cut.excerptBytes, hash: expectedHash } };
}

/**
 * R66 P2：**完整文件读取**（屏幕阅读通道）——与 readVerifiedCopy（64KB 提取窗=模型注入
 * 同源）分列：本函数返回托管副本的**全文**（无截断），供预览排版阅读/HTML 页面渲染/源码
 * 浏览。同一完整性链（实根/实身份/受控句柄/实际字节 sha256）。文本附件上传上限
 * ATT_MAX_BYTES=256KB，全量读取天然有界；模型注入仍走提取窗（预算合同不变——不把
 * 整份文件无界发给模型）。
 */
export function readVerifiedFullText(
  blobPath: string,
  expectedHash: string,
  storeRoot?: string,
): { ok: true; text: string; originalBytes: number; encoding?: string } | { ok: false; error: AttachmentReadError } {
  const r = readStoreBytes(blobPath, expectedHash, storeRoot, 'txt');
  if (!r.ok) return r;
  // R69 P1-C：同 readVerifiedCopy——原字节副本按检测链解码（BOM/UTF-16/GB18030）。
  const dec = decodeTextBytes(r.raw);
  if (!dec.ok) return { ok: false, error: { code: 'attachment-corrupted', message: `文本副本解码失败（${dec.error.message}）——原件字节完整（另存原文件仍逐字节一致），仅阅读通道不可用` } };
  return { ok: true, text: dec.text, originalBytes: r.raw.length, encoding: dec.encoding };
}

/* ============================================================
   R69 P1-C：文本字节解码（上传/读取同一检测链——确定性一致）
   ============================================================ */

export interface TextDecodeOk { ok: true; text: string; encoding: string }
export interface TextDecodeFail { ok: false; error: { code: 'text-undecodable'; message: string } }

/**
 * 解码文本副本字节：BOM 优先（UTF-8/UTF-16LE/BE——TextDecoder 默认剥 BOM），其后
 * fatal UTF-8 → 无 BOM UTF-16 启发（偶长度+单侧零字节占比）→ GB18030（Node full-ICU；
 * Windows 常见中文编码）。**解码成功但含二进制控制字节（00-08/0E-1F）视为该编码失败**
 * （GB18030 可解码几乎任意字节序列——控制字节才是二进制判据），全部失败=二进制/未知编码
 * （明确拒绝，不静默替换 U+FFFD——原件字节仍完整保存，另存原文件逐字节一致）。
 */
export function decodeTextBytes(raw: Buffer): TextDecodeOk | TextDecodeFail {
  if (raw.length === 0) return { ok: true, text: '', encoding: 'empty' };
  const CONTROL_RE = /[\u0000-\u0008\u000E-\u001F]/;
  let decodedWithControls = false;
  const tryDecode = (label: string): TextDecodeOk | null => {
    try {
      // ignoreBOM 默认 false=剥 BOM（UTF-8 BOM 不进正文、不再重编码损失）。
      const text = new TextDecoder(label, { fatal: true }).decode(raw);
      if (CONTROL_RE.test(text)) {
        decodedWithControls = true;
        return null;
      }
      return { ok: true, text, encoding: label.replace(/-/g, '').toLowerCase() };
    } catch {
      return null;
    }
  };
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    const r = tryDecode('utf-8');
    if (r != null) return { ...r, encoding: 'utf-8-bom' };
  }
  if (raw[0] === 0xff && raw[1] === 0xfe) {
    const r = tryDecode('utf-16le');
    if (r != null) return { ...r, encoding: 'utf-16le-bom' };
  }
  if (raw[0] === 0xfe && raw[1] === 0xff) {
    const r = tryDecode('utf-16be');
    if (r != null) return { ...r, encoding: 'utf-16be-bom' };
  }
  const utf8 = tryDecode('utf-8');
  if (utf8 != null) return utf8;
  // 无 BOM 的 UTF-16 启发：偶长度且某一侧字节近半为 0（ASCII/中文 UTF-16 特征）。
  if (raw.length % 2 === 0 && raw.length >= 8) {
    let zeroOdd = 0;
    let zeroEven = 0;
    const half = raw.length / 2;
    for (let i = 0; i < raw.length; i += 2) {
      if (raw[i] === 0) zeroEven += 1;
      if (raw[i + 1] === 0) zeroOdd += 1;
    }
    if (zeroEven / half > 0.3) {
      const r = tryDecode('utf-16be');
      if (r != null) return r;
    }
    if (zeroOdd / half > 0.3) {
      const r = tryDecode('utf-16le');
      if (r != null) return r;
    }
  }
  const gb = tryDecode('gb18030');
  if (gb != null) return gb;
  return {
    ok: false,
    error: decodedWithControls
      ? { code: 'text-undecodable', message: '内容含二进制控制字节——不是文本附件（图片/PDF/Office 请用对应类型上传）' }
      : { code: 'text-undecodable', message: '不是支持的文本编码（UTF-8/UTF-8 BOM/UTF-16LE/BE/GB18030）——可能是二进制文件或未识别编码' },
  };
}
