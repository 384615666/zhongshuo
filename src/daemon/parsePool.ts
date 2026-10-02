/**
 * 文档解析子进程池（第二十九轮一→第三十轮一重写）——解析执行边界：
 * - **完整 job 队列**：每个排队项自带 kind/blobPath/hash/options/入队时刻/截止与结算
 *   （第三十轮一修复：此前 waiters 只存 resolve、finally 以当前任务参数出队——B 会被当
 *   A 解析；且 finally 内 await 拖延原任务返回）。调度泵串行取件，A 的完成/失败/超时结算
 *   后立即取 B（B 用自己的文件/格式/hash/故障配置）。
 * - **响应与退出分别登记**：收到合法响应不立即结算——并发槽在子进程 **exit 确认收拢后**
 *   才释放；非法 jobId/超预算响应触发 kill ladder 收拢后按错误结算；成功后子进程不退
 *   （2s 宽限后 kill 收拢）；强杀后仍未确认退出=parse-kill-unconfirmed（如实，不宣称杀净）。
 * - **排队等待纳入端到端截止**：总截止自入队起算；泵取件时剩余 ≤0 直接按超时结算（不启动）。
 * - dispose（daemon.stop 同链）：排队即取消、在途 kill 收拢；启动准备期间 dispose 也取消。
 * - dev/测试形态的 parse-worker 按源码指纹重建（parseWorker.ts+parseContracts.ts+parseJobObject.ts
 *   内容哈希——旧产物不匹配即重建，防新源码测试继续跑旧 worker）；打包形态恒用同目录产物。
 */
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  PARSE_CONCURRENCY, PARSE_QUEUE_MAX, PARSE_DEADLINE_MS, PARSE_KILL_GRACE_MS,
  PARSE_MEMORY_LIMIT_MB, PARSE_RESPONSE_MAX_BYTES, PARSE_TOTAL_MEMORY_LIMIT_BYTES,
  type ExtractCache, type ParseJob, type ParseJobKind, type ParseResponse,
} from './parseContracts.ts';
import { attachMemoryJobObject } from './parseJobObject.ts';

export type ParseRunResult =
  | { ok: true; result: ExtractCache & { artifactKind?: string } }
  | { ok: false; error: { code: string; message: string } };

/** pptx-pages 专用结果（第三十八轮四：大载荷走 outPath 文件——IPC 只回摘要）。 */
export type ParsePagesResult =
  | { ok: true; pagesSummary: { sourceHash: string; slides: number; pxW: number; pxH: number; truncatedPages: number; outBytes: number }; outPath: string }
  | { ok: false; error: { code: string; message: string } };

type SettleResult = ParseRunResult | ParsePagesResult;

export interface ParseRunOptions {
  /** 端到端截止（含排队等待；缺省 PARSE_DEADLINE_MS）。 */
  deadlineMs?: number;
  /** pptx-pages 输出文件（调用方管理生命周期——成功响应后由调用方读取并清理）。 */
  outPath?: string;
  /** 受控故障注入（仅 ZS_TEST_PARSE_HOOKS=1 生效——生产不设即不可达）。 */
  hooks?: { busyMs?: number; exitCode?: number; allocMB?: number };
}

function scriptDir(): string {
  if (typeof __dirname === 'string') return __dirname; // CJS 打包形态
  try { return dirname(fileURLToPath(import.meta.url)); } catch { return process.cwd(); } // ESM 源码形态
}

