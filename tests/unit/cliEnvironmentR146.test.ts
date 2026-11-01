import {afterEach, describe, expect, it, vi} from 'vitest';
import {delimiter} from 'node:path';
import {refreshCliSearchPath} from '../../src/daemon/cliEnvironment.ts';

afterEach(() => vi.unstubAllEnvs());
describe('R146 newly installed CLI search environment', () => {
  it('merges current installer paths into the daemon and preserves its existing search priority', () => {
    vi.stubEnv('PATH', ['C:/old bin', 'C:/old bin'].join(delimiter));
    expect(refreshCliSearchPath(() => ['"C:/new 中文 bin"', 'C:/old bin', ''])).toBeNull();
    expect(process.env.PATH?.split(delimiter)).toEqual(['C:/old bin', 'C:/new 中文 bin']);
  });
  it('keeps the old environment when reading Windows settings fails and explains the recovery action', () => {
    vi.stubEnv('PATH', 'original');
    expect(refreshCliSearchPath(() => {throw Error('fixture failure');})).toContain('重新打开再扫描');
    expect(process.env.PATH).toBe('original');
  });
});
