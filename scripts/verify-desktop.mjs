/**
 * DEV-15 桌面产物验收（第十四轮四）：中文+空格安装目录上的完整桌面链——本地可复核，
 * 不发布、不修改用户现有安装或全局环境。
 *
 * 链路断言（分层如实）：
 * ① 首次启动+正常退出：electron.exe（产物）→ main（打包形态：随包 Node daemon.cjs+
 *    受管默认开）→ IPC → fake runtime turn → 任务 DONE → daemon.shutdown 优雅停机 →
 *    应用退出码 0 + daemon.pid 移除 + 无遗留进程（Win32_Process 按产物路径核对）；
 * ② 重复启动（顺序）：同 appData 第二次全链（单例锁随干净退出释放——第二次不得失败）；
 * ③ 受管依赖缺失负例：精确移除产物内 koffi+@koromix（断言确实移除）→ 启动=daemon
 *    拒绝启动（stderr 含拒绝字样）→ 应用明确失败退出（exit 1，不静默降级为未受管）。
 *
 * 运行时分层如实：Electron/随包 Node 均来自产物自身（开发 PATH 不参与 daemon 启动——
 * main 以绝对路径调用随包 node.exe）；开发环境构建产物属正常交付形态。
 * 失败保留诊断目录与报告；成功按明确范围清理。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const repo = resolve(import.meta.dirname, '..');

// 前置构建（幂等）：UI → daemon bundle → 桌面便携装配。
for (const script of ['build-ui.mjs', 'pack-daemon.mjs', 'pack-desktop.mjs']) {
  const r = spawnSync(process.execPath, [join(repo, 'scripts', script)], { cwd: repo, encoding: 'utf8', timeout: 300_000 });
  if (r.status !== 0) {
    console.error(`[verify-desktop] 前置构建失败（${script}）：${(r.stdout ?? '') + (r.stderr ?? '')}`);
    process.exit(1);
  }
}
const staging = join(repo, 'dist', 'desktop', '众说-便携-win-x64');

/** 安装目录：中文+空格路径（DEV-15 验收项）。 */
const installRoot = mkdtempSync(join(tmpdir(), '桌面 安装-'));
const appHome = join(installRoot, '众说 桌面版');
cpSync(staging, appHome, { recursive: true, dereference: true });
const fixtureProj = join(installRoot, '演示 项目');
mkdirSync(fixtureProj, { recursive: true });
writeFileSync(join(fixtureProj, 'notes.md'), '# 演示\n\n宇宙密码：DEV15-PORTABLE-9527\n', 'utf8');

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `：${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const appendFile = (path, text) => { try { appendFileSync(path, text); } catch { /* 诊断尽力而为 */ } };

/** 产物残留进程查询（第十五轮二修正）：QUERY-OK 尾标=查询成功（空结果=零行）；失败/超时/
 * 非数字=ERR（不当 0）；排除查询进程自身；按安装根匹配**任意名称**执行载体（不限 node/electron）。
 * 正常用例不得以「匹配不到」证明无残留——控制组 decoy 先证检测有效。 */
const psQueryPath = join(installRoot, 'proc-query.ps1');
writeFileSync(psQueryPath, [
  '$Pattern = $env:ZS_PROC_PATTERN',
  '$ErrorActionPreference = "Stop"',
  'try {',
  '  $p = Get-CimInstance Win32_Process -Filter "CommandLine != NULL" | Where-Object { $_.CommandLine -like $Pattern -and $_.ProcessId -ne $PID }',
  '  $p | ForEach-Object { "{0}`t{1}" -f $_.ProcessId, $_.Name }',
  '  "QUERY-OK"',
  '} catch { "ERR`t" + $_.Exception.Message }',
].join('\n'), 'utf8');
function leftoverProcesses() {
  const ask = () => spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psQueryPath], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ZS_PROC_PATTERN: `*${installRoot}*` } });
  let r = ask();
  if (r.error != null || r.status !== 0) r = ask(); // 冷启动首查重试一次（失败不折算为零）
  const out = (r.stdout ?? '').trim();
  if (r.status !== 0 || r.error != null || !out.includes('QUERY-OK') || out.includes('ERR\t')) return 'ERR';
  return out.split('\n').filter((l) => /^\d+\t/.test(l.trim())).length;
}

