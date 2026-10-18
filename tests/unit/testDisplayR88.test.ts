import { describe, expect, it } from 'vitest';
import { resolveDisplayPlacement, type DisplayLike } from '../../src/ui/testDisplay.ts';

const displays: DisplayLike[] = [
  { id: 1, label: 'Primary', bounds: { x: 0, y: 0, width: 3440, height: 1440 }, workArea: { x: 0, y: 0, width: 3440, height: 1380 } },
  { id: 3, label: '\\\\.\\DISPLAY3', bounds: { x: 3440, y: -444, width: 3440, height: 1440 }, workArea: { x: 3440, y: -444, width: 3440, height: 1380 } },
];

describe('R88 fail-closed non-primary visible-test placement', () => {
  it('uses the explicitly requested non-primary display and exact window rectangle', () => {
    expect(resolveDisplayPlacement({
      displays,
      primaryId: 1,
      displaySpec: 'DISPLAY3',
      boundsSpec: '3960,-404,2400,1280',
      current: { x: 0, y: 0, width: 1280, height: 800 },
    })).toEqual({
      display: displays[1],
      bounds: { x: 3960, y: -404, width: 2400, height: 1280 },
    });
  });

  it('can identify a screen by exact geometry when Windows display labels are unavailable', () => {
    expect(resolveDisplayPlacement({
      displays,
      primaryId: 1,
      displaySpec: '3440,-444,3440,1440',
      boundsSpec: '3960,-404,2400,1280',
      current: { x: 0, y: 0, width: 1280, height: 800 },
    })?.display.id).toBe(3);
  });

  it('never falls back to the primary screen and rejects off-screen rectangles', () => {
    expect(() => resolveDisplayPlacement({ displays, primaryId: 1, displaySpec: 'DISPLAY3', boundsSpec: '0,0,1200,800', current: { x: 0, y: 0, width: 1280, height: 800 } })).toThrow(/超出/);
    expect(() => resolveDisplayPlacement({ displays, primaryId: 1, displaySpec: 'missing', current: { x: 0, y: 0, width: 1280, height: 800 } })).toThrow(/未找到/);
    expect(() => resolveDisplayPlacement({ displays, primaryId: 1, displaySpec: 'Primary', current: { x: 0, y: 0, width: 1280, height: 800 } })).toThrow(/主屏/);
  });
});
