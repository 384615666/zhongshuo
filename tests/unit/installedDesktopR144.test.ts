import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { installedDaemonPipe, installedDesktopConfiguration } from '../../src/ui/installedDesktop.ts';

describe('installed desktop entry', () => {
  it('uses a stable data root outside the install directory and ignores inherited overrides', () => {
    const result = installedDesktopConfiguration([], { ZS_APP_DATA: 'old', ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_DAEMON_ENTRY: 'wrong', ZS_PIPE_NAME: 'wrong', ELECTRON_RUN_AS_NODE: '1', CODEX_HOME: 'codex', DSH_HOME: 'dsh', PI_CODING_AGENT_DIR: 'pi', PATH: 'system' }, 'C:/Local');
    expect(result.dataRoot).toBe(resolve('C:/Local/Zhongshuo/data'));
    expect(result.env).toEqual({ ZS_RUNTIME: 'claude', CODEX_HOME: 'codex', DSH_HOME: 'dsh', PI_CODING_AGENT_DIR: 'pi', PATH: 'system' });
  });
  it('accepts a deliberate absolute data selection and keeps engineering display parameters', () => {
    const result = installedDesktopConfiguration(['--data-dir=C:/existing data'], { ZS_DEV25_DEBUG_PORT: '9222', ZS_TEST_DISPLAY: '2', ZS_TEST_PLACEMENT_FILE: 'placement', ZS_REMOTE_SHELL_URL: 'wrong', zs_allow_fake: '1' }, 'C:/Local');
    expect(result.dataRoot).toBe(resolve('C:/existing data'));
    expect(result.env).toEqual({ ZS_RUNTIME: 'claude', ZS_DEV25_DEBUG_PORT: '9222', ZS_TEST_DISPLAY: '2', ZS_TEST_PLACEMENT_FILE: 'placement' });
  });
  it('refuses relative and duplicate selections', () => {
    expect(() => installedDesktopConfiguration(['--data-dir=relative'], {}, 'C:/Local')).toThrow('绝对');
    expect(() => installedDesktopConfiguration(['--data-dir=C:/a', '--data-dir=C:/b'], {}, 'C:/Local')).toThrow('重复');
  });
  it('binds pipe identity to the data root across upgrades and isolates other roots', () => {
    expect(installedDaemonPipe('C:/Local/Zhongshuo/data')).toBe(installedDaemonPipe('c:/local/zhongshuo/data'));
    expect(installedDaemonPipe('C:/a')).not.toBe(installedDaemonPipe('C:/b'));
    expect(installedDaemonPipe('C:/a')).toMatch(/^\\\\\.\\pipe\\zhongshuo-desktop-[a-f0-9]{32}$/);
  });
});
