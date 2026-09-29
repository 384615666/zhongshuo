/**
 * RealCallGate 本地模拟验证（第八轮，零网络——文件账本+锁语义，不执行真实认证）。
 * 「有环境变量门禁」与「已有预算硬上限」分别验收：本文件只验后者（机械约束）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { RealCallGate, RealCallConfigError, RealCallLimitError, gatedStartTurn } from '../util/realCallGate.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-rcg-'));
afterAll(() => {
  for (let i = 0; i < 3; i += 1) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ }
  }
});

describe('真实调用预算硬上限（文件账本+目录锁；零网络模拟）', () => {
  it('配置缺失/非法：open 即拒绝（未提供配置时在请求前拒绝，不静默执行）', () => {
    expect(() => RealCallGate.open({})).toThrow(RealCallConfigError);
    expect(() => RealCallGate.open({ runtime: 'claude', model: 'deepseek-flash' })).toThrow(RealCallConfigError);
    expect(() => RealCallGate.open({ runtime: 'claude', model: 'm', maxStartTurns: 0, budgetLabel: 'x', storeDir: join(tmpRoot, 'a') })).toThrow(RealCallConfigError);
  });

  it('单进程：额度内放行、超限请求前拦截；拒绝不占额度但如实计数', () => {
    const storeDir = join(tmpRoot, 'single');
    const gate = RealCallGate.open({ runtime: 'claude', model: 'deepseek-flash', maxStartTurns: 2, budgetLabel: 'unit-single', storeDir });
    const t1 = gate.acquireStartTurn();
    const t2 = gate.acquireStartTurn();
    gate.recordOutcome(t1, 'sent');
    gate.recordOutcome(t2, 'failed', '连接被拒');
    expect(() => gate.acquireStartTurn()).toThrow(RealCallLimitError);
    expect(() => gate.acquireStartTurn()).toThrow(RealCallLimitError); // 拒绝可重复（不占额度）
    const s = gate.summary();
    expect(s).toMatchObject({ acquired: 2, rejected: 2, sent: 1, failed: 1, maxStartTurns: 2 });
    // 账本持久化：新实例（同目录）读到同一事实——额度不因重开闸门而重置。
    const gate2 = RealCallGate.open({ runtime: 'claude', model: 'deepseek-flash', maxStartTurns: 2, budgetLabel: 'unit-single', storeDir });
    expect(() => gate2.acquireStartTurn()).toThrow(RealCallLimitError);
  });

  it('同账本混入不同 runtime/model：open 拒绝（不同真实渠道必须分账本）', () => {
    const storeDir = join(tmpRoot, 'mixed');
    RealCallGate.open({ runtime: 'claude', model: 'deepseek-flash', maxStartTurns: 3, budgetLabel: 'b1', storeDir });
    expect(() => RealCallGate.open({ runtime: 'codex', model: 'gpt-6-luna', maxStartTurns: 3, budgetLabel: 'b2', storeDir })).toThrow(RealCallConfigError);
  });

  it('gatedStartTurn：成功记 sent；异常记 failed 后上抛（额度占用不返还）；超时如实记 timeout/uncertain', async () => {
    const gate = RealCallGate.open({ runtime: 'claude', model: 'deepseek-flash', maxStartTurns: 8, budgetLabel: 'unit-gated', storeDir: join(tmpRoot, 'gated') });
    await gatedStartTurn(gate, async () => { /* 成功 */ });
    await expect(gatedStartTurn(gate, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(gatedStartTurn(gate, () => new Promise(() => { /* 挂起 */ }), 40)).rejects.toThrow('gated-start-turn-timeout');
    const s = gate.summary();
    expect(s).toMatchObject({ acquired: 3, sent: 1, failed: 1, timeout: 1 });
  });

  it('跨进程并发（两个真实子进程各争 6 次，总额度 8）：acquired 合计不超限、拒绝如实计数', () => {
    const storeDir = join(tmpRoot, 'multi');
    // 先以本进程建立账本（max=8）。
    RealCallGate.open({ runtime: 'claude', model: 'deepseek-flash', maxStartTurns: 8, budgetLabel: 'cross-proc', storeDir });
    const run = (label: string): { acquired: number; rejected: number } => {
      const r = spawnSync(process.execPath, ['--experimental-strip-types', join('tests', 'fixtures', 'realCallGateRunner.ts'), storeDir, label, '6'], {
        encoding: 'utf8', timeout: 60_000, cwd: process.cwd(),
      });
      expect(r.status).toBe(0);
      const line = r.stdout.trim().split('\n').pop()!;
      return JSON.parse(line) as { acquired: number; rejected: number };
    };
    const a = run('proc-a');
    const b = run('proc-b');
    expect(a.acquired + b.acquired).toBe(8); // 总额不被任何进程重新获得
    expect(a.acquired + a.rejected).toBe(6); // 每次尝试二值落账（成功或被拒，不丢失）
    expect(b.acquired + b.rejected).toBe(6);
    const s = RealCallGate.open({ runtime: 'claude', model: 'deepseek-flash', maxStartTurns: 8, budgetLabel: 'cross-proc', storeDir }).summary();
    expect(s.acquired).toBe(8);
    expect(s.acquired + s.rejected).toBeGreaterThanOrEqual(12);
  }, 120_000);
});
