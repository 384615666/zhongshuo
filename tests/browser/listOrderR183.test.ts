/**
 * R183 用户第 1 项：侧栏「项目 / 房间」本地拖动顺序（src/ui/hifi/data/listOrder.ts）的单元测试。
 *
 * node 环境（vitest 默认），自己 stub globalThis.window.localStorage：
 *  - 这里只测纯函数与 localStorage 持久化边界，不渲染 React（useListOrderVersion 由截图场景覆盖）；
 *  - 覆盖「坏 JSON / 超长内容 / 存储读写抛错 / >500 截断 / 去重 / 已删除 ID 不伪造顺序」等边界；
 *  - 不接触隔离夹具以外的任何数据，不启动 daemon。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LIST_ORDER_KEY,
  loadListOrder,
  moveId,
  moveProjectOrder,
  moveRoomOrder,
  orderIdsByIds,
  orderProjectIds,
  orderRoomIds,
  promoteProjectOrder,
  setProjectOrder,
  setRoomOrder,
} from '../../src/ui/hifi/data/listOrder';

const originalWindow = (globalThis as { window?: unknown }).window;

/** 与 ListOrder 结构一致的期望空值（结构相等比较；模块内部的 EMPTY 是同一形状）。 */
const EMPTY = { version: 1, projects: [], rooms: {} };

let storage: Map<string, string>;
let events: number;
let throwOnRead: boolean;
let throwOnWrite: boolean;

function installWindow(): void {
  const fake = {
    get localStorage() {
      return {
        getItem(key: string): string | null {
          if (throwOnRead) throw new Error('localStorage 读取被拒绝（模拟隐私模式）');
          return storage.get(key) ?? null;
        },
        setItem(key: string, value: string): void {
          if (throwOnWrite) throw new Error('QuotaExceededError（模拟配额不足）');
          storage.set(key, String(value));
        },
        removeItem(key: string): void {
          storage.delete(key);
        },
      };
    },
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    dispatchEvent: (): boolean => {
      events += 1;
      return true;
    },
  };
  (globalThis as unknown as { window: unknown }).window = fake;
}

beforeEach(() => {
  storage = new Map();
  events = 0;
  throwOnRead = false;
  throwOnWrite = false;
  installWindow();
});

afterEach(() => {
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
});

/** 当前落盘内容（没有写入时返回 null）。 */
function persisted(): { version: number; projects: string[]; rooms: Record<string, string[]> } | null {
  const raw = storage.get(LIST_ORDER_KEY);
  return raw == null ? null : (JSON.parse(raw) as { version: number; projects: string[]; rooms: Record<string, string[]> });
}

