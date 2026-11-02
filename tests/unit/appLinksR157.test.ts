import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_LINK_URLS, resolveAppLink, type AppLink, type AppLinkTarget } from '../../src/ui/appLinks.ts';

/**
 * R157：设置页「操作手册 / GitHub / 主页」外部链接——纯函数白名单 + main IPC 来源校验 +
 * preload 只转发枚举目标 + bridge 帮助函数。源码契约断言直接读真实文件（main/preload/bridge），
 * 防止后续改动把「只接受枚举」退化成「打开调用方给的地址」。
 */

const rendererRoot = resolve('fixture', 'dist', 'ui', 'renderer');
const source = (rel: string): string => readFileSync(new URL(`../../src/ui/${rel}`, import.meta.url), 'utf8');

/** 取出 main.ts 中某个 ipcMain.handle 的处理函数源码（到下一个同缩进注册为止）。 */
function handlerBlock(src: string, channel: string): string {
  const start = src.indexOf(`ipcMain.handle('${channel}'`);
  expect(start).toBeGreaterThan(-1);
  const next = src.indexOf('\n  ipcMain.handle(', start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

function expectFileLink(link: AppLink): { kind: 'file'; path: string } {
  expect(link.kind).toBe('file');
  return link as { kind: 'file'; path: string };
}

// bridge.ts 是 hifi 模块（依赖 window/DOM），不在根 tsconfig 的检查面内——按 R152 对 main.ts
// 的做法在内存里转译后放进 vm 执行：验证真实函数体，且不给根类型检查引入 DOM 依赖。
const bridgeCode = ts.transpileModule(readFileSync(new URL('../../src/ui/hifi/bridge.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
}).outputText;

/** 用给定的 window 桩加载 bridge.ts，返回真实导出的 openAppLink。 */
function loadOpenAppLink(windowValue: unknown): (target: string) => Promise<{ ok: boolean; error?: string }> {
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(bridgeCode, {
    module,
    exports: module.exports,
    window: windowValue,
    require: (name: string) => {
      if (name === '../../contracts/userFacingText.ts') return { userFacingSystemText: (text: string) => text };
      if (name === '../../contracts/runtimeMetadataDeadline.ts') {
        return { isRuntimeMetadataRead: () => false, RUNTIME_METADATA_RECEIPT_DEADLINE_MS: 1 };
      }
      throw Error(`Unexpected dependency ${name}`);
    },
    setTimeout,
    clearTimeout,
  });
  return (module.exports as { openAppLink: (target: string) => Promise<{ ok: boolean; error?: string }> }).openAppLink;
}

/** 取被拒绝错误的 message（跨 vm realm 的 Error 不能依赖 instanceof）。 */
async function rejectionMessage(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('electron');
  vi.restoreAllMocks();
});

describe('R157 resolveAppLink 白名单', () => {
  it('manual 解析为 rendererRoot 内的随包操作手册', () => {
    const link = expectFileLink(resolveAppLink('manual', rendererRoot));
    expect(link.path).toBe(join(rendererRoot, 'user-guide', 'index.html'));
    // 相对路径必须落在 rendererRoot 内（不得穿越到根外）。
    const rel = relative(rendererRoot, link.path);
    expect(rel).toBe(join('user-guide', 'index.html'));
    expect(rel.startsWith('..')).toBe(false);
    expect(resolve(link.path).startsWith(resolve(rendererRoot) + sep)).toBe(true);
    // 手册确有打包来源（docs/user-guide/index.html → dist/ui/renderer/user-guide/）。
    expect(existsSync(new URL('../../docs/user-guide/index.html', import.meta.url))).toBe(true);
    // 带尾分隔符的根同样解析到根内同一路径。
    expect(expectFileLink(resolveAppLink('manual', rendererRoot + sep)).path).toBe(link.path);
  });

  it('github / homepage 解析为写死的 https 地址', () => {
    expect(resolveAppLink('github', rendererRoot)).toEqual({ kind: 'url', url: 'https://github.com/384615666/zhongshuo' });
    expect(resolveAppLink('homepage', rendererRoot)).toEqual({ kind: 'url', url: 'https://zhongshuo.lsjx.xyz' });
    expect(APP_LINK_URLS).toEqual({ github: 'https://github.com/384615666/zhongshuo', homepage: 'https://zhongshuo.lsjx.xyz' });
    // 外网地址不受 rendererRoot 影响（renderer 无法注入目标地址）。
    expect(resolveAppLink('github', 'C:\\other-root')).toEqual(resolveAppLink('github', rendererRoot));
    expect(resolveAppLink('homepage', '')).toEqual(resolveAppLink('homepage', rendererRoot));
  });

  it('拒绝任何非枚举目标（URL / 路径 / 大小写变体 / 非字符串）', () => {
    const badTargets = [
      '', 'MANUAL', 'Manual', 'Github', 'github ', ' github', 'manual\n',
      'https://evil.example', 'http://127.0.0.1:9/', 'file:///C:/Windows/System32/calc.exe',
      'user-guide/index.html', '../secret', 'C:\\Windows\\System32\\calc.exe', 'constructor', 'toString', '__proto__',
    ];
    for (const target of badTargets) {
      expect(() => resolveAppLink(target as AppLinkTarget, rendererRoot)).toThrow('未知的外部链接目标');
    }
    for (const target of [null, undefined, 42, {}, [], { kind: 'url', url: 'https://evil.example' }]) {
      expect(() => resolveAppLink(target as unknown as AppLinkTarget, rendererRoot)).toThrow('未知的外部链接目标');
    }
  });

  it('缺少渲染目录时拒绝（不拼出相对手册路径）', () => {
    for (const root of ['', undefined, null]) {
      expect(() => resolveAppLink('manual', root as unknown as string)).toThrow('外部链接缺少渲染目录');
    }
  });

  it('模块本身不 import electron（纯函数，可在无 Electron 环境测试）', () => {
    const appLinksSrc = source('appLinks.ts');
    expect(appLinksSrc).not.toMatch(/from 'electron'/);
    expect(appLinksSrc).toContain("github: 'https://github.com/384615666/zhongshuo'");
    expect(appLinksSrc).toContain("homepage: 'https://zhongshuo.lsjx.xyz'");
  });
});

describe('R157 main 侧 IPC 契约（源码断言）', () => {
  const mainSrc = source('main.ts');
  const block = handlerBlock(mainSrc, 'zs:open-app-link');

  it('先 assertTrustedSender(event)，再触碰 shell', () => {
    const body = block.slice(block.indexOf('{') + 1).trimStart();
    expect(body.startsWith('assertTrustedSender(event);')).toBe(true);
    const trustedAt = block.indexOf('assertTrustedSender(event)');
    expect(trustedAt).toBeGreaterThan(-1);
    expect(block.indexOf('await shell.openPath(')).toBeGreaterThan(trustedAt);
    expect(block.indexOf('await shell.openExternal(')).toBeGreaterThan(trustedAt);
    // 通道只注册一次（重复注册会让后注册的处理函数覆盖校验）。
    expect([...mainSrc.matchAll(/'zs:open-app-link'/g)]).toHaveLength(1);
  });

  it('只把枚举目标交给 resolveAppLink，shell 只打开解析结果', () => {
    expect(block).toMatch(/typeof target !== 'string'/);
    expect(block).toMatch(/resolveAppLink\(\s*target as AppLinkTarget\s*,\s*rendererRoot\s*\)/);
    expect(block).toMatch(/shell\.openPath\(link\.path\)/);
    expect(block).toMatch(/shell\.openExternal\(link\.url\)/);
    // 调用方传入的目标绝不直接进 shell（否则等于开放任意 URL/路径）。
    expect(block).not.toMatch(/openExternal\(\s*target/);
    expect(block).not.toMatch(/openPath\(\s*target/);
    expect(block).not.toMatch(/target\s*\+\s*['"`]|\$\{\s*target\s*\}/);
    // 处理函数内不出现字面地址（地址只在 appLinks 白名单里）。
    expect(block).not.toMatch(/https?:\/\//);
  });

  it('manual 先 existsSync 校验，打开失败一律回执 {ok:false,error}（不抛未处理拒绝）', () => {
    expect(block).toMatch(/existsSync\(link\.path\)/);
    expect(block).toMatch(/\{ ok: false, error: `操作手册文件缺失：\$\{link\.path\}` \}/);
    expect(block).toMatch(/error\.length === 0 \? \{ ok: true \} : \{ ok: false, error \}/);
    // shell 抛错（无默认浏览器等）同样转成 ok:false 回执，界面行内显示原因。
    expect(block).toMatch(/系统未能打开操作手册：/);
    expect(block).toMatch(/系统未能打开链接：/);
    expect(block.match(/catch \(cause\)/g)).toHaveLength(2);
  });

  it('main 复用 appLinks 的解析函数，且不重复实现地址表', () => {
    expect(mainSrc).toContain("import type { AppLinkTarget } from './appLinks.ts';");
    expect(block).toMatch(/await import\('\.\/appLinks\.ts'\)/);
    expect(block).not.toContain('github.com');
    expect(block).not.toContain('zhongshuo.lsjx.xyz');
  });
});

describe('R157 preload 只转发枚举目标', () => {
  it('只暴露 open(target) → invoke(zs:open-app-link, target)，不拼 URL/路径', () => {
    const preloadSrc = source('preload.ts');
    expect(preloadSrc).toContain("contextBridge.exposeInMainWorld('zsAppLinks'");
    expect([...preloadSrc.matchAll(/invoke\('zs:open-app-link'/g)]).toHaveLength(1);
    const start = preloadSrc.indexOf("exposeInMainWorld('zsAppLinks'");
    const end = preloadSrc.indexOf('});', start);
    const exposed = preloadSrc.slice(start, end + 3);
    expect(exposed).toMatch(/open:\s*\(target: AppLinkTarget\):\s*Promise<\{ ok: boolean; error\?: string \}>/);
    expect(exposed).toMatch(/ipcRenderer\.invoke\('zs:open-app-link', target\)/);
    expect(exposed).not.toMatch(/https?:\/\//);
    expect(exposed).not.toMatch(/openPath|openExternal|join\(|resolve\(/);
  });

  it('运行时：exposeInMainWorld 收到的 zsAppLinks 只把枚举目标原样转发', async () => {
    const exposeInMainWorld = vi.fn();
    const invoke = vi.fn(async () => ({ ok: true }));
    vi.doMock('electron', () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
    }));
    vi.resetModules();
    await import('../../src/ui/preload.ts');
    const exposed = exposeInMainWorld.mock.calls.find(([name]) => name === 'zsAppLinks')?.[1] as
      { open: (target: AppLinkTarget) => Promise<{ ok: boolean; error?: string }> } | undefined;
    expect(exposed).toBeDefined();
    expect(Object.keys(exposed!)).toEqual(['open']);
    for (const target of ['manual', 'github', 'homepage'] as const) {
      await expect(exposed!.open(target)).resolves.toEqual({ ok: true });
      expect(invoke).toHaveBeenLastCalledWith('zs:open-app-link', target);
    }
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});

describe('R157 bridge.openAppLink 帮助函数', () => {
  it('桥缺失时抛中文可读错误', async () => {
    const missing = loadOpenAppLink({});
    expect(await rejectionMessage(() => missing('manual'))).toBe('外部链接入口不可用，请重新打开众说');
    const malformed = loadOpenAppLink({ zsAppLinks: { open: 'not-a-function' } });
    expect(await rejectionMessage(() => malformed('manual'))).toBe('外部链接入口不可用，请重新打开众说');
  });

  it('成功时只转发枚举目标并返回 {ok:true}', async () => {
    const calls: unknown[] = [];
    const open = loadOpenAppLink({ zsAppLinks: { open: async (target: string) => { calls.push(target); return { ok: true }; } } });
    await expect(open('github')).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['github']);
  });

  it('打开失败不抛错：返回 {ok:false,error} 供设置页行内显示', async () => {
    const missingFile = loadOpenAppLink({ zsAppLinks: { open: async () => ({ ok: false, error: '操作手册文件缺失：C:\\x\\index.html' }) } });
    await expect(missingFile('manual')).resolves.toEqual({ ok: false, error: '操作手册文件缺失：C:\\x\\index.html' });
    const noReason = loadOpenAppLink({ zsAppLinks: { open: async () => ({ ok: false }) } });
    await expect(noReason('manual')).resolves.toEqual({ ok: false, error: '系统未返回原因' });
    const noResult = loadOpenAppLink({ zsAppLinks: { open: async () => undefined } });
    await expect(noResult('manual')).resolves.toEqual({ ok: false, error: '系统未返回结果' });
  });

  it('非法目标由 main 拒绝：错误向上抛（设置页 catch 后 toast）', async () => {
    const open = loadOpenAppLink({ zsAppLinks: { open: async () => { throw new Error('未知的外部链接目标：https://evil.example'); } } });
    expect(await rejectionMessage(() => open('manual'))).toBe('未知的外部链接目标：https://evil.example');
  });

  it('bridge 复用 appLinks 的 AppLinkTarget 类型（不重复声明枚举）', () => {
    const bridgeSrc = source('hifi/bridge.ts');
    expect(bridgeSrc).toContain("import type { AppLinkTarget } from '../appLinks.ts';");
    expect(bridgeSrc).toContain('export type { AppLinkTarget };');
    expect(bridgeSrc).toMatch(/export async function openAppLink\(target: AppLinkTarget\): Promise<\{ ok: boolean; error\?: string \}>/);
    expect(bridgeSrc).toContain('api.open(target)');
  });
});
