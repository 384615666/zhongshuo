import { sendCommand, type BridgeOutcome } from '../bridge';
import { readingNamespace } from './readingPositions';

export interface GitWriteEnvelope { projectId: string; commandId: string; method: string; params: Record<string, unknown> }
const allowed = new Set(['git.stage', 'git.unstage', 'git.stageTask', 'git.commit', 'git.push', 'git.pull', 'git.checkout', 'git.branch.create', 'git.commit.undo', 'git.conflict.resolve']);
const inFlight = new Set<string>();
export let gitWriteStorageError: string | null = null;
const notify = () => window.dispatchEvent(new Event('zs-git-writes'));
function key() {
  const ns = readingNamespace();
  if (!ns) throw Error('正在确认数据位置，请稍后再试');
  return ns.replace('zs.hifi.reading.', 'zs.hifi.gitWrites.');
}
export function pendingGitWrites(): GitWriteEnvelope[] {
  const raw = localStorage.getItem(key());
  if (raw == null) return [];
  if (new TextEncoder().encode(raw).byteLength > 262144) throw Error('Git 操作账本超限，原件保留');
  const parsed = JSON.parse(raw) as { v: number; items: GitWriteEnvelope[] };
  if (parsed.v !== 1 || !Array.isArray(parsed.items) || parsed.items.length > 64 || parsed.items.some(p => !p || !allowed.has(p.method) || typeof p.commandId !== 'string' || typeof p.projectId !== 'string' || !p.params || p.params.projectId !== p.projectId)) throw Error('Git 操作账本不可读，保留原件且未自动执行');
  return parsed.items;
}
function persist(items: GitWriteEnvelope[]) {
  const raw = JSON.stringify({ v: 1, items });
  if (items.length > 64 || new TextEncoder().encode(raw).byteLength > 262144) throw Error('待确认的 Git 操作过多，请先处理已有记录。本次操作尚未发送。');
  localStorage.setItem(key(), raw);
  notify();
}
export function gitWriteInFlight(projectId: string) { return inFlight.has(projectId); }

/** Persist first. Only an explicit original-number replay may transmit a retained envelope. */
export async function gitWrite<T>(projectId: string, method: string, params: Record<string, unknown>, replay = false): Promise<BridgeOutcome<T>> {
  if (inFlight.has(projectId)) return { status: 'failed', code: 'OPERATION_IN_FLIGHT', error: '该项目正在等待 Git 回执，请稍候' };
  inFlight.add(projectId);
  let sent = false;
  try {
    const rootKey = key(), items = pendingGitWrites(), prior = items.find(p => p.projectId === projectId);
    if (prior && !replay) return { status: 'unknown', error: '该项目上次 Git 操作的结果尚未确认，请先查询原操作。' };
    if (replay && !prior) return { status: 'failed', code: 'NO_PENDING_OPERATION', error: '没有待确认的 Git 操作' };
    if (!allowed.has(method) || params.projectId !== projectId) throw Error('Git 操作或目标身份不匹配');
    const envelope: GitWriteEnvelope = prior ?? { projectId, method, commandId: `git-${crypto.randomUUID()}`, params: JSON.parse(JSON.stringify(params)) as Record<string, unknown> };
    if (!prior) persist([...items, envelope]);
    sent = true;
    const result = await sendCommand<T>(envelope.commandId, envelope.method, envelope.params);
    if (prior && result.status === 'failed' && !result.operationKnownRejected) return { status: 'unknown', error: `${result.error}。仍未查到原操作的结果，请稍后再查询。` };
    if (result.status !== 'unknown' && key() === rootKey) {
      try { persist(pendingGitWrites().filter(p => p.commandId !== envelope.commandId)); gitWriteStorageError = null; }
      catch (e) { gitWriteStorageError = `回执已${result.status === 'ok' ? '成功' : '明确拒绝'}，但本地记录更新失败：${(e as Error).message}。请查询原操作的结果。`; }
    }
    return result;
  } catch (e) {
    return sent ? { status: 'unknown', error: `Git 操作结果确认失败：${(e as Error).message}。请先查询原操作的结果。` } : { status: 'failed', code: 'LOCAL_STORAGE_UNAVAILABLE', error: `Git 操作记录无法保存，本次尚未发送：${(e as Error).message}` };
  } finally { inFlight.delete(projectId); notify(); }
}
