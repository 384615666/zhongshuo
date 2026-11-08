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

  it('每个分区一张卡片：段标题 + 行列表（不再有小字说明）', () => {
    const html = page();
    expect((html.match(/data-settings-section="/g) ?? [])).toHaveLength(5);
    expect((html.match(/settings-card-body/g) ?? [])).toHaveLength(5);
    for (const title of ['外观', '通知', 'AI 设置', '数据与存储', '帮助与关于']) {
      expect(html).toContain(`settings-section-title">${title}<`);
    }
    // 用户要求去掉设置页的小字文案：页头说明与各分区说明都不再渲染。
    expect(html).not.toContain('settings-section-sub');
    expect(html).not.toContain('外观、通知、AI、数据与帮助都在这一页');
    expect(html).not.toContain('主题、头像和名字；只在本机生效');
    expect(html).not.toContain('桌面通知总开关。');
    expect(html).not.toContain('调用预算与同时运行的 AI。');
    expect(html).not.toContain('数据位置、备份、草稿与归档。');
    expect(html).not.toContain('手册、链接、版本与诊断。');
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
    // R206：链接说明（含 URL）不再作为小字渲染；入口按钮仍保留。
    expect(html).not.toContain('https://github.com/384615666/zhongshuo');
    expect(html).not.toContain('https://zhongshuo.lsjx.xyz');
    // 手册交给系统浏览器打开，应用内不再嵌 iframe。
    expect(html).not.toContain('<iframe');
  });

  it('设置页不再显示行内小字说明（R206）', () => {
    const html = page();
    for (const copy of [
      '浅色、深色随时切换',
      '默认显示个人和 AI 头像，姓名始终保留',
      '聊天里你自己那一侧显示这张；AI 成员头像在成员管理里设置',
      '聊天里你自己消息的署名；留空继续显示「你」',
      '关闭后，任务完成、需要处理、等待输入或待验收时不再弹出系统通知',
      '默认关闭。开启后，AI 调用达到上限时暂停',
      '选择保存位置；众说正常关闭后复制并逐个核对',
      '查看已归档项目和房间的历史，或恢复使用',
      '用系统默认浏览器打开随程序附带的离线手册',
      '超出上限的任务会等待',
      '所有项目合计',
      '同一成员在同一对话串中仍依次执行',
      '只在本机读取；复制内容不含正文',
      'PNG、JPEG 或 WebP 图片，大小不超过 384 千字节',
      '默认上限：单人执行',
    ]) expect(html).not.toContain(copy);
    expect(html).not.toContain('pset-row-hint');
    expect(html).not.toContain('field-hint');
    // R207：状态小字也不再显示；版本名称改为「本地多Agent协作工作台」。
    const visible = html.replace(/<[^>]*>/g, '');
    expect(visible).not.toContain('当前显示「你」');
    expect(visible).not.toContain('已开启');
    expect(visible).not.toContain('已关闭');
    expect(visible).not.toContain('当前上限');
    expect(html).toContain('众说 · 本地多Agent协作工作台');
    expect(html).not.toContain('本地多成员协作工作台');
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
    // 草稿设置已移除，不再能被搜索到；清理存储仍在。
    expect(searchAppSettings('草稿')).toEqual([]);
    expect(searchAppSettings('清理本地草稿')).toEqual([]);
    expect(searchAppSettings('清理存储')).toContainEqual(expect.objectContaining({ section: 'data' }));
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

  it('去掉草稿的几个设置，保留清理存储', () => {
    const html = page();
    expect(html).not.toContain('草稿保存');
    expect(html).not.toContain('清理本地草稿');
    expect(html).not.toContain('重试保存');
    expect(html).not.toContain('data-zs-draft-retry');
    expect(html).not.toContain('data-zs-draft-recovery-note');
    expect(html).not.toContain('草稿和未确认发送的保存状态');
    expect(html).toContain('清理存储');
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
    // 数据：三个分组（草稿设置已移除）
    expect(html).toContain('数据位置与备份');
    expect(html).not.toContain('>草稿<');
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
