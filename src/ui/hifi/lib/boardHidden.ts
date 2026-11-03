/**
 * 看板「归档」的隐藏集合（R172 用户第 2 项：界面文案统一叫「归档」，机制不变）。
 *
 * 语义：归档**只影响看板卡片的显示**——不删除任务、不修改任务状态、不调用任何写命令；
 * 任务本身保留，仍可在原对话串打开。页面上的「撤销」只回退最近一次归档操作涉及的
 * 卡片（内存记录，刷新/重开即无撤销入口），不提供「恢复全部」。
 *
 * 存储：localStorage 键 `zs.board.hidden.v1`，结构 `{ v: 1, items: { [taskId]: at } }`，
 * `at` 是归档时间（毫秒），用于超出上限时保留最近归档的若干项。
 * 损坏数据/超长内容/不可写的本地存储一律按空集兜底，绝不让看板因为本地数据打不开。
 */
const STORAGE_KEY = 'zs.board.hidden.v1';
const EVENT_NAME = 'zs-board-hidden';
/** 单条任务 ID 通常只有几十字节；5000 条已远超正常使用量，超出按最近时间裁剪。 */
const MAX_ITEMS = 5000;
/** 读取上限：超过直接当作损坏数据，避免解析异常大的字符串。 */
const MAX_RAW_LENGTH = 1024 * 1024;

type HiddenItems = Record<string, number>;

let items: HiddenItems = {};
let loaded = false;

function sanitize(value: unknown): HiddenItems {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: HiddenItems = {};
  let count = 0;
  for (const [taskId, at] of Object.entries(value as Record<string, unknown>)) {
    if (taskId === '' || typeof at !== 'number' || !Number.isFinite(at)) continue;
    out[taskId] = at;
    count += 1;
    if (count >= MAX_ITEMS) break;
  }
  return out;
}

function load(): void {
  if (loaded) return;
  loaded = true;
  items = {};
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (raw == null || raw === '') return;
    if (raw.length > MAX_RAW_LENGTH) return;
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object') return;
    const record = parsed as { v?: unknown; items?: unknown };
    if (record.v !== 1) return;
    items = sanitize(record.items);
  } catch {
    items = {};
  }
}

function emit(): void {
  try {
    window.dispatchEvent(new CustomEvent(EVENT_NAME));
  } catch {
    // 没有 window 的环境（例如测试里直接导入模块）不影响内存状态的正确性。
  }
}

function persist(): void {
  const entries = Object.entries(items);
  if (entries.length > MAX_ITEMS) {
    items = Object.fromEntries(
      entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_ITEMS),
    );
  }
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ v: 1, items }));
  } catch {
    // 本地存储不可写（隐私模式/配额满）：本次打开期间仍在内存中生效，刷新后恢复显示。
  }
  emit();
}

/** 已归档（从看板隐藏）的任务 ID 集合（只读快照）。 */
export function hiddenTaskIds(): Set<string> {
  load();
  return new Set(Object.keys(items));
}

/** 归档一张看板卡片（只隐藏卡片，不删任务）。 */
export function hideTask(taskId: string): void {
  hideTasks([taskId]);
}

/** 批量归档看板卡片（归档本项目 / 归档全部用，一次写入、一次通知）。 */
export function hideTasks(taskIds: readonly string[]): void {
  load();
  const at = Date.now();
  let changed = false;
  for (const taskId of taskIds) {
    if (taskId === '') continue;
    items[taskId] = at;
    changed = true;
  }
  if (changed) persist();
}

/** 撤销归档：把这些任务移出隐藏集合（单次写入+一次通知），卡片重新出现在看板。 */
export function unhideTasks(taskIds: readonly string[]): void {
  load();
  let changed = false;
  for (const taskId of taskIds) {
    if (taskId === '') continue;
    if (Object.prototype.hasOwnProperty.call(items, taskId)) {
      delete items[taskId];
      changed = true;
    }
  }
  if (changed) persist();
}

/**
 * 监听隐藏集合变化（同窗口 CustomEvent + 其它标签页的 storage 事件）。
 * 返回取消订阅函数。
 */
export function subscribe(listener: () => void): () => void {
  const onLocal = () => listener();
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key != null) return;
    // 其它标签页改写了存储：下次读取从存储重建。
    loaded = false;
    listener();
  };
  window.addEventListener(EVENT_NAME, onLocal);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT_NAME, onLocal);
    window.removeEventListener('storage', onStorage);
  };
}
