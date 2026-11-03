/**
 * 看板「从看板移除」的隐藏集合。
 *
 * 语义（用户反馈第 4 项）：移除/清空**只影响看板卡片的显示**——不删除任务、
 * 不修改任务状态、不调用任何写命令；任务仍可在原对话串打开。
 *
 * 存储：localStorage 键 `zs.board.hidden.v1`，结构 `{ v: 1, items: { [taskId]: at } }`，
 * `at` 是移除时间（毫秒），用于超出上限时保留最近移除的若干项。
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

/** 被隐藏的任务 ID 集合（只读快照）。 */
export function hiddenTaskIds(): Set<string> {
  load();
  return new Set(Object.keys(items));
}

/** 隐藏项总数。 */
export function hiddenCount(): number {
  load();
  return Object.keys(items).length;
}

/** 从看板移除一张卡片（只隐藏，不删任务）。 */
export function hideTask(taskId: string): void {
  hideTasks([taskId]);
}

/** 批量从看板移除（清空本项目 / 清空全部卡片用，一次写入、一次通知）。 */
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

/** 恢复显示全部已移除的卡片。 */
export function restoreAll(): void {
  load();
  items = {};
  persist();
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
