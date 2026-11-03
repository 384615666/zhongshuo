import { describe, expect, it } from 'vitest';
import {
  detectLocalOpeners,
  isOpenableLocalFile,
  publicOpeners,
  type OpenerProbe,
} from '../../src/ui/localOpeners.ts';
import { absoluteProjectPath, directoryOf } from '../../src/ui/hifi/lib/localOpen.ts';

function probeWith(files: string[], dirs: string[] = []): OpenerProbe {
  const fileSet = new Set(files.map((file) => file.toLowerCase()));
  const dirSet = new Set(dirs.map((dir) => dir.toLowerCase()));
  const all = [...files, ...dirs];
  return {
    exists: (path) => fileSet.has(path.toLowerCase()) || dirSet.has(path.toLowerCase()),
    list: (dir) => {
      const prefix = dir.toLowerCase() + '\\';
      const names = new Set<string>();
      for (const path of all) {
        if (path.toLowerCase().startsWith(prefix)) {
          const rest = path.slice(prefix.length);
          if (rest.length > 0) names.add(rest.split('\\')[0]!);
        }
      }
      return [...names];
    },
    isFile: (path) => fileSet.has(path.toLowerCase()),
  };
}

const env = {
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
};

describe('R170 local openers detection', () => {
  it('always offers Explorer on Windows and only detected editors', () => {
    const openers = detectLocalOpeners(env, 'win32', probeWith([]));
    expect(openers.map((opener) => opener.id)).toEqual(['explorer']);
    expect(publicOpeners(openers)).toEqual([{ id: 'explorer', label: '资源管理器', kind: 'explorer' }]);
  });

  it('detects VS Code, IntelliJ IDEA and PyCharm from their real install locations', () => {
    const probe = probeWith([
      'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
      'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2026.1\\bin\\idea64.exe',
      'C:\\Program Files\\JetBrains\\PyCharm 2026.1\\bin\\pycharm64.exe',
    ], [
      'C:\\Program Files\\JetBrains',
      'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2026.1',
      'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2026.1\\bin',
      'C:\\Program Files\\JetBrains\\PyCharm 2026.1',
      'C:\\Program Files\\JetBrains\\PyCharm 2026.1\\bin',
    ]);
    const openers = detectLocalOpeners(env, 'win32', probe);
    expect(openers.map((opener) => opener.id)).toEqual(['explorer', 'vscode', 'idea', 'pycharm']);
    expect(openers.find((opener) => opener.id === 'idea')?.executable).toBe('C:\\Program Files\\JetBrains\\IntelliJ IDEA 2026.1\\bin\\idea64.exe');
  });

  it('supports JetBrains Toolbox version-directory layouts', () => {
    const base = 'C:\\Users\\me\\AppData\\Local\\JetBrains\\Toolbox\\apps\\IDEA-U\\ch-1\\2026.1';
    const probe = probeWith([`${base}\\bin\\idea64.exe`], [
      'C:\\Users\\me\\AppData\\Local\\JetBrains\\Toolbox\\apps',
      'C:\\Users\\me\\AppData\\Local\\JetBrains\\Toolbox\\apps\\IDEA-U',
      'C:\\Users\\me\\AppData\\Local\\JetBrains\\Toolbox\\apps\\IDEA-U\\ch-1',
      base,
      `${base}\\bin`,
    ]);
    expect(detectLocalOpeners(env, 'win32', probe).map((opener) => opener.id)).toEqual(['explorer', 'idea']);
  });

  it('returns no capabilities off Windows (no invented platform support)', () => {
    expect(detectLocalOpeners(env, 'linux', probeWith([]))).toEqual([]);
  });

  it('validates that only existing absolute files can be opened', () => {
    const probe = probeWith(['C:\\work\\project\\notes.md']);
    expect(isOpenableLocalFile('C:\\work\\project\\notes.md', probe, 'win32')).toBe(true);
    expect(isOpenableLocalFile('notes.md', probe, 'win32')).toBe(false);
    expect(isOpenableLocalFile('C:\\work\\project\\missing.md', probe, 'win32')).toBe(false);
    expect(isOpenableLocalFile('', probe, 'win32')).toBe(false);
  });
});

describe('R170 absolute project paths', () => {
  it('joins a project root with the project-relative path', () => {
    expect(absoluteProjectPath('D:\\zhongshuo-public', 'src\\ui\\main.ts')).toBe('D:\\zhongshuo-public\\src\\ui\\main.ts');
    expect(absoluteProjectPath('D:\\zhongshuo-public\\', './docs/readme.md')).toBe('D:\\zhongshuo-public\\docs\\readme.md');
  });

  it('keeps an already absolute path unchanged (only normalizing separators)', () => {
    expect(absoluteProjectPath('D:\\other', 'C:/work/a.md')).toBe('C:\\work\\a.md');
    expect(absoluteProjectPath(undefined, 'C:\\work\\a.md')).toBe('C:\\work\\a.md');
  });

  it('returns null when there is no project root and the path is relative', () => {
    expect(absoluteProjectPath(undefined, 'notes.md')).toBeNull();
    expect(absoluteProjectPath('', 'notes.md')).toBeNull();
    expect(absoluteProjectPath('D:\\root', '')).toBeNull();
  });

  it('derives the containing folder for copy/open titles', () => {
    expect(directoryOf('D:\\root\\a\\b.md')).toBe('D:\\root\\a');
    expect(directoryOf('D:\\b.md')).toBe('D:\\');
  });
});
