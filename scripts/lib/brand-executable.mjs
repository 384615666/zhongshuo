import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {realpathSync} from 'node:fs';

/** Version-info metadata derived from packaging/windows/release.json for a distribution EXE. */
export function windowsExecutableBrand(release, originalFilename) {
  return {
    version: release.version,
    numericVersion: release.numericVersion,
    productName: release.productName,
    fileDescription: release.productName,
    company: '众说开源项目',
    copyright: 'Copyright (C) 2026 众说开源项目',
    internalName: 'Zhongshuo',
    originalFilename,
    comments: '本地多 Agent 协同工作台',
  };
}

/** Patch only a distribution copy: icon groups plus PE version-info strings.
 *  Every icon frame and the rewritten version resource are verified by reading PE resources back. */
export function brandWindowsExecutable(executable, icon, brand = null) {
  if(realpathSync(executable).replaceAll('\\','/').toLowerCase().includes('/node_modules/'))throw Error('Refusing to alter a dependency executable');
  const script=fileURLToPath(new URL('./brand-executable.ps1',import.meta.url));
  const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Executable',executable,'-Icon',icon];
  if(brand!=null){
    for(const [key,flag] of [['version','-Version'],['numericVersion','-NumericVersion'],['productName','-ProductName'],['fileDescription','-FileDescription'],['company','-Company'],['copyright','-Copyright'],['internalName','-InternalName'],['originalFilename','-OriginalFilename'],['comments','-Comments']]){
      if(typeof brand[key]==='string'&&brand[key].length>0)args.push(flag,brand[key]);
    }
  }
  const result=spawnSync('powershell.exe',args,{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:1024*1024});
  if(result.error||result.status!==0)throw Error(`Cannot embed Windows brand resources: ${result.error?.message??result.stderr?.trim()}`);
  const verified=JSON.parse(result.stdout);
  if(!verified.Verified||verified.Frames<1||verified.Groups<1)throw Error('Embedded Windows icon verification failed');
  if(brand!=null&&(verified.Version==null||verified.Version.Verified!==true))throw Error('Embedded Windows version resource verification failed');
  return verified;
}
