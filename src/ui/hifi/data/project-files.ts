/**
 * 项目文件树（R64）：真实目录懒装载投影——project.files.list（安全根内只读列举）。
 * 替代原型 mock-tree：节点来自用户项目磁盘的真实目录项（名称/类型/大小/mtime），
 * 目录按需展开（每目录一次命令，读取完整性如实呈现）。不做内容读取——
 * 选中文件经共享预览走 project.file.read 只读快照。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { command } from '../bridge';

export interface TreeNode {
  path: string;
  name: string;
  kind: 'dir' | 'file';
  sizeBytes?: number;
  modifiedAt?: number;
  children: TreeNode[];
  depth: number;
  /** 目录是否已装载过子项（懒装载标记）。 */
  loaded?: boolean;
}

interface ListData { path: string; entries: Array<{ name: string; kind: 'dir' | 'file'; sizeBytes: number | null; modifiedAt: number | null }>; truncated: boolean }

/** 文件大小展示（与 lib/format.formatBytes 同义——保留原型签名）。 */
export function fileSizeLabel(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function listDir(projectId: string, dirPath: string): Promise<ListData> {
  return command<ListData>('project.files.list', { projectId, ...(dirPath.length > 0 ? { path: dirPath } : {}) });
}

function childrenOf(projectId: string, dir: TreeNode, data: ListData): TreeNode[] {
  return data.entries.map((e) => ({
    path: dir.path.length > 0 ? `${dir.path}/${e.name}` : e.name,
    name: e.name,
    kind: e.kind,
    sizeBytes: e.sizeBytes ?? undefined,
    modifiedAt: e.modifiedAt ?? undefined,
    children: [],
    depth: dir.depth + 1,
    loaded: e.kind === 'dir' ? false : undefined,
  }));
}

/**
 * 懒装载目录树 hook：挂载装载根目录；toggleDir 展开目录（首次装载其子项）。
 * 加载失败如实 error（不伪空树）；truncated 目录标注在节点上（title 提示）。
 */
export function useLazyTree(projectId: string): {
  roots: TreeNode[];
  expanded: Set<string>;
  toggleDir: (path: string) => void;
  loading: boolean;
  error: string | null;
  truncatedDirs: Set<string>;
  fileCount: number;
  reload: () => void;
  findNode: (path: string) => TreeNode | undefined;
} {
  const [root, setRoot] = useState<TreeNode>({ path: '', name: '', kind: 'dir', children: [], depth: -1, loaded: false });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncatedDirs, setTruncatedDirs] = useState<Set<string>>(new Set());
  const [version, setVersion] = useState(0);
  const [flat, setFlat] = useState<Map<string, TreeNode>>(new Map());

  const rebuildFlat = useCallback((node: TreeNode, into: Map<string, TreeNode>): void => {
    for (const c of node.children) { into.set(c.path, c); rebuildFlat(c, into); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    void listDir(projectId, '')
      .then((data) => {
        if (cancelled) return;
        const nextRoot: TreeNode = { path: '', name: '', kind: 'dir', children: [], depth: -1, loaded: true };
        nextRoot.children = childrenOf(projectId, nextRoot, data);
        const m = new Map<string, TreeNode>();
        rebuildFlat(nextRoot, m);
        setRoot(nextRoot); setFlat(m);
        setTruncatedDirs((prev) => (data.truncated ? new Set(prev).add('') : new Set(prev)));
      })
      .catch((e: unknown) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, version]);

  const toggleDir = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    const dir = flat.get(path);
    if (dir != null && dir.kind === 'dir' && dir.loaded !== true) {
      void listDir(projectId, path)
        .then((data) => {
          setFlat((prevFlat) => {
            const target = prevFlat.get(path);
            if (target == null) return prevFlat;
            target.children = childrenOf(projectId, target, data);
            target.loaded = true;
            const m = new Map(prevFlat);
            rebuildFlat(rootRef.current, m);
            return m;
          });
          if (data.truncated) setTruncatedDirs((prev) => new Set(prev).add(path));
        })
        .catch((e: unknown) => setError((e as Error).message));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, flat]);

  /** root 的最新引用（toggleDir 内重建 flat 用——避免闭包旧树）。 */
  const rootRef = useRefRoot(root);

  const fileCount = useMemo(() => { let n = 0; for (const t of flat.values()) if (t.kind === 'file') n += 1; return n; }, [flat]);
  const findNode = useCallback((path: string) => flat.get(path), [flat]);

  return { roots: root.children, expanded, toggleDir, loading, error, truncatedDirs, fileCount, reload: () => setVersion((v) => v + 1), findNode };
}

/** root 引用镜像（useLazyTree 内部用）。 */
import { useRef } from 'react';
function useRefRoot(root: TreeNode): { current: TreeNode } {
  const ref = useRef(root);
  ref.current = root;
  return ref;
}
