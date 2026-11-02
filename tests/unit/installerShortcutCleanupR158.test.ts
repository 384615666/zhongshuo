import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const iss = readFileSync(resolve(root, 'packaging/windows/zhongshuo.iss'), 'utf8');

/**
 * R158：开始菜单里显示成 Electron / ElectronApp 的根因是早期未品牌化构建留下的同名快捷方式
 * （它们带着同一个 AppUserModelID，Windows 会把「众说」的去重项显示成它们）。
 * 安装器只在**目标确实指向本程序**时删除，不能按名字盲删。
 */
describe('R158 安装器清理早期错误快捷方式', () => {
  it('只删除指向本程序的 Electron / ElectronApp 快捷方式', () => {
    expect(iss).toContain('procedure RemoveStaleAppShortcut');
    expect(iss).toMatch(/RemoveStaleAppShortcut\('Electron'\)/);
    expect(iss).toMatch(/RemoveStaleAppShortcut\('ElectronApp'\)/);
    // 目标比对：必须和安装目录里的 Zhongshuo.exe 相同才删
    expect(iss).toMatch(/CompareText\(Target, ExpandConstant\('\{app\}\\Zhongshuo\.exe'\)\)/);
    // 删除前必须存在性检查，且删除后刷新 Shell
    expect(iss).toMatch(/if not FileExists\(LinkPath\) then exit;/);
    expect(iss).toMatch(/if DeleteFile\(LinkPath\) then\s*\n\s*RefreshShellItem/);
  });

  it('众说自己的快捷方式仍带安装版 AUMID', () => {
    expect(iss).toMatch(/\{group\}\\众说";[^\n]*AppUserModelID: "com\.zhongshuo\.desktop\.app"/);
    expect(iss).toMatch(/\{userdesktop\}\\众说";[^\n]*AppUserModelID: "com\.zhongshuo\.desktop\.app"/);
  });
});

/**
 * 运行期自愈：安装版每次启动都会清掉同名的错误快捷方式（只在文件里确实提到本程序 exe 时），
 * 并在窗口出现后 4 秒再复查一次；同时 setAppDetails 必须给出 relaunchCommand，
 * 否则 Windows 拿不到完整注册、会按默认身份（ElectronApp）生成开始菜单项。
 */
describe('R162 运行期开始菜单自愈与身份注册', () => {
  const main = readFileSync(resolve(root, 'src/ui/main.ts'), 'utf8');

  it('安装版启动时清理同名的错误快捷方式，且判定保守', () => {
    expect(main).toContain('function removeStaleStartMenuShortcuts');
    expect(main).toMatch(/process\.platform !== 'win32' \|\| !installedDesktop/);
    // 只在 .lnk 内容确实提到本程序 exe 名时才删
    expect(main).toMatch(/!ascii\.includes\(exeName\) && !wide\.includes\(exeName\)/);
    expect(main).toMatch(/unlinkSync\(link\)/);
    // 启动时执行一次 + 4 秒后复查
    expect(main).toMatch(/removeStaleStartMenuShortcuts\(\);\s*\n\s*\/\/[^\n]*\n\s*const staleShortcutTimer = setTimeout\(removeStaleStartMenuShortcuts, 4_000\)/);
  });

  it('setAppDetails 同时给出 relaunchCommand 与显示名', () => {
    expect(main).toMatch(/relaunchCommand:\s*`"\$\{process\.execPath\}"`/);
    expect(main).toMatch(/relaunchDisplayName:\s*'众说'/);
  });
});
