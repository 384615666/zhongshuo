import { readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { AdapterCallError } from '../../contracts/runtime.ts';

export type ExternalRuntimeKind = 'deepseek-harness' | 'pi';
export interface AgentExecutable { command: string; prefixArgs: string[] }
const bin = (kind: ExternalRuntimeKind) => kind === 'deepseek-harness' ? 'dsh' : 'pi';
const file = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };

/** Resolve an installed CLI without invoking a shell or evaluating its shim. */
export function resolveAgentExecutable(kind: ExternalRuntimeKind, explicit?: string): AgentExecutable {
  const selected = explicit?.trim() || bin(kind);
  if (/[\r\n\0]/.test(selected)) throw new AdapterCallError('VALIDATION_INVALID', '执行程序引用含无效字符', true);
  let path = selected;
  if (!isAbsolute(path) && !/[\\/]/.test(path)) {
    const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
    const found = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
      .flatMap(dir => suffixes.map(suffix => join(dir, path + suffix))).find(file);
    if (found) path = found;
  } else path = resolve(path);
  if (/\.(?:mjs|cjs|js)$/i.test(path)) return { command: process.execPath, prefixArgs: [path] };
  if (/\.(?:cmd|bat)$/i.test(path)) {
    let text: string;
    try { text = readFileSync(path, 'utf8'); }
    catch { throw new AdapterCallError('RUNTIME_NOT_FOUND', `无法读取 ${bin(kind)} 的启动入口`, true); }
    // npm/pnpm generated shims quote their script target. Never execute arbitrary
    // batch content, cmd.exe, PowerShell, or text from a user prompt.
    const targets = [...text.matchAll(/"([^"\r\n]+\.(?:mjs|cjs|js))"/gi)];
    const target = targets.at(-1)?.[1];
    if (!target) throw new AdapterCallError('CAPABILITY_UNSUPPORTED', `${bin(kind)} 的启动脚本无法解析，请选择实际 .js 或 .exe 程序`, true);
    const script = resolve(target.replace(/%~?dp0%?|\$basedir/gi, dirname(path)));
    if (!file(script)) throw new AdapterCallError('RUNTIME_NOT_FOUND', `${bin(kind)} 的脚本目标不存在`, true);
    const siblingNode = join(dirname(path), 'node.exe');
    return { command: file(siblingNode) ? siblingNode : process.execPath, prefixArgs: [script] };
  }
  if (process.platform === 'win32' && !['.exe', '.com'].includes(extname(path).toLowerCase()))
    throw new AdapterCallError('RUNTIME_NOT_FOUND', `没有找到 ${bin(kind)}，请先安装并选择实际程序入口`, true);
  return { command: path, prefixArgs: [] };
}
