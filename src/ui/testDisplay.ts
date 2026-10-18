export interface DisplayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayLike {
  id: number;
  label: string;
  bounds: DisplayRect;
  workArea: DisplayRect;
}

function normalizedLabel(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function parseRect(spec: string | undefined): DisplayRect | null {
  if (spec == null || spec.trim() === '') return null;
  const values = spec.split(/[,\s;]+/).filter(Boolean).map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) throw Error('ZS_TEST_WINDOW_BOUNDS 必须为 x,y,width,height');
  const [x, y, width, height] = values as [number, number, number, number];
  if (width <= 0 || height <= 0) throw Error('ZS_TEST_WINDOW_BOUNDS 的宽高必须大于 0');
  return { x, y, width, height };
}

function containsBounds(outer: DisplayRect, inner: DisplayRect): boolean {
  const tolerance = 1;
  return inner.x >= outer.x - tolerance
    && inner.y >= outer.y - tolerance
    && inner.x + inner.width <= outer.x + outer.width + tolerance
    && inner.y + inner.height <= outer.y + outer.height + tolerance;
}

function displayMatches(display: DisplayLike, spec: string): boolean {
  if (String(display.id) === spec.trim()) return true;
  const wantedLabel = normalizedLabel(spec);
  const actualLabel = normalizedLabel(display.label);
  if (wantedLabel.length > 0 && actualLabel.length > 0 && (actualLabel === wantedLabel || actualLabel.includes(wantedLabel) || wantedLabel.includes(actualLabel))) return true;
  const geometry = (() => {
    try { return parseRect(spec); } catch { return null; }
  })();
  return geometry != null && containsBounds(display.bounds, geometry) && containsBounds(geometry, display.bounds);
}

/** Optional engineering hook. A requested display is fail-closed: no silent primary fallback. */
export function resolveDisplayPlacement(input: {
  displays: DisplayLike[];
  primaryId: number;
  displaySpec?: string;
  boundsSpec?: string;
  current: DisplayRect;
}): { display: DisplayLike; bounds: DisplayRect } | null {
  const hasDisplay = input.displaySpec != null && input.displaySpec.trim().length > 0;
  const explicit = parseRect(input.boundsSpec);
  if (!hasDisplay && explicit == null) return null;
  const display = hasDisplay
    ? input.displays.find((candidate) => displayMatches(candidate, input.displaySpec!))
    : input.displays.find((candidate) => containsBounds(candidate.bounds, explicit!));
  if (display == null) throw Error(`未找到测试显示目标：${input.displaySpec ?? input.boundsSpec}`);
  if (display.id === input.primaryId) throw Error('可见测试拒绝使用主屏；请指定非主屏');
  if (explicit != null) {
    if (!containsBounds(display.bounds, explicit)) throw Error(`测试窗口 ${JSON.stringify(explicit)} 超出 ${display.label || display.id} 范围`);
    return { display, bounds: explicit };
  }
  const width = Math.max(320, Math.min(input.current.width, display.workArea.width - 80));
  const height = Math.max(240, Math.min(input.current.height, display.workArea.height - 80));
  return {
    display,
    bounds: {
      x: display.workArea.x + Math.round((display.workArea.width - width) / 2),
      y: display.workArea.y + Math.round((display.workArea.height - height) / 2),
      width,
      height,
    },
  };
}
