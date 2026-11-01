import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WriteOccupancyLine } from '../../src/ui/hifi/pages/Room.tsx';

describe('R152 real project concurrency select', () => {
  it('room occupancy reports registered holders without inventing a single-writer policy or an adjustable limit', () => {
    const html = renderToStaticMarkup(createElement(WriteOccupancyLine, { lease: { lockDomain: 'fixture', ownerTaskId: 'a', ownerTaskLabel: '甲任务', parallelHolders: ['a', 'b'] } }));
    expect(html).toContain('已登记 2 个任务');
    expect(html).not.toMatch(/依次执行|调整上限|已达上限|正在改文件/);
  });
  it('reads, saves, retries the original unknown command and isolates switched project receipts', async () => {
    const helper = await import(new URL('./helpers/writeConcurrencyR152.cjs', import.meta.url).href) as {
      default: { runVerifier(): Promise<{ ok: boolean; checks: Array<{ name: string; ok: boolean }>; evidence: string }> };
    };
    const result = await helper.default.runVerifier();
    expect(result.checks.filter(c => !c.ok), result.evidence).toEqual([]);
    expect(result.ok).toBe(true);
  }, 40_000);
});
