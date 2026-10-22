/**
 * Explicit turn deadline parsing. Missing/empty and zero disable the hard deadline;
 * only an explicit positive integer enables interruption. Negative/fractional values
 * fail startup instead of being silently coerced.
 */
export function turnDeadlineFromConfig(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('ZS_TURN_DEADLINE_MS 必须是非负整数（0=关闭，正数=毫秒）');
  }
  return value === 0 ? null : value;
}
