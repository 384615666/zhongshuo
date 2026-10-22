import { describe, expect, it } from 'vitest';
import { deadlineSecondsText, parseDeadlineSeconds } from '../../src/ui/hifi/lib/deadlineField.ts';

describe('R99 deadline settings field', () => {
  it('preserves a legal ten-second value without rounding it to disabled', () => {
    expect(deadlineSecondsText(10_000)).toBe('10');
    expect(parseDeadlineSeconds('10')).toEqual({ ok: true, value: 10_000 });
    expect(deadlineSecondsText(12_345)).toBe('12.345');
    expect(parseDeadlineSeconds('12.345')).toEqual({ ok: true, value: 12_345 });
  });

  it('distinguishes inherit from explicit disabled', () => {
    expect(deadlineSecondsText(null)).toBe('');
    expect(parseDeadlineSeconds('')).toEqual({ ok: true, value: null });
    expect(deadlineSecondsText(0)).toBe('0');
    expect(parseDeadlineSeconds('0')).toEqual({ ok: true, value: 0 });
  });
});
