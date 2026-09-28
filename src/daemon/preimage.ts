/**
 * 变更前像（pre-image）捕获、内容存储与 diff（DEV-12 主体，2026-09-28 第五轮）。
 *
 * 基础数据模型（三态——「不存在」与「读取失败/未知」必须区分，未知不能推导删除、
 * 新增或安全可撤销）：
 * - present：文件存在且已读取（sha256+size；受管理内容引用=内容寻址存储文件名）；
 * - absent：确认不存在（ENOENT）——新增文件在变更前即此态；
 * - unknown：读取失败/越界/目录项/符号链接越界等——撤销决策对该文件不可自动进行。
 *
 * 内容级前像（§14.2/E15）：可恢复内容存入受管理内容存储（storeDir/<sha256>，内容寻址，
 * 写入后回读核对 hash）；超出大小上限的文件保留 hash 但标记 contentUnavailable——
 * 内容级撤销对该文件不可用，必须提前如实呈现（不得事后才发现无法恢复）。
 *
 * 路径纪律：全部按 root 规范化为 '/' 分隔的相对路径；绝对路径必须在 root 内（真实路径
 * 边界判定，不用裸前缀）；指向 root 外的符号链接/junction 不跟随——记 unknown（§3.3）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { comparisonKey, isSameOrAncestorPath } from '../daemon/directoryIdentity.ts';

export type PathState = 'present' | 'absent' | 'unknown';

export interface PreimageEntry {
  /** 相对 root 的规范化路径（'/' 分隔；不包含盘符/前导分隔）。 */
  path: string;
  state: PathState;
  /** present 时必有；absent/unknown 无。 */
  sha256?: string;
  size?: number;
  /** 受管理内容引用（storeDir 内文件名=sha256）；未存内容（超上限/存储失败）则缺省。 */
  contentRef?: string;
  /** 内容级撤销不可用的原因（超上限等）——提前呈现，不事后失败。 */
  contentUnavailable?: string;
  /** unknown 时的错误摘要。 */
  error?: string;
}

export interface PreimageCapture {
  captureId: string;
  capturedAt: number;
  /** 捕获根（绝对路径，原样记录）。 */
  root: string;
  entries: PreimageEntry[];
}

export interface PreimageDiff {
  added: string[];
  removed: string[];
  modified: string[];
  /** 任一侧 unknown 的路径——不能推导 added/removed/modified，也不可自动撤销。 */
  undeterminable: Array<{ path: string; reason: string }>;
}

export interface CaptureOptions {
  /** 内容存储目录（受管理内容引用的落点）；不传则不存内容（只有 hash 清单）。 */
  storeDir?: string;
  /** 单文件内容存储上限（字节，默认 8MB，env ZS_PREIMAGE_MAX_BYTES）。 */
  maxBytes?: number;
  /** 目录扫描模式下的文件数上限（默认 5000，env ZS_PREIMAGE_MAX_FILES）。 */
  maxFiles?: number;
  now?: number;
}

const DEFAULT_MAX_BYTES = envInt('ZS_PREIMAGE_MAX_BYTES', 8 * 1024 * 1024);
const DEFAULT_MAX_FILES = envInt('ZS_PREIMAGE_MAX_FILES', 5_000);

/** 目录扫描默认排除（.git 的内容基线由 Git 基线承担——ref+porcelain，§14.2）。 */
export const DIRECTORY_SCAN_EXCLUDES = new Set(['.git']);