let cachedWorkerScript: string | null = null;
/** 源码指纹（dev 产物按内容重建——源码变更后旧 dev worker 不再复用）。 */
function devSourceFingerprint(): string {
  const dir = scriptDir();
  const h = createHash('sha256');
  // pptxPages.ts 进 worker bundle（第三十八轮四）——变更必须触发重建，加入指纹。
  for (const f of ['parseWorker.ts', 'parseContracts.ts', 'parseJobObject.ts', 'pptxPages.ts', 'zipGuard.ts']) {
    try { h.update(readFileSync(join(dir, f))); h.update(f); } catch { h.update(`missing:${f}`); }
  }
  return h.digest('hex');
}
async function resolveWorkerScript(): Promise<string> {
  // 环境显式指定恒优先（隔离副本/测试切换不被缓存覆盖）。
  const envOverride = process.env.ZS_PARSE_WORKER;
  if (envOverride != null && envOverride.length > 0) return envOverride;
  // 仅打包形态缓存路径；dev 目录以 build-fingerprint.txt 存在与否判定——dev 每次核对源码指纹。
  if (cachedWorkerScript != null && existsSync(cachedWorkerScript) && !existsSync(join(dirname(cachedWorkerScript), 'build-fingerprint.txt'))) {
    return cachedWorkerScript;
  }
  const bundled = join(scriptDir(), 'parse-worker.cjs');
  if (existsSync(bundled)) { cachedWorkerScript = bundled; return bundled; }
  // 源码/测试形态：esbuild 产出——**每次调用核对源码指纹**（不匹配即重建；修复前只在
  // 无缓存时检查，源码变更后的同进程测试会继续跑旧 worker）。
  const devDir = join(process.cwd(), 'dist', 'dev-parse');
  const devOut = join(devDir, 'parse-worker.cjs');
  const fpFile = join(devDir, 'build-fingerprint.txt');
  const fp = devSourceFingerprint();
  const stale = (() => {
    try { return readFileSync(fpFile, 'utf8').trim() !== fp; } catch { return true; }
  })();
  if (!existsSync(devOut) || stale) {
    const { build } = await import('esbuild');
    mkdirSync(devDir, { recursive: true });
    await build({
      entryPoints: [join(scriptDir(), 'parseWorker.ts')],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      outfile: devOut,
      sourcemap: false,
      logLevel: 'silent',
    });
    writeFileSync(fpFile, fp, 'utf8');
    // dev 产物对齐生产布局：同目录 cmaps/（打包形态的 CMap 依赖同目录解析）。
    const cmapsSrc = join(process.cwd(), 'node_modules', 'pdfjs-dist', 'cmaps');
    if (existsSync(cmapsSrc) && !existsSync(join(devDir, 'cmaps'))) {
      cpSync(cmapsSrc, join(devDir, 'cmaps'), { recursive: true });
    }
  }
  cachedWorkerScript = devOut;
  return devOut;
}

interface QueuedJob {
  kind: ParseJobKind;
  blobPath: string;
  expectedHash: string;
  outPath?: string;
  opts: ParseRunOptions;
  enqueuedAt: number;
  totalDeadlineMs: number;
  resolve: (r: SettleResult) => void;
}

const cancelledResult = (note: string): ParseRunResult => ({ ok: false, error: { code: 'parse-cancelled', message: `解析池已关闭（daemon 停机）——${note}` } });

export class ParsePool {
  /** 调度泵互斥（单并发=至多一个在途子进程）。 */
  private pumping = false;
  private readonly queue: QueuedJob[] = [];
  private readonly live = new Set<ChildProcess>(); // 已 fork 未确认 exit（收拢登记）
  private disposed = false;
  /** 任务计数（成功+失败结算；解析不重复证明：同内容二次上传计数不增）。 */
  private completedCount = 0;

  stats(): { active: number; queued: number; liveChildren: number; completed: number } {
    return { active: this.pumping ? 1 : 0, queued: this.queue.length, liveChildren: this.live.size, completed: this.completedCount };
  }

  run(kind: ParseJobKind, blobPath: string, expectedHash: string, opts: ParseRunOptions = {}): Promise<ParseRunResult> {
    // kind='pptx-pages' 只会以 pages 变体结算（worker 分支只回 pagesSummary）——断言安全。
    return this.enqueue(kind, blobPath, expectedHash, opts) as Promise<ParseRunResult>;
  }

  /** pptx-pages 专用（第三十八轮四）：outPath 必填——完整 JSON 由 worker 写文件，IPC 只回摘要。 */
  runPages(blobPath: string, expectedHash: string, outPath: string, opts: ParseRunOptions = {}): Promise<ParsePagesResult> {
    return this.enqueue('pptx-pages', blobPath, expectedHash, { ...opts, outPath }) as Promise<ParsePagesResult>;
  }

  private enqueue(kind: ParseJobKind, blobPath: string, expectedHash: string, opts: ParseRunOptions): Promise<SettleResult> {
    if (this.disposed) {
      return Promise.resolve(cancelledResult('任务取消'));
    }
    return new Promise<SettleResult>((resolve) => {
      if (this.disposed) { resolve(cancelledResult('任务取消')); return; }
      if (this.pumping && this.queue.length >= PARSE_QUEUE_MAX) {
        resolve({ ok: false, error: { code: 'parse-busy', message: `解析队列已满（并发 ${PARSE_CONCURRENCY}+等待 ${PARSE_QUEUE_MAX}）——请稍后重试（明确拒绝，不悬挂）` } });
        return;
      }
      this.queue.push({ kind, blobPath, expectedHash, outPath: opts.outPath, opts, enqueuedAt: Date.now(), totalDeadlineMs: opts.deadlineMs ?? PARSE_DEADLINE_MS, resolve });
      void this.pump();
    });
  }

