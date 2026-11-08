import { describe, expect, it } from 'vitest';
import {
  VIEWER_DISPLAY_NAME_MAX_LENGTH,
  VIEWER_DISPLAY_NAME_SETTING_KEY,
  normalizeViewerDisplayName,
  viewerDisplayLabel,
} from '../../src/contracts/viewerIdentity.ts';

/**
 * R195 第 9 项：用户显示名的合同层。
 * 只验证归一化/回退口径——真值持久化（app.settings）由设置页与 daemon 命令验收。
 */
describe('R195 用户显示名合同', () => {
  it('设置键是稳定的 app.settings 键', () => {
    expect(VIEWER_DISPLAY_NAME_SETTING_KEY).toBe('ui.viewer.displayName');
  });

  it('未设置/空白一律回退「你」，不改变默认观感', () => {
    for (const raw of [null, undefined, '', '   ', '\t\n']) {
      expect(normalizeViewerDisplayName(raw)).toBe('');
      expect(viewerDisplayLabel(raw)).toBe('你');
    }
  });

  it('去掉控制字符、折叠连续空白并去首尾空白', () => {
    expect(normalizeViewerDisplayName('  张三  ')).toBe('张三');
    expect(normalizeViewerDisplayName('张\u0000三')).toBe('张 三');
    expect(normalizeViewerDisplayName('张三\n\n  李四')).toBe('张三 李四');
  });

  it('超长按上限截断，不在保存时整条拒绝', () => {
    const long = '很'.repeat(VIEWER_DISPLAY_NAME_MAX_LENGTH + 8);
    const normalized = normalizeViewerDisplayName(long);
    expect(normalized).toHaveLength(VIEWER_DISPLAY_NAME_MAX_LENGTH);
    expect(normalized.startsWith('很')).toBe(true);
  });

  it('正常名字原样显示，不再包一层「你」', () => {
    expect(viewerDisplayLabel('王五')).toBe('王五');
    expect(viewerDisplayLabel(' 王五 ')).toBe('王五');
  });
});
