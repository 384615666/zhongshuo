import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { appSectionOf, searchAppSettings, SettingsPage } from '../../src/ui/hifi/pages/SettingsPage.tsx';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** R157：设置改成单页——所有分区自上而下排在一页，不再有左侧分区菜单；R170 整理版面。 */
const page = (query: Record<string, string> = {}) => renderToStaticMarkup(createElement(SettingsPage, { query }));
const SECTIONS = ['appearance', 'notifications', 'runtime', 'data', 'help'] as const;

describe('R157 单页设置（R170 整理后）', () => {
  it('把所有分区放在同一页里，不再有左侧分区菜单', () => {
    const html = page();
    expect(html).toContain('settings-single');
    for (const section of SECTIONS) {
      expect(html).toContain(`data-settings-section="${section}"`);
    }
    // 通用段已删：不再有 general 分区。
    expect(html).not.toContain('data-settings-section="general"');
    expect(html).not.toContain('settings-nav');
    expect(html).not.toContain('aria-current="page"');
    // 段落顺序固定：外观 → 通知 → AI 设置 → 数据与存储 → 帮助与关于。
    const positions = SECTIONS.map((section) => html.indexOf(`data-settings-section="${section}"`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('每个分区一张卡片：段标题 + 一句说明 + 行列表', () => {
    const html = page();
    expect((html.match(/data-settings-section="/g) ?? [])).toHaveLength(5);
    expect((html.match(/settings-card-body/g) ?? [])).toHaveLength(5);
    for (const title of ['外观', '通知', 'AI 设置', '数据与存储', '帮助与关于']) {
      expect(html).toContain(`settings-section-title">${title}<`);
    }
    // 每段只有一句说明，且 ≤24 字，不再有重复解释段落。
    const subs = Array.from(html.matchAll(/settings-section-sub">([^<]*)</g), (m) => m[1]);
    expect(subs).toHaveLength(5);
    for (const sub of subs) expect(sub.length).toBeLessThanOrEqual(24);
  });

  it('删除了通用、对话串通知与 AI 成员的模型权限', () => {
    const html = page();
    expect(html).not.toContain('>通用<');
    expect(html).not.toContain('启动时打开的项目');
    expect(html).not.toContain('对话串通知');
    expect(html).not.toContain('data-zs-notification-settings');
    expect(html).not.toContain('投递记录');
    expect(html).not.toContain('AI 成员的模型与权限');
    expect(html).not.toContain('还没有 AI 成员');
    // 通知段只剩桌面通知总开关。
    expect(html).toContain('data-zs-notification-master="1"');
    expect(html).not.toContain('data-zs-notification-read-error');
    // AI 设置段只剩调用预算与同时运行的 AI。
    expect(html).toContain('调用次数预算');
    expect(html).toContain('data-settings-row="execution-concurrency"');
  });

  it('顶部保留「设置」标题与搜索，并新增分区锚点 chips', () => {
    const html = page();
    expect(html).toContain('page-title">设置<');
    expect(html).toContain('aria-label="搜索设置项"');
    expect(html).toContain('settings-chips');
    for (const section of SECTIONS) {
      expect(html).toContain(`data-settings-chip="${section}"`);
    }
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
    // general 段已删：解析为 general，由页面滚到顶部（不 404、不空白）。
    expect(appSectionOf('general')).toBe('general');
    expect(appSectionOf('help')).toBe('help');
    expect(appSectionOf('guide')).toBe('help');
    expect(appSectionOf('manual')).toBe('help');
    expect(appSectionOf('connections')).toBe('general');
    expect(appSectionOf('lan')).toBe('general');
    expect(appSectionOf('ai')).toBe('runtime');
    expect(appSectionOf(undefined)).toBe('general');
    expect(appSectionOf('nonsense')).toBe('general');
  });

  it('搜索只索引现存设置项', () => {
    expect(searchAppSettings('手册')).toContainEqual(expect.objectContaining({ section: 'help', match: 'open-manual' }));
    expect(searchAppSettings('github')).toContainEqual(expect.objectContaining({ section: 'help', match: 'open-github' }));
    expect(searchAppSettings('主页')).toContainEqual(expect.objectContaining({ section: 'help', match: 'open-homepage' }));
    expect(searchAppSettings('通知')).toContainEqual(expect.objectContaining({ section: 'notifications' }));
    // 被删内容不再可从搜索找到。
    expect(searchAppSettings('启动时打开的项目')).toEqual([]);
    expect(searchAppSettings('启动')).toEqual([]);
    expect(searchAppSettings('对话串')).toEqual([]);
    expect(searchAppSettings('AI 成员')).toEqual([]);
    expect(searchAppSettings('通用')).toEqual([]);
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

  /** R158/R170 排版：卡片分组、控件右对齐、去重、保留 data-zs-* 选择器。 */
  it('每个分区都按卡片分组，控件统一在右列', () => {
    const html = page();
    // 外观：主题与显示头像都在右列控件里，不再堆在名称下面
    expect(html).toMatch(/data-settings-row="appearance-theme"[\s\S]{0,400}?pset-row-control[\s\S]{0,200}?seg/);
    expect(html).toMatch(/data-settings-row="appearance-avatars"[\s\S]{0,400}?pset-row-control[\s\S]{0,300}?switch/);
    // 我的头像：卡片标题已说明，不重复「头像」字段名
    expect(html).not.toContain('field-label">头像<');
    // 通知：行标签是开关本身的含义，不再重复同一个词
    expect(html).toContain('允许弹出系统通知');
    // 数据：三个分组
    expect(html).toContain('数据位置与备份');
    expect(html).toContain('>草稿<');
    expect(html).toContain('归档与项目');
    // 保留既有 data-zs-* 选择器（验收脚本依赖）
    for (const selector of [
      'data-zs-avatar-settings="1"',
      'data-zs-notification-master="1"',
      'data-zs-data-guide="1"',
      'data-zs-app-links="1"',
      'data-zs-call-budget-setting=',
      'data-zs-open-link="manual"',
    ]) expect(html).toContain(selector);
  });

  it('页头吸顶、搜索结果是浮层，正文 880px 居中', () => {
    const shared = readFileSync(resolve(root, 'src/ui/hifi/styles/components.css'), 'utf8');
    expect(shared).toMatch(/\.settings-head\s*\{[^}]*position:\s*sticky/);
    expect(shared).toMatch(/\.settings-search-results\s*\{[^}]*position:\s*absolute/);

    const own = readFileSync(resolve(root, 'src/ui/hifi/styles/r170-settings.css'), 'utf8');
    expect(own).toMatch(/\.settings-single\s*\{[^}]*max-width:\s*880px/);
    expect(own).toMatch(/@media \(max-width: 760px\)/);
  });

  it('私信页与房间页共用同一主区底色', () => {
    const dm = readFileSync(resolve(root, 'src/ui/hifi/DmPage.tsx'), 'utf8');
    expect(dm).toContain('<div className="main"');
    const base = readFileSync(resolve(root, 'src/ui/hifi/styles/base.css'), 'utf8');
    expect(base).toMatch(/\.main\s*\{[^}]*background:\s*var\(--bg-surface\)/);
  });
});
