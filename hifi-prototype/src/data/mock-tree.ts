/**
 * 项目文件树 mock 数据（第十五批 §4）。
 *
 * 为什么要有它：§17.1/§17.2 承诺「文件」标签是**文件树 + 预览 + diff**，
 * 但原型的左列一直只是"改动集列表" —— 那其实只覆盖了"改了什么"，
 * 用户看不到"项目里有什么"（未修改的文件、嵌套目录、空目录）。
 *
 * **明确边界（必须让读者知道这是 mock）**：
 *  - 不扫描真实磁盘，不读用户项目文件内容；
 *  - 树与预览内容都是构造的示例，用于验证交互（展开/选中/大文件/二进制说明）；
 *  - 真实实现需要 `file.tree` / `file.read`（§15.2 目前**没有**这两个命令，
 *    属待补命令面），并受目录锁与权限约束。
 */

export interface MockFileNode {
  /** 相对项目根的路径，作为稳定 key */
  path: string;
  name: string;
  kind: 'dir' | 'file';
  /** 文件大小（字节），目录为 undefined */
  sizeBytes?: number;
  /** 预览内容；二进制/超大文件不给内容，界面显示说明而不是假装能读 */
  preview?: string;
  /** 不可按文本预览的原因（§4：非文本/大文件显示适当说明） */
  notPreviewable?: 'binary' | 'too_large';
  /** 是否为项目中的空目录（也要能显示出来） */
  emptyDir?: boolean;
}

const TREE_ZS: MockFileNode[] = [
  {
    path: 'src', name: 'src', kind: 'dir',
  },
  {
    path: 'src/contracts', name: 'contracts', kind: 'dir',
  },
  {
    path: 'src/contracts/events.ts', name: 'events.ts', kind: 'file', sizeBytes: 4210,
    preview: `/**
 * 规范化事件：把厂商事件类型收敛到本层，domain 不再引用 provider 联合类型。
 */
export type NormalizedEvent =
  | { kind: 'message'; text: string }
  | { kind: 'tool'; name: string; input?: unknown }
  | { kind: 'done'; usage?: UsageRecord };
`,
  },
  {
    path: 'src/contracts/router.ts', name: 'router.ts', kind: 'file', sizeBytes: 1860,
    preview: `export type RouteMode = 'AUTO' | 'DIRECT' | 'DELIBERATE';

/** 路由由 @ 结构推导，不由界面控件单独决定 */
export function deriveRoute(mentions: string[], sendAs: 'ai' | 'record'):
  { mode: RouteMode; reason: string } {
  if (sendAs === 'record') return { mode: 'AUTO', reason: '仅记录：不唤醒 agent' };
  if (mentions.length === 0) return { mode: 'AUTO', reason: '无 @：由协调者接单' };
  if (mentions.length === 1) return { mode: 'DIRECT', reason: '单个结构化 @' };
  return { mode: 'DELIBERATE', reason: '@全体或多个明确 @' };
}
`,
  },
  {
    path: 'src/domain', name: 'domain', kind: 'dir',
  },
  {
    path: 'src/domain/task.ts', name: 'task.ts', kind: 'file', sizeBytes: 2740,
    preview: `export interface Task {
  id: string;
  projectId: string;
  status: TaskStatus;
  /** 创建时快照的验收策略，之后改项目设置不影响本任务 */
  reviewPolicy: 'user_review' | 'auto_deliver';
}
`,
  },
  {
    path: 'src/ui', name: 'ui', kind: 'dir',
  },
  {
    path: 'src/ui/Dashboard.tsx', name: 'Dashboard.tsx', kind: 'file', sizeBytes: 3120,
    preview: `export const TITLE = "众说 · 工作台";

export function Dashboard() {
  // 注意：此文件当前处于冲突状态（工作区里有标记冲突），
  // 冲突解决前不提供整文件一键覆盖（§14.2）。
  return <main>{TITLE}</main>;
}
`,
  },
  {
    // 空目录也要能展开/显示，不能因为"没有子节点"就从树里消失
    path: 'src/empty-placeholder', name: 'empty-placeholder', kind: 'dir', emptyDir: true,
  },
  {
    path: 'scripts', name: 'scripts', kind: 'dir',
  },
  {
    path: 'scripts/build-report.mjs', name: 'build-report.mjs', kind: 'file', sizeBytes: 2640,
    preview: `// 报告正文按 UTF-8 写盘，终端提示单独转码（中文路径兜底）。
import { writeFile } from 'node:fs/promises';
const outDir = resolve(fileURLToPath(pathToFileURL(process.argv[2] ?? 'dist')));
await writeFile(join(outDir, 'report.md'), md, 'utf8');
`,
  },
  {
    path: 'scripts/lib', name: 'lib', kind: 'dir',
  },
  {
    path: 'scripts/lib/paths.mjs', name: 'paths.mjs', kind: 'file', sizeBytes: 940,
    preview: `/** 路径先规范化再进 fs 调用：Windows 中文路径与盘符大小写都必须处理 */
export function normalize(p) {
  return p.replace(/\\\\/g, '/');
}
`,
  },
  {
    path: 'fixtures', name: 'fixtures', kind: 'dir',
  },
  {
    // 大文件 / 二进制不假装能读（§4）
    path: 'fixtures/large-corpus.bin', name: 'large-corpus.bin', kind: 'file',
    sizeBytes: 214_748_364, notPreviewable: 'binary',
  },
  {
    path: 'docs', name: 'docs', kind: 'dir',
  },
  {
    path: 'docs/README.md', name: 'README.md', kind: 'file', sizeBytes: 780,
    preview: `# 众说

本地项目群聊多 Agent 协同工作台。

> 本节由你在任务 #13 开始前手动修改，不属于任务改动。
`,
  },
  {
    path: 'docs/zhongshuo-development-design-v1.md', name: 'zhongshuo-development-design-v1.md',
    kind: 'file', sizeBytes: 512_000, notPreviewable: 'too_large',
  },
];

