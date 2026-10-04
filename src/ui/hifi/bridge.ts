/**
 * 正式命令桥（H1 首包）：类型化包装 `window.zs.command`（preload contextBridge——与既有
 * renderer 同一窄接口，不复制绕过规则的实现）。所有真实数据/写操作都经此处。
 */

export interface ZsEnvelope { protocolVersion: 1; commandId: string; method: string; params: Record<string, unknown> }
export interface ZsResult<T> { ok: boolean; data?: T; error?: { code: string; message: string } }

export interface ZsBridge {
  command(envelope: ZsEnvelope): Promise<ZsResult<never>>;
  pickFolder(): Promise<string | null>;
  onDisconnect(cb: () => void): void;
  onReconnected(cb: () => void): void;
}

export function bridge(): ZsBridge {
  const zs = (window as unknown as { zs?: ZsBridge }).zs;
  if (zs == null || typeof zs.command !== 'function') {
    throw new Error('预加载桥不可用（window.zs 缺失）——正式命令面无法访问');
  }
  return zs;
}

let seq = 0;
export async function command<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await bridge().command({ protocolVersion: 1, commandId: `hifi-${Date.now().toString(36)}-${(seq += 1)}`, method, params });
  if (!r.ok) throw new Error(`${r.error?.code ?? 'ERROR'}: ${r.error?.message ?? '未知错误'}`);
  return r.data as T;
}
