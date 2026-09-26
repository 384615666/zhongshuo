/**
 * 免打扰时段的「此刻是否生效」判定。
 *
 * 为什么要单独一个模块：免打扰开关是**定时规则**，不是即时状态 ——
 * `enabled=true` 只说明"这条规则开着"，不代表此刻正在免打扰。原实现把两者当成一件事，
 * 于是 18:27 设置 22:00—08:00 也会显示"当前正在免打扰"（用户实测复现）。
 *
 * 口径：
 *  - 未启用 → false；
 *  - 跨零点（from > to，如 22:00 → 08:00）按两段判断：`now >= from` 或 `now < to`；
 *  - 同一天（from < to）：`from <= now < to`；
 *  - from === to：视为**全天**（界面上也这么写，避免"设了却不生效"的误解）；
 *  - 时间串解析不了 → false（不猜，宁愿不静音）。
 */
export interface DndRule {
  enabled: boolean;
  /** HH:MM */
  from: string;
  /** HH:MM */
  to: string;
}

/** `HH:MM` → 当天第几分钟；非法返回 null */
export function minuteOfDay(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 免打扰此刻是否生效（`now` 可注入，便于测试） */
export function dndActiveNow(rule: DndRule, now: Date = new Date()): boolean {
  if (!rule.enabled) return false;
  const from = minuteOfDay(rule.from);
  const to = minuteOfDay(rule.to);
  if (from === null || to === null) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (from === to) return true; // 全天
  if (from < to) return cur >= from && cur < to;
  // 跨零点：22:00 → 08:00
  return cur >= from || cur < to;
}
