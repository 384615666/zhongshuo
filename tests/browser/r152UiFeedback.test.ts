import { describe, expect, it } from 'vitest';

describe('R152 titlebar, image sending and settings layout', () => {
  it('keeps visible theme contrast, settings alignment and sends images without an extra gate', async () => {
    const helper = await import(new URL('./helpers/r152UiFeedback.cjs', import.meta.url).href) as {
      default: { runVerifier(): Promise<{ ok: boolean; realBusinessCalls: number; checks: Array<{ name: string; ok: boolean; detail?: unknown }>; evidence: string }> };
    };
    const result = await helper.default.runVerifier();
    expect(result.checks.filter(check => !check.ok), result.evidence).toEqual([]);
    expect(result.realBusinessCalls).toBe(0);
    expect(result.ok).toBe(true);
  }, 70_000);
});