/** data-backfill：结构与众说不同，用来证明树是按项目取的 */
const TREE_BACKFILL: MockFileNode[] = [
  { path: 'etl', name: 'etl', kind: 'dir' },
  {
    path: 'etl/backfill-orders.py', name: 'backfill-orders.py', kind: 'file', sizeBytes: 3640,
    preview: `BATCH_SIZE = 50_000

def run(conn, checkpoint: int) -> int:
    """按 updated_at 水位分批；断点写入 etl_checkpoint，重跑从水位续。"""
    cur = conn.cursor()
    cur.execute(SELECT_SQL, (checkpoint, BATCH_SIZE))
    rows = cur.fetchall()
    cur.executemany(INSERT_SQL, rows)   # ON CONFLICT DO NOTHING → 幂等
    return len(rows)
`,
  },
  { path: 'etl/checkpoint.sql', name: 'checkpoint.sql', kind: 'file', sizeBytes: 420,
    preview: `CREATE TABLE IF NOT EXISTS etl_checkpoint (
  job       TEXT PRIMARY KEY,
  watermark TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
` },
  { path: 'tests', name: 'tests', kind: 'dir' },
  { path: 'tests/test_backfill.py', name: 'test_backfill.py', kind: 'file', sizeBytes: 1180,
    preview: `def test_idempotent(conn):
    run(conn, 0)
    before = count(conn)
    run(conn, 0)          # 再跑一遍
    assert count(conn) == before, "重跑不应重复写入"
` },
];

/** docs 项目：目录失效，树取不到内容（§17.7：目录失效要有明确状态） */
const TREE_MISSING: MockFileNode[] = [];

/**
 * notes-vault：**非 Git 且目录正常**的项目（§9.4 专用）。
 * 它不是 Git 仓库，但文件树与预览必须照常可用 —— 版本控制的有无不改变
 * "能不能看项目里有什么"这件事。
 */
