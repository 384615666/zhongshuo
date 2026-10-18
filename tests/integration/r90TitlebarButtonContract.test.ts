/**
 * R90 titlebar/button contract.
 *
 * These are source-level contracts for a shared style layer that is assembled at
 * build time. They keep the normal titlebar from regressing to permanent runtime
 * badges and pin the compact control sizes/focus states used by project rows,
 * overlays and menus.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('R90 titlebar and shared control contract', () => {
  it('keeps normal titlebar chrome to brand/project and only exposes an actionable connection status when needed', () => {
    const source = read('src/ui/hifi/components/TitleBar.tsx');

    expect(source).not.toContain('guard.fakeAllowed');
    expect(source).not.toContain("command<{ dispatchGuard");
    expect(source).not.toContain("'真实任务'");
    expect(source).not.toContain("'模拟运行'");
    expect(source).not.toContain('>已连接<');
    expect(source).toContain('connectionLabel != null ?');
    expect(source).toContain('className="zs-tb-status zs-tb-no-drag"');
    expect(source).toContain("navigate('/settings?section=help')");
    expect(source).toContain('className="zs-tb-project zs-tb-no-drag"');
    expect(source).toContain('className="zs-tb-project-name"');
    expect(source).not.toContain('<TitleBarStatButton />');
    expect(source).not.toContain('浏览器宿主（窗口控制由桌面客户端提供）');
  });

  it('keeps the drag region and windows controls while making every native control keyboard-typed', () => {
    const source = read('src/ui/hifi/components/TitleBar.tsx');
    const windowButtons = source.match(/type="button" className="zs-winbtn/g) ?? [];

    expect(source).toContain('className="zs-tb-drag"');
    expect(windowButtons).toHaveLength(6); // 3 degraded controls + 3 normal controls
    expect(source).toContain('aria-label="最小化"');
    expect(source).toContain('aria-label="关闭窗口"');
  });

  it('uses shared size/focus/disabled tokens for project rows, overlays and menus', () => {
    const tokens = read('src/ui/hifi/styles/tokens.css');
    const base = read('src/ui/hifi/styles/base.css');
    const titlebar = read('src/ui/hifi/styles/titlebar.css');
    const ui = read('src/ui/hifi/components/ui.tsx');

    expect(tokens).toContain('--control-icon-size: 28px');
    expect(tokens).toContain('--control-icon-compact: 24px');
    expect(tokens).toContain('--control-focus-width: 2px');
    expect(tokens).toContain('--titlebar-window-button-width: 44px');

    expect(base).toMatch(/\.side-caret\s*\{[\s\S]*?width: var\(--control-icon-compact\);[\s\S]*?box-shadow: none;/);
    expect(base).toMatch(/\.side-row-act\s*\{[\s\S]*?width: var\(--control-icon-compact\);/);
    expect(base).toContain('.overlay-head > .overlay-close');
    expect(base).toContain('.menu-item.on:not(:disabled)');
    expect(base).toContain(".icon-btn[aria-pressed='true']");
    expect(base).toContain('R90 控件状态合同');
    expect(base).toContain(':focus-visible');
    expect(base).toContain('aria-disabled');

    expect(titlebar).toContain('#zs-titlebar.zs-titlebar');
    expect(titlebar).toContain('--titlebar-height');
    expect(titlebar).toContain(':is(.zs-tb-project, .zs-tb-status, .zs-winbtn):focus-visible');
    expect(titlebar).toContain('--titlebar-close-bg');

    expect(ui).toContain('function OverlayCloseButton');
    expect(ui).toContain('role="switch"');
    expect(ui).toContain('aria-checked={checked}');
    expect(ui).toContain('type="button" className="icon-btn overlay-close"');
  });
});
