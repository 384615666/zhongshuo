import {win32} from 'node:path';
import type {ShortcutDetails} from 'electron';

export const WINDOWS_APP_NAME='众说';
export function windowsRelaunchCommand(exe:string,dataRoot?:string):string{
  const quote=(value:string)=>'"'+value.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')+'"';
  return [quote(exe),...(dataRoot?[quote('--data-dir='+dataRoot)]:[])].join(' ');
}
const sameTarget=(left:string,right:string)=>win32.isAbsolute(left)&&win32.normalize(left).toLowerCase()===win32.normalize(right).toLowerCase();
export interface ShortcutIo {
  exists:(path:string)=>boolean;
  read:(path:string)=>ShortcutDetails;
  write:(path:string,details:ShortcutDetails)=>boolean;
  remove:(path:string)=>void;
}
/** Preserve native toast activation metadata while replacing only a shortcut
 * whose parsed target is this exact executable. Never inspect arbitrary bytes. */
export function repairLegacyAppShortcuts(programs:string,exe:string,icon:string,appId:string,io:ShortcutIo):string[]{
  if(!win32.isAbsolute(programs)||!win32.isAbsolute(exe))return [];
  const repaired:string[]=[],destination=win32.join(programs,WINDOWS_APP_NAME+'.lnk');
  for(const name of ['Electron','ElectronApp']){
    const source=win32.join(programs,name+'.lnk');
    try{
      if(!io.exists(source))continue;
      const old=io.read(source);
      if(!sameTarget(old.target,exe))continue;
      if(io.exists(destination)&&!sameTarget(io.read(destination).target,exe))continue;
      if(!io.write(destination,{...old,target:exe,icon,iconIndex:0,description:WINDOWS_APP_NAME,appUserModelId:appId}))continue;
      const saved=io.read(destination);
      if(!sameTarget(saved.target,exe)||saved.appUserModelId!==appId||saved.toastActivatorClsid!==old.toastActivatorClsid)continue;
      if(!sameTarget(io.read(source).target,exe))continue;
      io.remove(source);repaired.push(source);
    }catch{/* A broken or foreign shortcut must not affect other items or boot. */}
  }
  return repaired;
}

/**
 * Toast 身份图标（R198）：Windows 桌面通知的应用图标/名称来自 AUMID **快捷方式**；
 * 一旦 `HKCU\Software\Classes\AppUserModelId\<AUMID>` 键存在，Toast 平台会优先用该键的
 * `IconUri`/显示名，而实测该键的 IconUri 指向随包 ICO/PNG 时都渲染成黑色方块/占位字形
 * （删掉整键后同一 AUMID 的快捷方式图标与名称能正常显示）。所以这里不再写 DisplayName/
 * IconUri，而是**删除**本应用 AUMID 的这个键，让 Windows 回退到先装好的「众说」快捷方式。
 * 只处理本应用 scoped AUMID；命令参数结构化传给 reg.exe，不拼接命令串。
 */
export function windowsNotificationIdentityReset(appId:string):string[][]{
  if(!/^com\.zhongshuo\.[A-Za-z0-9._-]{1,140}$/.test(appId))throw Error('Invalid application notification identity');
  const key=`HKCU\\Software\\Classes\\AppUserModelId\\${appId}`;
  return [['delete',key,'/f']];
}
