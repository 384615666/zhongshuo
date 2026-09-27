/**
 * 分析基线清单（§6.3 最小实现 + §14.2 的 Git ref 记录）。
 * - 排除 VCS 内部、依赖缓存、构建目录、常见凭据文件；大文件/二进制/符号链接记入排除清单。
 * - 不跟随符号链接目标；不执行任何安装脚本；清单含每文件 sha256。
 * - Git 目录额外记录 HEAD（读 .git 文件实现，不依赖 git 二进制）；工作区内容前像归 DEV-12。
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { lstatSync } from 'node:fs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { domainOk } from '../contracts/errors.ts';
import type { DomainResult } from '../contracts/errors.ts';

export interface BaselineOptions {
  perFileMaxBytes?: number;
  totalMaxBytes?: number;
  maxEntries?: number;
}

const EXCLUDED_DIRS = new Set([
  '.git', '.hg', '.svn', // VCS 内部
  'node_modules', '.pnpm-store', '.venv', 'venv', '__pycache__', // 依赖缓存
  'dist', 'build', 'out', 'target', '.next', '.turbo', '.cache', // 构建产物
  '.zhongshuo', // 本产品导出目录（§12.1）
]);

const EXCLUDED_FILE_PATTERNS: Array<(name: string) => boolean> = [
  (n) => n === '.env' || n.startsWith('.env.'),
  (n) => n.endsWith('.pem') || n.endsWith('.key'),
  (n) => n === 'credentials.json' || n === 'id_rsa' || n === 'id_ed25519',
  (n) => n.endsWith('.p12') || n.endsWith('.pfx'),
];

export interface BaselineManifest {
  schemaVersion: 1;
  rootCanonicalPath: string;
  kind: 'plain' | 'git';
  git?: { head: string | null; branch: string | null };
  entries: Array<{ path: string; size: number; sha256: string }>;
  excluded: Array<{ path: string; reason: 'excluded_dir' | 'credential_like' | 'oversize_file' | 'symlink' | 'binary' | 'total_cap' | 'max_entries' }>;
  totals: { includedFiles: number; includedBytes: number; excludedCount: number };
  createdAt: number;
}

/** 读取 Git HEAD（不依赖 git 二进制；worktree/submodule 的 .git 文件形态标记 unknown）。 */
function readGitHead(root: string): { head: string | null; branch: string | null } {
  try {
    const dotGit = join(root, '.git');
    const st = lstatSync(dotGit);
    if (!st.isDirectory()) return { head: null, branch: null }; // worktree 文件形态：DEV-12 扩展
    const headText = readFileSync(join(dotGit, 'HEAD'), 'utf8').trim();
    if (!headText.startsWith('ref: ')) return { head: headText, branch: null }; // detached
    const ref = headText.slice(5);
    const refPath = join(dotGit, ref);
    try {
      return { head: readFileSync(refPath, 'utf8').trim(), branch: ref.replace('refs/heads/', '') };
    } catch {
      // packed-refs 兜底
      const packed = readFileSync(join(dotGit, 'packed-refs'), 'utf8');
      const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
      return { head: line?.split(' ')[0] ?? null, branch: ref.replace('refs/heads/', '') };
    }
  } catch {
    return { head: null, branch: null };
  }
}

const BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico',
  '.zip', '.gz', '.tar', '.7z', '.rar', '.pdf', '.docx', '.xlsx', '.pptx', '.woff',
  '.woff2', '.ttf', '.mp4', '.mp3', '.wav', '.sqlite', '.db',
]);