/** 规范化并校验路径：返回相对 root 的 '/' 分隔路径；越界（.. 逃逸/root 外绝对路径）抛错。 */
export function normalizeWithinRoot(root: string, path: string): string {
  const abs = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rootKey = comparisonKey(resolve(root));
  const absKey = comparisonKey(abs);
  if (absKey !== rootKey && !absKey.startsWith(rootKey + sep)) {
    throw new Error(`路径越出项目边界：${path}（root=${root}）`);
  }
  const rel = abs.slice(resolve(root).length).replaceAll('\\', '/').replace(/^\//, '');
  if (rel.length === 0) throw new Error(`路径即根目录本身（不支持）：${path}`);
  if (rel.split('/').includes('..')) throw new Error(`路径包含 .. 段：${path}`);
  return rel;
}

/** 捕获前像：显式路径列表（调用方圈定变更面）。 */
export function captureFilePreimage(root: string, paths: string[], options: CaptureOptions = {}): PreimageCapture {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = options.now ?? Date.now();
  const entries: PreimageEntry[] = [];
  for (const p of paths) {
    entries.push(captureOne(root, p, options.storeDir, maxBytes));
  }
  return { captureId: `pre_${randomUUID()}`, capturedAt: now, root: resolve(root), entries };
}

/** 目录扫描完整性状态：完整 / 截断（达上限）/ 有失败（readdir/stat 失败——不能称完整）。 */
export interface ScanResult {
  files: string[];
  truncated: boolean;
  /** 读取失败的具体范围（目录级）——受影响子树的基线缺失只能判 unknown，不能推导 absent。 */
  failedDirs: Array<{ dir: string; error: string }>;
  /** 物理路径拒绝（进入前判定：越界 junction/symlink、复合链接环）——不进入即拒绝、零接触。 */
  rejectedEntries: Array<{ entry: string; reason: string }>;
}

/**
 * 目录扫描捕获（非 Git 整目录语义，E15；第五轮修复）：
 * - **进入目录前**先核物理路径：realpath 后必须在 root 真实路径内（junction/symlink 越界
 *   即拒绝并记录——不递归出去后才逐文件拒绝）；复合链接环（同一真实目录二次到达）终止该枝。
 * - readdir/stat 失败**不静默跳过**：记入 failedDirs，完整性状态不再是「完整」——
 *   finalize 据此把受影响路径的基线缺失判 unknown，不推导 absent。
 * - 空目录是合法基线（files 可为空——由调用方按 scopeKind 判定，不因零文件拒绝）。
 */
export function scanDirectoryFiles(root: string, maxFiles = DEFAULT_MAX_FILES): ScanResult {
  const files: string[] = [];
  const failedDirs: ScanResult['failedDirs'] = [];
  const rejectedEntries: ScanResult['rejectedEntries'] = [];
  let truncated = false;
  const rootReal = realpathSync(resolve(root));
  const relOf = (p: string): string => p.slice(resolve(root).length + 1).replaceAll('\\', '/') || '.';
  const visitedRealDirs = new Set<string>([comparisonKey(rootReal)]);
  const walk = (dir: string): void => {
    if (files.length >= maxFiles) { truncated = true; return; }
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      failedDirs.push({ dir: relOf(dir), error: String(error).slice(0, 120) });
      return; // 子树读取失败=完整性破口（如实记录——不称扫描完整）
    }
    for (const name of names) {
      if (DIRECTORY_SCAN_EXCLUDES.has(name)) continue;
      const full = join(dir, name);
      let real: string;
      try {
        real = realpathSync(full);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue; // 扫描窗口内消失：captureOne 重读时按三态判定
        failedDirs.push({ dir: relOf(full), error: `realpath 失败：${String(error).slice(0, 100)}` });
        continue;
      }
      if (!isSameOrAncestorPath(rootReal, real)) {
        rejectedEntries.push({ entry: relOf(full), reason: `symlink/junction 越界（解析至 ${real}）` });
        continue;
      }
      let st;
      try {
        st = statSync(full);
      } catch (error) {
        failedDirs.push({ dir: relOf(full), error: `stat 失败：${String(error).slice(0, 100)}` });
        continue;
      }
      if (st.isDirectory()) {
        const realKey = comparisonKey(real);
        if (visitedRealDirs.has(realKey)) {
          rejectedEntries.push({ entry: relOf(full), reason: `目录环（真实路径已访问：${real}）` });
          continue;
        }
        visitedRealDirs.add(realKey);
        walk(full);
      } else if (st.isFile()) {
        files.push(full);
        if (files.length >= maxFiles) { truncated = true; return; }
      }
    }
  };
  walk(root);
  return { files, truncated, failedDirs, rejectedEntries };
}

