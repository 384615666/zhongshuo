/**
 * 正式命令桥（H1 首包，第四十七轮修订）：类型化包装 `window.zs.command`（preload
 * contextBridge——与既有 renderer 同一窄接口，不复制绕过规则的实现）。
 *
 * 正式异步合同：发送类命令带**调用方提供的 commandId**（Composer 草稿身份——同号重试=幂等
 * 恰一次），并返回可判定结果——ok / failed（服务端明确拒绝）/ unknown（传输失败或超时，
 * 结果未知——保留草稿沿同号重试）。
 */

export interface ZsEnvelope { protocolVersion: 1; commandId: string; method: string; params: Record<string, unknown> }
export interface ZsResult<T> { ok: boolean; data?: T; error?: { code: string; message: string } }

export interface ZsBridge {
  command(envelope: ZsEnvelope): Promise<ZsResult<never>>;
  pickFolder(): Promise<string | null>;
  /** 打开导出目录（main 侧白名单：仅应用数据区 exports/ 内路径——r56 H4 导出入口用）。 */
  openPath(target: string): Promise<string>;
  onDisconnect(cb: () => void): void;
  onReconnected(cb: () => void): void;
}

/** 打开导出目录（窄权限：exports/ 白名单外的路径由 main 拒绝）。 */
export async function openExportDir(dir: string): Promise<string> {
  return bridge().openPath(dir);
}

export interface BridgeOk<T> { status: 'ok'; data: T }
export interface BridgeFailed { status: 'failed'; code: string; error: string }
export interface BridgeUnknown { status: 'unknown'; error: string }
export type BridgeOutcome<T> = BridgeOk<T> | BridgeFailed | BridgeUnknown

/** 结果未知判定窗口：超过即视为 unknown（同 commandId 重试由调用方决定）。 */
const UNKNOWN_TIMEOUT_MS = 20_000;
const recentErrors:Array<{at:number;method:string;code:string;status:'failed'|'unknown'}>=[];
export function bridgeErrorFacts(){return recentErrors.map(e=>({...e}));}

export function bridge(): ZsBridge {
  const zs = (window as unknown as { zs?: ZsBridge }).zs;
  if (zs == null || typeof zs.command !== 'function') {
    throw new Error('预加载桥不可用（window.zs 缺失）——正式命令面无法访问');
  }
  return zs;
}

/** 普通读取命令：明确失败抛错（页面按读取失败处理，不冒充空态）。 */
export async function command<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await commandOutcome<T>(`rd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, method, params);
  if (r.status === 'ok') return r.data;
  throw new Error(`${r.status === 'failed' ? `${r.code}: ${r.error}` : r.error}`);
}

/** 发送类命令：携带调用方 commandId，返回可判定回执（ok/failed/unknown）。 */
export async function sendCommand<T>(commandId: string, method: string, params: Record<string, unknown>): Promise<BridgeOutcome<T>> {
  return commandOutcome<T>(commandId, method, params);
}

async function commandOutcome<T>(commandId: string, method: string, params: Record<string, unknown>): Promise<BridgeOutcome<T>> {
  const finish=(outcome:BridgeOutcome<T>)=>{if(outcome.status!=='ok'){const code=outcome.status==='unknown'?'TRANSPORT_RESULT_UNKNOWN':/^[A-Z_][A-Z0-9_]{0,63}$/.test(outcome.code)?outcome.code:'SERVICE_REJECTED';recentErrors.push({at:Date.now(),method:/^[a-zA-Z]+(?:\.[a-zA-Z]+)*$/.test(method)?method:'command',code,status:outcome.status});if(recentErrors.length>20)recentErrors.shift();}return outcome;};
  const zs = bridge();
  let settle: ((v: ZsResult<T> | 'timeout') => void) | null = null;
  const timer = setTimeout(() => { settle?.('timeout'); }, UNKNOWN_TIMEOUT_MS);
  const wrapped = new Promise<ZsResult<T> | 'timeout'>((resolve) => { settle = resolve; });
  try {
    const p = zs.command({ protocolVersion: 1, commandId, method, params } satisfies ZsEnvelope);
    void p.then((r) => { settle?.(r as ZsResult<T>); }, (e: unknown) => {
      // 传输层失败（断连/序列化）——服务端可能已执行也可能没有：**结果未知**，不是服务拒绝。
      settle?.({ ok: false, error: { code: '__TRANSPORT__', message: e instanceof Error ? e.message : String(e) } });
    });
    const r = await wrapped;
    if (r === 'timeout') return finish({ status: 'unknown', error: '服务未在时限内回执' });
    if (r.ok) return { status: 'ok', data: r.data as T };
    if (r.error?.code === '__TRANSPORT__') return finish({ status: 'unknown', error: r.error.message });
    return finish({ status: 'failed', code: r.error?.code ?? 'ERROR', error: r.error?.message ?? '未知错误' });
  } catch (e) {
    // 桥本身抛错（断连/序列化）：结果未知——不是服务端拒绝。
    return finish({ status: 'unknown', error: e instanceof Error ? e.message : String(e) });
  } finally {
    clearTimeout(timer);
  }
}