/** 构建基线清单（真实遍历 + 内容 hash；不改写任何源文件）。 */
export function buildBaselineManifest(
  rootCanonicalPath: string,
  options: BaselineOptions = {},
  now = Date.now(),
): DomainResult<BaselineManifest> {
  const perFileMax = options.perFileMaxBytes ?? 5 * 1024 * 1024;
  const totalMax = options.totalMaxBytes ?? 200 * 1024 * 1024;
  const maxEntries = options.maxEntries ?? 20_000;

  const isGit = (() => {
    try {
      return lstatSync(join(rootCanonicalPath, '.git')).isDirectory();
    } catch {
      return false;
    }
  })();
  const manifest: BaselineManifest = {
    schemaVersion: 1,
    rootCanonicalPath,
    kind: isGit ? 'git' : 'plain',
    ...(isGit ? { git: readGitHead(rootCanonicalPath) } : {}),
    entries: [],
    excluded: [],
    totals: { includedFiles: 0, includedBytes: 0, excludedCount: 0 },
    createdAt: now,
  };

  const relNorm = (abs: string): string => relative(rootCanonicalPath, abs).replaceAll('\\', '/');
  const walk = (dir: string): void => {
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      manifest.excluded.push({ path: relNorm(dir), reason: 'excluded_dir' });
      return;
    }
    for (const dirent of dirents) {
      const abs = join(dir, dirent.name);
      const rel = relNorm(abs);
      if (dirent.isDirectory()) {
        if (EXCLUDED_DIRS.has(dirent.name)) {
          manifest.excluded.push({ path: rel, reason: 'excluded_dir' });
          continue;
        }
        walk(abs);
      } else if (dirent.isSymbolicLink()) {
        // 外部链接目标不自动跟随（§6.3）。
        manifest.excluded.push({ path: rel, reason: 'symlink' });
        continue;
      } else if (dirent.isFile()) {
        if (EXCLUDED_FILE_PATTERNS.some((match) => match(dirent.name))) {
          manifest.excluded.push({ path: rel, reason: 'credential_like' });
          continue;
        }
        if (BINARY_EXTENSIONS.has(dirent.name.slice(dirent.name.lastIndexOf('.')).toLowerCase())) {
          manifest.excluded.push({ path: rel, reason: 'binary' });
          continue;
        }
        const size = statSync(abs).size;
        if (size > perFileMax) {
          manifest.excluded.push({ path: rel, reason: 'oversize_file' });
          continue;
        }
        if (manifest.totals.includedBytes + size > totalMax) {
          manifest.excluded.push({ path: rel, reason: 'total_cap' });
          continue;
        }
        if (manifest.entries.length >= maxEntries) {
          manifest.excluded.push({ path: rel, reason: 'max_entries' });
          continue;
        }
        const sha256 = createHash('sha256').update(readFileSync(abs)).digest('hex');
        manifest.entries.push({ path: rel, size, sha256 });
        manifest.totals.includedFiles += 1;
        manifest.totals.includedBytes += size;
      }
    }
  };
  walk(rootCanonicalPath);
  manifest.totals.excludedCount = manifest.excluded.length;
  return domainOk(manifest);
}

export interface BaselineRecordResult {
  baselineId: string;
  manifestHash: string;
  manifestPath: string;
}

/** 清单落盘（不可变路径）+ baselines 行（§12.4：先临时文件再原子重命名由 DEV-12 完整化，此处直写）。 */
export function createBaselineRecord(
  db: ZhongshuoDatabase,
  input: {
    projectId: string;
    manifest: BaselineManifest;
    taskRevision: number;
    storageDir: string;
    now?: number;
  },
): DomainResult<BaselineRecordResult> {
  const now = input.now ?? Date.now();
  void now; // manifest.createdAt 已承载时间戳；行级 created_at 由迁移默认值/调用方管理
  const manifestHash = createHash('sha256').update(JSON.stringify(input.manifest)).digest('hex');
  const manifestPath = join(input.storageDir, `baseline-${manifestHash.slice(0, 16)}.json`);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(input.manifest, null, 2), 'utf8');
  const baselineId = `bl_${manifestHash.slice(0, 24)}`;
  // 内容寻址幂等：同清单 hash 复用既有基线（同内容不产生第二条记录）。
  const info = db
    .prepare(
      `INSERT INTO baselines (id, project_id, task_revision, manifest_hash, manifest_path, status)
       VALUES (?, ?, ?, ?, ?, 'ready')
       ON CONFLICT (id) DO NOTHING`,
    )
    .run(baselineId, input.projectId, input.taskRevision, manifestHash, manifestPath);
  if (info.changes === 0) {
    const existing = db
      .prepare('SELECT manifest_path FROM baselines WHERE id = ?')
      .get(baselineId) as { manifest_path: string };
    return domainOk({ baselineId, manifestHash, manifestPath: existing.manifest_path });
  }
  return domainOk({ baselineId, manifestHash, manifestPath });
}
