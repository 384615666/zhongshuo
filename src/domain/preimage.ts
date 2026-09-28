/**
 * DEV-12 起步（2026-09-28 第四轮）：变更前像（pre-image）捕获与 diff——基线/非破坏撤销的基础。
 *
 * 边界（本轮最小实现，均为纯函数 + 显式路径列表，不扫描任意目录、不触碰用户真实项目——
 * 验证一律在临时 fixture）：
 * - captureFilePreimage：按显式文件路径列表读取内容并记 sha256（前像=变更前的事实快照）；
 * - diffPreimages：对比两组前像 → added/removed/modified（内容 hash 变化=modified）；
 * - 撤销执行（用前像还原）、Git 基线（非 Git 目录的 etc/ctimes 快照）不在本轮——
 *   撤销需写入编排与安全边界（原子替换/失败回滚），随 DEV-12 主体实施。
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export interface FilePreimageEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface PreimageCapture {
  capturedAt: number;
  entries: FilePreimageEntry[];
  /** 读取失败项（如实记录，不静默跳过——撤销决策需要知道前像不完整）。 */
  unreadable: Array<{ path: string; error: string }>;
}

export interface PreimageDiff {
  added: string[];
  removed: string[];
  modified: string[];
}

/** 捕获前像：显式路径列表（调用方圈定变更面）；每文件读全文+hash。 */
export function captureFilePreimage(paths: string[], now = Date.now()): PreimageCapture {
  const entries: FilePreimageEntry[] = [];
  const unreadable: Array<{ path: string; error: string }> = [];
  for (const p of paths) {
    try {
      const content = readFileSync(p);
      entries.push({ path: p, sha256: createHash('sha256').update(content).digest('hex'), size: content.length });
    } catch (error) {
      unreadable.push({ path: p, error: String(error).slice(0, 120) });
    }
  }
  return { capturedAt: now, entries, unreadable };
}

/** diff：before→after（added=新出现；removed=消失；modified=hash 变化）。 */
export function diffPreimages(before: PreimageCapture, after: PreimageCapture): PreimageDiff {
  const b = new Map(before.entries.map((e) => [e.path, e.sha256]));
  const a = new Map(after.entries.map((e) => [e.path, e.sha256]));
  const added: string[] = [];
  const modified: string[] = [];
  for (const [path, hash] of a) {
    if (!b.has(path)) added.push(path);
    else if (b.get(path) !== hash) modified.push(path);
  }
  const removed = [...b.keys()].filter((p) => !a.has(p));
  return { added, removed, modified };
}
