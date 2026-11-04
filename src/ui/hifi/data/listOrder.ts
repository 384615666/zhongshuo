/**
 * R183 侧栏「项目 / 房间」的本地显示顺序（用户第 1 项：可上下拖动调换位置）。
 *
 * 边界：
 *  - 这是**本人本客户端**的排列偏好，不是项目/房间数据：不写 daemon、不改 created_at、
 *    不改变任何命令的语义；换机器或清 localStorage 只是回到默认顺序。
 *  - 只持久化 ID 数组；读取时校验类型/去重/长度上限，残留的已删除 ID 自然失效（应用顺序时
 *    只按当前真实 ID 列表排，多余的 ID 被忽略）。
 *  - 顺序语义：保存过的顺序优先；未出现过的 ID（新项目/新房间）追加在末尾，不插队。
 *  - 变更通过 `zs-nav-list-order` 事件通知（侧栏 / 成员管理 / 任务看板的项目卡列一起重排）。
 */
import { useEffect, useState } from 'react';

export const LIST_ORDER_KEY = 'zhongshuo.nav.listOrder.v1';
export const LIST_ORDER_EVENT = 'zs-nav-list-order';

const MAX_PROJECT_IDS = 500;
const MAX_ROOM_PROJECTS = 100;
const MAX_ROOM_IDS = 500;
const MAX_STORAGE_BYTES = 64 * 1024;

export interface ListOrder {
  version: 1;
  projects: string[];
  rooms: Record<string, string[]>;
}

const EMPTY: ListOrder = { version: 1, projects: [], rooms: {} };

function sanitizeIds(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 200) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    if (seen.size >= max) break;
  }
  return [...seen];
}

/** 读取顺序偏好（损坏/无 localStorage 一律回退空顺序，不抛错、不阻塞界面）。 */
export function loadListOrder(): ListOrder {
  try {
    const raw = window.localStorage?.getItem(LIST_ORDER_KEY);
    if (raw == null || raw.length > MAX_STORAGE_BYTES) return EMPTY;
    const parsed = JSON.parse(raw) as { version?: unknown; projects?: unknown; rooms?: unknown };
    if (parsed == null || typeof parsed !== 'object' || parsed.version !== 1) return EMPTY;
    const rooms: Record<string, string[]> = {};
    if (parsed.rooms != null && typeof parsed.rooms === 'object' && !Array.isArray(parsed.rooms)) {
      for (const [projectId, ids] of Object.entries(parsed.rooms as Record<string, unknown>).slice(0, MAX_ROOM_PROJECTS)) {
        if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 200) continue;
        const clean = sanitizeIds(ids, MAX_ROOM_IDS);
        if (clean.length > 0) rooms[projectId] = clean;
      }
    }
    return { version: 1, projects: sanitizeIds(parsed.projects, MAX_PROJECT_IDS), rooms };
  } catch {
    return EMPTY;
  }
}

function persist(order: ListOrder): boolean {
  try {
    const bounded: ListOrder = { version: 1, projects: order.projects.slice(0, MAX_PROJECT_IDS), rooms: {} };
    for (const [projectId, ids] of Object.entries(order.rooms).slice(0, MAX_ROOM_PROJECTS)) {
      const clean = ids.slice(0, MAX_ROOM_IDS);
      if (clean.length > 0) bounded.rooms[projectId] = clean;
    }
    const raw = JSON.stringify(bounded);
    if (raw.length > MAX_STORAGE_BYTES) return false;
    window.localStorage?.setItem(LIST_ORDER_KEY, raw);
    window.dispatchEvent(new Event(LIST_ORDER_EVENT));
    return true;
  } catch {
    // 隐私模式 / 配额不足：本次会话内的拖动结果仍由调用方按返回值使用，不打断使用。
    return false;
  }
}

/** 按保存顺序重排：已知 ID 依偏好顺序在前，未记录的 ID 按原顺序追加。 */
export function orderIdsByIds(ids: string[], preferred: string[]): string[] {
  if (preferred.length === 0 || ids.length === 0) return [...ids];
  const rank = new Map<string, number>();
  preferred.forEach((id, index) => { if (!rank.has(id)) rank.set(id, index); });
  const known: string[] = [];
  const unknown: string[] = [];
  for (const id of ids) (rank.has(id) ? known : unknown).push(id);
  known.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
  return [...known, ...unknown];
}

export function orderProjectIds(ids: string[]): string[] {
  return orderIdsByIds(ids, loadListOrder().projects);
}

export function orderRoomIds(projectId: string, ids: string[]): string[] {
  return orderIdsByIds(ids, loadListOrder().rooms[projectId] ?? []);
}

/** 把 fromId 插到 toId 的前/后，返回新数组；ID 缺失或相同时返回 null（不伪造顺序）。 */
export function moveId(ids: string[], fromId: string, toId: string, place: 'before' | 'after'): string[] | null {
  if (fromId === toId) return null;
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from < 0 || to < 0) return null;
  const next = [...ids];
  next.splice(from, 1);
  const target = next.indexOf(toId);
  if (target < 0) return null;
  next.splice(place === 'before' ? target : target + 1, 0, fromId);
  return next;
}

/** 拖动后保存完整显示顺序（显示列表已是「偏好顺序 + 新项追加」的真值，直接落盘即可）。 */
export function setProjectOrder(ids: string[]): string[] {
  const next = sanitizeIds(ids, MAX_PROJECT_IDS);
  const current = loadListOrder();
  persist({ version: 1, projects: next, rooms: current.rooms });
  return next;
}

export function setRoomOrder(projectId: string, ids: string[]): string[] {
  const clean = sanitizeIds(ids, MAX_ROOM_IDS);
  const current = loadListOrder();
  const rooms = { ...current.rooms };
  if (clean.length > 0) rooms[projectId] = clean;
  else delete rooms[projectId];
  persist({ version: 1, projects: current.projects, rooms });
  return clean;
}

/** 拖动一个项目：只改本地显示顺序，返回新的显示顺序（失败返回原数组）。 */
export function moveProjectOrder(displayedIds: string[], fromId: string, toId: string, place: 'before' | 'after'): string[] {
  const moved = moveId(displayedIds, fromId, toId, place);
  if (moved == null) return displayedIds;
  setProjectOrder(moved);
  return moved;
}

export function moveRoomOrder(projectId: string, displayedIds: string[], fromId: string, toId: string, place: 'before' | 'after'): string[] {
  const moved = moveId(displayedIds, fromId, toId, place);
  if (moved == null) return displayedIds;
  setRoomOrder(projectId, moved);
  return moved;
}

/**
 * 置顶项目仍走正式 navigation 偏好；为保持「置顶=排到最前」的既有语义，
 * 置顶时同步把该项目挪到本地顺序的最前面（取消置顶不动位置）。
 */
export function promoteProjectOrder(projectId: string): void {
  const current = loadListOrder();
  if (current.projects[0] === projectId) return;
  persist({ version: 1, projects: [projectId, ...current.projects.filter((id) => id !== projectId)], rooms: current.rooms });
}

export function subscribeListOrder(listener: () => void): () => void {
  window.addEventListener(LIST_ORDER_EVENT, listener);
  return () => window.removeEventListener(LIST_ORDER_EVENT, listener);
}

/** React 侧订阅：拖动/置顶后让列表重排（事件在保存成功或同标签页更新时触发）。 */
export function useListOrderVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => subscribeListOrder(() => setVersion((v) => v + 1)), []);
  return version;
}