describe('R183 侧栏项目/房间本地顺序', () => {
  it('orderIdsByIds：偏好顺序优先、未记录 ID 按原顺序追加、不伪造已删除/未知 ID', () => {
    expect(orderIdsByIds(['b', 'a', 'c'], ['a', 'b'])).toEqual(['a', 'b', 'c']);
    // 偏好里存在但当前不存在的 ID（已删除项目/房间）被忽略；当前列表里的未记录 ID 原样追加在末尾。
    expect(orderIdsByIds(['a', 'c', 'b'], ['c', 'gone', 'zzz'])).toEqual(['c', 'a', 'b']);
    // 偏好数组里的重复项不会产生重复结果。
    expect(orderIdsByIds(['b', 'a'], ['a', 'a', 'b', 'b'])).toEqual(['a', 'b']);
    expect(orderIdsByIds(['b', 'a'], [])).toEqual(['b', 'a']);
    expect(orderIdsByIds([], ['a'])).toEqual([]);
  });

  it('loadListOrder：无记录/坏 JSON/错误版本/超长内容一律回退空顺序且不抛错', () => {
    expect(loadListOrder()).toEqual(EMPTY);

    storage.set(LIST_ORDER_KEY, '{not json');
    expect(loadListOrder()).toEqual(EMPTY);

    storage.set(LIST_ORDER_KEY, JSON.stringify({ version: 2, projects: ['a'], rooms: { p: ['r'] } }));
    expect(loadListOrder()).toEqual(EMPTY);

    storage.set(LIST_ORDER_KEY, JSON.stringify({ version: 1, projects: 'a', rooms: [] }));
    expect(loadListOrder()).toEqual(EMPTY);

    // 64KB 上限：超长内容不解析（避免卡顿/异常），直接回退。
    storage.set(LIST_ORDER_KEY, JSON.stringify({ version: 1, projects: ['a'], rooms: {} }).padEnd(65537, ' '));
    expect(loadListOrder()).toEqual(EMPTY);
  });

  it('loadListOrder：逐项清洗（去重/丢弃空串与超长 ID/非字符串）并限制条数', () => {
    storage.set(
      LIST_ORDER_KEY,
      JSON.stringify({
        version: 1,
        projects: ['a', 'a', '', 42, 'x'.repeat(201), 'b'],
        rooms: { p1: ['r1', 'r1', null, 'r2'], p2: [], bad: 'not-array' },
      }),
    );
    const order = loadListOrder();
    expect(order.projects).toEqual(['a', 'b']);
    expect(order.rooms).toEqual({ p1: ['r1', 'r2'] });
  });

  it('loadListOrder：localStorage 读取抛错时回退空顺序，不让界面装载失败', () => {
    throwOnRead = true;
    expect(loadListOrder()).toEqual(EMPTY);
    expect(() => orderProjectIds(['b', 'a'])).not.toThrow();
    expect(orderProjectIds(['b', 'a'])).toEqual(['b', 'a']);
  });

  it('setProjectOrder：去重后落盘并按 500 上限截断；写入失败不抛错也不清掉旧顺序', () => {
    const before = events;
    expect(setProjectOrder(['a', 'a', 'b'])).toEqual(['a', 'b']);
    expect(persisted()?.projects).toEqual(['a', 'b']);
    expect(events).toBe(before + 1); // 成功保存才广播重排事件

    const many = Array.from({ length: 600 }, (_, index) => `p${index}`);
    expect(setProjectOrder(many)).toHaveLength(500);
    expect(persisted()?.projects).toHaveLength(500);

    // 存储写失败（配额不足/隐私模式）：返回本次会话可用的顺序，旧数据保持、无事件、不抛错。
    const eventsBeforeFailure = events;
    throwOnWrite = true;
    let fallback: string[] = [];
    expect(() => {
      fallback = setProjectOrder(['b', 'a']);
    }).not.toThrow();
    expect(fallback).toEqual(['b', 'a']);
    expect(persisted()?.projects).toHaveLength(500);
    expect(events).toBe(eventsBeforeFailure);
  });

  it('setProjectOrder：超过 64KB 的合法调用不写入（返回本次可用顺序，不抛错）', () => {
    const huge = Array.from({ length: 500 }, (_, index) => 'x'.repeat(196) + String(index).padStart(4, '0'));
    expect(() => setProjectOrder(huge)).not.toThrow();
    expect(persisted()).toBeNull();
  });

  it('setRoomOrder：按项目保存/清除、去重、500 上限，且不影响项目顺序', () => {
    setProjectOrder(['a', 'b']);
    expect(setRoomOrder('p1', ['r1', 'r1', 'r2'])).toEqual(['r1', 'r2']);
    expect(loadListOrder().rooms.p1).toEqual(['r1', 'r2']);
    expect(loadListOrder().projects).toEqual(['a', 'b']);

    // 空数组 = 清掉该项目的房间偏好（回到默认顺序），不写空数组占位。
    expect(setRoomOrder('p1', [])).toEqual([]);
    expect(loadListOrder().rooms.p1).toBeUndefined();

    const many = Array.from({ length: 600 }, (_, index) => `r${index}`);
    expect(setRoomOrder('p2', many)).toHaveLength(500);
    expect(loadListOrder().rooms.p2).toHaveLength(500);
    expect(loadListOrder().projects).toEqual(['a', 'b']);
  });

  it('moveId：before/after 插入正确；from==to、缺失 ID、空列表返回 null；不改原数组', () => {
    const ids = ['a', 'b', 'c'];
    expect(moveId(ids, 'c', 'a', 'before')).toEqual(['c', 'a', 'b']);
    expect(moveId(ids, 'a', 'c', 'after')).toEqual(['b', 'c', 'a']);
    expect(moveId(ids, 'a', 'b', 'after')).toEqual(['b', 'a', 'c']);
    expect(moveId(ids, 'c', 'b', 'before')).toEqual(['a', 'c', 'b']);

    expect(moveId(ids, 'b', 'b', 'before')).toBeNull();
    expect(moveId(ids, 'z', 'a', 'before')).toBeNull();
    expect(moveId(ids, 'a', 'z', 'after')).toBeNull();
    expect(moveId([], 'a', 'b', 'before')).toBeNull();
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('moveProjectOrder/moveRoomOrder：拖到新位置后立即落盘；非法移动保持显示顺序且不写存储', () => {
    expect(moveProjectOrder(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b']);
    expect(loadListOrder().projects).toEqual(['c', 'a', 'b']);

    const before = events;
    expect(moveProjectOrder(['c', 'a', 'b'], 'missing', 'a', 'before')).toEqual(['c', 'a', 'b']);
    expect(loadListOrder().projects).toEqual(['c', 'a', 'b']);
    expect(events).toBe(before); // 无效拖动不广播

    expect(moveRoomOrder('p1', ['r1', 'r2', 'r3'], 'r3', 'r1', 'before')).toEqual(['r3', 'r1', 'r2']);
    expect(loadListOrder().rooms.p1).toEqual(['r3', 'r1', 'r2']);
  });

  it('promoteProjectOrder：置顶项目排到最前、重复置顶稳定、不改房间顺序', () => {
    setProjectOrder(['a', 'b', 'c']);
    setRoomOrder('p1', ['r2', 'r1']);

    promoteProjectOrder('c');
    expect(loadListOrder().projects).toEqual(['c', 'a', 'b']);
    // 再次置顶同一个项目（或已排最前）不重排、不重复。
    promoteProjectOrder('c');
    expect(loadListOrder().projects).toEqual(['c', 'a', 'b']);

    promoteProjectOrder('b');
    expect(loadListOrder().projects).toEqual(['b', 'c', 'a']);
    expect(loadListOrder().rooms.p1).toEqual(['r2', 'r1']);
  });

  it('orderProjectIds/orderRoomIds：应用已保存偏好；无偏好时保持传入顺序', () => {
    expect(orderProjectIds(['b', 'a'])).toEqual(['b', 'a']);
    setProjectOrder(['b', 'a']);
    expect(orderProjectIds(['a', 'b'])).toEqual(['b', 'a']);

    setRoomOrder('p1', ['r2', 'r1']);
    expect(orderRoomIds('p1', ['r1', 'r2', 'r3'])).toEqual(['r2', 'r1', 'r3']);
    expect(orderRoomIds('other', ['r1', 'r2'])).toEqual(['r1', 'r2']);
  });
});
