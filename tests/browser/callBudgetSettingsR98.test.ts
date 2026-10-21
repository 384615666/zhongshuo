import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CallBudgetSettingsRow,
  callBudgetSettingReadBackMatches,
  callBudgetSettingWrite,
} from '../../src/ui/hifi/pages/SettingsPage.tsx';
import {
  CALL_BUDGET_ENABLED_SETTING_KEY,
  DEFAULT_CALL_BUDGET_LIMITS,
} from '../../src/contracts/callBudget.ts';

describe('R98 AI 设置里的调用预算开关', () => {
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
    expect(html).toContain(`DIRECT ${DEFAULT_CALL_BUDGET_LIMITS.DIRECT}`);
    expect(html).toContain(`AUTO ${DEFAULT_CALL_BUDGET_LIMITS.AUTO}`);
    expect(html).toContain(`双人独立研讨 ${DEFAULT_CALL_BUDGET_LIMITS.DELIBERATE}（随人数调整）`);
  });
});
