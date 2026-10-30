import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {getState,setState} from '../../src/ui/hifi/data/store.ts';
import {loadSidebarRooms,openSidebarRoom,refreshRooms,switchFocusProject} from '../../src/ui/hifi/loader.ts';
import {cancelAllNavIntents} from '../../src/ui/hifi/lib/navIntent.ts';

const initial=getState();
const oldWindow=globalThis.window;
const oldHashChange=globalThis.HashChangeEvent;
function install(handler:(method:string,params:Record<string,unknown>)=>Promise<unknown>){
  const location={hash:'#/project/a/room/a1'};
  Object.assign(globalThis,{window:{location,dispatchEvent:()=>{},setTimeout,
    zs:{command:async(e:{method:string;params:Record<string,unknown>})=>({ok:true,data:await handler(e.method,e.params)})}},HashChangeEvent:class{}});
  return location;
}
const list=(prefix:string)=>({items:[{id:prefix+'1',name:prefix+'房间',conversationId:prefix+'conv',revision:0}]});
const gate=()=>{let release!:()=>void;const wait=new Promise<void>(r=>{release=r;});return{wait,release};};
beforeEach(()=>setState(s=>({...s,loadGen:s.loadGen+1,activeProjectId:'a',openInFlight:false,openInFlightTarget:null,
  sidebarRoomIndexes:{},projects:['a','b','c'].map(id=>({id,displayName:id,rootPath:'D:/isolated/'+id,canonicalPath:'D:/isolated/'+id,directoryIdentity:id,status:'ok',revision:0,isGit:false})),
  rooms:[{id:'a1',projectId:'a',name:'A房间',conversationId:'aconv',coordinatorMemberId:'m',memberIds:['m'],revision:0,unread:0}],members:[],dms:[]})));
afterEach(()=>{cancelAllNavIntents();setState(()=>initial);Object.assign(globalThis,{window:oldWindow,HashChangeEvent:oldHashChange});});

describe('R129 independent server room indexes',()=>{
  it('never infers an empty B index from a focus change while A rooms remain loaded',async()=>{
    const pending=gate();
    install(async(method,params)=>{
      if(method==='room.list'){await pending.wait;return list(String(params.projectId));}
      if(method==='runtime.status')return{memberBindings:[]};
      if(method==='conversation.list')return{conversations:[]};
      return{items:[]};
    });
    setState(s=>({...s,sidebarRoomIndexes:{b:{status:'ready',rooms:[{id:'b1',name:'B房间',revision:0}]}}}));
    const switching=switchFocusProject('b');
    expect(getState().activeProjectId).toBe('b');
    expect(getState().rooms[0]?.projectId).toBe('a');
    expect(getState().sidebarRoomIndexes.b).toMatchObject({status:'loading',rooms:[{id:'b1'}]});
    pending.release();await switching;
    expect(getState().sidebarRoomIndexes.b).toMatchObject({status:'ready',rooms:[{id:'b1'}]});
  });
  it('keeps the newest server index and previous rooms when reads arrive out of order or fail',async()=>{
    const pending=gate();let calls=0;
    install(async()=>{calls++;if(calls===1){await pending.wait;return{items:[]};}if(calls===3)throw Error('isolated outage');return list('b');});
    const older=loadSidebarRooms('b');await loadSidebarRooms('b');pending.release();await older;
    expect(getState().sidebarRoomIndexes.b).toMatchObject({status:'ready',rooms:[{id:'b1'}]});
    await expect(loadSidebarRooms('b')).rejects.toThrow('isolated outage');
    expect(getState().sidebarRoomIndexes.b).toMatchObject({status:'error',rooms:[{id:'b1'}],error:'isolated outage'});
    expect(getState().rooms[0]?.id).toBe('a1');
  });
  it('switches a loaded room immediately without waiting on any backend command',async()=>{
    let reads=0;const location=install(async()=>{reads++;throw Error('must not read');});
    setState(s=>({...s,rooms:[...s.rooms,{...s.rooms[0]!,id:'a2',name:'A第二房间'}]}));
    const switching=openSidebarRoom('a','a2');
    expect(location.hash).toBe('/project/a/room/a2');
    expect(reads).toBe(0);await expect(switching).resolves.toBe(true);
  });
  it('does not let a stale room roster overwrite a newer list in the same project',async()=>{
    const roster=gate();let reads=0;
    install(async(method,params)=>{
      if(method==='room.list')return list(++reads===1?'old':'new');
      if(method==='member.list'&&params.roomId==='old1')await roster.wait;
      return{items:[]};
    });
    const older=refreshRooms('a');
    await new Promise(r=>setTimeout(r,0));await refreshRooms('a');roster.release();await older;
    expect(getState().rooms.map(r=>r.id)).toEqual(['new1']);
    expect(getState().sidebarRoomIndexes.a?.rooms.map(r=>r.id)).toEqual(['new1']);
  });
  it('a late project switch reports superseded and cannot persist a newer focus as its success',async()=>{
    const pending=gate();const writes:unknown[]=[];
    install(async(method,params)=>{
      if(method==='room.list'){if(params.projectId==='b')await pending.wait;return list(String(params.projectId));}
      if(method==='conversation.list')return{conversations:[]};
      if(method==='runtime.status')return{memberBindings:[]};
      if(method==='navigation.set'){writes.push(params);return{saved:true};}
      return{items:[]};
    });
    const b=switchFocusProject('b');await switchFocusProject('c');pending.release();await expect(b).resolves.toBe(false);
    expect(getState().activeProjectId).toBe('c');expect(getState().rooms[0]?.projectId).toBe('c');
    await new Promise(r=>setTimeout(r,0));expect(writes).toHaveLength(1);
  });
});
