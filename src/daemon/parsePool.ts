/**
 * 文档解析子进程池（第二十九轮一）——解析执行边界：
 * - 每任务 fork 独立子进程（parseWorker.ts / 打包 parse-worker.mjs）——pdfjs/mammoth/
 *   xlsx 同步 CPU 阻塞被进程边界隔离，daemon 主线程的普通 IPC、停止与其他任务不受影响；
 * - 墙钟截止覆盖加载、逐页/逐项提取、结果传输与收拢：超时 SIGTERM→（宽限）SIGKILL，
 *   **exit 事件确认后才结算超时**（收拢确认，不虚报）；
 * - 并发=1（内存上限=单子进程 320MB）+等待队列 4：超队=parse-busy 明确拒绝（不悬挂）；
 * - 成功/失败路径统一 finally 清计时器/注销子进程——无悬挂句柄；dispose（daemon.stop）
 *   杀全部子进程并拒绝排队任务；
 * - 响应体积防御上限（worker 侧已限输出——此为第二道界）。
 *
 * 子进程脚本解析顺序：ZS_PARSE_WORKER 显式指定 → 打包同目录 parse-worker.mjs（daemon.cjs
 * 同目录）→ 源码形态按需 esbuild 产出 dist/dev-parse/parse-worker.mjs（每进程一次——
 * esbuild 为开发依赖，生产产物恒走第二分支不触达）。
 */
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  PARSE_CONCURRENCY, PARSE_QUEUE_MAX, PARSE_DEADLINE_MS, PARSE_KILL_GRACE_MS,
  PARSE_MEMORY_LIMIT_MB, PARSE_RESPONSE_MAX_BYTES,
  type ExtractCache, type ParseJob, type ParseJobKind, type ParseResponse,
} from './parseContracts.ts';

export type ParseRunResult =
  | { ok: true; result: ExtractCache & { artifactKind?: string } }
  | { ok: false; error: { code: string; message: string } };

export interface ParseRunOptions {
  deadlineMs?: number;
  /** 受控故障注入（仅 ZS_TEST_PARSE_HOOKS=1 生效——生产不设即不可达）。 */
  hooks?: { busyMs?: number; exitCode?: number };
}

function scriptDir(): string {
  if (typeof __dirname === 'string') return __dirname; // CJS 打包形态
  try { return dirname(fileURLToPath(import.meta.url)); } catch { return process.cwd(); } // ESM 源码形态
}

let cachedWorkerScript: string | null = null;
async function resolveWorkerScript(): Promise<string> {
  // 环境显式指定恒优先（隔离副本/测试切换不被缓存覆盖）。
  const envOverride = process.env.ZS_PARSE_WORKER;
  if (envOverride != null && envOverride.length > 0) return envOverride;
  if (cachedWorkerScript != null) return cachedWorkerScript;
  const bundled = join(scriptDir(), 'parse-worker.cjs');
  if (existsSync(bundled)) { cachedWorkerScript = bundled; return bundled; }
  // 源码/测试形态：esbuild 即时产出（每进程一次；esbuild=开发依赖）。
  const devOut = join(process.cwd(), 'dist', 'dev-parse', 'parse-worker.cjs');
  if (!existsSync(devOut)) {
    const { build } = await import('esbuild');
    mkdirSync(dirname(devOut), { recursive: true });
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
    // dev 产物对齐生产布局：同目录 cmaps/（打包形态的 CMap 依赖同目录解析）。
    const cmapsSrc = join(process.cwd(), 'node_modules', 'pdfjs-dist', 'cmaps');
    if (existsSync(cmapsSrc) && !existsSync(join(dirname(devOut), 'cmaps'))) {
      cpSync(cmapsSrc, join(dirname(devOut), 'cmaps'), { recursive: true });
    }
  }
  cachedWorkerScript = devOut;
  return devOut;
}

export class ParsePool {
  private activeCount = 0;
  private waiters: Array<(r: ParseRunResult) => void> = [];
  private readonly live = new Set<ChildProcess>();
  private disposed = false;
  /** 任务计数（completed 含成功+失败结算；解析不重复证明：同内容二次上传计数不增）。 */
  private completedCount = 0;

  stats(): { active: number; queued: number; liveChildren: number; completed: number } {
    return { active: this.activeCount, queued: this.waiters.length, liveChildren: this.live.size, completed: this.completedCount };
  }

  run(kind: ParseJobKind, blobPath: string, expectedHash: string, opts: ParseRunOptions = {}): Promise<ParseRunResult> {
    if (this.disposed) {
      return Promise.resolve({ ok: false, error: { code: 'parse-cancelled', message: '解析池已关闭（daemon 停机）——任务取消' } });
    }
    if (this.activeCount >= PARSE_CONCURRENCY) {
      if (this.waiters.length >= PARSE_QUEUE_MAX) {
        return Promise.resolve({ ok: false, error: { code: 'parse-busy', message: `解析队列已满（并发 ${PARSE_CONCURRENCY}+等待 ${PARSE_QUEUE_MAX}）——请稍后重试（明确拒绝，不悬挂）` } });
      }
      return new Promise<ParseRunResult>((resolve) => {
        if (this.disposed) {
          resolve({ ok: false, error: { code: 'parse-cancelled', message: '解析池已关闭（daemon 停机）——任务取消' } });
          return;
        }
        this.waiters.push(resolve);
      });
    }
    return this.runNow(kind, blobPath, expectedHash, opts);
  }