  /** 调度泵：串行取件；每件经 dispatchJob（含 exit 收拢）后才取下一件（槽在收拢后释放）。 */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.disposed && this.queue.length > 0) {
        const job = this.queue.shift()!;
        // 排队等待纳入端到端截止：入队起算剩余时间；耗尽=按超时结算（不启动子进程）。
        const remaining = job.totalDeadlineMs - (Date.now() - job.enqueuedAt);
        if (remaining <= 0) {
          this.completedCount += 1;
          job.resolve({ ok: false, error: { code: `${job.kind}-timeout`, message: `解析端到端超时（排队等待耗尽 ${job.totalDeadlineMs}ms 截止——未启动子进程，不虚假占槽）` } });
          continue;
        }
        const result = await this.dispatchJob(job, remaining);
        this.completedCount += 1;
        job.resolve(result); // A 结算立即循环取 B——不被 B 或 A 的后续等待拖延
      }
    } finally {
      this.pumping = false;
    }
  }

  private async dispatchJob(job: QueuedJob, deadlineMs: number): Promise<SettleResult> {
    let script: string;
    try {
      script = await resolveWorkerScript();
    } catch (error) {
      return { ok: false, error: { code: 'parse-worker-failed', message: `解析 worker 解析失败：${error instanceof Error ? error.message : String(error)}` } };
    }
    if (this.disposed) return cancelledResult('启动准备期间任务取消');
    const jobId = `pj_${randomUUID()}`;
    const hooks = process.env.ZS_TEST_PARSE_HOOKS === '1'
      ? {
          busyMs: Number(process.env.ZS_TEST_PARSE_BUSY_MS ?? 0) || job.opts.hooks?.busyMs,
          exitCode: job.opts.hooks?.exitCode,
          allocMB: Number(process.env.ZS_TEST_PARSE_ALLOC_MB ?? 0) || job.opts.hooks?.allocMB,
        }
      : undefined;
    const message: ParseJob & { hooks?: { busyMs?: number; exitCode?: number; allocMB?: number } } = { jobId, kind: job.kind, blobPath: job.blobPath, expectedHash: job.expectedHash, ...(job.outPath != null ? { outPath: job.outPath } : {}), ...(hooks != null ? { hooks } : {}) };
    let child: ChildProcess;
    try {
      child = fork(script, [], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: [...process.execArgv, `--max-old-space-size=${PARSE_MEMORY_LIMIT_MB}`],
      });
    } catch (error) {
      return { ok: false, error: { code: 'parse-worker-failed', message: `解析子进程启动失败：${error instanceof Error ? error.message : String(error)}` } };
    }
    this.live.add(child);
    // 进程总内存硬界（第三十轮二：--max-old-space-size 只限 V8 老生代，外部 Buffer 不受其
    // 约束——Job Object PROCESS_MEMORY 覆盖整进程提交内存）。Windows 之外无 Job Object——
    // 回退仅 V8 上限（限制缺口如实呈现，不宣称整进程硬界）。
    void attachMemoryJobObject(child, PARSE_TOTAL_MEMORY_LIMIT_BYTES).catch(() => { /* 附加失败不阻断解析；限制降级为仅 V8 上限 */ });
    let stderrTail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => { stderrTail = (stderrTail + d).slice(-500); });
    return await new Promise<SettleResult>((resolve) => {
      let settled = false;
      let exited = false;
      let timedOut = false;
      let invalidResponse: string | null = null;
      let pendingResult: SettleResult | null = null;
      let deadlineTimer: NodeJS.Timeout | null = null;
      let killTimer: NodeJS.Timeout | null = null;
      let unconfirmedTimer: NodeJS.Timeout | null = null;
      let exitGraceTimer: NodeJS.Timeout | null = null;
      const clearTimers = (): void => {
        for (const t of [deadlineTimer, killTimer, unconfirmedTimer, exitGraceTimer]) if (t != null) clearTimeout(t);
        deadlineTimer = killTimer = unconfirmedTimer = exitGraceTimer = null;
      };
      const killLadder = (): void => {
        try { child.kill(); } catch { /* 已退出 */ }
        if (killTimer == null) killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, PARSE_KILL_GRACE_MS);
      };
      const finish = (r: SettleResult): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        resolve(r);
      };
      // 端到端墙钟截止（覆盖加载/逐项提取/传输；收拢经 exit 确认后才结算）。
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        killLadder();
        // 强杀后仍未确认 exit（理论罕见：句柄悬挂等）——有界兜底，如实登记不宣称杀净。
        if (unconfirmedTimer == null) {
          unconfirmedTimer = setTimeout(() => {
            if (!exited) finish({ ok: false, error: { code: 'parse-kill-unconfirmed', message: `解析超时（${deadlineMs}ms）且子进程终止未确认（SIGTERM→SIGKILL 后 ${PARSE_KILL_GRACE_MS + 5_000}ms 无 exit）——按未收拢登记，不宣称杀净` } });
          }, PARSE_KILL_GRACE_MS + 5_000);
        }
      }, deadlineMs);
      child.once('message', (raw: unknown) => {
        // 响应登记（不立即结算——槽在 exit 收拢后释放）。
        const resp = raw as ParseResponse;
        if (resp == null || typeof resp !== 'object' || resp.jobId !== jobId) {
          invalidResponse = '响应不合法（jobId 不符）';
          killLadder(); // 非法响应必须收拢对应进程（不能 resolve 后只清截止）
          return;
        }
        if (Buffer.byteLength(JSON.stringify(resp), 'utf8') > PARSE_RESPONSE_MAX_BYTES) {
          invalidResponse = `解析响应超防御上限 ${PARSE_RESPONSE_MAX_BYTES}B`;
          killLadder();
          return;
        }
        if (resp.ok && resp.result != null) pendingResult = { ok: true, result: resp.result };
        else if (resp.ok && resp.pagesSummary != null && job.outPath != null) pendingResult = { ok: true, pagesSummary: resp.pagesSummary, outPath: job.outPath };
        else pendingResult = { ok: false, error: resp.error ?? { code: 'parse-worker-failed', message: '解析失败（无错误详情）' } };
        if (deadlineTimer != null) { clearTimeout(deadlineTimer); deadlineTimer = null; }
        // 成功路径：子进程应即退；2s 内未退（挂起）→ kill 收拢（不无限等待释放槽）。
        exitGraceTimer = setTimeout(() => { if (!exited) killLadder(); }, 2_000);
      });
      child.once('exit', (code, signal) => {
        // 退出登记+槽释放点（本回调即收拢确认）。
        exited = true;
        this.live.delete(child);
        if (settled) return;
        if (this.disposed) finish(cancelledResult('在途任务取消并确认退出'));
        else if (invalidResponse != null) finish({ ok: false, error: { code: 'parse-worker-failed', message: `解析子进程响应被拒（${invalidResponse}）——进程已收拢（code=${code ?? '?'}${signal != null ? ` signal=${signal}` : ''}）` } });
        else if (pendingResult != null) finish(pendingResult);
        else if (timedOut) finish({ ok: false, error: { code: `${message.kind}-timeout`, message: `解析超时（${deadlineMs}ms 截止，子进程已终止并确认退出 code=${code ?? '?'}${signal != null ? ` signal=${signal}` : ''}）——资源限制如实拒绝` } });
        else finish({ ok: false, error: { code: 'parse-worker-exited', message: `解析子进程未产出结果即退出（code=${code ?? '?'}${signal != null ? ` signal=${signal}` : ''}${stderrTail.length > 0 ? `；stderr 尾部：${stderrTail.slice(-160)}` : ''}）` } });
      });
      child.once('error', (error) => {
        this.live.delete(child);
        finish({ ok: false, error: { code: 'parse-worker-failed', message: `解析子进程错误：${error.message}` } });
      });
      child.send(message);
    });
  }

  /** 关停（daemon.stop）：排队即取消、在途 kill 收拢，exit 确认后返回（有界）。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const w of this.queue.splice(0)) {
      this.completedCount += 1;
      w.resolve(cancelledResult('排队任务取消'));
    }
    const children = [...this.live];
    for (const c of children) { try { c.kill(); } catch { /* 已退出 */ } }
    const allExited = Promise.all(children.map((c) => new Promise<void>((r) => c.once('exit', () => r()))));
    const grace = (ms: number): Promise<null> => new Promise((r) => { const t = setTimeout(() => r(null), ms); t.unref?.(); });
    if (await Promise.race([allExited, grace(PARSE_KILL_GRACE_MS + 1_000)]) == null) {
      for (const c of children) { try { c.kill('SIGKILL'); } catch { /* 已退出 */ } }
      await Promise.all(children.map((c) => new Promise<void>((r) => { if (c.exitCode != null || c.signalCode != null) r(); else c.once('exit', () => r()); })));
    }
  }
}

let poolSingleton: ParsePool | null = null;
export function getParsePool(): ParsePool {
  if (poolSingleton == null) poolSingleton = new ParsePool();
  return poolSingleton;
}
export async function disposeParsePool(): Promise<void> {
  cachedWorkerScript = null; // 路径缓存一并复位（测试按环境切换 worker 副本）
  if (poolSingleton == null) return;
  await poolSingleton.dispose();
  poolSingleton = null;
}