const TREE_NOTGIT: MockFileNode[] = [
  { path: 'docs', name: 'docs', kind: 'dir' },
  {
    path: 'docs/index.md', name: 'index.md', kind: 'file', sizeBytes: 1240,
    preview: `# 笔记索引

## 架构
- 2026-08-14 六边界与依赖方向.md
- 2026-09-02 目录锁域判定.md

## 排期
- 2026-09-10 M3 批次拆分.md

## 复盘
- 2026-09-18 中文路径事故复盘.md
`,
  },
  {
    path: 'docs/meetings', name: 'meetings', kind: 'dir',
  },
  {
    path: 'docs/meetings/2026-08-14-boundaries.md', name: '2026-08-14-boundaries.md', kind: 'file', sizeBytes: 3180,
    preview: `# 六边界与依赖方向

结论：domain 不得直接引用 provider 联合类型，一律经 contracts 规范化。

待办：核对 persistence 是否被 ui 直接引用（已由任务复核）。
`,
  },
  {
    path: 'docs/meetings/2026-09-18-path-incident.md', name: '2026-09-18-path-incident.md', kind: 'file', sizeBytes: 2260,
    preview: `# 中文路径事故复盘

现象：Windows 中文路径导致 ENOENT。
根因：未先规范化路径就进入 fs 调用。
改进：路径先规范化再进 fs；报告正文按 UTF-8 写盘，终端提示单独转码。
`,
  },
  {
    // 非 Git 项目里也可能有二进制附件
    path: 'attachments', name: 'attachments', kind: 'dir',
  },
  {
    path: 'attachments/whiteboard.png', name: 'whiteboard.png', kind: 'file',
    sizeBytes: 1_842_000, notPreviewable: 'binary',
  },
  {
    // 空目录同样要能显示
    path: 'inbox', name: 'inbox', kind: 'dir', emptyDir: true,
  },
];

const TREES: Record<string, MockFileNode[]> = {
  proj_zs_01: TREE_ZS,
  proj_backfill_02: TREE_BACKFILL,
  proj_docs_03: TREE_MISSING,
  proj_notgit_04: TREE_NOTGIT,
};

export function mockTreeOf(projectId: string): MockFileNode[] {
  return TREES[projectId] ?? [];
}

/**
 * 把扁平节点列表整理成可渲染的树。
 * 只做一层父子归并：路径按 `/` 分段，父目录若未显式出现则补一个隐式目录，
 * 保证树不会因为数据里漏写目录节点而断掉。
 */
export interface TreeNode extends MockFileNode {
  children: TreeNode[];
  depth: number;
}

export function buildTree(nodes: MockFileNode[]): TreeNode[] {
  const byPath = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  const ensureDir = (path: string): TreeNode => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const name = path.split('/').pop() ?? path;
    const dir: TreeNode = { path, name, kind: 'dir', children: [], depth: 0 };
    byPath.set(path, dir);
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (parentPath) ensureDir(parentPath).children.push(dir);
    else roots.push(dir);
    return dir;
  };

  for (const n of nodes) {
    const node: TreeNode = { ...n, children: [], depth: 0 };
    byPath.set(n.path, node);
    const parentPath = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '';
    if (parentPath) ensureDir(parentPath).children.push(node);
    else roots.push(node);
  }

  const assignDepth = (list: TreeNode[], depth: number) => {
    for (const n of list) {
      n.depth = depth;
      // 目录在前、文件在后，各自按名称排序（与常见文件管理器一致）
      n.children.sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1);
      assignDepth(n.children, depth + 1);
    }
  };
  roots.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  assignDepth(roots, 0);
  return roots;
}

/** 文件大小展示。命名与 lib/format 的 formatBytes 区分，避免同名导入冲突。 */
export function fileSizeLabel(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
