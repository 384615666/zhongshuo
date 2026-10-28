import { sendCommand, type BridgeOutcome } from '../bridge';
import { readingNamespace } from './readingPositions';
export interface MemberWrite {
    scope: string;
    commandId: string;
    method: string;
    params: Record<string, unknown>;
}
const allowed = new Set(['project.writeAccess.set','member.create', 'member.update', 'member.setRuntime', 'member.setEnabled', 'memberTemplate.saveFromMember', 'memberTemplate.update', 'memberTemplate.createMember']);
const busy = new Set<string>();
const confirmed = new Map<string, 'ok' | 'failed'>();
export let memberWriteStorageError: string | null = null;
export function memberWriteState(p:MemberWrite) { return busy.has(p.scope) ? 'pending' : confirmed.get(p.commandId) ?? 'unknown'; }
function key() { const ns = readingNamespace(); if (!ns)
    throw Error('正在确认数据位置，请稍后再试'); return ns.replace('zs.hifi.reading.', 'zs.hifi.memberWrites.'); }
export function pendingMemberWrites(): MemberWrite[] {
    const raw = localStorage.getItem(key());
    if (raw == null)
        return [];
    if(new TextEncoder().encode(raw).byteLength>262144)throw Error('待确认的成员操作过多，请先处理已有记录');
    const parsed = JSON.parse(raw) as {
        v: number;
        items: MemberWrite[];
    };
    if (parsed.v !== 1 || !Array.isArray(parsed.items) || parsed.items.length > 64 || new TextEncoder().encode(raw).byteLength > 262144 || parsed.items.some(p => !allowed.has(p.method) || typeof p.scope !== 'string' || typeof p.commandId !== 'string' || !p.params || typeof p.params !== 'object'))
        throw Error('成员操作记录无法读取，请重新打开众说后重试');
    return parsed.items;
}
function persist(items: MemberWrite[]) { const raw = JSON.stringify({ v: 1, items }); if (items.length > 64 || new TextEncoder().encode(raw).byteLength > 262144)
    throw Error('待确认的成员操作过多，请先查询已有操作的结果'); localStorage.setItem(key(), raw); window.dispatchEvent(new Event('zs-member-writes')); }
export async function memberWrite<T>(scope: string, method: string, params: Record<string, unknown>, replay = false): Promise<BridgeOutcome<T>> {
    if (busy.has(scope))
        return { status: 'failed', code: 'OPERATION_IN_FLIGHT', error: '同一成员操作正在等待回执' };
    busy.add(scope);
    let transmitted = false;
    try {
        const rootKey = key();
        const items = pendingMemberWrites();
        const prior = items.find(x => x.scope === scope);
        if (prior && !replay)
            return { status: 'unknown', error: '上次操作的结果尚未确认，请先查询原操作' };
        if (replay && !prior)
            return { status: 'failed', code: 'NO_PENDING_OPERATION', error: '没有待确认的原操作' };
        if (!allowed.has(method))
            throw Error('不支持的成员操作');
        const envelope = prior ?? { scope, method, params: JSON.parse(JSON.stringify(params)) as Record<string, unknown>, commandId: `member-${crypto.randomUUID()}` };
        if (!prior)
            persist([...items, envelope]); // durable before transmission, including close/reload
        transmitted = true;
        const result = await sendCommand<T>(envelope.commandId, envelope.method, envelope.params);
        if (result.status !== 'unknown') {
            confirmed.set(envelope.commandId,result.status);
            if(confirmed.size>64)confirmed.delete(confirmed.keys().next().value!);
            // Never remove another data root's ledger after a delayed acknowledgement.
            if (key() === rootKey) {
                try { persist(pendingMemberWrites().filter(x => x.commandId !== envelope.commandId)); confirmed.delete(envelope.commandId); memberWriteStorageError=null; }
                catch(e) { memberWriteStorageError=`回执已${result.status==='ok'?'成功':'明确拒绝'}，但本地记录更新失败：${(e as Error).message}。请查询原操作的结果。`; }
            }
        }
        return result;
    }
    catch (e) {
        return transmitted ? { status: 'unknown', error: `操作结果确认失败：${(e as Error).message}。请先查询原操作的结果。` } : { status: 'failed', code: 'LOCAL_STORAGE_UNAVAILABLE', error: `操作记录无法保存，本次尚未提交：${(e as Error).message}` };
    }
    finally {
        busy.delete(scope);
        window.dispatchEvent(new Event('zs-member-writes'));
    }
}
