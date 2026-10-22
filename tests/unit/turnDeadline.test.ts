import { describe, expect, it } from 'vitest';
import { turnDeadlineFromConfig } from '../../src/daemon/turnDeadline.ts';

describe('R99 explicit turn deadline configuration', () => {
  it('missing/empty/zero disable the implicit hard deadline', () => {
    expect(turnDeadlineFromConfig(undefined)).toBeNull();
    expect(turnDeadlineFromConfig('')).toBeNull();
    expect(turnDeadlineFromConfig('  ')).toBeNull();
    expect(turnDeadlineFromConfig('0')).toBeNull();
  });

  it('only an explicit positive safe integer enables a hard deadline', () => {
    expect(turnDeadlineFromConfig('300000')).toBe(300_000);
    expect(turnDeadlineFromConfig('1')).toBe(1);
  });

  it('negative, fractional or non-numeric values fail instead of silently coercing', () => {
    for (const raw of ['-1', '1.5', 'nope', 'Infinity']) {
      expect(() => turnDeadlineFromConfig(raw)).toThrow();
    }
  });
});
