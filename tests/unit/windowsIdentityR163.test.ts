import {describe,it,expect} from 'vitest';
import type {ShortcutDetails} from 'electron';
import {repairLegacyAppShortcuts,windowsIdentityRegistration,windowsRelaunchCommand,type ShortcutIo} from '../../src/ui/windowsAppIdentity.ts';

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
  it('registers only a scoped AUMID and passes a quoted or spaced icon path as a single literal argument',()=>{
    const special="C:\\Apps\\it’s $mine\\logo.ico",commands=windowsIdentityRegistration(appId,special);
    expect(commands.some(args=>args.includes('DisplayName')&&args.includes('众说'))).toBe(true);
    expect(commands.some(args=>args.includes('IconUri')&&args.includes(special))).toBe(true);
    expect(()=>windowsIdentityRegistration('foreign.app',special)).toThrow();expect(()=>windowsIdentityRegistration(appId,'relative.ico')).toThrow();
  });
});
