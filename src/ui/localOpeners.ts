/**
 * 本机「用其他程序打开」能力发现（R170）。
 *
 * 界面里的文件卡与预览标签需要提供「资源管理器 / VS Code / IntelliJ IDEA / PyCharm」
 * 这类本机已安装程序的打开入口（用户反馈第 11 项），以及右键菜单的「打开文件夹 /
 * 按默认程序打开」（第 8 项）。
 *
 * 边界：
 *  - 这里**只做发现与路径校验**，不执行任何用户内容：可执行文件与参数由主进程按
 *    固定清单解析，渲染器只能提交枚举 id 与一个已存在的本机绝对文件路径。
 *  - 不猜测安装位置来伪造能力：找不到就是没装，界面只显示「资源管理器」与复制路径。
 *  - 探测逻辑通过 `OpenerProbe` 注入文件系统，便于单元测试（不依赖真实安装）。
 */
import { existsSync as realExists, readdirSync as realList, statSync as realStat } from 'node:fs';
import { win32 } from 'node:path';

export type LocalOpenerId = 'explorer' | 'vscode' | 'idea' | 'pycharm';

export interface LocalOpener {
  id: LocalOpenerId;
  label: string;
  /** explorer=打开所在文件夹；editor=用该程序打开文件 */
  kind: 'explorer' | 'editor';
  /** 仅主进程内部使用；不通过 IPC 返回渲染器。 */
  executable?: string;
}

export interface OpenerProbe {
  exists(path: string): boolean;
  list(dir: string): string[];
  isFile(path: string): boolean;
}

const defaultProbe: OpenerProbe = {
  exists: (path) => {
    try { return realExists(path); } catch { return false; }
  },
  list: (dir) => {
    try { return realList(dir); } catch { return []; }
  },
  isFile: (path) => {
    try { return realStat(path).isFile(); } catch { return false; }
  },
};

function firstExisting(probe: OpenerProbe, candidates: Array<string | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate == null || candidate === '') continue;
    if (probe.isFile(candidate)) return candidate;
  }
  return null;
}

/** 在有限深度内按文件名查找（JetBrains Toolbox 的安装层级是动态版本号目录）。 */
function findExecutableUnder(probe: OpenerProbe, root: string | undefined, executableNames: readonly string[], maxDepth: number): string | null {
  if (root == null || root === '' || !probe.exists(root)) return null;
  const seen = new Set<string>();
  let budget = 240;
  const walk = (dir: string, depth: number): string | null => {
    if (depth > maxDepth || budget-- <= 0 || seen.has(dir)) return null;
    seen.add(dir);
    const entries = probe.list(dir);
    for (const name of executableNames) if (entries.includes(name)) {
      const candidate = win32.join(dir, name);
      if (probe.isFile(candidate)) return candidate;
    }
    for (const name of entries) {
      if (depth >= maxDepth) break;
      // 只下钻看起来像安装目录的名字；避免扫进缓存/插件等大目录。
      if (!/^(ch-|bin$|bin\b|20\d\d\.|[A-Za-z][\w .-]{0,40}$)/.test(name)) continue;
      const found = walk(win32.join(dir, name), depth + 1);
      if (found != null) return found;
    }
    return null;
  };
  return walk(root, 0);
}

function jetbrainsRoots(env: Record<string, string | undefined>): string[] {
  const roots = [
    env.ProgramFiles != null ? win32.join(env.ProgramFiles, 'JetBrains') : null,
    env['ProgramFiles(x86)'] != null ? win32.join(env['ProgramFiles(x86)']!, 'JetBrains') : null,
    env.LOCALAPPDATA != null ? win32.join(env.LOCALAPPDATA, 'Programs', 'JetBrains') : null,
    env.LOCALAPPDATA != null ? win32.join(env.LOCALAPPDATA, 'JetBrains', 'Toolbox', 'apps') : null,
  ];
  return roots.filter((root): root is string => root != null);
}

function detectJetBrains(probe: OpenerProbe, env: Record<string, string | undefined>, prefix: RegExp, executableNames: readonly string[]): string | null {
  for (const root of jetbrainsRoots(env)) {
    if (!probe.exists(root)) continue;
    for (const name of probe.list(root)) {
      if (!prefix.test(name)) continue;
      for (const executable of executableNames) {
        const direct = win32.join(root, name, 'bin', executable);
        if (probe.isFile(direct)) return direct;
      }
      const nested = findExecutableUnder(probe, win32.join(root, name), executableNames, 4);
      if (nested != null) return nested;
    }
  }
  return null;
}

function detectVsCode(probe: OpenerProbe, env: Record<string, string | undefined>): string | null {
  const local = env.LOCALAPPDATA;
  const pf = env.ProgramFiles;
  const pf86 = env['ProgramFiles(x86)'];
  return firstExisting(probe, [
    local != null ? win32.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe') : undefined,
    pf != null ? win32.join(pf, 'Microsoft VS Code', 'Code.exe') : undefined,
    pf86 != null ? win32.join(pf86, 'Microsoft VS Code', 'Code.exe') : undefined,
    local != null ? win32.join(local, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe') : undefined,
  ]);
}

/**
 * 本机可用的打开方式（顺序固定）。Windows 之外的开发环境返回空数组——
 * 应用只有 Windows 安装包，不虚构其它平台能力。
 */
export function detectLocalOpeners(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  probe: OpenerProbe = defaultProbe,
): LocalOpener[] {
  const openers: LocalOpener[] = [];
  if (platform === 'win32') {
    openers.push({ id: 'explorer', label: '资源管理器', kind: 'explorer' });
    const vsCode = detectVsCode(probe, env);
    if (vsCode != null) openers.push({ id: 'vscode', label: 'VS Code', kind: 'editor', executable: vsCode });
    const idea = detectJetBrains(probe, env, /^(IntelliJ IDEA|IDEA)/i, ['idea64.exe', 'idea.exe']);
    if (idea != null) openers.push({ id: 'idea', label: 'IntelliJ IDEA', kind: 'editor', executable: idea });
    const pycharm = detectJetBrains(probe, env, /^PyCharm/i, ['pycharm64.exe', 'pycharm.exe']);
    if (pycharm != null) openers.push({ id: 'pycharm', label: 'PyCharm', kind: 'editor', executable: pycharm });
  }
  return openers;
}

/** 渲染器可见的打开方式（不含可执行文件路径）。 */
export function publicOpeners(openers: readonly LocalOpener[]): Array<{ id: LocalOpenerId; label: string; kind: 'explorer' | 'editor' }> {
  return openers.map(({ id, label, kind }) => ({ id, label, kind }));
}

/**
 * 主进程对渲染器提交的路径做最小校验：必须是绝对路径、真实存在的文件。
 * 目录与不存在的路径一律拒绝（不打开“附近的东西”冒充用户点名的文件）。
 */
export function isOpenableLocalFile(path: string, probe: OpenerProbe = defaultProbe, platform: string = process.platform): boolean {
  if (typeof path !== 'string' || path.trim() === '') return false;
  const normalized = platform === 'win32' ? win32.normalize(path) : path;
  if (platform === 'win32' ? !win32.isAbsolute(normalized) : !normalized.startsWith('/')) return false;
  return probe.isFile(normalized);
}
