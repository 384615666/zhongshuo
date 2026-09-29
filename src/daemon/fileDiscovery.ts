/**
 * 经授权的文件发现清单（第六轮，后续版本能力——不倒改已跑批次实验条件）。
 *
 * 背景（value-abc-20260928 C 组观察）：任务目录内文件名不可猜 + 模型自述无目录枚举能力
 * → 两侧均无法定位 logs/app-week.log。修复方向=**程序侧提供受限清单**（不依赖模型对工具面
 * 的认知）：范围=项目根内、排除 .git、条数上限、截断与扫描破口如实标注（复用 scanDirectory
 * 的完整性语义——failedDirs/rejectedEntries 不静默）。两模式在**分析入口轮**采用一致规则
 * （DIRECT 每轮 / DELIB IND 首轮），不暴露其他任务成果/评分答案/未授权文件（仅项目根内）。
 */
import { scanDirectoryFiles } from './preimage.ts';
import { existsSync, statSync } from 'node:fs';

export interface AuthorizedFileListing {
  policy: 'authorized-listing';
  files: string[];
  truncated: boolean;
  integrityNote: string;
}

/** 生成经授权的文件清单（root 必须存在且为目录——否则返回 null，不阻断组装）。 */
export function authorizedFileListing(root: string, maxEntries = 200): AuthorizedFileListing | null {
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) return null;
    const scan = scanDirectoryFiles(root, maxEntries);
    const files = scan.files.map((f) => f.slice(root.length + 1).replaceAll('\\', '/'));
    const parts: string[] = [];
    if (scan.failedDirs.length > 0) parts.push(`子树读取失败 ${scan.failedDirs.length} 处（受影响文件不在清单内）`);
    if (scan.rejectedEntries.length > 0) parts.push(`物理路径拒绝 ${scan.rejectedEntries.length} 项（越界链接/环——不可读）`);
    parts.push(scan.truncated ? `达清单上限（${maxEntries}）已截断` : '扫描完整');
    return {
      policy: 'authorized-listing',
      files,
      truncated: scan.truncated,
      integrityNote: `${parts.join('；')}；排除 .git；工具面以运行时实际可用为准（清单为程序侧授权补充，不构成工具能力声明）`,
    };
  } catch {
    return null; // 清单生成失败不阻断任务派发（模型仍可按已知路径读取）
  }
}
