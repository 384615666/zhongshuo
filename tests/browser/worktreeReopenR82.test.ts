import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
const storage=new Map<string,string>();
beforeEach(()=>{storage.clear();vi.resetModules();vi.stubGlobal('window',{setTimeout:()=>0,dispatchEvent:()=>true});vi.stubGlobal('localStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v)});});
afterEach(()=>vi.unstubAllGlobals());
describe('R82 real v2 file-entry reopen regression, no model calls',()=>{
  it.each(['files','thread'] as const)('restored mutable resource with only revision 2 opens via %s without resetting reading/draft or inventing bytes',async kind=>{
    let store=await import('../../src/ui/hifi/data/store');let actions=await import('../../src/ui/hifi/data/actions-preview');store.initDraftPersistence('r82-reading');
    const id=actions.registerWorktreeResource('p','说明.md',10);
    store.setState(s=>({...s,resources:s.resources.map(r=>r.id===id?{...r,revisions:[{revision:2,hash:'confirmed-v2',sizeBytes:10,createdAt:2,content:{kind:'text' as const,text:'ENGINEERING_PRIVATE_BYTES'}}]}:r)}));
    expect(actions.openPreview(id,2,{target:{kind:'files',projectId:'p',view:'files'}})).toBe(true);actions.rememberScroll(store.getState().preview.activeKey!,88);
    expect(storage.get('zs.hifi.reading.r82-reading')).not.toContain('PRIVATE_BYTES');
    vi.resetModules();store=await import('../../src/ui/hifi/data/store');actions=await import('../../src/ui/hifi/data/actions-preview');store.initDraftPersistence('r82-reading');
    const restored=store.getState().resources.find(r=>r.id===id)!;expect(restored.revisions.map(r=>r.revision)).toEqual([2]);
    const target=kind==='files'?{kind,projectId:'p',view:'files' as const}:{kind,projectId:'p',roomId:'room',threadId:'thread',tab:'artifacts' as const};
    expect(actions.openWorktreePreview('p','说明.md',10,{target})).toBe(true);
    const active=store.getState().preview.tabs.find(t=>t.key===store.getState().preview.activeKey)!;expect(active.revision).toBe(2);expect(active.scrollTop).toBe(88);expect(restored.revisions[0]!.content.kind).toBe('unsupported');
    expect(store.getState().resources.find(r=>r.id===id)!.revisions.map(r=>r.hash)).toEqual(['confirmed-v2']);
    expect(actions.openPreview(id,1,{target})).toBe(false); // explicit old version never silently substitutes v2
  });
});
