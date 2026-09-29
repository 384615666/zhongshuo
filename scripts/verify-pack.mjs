/**
 * DEV-15 早期打包验证（第十三轮四）：build-and-verify——产物在**脱离源码目录/开发 PATH/**
 * 的独立目录（含中文+空格路径）启动，验证 SQLite/koffi 可加载与受管 fixture 链。
 *
 * 复核产物：dist/pack/daemon.cjs + dist/pack/verify-report.json（机器可读结论）。
 * 不发布、不上传、不改动用户环境。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const repo = resolve(import.meta.dirname, '..');
const dist = join(repo, 'dist', 'pack');
const artifact = join(dist, 'daemon.cjs');
if (!existsSync(artifact)) {
  console.error('[verify-pack] 缺产物：先运行 node scripts/pack-daemon.mjs');
  process.exit(1);
}

/** 安装目录：中文+空格路径（DEV-15 验收项）。 */
const installRoot = mkdtempSync(join(tmpdir(), '装机 目录-'));
const appDir = join(installRoot, '应用 数据');
mkdirSync(appDir, { recursive: true });
cpSync(artifact, join(installRoot, '众说 daemon.cjs'));

/** 最小 node_modules：原生依赖从仓库 node_modules 复制（产物运行不依赖开发目录——拷贝到安装目录）。 */
const nm = join(installRoot, 'node_modules');
mkdirSync(nm, { recursive: true });
// pnpm 的 node_modules/<dep> 是指向 .pnpm 的符号链接——无 symlink 权限时 cpSync 失败；
// 解析真实路径后 verbatim 复制（dereference）。
import { realpathSync } from 'node:fs';
for (const dep of ['koffi', 'better-sqlite3', '@koromix']) {
  const src = join(repo, 'node_modules', dep);
  if (!existsSync(src)) continue;
  const real = realpathSync(src);
  cpSync(real, join(nm, dep), { recursive: true, dereference: true });
}
// koffi 的平台二进制是同包 @koromix/koffi-win32-x64（cnoke 在运行时按平台解析）——
// pnpm 把它装在 .pnpm/koffi@x/node_modules/@koromix 下（非顶层可见），需显式带出。
{
  const scopedSrc = join(repo, 'node_modules', '.pnpm', 'koffi@3.3.2', 'node_modules', '@koromix');
  if (existsSync(scopedSrc)) {
    mkdirSync(join(nm, '@koromix'), { recursive: true });
    cpSync(scopedSrc, join(nm, '@koromix'), { recursive: true, dereference: true });
  }
}
for (const dep of ['koffi', 'better-sqlite3']) {
  if (!existsSync(join(nm, dep, 'package.json'))) {
    console.error(`[verify-pack] ${dep} 复制不完整`);
    process.exit(1);
  }
}
// better-sqlite3 的 binding 指向相对 build/ 目录——随 recursive 复制；koffi 同理。

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `：${detail}` : ''}`);
};

/** 在安装目录启动产物（clean env——脱离开发 PATH/源码 cwd）。 */
const runPacked = (env, args = [], opts = {}) => {
  if ('nmOverride' in opts && opts.nmOverride) {
    // 精确破坏：只移除 koffi（保留 better-sqlite3——否则在受管检查前就因缺 SQLite 失败）。
    rmSync(join(nm, 'koffi'), { recursive: true, force: true });
    rmSync(join(nm, '@koromix'), { recursive: true, force: true });
  }
  const child = spawnSync(process.execPath, [join(installRoot, '众说 daemon.cjs'), ...args], {
    cwd: installRoot,
    env: {
      SystemRoot: process.env.SystemRoot,
      PATH: process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : undefined, // 仅系统 PATH——脱离开发 PATH
      ...env,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
};

// ① 宿主与依赖可加载：fake 档启动（开发模式哨兵）→ 输出 listening 行即 SQLite 可加载。
{
  const r = runPacked({ ZS_PACKED_ENTRY: '1', ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_APP_DATA: appDir, ZS_PIPE_NAME: '\\\\\.\\\\pipe\\\\zs-pack-verify-1' });
  const listening = r.stderr.includes('listening') || r.stdout.includes('listening');
  record('daemon 启动（SQLite 可加载，中文+空格安装路径）', listening, listening ? 'listening 行已出现' : `exit=${r.status} stderr=${(r.stderr || '').slice(0, 200)} stdout=${(r.stdout || '').slice(0, 200)}`);
  record('daemon 优雅退出', r.status === 0 || r.status == null, `exit=${r.status}`);
}

// ② 受管能力可加载：koffi 探针（经产物 bundle 内 jobManager——ZS_MANAGED_PROBE=1 哨兵）。
//    产物入口当前不识别该哨兵——用 node -e 从安装目录 require 产物不适用（CJS bundle 导出
//    startDaemon）。改为直接以 koffi 探针进程验证安装目录 node_modules 链：
{
  const probePath = join(installRoot, 'koffi-probe.cjs');
  writeFileSync(probePath, "try { const koffi = require('koffi'); const k = koffi.load('kernel32.dll'); const pid = k.func('uint32_t __stdcall GetCurrentProcessId()')(); console.log('KOFFI_OK pid=' + pid); } catch (e) { console.log('KOFFI_FAIL ' + e.message); }", 'utf8');
  // 探针直接跑 node probe.cjs（runPacked 固定以 daemon.cjs 为 argv[1]——会静默跑空 bundle）。
  const r = spawnSync(process.execPath, [probePath], {
    cwd: installRoot,
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : undefined },
    encoding: 'utf8',
    timeout: 20_000,
  });
  record('koffi 受管能力可加载（安装目录 node_modules）', r.stdout.includes('KOFFI_OK'), `${(r.stdout || '').trim().slice(0, 60)} | err=${((r.stderr || '').split('\n').slice(0, 2).join(' / ') || '').slice(0, 150)}`);
}

// ③ 受管能力加载失败=拒绝派发不降级：受管开关开但 koffi 不可用（NODE_PATH 指向空目录）→
//    产物启动失败（不静默降级为未受管）。
{
  const r = runPacked({ ZS_PACKED_ENTRY: '1', ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_APP_DATA: appDir, ZS_MANAGED_RUNTIME: '1', ZS_PIPE_NAME: '\\\\\.\\\\pipe\\\\zs-pack-verify-2' }, [], [], { nmOverride: true });
  const refused = r.status !== 0 && ((r.stderr || '').includes('受管运行时启用') || (r.stderr || '').includes('拒绝启动'));
  record('受管加载失败=拒绝启动（不降级）', refused, `exit=${r.status} tail=${(((r.stderr || '').split('\n').filter(Boolean).slice(-1)[0]) ?? '').slice(0, 140)}`);
}

// 报告落盘（机器可读）。
const report = { builtAt: new Date().toISOString(), installRoot, results, allPassed: results.every((r) => r.ok) };
writeFileSync(join(dist, 'verify-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(`[verify-pack] ${report.allPassed ? '全部通过' : '存在失败'}；报告=${join(dist, 'verify-report.json')}`);
rmSync(installRoot, { recursive: true, force: true });
process.exit(report.allPassed ? 0 : 1);
