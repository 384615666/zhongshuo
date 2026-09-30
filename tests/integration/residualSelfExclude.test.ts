/**
 * 残留检测自身排除回归（第十八轮一）：独立机 Git Bash 首启误报（pid=40252=验证器自身主进程
 * 被包路径匹配）的修复验证。三壳（.cmd 相对 / PowerShell 绝对路径 / Git Bash）各启动探针：
 * - fixed（v2 协议：排除自身+父壳+查询辅助）→ 自身不计、decoy 仍可检出、杀 decoy 后归零；
 * - legacy（只排除查询辅助——修复前形态）→ 绝对路径壳下自身必须被匹配（负向对照：证明本
 *   测试装置能复现被报告的误报类别，fixed 通过才有意义）。
 * PS 查询文本直接从随包分发的模板源提取（保证回归的是交付字节），三处实现须逐字一致。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');
const templateLocal = readFileSync(join(repoRoot, 'scripts', 'independent-verify-local.template.mjs'), 'utf8');
const templateDesktop = readFileSync(join(repoRoot, 'scripts', 'independent-verify-desktop.template.mjs'), 'utf8');
const devVerifier = readFileSync(join(repoRoot, 'scripts', 'verify-desktop.mjs'), 'utf8');

function extractProcQuery(source: string, label: string): string {
  const begin = 'const PROC_QUERY_PS = `';
  const start = source.indexOf(begin);
  expect(start, `${label} 缺少 PROC_QUERY_PS 块`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('`;', start + begin.length);
  expect(end, `${label} PROC_QUERY_PS 块未闭合`).toBeGreaterThan(start);
  return source.slice(start + begin.length, end);
}

const PROBE = `
import { spawn, spawnSync } from 'node:child_process';
const mode = process.argv[2] ?? 'fixed';
const here = import.meta.dirname; // 模式根=探针目录（含 q.ps1 与探针自身路径）
const pattern = '*' + here + '*';
const alt = pattern.replaceAll('\\\\', '/');
function query() {
  const exclude = mode === 'fixed' ? [process.pid, process.ppid].filter((p) => p != null).join(',') : '';
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', here + '\\\\' + 'q.ps1'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ZS_PROC_PATTERN: pattern, ZS_PROC_PATTERN_ALT: alt !== pattern ? alt : '', ZS_PROC_EXCLUDE: exclude } });
  const out = (r.stdout ?? '').trim();
  if (r.status !== 0 || r.error != null || !out.includes('QUERY-OK') || out.includes('ERR' + String.fromCharCode(9))) { console.log('PROBE-RESULT ' + JSON.stringify({ error: (out.slice(0, 120) || '空输出') })); process.exit(0); }
  return out.split('\\n').filter((l) => /^\\d+\\t/.test(l.trim())).map((l) => Number(l.trim().split('\\t')[0]));
}
const rows1 = query();
const selfSeen = rows1.includes(process.pid);
const decoy = spawn(process.execPath, ['-e', 'setInterval(()=>{},20000) /* ' + here + ' decoy */'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1000));
const rows2 = query();
const decoySeen = rows2.includes(decoy.pid ?? -1);
decoy.kill();
await new Promise((r) => setTimeout(r, 1200));
const afterKill = query().length;
console.log('PROBE-RESULT ' + JSON.stringify({ mode, selfSeen, decoySeen, afterKill }));
process.exit(0);
`;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-residual-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

interface ProbeResult { mode?: string; selfSeen?: boolean; decoySeen?: boolean; afterKill?: number; error?: string }

function runProbe(launcher: 'cmd' | 'powershell' | 'bash', mode: 'fixed' | 'legacy', probeDir: string): ProbeResult | null {
  const probePath = join(probeDir, 'probe.mjs');
  let r: { status: number | null; stdout: string; stderr: string };
  if (launcher === 'cmd') {
    // 相对路径（忠实于 .cmd 双击形态）：命令行不含探针绝对路径——修复前也"碰巧"不匹配。
    r = spawnSync('cmd.exe', ['/c', 'node', 'probe.mjs', mode], { encoding: 'utf8', cwd: probeDir, timeout: 120_000, env: process.env });
  } else if (launcher === 'powershell') {
    const psQuote = (s: string) => `'${s.replaceAll("'", "''")}'`; // PS 单引号串仅 '' 转义，路径原样
    r = spawnSync('powershell', ['-NoProfile', '-Command', `& ${psQuote(process.execPath)} ${psQuote(probePath)} ${mode}`], { encoding: 'utf8', timeout: 120_000, env: process.env });
  } else {
    const bash = spawnSync('where', ['bash'], { encoding: 'utf8' }).stdout.trim().split('\n')[0]?.trim();
    if (bash == null || bash.length === 0) return null; // 可用时才覆盖（开发机=Git Bash 环境）
    const toMsys = (p: string) => `/${p[0]!.toLowerCase()}${p.slice(2).replaceAll('\\', '/')}`; // MSYS 经参数转换写回 Windows 绝对路径（复现独立机形态）
    const shQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    r = spawnSync(bash, ['-c', `${shQuote(process.execPath)} ${shQuote(toMsys(probePath))} ${mode}`], { encoding: 'utf8', timeout: 120_000, env: process.env });
  }
  const line = (r.stdout ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('PROBE-RESULT '));
  if (line == null) throw new Error(`${launcher}/${mode} 探针无结果：status=${r.status} stderr=${(r.stderr ?? '').slice(0, 160)}`);
  return JSON.parse(line.slice('PROBE-RESULT '.length));
}

