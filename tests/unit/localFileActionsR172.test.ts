import {describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalFileActions,launchLocalEditor} from '../../src/ui/localFileActions.ts';
import {windowsFileAssociations,openWindowsFileAssociation} from '../../src/ui/windowsFileAssociations.ts';

function fixture(){
  const invokeAssociation=vi.fn(),openDefault=vi.fn(async()=>''),launch=vi.fn(async()=>({ok:true}));
  const associations=vi.fn((path:string)=>[{id:'association:'+path.split('.').pop(),label:path.endsWith('.docx')?'Word':'Excel',kind:'editor' as const}]);
  const validate=(path:unknown)=>{if(typeof path!=='string'||!path.startsWith('C:\\work\\'))throw Error('Invalid file');return path;};
  const editors=()=>[{id:'vscode' as const,label:'VS Code',kind:'editor' as const,executable:'C:\\Code.exe'}];
  return{actions:createLocalFileActions({validate,editors,associations,invokeAssociation,openDefault,launch}),invokeAssociation,openDefault,launch,associations};
}
describe('R172 file opening actions',()=>{
  it('catches an actual asynchronous spawn failure without an uncaught error or false success',async()=>{
    const result=await launchLocalEditor(join(tmpdir(),randomUUID(),'missing-editor.exe'),'C:\\file.txt');
    expect(result.ok).toBe(false);expect(result.error).not.toMatch(/ENOENT|missing-editor/);
  });
  it('uses the spawn event for an actual successful launch',async()=>{
    // A missing JS entry exits promptly, after the Node executable really starts.
    expect(await launchLocalEditor(process.execPath,join(tmpdir(),randomUUID()+'.cjs'))).toEqual({ok:true});
  });
  it('resolves different applications for Word and Excel files and always offers default opening',()=>{
    const f=fixture();
    expect(f.actions.list('C:\\work\\a.docx').map(item=>item.label)).toEqual(['按默认程序打开','资源管理器','Word']);
    expect(f.actions.list('C:\\work\\a.xlsx').map(item=>item.label)).toEqual(['按默认程序打开','资源管理器','Excel']);
  });
  it('does not reuse an association ID from another extension or accept a raw executable',async()=>{
    const f=fixture();
    expect((await f.actions.open('association:docx','C:\\work\\a.xlsx')).ok).toBe(false);
    expect((await f.actions.open('C:\\evil.exe','C:\\work\\a.xlsx')).ok).toBe(false);
    expect(f.invokeAssociation).not.toHaveBeenCalled();expect(f.launch).not.toHaveBeenCalled();
  });
  it('invokes only the selected, currently registered file handler',async()=>{
    const f=fixture();expect(await f.actions.open('association:docx','C:\\work\\a.docx')).toEqual({ok:true});
    expect(f.invokeAssociation).toHaveBeenCalledExactlyOnceWith('association:docx','C:\\work\\a.docx');
  });
  it('uses the system default and exposes a failure rather than claiming success',async()=>{
    const f=fixture();f.openDefault.mockResolvedValue('关联程序未安装');
    expect(await f.actions.open('default','C:\\work\\a.docx')).toEqual({ok:false,error:'关联程序未安装'});
  });
  it('keeps default opening usable if association enumeration is unavailable',async()=>{
    const f=fixture();f.associations.mockImplementation(()=>{throw Error('OS enumeration failed');});
    expect(f.actions.list('C:\\work\\a.docx').map(item=>item.id)).toEqual(['default','explorer']);
    expect(await f.actions.open('default','C:\\work\\a.docx')).toEqual({ok:true});
  });
  it('returns a readable error if a handler disappears after listing',async()=>{
    const f=fixture();f.invokeAssociation.mockImplementation(()=>{throw Error('raw COM detail');});
    const result=await f.actions.open('association:docx','C:\\work\\a.docx');
    expect(result.ok).toBe(false);expect(result.error).not.toContain('COM');
  });
  it('refuses invalid paths before querying or launching programs',async()=>{
    const f=fixture();expect(()=>f.actions.list('relative.docx')).toThrow();
    await expect(f.actions.open('default','relative.docx')).rejects.toThrow();
    expect(f.associations).not.toHaveBeenCalled();expect(f.openDefault).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform!=='win32')('enumerates real Windows handlers with opaque extension-bound IDs and rejects an invented selection',()=>{
    const word=windowsFileAssociations('C:\\file.docx'),excel=windowsFileAssociations('C:\\file.xlsx');
    expect(word.every(item=>/^association:[a-f0-9]{64}$/.test(item.id))).toBe(true);
    expect(word.filter(item=>excel.some(other=>other.id===item.id))).toEqual([]);
    expect(()=>openWindowsFileAssociation('association:'+ '0'.repeat(64),'C:\\file.docx')).toThrow();
  });
});
