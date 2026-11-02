import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {getState,setState,setReadGate} from '../../src/ui/hifi/data/store';
import {loadDmHistory,loadDmProjectIndex,markDmRead} from '../../src/ui/hifi/loader';
import type {HifiState} from '../../src/ui/hifi/data/store';

const originalWindow=(globalThis as {window?:unknown}).window;let original:HifiState;
const dm=(id:string)=>({id,projectId:'p',title:id,memberIds:[],threadId:'',createdAt:0,lastMessageAt:0,lastMessageSeq:0,lastReadSeq:0,unread:0});
beforeEach(()=>{original=getState();setState(state=>({...state,activeProjectId:'p',loadGen:900,dms:[dm('a'),dm('b')],dmProjectIndexes:{},dmHistory:{},dmReadSeq:{},dmHistoryThroughSeq:{}}));});
afterEach(()=>{setReadGate(null);setState(()=>original);(globalThis as {window?:unknown}).window=originalWindow;});
describe('R163 DM reading watermarks',()=>{
  it('acknowledges the rendered reply even if the prior list still said zero unread, and drops stale list responses',async()=>{
    let release!:(reply:unknown)=>void;let holdList=false;const calls:Array<{method:string;params:Record<string,unknown>}>=[];
    (globalThis as {window?:unknown}).window={zs:{command:async(env:{method:string;params:Record<string,unknown>})=>{
      calls.push(env);
      if(env.method==='conversation.history')return{ok:true,data:{messages:[{id:'reply',authorType:'agent',authorId:'m',bodyJson:'{"text":"new reply"}',conversationSeq:2}]}};
      if(env.method==='conversation.list'){
        if(holdList){holdList=false;return new Promise(resolve=>{release=resolve;});}
        return{ok:true,data:{conversations:[{conversationId:'a',projectId:'p',unread:0,lastReadSeq:2,lastMessageSeq:2}]}};
      }
      return{ok:true,data:{}};
    }}};
    setReadGate(id=>id==='a');holdList=true;const stale=loadDmProjectIndex('p');
    await loadDmHistory('a',{markRead:true});
    expect(calls.filter(call=>call.method==='conversation.markRead').map(call=>call.params.throughMessageSeq)).toEqual([2]);
    release({ok:true,data:{conversations:[{conversationId:'a',projectId:'p',unread:1,lastReadSeq:0,lastMessageSeq:2}]}});await stale;
    expect(getState().dmReadSeq.a).toBe(2);expect(getState().dmProjectIndexes.p?.items[0]?.unread).toBe(0);
  });
  it('does not mark a hidden, scrolled-away or different conversation and ignores an older history response',async()=>{
    let resolveOld!:(reply:unknown)=>void;let historyCalls=0;let marks=0;
    (globalThis as {window?:unknown}).window={zs:{command:async(env:{method:string})=>{
      if(env.method==='conversation.history'){
        if(historyCalls++===0)return new Promise(resolve=>{resolveOld=resolve;});
        return{ok:true,data:{messages:[{id:'new',conversationSeq:3,bodyJson:'{"text":"new"}'}]}};
      }
      if(env.method==='conversation.markRead')marks++;
      return{ok:true,data:{conversations:[]}};
    }}};
    setReadGate(()=>false);const old=loadDmHistory('a',{markRead:true});await loadDmHistory('a',{markRead:true});
    resolveOld({ok:true,data:{messages:[{id:'old',conversationSeq:1,bodyJson:'{"text":"old"}'}]}});await old;
    expect(getState().dmHistory.a?.map(message=>message.id)).toEqual(['new']);expect(marks).toBe(0);
    setReadGate(id=>id==='b');await markDmRead('a',3);expect(marks).toBe(0);
    setReadGate(()=>true);await markDmRead('b',0);expect(marks).toBe(0);
  });
});
