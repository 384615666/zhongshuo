/**
 * R201 第 6 项：把 markdown 里的 `file:///...` 绝对路径还原成本机路径。
 *
 * 只接受明确的 file: 协议 + 绝对路径；http/https/mailto/相对路径一律返回 null，
 * 由调用方继续按普通链接渲染。支持 Windows 盘符路径、百分号编码与 UNC。
 */
export function localPathFromFileHref(href: string): string | null {
  const raw = href.trim();
  if (!/^file:/i.test(raw) || /[\x00-\x1f\x7f]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    // URL query/fragment are not part of the filename. Encoded separators must
    // not silently turn a filename into a different path after decoding.
    if (/%(?:2f|5c)/i.test(url.pathname)) return null;
    const path = decodeURIComponent(url.pathname);
    if (/[\x00-\x1f\x7f]/.test(path)) return null;
    if (url.hostname && url.hostname !== 'localhost') {
      if (url.hostname === '.' || url.hostname === '..' || !/^\/[^/]+/.test(path)) return null;
      return `\\\\${url.hostname}${path.replace(/\//g, '\\')}`;
    }
    if (!/^\/[A-Za-z]:\//.test(path)) return null;
    return path.slice(1).replace(/\//g, '\\');
  } catch {
    return null;
  }
}

export function fileNameFromLocalPath(path: string): string {
  const hit = /[^\\/]+$/.exec(path);
  return hit == null ? path : hit[0];
}
