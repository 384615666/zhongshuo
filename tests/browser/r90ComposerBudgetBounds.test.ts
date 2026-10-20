import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('R90 composer deliberation budget bounds', () => {
  it('uses the revision-aware default for two members and requires roster+1 for three members', async () => {
    vi.stubGlobal('window', { setTimeout: (fn: () => void) => { fn(); return 0; } });
    const [{ deliberationBudgetBounds, isValidDeliberationBudget }, { defaultDeliberationMaxTurns }] = await Promise.all([
      import('../../src/ui/hifi/components/Composer.tsx'),
      import('../../src/ui/hifi/loader.ts'),
    ]);
    expect(defaultDeliberationMaxTurns(2)).toBe(17);
    expect(deliberationBudgetBounds(['m1', 'm2'], ['m1', 'm2', 'm3'])).toEqual({
      rosterSize: 2, minimum: 3, maximum: 500,
    });
    expect(deliberationBudgetBounds(['m1', 'm2', 'm3'], ['m1', 'm2', 'm3'])).toEqual({
      rosterSize: 3, minimum: 4, maximum: 500,
    });
    expect(deliberationBudgetBounds(['all'], ['m1', 'm2', 'm3']).minimum).toBe(4);
    expect(isValidDeliberationBudget(3, ['m1', 'm2', 'm3'], ['m1', 'm2', 'm3'])).toBe(false);
    expect(isValidDeliberationBudget(4, ['m1', 'm2', 'm3'], ['m1', 'm2', 'm3'])).toBe(true);
  });
});
