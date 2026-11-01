import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExecutionConcurrencyPanel } from '../../src/ui/hifi/components/ExecutionConcurrencyPanel.tsx';
import { searchAppSettings, SettingsPage } from '../../src/ui/hifi/pages/SettingsPage.tsx';

describe('R153 execution concurrency settings UI', () => {
  it('searches the real AI settings panel and keeps unread values unconfirmed', () => {
    for (const query of ['并发', '同时运行', '每项目', '同渠道', 'concurrency']) expect(searchAppSettings(query)).toContainEqual(expect.objectContaining({ section: 'runtime', match: 'execution-concurrency' }));
    expect(renderToStaticMarkup(createElement(SettingsPage, { query: { section: 'runtime' } }))).toContain('data-settings-row="execution-concurrency"');
    const html = renderToStaticMarkup(createElement(ExecutionConcurrencyPanel));
    expect(html).toContain('读取中…');
    expect(html).not.toContain('当前上限：');
    expect(html.match(/type="number"/g)).toHaveLength(3);
  });

  it('uses production components to save one atomic setting, read back, retry unknown receipts and isolate late routes', async () => {
    const helper = await import(new URL('./helpers/executionConcurrencyR153.cjs', import.meta.url).href) as {
      default: { runVerifier(): Promise<{ ok: boolean; checks: Array<{ name: string; ok: boolean }>; evidence: string }> };
    };
    const result = await helper.default.runVerifier();
    expect(result.checks.filter(c => !c.ok), result.evidence).toEqual([]);
    expect(result.ok).toBe(true);
  }, 45_000);
});
