/**
 * 预览 fixture 的**真实静态文本内容**（UX-PREVIEW-01，A 阶段）。
 *
 * 施工说明 §3：允许用真实静态文本/图片 fixture 验证读取与显示，
 * 但要求"数据模拟与 UI 真可操作是两回事"。所以这里给的是**真能渲染**的内容：
 * Markdown 按真实规则解析、CSV 按真实规则分列 —— 不是占位字符串。
 *
 * 图片数据在 `./fixture-png.ts`（由生成脚本产出，不要手改）。
 *
 * 边界（必须如实，§8.1）：这些是**原型内嵌的 mock 资源**，
 * 不代表读取了用户磁盘上的文件。界面要标注"模拟资源"，
 * 不能把 mock 说成真实解析通过。
 */

/* ---------- Markdown：验证标题/列表/表格/行内代码/引用块/长行 ---------- */

export const FIXTURE_MARKDOWN_V1 = `# 预览管线设计说明

本文件用于验证 **Markdown 渲染**、源码切换与行/段落锚点引用。

## 1. 资源身份与版本

同一份资源可以有多个固定版本。引用与评论绑定的是
\`(resourceId, revision)\`，而不是"最新版"。

| 版本 | 内容 | 说明 |
|---|---|---|
| v1 | 初稿 | 只含背景与问题陈述 |
| v2 | 补充方案 | 加入资源契约与竞态处理 |
| v3 | 当前 | 补测试证据与边界说明 |

## 2. 渲染要求

- 标题、列表、表格、行内代码 \`like-this\`、引用块都要正确渲染
- 原始 HTML 不执行，按文本显示
- 切换源码视图时保留滚动位置

> 引用块示例：预览只用于阅读、定位、比较和引用；
> 打开文件不自动发送给 AI，也不运行脚本。

### 2.1 长行测试

下面这行刻意很长，用于验证 1280px 窗口下预览区的换行与横向滚动行为：资源解析必须在受控读取层校验真实归属、projectId、允许的根目录及 canonical path，相对路径、软链接和 junction 都不能越过项目或成果的授权范围。

## 3. 待办

1. 接入真实磁盘读取（当前为 mock fixture）
2. Office 转换服务
3. 大文件分片与虚拟列表
`;

/** v2：用于验证"磁盘已更新 → 提示而不抢正文"（PV-09） */
export const FIXTURE_MARKDOWN_V2 = FIXTURE_MARKDOWN_V1
  .replace(
    '# 预览管线设计说明',
    '# 预览管线设计说明（v2 · 已补充竞态处理）',
  )
  .replace(
    '## 3. 待办',
    `## 2.2 竞态处理

同一当前文件连续刷新时**只接受最新请求**对应的读取版本，
避免晚回包把内容回退到旧版本。关闭标签后的回包不得重新打开该标签。

## 3. 待办`,
  );

/* ---------- 代码：验证行号与长代码行 ---------- */

export const FIXTURE_CODE_TS = `/**
 * 资源解析的受控读取层（示意代码，用于预览渲染验证）。
 *
 * 关键约束：真实归属必须由**主进程/服务端**校验，
 * 界面传来的 projectId 只作为定位线索，不构成授权。
 */

export interface ResourceRef {
  kind: 'artifact' | 'attachment' | 'worktree';
  projectId: string;
  resourceId: string;
  revision: number;
  hash: string;
}

export class ResourceResolver {
  private readonly roots = new Map<string, string>();

  registerRoot(projectId: string, canonicalPath: string) {
    // canonical path 必须已解析软链接/junction，否则相对路径可以越界
    this.roots.set(projectId, canonicalPath);
  }

  /** 相对路径 -> 绝对路径，越界时失败而不是静默截断 */
  resolvePath(projectId: string, relativePath: string): string {
    const root = this.roots.get(projectId);
    if (!root) throw new Error('PROJECT_NOT_FOUND');
    const normalized = relativePath.replace(/\\\\/g, '/').replace(/^\\.\\//, '');
    if (normalized.split('/').includes('..')) {
      throw new Error('PATH_OUTSIDE_PROJECT');
    }
    return root + '/' + normalized;
  }

  /** 渲染器分发：按内容 kind，不按扩展名猜（§8.1） */
  viewerFor(asset: ResourceRef): 'markdown' | 'code' | 'image' | 'csv' | 'unsupported' {
    switch (asset.kind) {
      case 'worktree':
        return 'code';
      default:
        return 'markdown';
    }
  }
}
`;

/* ---------- 纯文本：非 Git 项目笔记 ---------- */

export const FIXTURE_NOTES_TXT = `notes-vault 目录说明
====================

非 Git 项目的笔记目录，用于验证：
  1. 非 Git 项目的文件树与预览可用
  2. Git 标签显示「尚未初始化」且不自动初始化
  3. 整目录快照式的改动前像

目录结构：
  notes/         随手笔记
  attachments/   附件（图片等）

注意：本项目目录正常但不是 Git 仓库，
所以「文件」标签可用，「Git」标签给出说明。
`;

/* ---------- CSV：验证分列、引号内逗号与跨行单元格 ---------- */

export const FIXTURE_CSV = `任务号,标题,状态,负责人,回复数,更新时间
12,整理本周演化日志,待验收,Codex,143,2026-09-22 17:30
13,"修复报告脚本路径解析（含 ""引号"" 与逗号, 场景）",执行中,Claude,28,2026-09-22 16:05
14,补充预览交互测试,已完成,Codex,41,2026-09-21 11:20
11,"复盘上一轮方案
（跨行单元格）",已完成,Claude,67,2026-09-20 09:15
`;

/* ---------- diff：验证两侧固定版本比较 ---------- */

export const FIXTURE_DIFF_LEFT = `export function threadMaxWidth() {
  const w = typeof window === 'undefined' ? 1600 : window.innerWidth;
  const sidebarOpen = !!document.querySelector('.sidebar');
  const avail = w - (sidebarOpen ? SIDEBAR_W : 0);
  return Math.max(THREAD_MIN, Math.min(1100, avail - MAIN_MIN));
}
`;

export const FIXTURE_DIFF_RIGHT = `export function threadMaxWidth(containerWidth: number, sidebarOpen: boolean) {
  // 改为按容器宽度测量：系统缩放/浏览器缩放下 window.innerWidth 不可靠
  const avail = containerWidth - (sidebarOpen ? SIDEBAR_W : 0);
  return Math.max(THREAD_MIN, Math.min(1100, avail - MAIN_MIN));
}
`;
