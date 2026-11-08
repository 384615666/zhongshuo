/**
 * R201 第 6 项：把 markdown 里的 `file:///...` 绝对路径还原成本机路径。
 *
 * 只接受明确的 file: 协议 + 绝对路径；http/https/mailto/相对路径一律返回 null，
 * 由调用方继续按普通链接渲染。支持 Windows 盘符路径、百分号编码与 UNC。
 */
export function localPathFromFileHref(href: string): string | null {
  const raw = href.trim();
  if (!/^file:/i.test(raw)) return null;
  let rest = raw.slice(5); // 去掉 "file:"
  if (rest.startsWith('//')) {
    rest = rest.slice(2);
    if (rest.startsWith('/')) rest = rest.slice(1); // file:///C:/...
    if (!/^[A-Za-z]:[\\/]/.test(rest) && !/^\/[A-Za-z]:[\\/]/.test(rest)) {
      // UNC：file://server/share/x → \\server\share\x
      try { rest = decodeURIComponent(rest); } catch { /* 保留原文 */ }
      return '\\\\' + rest.replace(/\//g, '\\');
    }
  } else if (!/^\/?[A-Za-z]:[\\/]/.test(rest)) {
    return null; // file:relative.png / file:/相对路径：不具备本机绝对路径语义
  }
  if (rest.startsWith('/')) rest = rest.slice(1);
  try { rest = decodeURIComponent(rest); } catch { /* 保留原文 */ }
  if (/^[A-Za-z]:[\\/]/.test(rest) || /^\\\\/.test(rest)) return rest.replace(/\//g, '\\');
  return null;
}

export function fileNameFromLocalPath(path: string): string {
  const hit = /[^\\/]+$/.exec(path);
  return hit == null ? path : hit[0];
}
