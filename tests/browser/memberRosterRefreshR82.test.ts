import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
const f=vi.hoisted(()=>({members:vi.fn(async()=>{}),rooms:vi.fn(async()=>{}),dms:vi.fn(async()=>{}),state:{activeProjectId:'p',rooms:[{id:'r',projectId:'p',memberIds:['old']}],readErrors:{} as Record<string,string>}}));
vi.mock('../../src/ui/hifi/loader',()=>({refreshMembers:f.members,refreshRooms:f.rooms,refreshDms:f.dms}));
vi.mock('../../src/ui/hifi/shell',()=>({getState:()=>f.state,useStore:()=>f.state}));
beforeEach(()=>{vi.clearAllMocks();f.state.activeProjectId='p';f.state.readErrors={};vi.stubGlobal('window',{dispatchEvent:vi.fn()});});
afterEach(()=>vi.unstubAllGlobals());
describe('R82 template-created member is usable in authoritative room roster',()=>{
  it('identity refresh reads both members and room roster plus DM; no writes or model calls',async()=>{const {refreshMemberIdentity}=await import('../../src/ui/hifi/components/MemberManagementForms');await refreshMemberIdentity('p');expect(f.members).toHaveBeenCalledWith('p');expect(f.rooms).toHaveBeenCalledWith('p');expect(f.dms).toHaveBeenCalledWith('p');expect(window.dispatchEvent).toHaveBeenCalledOnce();});
  it('partial roster read failure is not a successful create readback; old roster stays, only read retry',async()=>{f.state.readErrors={'roster:r':'READ_FAILED'};const {refreshMemberIdentity}=await import('../../src/ui/hifi/components/MemberManagementForms');await expect(refreshMemberIdentity('p')).rejects.toThrow(/成员已保存.*原名单保留/);expect(f.state.rooms[0]!.memberIds).toEqual(['old']);expect(window.dispatchEvent).not.toHaveBeenCalled();});
});
