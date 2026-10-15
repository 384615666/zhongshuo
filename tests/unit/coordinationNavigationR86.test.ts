import {describe,expect,it} from 'vitest';
import {routeForResolved} from '../../src/ui/hifi/lib/deepLink.ts';
const state={rooms:[],dms:[]};
describe('R86 child task navigation preserves the authoritative entity',()=>{
  it.each(['task','delivery'] as const)('keeps child %s identity while sharing its original thread',kind=>{
    expect(routeForResolved({kind,projectId:'p',conversationId:'c',threadId:'thread',taskId:'child',parentTaskId:'parent',...(kind==='delivery'?{deliveryId:'delivery'}:{})},state)).toBe(`/thread/thread?tab=task&task=child${kind==='delivery'?'&delivery=delivery':''}`);
  });
  it('keeps the established root thread URL for ordinary tasks',()=>{
    expect(routeForResolved({kind:'task',projectId:'p',conversationId:'c',threadId:'thread',taskId:'parent'},state)).toBe('/thread/thread?tab=task');
  });
});
