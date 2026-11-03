/**
 * 本机文件打开（R170）：把「某个资源到底是磁盘上的哪个文件」以及
 * 「资源管理器打开 / 用某个编辑器打开 / 复制路径」收敛到一处。
 *
 * 边界：
 *  - 仅当资源能对应到**项目目录里的真实文件**时才提供打开入口；交付文档、托管附件
 *    这类没有磁盘路径的资源不显示“打开文件夹/用其他程序打开”，只保留原有预览能力。
 *  - 绝对路径由「项目根目录 + 项目内相对路径」拼出；主进程会再校验文件真实存在。
 *  - 浏览器开发形态没有本机桥时，静默降级为只复制路径（不假装能打开）。
 */

export interface LocalFileOpener {
  id: string;
  label: string;
  kind: 'default' | 'explorer' | 'editor';
}

interface LocalFilesBridge {
  openers(path:string): Promise<{ items: LocalFileOpener[] }>;
  reveal(path: string): Promise<{ ok: boolean }>;
  openDefault(path: string): Promise<{ ok: boolean; error?: string }>;
  openWith(appId: string, path: string): Promise<{ ok: boolean; error?: string }>;
}

function bridge(): LocalFilesBridge | null {
  const candidate = (window as unknown as { zsLocalFiles?: LocalFilesBridge }).zsLocalFiles;
  return candidate != null && typeof candidate.openers === 'function' ? candidate : null;
}

/** 本机桥是否可用（浏览器里没有）。 */
export function canOpenLocalFiles(): boolean {
  return bridge() != null;
}

/** 把项目内相对路径/已经绝对的路径解析成绝对路径；无法解析时返回 null。 */
export function absoluteProjectPath(projectRoot: string | null | undefined, relativePath: string | null | undefined): string | null {
  const rel = (relativePath ?? '').trim();
  if (rel === '') return null;
  if (/^[A-Za-z]:[\\/]/.test(rel) || /^\\\\/.test(rel)) {
    // 已是绝对路径（含 UNC）：只统一分隔符，交由主进程校验真实存在。
    return rel.replace(/\//g, '\\');
  }
  if (rel.startsWith('/')) return rel; // POSIX 绝对路径（非 Windows 开发形态）
  if (projectRoot == null || projectRoot.trim() === '') return null;
  const root = projectRoot.trim().replace(/[\\/]+$/, '');
  const tail = rel.replace(/^[.][\\/]/, '').replace(/^[\\/]+/, '').replace(/\//g, '\\');
  return `${root}\\${tail}`;
}

/** 本机可用打开方式（主进程探测；无桥/失败时只返回空数组，不伪造）。 */
export async function localFileOpeners(path:string): Promise<LocalFileOpener[]> {
  const b = bridge();
  if(b==null)return [];
  try{const result=await b.openers(path);return Array.isArray(result?.items)?result.items.filter(item=>item!=null&&typeof item.id==='string'):[];}
  catch{return [];}
}

export interface LocalFileResult { ok: boolean; error?: string }

export async function revealLocalFile(absolutePath: string): Promise<LocalFileResult> {
  const b = bridge();
  if (b == null) return { ok: false, error: '当前环境不支持打开本机文件' };
  try { return await b.reveal(absolutePath); } catch (error) { return { ok: false, error: messageOf(error) }; }
}

export async function openLocalFileDefault(absolutePath: string): Promise<LocalFileResult> {
  const b = bridge();
  if (b == null) return { ok: false, error: '当前环境不支持打开本机文件' };
  try { return await b.openDefault(absolutePath); } catch (error) { return { ok: false, error: messageOf(error) }; }
}

export async function openLocalFileWith(appId: string, absolutePath: string): Promise<LocalFileResult> {
  const b = bridge();
  if (b == null) return { ok: false, error: '当前环境不支持打开本机文件' };
  try { return await b.openWith(appId, absolutePath); } catch (error) { return { ok: false, error: messageOf(error) }; }
}

/** 复制文本：优先系统剪贴板，失败时退回隐藏 textarea（浏览器/权限受限时仍可用）。 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const value = String(text ?? '');
  if (value === '') return false;
  try {
    if (navigator.clipboard?.writeText != null) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* 权限被拒——继续走回退路径 */ }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
    document.body.removeChild(area);
    return ok;
  } catch { return false; }
}

/** 文件所在目录（用于文案与“打开文件夹”标题）。 */
export function directoryOf(path: string): string {
  const normalized = path.replace(/\//g, '\\');
  const at = normalized.lastIndexOf('\\');
  if (at < 0) return normalized;
  if (at === 2 && /^[A-Za-z]:\\/.test(normalized)) return normalized.slice(0, 3); // 盘符根目录
  return at === 0 ? normalized : normalized.slice(0, at);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
