/**
 * 测试入口隔离证明（2026-09-29 核账后新增，零模型调用）：
 * 上轮教训——`npm run test:e2e` 全量曾收集无门禁的 realCodex*.test.ts，在调试循环中
 * 反复触发真实调用（45 会话/55 turn/gpt-6-luna，与「零真实调用」声明矛盾）。本用例把
 * 防复发措施固化为可回归断言：
 * - 配置层：fake e2e 配置按文件名排除 real*；真实认证独立配置只含 real*；
 * - 门禁层：三个 real 文件 describe 级 ZS_REAL_E2E 门禁（文本断言防回退）；
 * - 功能证明（真实子进程执行，不靠猜）：①`vitest list`（fake 配置）收集集合不含
 *   real* 文件；②`vitest run`（real 配置，**不设 ZS_REAL_E2E**）全部 skip、零失败、
 *   秒级完成——不发任何模型请求（App Server 不 spawn：guard 在 describe 级，用例体
 *   与 beforeAll 均不执行真实 turn）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = join(__dirname, '..', '..');

describe('测试入口隔离（防真实调用混跑）', () => {
  it('配置层：fake e2e 排除 real*；真实认证独立入口只含 real*', () => {
    const fake = readFileSync(join(root, 'vitest.e2e.config.ts'), 'utf8');
    expect(fake).toContain("exclude: ['**/node_modules/**', '**/.git/**', 'tests/e2e/real*.test.ts']");
    const real = readFileSync(join(root, 'vitest.real.e2e.config.ts'), 'utf8');
    expect(real).toContain("include: ['tests/e2e/real*.test.ts']");
  });

  it('门禁层：三个真实认证文件均有 ZS_REAL_E2E describe 级门禁（缺省 skip 不发请求）', () => {
    for (const f of ['realCodex.test.ts', 'realCodexFinish.test.ts', 'realCodexRemaining.test.ts']) {
      const text = readFileSync(join(root, 'tests', 'e2e', f), 'utf8');
      expect(text, f).toContain("process.env.ZS_REAL_E2E === '1' ? describe : describe.skip");
    }
  });

  it('预算护栏层（第八轮）：真实文件的 startTurn 全部经 RealCallGate 计数（环境变量门禁≠预算硬上限，分别验收）', () => {
    for (const f of ['realCodex.test.ts', 'realCodexFinish.test.ts', 'realCodexRemaining.test.ts']) {
      const text = readFileSync(join(root, 'tests', 'e2e', f), 'utf8');
      expect(text, `${f}: 应初始化闸门`).toContain('RealCallGate.open({');
      // 不允许再出现未经闸门的直接 await startTurn（gatedStartTurn 包装除外）。
      const direct = [...text.matchAll(/await\s+(\w+)\.startTurn\(/g)].map((m) => m[1]!);
      expect(direct, `${f}: 存在未过闸的 startTurn：${direct.join(',')}`).toHaveLength(0);
      expect(text, f).toContain('gatedStartTurn(gate,');
    }
    // 护栏自身语义的本地模拟验收（零网络）。
    const gateText = readFileSync(join(root, 'tests', 'util', 'realCallGate.ts'), 'utf8');
    expect(gateText).toContain('RealCallLimitError'); // 超限=请求前拦截
    expect(gateText).toContain("'uncertain'"); // 请求是否发出不确定=如实记录，不当零消耗
  });

  it('功能证明①：fake e2e 配置的收集集合不含 real*（vitest list 子进程实跑）', () => {
    const out = execFileSync('npx', ['vitest', 'list', '--config', 'vitest.e2e.config.ts', '--run=false'], {
      cwd: root, encoding: 'utf8', timeout: 120_000, shell: process.platform === 'win32',
    });
    const files = [...out.matchAll(/([\w./\\-]*test\.ts)/g)].map((m) => (m[1] ?? '').replaceAll('\\', '/'));
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.includes('realCodex')), `real 文件混入：${files.join(',')}`).toBe(false);
  }, 180_000);

  it('功能证明②：真实配置在未设 ZS_REAL_E2E 时全部 skip、零失败（不 spawn App Server、不发请求）', () => {
    const env = { ...process.env };
    delete env.ZS_REAL_E2E; // 未显式 opt-in 的缺省状态
    const out = execFileSync('npx', ['vitest', 'run', '--config', 'vitest.real.e2e.config.ts'], {
      cwd: root, encoding: 'utf8', timeout: 300_000, shell: process.platform === 'win32', env,
    });
    expect(out).toMatch(/skipped/);
    expect(out).not.toMatch(/failed/);
    expect(out).not.toMatch(/passed \([1-9]/); // 无任何用例实际执行（全 skip）
  }, 360_000);
});
