/**
 * 外部链接（R157）：设置页「操作手册 / GitHub / 主页」三类入口的唯一解析点。
 *
 * 纯函数、不 import electron——main 的 IPC 与单测共用同一份白名单：
 * - 只接受枚举目标，**绝不接受调用方传入的任意 URL/路径**（renderer 不能借此外开任意地址）；
 * - 操作手册固定指向随包 renderer/user-guide/index.html（build:ui 打包）；
 * - GitHub 与主页是写死的 https 地址，不经 renderer 传入、也不能被覆盖。
 */
import { join, normalize, sep } from 'node:path';

export type AppLinkTarget = 'manual' | 'github' | 'homepage';

/** 解析结果：随包本地文件（kind=file）或固定外网地址（kind=url）。 */
export type AppLink = { kind: 'file'; path: string } | { kind: 'url'; url: string };

/** 固定外网地址（写死；改地址只能改这里，renderer 无法注入）。 */
export const APP_LINK_URLS = {
  github: 'https://github.com/384615666/zhongshuo',
  homepage: 'https://zhongshuo.lsjx.xyz',
} as const satisfies Record<Exclude<AppLinkTarget, 'manual'>, string>;

/**
 * 解析外部链接目标（rendererRoot=main 侧的 dist/ui/renderer 绝对路径）。
 * 非枚举目标一律抛错——调用方传任意 URL/路径都不会被打开。
 */
export function resolveAppLink(target: AppLinkTarget, rendererRoot: string): AppLink {
  if (target === 'manual') {
    if (typeof rendererRoot !== 'string' || rendererRoot.length === 0) {
      throw new Error('外部链接缺少渲染目录（rendererRoot）');
    }
    // 固定相对段拼接，再按根前缀复核（与 zsres 处理器同法：越界即拒绝）。
    const manualPath = normalize(join(rendererRoot, 'user-guide', 'index.html'));
    const root = normalize(rendererRoot);
    const rootPrefix = root.endsWith(sep) ? root : root + sep; // 容忍带尾分隔符的根
    if (manualPath !== root && !manualPath.startsWith(rootPrefix)) {
      throw new Error('操作手册路径越界拒绝');
    }
    return { kind: 'file', path: manualPath };
  }
  if (target === 'github') return { kind: 'url', url: APP_LINK_URLS.github };
  if (target === 'homepage') return { kind: 'url', url: APP_LINK_URLS.homepage };
  throw new Error(`未知的外部链接目标：${String(target)}`);
}
