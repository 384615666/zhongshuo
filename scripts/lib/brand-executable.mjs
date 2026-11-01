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

function readVersionInfo(executable) {
  const script=fileURLToPath(new URL('./verify-exe-version.ps1',import.meta.url));
  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Executable',executable],{encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
  if(result.error||result.status!==0)throw Error(`Cannot read embedded version info: ${result.error?.message??result.stderr?.trim()}`);
  return JSON.parse(result.stdout);
}

/** Patch only a distribution copy: icon groups plus PE version-info strings.
 *  Every icon frame is read back in-process; the rewritten version resource is verified by a
 *  fresh PowerShell process (Windows PowerShell can return a stale FileVersionInfo in the
 *  process that just committed UpdateResource). */
export function brandWindowsExecutable(executable, icon, brand = null) {
  if(realpathSync(executable).replaceAll('\\','/').toLowerCase().includes('/node_modules/'))throw Error('Refusing to alter a dependency executable');
  const script=fileURLToPath(new URL('./brand-executable.ps1',import.meta.url));
  // The script only uses Win32 APIs and never prompts; avoid flags that alter resource reads.
  const args=['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Executable',executable,'-Icon',icon];
  if(brand!=null){
    for(const [key,flag] of [['version','-Version'],['numericVersion','-NumericVersion'],['productName','-ProductName'],['fileDescription','-FileDescription'],['company','-Company'],['copyright','-Copyright'],['internalName','-InternalName'],['originalFilename','-OriginalFilename'],['comments','-Comments']]){
      if(typeof brand[key]==='string'&&brand[key].length>0)args.push(flag,brand[key]);
    }
  }
  const result=spawnSync('powershell.exe',args,{encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
  if(result.error||result.status!==0)throw Error(`Cannot embed Windows brand resources: ${result.error?.message??result.stderr?.trim()}`);
  const verified=JSON.parse(result.stdout);
  if(!verified.Verified||verified.Frames<1||verified.Groups<1)throw Error('Embedded Windows icon verification failed');
  if(brand!=null){
    if(verified.Version==null||verified.Version.Verified!==true)throw Error('Embedded Windows version resource write was not committed');
    const info=readVersionInfo(executable);
    const mismatches=[];
    if(info.productName!==brand.productName)mismatches.push(`ProductName=${info.productName}`);
    if(info.fileDescription!==brand.fileDescription)mismatches.push(`FileDescription=${info.fileDescription}`);
    if(info.originalFilename!==brand.originalFilename)mismatches.push(`OriginalFilename=${info.originalFilename}`);
    if(info.companyName!==brand.company)mismatches.push(`CompanyName=${info.companyName}`);
    if(info.fileVersion!==brand.version)mismatches.push(`FileVersion=${info.fileVersion}`);
    if(mismatches.length>0)throw Error(`Embedded Windows version resource verification failed: ${mismatches.join(', ')}`);
    verified.Version={verified:true,productName:info.productName,fileDescription:info.fileDescription,fileVersion:info.fileVersion,productVersion:info.productVersion,originalFilename:info.originalFilename,companyName:info.companyName};
  }
  return verified;
}