function captureOne(root: string, userPath: string, storeDir: string | undefined, maxBytes: number): PreimageEntry {
  let rel: string;
  try {
    rel = normalizeWithinRoot(root, userPath);
  } catch (error) {
    return { path: String(userPath).replaceAll('\\', '/'), state: 'unknown', error: error instanceof Error ? error.message : String(error) };
  }
  const abs = join(resolve(root), rel);
  // 符号链接/边界：目标解析到 root 外 → 不跟随（记 unknown，不读写外部文件）。
  try {
    const real = realpathSync(abs);
    const rootReal = realpathSync(resolve(root));
    if (!isSameOrAncestorPath(rootReal, real)) {
      return { path: rel, state: 'unknown', error: `symlink-escape：解析到项目边界外（${real}）` };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { path: rel, state: 'absent' };
    return { path: rel, state: 'unknown', error: `realpath 失败：${String(error).slice(0, 120)}` };
  }
  let st;
  try {
    st = statSync(abs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { path: rel, state: 'absent' };
    return { path: rel, state: 'unknown', error: `stat 失败：${String(error).slice(0, 120)}` };
  }
  if (!st.isFile()) return { path: rel, state: 'unknown', error: `不是普通文件（${st.isDirectory() ? '目录' : '特殊文件'}）` };
  let content: Buffer;
  try {
    content = readFileSync(abs);
  } catch (error) {
    return { path: rel, state: 'unknown', error: `读取失败：${String(error).slice(0, 120)}` };
  }
  const sha256 = createHash('sha256').update(content).digest('hex');
  const entry: PreimageEntry = { path: rel, state: 'present', sha256, size: content.length };
  if (content.length > maxBytes) {
    entry.contentUnavailable = `超出内容存储上限（${content.length} > ${maxBytes} 字节）——该文件不可内容级撤销（§14.2）`;
    return entry;
  }
  if (storeDir != null) {
    try {
      const ref = storeContent(storeDir, sha256, content);
      entry.contentRef = ref;
    } catch (error) {
      entry.contentUnavailable = `内容存储失败：${String(error).slice(0, 120)}`;
    }
  }
  return entry;
}

/** 内容寻址存储：storeDir/<sha256>；已存在则直接复用；写入后回读核对 hash。 */
function storeContent(storeDir: string, sha256: string, content: Buffer): string {
  mkdirSync(storeDir, { recursive: true });
  const target = join(storeDir, sha256);
  if (statSync(target, { throwIfNoEntry: false }) == null) {
    const tmp = `${target}.tmp_${randomUUID().slice(0, 8)}`;
    writeFileSync(tmp, content);
    const written = readFileSync(tmp); // 回读核对（写入路径上的诚实性——写坏不冒充已存）
    const writtenHash = createHash('sha256').update(written).digest('hex');
    if (writtenHash !== sha256) {
      rmSync(tmp, { force: true });
      throw new Error(`内容写入核对失败（期望 ${sha256}，实际 ${writtenHash}）`);
    }
    // 原子落位：同目录 rename（Windows 上目标已存在时 rename 覆盖——内容寻址同 hash 等价）。
    renameSync(tmp, target);
  }
  return sha256;
}

/** diff：before→after。任一侧 unknown → undeterminable（不推导增删改）。 */
export function diffPreimages(before: PreimageCapture, after: PreimageCapture): PreimageDiff {
  const b = new Map(before.entries.map((e) => [e.path, e]));
  const a = new Map(after.entries.map((e) => [e.path, e]));
  const diff: PreimageDiff = { added: [], removed: [], modified: [], undeterminable: [] };
  for (const [path, afterEntry] of a) {
    const beforeEntry = b.get(path);
    if (beforeEntry == null) continue; // before 未收录（不在捕获面）——不判定（调用方保证两侧同面）
    if (beforeEntry.state === 'unknown' || afterEntry.state === 'unknown') {
      diff.undeterminable.push({ path, reason: `状态未知（before=${beforeEntry.state}，after=${afterEntry.state}）` });
      continue;
    }
    if (beforeEntry.state === 'absent' && afterEntry.state === 'present') diff.added.push(path);
    else if (beforeEntry.state === 'present' && afterEntry.state === 'absent') diff.removed.push(path);
    else if (beforeEntry.state === 'present' && afterEntry.state === 'present') {
      if (beforeEntry.sha256 !== afterEntry.sha256) diff.modified.push(path);
    }
    // absent→absent：无变化。
  }
  for (const [path, beforeEntry] of b) {
    if (!a.has(path)) diff.undeterminable.push({ path, reason: 'after 捕获缺失该路径（捕获面不一致）' });
    else if (beforeEntry.state === 'unknown') {
      // 已在上面循环覆盖（unknown 双向判定）——此处仅捕获面一致性兜底。
    }
  }
  return diff;
}

/** 从内容存储读取受管理内容并核对 hash（撤销前必须核对——存储损坏不得静默恢复）。 */
export function readStoredContent(storeDir: string, contentRef: string): { ok: true; content: Buffer } | { ok: false; error: string } {
  try {
    const content = readFileSync(join(storeDir, contentRef));
    const hash = createHash('sha256').update(content).digest('hex');
    if (hash !== contentRef) return { ok: false, error: `内容存储核对失败（期望 ${contentRef}，实际 ${hash}）` };
    return { ok: true, content };
  } catch (error) {
    return { ok: false, error: `内容读取失败：${String(error).slice(0, 120)}` };
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.length === 0) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