describe('残留检测 v2：三处实现逐字一致', () => {
  it('独立包两模板+开发机 verify-desktop 的 PROC_QUERY_PS 完全一致', () => {
    const a = extractProcQuery(templateLocal, '独立本地模板');
    const b = extractProcQuery(templateDesktop, '独立桌面模板');
    const c = extractProcQuery(devVerifier, '开发机验证器');
    expect(b).toBe(a);
    expect(c).toBe(a);
    // 协议要点：显式排除清单 + 双形态模式（反斜杠/正斜杠——MSYS 启动的进程命令行为正斜杠形态）+ 查询辅助自身 + QUERY-OK 成功标记。
    expect(a).toContain('ZS_PROC_EXCLUDE');
    expect(a).toContain('ZS_PROC_PATTERN_ALT');
    expect(a).toContain('-ne $PID');
    expect(a).toContain('QUERY-OK');
  });
});

describe('残留检测 v2：三壳自身排除（fixed）与误报（legacy）', () => {
  const probeDir = join(tmpRoot, 'P');

  it('准备探针目录（模式根=P，含 PS 查询=模板交付字节）', () => {
    mkdirSync(probeDir, { recursive: true });
    writeFileSync(join(probeDir, 'q.ps1'), extractProcQuery(templateLocal, '独立本地模板'), 'utf8');
    writeFileSync(join(probeDir, 'probe.mjs'), PROBE, 'utf8');
  });

  it('legacy 负向对照：绝对路径壳（PowerShell/Git Bash）下自身被匹配——复现独立机误报类别', () => {
    const pwsh = runProbe('powershell', 'legacy', probeDir);
    expect(pwsh?.error).toBeUndefined();
    expect(pwsh?.selfSeen, '装置未能复现误报（PowerShell 绝对路径下 legacy 应匹配自身）——fixed 结论失效').toBe(true);
    const bash = runProbe('bash', 'legacy', probeDir);
    if (bash != null) {
      expect(bash.error).toBeUndefined();
      expect(bash.selfSeen, '装置未能复现误报（Git Bash 下 legacy 应匹配自身）').toBe(true);
    }
  }, 240_000);

  it('legacy 对照补：.cmd 相对路径壳下自身不匹配（原"碰巧通过"形态，非安全依据）', () => {
    const cmd = runProbe('cmd', 'legacy', probeDir);
    expect(cmd?.error).toBeUndefined();
    expect(cmd?.selfSeen).toBe(false);
  }, 240_000);

  it('fixed 三壳：自身不计、decoy 仍检出（检测未失效）、杀 decoy 后归零', () => {
    for (const launcher of ['cmd', 'powershell', 'bash'] as const) {
      const res = runProbe(launcher, 'fixed', probeDir);
      if (res == null) continue; // bash 不可用时跳过
      expect(res.error, `${launcher} 查询失败`).toBeUndefined();
      expect(res.selfSeen, `${launcher}：自身仍被计入`).toBe(false);
      expect(res.decoySeen, `${launcher}：decoy 未被检出——检测被削弱为"匹配不到"`).toBe(true);
      expect(res.afterKill, `${launcher}：杀 decoy 后未归零`).toBe(0);
    }
  }, 360_000);
});
