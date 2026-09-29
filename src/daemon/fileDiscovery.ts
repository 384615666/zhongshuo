/**
 * 项目范围文件发现清单（第七轮重写：回到既有授权合同，不自行新增产品权限规则）。
 *
 * 合同依据（主设计 v1）：
 * - §13.4 任务上下文隔离矩阵第 1 行：项目源码/指定基线「当前任务默认可用，按权限读取；
 *   跨任务=同项目可分析同一代码」——项目根内文件（含其他任务 applied 修改过的共享源码）
 *   默认进入清单；**不再按 change_sets 归属排除**（第六轮·下的旧规则把其他任务改过的共享
 *   源码永久藏起来，超出基线授权——改动归属与撤销是溯源维度，不是可读性维度；其他任务的
 *   对话/摘要/报告按 §13.4 属"否"，但它们存 DB/appData 侧，不在项目根，天然不进清单）。
 * - §6.3 分析基线默认排除：VCS 内部目录、依赖缓存、构建目录和常见凭据文件——按**命名
 *   清单**排除（不按 "." 前缀一刀切：.editorconfig/.gitignore 等非凭据配置可见；
 *   .env.example 是文档惯例，不排）。
 * - §13.2 大项目处理：忽略依赖和构建目录；设上限并显示排除项。
 * - §6.2 可实现隔离的边界：有广泛本机读取权限的 CLI 仍可能绕过应用接口——本清单只声明
 *   **输入清单过滤范围**，不构成 runtime 文件沙箱认证。
 *
 * 路径匹配：段与文件名比较用小写（Windows 大小写不敏感；分隔符统一 '/'）——别名/大小写
 * 变体（Node_Modules/DIST/.ENV）同等排除。上限按**过滤后**计数：扫描窗口放大，避免排除项
 * 耗尽名额使合法文件不可发现；截断如实标注。
 */
import { scanDirectoryFiles } from './preimage.ts';
import { existsSync, statSync } from 'node:fs';

export interface AuthorizedFileListing {
  policy: 'authorized-listing';
  files: string[];
  truncated: boolean;
  integrityNote: string;
  /** 范围过滤计数（如实）。 */
  excludedInternal: number;
}

/** §6.3 默认排除目录段（VCS 内部/依赖缓存/构建产物；小写比较）。 */
const EXCLUDED_DIR_SEGMENTS = new Set([
  '.git', '.hg', '.svn',
  'node_modules', '.pnpm-store', 'bower_components',
  'dist', 'build', 'out', 'target', '.next', '.nuxt', '.turbo', '.cache', 'coverage',
]);

/** §6.3 常见凭据文件模式（文件名小写匹配；.example/.template 文档惯例与公钥不排）。 */
function isCredentialFileName(lowerName: string): boolean {
  if (lowerName === '.env') return true;
  if (lowerName.startsWith('.env.')) return !(lowerName.endsWith('.example') || lowerName.endsWith('.template'));
  if (lowerName.endsWith('.pem') || lowerName.endsWith('.key')) return true;
  if (lowerName.startsWith('id_rsa') || lowerName.startsWith('id_ed25519') || lowerName.startsWith('id_ecdsa')) return !lowerName.endsWith('.pub');
  if (lowerName.startsWith('credentials.') || lowerName.startsWith('secrets.')) return true;
  return false;
}

export interface ListingScopeOptions {
  maxEntries?: number;
}

/** 生成项目范围授权清单（root 必须存在且为目录——否则返回 null，不阻断组装）。 */
export function projectScopedFileListing(root: string, options: ListingScopeOptions = {}): AuthorizedFileListing | null {
  const maxEntries = options.maxEntries ?? 200;
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) return null;
    // 扫描窗口放大：过滤后计数到 maxEntries——排除项不占用合法文件的名额。
    const scan = scanDirectoryFiles(root, maxEntries * 3 + 128);
    let excludedInternal = 0;
    const files: string[] = [];
    for (const f of scan.files) {
      const rel = f.slice(root.length + 1).replaceAll('\\', '/');
      const segments = rel.split('/');
      const fileName = segments[segments.length - 1] ?? '';
      if (segments.some((seg) => EXCLUDED_DIR_SEGMENTS.has((seg ?? '').toLowerCase()))) { excludedInternal += 1; continue; }
      if (isCredentialFileName(fileName.toLowerCase())) { excludedInternal += 1; continue; }
      files.push(rel);
    }
    const truncated = scan.truncated || files.length > maxEntries;
    const listed = files.slice(0, maxEntries);
    const parts: string[] = [];
    if (scan.failedDirs.length > 0) parts.push(`子树读取失败 ${scan.failedDirs.length} 处（受影响文件不在清单内）`);
    if (scan.rejectedEntries.length > 0) parts.push(`物理路径拒绝 ${scan.rejectedEntries.length} 项（越界链接/环——不可读）`);
    parts.push(truncated ? `达清单上限（${maxEntries}）已截断` : '扫描完整');
    if (excludedInternal > 0) parts.push(`内部/凭据排除 ${excludedInternal} 项（VCS 内部·依赖缓存·构建产物·常见凭据）`);
    return {
      policy: 'authorized-listing',
      files: listed,
      truncated,
      integrityNote: `${parts.join('；')}；任务可读范围=项目根内文件（§13.4：项目源码默认可读，同项目共享；§6.3 默认排除 VCS 内部/依赖缓存/构建产物/常见凭据；其他任务对话/摘要/报告不在项目根，不进清单）；工具面以运行时实际可用为准（清单为程序侧授权补充，不构成工具能力声明或文件沙箱认证）`,
      excludedInternal,
    };
  } catch {
    return null; // 清单生成失败不阻断任务派发（模型仍可按已知路径读取）
  }
}
