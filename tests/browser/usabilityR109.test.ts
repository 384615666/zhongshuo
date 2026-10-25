import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {routeForResolved} from '../../src/ui/hifi/lib/deepLink';

beforeEach(()=>{
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{},removeItem:()=>{}});
  vi.stubGlobal('window',{setTimeout,clearTimeout,dispatchEvent:()=>true});
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

describe('R109 existing UI behavior',()=>{
  it('keeps a newer error visible for its own timeout after an earlier success',async()=>{
    const store=await import('../../src/ui/hifi/data/store');
    store.toast('第一次成功','success');
    vi.advanceTimersByTime(4000);
    store.toast('第二次失败','error');
    vi.advanceTimersByTime(201);
    expect(store.getState().ui.toast).toEqual({text:'第二次失败',tone:'error'});
    vi.advanceTimersByTime(3999);
    expect(store.getState().ui.toast).toBeUndefined();
  });

  it('preserves the tail of a selected delivery excerpt longer than 400 characters',async()=>{
    const store=await import('../../src/ui/hifi/data/store');
    const preview=await import('../../src/ui/hifi/data/actions-preview');
    const id=preview.registerDeliveryResource({
      deliveryId:'d1',revision:2,manifestHash:'hash1',conversationId:'c1',threadId:'th1',
      taskTitle:'旧成果',audience:'room',roomId:'r1',
      openedFrom:{kind:'thread',projectId:'p1',roomId:'r1',threadId:'th1',tab:'replies'},
    });
    const selection='需要完整保留的选区正文。'.repeat(60)+'选区末尾不能丢失';
    expect(preview.quoteResource(id,2,'thread:th1','当前任务',selection)).toBe(true);
    const inserts=store.takeDraftInserts('thread:th1');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.text.endsWith(selection)).toBe(true);
  });

  it('opens existing notification task views while ordinary task links keep their default',()=>{
    const result={kind:'task' as const,projectId:'p1',conversationId:'c1',threadId:'th1',taskId:'t1'};
    const state={rooms:[],dms:[]};
    expect(routeForResolved(result,state)).toBe('/thread/th1?tab=task');
    expect(routeForResolved(result,state,'replies')).toBe('/thread/th1');
    expect(routeForResolved(result,state,'delivery')).toBe('/thread/th1?tab=delivery');
    expect(routeForResolved(result,state,'run')).toBe('/thread/th1?tab=run');
    expect(routeForResolved({...result,kind:'delivery',deliveryId:'d1'},state)).toBe('/thread/th1?tab=delivery');
    expect(routeForResolved({kind:'msg',projectId:'p1',conversationId:'dm1',messageId:'msg1'},{rooms:[],dms:[{id:'dm1'}]})).toBe('/dm/dm1?message=msg1');
  });
});
