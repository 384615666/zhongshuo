import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {getState,setState,type HifiState} from '../../src/ui/hifi/data/store';
import {setConversationPinned,applyNavigationPins,navigationPinGeneration} from '../../src/ui/hifi/data/navigationPins';
import {dmUnreadTotal} from '../../src/ui/hifi/data/selectors';
import type {NavigationPin} from '../../src/contracts/navigationPins';

const originalWindow=(globalThis as {window?:unknown}).window;
let initial:HifiState;
beforeEach(()=>{initial=getState();setState(state=>({...state,navigationPins:[],navigationPinBusy:{}}));});
afterEach(()=>{setState(()=>initial);(globalThis as {window?:unknown}).window=originalWindow;});
const pin=(id:string,kind:'room'|'dm'='dm'):NavigationPin=>({kind,projectId:id,itemId:id,label:id,pinnedAt:1});
describe('R160 pin requests and unread scope',()=>{
  it('prevents duplicate clicks and composes independent late results without replacing other pins',async()=>{
    const releases=new Map<string,(data:unknown)=>void>();let calls=0;const params:unknown[]=[];
    (globalThis as {window?:unknown}).window={zs:{command:async(env:{params:{itemId:string}})=>{calls++;params.push(env.params);return new Promise(resolve=>releases.set(env.params.itemId,resolve));}}};
    const generation=navigationPinGeneration();
    const a=setConversationPinned(pin('a'),true),duplicate=setConversationPinned(pin('a'),true),b=setConversationPinned(pin('b'),true);
    expect(calls).toBe(2);
    expect(params[0]).toEqual({clientId:'desktop-hifi',kind:'dm',projectId:'a',itemId:'a',pinned:true});
    applyNavigationPins([],navigationPinGeneration());
    expect(getState().navigationPinBusy['dm:a']).toBe(true);
    releases.get('b')!({ok:true,data:{pin:pin('b')}});await b;
    releases.get('a')!({ok:true,data:{pin:pin('a')}});await a;await duplicate;
    expect(getState().navigationPins.map(pin=>pin.itemId).sort()).toEqual(['a','b']);
    applyNavigationPins([],generation);
    expect(getState().navigationPins).toHaveLength(2);
    applyNavigationPins([],navigationPinGeneration());
    expect(getState().navigationPins).toEqual([]);
  });
  it('counts hidden-project pinned DMs once and excludes other hidden conversations',()=>{
    const state={...getState(),projects:['a','b'].map(id=>({id})),visibleProjectIds:['a'],pinnedProjectIds:[],navigationPins:[pin('b'),pin('a')],dms:[],
      dmProjectIndexes:{a:{status:'ready',items:[{id:'a',projectId:'a',unread:2}]},b:{status:'ready',items:[{id:'b',projectId:'b',unread:3},{id:'hidden-other',projectId:'b',unread:99}]}}} as unknown as HifiState;
    expect(dmUnreadTotal(state)).toBe(5);
  });
});
