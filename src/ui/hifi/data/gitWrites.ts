import { sendCommand, type BridgeOutcome } from '../bridge';
import { readingNamespace } from './readingPositions';

export interface GitWriteEnvelope { projectId: string; commandId: string; method: string; params: Record<string, unknown> }
const allowed = new Set(['git.stage', 'git.unstage', 'git.stageTask', 'git.commit', 'git.push', 'git.pull', 'git.checkout', 'git.branch.create', 'git.commit.undo', 'git.conflict.resolve']);
const inFlight = new Set<string>();
export let gitWriteStorageError: string | null = null;
const notify = () => window.dispatchEvent(new Event('zs-git-writes'));
function key() {
  const ns = readingNamespace();
  if (!ns) throw Error('数据根尚未确认，未提交 Git 操作');
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
  if (items.length > 64 || new TextEncoder().encode(raw).byteLength > 262144) throw Error('Git 操作信封超过本地账本容量，未发送；输入保留');
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
    if (prior && !replay) return { status: 'unknown', error: '该项目有未确认的 Git 操作；原信封保留，请先查看事实或明确同号重放，不会换新身份' };
    if (replay && !prior) return { status: 'failed', code: 'NO_PENDING_OPERATION', error: '没有可重放的 Git 操作' };
    if (!allowed.has(method) || params.projectId !== projectId) throw Error('Git 操作或目标身份不匹配');
    const envelope: GitWriteEnvelope = prior ?? { projectId, method, commandId: `git-${crypto.randomUUID()}`, params: JSON.parse(JSON.stringify(params)) as Record<string, unknown> };
    if (!prior) persist([...items, envelope]);
    sent = true;
    const result = await sendCommand<T>(envelope.commandId, envelope.method, envelope.params);
    if (prior && result.status === 'failed' && !result.operationKnownRejected) return { status: 'unknown', error: `${result.code}：${result.error}。本次重放未能核实原操作结果，原信封继续保留；不会换新身份。` };
    if (result.status !== 'unknown' && key() === rootKey) {
      try { persist(pendingGitWrites().filter(p => p.commandId !== envelope.commandId)); gitWriteStorageError = null; }
      catch (e) { gitWriteStorageError = `回执已${result.status === 'ok' ? '成功' : '明确拒绝'}，本地记录未能收口：${(e as Error).message}。原身份保留，可回读或同号核对。`; }
    }
    return result;
  } catch (e) {
    return sent ? { status: 'unknown', error: `Git 回执或账本收口失败：${(e as Error).message}。原身份保留，不自动重发。` } : { status: 'failed', code: 'LOCAL_STORAGE_UNAVAILABLE', error: `Git 操作无法耐久保存，未发送：${(e as Error).message}` };
  } finally { inFlight.delete(projectId); notify(); }
}
