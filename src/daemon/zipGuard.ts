/**
 * zip 护栏解包（第二十九轮四建；第三十七轮四从 parseWorker 迁出为共享模块）：
 * 条目数/声明尺寸/实际输出/总量四护栏+路径穿越拒绝——供解析 worker 与主进程（PPTX 静态页
 * 预览等）复用。迁出原因：parseWorker 末尾注册 process.on('message') IPC 入口——主进程
 * import 它会把 worker 入口带进 daemon（消息到达即 process.exit——vitest 实证 1538 个
 * unhandled「process.exit unexpectedly called」）。
 */
import { Unzip, UnzipInflate } from 'fflate';

export const ZIP_MAX_ENTRIES = 1_500;
export const ZIP_ENTRY_MAX_BYTES = 64 * 1024 * 1024;
export const ZIP_TOTAL_MAX_BYTES = 160 * 1024 * 1024;

export class ZipGuardError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ZipLimits { maxEntries?: number; entryMax?: number; totalMax?: number }
export function safeUnzipWith(raw: Buffer, limits: ZipLimits = {}): Record<string, Buffer> {
  const maxEntries = limits.maxEntries ?? ZIP_MAX_ENTRIES;
  const entryMax = limits.entryMax ?? ZIP_ENTRY_MAX_BYTES;
  const totalMax = limits.totalMax ?? ZIP_TOTAL_MAX_BYTES;
  const out: Record<string, Buffer> = {};
  let entryCount = 0;
  let totalActual = 0;
  let failure: { code: string; message: string } | null = null;
  const fail = (code: string, message: string): void => { if (failure == null) failure = { code, message }; };
  const uz = new Unzip();
  uz.register(UnzipInflate);
  uz.onfile = (f) => {
    entryCount += 1;
    if (entryCount > maxEntries) { fail('zip-entry-limit', `压缩包条目数超过上限 ${maxEntries}——资源限制明确拒绝`); }
    if (f.name.includes('..')) { fail('zip-corrupt', `压缩包含路径穿越条目：${f.name}`); }
    const declared = f.originalSize ?? f.size ?? 0;
    if (declared > entryMax) { fail('zip-size-limit', `条目 ${f.name} 声明解压 ${declared}B 超上限 ${entryMax}B`); }
    const skipCollection = failure != null;
    const chunks: Buffer[] = [];
    let actual = 0;
    f.ondata = (e: Error | null, chunk: Uint8Array | null, final: boolean) => {
      if (e != null) { fail('zip-corrupt', `条目 ${f.name} 解压失败（${e.message}）`); return; }
      if (chunk != null) {
        actual += chunk.length;
        totalActual += chunk.length;
        // 实际输出限制（声明不可信）：超限即丢弃后续块（内存不膨胀）。
        if (actual > entryMax) { fail('zip-size-limit', `条目 ${f.name} 实际解压输出超上限 ${entryMax}B（声明尺寸不可信）`); return; }
        if (totalActual > totalMax) { fail('zip-size-limit', `解压实际总量超上限 ${totalMax}B`); return; }
        if (!skipCollection) chunks.push(Buffer.from(chunk));
      }
      if (final && failure == null) out[f.name] = Buffer.concat(chunks);
    };
    f.start(); // 恒启动（不启动会内部缓冲压缩数据）；超限路径只计数不收集
  };
  try {
    uz.push(new Uint8Array(raw), true);
  } catch (error) {
    const f1 = failure as { code: string; message: string } | null;
    if (f1 != null) throw new ZipGuardError(f1.code, f1.message);
    throw new ZipGuardError('zip-corrupt', `不是可解析的 zip/Office 文档（${String((error as Error).message).slice(0, 100)}）`);
  }
  const finalFailure = failure as { code: string; message: string } | null; // 闭包写入——显式放宽收窄
  if (finalFailure != null) throw new ZipGuardError(finalFailure.code, finalFailure.message);
  return out;
}