  private async runNow(kind: ParseJobKind, blobPath: string, expectedHash: string, opts: ParseRunOptions): Promise<ParseRunResult> {
    this.activeCount += 1;
    try {
      const script = await resolveWorkerScript();
      const jobId = `pj_${randomUUID()}`;
      // 受控故障钩子：仅 ZS_TEST_PARSE_HOOKS=1 可达；缺省回落环境变量（命令层上传无 hooks
      // 入口——归档竞态等故障注入按环境给）。
      const hooks = process.env.ZS_TEST_PARSE_HOOKS === '1'
        ? { busyMs: Number(process.env.ZS_TEST_PARSE_BUSY_MS ?? 0) || opts.hooks?.busyMs, exitCode: opts.hooks?.exitCode }
        : undefined;
      const job: ParseJob = { jobId, kind, blobPath, expectedHash, ...(hooks != null ? { hooks } : {}) };
      return await this.dispatch(script, job, opts.deadlineMs ?? PARSE_DEADLINE_MS);
    } finally {
      this.activeCount -= 1;
      const next = this.waiters.shift();
      if (next != null) next(this.disposed
        ? { ok: false, error: { code: 'parse-cancelled', message: '解析池已关闭（daemon 停机）——排队任务取消' } }
        : await this.runNow(kind, blobPath, expectedHash, opts));
    }
  }

  private dispatch(script: string, job: ParseJob, deadlineMs: number): Promise<ParseRunResult> {
    return new Promise<ParseRunResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = fork(script, [], {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          execArgv: [...process.execArgv, `--max-old-space-size=${PARSE_MEMORY_LIMIT_MB}`],
        });
      } catch (error) {
        resolve({ ok: false, error: { code: 'parse-worker-failed', message: `解析子进程启动失败：${error instanceof Error ? error.message : String(error)}` } });
        return;
      }
      this.live.add(child);
      let settled = false;
      let timedOut = false;
      let killTimer: NodeJS.Timeout | null = null;
      let stderrTail = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (d: string) => { stderrTail = (stderrTail + d).slice(-500); });
      const finish = (r: ParseRunResult): void => {
        if (settled) return;
        settled = true;
        this.completedCount += 1;
        if (killTimer != null) { clearTimeout(killTimer); killTimer = null; }
        resolve(r);
      };
      // 截止：TERM→宽限→KILL；**exit 确认后**才结算超时（收拢确认）。
      const deadlineTimer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch { /* 已退出 */ }
        killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, PARSE_KILL_GRACE_MS);
      }, deadlineMs);
      child.once('message', (raw: unknown) => {
        clearTimeout(deadlineTimer);
        const resp = raw as ParseResponse;
        if (resp == null || resp.jobId !== job.jobId) {
          finish({ ok: false, error: { code: 'parse-worker-failed', message: '解析子进程响应不合法（jobId 不符）' } });
          return;
        }
        if (Buffer.byteLength(JSON.stringify(resp), 'utf8') > PARSE_RESPONSE_MAX_BYTES) {
          finish({ ok: false, error: { code: 'parse-output-budget', message: `解析响应超防御上限 ${PARSE_RESPONSE_MAX_BYTES}B——输出预算拒绝` } });
          return;
        }
        if (resp.ok && resp.result != null) finish({ ok: true, result: resp.result });
        else finish({ ok: false, error: resp.error ?? { code: 'parse-worker-failed', message: '解析失败（无错误详情）' } });
      });
      child.once('exit', (code, signal) => {
        clearTimeout(deadlineTimer);
        if (killTimer != null) { clearTimeout(killTimer); killTimer = null; }
        this.live.delete(child);
        if (settled) return;
        if (this.disposed) {
          finish({ ok: false, error: { code: 'parse-cancelled', message: '解析池已关闭（daemon 停机）——在途任务取消并确认退出' } });
        } else if (timedOut) {
          finish({ ok: false, error: { code: `${job.kind}-timeout`, message: `解析超时（${deadlineMs}ms 截止，子进程已终止并确认退出 code=${code ?? '?'}${signal != null ? ` signal=${signal}` : ''}）——资源限制如实拒绝` } });
        } else {
          finish({ ok: false, error: { code: 'parse-worker-exited', message: `解析子进程未产出结果即退出（code=${code ?? '?'}${signal != null ? ` signal=${signal}` : ''}${stderrTail.length > 0 ? `；stderr 尾部：${stderrTail.slice(-160)}` : ''}）` } });
        }
      });
      child.once('error', (error) => {
        clearTimeout(deadlineTimer);
        this.live.delete(child);
        finish({ ok: false, error: { code: 'parse-worker-failed', message: `解析子进程错误：${error.message}` } });
      });
      child.send(job);
    });
  }

  /** 关停（daemon.stop）：杀全部子进程、拒绝排队任务，exit 确认后返回（有界）。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    const cancelled: ParseRunResult = { ok: false, error: { code: 'parse-cancelled', message: '解析池已关闭（daemon 停机）——排队任务取消' } };
    for (const w of this.waiters.splice(0)) w(cancelled); // 已排队任务以取消结算（不再启动）
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
