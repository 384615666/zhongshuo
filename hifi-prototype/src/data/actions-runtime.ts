/**
 * 执行工具（runtime）的接入配置动作（§4.1「工具配置」）。
 *
 * §4.1 要求正文回答四个问题：**我怎么接入一个工具？现在登录的是谁？用订阅还是 API 配置？
 * 为什么不能用？** 这份动作文件负责其中的"改配置"那一半：
 * 可执行文件位置、认证方式、连接配置，按「用户操作 / 保存结果 / 生效时机 / 失败处理」定义。
 *
 * 边界必须如实：原型**不检查路径是否存在**（没有文件系统访问），也**不读取账号信息**（
 * 凭据在 runtime 自己的凭据存储里）。所以这里的校验只做"结构上能判定的那部分"，
 * 不能判定的（路径存在性、账号名）在界面上明确标为未验证，不猜。
 */

import { getState, recordLocalOnly, setState, toast } from './store';
import type { RuntimeConfig } from './types';

export type RuntimeConfigResult = { ok: true } | { ok: false; error: string };

/** 绝对路径：Windows 盘符 / UNC，或 POSIX 根路径 */
export function isAbsolutePath(p: string): boolean {
  const t = p.trim();
  if (!t) return false;
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (t.startsWith('\\\\')) return true;
  return t.startsWith('/');
}

/**
 * 校验一份配置草稿（创建与编辑共用同一套规则）。
 * 不合法时返回原因，由调用方**留在编辑态**并显示行内错误 —— 不写入状态。
 */
export function validateRuntimeConfigDraft(draft: {
  executablePath: string;
  authMode: string;
  connectionArgs: string;
}): string | null {
  const p = draft.executablePath.trim();
  if (!p) return '请填可执行文件位置：没有它，这个工具无法启动。';
  if (!isAbsolutePath(p)) {
    return '要填绝对路径（如 C:\\…\\codex.cmd 或 /usr/local/bin/claude）—— 相对路径会随工作目录变化，不能用。';
  }
  if (draft.authMode !== 'subscription' && draft.authMode !== 'api-key') {
    return '认证方式只能是「订阅登录」或「API key」。';
  }
  const args = draft.connectionArgs.trim();
  if (args.length > 200) return '连接参数太长（上限 200 字符）。';
  if (/[\r\n]/.test(draft.connectionArgs)) return '连接参数不能包含换行。';
  return null;
}

/**
 * 保存一份接入配置。
 *
 * 用户操作：改路径 / 认证方式 / 连接参数后点保存。
 * 保存结果：写入本机配置（原型写内存值，并留痕）。
 * 生效时机：立即生效 —— 正在运行的 turn 用旧配置跑完，下一个 turn 用新配置。
 * 失败处理：校验不过就**不写入**并把原因回给界面（行内显示），不显示成功。
 */
export function updateRuntimeConfig(
  runtimeId: string,
  patch: Partial<Pick<RuntimeConfig, 'executablePath' | 'authMode' | 'connectionArgs'>>,
): RuntimeConfigResult {
  const s = getState();
  const cur = s.runtimeConfigs[runtimeId];
  if (!cur) return { ok: false, error: '这个工具没有可配置项（未检测到安装记录）。' };

  const draft = {
    executablePath: patch.executablePath ?? cur.executablePath,
    authMode: patch.authMode ?? cur.authMode,
    connectionArgs: patch.connectionArgs ?? cur.connectionArgs,
  };
  const bad = validateRuntimeConfigDraft(draft);
  if (bad) return { ok: false, error: bad };

  const next: RuntimeConfig = {
    ...cur,
    executablePath: draft.executablePath.trim(),
    authMode: draft.authMode as RuntimeConfig['authMode'],
    connectionArgs: draft.connectionArgs.trim(),
    updatedAt: Date.now(),
  };
  setState((st) => ({ ...st, runtimeConfigs: { ...st.runtimeConfigs, [runtimeId]: next } }));
  recordLocalOnly(
    'runtime.config.update',
    `runtime=${runtimeId} path=${next.executablePath} auth=${next.authMode} args="${next.connectionArgs}"（原型只改内存配置，不写本机配置文件）`,
  );
  toast('配置已保存：立即生效；正在运行的 turn 会用旧配置跑完，下一个 turn 用新的', 'success');
  return { ok: true };
}
