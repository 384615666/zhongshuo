import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {realpathSync} from 'node:fs';

/** Patch only a distribution copy. Verify every group/language/frame by reading PE resources back. */
export function brandWindowsExecutable(executable, icon) {
  if(realpathSync(executable).replaceAll('\\','/').toLowerCase().includes('/node_modules/'))throw Error('Refusing to alter a dependency executable');
  const script=fileURLToPath(new URL('./brand-executable.ps1',import.meta.url));
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Executable',executable,'-Icon',icon],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});
  if(result.error||result.status!==0)throw Error(`Cannot embed Windows brand icon: ${result.error?.message??result.stderr?.trim()}`);
  const verified=JSON.parse(result.stdout);
  if(!verified.Verified||verified.Frames<1||verified.Groups<1)throw Error('Embedded Windows icon verification failed');
  return verified;
}
