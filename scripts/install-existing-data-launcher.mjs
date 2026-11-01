import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExistingDatabase } from './existing-data-launcher.mjs';

// Explicit opt-in, never guesses a user's data directory or copies runtime data.
export function installExistingDataLauncher(packageDir, appDataDir) {
  if (!isAbsolute(appDataDir)) throw Error('Pass an absolute existing data directory.');
  assertExistingDatabase(appDataDir);
  if (!existsSync(join(packageDir, 'ZhongshuoDual', 'resources', 'app', 'daemon', 'node', 'node.exe'))) {
    throw Error('Bundled Node is missing. Pass a built portable package directory.');
  }
  const configPath = join(packageDir, 'existing-data.json');
  if (existsSync(configPath) && resolve(JSON.parse(readFileSync(configPath, 'utf8')).appDataDir) !== resolve(appDataDir)) {
    throw Error('Existing launcher targets another data directory. Refusing to replace it.');
  }
  writeFileSync(configPath, JSON.stringify({ appDataDir: resolve(appDataDir) }, null, 2) + '\n');
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'existing-data-launcher.mjs'), join(packageDir, 'existing-data-launcher.mjs'));
  const bat = [
    '@echo off', 'setlocal DisableDelayedExpansion',
    '"%~dp0ZhongshuoDual\\resources\\app\\daemon\\node\\node.exe" "%~dp0existing-data-launcher.mjs"',
    'exit /b %errorlevel%', '',
  ];
  const vbs = [
    'Option Explicit', 'Dim shell, fso, root, code, command, message',
    'Set shell = CreateObject("WScript.Shell")', 'Set fso = CreateObject("Scripting.FileSystemObject")',
    'root = fso.GetParentFolderName(WScript.ScriptFullName)', 'shell.CurrentDirectory = root',
    'command = Chr(34) & root & "\\ZhongshuoDual\\resources\\app\\daemon\\node\\node.exe" & Chr(34) & " " & Chr(34) & root & "\\existing-data-launcher.mjs" & Chr(34)',
    'On Error Resume Next', 'code = shell.Run(command, 0, True)',
    'If Err.Number <> 0 Then code = 1', 'On Error GoTo 0',
    'If code <> 0 Then',
    '  message = "Zhongshuo could not start (exit " & code & "). See: " & root & "\\startup-existing-data.log"',
    '  If LCase(fso.GetFileName(WScript.FullName)) = "cscript.exe" Then',
    '    WScript.Echo message',
    '  Else',
    '    MsgBox message, 16, "Zhongshuo startup failed"',
    '  End If',
    'End If',
    'WScript.Quit code', '',
  ];
  writeFileSync(join(packageDir, 'start-existing-data.bat'), bat.join('\r\n'));
  writeFileSync(join(packageDir, 'start-existing-data.vbs'), vbs.join('\r\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw Error('Usage: node scripts/install-existing-data-launcher.mjs <package-directory> <absolute-existing-data-directory>');
  installExistingDataLauncher(resolve(process.argv[2]), process.argv[3]);
  console.log('Installed start-existing-data.vbs / .bat. No application was launched.');
}
