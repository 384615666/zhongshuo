import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CallBudgetSettingsRow,
  callBudgetSettingReadBackMatches,
  callBudgetSettingWrite,
  searchAppSettings,
  SettingsPage,
} from '../../src/ui/hifi/pages/SettingsPage.tsx';
import {
  CALL_BUDGET_ENABLED_SETTING_KEY,
  DEFAULT_CALL_BUDGET_LIMITS,
} from '../../src/contracts/callBudget.ts';

describe('R98 AI 设置里的调用预算开关', () => {
  it('常用预算搜索词定位正式 AI 设置中的预算行', () => {
    for (const query of ['调用预算', '调用次数', '次数预算', '预算', ' CALLBUDGET ', 'budget']) {
      expect(searchAppSettings(query)).toContainEqual(expect.objectContaining({
        section: 'runtime', match: 'call-budget',
      }));
    }
    const html = renderToStaticMarkup(createElement(SettingsPage, { query: { section: 'runtime' } }));
    expect(html).toContain('data-settings-row="call-budget"');
    expect(html).toContain('还没有 AI 成员。打开项目后');
    expect(html).toContain('data-zs-call-budget-setting="callBudget.enabled"');
  });

  it('已有头像编辑、归档和重新关联操作可通过设置搜索找到', () => {
    for (const query of ['我的头像', '个人头像', 'AI头像', '更换']) {
      expect(searchAppSettings(query)).toContainEqual(expect.objectContaining({
        section: 'appearance', match: 'appearance-avatar-images',
      }));
    }
    const appearance = renderToStaticMarkup(createElement(SettingsPage, { query: { section: 'appearance' } }));
    expect(appearance).toContain('data-settings-row="appearance-avatar-images"');
    expect(searchAppSettings('归档')).toContainEqual(expect.objectContaining({ section: 'data', match: '归档管理' }));
    expect(searchAppSettings('重新关联')).toContainEqual(expect.objectContaining({ section: 'data', match: '已移除的项目' }));
    const data = renderToStaticMarkup(createElement(SettingsPage, { query: { section: 'data' } }));
    expect(data).toContain('data-settings-row="归档管理"');
    expect(data).toContain('data-settings-row="已移除的项目"');
    expect(searchAppSettings('  ')).toEqual([]);
    expect(searchAppSettings('repoStatus.visible')).toEqual([]);
  });

  it('实际写入载荷使用稳定键，且回读不接受 null 冒充 false', () => {
    expect(callBudgetSettingWrite(true)).toEqual({ key: CALL_BUDGET_ENABLED_SETTING_KEY, value: 'true' });
    expect(callBudgetSettingWrite(false)).toEqual({ key: CALL_BUDGET_ENABLED_SETTING_KEY, value: 'false' });
    expect(callBudgetSettingReadBackMatches('true', true)).toBe(true);
    expect(callBudgetSettingReadBackMatches('false', false)).toBe(true);
    expect(callBudgetSettingReadBackMatches(null, false)).toBe(false);
    expect(callBudgetSettingReadBackMatches('true', false)).toBe(false);
  });

  it('初始语义为默认关闭、持续计数，并渲染真实默认上限', () => {
    const html = renderToStaticMarkup(createElement(CallBudgetSettingsRow));
    expect(html).toContain(`data-zs-call-budget-setting="${CALL_BUDGET_ENABLED_SETTING_KEY}"`);
    expect(html).toContain('data-zs-call-budget-enabled="false"');
    expect(html).toContain('data-zs-call-budget-enforcement="disabled"');
    expect(html).toContain('data-zs-call-budget-counting="always"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain(
      `data-zs-call-budget-defaults="DIRECT:${DEFAULT_CALL_BUDGET_LIMITS.DIRECT},AUTO:${DEFAULT_CALL_BUDGET_LIMITS.AUTO},DELIBERATE:${DEFAULT_CALL_BUDGET_LIMITS.DELIBERATE}"`,
    );
    expect(html).toContain('默认关闭');
    expect(html).toContain('更改对新请求生效');
    expect(html).toContain(`单人执行 ${DEFAULT_CALL_BUDGET_LIMITS.DIRECT} 次`);
    expect(html).toContain(`自动协作 ${DEFAULT_CALL_BUDGET_LIMITS.AUTO} 次`);
    expect(html).toContain(`双人独立研讨 ${DEFAULT_CALL_BUDGET_LIMITS.DELIBERATE} 次（随人数调整）`);
    const text = html.replace(/<[^>]*>/g, '');
    expect(text).not.toMatch(/DIRECT|AUTO|DELIBERATE/);
    expect(text.match(/默认上限/g)).toHaveLength(1);
  });
});
