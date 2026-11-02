import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {dmListTime,sortDmConversations,visibleDmProjects} from '../../src/ui/hifi/lib/dmList';
import {defaultAiAvatarPreset,defaultMemberAvatarPreset} from '../../src/ui/hifi/data/avatarPresets';
import {getState,setState,type HifiState} from '../../src/ui/hifi/data/store';
import {loadDmProjectIndex,createDm} from '../../src/ui/hifi/loader';
import type {DmConversation} from '../../src/ui/hifi/data/types';

const at=(day:number,hour=13,minute=14)=>new Date(2026,10,day,hour,minute).getTime();
const initialWindow=(globalThis as {window?:unknown}).window;
let initial:HifiState;
beforeEach(()=>{initial=getState();});
afterEach(()=>{setState(()=>initial);(globalThis as {window?:unknown}).window=initialWindow;});

describe('R159 grouped private messages',()=>{
  it('formats local calendar days, month boundaries and absent timestamps',()=>{
    const now=at(2);
    expect(dmListTime(at(2),now)).toBe('13:14');
    expect(dmListTime(at(1,23),now)).toBe('昨天');
    expect(dmListTime(at(0),now)).toBe('前天');
    expect(dmListTime(new Date(2026,9,15).getTime(),now)).toBe('2026-10-15');
    expect(dmListTime(0,now)).toBe('');
  });
  it('sorts by the latest AI reply, with activity and creation fallbacks',()=>{
    const dm=(id:string,reply:number|null,last:number,created=1)=>({id,lastReplyAt:reply,lastMessageAt:last,createdAt:created}) as DmConversation;
    expect(sortDmConversations([dm('older-reply',100,1000),dm('newer-reply',200,200),dm('no-reply',null,150),dm('empty',null,0,50)]).map(item=>item.id))
      .toEqual(['newer-reply','no-reply','older-reply','empty']);
  });
  it('uses only sidebar-visible projects, including pinned projects once',()=>{
    const projects=['a','b','hidden','removed'].map(id=>({id,removedAt:id==='removed'?1:undefined})) as HifiState['projects'];
    expect(visibleDmProjects({projects,visibleProjectIds:['a','b','removed'],pinnedProjectIds:['b']}).map(project=>project.id)).toEqual(['b','a']);
  });
  it('maps the four default channels to the requested preset identities',()=>{
    for(const [kind,id] of [['claude','claude'],['deepseek-harness','deepseek'],['codex','codex'],['pi','pi']]){
      expect(defaultAiAvatarPreset(kind).id).toBe(id);
      expect(defaultMemberAvatarPreset('m_default_'+kind+'_project')?.id).toBe(id);
    }
    expect(defaultMemberAvatarPreset('m_default_project_0')).toBeUndefined();
  });
  it('loads another project independently, keeps the active list and retains its last snapshot on failure',async()=>{
    let fail=false;
    (globalThis as {window?:unknown}).window={zs:{command:async()=>{
      if(fail)return{ok:false,error:{code:'READ_FAILURE',message:'读取失败'}};
      return{ok:true,data:{conversations:[{conversationId:'dmB',projectId:'B',peerMemberId:'mB',lastReplyAt:42,lastMessageAt:43,createdAt:10}]}};
    }}};
    setState(s=>({...s,activeProjectId:'A',dmProjectIndexes:{},dms:[{id:'dmA',projectId:'A'} as DmConversation]}));
    await loadDmProjectIndex('B');
    expect(getState().activeProjectId).toBe('A');
    expect(getState().dms.map(dm=>dm.id)).toEqual(['dmA']);
    expect(getState().dmProjectIndexes.B.items[0]).toMatchObject({id:'dmB',memberIds:['mB'],lastReplyAt:42,lastMessageAt:43});
    fail=true;await expect(loadDmProjectIndex('B')).rejects.toThrow('读取失败');
    expect(getState().dmProjectIndexes.B).toMatchObject({status:'error',items:[{id:'dmB'}]});
  });
  it('freezes creation to the group and does not retry a successful create when its list read fails',async()=>{
    const calls:Array<{method:string;params:Record<string,unknown>;commandId:string}>=[];
    (globalThis as {window?:unknown}).window={zs:{command:async (envelope:typeof calls[number])=>{
      calls.push(envelope);return envelope.method==='conversation.create'?{ok:true,data:{conversationId:'newB'}}:{ok:false,error:{code:'READ_FAILURE',message:'list failed'}};
    }}};
    setState(s=>({...s,activeProjectId:'A',dmProjectIndexes:{}}));
    expect(await createDm('mB','B','same-request')).toBe('newB');
    expect(calls[0]).toMatchObject({commandId:'same-request',method:'conversation.create',params:{projectId:'B',peerMemberId:'mB'}});
    expect(calls.filter(call=>call.method==='conversation.create')).toHaveLength(1);
    expect(getState().activeProjectId).toBe('A');
  });
});
