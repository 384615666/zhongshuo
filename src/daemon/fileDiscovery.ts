/**
 * 经授权的文件发现清单（第六轮·下修订：任务作用域过滤——两模式遵循同一权限规则）。
 *
 * 背景（value-abc-20260928 C 组观察）：任务目录内文件名不可猜 + 模型自述无目录枚举能力
 * → 两侧均无法定位 logs/app-week.log。修复方向=**程序侧提供受限清单**（不依赖模型对工具面
 * 的认知）。**任务实际允许的文件范围**（不止物理边界）：
 * - 项目根内 + 非隐藏文件（. 开头段与 .git 同口径排除——内部/配置项）；
 * - **其他任务变更归属文件**（change_sets 归属≠当前任务且 after=present——本产品写档溯源，
 *   DEV-12）不出现在清单——不因位于项目根内就可见；
 * - 评分答案/内部文件不在项目根内，天然不受影响；阶段不可读成果（DELIB 冻结材料）在
 *   appData 侧，同样不在项目根。
 * 截断与扫描破口如实标注（复用 scanDirectory 完整性语义）。清单进入输入信封（hash 校验
 * 覆盖）。**本过滤不构成 runtime 文件沙箱认证**（模型仍可按已知路径读取——工具面以运行时
 * 实际可用为准）；两模式一致性=同一授权规则，不是无条件看到整项目。
 */
import { scanDirectoryFiles } from './preimage.ts';
import { existsSync, statSync } from 'node:fs';

export interface AuthorizedFileListing {
  policy: 'authorized-listing';
  files: string[];
  truncated: boolean;
  integrityNote: string;
  /** 范围过滤计数（如实）。 */
  excludedHidden: number;
  excludedOtherTask: number;
}

export interface ListingScopeOptions {
  maxEntries?: number;
  /** 其他任务变更归属路径（exclude 口径见 taskScopedFileListing）。 */
  excludePaths?: Set<string>;
}

/** 生成经授权的文件清单（root 必须存在且为目录——否则返回 null，不阻断组装）。 */
export function authorizedFileListing(root: string, options: ListingScopeOptions = {}): AuthorizedFileListing | null {
  const maxEntries = options.maxEntries ?? 200;
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) return null;
    const scan = scanDirectoryFiles(root, maxEntries);
    const excludePaths = options.excludePaths ?? new Set<string>();
    let excludedHidden = 0;
    let excludedOtherTask = 0;
    const files: string[] = [];
    for (const f of scan.files) {
      const rel = f.slice(root.length + 1).replaceAll('\\', '/');
      if (rel.split('/').some((seg) => seg.startsWith('.'))) { excludedHidden += 1; continue; }
      if (excludePaths.has(rel)) { excludedOtherTask += 1; continue; }
      files.push(rel);
    }
    const parts: string[] = [];
    if (scan.failedDirs.length > 0) parts.push(`子树读取失败 ${scan.failedDirs.length} 处（受影响文件不在清单内）`);
    if (scan.rejectedEntries.length > 0) parts.push(`物理路径拒绝 ${scan.rejectedEntries.length} 项（越界链接/环——不可读）`);
    parts.push(scan.truncated ? `达清单上限（${maxEntries}）已截断` : '扫描完整');
    if (excludedHidden > 0) parts.push(`隐藏项 ${excludedHidden} 项不在本任务清单`);
    if (excludedOtherTask > 0) parts.push(`其他任务变更归属 ${excludedOtherTask} 项不在本任务清单`);
    return {
      policy: 'authorized-listing',
      files,
      truncated: scan.truncated,
      integrityNote: `${parts.join('；')}；任务可读范围=项目根内非隐藏文件（排除 .git/隐藏项/其他任务成果；评分答案与内部文件不在项目根内不受影响）；工具面以运行时实际可用为准（清单为程序侧授权补充，不构成工具能力声明或文件沙箱认证）`,
      excludedHidden,
      excludedOtherTask,
    };
  } catch {
    return null; // 清单生成失败不阻断任务派发（模型仍可按已知路径读取）
  }
}

/** 最小 DB 面（测试可注入；避免与 ZhongshuoDatabase 具体类型耦合）。 */
interface ListingDb {
  prepare(sql: string): { all(...args: unknown[]): unknown };
}

/** 任务作用域清单：物理边界内按当前任务授权过滤（其他任务 change_sets 归属排除）。 */
export function taskScopedFileListing(db: ListingDb, projectId: string, taskId: string | null, root: string): AuthorizedFileListing | null {
  const rows = db.prepare(
    `SELECT DISTINCT csf.path FROM change_set_files csf JOIN change_sets cs ON cs.id = csf.change_set_id
     WHERE cs.project_id = ? AND cs.task_id IS NOT NULL AND cs.task_id != ? AND csf.role = 'after' AND csf.state = 'present'`,
  ).all(projectId, taskId ?? '') as Array<{ path: string }>;
  return authorizedFileListing(root, { excludePaths: new Set(rows.map((r) => r.path)) });
}
