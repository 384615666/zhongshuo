/**
 * G3 Electron 演示（fake 与 codex 两档）：启动打包后的正式 UI（dist/ui/main.js），
 * 以 ZS_UI_DEMO 驱动自动化链路（打开项目→提交→轮询→history→截图→结果 JSON）。
 * fake 档零额度；codex 档消耗真实 turn（预算由 ZS_DEMO_TIMEOUT_MS 控制）。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 固定 fixture 目录：真实档与 fake 档共用同一真实文件（notes.md 暗号 G3-CODEX-8848）。
const fixtureRoot = process.env.ZS_G3_TMP ?? mkdtempSync(join(tmpdir(), 'zhongshuo-g3-'));
mkdirSync(join(fixtureRoot, 'proj'), { recursive: true });
const projDir = join(fixtureRoot, 'proj');
if (!existsSync(join(projDir, 'notes.md'))) {
  writeFileSync(join(projDir, 'notes.md'), '# 备忘\n\n宇宙密码：G3-CODEX-8848\n', 'utf8');
}
afterAll(() => {
  for (let i = 0; i < 3; i += 1) {
    try {
      rmSync(fixtureRoot, { recursive: true, force: true });
      break;
    } catch { /* retry */ }
  }
});

interface DemoResult {
  ok: boolean
  runtime: string
  taskStatus: string
  agentReplies: string[]
  screenshot: string
  error?: string
}

function runElectronDemo(runtime: 'fake' | 'codex', timeoutMs: number): Promise<DemoResult> {
  const appData = join(fixtureRoot, `appdata-${runtime}`);
  const resultPath = join(fixtureRoot, `demo-${runtime}.json`);
  const shots = join(fixtureRoot, 'shots');
  return new Promise((resolve, reject) => {
    // Windows：.cmd shim 不能直接 spawn（EINVAL/ENOENT）——直指 Electron 原生 exe。
    const electronBin = join('node_modules', 'electron', 'dist', 'electron.exe');
    const child = spawn(electronBin, ['dist/ui/main.cjs'], {
      env: {
        ...process.env,
        ZS_APP_DATA: appData,
        ZS_RUNTIME: runtime,
        ZS_ALLOW_FAKE: '1',
        ZS_UI_DEMO: resultPath,
        ZS_DEMO_DIR: projDir,
        ZS_DEMO_SHOTS: shots,
        ZS_DEMO_TIMEOUT_MS: String(timeoutMs),
        ZS_E2E_MODEL: process.env.ZS_E2E_MODEL ?? 'gpt-6-luna',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.stdout.on('data', () => {});
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Electron 演示超时（${runtime}）\n${stderr.slice(-500)}`));
    }, timeoutMs + 90_000);
    timer.unref?.();
    child.on('exit', () => {
      clearTimeout(timer);
      if (!existsSync(resultPath)) {
        reject(new Error(`演示未产出结果（${runtime}）\n${stderr.slice(-800)}`));
        return;
      }
      resolve(JSON.parse(readFileSync(resultPath, 'utf8')) as DemoResult);
    });
  });
}

describe('G3：正式 Electron UI 闭环', () => {
  it('fake 档（开发模式，零额度）：打开→提交→worker→线程回复→截图', async () => {
    const result = await runElectronDemo('fake', 60_000);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.taskStatus).toBe('DONE');
    expect(result.agentReplies.length).toBeGreaterThanOrEqual(1);
    // 截图在无 GPU 合成器的会话（RDP）会失败——业务链路结果为准，截图存在性不强求。
    if (result.screenshot != null) expect(existsSync(result.screenshot)).toBe(true);
  }, 240_000);

  it('codex 档（真实 runtime，gpt-6-luna）：真实文件内容回流进正确线程', async ({ skip }) => {
    if (process.env.ZS_G3_REAL !== '1') skip(); // 真实档显式触发，控制预算
    const result = await runElectronDemo('codex', 240_000);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    // 正式输入包含用户请求，真实文件内容（fixture 暗号）经模型回流线程。
    const all = result.agentReplies.join('\n');
    expect(all).toContain('G3-CODEX-8848');
    if (result.screenshot != null) expect(existsSync(result.screenshot)).toBe(true);
  }, 420_000);
});
