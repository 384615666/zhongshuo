import { describe, expect, it } from 'vitest';
import { coordinationCallAvailable, validateCoordinationPlan } from '../../src/contracts/coordination.ts';

const step = (key: string, memberId = 'a', dependsOn: string[] = []) => ({ key, memberId, dependsOn, title: key, objective: '真实工作', role: 'analysis' });
describe('R86 authoritative collaboration plan', () => {
  it('accepts independent identities and an explicit dependency chain', () => {
    const plan = { summary: '实现后独立评审', steps: [step('build'), step('review', 'b', ['build'])] };
    expect(validateCoordinationPlan(plan, ['a', 'b'])).toEqual(plan);
  });
  it('rejects unknown and cross-project member identities regardless of display names', () => {
    expect(() => validateCoordinationPlan({ summary: 'x', steps: [step('work', 'other-project')] }, ['a'])).toThrow('名单');
  });
  it('rejects duplicate nodes, missing dependencies, self loops and longer cycles', () => {
    for (const steps of [[step('a'), step('a')], [step('a', 'a', ['missing'])], [step('a', 'a', ['a'])], [step('a', 'a', ['b']), step('b', 'b', ['a'])]]) {
      expect(() => validateCoordinationPlan({ summary: 'x', steps }, ['a', 'b'])).toThrow();
    }
  });
  it('rejects empty work and unbounded plans', () => {
    for (const steps of [[], Array.from({ length: 9 }, (_, i) => step(`a${i}`))]) expect(() => validateCoordinationPlan({ summary: 'x', steps }, ['a'])).toThrow();
  });
  it('reserves integration calls and counts unknown/reserved calls conservatively', () => {
    expect(coordinationCallAvailable(21, 'work')).toBe(true);
    expect(coordinationCallAvailable(22, 'work')).toBe(false);
    expect(coordinationCallAvailable(22, 'integration')).toBe(true);
    expect(coordinationCallAvailable(24, 'integration')).toBe(false);
    expect(coordinationCallAvailable(-1, 'work')).toBe(false);
  });
});
