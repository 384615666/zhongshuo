/**
 * R201：用户 2026-11-08 第 8 轮 6 条界面反馈的静态合同。
 *
 * 运行期几何/截图见 scripts/capture-r201-ui.cjs（21 项断言）；本文件只钉住
 * 源码层容易回退的几处：file:/// 解析、标题栏项目下拉移除、命令面板键盘提示移除、
 * 工作区按钮内边距、LiveProgress 单行样式。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localPathFromFileHref } from '../../src/ui/hifi/lib/localFileHref.ts';

const root = resolve(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('R201 第 6 项：file:/// 本地文件链接', () => {
  it('parses Windows file URLs with spaces and encoded characters', () => {
    expect(localPathFromFileHref('file:///C:/Users/Public/Documents/%E7%A4%BA%E4%BE%8B%20%E5%9B%BE%E7%89%87.png'))
      .toBe('C:\\Users\\Public\\Documents\\示例 图片.png');
    expect(localPathFromFileHref('file:///D:/a%20b/c.txt')).toBe('D:\\a b\\c.txt');
    expect(localPathFromFileHref('file:///C:/plain/x.png')).toBe('C:\\plain\\x.png');
  });
  it('supports UNC paths and rejects non-file URLs', () => {
    expect(localPathFromFileHref('file://server/share/x.png')).toBe('\\\\server\\share\\x.png');
    expect(localPathFromFileHref('https://example.invalid/x.png')).toBeNull();
    expect(localPathFromFileHref('file:relative.png')).toBeNull();
    expect(localPathFromFileHref('mailto:a@b')).toBeNull();
  });
  it('markdown inline renders image syntax as a local file entry (no ! prefix)', () => {
    const source = read('src/ui/hifi/preview/MarkdownView.tsx');
    expect(source).toContain('(!?\\[[^\\]]*\\]\\([^)]+\\)');
    expect(source).toContain('localPathFromFileHref(m[3])');
    expect(source).toContain('复制文件地址');
    expect(source).toContain('用默认程序打开');
    expect(source).toContain('在文件管理器中显示');
    expect(source).toContain('md-file-link-name');
  });
});

describe('R201 第 1–5 项：标题栏 / 工作区按钮 / 命令面板 / 最近活动', () => {
  it('workspace open button has no inherited padding (hover overlay centered)', () => {
    const base = read('src/ui/hifi/styles/base.css');
    expect(base).toMatch(/\.side-heading button\s*\{[\s\S]*?width: 20px;[\s\S]*?height: 20px;[\s\S]*?padding: 0;[\s\S]*?flex: none;/);
  });
  it('workspace button title is only 打开新的工作区', () => {
    const app = read('src/ui/hifi/App.tsx');
    expect(app).toContain('title="打开新的工作区"');
    expect(app).toContain("aria-label={folderPickerBusy ? '正在打开新的工作区' : '打开新的工作区'}");
    expect(app).not.toContain('打开/切换工作区');
  });
  it('titlebar no longer has the project switcher component', () => {
    const source = read('src/ui/hifi/components/TitleBar.tsx');
    expect(source).not.toContain('zs-tb-project');
    expect(source).not.toContain('ProjectMenu');
    expect(source).not.toContain('data-zs-project-menu-btn');
  });
  it('command palette no longer shows the Esc/Enter key hints', () => {
    const source = read('src/ui/hifi/components/CommandPalette.tsx');
    expect(source).not.toContain('退出键');
    expect(source).not.toContain('回车键');
    expect(source).not.toContain('<span className="kbd">');
    expect(source).toMatch(/placeholder="搜索页面、房间、私信、成员、任务、消息…"/);
  });
  it('live progress keeps the recent-activity label on one truncated line', () => {
    const css = read('src/ui/hifi/styles/components.css');
    expect(css).toMatch(/\.live-progress-activity\s*\{[\s\S]*?flex-wrap: nowrap;/);
    expect(css).toMatch(/\.live-progress-activity-text\s*\{[\s\S]*?white-space: nowrap;[\s\S]*?text-overflow: ellipsis;/);
    expect(css).toMatch(/\.live-progress-ago\s*\{[\s\S]*?white-space: nowrap;/);
    const source = read('src/ui/hifi/components/LiveProgress.tsx');
    expect(source).toContain('live-progress-activity-text');
    expect(source).toContain('live-progress-ago');
  });
});
