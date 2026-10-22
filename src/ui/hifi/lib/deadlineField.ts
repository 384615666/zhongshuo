export function deadlineSecondsText(value: number | null): string {
  if (value == null) return '';
  return String(value / 1000);
}

export function parseDeadlineSeconds(raw: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const text = raw.trim();
  if (text === '') return { ok: true, value: null };
  const seconds = Number(text);
  const value = seconds * 1000;
  if (!Number.isFinite(seconds) || !Number.isSafeInteger(value) || value < 0 || value > 86_400_000 || (value > 0 && value < 10_000)) {
    return { ok: false, error: '留空表示继承；0 表示关闭；自定义须为至少 10 秒、最多 24 小时的时间' };
  }
  return { ok: true, value: value === 0 ? 0 : value };
}
