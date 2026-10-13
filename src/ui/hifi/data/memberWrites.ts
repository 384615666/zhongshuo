import { sendCommand, type BridgeOutcome } from '../bridge';
import { readingNamespace } from './readingPositions';
export interface MemberWrite {
    scope: string;
    commandId: string;
    method: string;
    params: Record<string, unknown>;
}
const allowed = new Set(['member.create', 'member.update', 'member.setRuntime', 'member.setEnabled', 'memberTemplate.saveFromMember', 'memberTemplate.update', 'memberTemplate.createMember']);
const busy = new Set<string>();
const confirmed = new Map<string, 'ok' | 'failed'>();
export let memberWriteStorageError: string | null = null;
export function memberWriteState(p:MemberWrite) { return busy.has(p.scope) ? 'pending' : confirmed.get(p.commandId) ?? 'unknown'; }
function key() { const ns = readingNamespace(); if (!ns)
    throw Error('数据根尚未确认，不能保存成员操作信封'); return ns.replace('zs.hifi.reading.', 'zs.hifi.memberWrites.'); }
export function pendingMemberWrites(): MemberWrite[] {
    const raw = localStorage.getItem(key());
    if (raw == null)
        return [];
    const parsed = JSON.parse(raw) as {
        v: number;
        items: MemberWrite[];
    };
    if (parsed.v !== 1 || !Array.isArray(parsed.items) || parsed.items.length > 64 || raw.length > 262144 || parsed.items.some(p => !allowed.has(p.method) || typeof p.scope !== 'string' || typeof p.commandId !== 'string' || !p.params || typeof p.params !== 'object'))
        throw Error('成员操作账本不可读；保留原件，未自动执行');
    return parsed.items;
}
function persist(items: MemberWrite[]) { const raw = JSON.stringify({ v: 1, items }); if (items.length > 64 || raw.length > 262144)
    throw Error('成员操作账本达到上限；请先处理已有未知结果'); localStorage.setItem(key(), raw); window.dispatchEvent(new Event('zs-member-writes')); }
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
            return { status: 'unknown', error: '此操作已有未知结果；请明确重放原操作，不会换新身份' };
        if (replay && !prior)
            return { status: 'failed', code: 'NO_PENDING_OPERATION', error: '没有可重放的原操作' };
        if (!allowed.has(method))
            throw Error('不支持的成员操作');
        const envelope = prior ?? { scope, method, params: JSON.parse(JSON.stringify(params)) as Record<string, unknown>, commandId: `member-${crypto.randomUUID()}` };
        if (!prior)
            persist([...items, envelope]); // durable before transmission, including close/reload
        transmitted = true;
        const result = await sendCommand<T>(envelope.commandId, envelope.method, envelope.params);
        if (result.status !== 'unknown') {
            confirmed.set(envelope.commandId,result.status);
            // Never remove another data root's ledger after a delayed acknowledgement.
            if (key() === rootKey) {
                try { persist(pendingMemberWrites().filter(x => x.commandId !== envelope.commandId)); confirmed.delete(envelope.commandId); memberWriteStorageError=null; }
                catch(e) { memberWriteStorageError=`回执已${result.status==='ok'?'成功':'明确拒绝'}，但本地账本未能收口：${(e as Error).message}。原信封保留；回读或人工同号核对。`; }
            }
        }
        return result;
    }
    catch (e) {
        return transmitted ? { status: 'unknown', error: `操作账本或回执处理失败：${(e as Error).message}。未自动重建身份；请保留此输入并回读事实。` } : { status: 'failed', code: 'LOCAL_STORAGE_UNAVAILABLE', error: `操作账本不能耐久保存，未提交：${(e as Error).message}` };
    }
    finally {
        busy.delete(scope);
        window.dispatchEvent(new Event('zs-member-writes'));
    }
}
