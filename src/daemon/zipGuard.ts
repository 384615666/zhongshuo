/** ZIP 共享解包：保留路径、重复条目、解压错误与声明/实际尺寸一致性校验。
 * 不以条目数或解压字节数拒绝文档；解析 worker 的内存与截止边界仍由父进程强制。
 */
import { Unzip, UnzipInflate } from 'fflate';

export class ZipGuardError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function safeUnzipWith(raw: Buffer): Record<string, Buffer> {
  const out: Record<string, Buffer> = Object.create(null) as Record<string, Buffer>;
  const pending = new Set<string>();
  let failure: { code: string; message: string } | null = null;
  const fail = (code: string, message: string): void => { if (failure == null) failure = { code, message }; };
  const uz = new Unzip();
  uz.register(UnzipInflate);
  uz.onfile = (f) => {
    if (f.name.includes('..') || f.name.startsWith('/') || f.name.includes('\\') || /^[A-Za-z]:/.test(f.name) || f.name.includes('\0')) {
      fail('zip-corrupt', `压缩包含路径穿越条目：${f.name}`);
    }
    if (pending.has(f.name) || Object.hasOwn(out, f.name)) fail('zip-corrupt', `压缩包含重复条目：${f.name}`);
    pending.add(f.name);
    const declared = f.originalSize;
    const chunks: Buffer[] = [];
    let actual = 0;
    f.ondata = (e: Error | null, chunk: Uint8Array | null, final: boolean) => {
      if (e != null) { fail('zip-corrupt', `条目 ${f.name} 解压失败（${e.message}）`); return; }
      if (chunk != null) {
        actual += chunk.length;
        if (failure == null) chunks.push(Buffer.from(chunk));
      }
      if (final) {
        pending.delete(f.name);
        if (declared != null && actual !== declared) fail('zip-corrupt', `条目 ${f.name} 解压尺寸与声明不符`);
        if (failure == null) out[f.name] = Buffer.concat(chunks);
      }
    };
    f.start();
  };
  try {
    uz.push(new Uint8Array(raw), true);
  } catch (error) {
    const f1 = failure as { code: string; message: string } | null;
    if (f1 != null) throw new ZipGuardError(f1.code, f1.message);
    throw new ZipGuardError('zip-corrupt', `不是可解析的 zip/Office 文档（${String((error as Error).message).slice(0, 100)}）`);
  }
  if (pending.size > 0) fail('zip-corrupt', '压缩包条目数据不完整');
  const finalFailure = failure as { code: string; message: string } | null; // 闭包写入——显式放宽收窄
  if (finalFailure != null) throw new ZipGuardError(finalFailure.code, finalFailure.message);
  return out;
}
