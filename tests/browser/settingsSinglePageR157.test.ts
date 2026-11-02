import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { appSectionOf, searchAppSettings, SettingsPage } from '../../src/ui/hifi/pages/SettingsPage.tsx';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** R157：设置改成单页——所有分区自上而下排在一页，不再有左侧分区菜单。 */
const page = (query: Record<string, string> = {}) => renderToStaticMarkup(createElement(SettingsPage, { query }));

describe('R157 单页设置', () => {
  it('把所有分区放在同一页里，不再有左侧分区菜单', () => {
    const html = page();
    expect(html).toContain('settings-single');
    for (const section of ['general', 'appearance', 'notifications', 'runtime', 'data', 'help']) {
      expect(html).toContain(`data-settings-section="${section}"`);
    }
    expect(html).not.toContain('settings-nav');
    expect(html).not.toContain('aria-current="page"');
    // 段落顺序固定：通用 → 外观 → 通知 → AI 设置 → 数据与存储 → 帮助与关于。
    const positions = ['general', 'appearance', 'notifications', 'runtime', 'data', 'help']
      .map((section) => html.indexOf(`data-settings-section="${section}"`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('隐藏「打开一个定位链接」与整段「连接与设备」', () => {
    const html = page();
    expect(html).not.toContain('打开一个定位链接');
    expect(html).not.toContain('定位链接');
    expect(html).not.toContain('连接与设备');
    expect(html).not.toContain('远程访问');
    expect(html).not.toContain('配对码');
  });

  it('去掉 AI 设置里的运行状态详情', () => {
    const html = page();
    expect(html).not.toContain('运行环境详情');
    expect(html).not.toContain('本机运行状态');
    expect(html).not.toContain('本机当前能否发送真实任务');
    expect(html).not.toContain('日常运行');
  });

  it('帮助与关于提供操作手册、GitHub 与产品主页的外部入口', () => {
    const html = page();
    for (const target of ['manual', 'github', 'homepage']) expect(html).toContain(`data-zs-open-link="${target}"`);
    expect(html).toContain('https://github.com/384615666/zhongshuo');
    expect(html).toContain('https://zhongshuo.lsjx.xyz');
    // 手册交给系统浏览器打开，应用内不再嵌 iframe。
    expect(html).not.toContain('<iframe');
  });

  it('深链仍按分区解析，旧写法映射到现分区', () => {
    expect(appSectionOf('general')).toBe('general');
    expect(appSectionOf('help')).toBe('help');
    expect(appSectionOf('guide')).toBe('help');
    expect(appSectionOf('manual')).toBe('help');
    expect(appSectionOf('connections')).toBe('general');
    expect(appSectionOf('lan')).toBe('general');
    expect(appSectionOf(undefined)).toBe('general');
    expect(appSectionOf('nonsense')).toBe('general');
  });

  it('搜索仍能定位到单页里的具体设置行', () => {
    expect(searchAppSettings('手册')).toContainEqual(expect.objectContaining({ section: 'help', match: 'open-manual' }));
    expect(searchAppSettings('github')).toContainEqual(expect.objectContaining({ section: 'help', match: 'open-github' }));
    expect(searchAppSettings('主页')).toContainEqual(expect.objectContaining({ section: 'help', match: 'open-homepage' }));
    expect(searchAppSettings('通知')).toContainEqual(expect.objectContaining({ section: 'notifications' }));
  });

  it('不再出现开发过程的说明文字', () => {
    const html = page();
    for (const text of [
      '还没有设置过对话串通知',
      '可在对话串右上角菜单中设置静音',
      '本地偏好键',
      '本机用户 ID',
      'zs.hifi.persist',
    ]) {
      expect(html).not.toContain(text);
    }
  });

  /** R158 排版精修：卡片分组、控件右对齐、去重、折叠。 */
  it('每个分区都按卡片分组，控件统一在右列', () => {
    const html = page();
    // 外观：主题与显示头像都在右列控件里，不再堆在名称下面
    expect(html).toMatch(/data-settings-row="appearance-theme"[\s\S]{0,400}?pset-row-control[\s\S]{0,200}?seg/);
    expect(html).toMatch(/data-settings-row="appearance-avatars"[\s\S]{0,400}?pset-row-control[\s\S]{0,300}?switch/);
    // 我的头像：卡片标题已说明，不再重复「头像」字段名
    expect(html).not.toContain('field-label">头像<');
    // 通知：卡片标题「桌面通知」，行标签是开关本身的含义，不再重复同一个词
    expect(html).toContain('允许弹出系统通知');
    // 投递记录收进折叠区
    expect(html).toContain('投递记录（本机排查用）');
    expect(html).toMatch(/data-zs-notification-delivery="1"[\s\S]{0,400}?settings-why/);
    // AI 设置：预算与成员各自成卡
    expect(html).toContain('调用次数预算');
    expect(html).toContain('AI 成员');
    // 数据：三个卡片分组
    expect(html).toContain('数据位置与备份');
    expect(html).toContain('草稿');
    expect(html).toContain('归档与项目');
  });

  it('页头吸顶、搜索结果是浮层', () => {
    const css = readFileSync(resolve(root, 'src/ui/hifi/styles/components.css'), 'utf8');
    expect(css).toMatch(/\.settings-head\s*\{[^}]*position:\s*sticky/);
    expect(css).toMatch(/\.settings-search-results\s*\{[^}]*position:\s*absolute/);
    // 段间不再画第二条线（页头已有一条发丝线）
    expect(css).not.toMatch(/\.settings-section \+ \.settings-section\s*\{[^}]*border-top/);
  });

  it('私信页与房间页共用同一主区底色', () => {
    const dm = readFileSync(resolve(root, 'src/ui/hifi/DmPage.tsx'), 'utf8');
    expect(dm).toContain('<div className="main"');
    const base = readFileSync(resolve(root, 'src/ui/hifi/styles/base.css'), 'utf8');
    expect(base).toMatch(/\.main\s*\{[^}]*background:\s*var\(--bg-surface\)/);
  });
});
