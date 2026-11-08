import {describe,it,expect} from 'vitest';
import type {ShortcutDetails} from 'electron';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {repairLegacyAppShortcuts,windowsNotificationIdentityReset,windowsRelaunchCommand,type ShortcutIo} from '../../src/ui/windowsAppIdentity.ts';

const programs='C:\\User\\Programs',exe='C:\\Apps\\Zhongshuo\\Zhongshuo.exe',icon='C:\\Apps\\Zhongshuo\\logo.ico',appId='com.zhongshuo.desktop.app';
function fixture(){
  const links=new Map<string,ShortcutDetails>(),removed:string[]=[];
  const io:ShortcutIo={exists:path=>links.has(path),read:path=>{const item=links.get(path);if(!item)throw Error('Missing link');return item;},write:(path,value)=>{links.set(path,value);return true;},remove:path=>{removed.push(path);links.delete(path);}};
  return {links,removed,io};
}
describe('R163 Windows identity repair',()=>{
  it('keeps the explicit entry data root in a pinned-window relaunch, including paths with spaces',()=>{
    expect(windowsRelaunchCommand('C:\\Program Files\\众说\\Zhongshuo.exe','D:\\my data')).toBe('"C:\\Program Files\\众说\\Zhongshuo.exe" "--data-dir=D:\\my data"');
    expect(windowsRelaunchCommand(exe,'D:\\')).toBe('"'+exe+'" "--data-dir=D:\\\\"');
  });
  it('replaces an owned legacy shortcut, preserving the native toast activator metadata',()=>{
    const f=fixture(),old=programs+'\\ElectronApp.lnk',clsid='{FAE33443-453E-47D8-930D-ABC987654321}';
    f.links.set(old,{target:exe.toUpperCase(),appUserModelId:appId,toastActivatorClsid:clsid,args:'--example'});
    expect(repairLegacyAppShortcuts(programs,exe,icon,appId,f.io)).toEqual([old]);
    expect(f.links.get(programs+'\\众说.lnk')).toMatchObject({target:exe,appUserModelId:appId,toastActivatorClsid:clsid,args:'--example',icon});
  });
  it('does not delete a different app with the same executable basename or overwrite a foreign destination',()=>{
    const f=fixture(),old=programs+'\\ElectronApp.lnk';
    f.links.set(old,{target:'C:\\Other App\\Zhongshuo.exe',description:exe});
    repairLegacyAppShortcuts(programs,exe,icon,appId,f.io);expect(f.removed).toEqual([]);
    f.links.set(old,{target:exe});f.links.set(programs+'\\众说.lnk',{target:'C:\\Other\\program.exe'});
    repairLegacyAppShortcuts(programs,exe,icon,appId,f.io);expect(f.removed).toEqual([]);
    repairLegacyAppShortcuts('relative',exe,icon,appId,f.io);expect(f.removed).toEqual([]);
  });
  it('does not remove the original when writing or verification fails',()=>{
    const f=fixture(),old=programs+'\\Electron.lnk';f.links.set(old,{target:exe,toastActivatorClsid:'original'});
    repairLegacyAppShortcuts(programs,exe,icon,appId,{...f.io,write:()=>false});expect(f.removed).toEqual([]);
    repairLegacyAppShortcuts(programs,exe,icon,appId,{...f.io,write:(path,value)=>f.io.write(path,{...value,toastActivatorClsid:'lost'})});expect(f.removed).toEqual([]);
  });
  it('resets the scoped AUMID key so Windows falls back to the shortcut icon and name',()=>{
    // R198：Toast 平台一旦看到 AUMID 注册表键就用它的 IconUri/显示名（实测渲染成黑块/占位
    // 字形）；删掉整键后同一 AUMID 的快捷方式图标 + 名称正常。这里只允许删除本应用 scoped 键。
    const commands=windowsNotificationIdentityReset(appId);
    expect(commands).toEqual([['delete','HKCU\\Software\\Classes\\AppUserModelId\\'+appId,'/f']]);
    expect(()=>windowsNotificationIdentityReset('foreign.app')).toThrow();
    expect(()=>windowsNotificationIdentityReset('com.zhongshuo.')).toThrow();
  });
  it('main process no longer writes DisplayName/IconUri for the AUMID',()=>{
    const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
    const main=readFileSync(resolve(root,'src/ui/main.ts'),'utf8');
    expect(main).toContain('windowsNotificationIdentityReset(desktopAppId)');
    expect(main).not.toContain('windowsIdentityRegistration');
    expect(main).not.toContain('Notification identity registration');
  });
});