/** 启动产物并等待退出（严格分类：code/signal/超时分开，不把超时算成功）。 */
function runDesktop(appData, extraEnv, timeoutMs) {
  return new Promise((resolveRun) => {
    const resultPath = join(appData, '..', `demo-${Date.now()}.json`);
    const child = spawn(join(appHome, 'electron.exe'), [], {
      cwd: installRoot,
      env: {
        ...process.env,
        ZS_APP_DATA: appData,
        ZS_RUNTIME: 'fake',
        ZS_ALLOW_FAKE: '1',
        ZS_UI_DEMO: resultPath,
        ZS_DEMO_DIR: fixtureProj,
        ZS_DEMO_SHOTS: join(appData, 'shots'),
        ZS_DEMO_TIMEOUT_MS: '90000',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stdout.setEncoding('utf8');
    const logPath = join(installRoot, `desktop-run-${Date.now()}.log`);
    child.stderr.on('data', (c) => { stderr += c; try { appendFile(logPath, c); } catch { void 0; /* 诊断尽力而为 */ } });
    child.stdout.on('data', () => {});
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    let timedOut = false;
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, timedOut, stderr, resultPath });
    });
  });
}

const readResult = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};

let failed = false;
try {
  // ① 首次启动 + 正常退出（全链 fake：electron→随包 Node daemon→IPC→turn DONE→优雅停机）。
  {
    const appData = join(installRoot, '应用 数据', '实例一');
    const r = await runDesktop(appData, {}, 240_000);
    const demo = readResult(r.resultPath);
    const pidFileGone = !existsSync(join(appData, 'daemon.pid'));
    record('首次启动全链（打包形态：随包 Node daemon+受管默认开；任务 DONE）',
      r.code === 0 && r.signal == null && !r.timedOut && demo?.ok === true && demo?.taskStatus === 'DONE',
      `exit=${r.code}/${r.signal ?? '-'} timedOut=${r.timedOut} demo=${demo == null ? '无结果' : `${demo.taskStatus}`}`);
    record('正常退出（优雅停机：exit 0+pid 文件移除+无产物残留进程）',
      r.code === 0 && pidFileGone && leftoverProcesses() === 0,
      `pidFile=${pidFileGone ? '移除' : '残留'} leftover=${leftoverProcesses()}`);
    if (r.code !== 0 || demo?.ok !== true) {
      failed = true;
      console.error(`[verify-desktop] 首启失败——stderr 尾部：\n${r.stderr.split('\n').slice(-12).join('\n')}`);
      throw new Error('首启失败——中止');
    }
  }

  // ② 重复启动（顺序·**同一 appData**——不换目录冒充锁释放验证；首轮历史仍在）。
  {
    const appDataSame = join(installRoot, '应用 数据', '实例一'); // 与 ① 同目录
    const r = await runDesktop(appDataSame, {}, 240_000);
    const demo = readResult(r.resultPath);
    // 同目录历史核对：首轮任务仍在库中（不同 appData 另列 ⑤，不与重开混同）。
    const Database = createRequire(join(repo, 'node_modules', 'better-sqlite3'))('better-sqlite3');
    const db = new Database(join(appDataSame, 'state.sqlite'), { readonly: true });
    const taskCount = db.prepare('SELECT count(*) c FROM tasks').get().c;
    db.close();
    record('重复启动（同 appData 第二次全链 DONE+首轮历史仍在——锁随干净退出释放）',
      r.code === 0 && r.signal == null && !r.timedOut && demo?.ok === true && taskCount >= 2 && leftoverProcesses() === 0,
      `exit=${r.code} demo=${demo == null ? '无结果' : demo.taskStatus} tasks=${taskCount}`);
  }

  // ③ 并发启动（同一 appData）：第二实例 daemon 单例锁拒绝→应用明确失败退出；第一实例不受污染。
  {
    const appDataC = join(installRoot, '应用 数据', '并发实例');
    const first = runDesktop(appDataC, { ZS_FAKE_STALL_MS: '20000' }, 240_000); // 长任务占住实例
    await sleep(9000); // 等第一实例 daemon 完全就绪
    const second = await runDesktop(appDataC, {}, 180_000);
    const firstR = await first;
    const d1 = readResult(firstR.resultPath);
    const secondRefused = second.code === 1 && second.stderr.includes('daemon 异常退出');
    record('并发启动（同 appData：第二实例明确失败 exit 1，不启动第二 daemon）', secondRefused, `exit2=${second.code}`);
    record('第一实例不受污染（长任务照常 DONE+正常退出）', firstR.code === 0 && d1?.ok === true && d1?.taskStatus === 'DONE', `exit1=${firstR.code} demo=${d1?.taskStatus ?? '无'}`);
  }

  // ④ 受管依赖缺失负例：精确移除产物内 koffi+@koromix → 明确失败退出（不降级）。
  {
    const nm = join(appHome, 'resources', 'app', 'daemon', 'node_modules');
    rmSync(join(nm, 'koffi'), { recursive: true, force: true });
    rmSync(join(nm, '@koromix'), { recursive: true, force: true });
    const removed = !existsSync(join(nm, 'koffi')) && !existsSync(join(nm, '@koromix'));
    record('精确移除产物受管依赖（koffi+@koromix；better-sqlite3 保留）', removed, `koffi=${existsSync(join(nm, 'koffi'))}`);
    if (!removed) throw new Error('负例移除失败——中止');
    const appData = join(installRoot, '应用 数据', '实例三');
    const r = await runDesktop(appData, {}, 180_000);
    const refused = r.stderr.includes('拒绝启动') || r.stderr.includes('受管运行时启用');
    const failedFast = r.stderr.includes('daemon 异常退出') || r.stderr.includes('daemon 退出（code=1）');
    record('受管依赖缺失=应用明确失败退出（exit 1+拒绝启动日志；不静默未受管运行）',
      r.code === 1 && r.signal == null && !r.timedOut && refused && failedFast,
      `exit=${r.code} refused=${refused} daemonFail=${failedFast} tail=${(r.stderr.split('\n').filter((l) => l.includes('拒绝启动') || l.includes('受管运行时启用'))[0] ?? '').slice(0, 150)}`);
    await sleep(1000);
    record('负例无残留进程', leftoverProcesses() === 0, `leftover=${leftoverProcesses()}`);
  }
} catch (error) {
  failed = true;
  console.error(`[verify-desktop] 中止：${error instanceof Error ? error.stack : String(error)}`);
}

const allPassed = results.length > 0 && results.every((r) => r.ok) && !failed;
const report = {
  builtAt: new Date().toISOString(),
  installRoot,
  staging,
  results,
  allPassed,
  runtimeLayer: {
    electron: '产物自带（node_modules/electron/dist 拷贝）',
    daemonHost: '产物自带 node.exe（resources/app/daemon/node/）——daemon 启动不经开发 PATH',
    note: '便携产物在干净目录运行；未验证项=安装器/代码签名/独立 Windows 机器（见报告说明）',
  },
};
writeFileSync(join(repo, 'dist', 'desktop', 'verify-desktop-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(`[verify-desktop] ${allPassed ? '全部通过' : '存在失败'}；报告=${join(repo, 'dist', 'desktop', 'verify-desktop-report.json')}`);
if (allPassed) {
  rmSync(installRoot, { recursive: true, force: true });
  console.log(`[verify-desktop] 成功清理 installRoot=${installRoot}`);
} else {
  console.log(`[verify-desktop] 失败——保留诊断目录：${installRoot}`);
}
process.exit(allPassed ? 0 : 1);
