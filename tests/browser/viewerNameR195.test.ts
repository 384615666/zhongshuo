import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsPage, ViewerNameRow } from '../../src/ui/hifi/pages/SettingsPage.tsx';

/**
 * R195 第 9 项：设置页「我的名字」。
 * 只做静态渲染门：行位置、稳定钩子、默认状态文案与用户文案口径（R191：无括号说明、
 * 无英文错误码）。真实读写在隔离 Electron 截图脚本里走正式 app.settings 命令验收。
 */
describe('R195 设置页我的名字', () => {
  it('外观分区里有「我的名字」行与输入/保存钩子', () => {
    const markup = renderToStaticMarkup(createElement(ViewerNameRow));
    expect(markup).toContain('data-settings-row="appearance-viewer-name"');
    expect(markup).toContain('data-zs-viewer-name-control="1"');
    expect(markup).toContain('data-zs-viewer-name-input="1"');
    expect(markup).toContain('data-zs-viewer-name-save="1"');
    expect(markup).toContain('我的名字');
  });

  it('默认状态明确显示「你」，不冒充已设置名字', () => {
    const markup = renderToStaticMarkup(createElement(ViewerNameRow));
    // SSR 不跑 effect：首帧是读取中状态，但默认值与占位已经说明「未设置=你」。
    expect(markup).toContain('data-zs-viewer-name="default"');
    expect(markup).toContain('data-zs-viewer-name-value=""');
    expect(markup).toContain('placeholder="未设置时显示「你」"');
    expect(markup).not.toContain('data-zs-viewer-name-read-error');
  });

  it('设置页仍是一页五段，并带上名字行', () => {
    const html = renderToStaticMarkup(createElement(SettingsPage, { query: {} }));
    expect((html.match(/data-settings-section="/g) ?? [])).toHaveLength(5);
    expect(html).toContain('data-settings-row="appearance-viewer-name"');
    expect(html).toContain('data-settings-row="appearance-avatar-images"');
  });

  it('提示文案守 R191 口径：不出现括号说明', () => {
    const markup = renderToStaticMarkup(createElement(ViewerNameRow));
    expect(markup).not.toMatch(/[（(][^）)]{1,40}[）)]/);
  });
});
