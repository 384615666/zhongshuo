/**
 * R203：成员管理卡片直达「AI 设置」的静态合同。
 *
 * 用户反馈：点 AI 成员卡片不再进入单独的「成员详情 / Codex 配置」页，直接打开
 * 同一个「AI 设置」弹窗；旧的 /member/:id 深链回到成员管理页。
 * 运行期点击/重定向行为由 scripts/capture-r203-ui.cjs 在真实 UI 中验证。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('R203 成员卡片直接打开 AI 设置', () => {
  it('member detail page is gone and its route redirects to the members page', () => {
    expect(() => read('src/ui/hifi/pages/MemberDetailPage.tsx')).toThrow();
    const app = read('src/ui/hifi/App.tsx');
    expect(app).not.toContain('MemberDetailPage');
    expect(app).toMatch(/path\.match\(\/\^\\\/project\\\/\(\[\^\/\]\+\)\\\/member\\\/\(\[\^\/\?\]\+\)\$\/\)/);
    expect(app).toContain("return <RedirectTo to={`/project/${m[1] ?? ''}/members`} />;");
    expect(app).not.toContain('/member/${');
  });

  it('AI member cards open the AI settings dialog instead of navigating to a detail page', () => {
    const page = read('src/ui/hifi/MembersPage.tsx');
    expect(page).toContain('data-zs-member-card');
    expect(page).toContain('打开 ${m.displayName} 的 AI 设置');
    expect(page).toContain('openBind(m)');
    expect(page).not.toContain('/member/${m.id}');
    expect(page).not.toContain('data-zs-member-detail');
    expect(page).not.toContain('查看 ${m.displayName} 的成员详情');
  });

  it('command palette member entries go to the members page (no removed detail route)', () => {
    const palette = read('src/ui/hifi/components/CommandPalette.tsx');
    expect(palette).toContain('navigate(`/project/${m.projectId}/members`)');
    expect(palette).not.toContain('/member/${m.id}');
  });

  it('user guide describes opening AI settings from the member card', () => {
    const guide = read('docs/user-guide/README.md');
    expect(guide).toContain('点对应成员卡片（或卡片上的 **AI设置…**）直接打开 AI 设置');
  });
});
