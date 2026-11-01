import {afterEach,describe,expect,it,vi} from 'vitest';
import {command} from '../../src/ui/hifi/bridge.ts';
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('native runtime metadata receipt deadline',()=>{
  it('waits for a bounded 30-second catalog read without dropping its response at 20 seconds',async()=>{
    vi.useFakeTimers();let finish!:(value:unknown)=>void;
    vi.stubGlobal('window',{zs:{command:()=>new Promise(done=>{finish=done;})}});
    const outcome=command('member.runtimeCatalog',{}).then(value=>({value}),error=>({error}));
    let settled=false;void outcome.then(()=>{settled=true;});
    await vi.advanceTimersByTimeAsync(30_000);expect(settled).toBe(false);
    finish({ok:true,data:{models:[{id:'provider/configured-model'}]}});
    expect(await outcome).toEqual({value:{models:[{id:'provider/configured-model'}]}});
  });
  it('keeps ordinary command deadlines and a finite upper bound for metadata',async()=>{
    vi.useFakeTimers();vi.stubGlobal('window',{zs:{command:()=>new Promise(()=>{})}});
    const ordinary=command('project.list',{}).catch(error=>error);
    const metadata=command('member.runtimeOptions',{}).catch(error=>error);
    await vi.advanceTimersByTimeAsync(20_000);expect(await ordinary).toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(25_000);expect(await metadata).toBeInstanceOf(Error);
  });
});
