import { readFileSync, statSync } from 'node:fs';
import process from 'node:process';
import { delimiter, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';

export class CliResolutionError extends Error {
  constructor(code, message) { super(message); this.code = code; this.notStarted = true; }
}
const file = path => { try { return statSync(path).isFile(); } catch { return false; } };
const expand = (target, shim) => resolve(target.replace(/%~dp0|%dp0%/gi, dirname(shim) + sep).replace(/\$basedir/gi, dirname(shim)));

/** Known installers are decoded as argv/env data; no shell or script evaluation. */
export function resolveCliExecutable(kind, explicit) {
  const name = kind === 'deepseek-harness' ? 'dsh' : 'pi';
  const selected = explicit?.trim() || name;
  if (/[\r\n\0]/.test(selected)) throw new CliResolutionError('VALIDATION_INVALID', '执行程序引用含无效字符');
  let path = selected;
  if (!isAbsolute(path) && !/[\\/]/.test(path)) {
    const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    const found = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
      .flatMap(dir => suffixes.map(suffix => join(dir, path + suffix))).find(file);
    if (found) path = found;
  } else path = resolve(path);
  if (kind === 'deepseek-harness' && /(?:^|[\\/])DeepSeek Harness\.exe$/i.test(path)) {
    const archive = join(dirname(path), 'resources', 'app.asar');
    if (!file(path) || !file(archive)) throw new CliResolutionError('RUNTIME_NOT_FOUND', 'Harness 桌面程序或资源归档不存在');
    return { command: path, prefixArgs: ['--expose-internals', join(archive, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')],
      env: { ELECTRON_RUN_AS_NODE: '1' }, integrityFiles: [archive] };
  }
  if (/\.(?:mjs|cjs|js)$/i.test(path)) return { command: process.execPath, prefixArgs: [path] };
  if (/\.(?:cmd|bat)$/i.test(path)) {
    let text;
    try { text = readFileSync(path, 'utf8'); }
    catch { throw new CliResolutionError('RUNTIME_NOT_FOUND', `无法读取 ${name} 的启动入口`); }
    const desktop = text.match(/^"([^"\r\n]+\.exe)"\s+--expose-internals\s+"([^"\r\n]+app\.asar[\\/]dsh[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh-desktop-host[\\/]lib[\\/]cli\.js)"\s+%\*\s*$/mi);
    if (kind === 'deepseek-harness' && desktop && /^set\s+"ELECTRON_RUN_AS_NODE=1"\s*$/mi.test(text)) {
      const executable = expand(desktop[1], path), script = expand(desktop[2], path);
      const resolved = resolveCliExecutable(kind, executable);
      if (resolved.prefixArgs[1] !== script) throw new CliResolutionError('CAPABILITY_UNSUPPORTED', 'Harness 桌面启动入口与资源目录不一致');
      return { ...resolved, integrityFiles: [path, ...resolved.integrityFiles] };
    }
    const targets = [...text.matchAll(/"([^"\r\n]+\.(?:mjs|cjs|js))"/gi)];
    const target = targets.at(-1)?.[1];
    if (!target) throw new CliResolutionError('CAPABILITY_UNSUPPORTED', `${name} 的启动脚本无法解析，请选择实际 .js 或 .exe 程序`);
    const script = expand(target, path);
    if (!file(script)) throw new CliResolutionError('RUNTIME_NOT_FOUND', `${name} 的脚本目标不存在`);
    const siblingNode = join(dirname(path), 'node.exe');
    return { command: file(siblingNode) ? siblingNode : process.execPath, prefixArgs: [script] };
  }
  if (process.platform === 'win32' && !['.exe', '.com'].includes(extname(path).toLowerCase()))
    throw new CliResolutionError('RUNTIME_NOT_FOUND', `没有找到 ${name}，请先安装并选择实际程序入口`);
  return { command: path, prefixArgs: [] };
}
