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
import { basename, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const ATT_MAX_BYTES = 256 * 1024; // 上传上限（明确规则：超限拒绝不静默截断）
export const ATT_EXCERPT_BYTES = 64 * 1024; // 预览/注入截断预算（字节）

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

/**
 * 读获准副本并核对完整性。expectedHash=artifacts.hash（上传时内容寻址写入）。
 * 失败三态：out-of-store（路径越界——basename/父目录与内容寻址布局不符）、
 * unreadable（读失败）、corrupted（字节的 sha256 ≠ 记录 hash——副本被改写）。
 */
export function readVerifiedCopy(blobPath: string, expectedHash: string): { ok: true; copy: VerifiedCopy } | { ok: false; error: AttachmentReadError } {
  const resolved = resolve(blobPath);
  if (basename(resolved) !== `${expectedHash}.txt` || basename(dirname(resolved)) !== 'blobstore') {
    return { ok: false, error: { code: 'attachment-out-of-store', message: `附件副本路径越出托管存储（${blobPath}）——拒绝读取` } };
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
