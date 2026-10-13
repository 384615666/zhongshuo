import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const storage = new Map<string, string>();
let failStorage = false;
beforeEach(() => { storage.clear(); failStorage = false; vi.resetModules(); vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { if (failStorage)
        throw Error('EACCES'); storage.set(k, v); } }); });
afterEach(() => vi.unstubAllGlobals());
async function setup(reply: () => Promise<unknown>) {
    const command = vi.fn((envelope: unknown) => { void envelope; return reply(); });
    vi.stubGlobal('window', { zs: { command }, dispatchEvent: () => true });
    const ns = await import('../../src/ui/hifi/data/readingPositions.ts');
    ns.configureReadingPositions('r81-root');
    return { command, ns, journal: await import('../../src/ui/hifi/data/memberWrites.ts') };
}
describe('R81 durable unknown configuration creation contracts', () => {
    it('late authoritative root initialization makes a previously unread durable envelope reachable without transmitting it', async () => {
        const f=await setup(async()=>{throw Error('ack dropped');});
        await f.journal.memberWrite('create:p:t','memberTemplate.createMember',{projectId:'p',templateId:'t',expectedRevision:0,displayName:'原成员',description:''});
        vi.resetModules();
        const bus=new EventTarget();const command=vi.fn(async()=>({ok:true,data:{}}));
        vi.stubGlobal('window',{zs:{command},dispatchEvent:(e:Event)=>bus.dispatchEvent(e)});
        const journal=await import('../../src/ui/hifi/data/memberWrites.ts');
        expect(()=>journal.pendingMemberWrites()).toThrow('数据根尚未确认');
        let restored=0;bus.addEventListener('zs-member-writes',()=>{restored=journal.pendingMemberWrites().length;});
        const store=await import('../../src/ui/hifi/data/store.ts');store.initDraftPersistence('r81-root');
        expect(restored).toBe(1);expect(journal.pendingMemberWrites()[0]?.params.displayName).toBe('原成员');expect(command).not.toHaveBeenCalled();
    });
    it('successful or rejected server receipts retain their classification when post-receipt local storage fails',async()=>{
        const f=await setup(async()=>{failStorage=true;return{ok:true,data:{memberId:'committed'}};});
        expect(await f.journal.memberWrite('create','member.create',{projectId:'p',displayName:'已提交'})).toMatchObject({status:'ok',data:{memberId:'committed'}});
        expect(f.journal.memberWriteStorageError).toContain('成功');expect(f.journal.memberWriteState(f.journal.pendingMemberWrites()[0]!)).toBe('ok');
        failStorage=false;f.command.mockImplementation(async()=>{failStorage=true;return{ok:false,error:{code:'STALE_REVISION',message:'refused'}};});
        expect(await f.journal.memberWrite('update','member.update',{projectId:'p',memberId:'m'})).toMatchObject({status:'failed',code:'STALE_REVISION'});
        expect(f.journal.memberWriteStorageError).toContain('明确拒绝');
    });
    it('double submission coalesces; unknown close/reload preserves original command and parameters, only explicit same-ID replay sends', async () => {
        const f = await setup(async () => { throw Error('ack dropped'); });
        const params = { projectId: 'p', templateId: 't', expectedRevision: 3, displayName: '甲', description: '原输入' };
        expect((await f.journal.memberWrite('create:p:t', 'memberTemplate.createMember', params)).status).toBe('unknown');
        const first = f.command.mock.calls[0]![0];
        const original = JSON.stringify(first);
        expect((await f.journal.memberWrite('create:p:t', 'memberTemplate.createMember', { ...params, displayName: '乙' })).status).toBe('unknown');
        expect(f.command).toHaveBeenCalledTimes(1);
        vi.resetModules();
        const g = await setup(async () => ({ ok: true, data: { memberId: 'same-original-id' } }));
        expect(g.journal.pendingMemberWrites()).toHaveLength(1);
        expect(g.command).not.toHaveBeenCalled();
        expect((await g.journal.memberWrite('create:p:t', 'memberTemplate.createMember', { ...params, displayName: '不能改原信封' }, true)).status).toBe('ok');
        expect(JSON.stringify(g.command.mock.calls[0]![0])).toBe(original);
        expect(g.journal.pendingMemberWrites()).toHaveLength(0);
    });
    it('pre-send storage failure refuses transmission and preserves corrupt original ledger; definitive rejection is distinct', async () => {
        const f = await setup(async () => ({ ok: false, error: { code: 'STALE_REVISION', message: 'new version' } }));
        failStorage = true;
        expect(await f.journal.memberWrite('m', 'member.update', { projectId: 'p' })).toMatchObject({ status: 'failed', code: 'LOCAL_STORAGE_UNAVAILABLE' });
        expect(f.command).not.toHaveBeenCalled();
        failStorage = false;
        expect(await f.journal.memberWrite('m', 'member.update', { projectId: 'p' })).toMatchObject({ status: 'failed', code: 'STALE_REVISION' });
        expect(f.journal.pendingMemberWrites()).toHaveLength(0);
        storage.set('zs.hifi.memberWrites.r81-root', '{"v":999,"original":"preserve"}');
        expect((await f.journal.memberWrite('m', 'member.update', { projectId: 'q' })).status).toBe('failed');
        expect(storage.get('zs.hifi.memberWrites.r81-root')).toContain('preserve');
        expect(f.command).toHaveBeenCalledTimes(1);
    });
    it('in-flight root switch cannot clear another root journal; explicit operation is never auto-retried', async () => {
        let resolve: (r: unknown) => void = () => { };
        const f = await setup(() => new Promise(r => { resolve = r; }));
        const running = f.journal.memberWrite('same', 'member.create', { projectId: 'A', displayName: 'A' });
        expect((await f.journal.memberWrite('same', 'member.create', { projectId: 'A', displayName: 'A' })).status).toBe('failed');
        f.ns.configureReadingPositions('other-root');
        resolve({ ok: true, data: { memberId: 'mA' } });
        expect((await running).status).toBe('ok');
        expect(f.journal.pendingMemberWrites()).toHaveLength(0);
        f.ns.configureReadingPositions('r81-root');
        expect(f.journal.pendingMemberWrites()).toHaveLength(1);
        expect(f.command).toHaveBeenCalledTimes(1);
    });
});
