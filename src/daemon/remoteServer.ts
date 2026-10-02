/**
 * DEV-25 远程访问服务端（第三十一轮三/四建；第三十二轮重写；第三十三轮按定位缺口收口）。
 * 第三十三轮修复与合同补齐：
 * - **设备级授权代次（迁移 040 remote_devices.auth_epoch）**：吊销 A 只递增 A 的代次并撤销
 *   A 的 token/票据/活连接——**B 的现有 token/票据/WS 不受影响**（第三十二轮全局 authEpoch
 *   会把 B 一并 401——多设备互相误伤）。checkToken/票据消费按设备行核对 revoked_at+auth_epoch；
 * - **remoteGate 共享命令门禁**：dispatch 收到服务端构造的可信上下文（deviceId+deviceEpoch+
 *   gate 闭包）——命令面在**进入时**与**业务提交前**（commands.ts run() 边界）重查设备/会话
 *   有效性与代次；异步工作（附件解析/导出）完成后提交前也走同一门禁。吊销≠停止——已授权
 *   运行的任务按正式停止合同处理；
 * - **WSS 每地址未认证限额**（WS_UNAUTH_PER_ADDR=2/地址+全局 32）：handleUpgrade 按真实
 *   来源地址计数（第三十二轮取 addr 后 void 掉只查全局——限额形同虚设）；
 * - **有界关闭收拢**：closeConn 发起关闭后宽限（默认 3s）内未收到关闭握手→terminate 强杀
 *   并核实释放；连接从 conns 移除发生在**真正关闭后**（不再「先移除再 close 就当已退出」）；
 *   daemon.stop 有界等待全部连接收拢后强制清场；
 * - **事件泵按项目游标（projNext latch）**：每连接每项目独立水位，SQL 按订阅项目过滤——
 *   **大量未订阅项目的事件不再阻塞已订阅项目**（第三十二轮全局 LIMIT 500 先取再跳过：前 500
 *   条属未订阅 P1 时已订阅 P2 永远发不出）。迟后订阅从该项目水位续发；积压超续传窗口→
 *   cursor-stale（客户端拉同范围快照）；
 * - **导出下载**：主文件 sha256 核验可达（不再 bytes 后 continue 跳过）；**单次受控读取**的
 *   已验证字节直接进 ZIP（不再句柄校验后再 readFile 重读——ZIP 字节=核验字节）；**资产额度与
 *   必要元文件分离**（manifest.files 资产 ≤200；index/manifest 不占额度——合法 200 件附件+
 *   元文件完整下载，201 件明确 413）；发送前重查下载权限；
 * - **进程内自检（runSelfcheck）**：隔离验收模式（ZS_REMOTE_SELFCHECK=1——双机包启动器注入，
 *   正式入口不带）下由可信本机 UI 触发：创建码→错码 401（核对 fail_count 递增）→伪造
 *   Host/Origin 403→无 token 401→正码配对→session→同 commandId 恰一次（replayed=true+
 *   remote_audit_log 本次设备/命令号/成败/重放事实核对）→自清理吊销。**明文码只在进程内使用、
 *   结束失效，不落任何存储**；结果文件不含凭据。
 * 第三十二轮既有合同保留：ws 库承接握手/帧（maxPayload 64KB、结构验证只关该连接）、票据完整
 * 绑定（device+origin 消费比对+会话有效期+设备代次）、cmd 吊销重查、currentAddress 实际监听事实。
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import * as https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readdirSync, readFileSync, statSync, realpathSync, writeFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join, resolve } from 'node:path';
import { zip } from 'fflate';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { ensureServerIdentity, type RemoteServerIdentity } from './remoteIdentity.ts';
import { REMOTE_CLIENT_HTML, REMOTE_CLIENT_JS } from './remoteClient.ts';
import type { ZhongshuoDatabase } from '../persistence/db.ts';

// ---------- 配置 ----------
export interface RemoteConfig { enabled: boolean; listenHost: string; port: number; allowLan: boolean }

export function readRemoteConfig(db: ZhongshuoDatabase): RemoteConfig {
  const row = db.prepare('SELECT enabled, listen_host, port, allow_lan FROM remote_config WHERE id = 1').get() as { enabled: number; listen_host: string; port: number; allow_lan: number } | undefined;
  return row == null
    ? { enabled: false, listenHost: '127.0.0.1', port: 0, allowLan: false }
    : { enabled: row.enabled === 1, listenHost: row.listen_host, port: row.port, allowLan: row.allow_lan === 1 };
}

export function writeRemoteConfig(db: ZhongshuoDatabase, cfg: RemoteConfig, now: number): void {
  db.prepare('UPDATE remote_config SET enabled = ?, listen_host = ?, port = ?, allow_lan = ?, updated_at = ? WHERE id = 1')
    .run(cfg.enabled ? 1 : 0, cfg.listenHost, cfg.port, cfg.allowLan ? 1 : 0, now);
}

// ---------- 配对与设备（DB 事实；服务端内存做失效联动） ----------
const digestOf = (salt: string, value: string): string => createHash('sha256').update(`${salt}:${value}`).digest('hex');
const digestsEqual = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 无易混字符（0/O/1/I）
function randomCode(len: number): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length] ?? 'A';
  return out;
}

export const PAIRING_TTL_MS = 5 * 60_000;
export const PAIRING_MAX_FAILS = 5;
export const PAIRING_PER_IP_PER_MIN = 5;
export const PAIRING_GLOBAL_PER_MIN = 30;

/** 创建配对码（仅本机可信入口调用——commands 层 remote.pairing.create）。 */
export function createPairingCode(
  db: ZhongshuoDatabase,
  now: number,
  opts?: { code?: string; ttlMs?: number },
): { ok: true; pairingId: string; code: string; expiresAt: number } | { ok: false; error: string } {
  const code = opts?.code ?? randomCode(8);
  if (code.length < 8 || code.length > 64 || !/^[A-Za-z0-9]+$/.test(code)) {
    return { ok: false, error: '配对码须为 8—64 位字母数字（自定义拒绝——默认随机 8 位）' };
  }
  // 拒绝近期重复码（24h 内同明文码不重复发放）。**用历史行自己的 salt** 核验候选码
  // （第三十二轮一修复：旧实现拿新 salt 的 digest 与历史 digest 比较——同明文也永不相等，
  // 检查形同虚设；继续只持久化摘要，明文不落库）。
  const salt = randomBytes(16).toString('hex');
  const digest = digestOf(salt, code);
  const recent = db.prepare('SELECT code_salt, code_digest FROM remote_pairing_codes WHERE created_at > ?').all(now - 24 * 3600_000) as Array<{ code_salt: string; code_digest: string }>;
  if (recent.some((r) => digestsEqual(r.code_digest, digestOf(r.code_salt, code)))) {
    return { ok: false, error: '该配对码近期已用过——拒绝重复（换一个码）' };
  }
  const pairingId = `pair_${randomUUID().slice(0, 12)}`;
  const expiresAt = now + (opts?.ttlMs ?? PAIRING_TTL_MS);
  db.prepare('INSERT INTO remote_pairing_codes (pairing_id, code_salt, code_digest, created_at, expires_at, fail_count) VALUES (?, ?, ?, ?, ?, 0)').run(pairingId, salt, digest, now, expiresAt);
  return { ok: true, pairingId, code, expiresAt };
}

export function listDevices(db: ZhongshuoDatabase): Array<{ deviceId: string; deviceName: string; createdAt: number; lastSeenAt: number | null; revokedAt: number | null }> {
  return (db.prepare('SELECT device_id, device_name, created_at, last_seen_at, revoked_at FROM remote_devices ORDER BY created_at DESC').all() as Array<{ device_id: string; device_name: string; created_at: number; last_seen_at: number | null; revoked_at: number | null }>)
    .map((r) => ({ deviceId: r.device_id, deviceName: r.device_name, createdAt: r.created_at, lastSeenAt: r.last_seen_at, revokedAt: r.revoked_at }));
}

export type PairConsumeResult =
  | { ok: true; deviceId: string; deviceCredential: string }
  | { ok: false; status: 401 | 429; reason: 'invalid' | 'expired' | 'consumed' | 'invalidated' | 'ratelimited'; retryAfterSec?: number };

/** 原子消费配对码并创建设备（服务端生成 deviceId 与一次性展示的高熵凭据）。 */
export function consumePairingCode(db: ZhongshuoDatabase, ip: string, pairingId: string, code: string, deviceName: string, clientNonce: string, now: number, limits?: { perIpPerMin?: number; globalPerMin?: number }): PairConsumeResult & { clientNonce: string } {
  const perIp = limits?.perIpPerMin ?? PAIRING_PER_IP_PER_MIN;
  const global = limits?.globalPerMin ?? PAIRING_GLOBAL_PER_MIN;
  const winStart = now - 60_000;
  const ipHits = (db.prepare('SELECT count(*) c FROM remote_pairing_attempts WHERE ip = ? AND at > ?').get(ip, winStart) as { c: number }).c;
  const globalHits = (db.prepare('SELECT count(*) c FROM remote_pairing_attempts WHERE at > ?').get(winStart) as { c: number }).c;
  db.prepare('INSERT INTO remote_pairing_attempts (ip, at) VALUES (?, ?)').run(ip, now);
  if (ipHits >= perIp || globalHits >= global) {
    return { ok: false, status: 429, reason: 'ratelimited', retryAfterSec: 60, clientNonce };
  }
  if (deviceName.length === 0 || deviceName.length > 60) return { ok: false, status: 401, reason: 'invalid', clientNonce };
  const outcome = db.transaction((): PairConsumeResult => {
    const row = db.prepare('SELECT pairing_id, code_salt, code_digest, expires_at, consumed_at, fail_count FROM remote_pairing_codes WHERE pairing_id = ?').get(pairingId) as
      | { pairing_id: string; code_salt: string; code_digest: string; expires_at: number; consumed_at: number | null; fail_count: number }
      | undefined;
    if (row == null) return { ok: false, status: 401, reason: 'invalid' };
    if (row.consumed_at != null) return { ok: false, status: 401, reason: row.fail_count >= PAIRING_MAX_FAILS ? 'invalidated' : 'consumed' };
    if (row.expires_at <= now) return { ok: false, status: 401, reason: 'expired' };
    if (!digestsEqual(digestOf(row.code_salt, code), row.code_digest)) {
      const fails = row.fail_count + 1;
      if (fails >= PAIRING_MAX_FAILS) db.prepare('UPDATE remote_pairing_codes SET fail_count = ?, consumed_at = ? WHERE pairing_id = ?').run(fails, now, pairingId);
      else db.prepare('UPDATE remote_pairing_codes SET fail_count = ? WHERE pairing_id = ?').run(fails, pairingId);
      return { ok: false, status: 401, reason: 'invalid' };
    }
    db.prepare('UPDATE remote_pairing_codes SET consumed_at = ? WHERE pairing_id = ? AND consumed_at IS NULL').run(now, pairingId);
    const deviceId = `dev_${randomUUID().slice(0, 12)}`;
    const credSalt = randomBytes(16).toString('hex');
    const deviceCredential = `zc_${randomBytes(32).toString('base64url')}`;
    db.prepare('INSERT INTO remote_devices (device_id, device_name, credential_salt, credential_digest, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(deviceId, deviceName, credSalt, digestOf(credSalt, deviceCredential), now, now);
    return { ok: true, deviceId, deviceCredential };
  })();
  return { ...outcome, clientNonce };
}

/** Device 凭据核验（遍历未吊销设备比对加盐摘要——设备数为个位量级）。 */
export function verifyDeviceCredential(db: ZhongshuoDatabase, credential: string, now: number): { deviceId: string } | null {
  const rows = db.prepare('SELECT device_id, credential_salt, credential_digest FROM remote_devices WHERE revoked_at IS NULL').all() as Array<{ device_id: string; credential_salt: string; credential_digest: string }>;
  for (const r of rows) {
    if (digestsEqual(digestOf(r.credential_salt, credential), r.credential_digest)) {
      db.prepare('UPDATE remote_devices SET last_seen_at = ? WHERE device_id = ?').run(now, r.device_id);
      return { deviceId: r.device_id };
    }
  }
  return null;
}

/** 吊销（本机可信入口）：持久事实+服务端内存联动（token/票据/活连接由实例收口）。 */
export function revokeDeviceInDb(db: ZhongshuoDatabase, deviceId: string, now: number): boolean {
  const r = db.prepare('UPDATE remote_devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(now, deviceId);
  return r.changes === 1;
}

// ---------- 服务端 ----------
/** 远程通道保留给本机可信入口的方法（配对码创建/服务配置/吊销/关停/隔离自检——R11 §1/§3）。 */
export const REMOTE_BLOCKED_METHODS = new Set(['remote.pairing.create', 'remote.pairing.selfcheck', 'remote.pairing.selfcheckProbe', 'remote.pairing.selfcheckExport', 'remote.config.set', 'remote.config.get', 'remote.device.revoke', 'remote.devices.list', 'daemon.shutdown']);

export type RemoteGateOutcome = { ok: true } | { ok: false; code: string; message: string };

/**
 * 服务端构造的远程调用上下文（第三十三轮二：从「事后审计」升级为**共享命令门禁**）：
 * - deviceId/deviceEpoch：可信设备身份与**设备级**授权代次（不信客户端自报）；
 * - gate：进入命令面与业务提交前（commands.ts run() 边界）重查设备吊销/代次/会话有效性——
 *   异步工作（附件解析、导出）完成后提交前也走同一门禁。
 * 业务作者恒为设备代表的本机用户（localUserId）——不影响幂等 scope/payloadHash。
 */
export interface RemoteCallContext {
  deviceId: string;
  deviceEpoch: number;
  gate: () => RemoteGateOutcome;
}

export interface RemoteServerDeps {
  db: ZhongshuoDatabase;
  localUserId: string;
  appDataDir: string;
  /** 与桌面同一命令面（同 deps → 同权限/幂等 scope）；ctx=服务端构造的远程上下文（null=非远程）。 */
  dispatch: (envelope: unknown, ctx: RemoteCallContext | null) => Promise<unknown>;
  log?: (line: string) => void;
  now?: () => number;
  /** 测试钩子：时钟与窗口。 */
  testing?: { tokenTtlMs?: number; ticketTtlMs?: number; authWindowMs?: number; pumpMs?: number; resumeWindow?: number; perIpPerMin?: number; globalPerMin?: number; identity?: RemoteServerIdentity; closeGraceMs?: number; stopDeadlineMs?: number; unauthPerAddr?: number; unauthGlobal?: number };
}

interface TokenEntry { deviceId: string; expiresAt: number; deviceEpoch: number }
/** 票据完整绑定：设备+签发来源 Origin（消费比对）+会话 token 摘要+会话有效期+**设备级**授权代次。 */
interface TicketEntry { deviceId: string; origin: string; sessionTokenHash: string; sessionExpiresAt: number; deviceEpoch: number; expiresAt: number }
interface WsConn {
  ws: WsSocket;
  addr: string;
  origin: string;
  authed: boolean;
  deviceId: string | null;
  sessionExpiresAt: number;
  subs: Set<string>;
  /** 认证基线（全局 lastSeq/current）——迟后订阅的项目水位默认从此起。 */
  authBase: number;
  /** 每项目投递水位（latch 只前进；未订阅项目不推进——订阅后仍可收到）。 */
  projNext: Map<string, number>;
  closed: boolean;
  closing: boolean;
  authTimer: NodeJS.Timeout | null;
  sessionTimer: NodeJS.Timeout | null;
  closeTimer: NodeJS.Timeout | null;
}

const BODY_CAP_CMD = 48 * 1024 * 1024; // /cmd 承载 base64 附件（图片上限 ~27MB base64）
const BODY_CAP_SMALL = 8 * 1024;
const EXPORT_MAX_ASSETS = 200; // 资产额度（manifest.files——必要元文件 index/manifest 不占）
const EXPORT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const WS_MAX_PAYLOAD = 64 * 1024; // 认证/订阅小消息上限（完整消息大小——ws maxPayload）
const WS_MAX_SUBS = 200;
const WS_SLOW_CLIENT_BYTES = 8 * 1024 * 1024; // 发送缓冲积压（慢客户端）——超限关闭
const WS_UNAUTH_PER_ADDR = 2;
const WS_UNAUTH_GLOBAL = 32;
const CLOSE_GRACE_MS = 3000;
const STOP_DEADLINE_MS = 5000;

export class RemoteAccessServer {
  private readonly deps: RemoteServerDeps;
  private server: HttpsServer | null = null;
  private wss: WebSocketServer | null = null;
  private identity: RemoteServerIdentity | null = null;
  private readonly tokens = new Map<string, TokenEntry>();
  private readonly tickets = new Map<string, TicketEntry>();
  private readonly conns = new Set<WsConn>();
  private pumpTimer: NodeJS.Timeout | null = null;
  private allowedHostHeaders = new Set<string>();
  private allowedOrigins = new Set<string>();
  private boundPort = 0;
  private boundHost = '';
  private stopped = false;
  private readonly now: () => number;

  constructor(deps: RemoteServerDeps) {
    this.deps = deps;
    this.now = deps.now ?? ((): number => Date.now());
  }

  /** 续传窗口（默认 5000 事件；ZS_REMOTE_RESUME_WINDOW 可调——打包形态页面验收用）。 */
  private resumeWindow(): number {
    const envW = Number(process.env.ZS_REMOTE_RESUME_WINDOW);
    return this.deps.testing?.resumeWindow ?? (Number.isFinite(envW) && envW > 0 ? envW : 5000);
  }

  private maxEventSeq(): number {
    const r = this.deps.db.prepare('SELECT max(seq) m FROM domain_events').get() as { m: number | null };
    return r.m ?? 0;
  }

  private maxEventSeqFor(projectId: string): number {
    const r = this.deps.db.prepare('SELECT max(seq) m FROM domain_events WHERE project_id = ?').get(projectId) as { m: number | null };
    return r.m ?? 0;
  }

  private log(line: string): void {
    // 脱敏通道：调用方只传不含明文凭据的行（测试断言）。截断防误带长正文。
    this.deps.log?.(line.slice(0, 300));
  }

  /** Host/Origin 白名单来自本机配置（监听地址推导），不从请求扩名单。 */
  private computeAllowed(listenHost: string, port: number): void {
    const names = new Set<string>();
    names.add(`127.0.0.1:${port}`);
    names.add(`localhost:${port}`);
    if (listenHost === '0.0.0.0' || listenHost === '::') {
      for (const list of Object.values(networkInterfaces())) {
        for (const ni of list ?? []) {
          if (ni.family === 'IPv4') names.add(`${ni.address}:${port}`);
        }
      }
    } else {
      names.add(`${listenHost}:${port}`);
    }
    this.allowedHostHeaders = new Set([...names].map((n) => n.toLowerCase()));
    this.allowedOrigins = new Set([...names].map((n) => `https://${n}`));
  }

  private hostAllowed(req: IncomingMessage): boolean {
    const h = String(req.headers.host ?? '').toLowerCase();
    return this.allowedHostHeaders.has(h);
  }

  private originAllowed(req: IncomingMessage): boolean {
    const o = req.headers.origin;
    if (o == null) return false;
    return this.allowedOrigins.has(String(o).toLowerCase());
  }

  /** 下载（同源 GET）：浏览器同源 GET fetch 不带 Origin（规范行为）——Origin 缺席=同源/
   * 非浏览器，凭 Authorization 承担认证；**携带** Origin 时必须在白名单（跨源拒绝）。 */
  private originAllowedForDownload(req: IncomingMessage): boolean {
    const o = req.headers.origin;
    if (o == null) return true;
    return this.allowedOrigins.has(String(o).toLowerCase());
  }

  async start(cfg?: Partial<RemoteConfig>): Promise<{ address: string; port: number; fingerprint: string }> {
    if (this.server != null) throw new Error('远程服务已在运行');
    const conf: RemoteConfig = { ...readRemoteConfig(this.deps.db), ...(cfg ?? {}) };
    const identity = this.deps.testing?.identity != null
      ? { ok: true as const, identity: this.deps.testing.identity }
      : ensureServerIdentity(this.deps.appDataDir, conf.listenHost, conf.listenHost === '0.0.0.0' || conf.allowLan ? lanIps() : []);
    if (!identity.ok) throw new Error(identity.error);
    this.identity = identity.identity;
    this.stopped = false;
    this.server = createHttpsServer({ key: this.identity.keyPem, cert: this.identity.certChainPem }, (req, res) => { void this.handleHttp(req, res); });
    // WSS：握手与帧协议由 ws 库承担（掩码/分片/UTF-8/背压）；maxPayload=认证前小消息上限。
    this.wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false });
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    const port = await new Promise<number>((resolveP, rejectP) => {
      const onError = (e: Error): void => { rejectP(e); };
      this.server!.once('error', onError);
      this.server!.listen(conf.port, conf.listenHost, () => {
        this.server!.off('error', onError);
        const addr = this.server!.address();
        resolveP(addr != null && typeof addr === 'object' ? (addr as { port: number }).port : conf.port);
      });
    });
    this.boundPort = port;
    this.boundHost = conf.listenHost;
    this.computeAllowed(conf.listenHost, port);
    this.pumpTimer = setInterval(() => this.pumpEvents(), this.deps.testing?.pumpMs ?? 1000);
    this.pumpTimer.unref?.();
    const displayHost = conf.listenHost === '0.0.0.0' || conf.listenHost === '::' ? (primaryLanIp() ?? '127.0.0.1') : conf.listenHost;
    const addr = `https://${displayHost}:${port}`;
    this.log(`[remote] listening ${addr} fingerprint=${this.identity.fingerprintSha256.slice(0, 12)}…`);
    return { address: addr, port, fingerprint: this.identity.fingerprintSha256 };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pumpTimer != null) { clearInterval(this.pumpTimer); this.pumpTimer = null; }
    // 有界收拢（第三十三轮二）：先礼后兵——发起关闭，宽限内等真正关闭；到点 terminate 清场。
    for (const c of [...this.conns]) this.closeConn(c, 1001, 'server-stop');
    const deadline = this.now() + (this.deps.testing?.stopDeadlineMs ?? STOP_DEADLINE_MS);
    while (this.conns.size > 0 && this.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const c of [...this.conns]) {
      try { c.ws.terminate(); } catch { /* 尽力 */ }
      this.cleanupConn(c);
    }
    this.tokens.clear();
    this.tickets.clear();
    const s = this.server;
    const wss = this.wss;
    this.server = null;
    this.wss = null;
    this.boundPort = 0; // 运行态清零——currentAddress 不再把停用显示成运行中
    this.boundHost = '';
    if (wss != null) { try { await new Promise<void>((r) => { const t = setTimeout(r, 1000); wss.close(() => { clearTimeout(t); r(); }); }); } catch { /* 尽力 */ } }
    if (s != null) {
      await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections?.(); });
    }
  }

  /**
   * 吊销联动（第三十三轮二：**设备级**）：递增该设备 auth_epoch（迁移 040）+撤销该设备的
   * token/票据/活连接。**其他设备不受影响**（B 的 token/票据/WS 继续有效）。
   */
  invalidateDevice(deviceId: string): void {
    try {
      this.deps.db.prepare('UPDATE remote_devices SET auth_epoch = auth_epoch + 1 WHERE device_id = ?').run(deviceId);
    } catch { /* 持久事实以 revoked_at 为准（吊销命令已写）——代次递增尽力 */ }
    for (const [t, e] of this.tokens) if (e.deviceId === deviceId) this.tokens.delete(t);
    for (const [t, e] of this.tickets) if (e.deviceId === deviceId) this.tickets.delete(t);
    for (const c of [...this.conns]) if (c.deviceId === deviceId) this.closeConn(c, 1008, 'revoked');
  }

  /**
   * 共享命令门禁（第三十三轮二）：设备/代次/会话实时有效性核对——dispatch 进入时与业务
   * 提交前（commands.ts run() 边界）调用。吊销≠停止：已授权运行中的任务不在此收口。
   */
  deviceLive(deviceId: string, deviceEpoch: number, token?: string | null): RemoteGateOutcome {
    // 设备事实优先（吊销/代次变化是最强信号——不被 token 联动删除掩盖成 TOKEN_INVALID）。
    const dev = this.deps.db.prepare('SELECT revoked_at, auth_epoch FROM remote_devices WHERE device_id = ?').get(deviceId) as { revoked_at: number | null; auth_epoch: number } | undefined;
    if (dev == null || dev.revoked_at != null) return { ok: false, code: 'DEVICE_REVOKED', message: '设备已吊销（提交前重查拒绝）' };
    if (dev.auth_epoch !== deviceEpoch) return { ok: false, code: 'DEVICE_REVOKED', message: '设备授权代次变化（提交前重查拒绝）' };
    if (token != null) {
      const entry = this.tokens.get(token);
      if (entry == null) return { ok: false, code: 'TOKEN_INVALID', message: 'accessToken 无效或已吊销（提交前重查）' };
      if (entry.expiresAt <= this.now()) {
        this.tokens.delete(token);
        return { ok: false, code: 'TOKEN_EXPIRED', message: 'accessToken 已过期（提交前重查）——用 deviceCredential 换新' };
      }
    }
    return { ok: true };
  }

  /** 实际监听事实（第三十二轮四：0.0.0.0 时给 LAN 地址；停用/未启动=null——不再恒回环）。 */
  currentAddress(): { address: string; port: number; fingerprint: string; caFingerprint: string; lanAddresses: string[]; lanAddressDetails: Array<{ address: string; url: string; note: string | null }>; certNotAfter: string; certSubject: string; certIssuer: string } | null {
    if (this.server == null || this.identity == null || this.boundPort === 0) return null; // 停用/未启动=null（不显示运行中）
    const displayHost = this.boundHost === '0.0.0.0' || this.boundHost === '::' ? (primaryLanIp() ?? '127.0.0.1') : this.boundHost;
    return {
      address: `https://${displayHost}:${this.boundPort}`,
      port: this.boundPort,
      fingerprint: this.identity.fingerprintSha256, // 服务证书完整 64 位（页面所见——逐位核对）
      caFingerprint: this.identity.caFingerprintSha256, // CA（信任根）完整 64 位——用户导入 ca.cer 时核对
      lanAddresses: this.boundHost === '0.0.0.0' || this.boundHost === '::' ? lanIps().map((ip) => `https://${ip}:${this.boundPort}`) : [],
      // 地址明细（第三十八轮：多网卡逐地址可复制+虚拟网卡标注——不把 Meta Tunnel 的
      // 198.18.0.1 当真实 LAN 推荐）。
      lanAddressDetails: this.boundHost === '0.0.0.0' || this.boundHost === '::' ? lanAddressDetails(this.boundPort) : [],
      certNotAfter: this.identity.notAfter,
      certSubject: this.identity.subject,
      certIssuer: this.identity.issuer,
    };
  }

  /**
   * LAN 绑定自检（第三十六轮二）：服务机本机经**实际 LAN IP** 发起 HTTPS（以本地 CA 为信任锚）
   * ——通过=证书链对 LAN 名称有效+监听真实可达；失败区分「本机 LAN 绑定/TLS」与「跨机防火墙」
   * 两层（跨机问题不在本函数断言范围——客户端错误码需另行取得，不预判定性）。
   * 第三十八轮：优先无虚拟网卡疑点的地址（198.18.x.x 自检通过≠另一台机器可达）。
   */
  async verifyLanBinding(): Promise<{ ok: boolean; checkedUrl: string; error: string | null }> {
    if (this.server == null || this.identity == null || this.boundPort === 0) return { ok: false, checkedUrl: '', error: '服务未运行' };
    const lan = lanIps();
    if (lan.length === 0) return { ok: false, checkedUrl: '', error: '未发现非回环网络地址（仅本机模式？其它设备无法连接）' };
    const preferred = lan.find((ip) => lanAddressNoteOf(ip) == null) ?? lan[0]!;
    const url = `https://${preferred}:${this.boundPort}/`;
    const ac = new https.Agent({ ca: this.identity.caCertPem, servername: 'localhost' });
    const outcome = await new Promise<{ ok: boolean; error: string | null }>((resolveP) => {
      const req = https.request(url, { method: 'GET', agent: ac, timeout: 5000, rejectUnauthorized: true }, (res) => {
        res.resume();
        resolveP({ ok: (res.statusCode ?? 0) < 500, error: null });
      });
      req.on('error', (e) => resolveP({ ok: false, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolveP({ ok: false, error: '本机经 LAN 地址 HTTPS 超时' }); });
      req.end();
    });
    return { ok: outcome.ok, checkedUrl: url, error: outcome.error };
  }

  // ---------- HTTP ----------
  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'https://localhost');
      const path = url.pathname;
      if (!this.hostAllowed(req)) { this.reply(res, 403, { ok: false, error: { code: 'HOST_FORBIDDEN', message: 'Host 不在白名单（来自本机配置——不自动扩名单）' } }); return; }
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss:", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
        res.end(REMOTE_CLIENT_HTML);
        return;
      }
      if (req.method === 'GET' && path === '/app.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'x-content-type-options': 'nosniff' });
        res.end(REMOTE_CLIENT_JS);
        return;
      }
      if (req.method === 'POST' && path === '/pair') { await this.handlePair(req, res); return; }
      if (req.method === 'POST' && path === '/session') { await this.handleSession(req, res); return; }
      if (req.method === 'POST' && path === '/ws-ticket') { await this.handleWsTicket(req, res); return; }
      if (req.method === 'POST' && path === '/cmd') { await this.handleCmd(req, res); return; }
      if (req.method === 'GET' && /^\/export\/[A-Za-z0-9_-]+\/download$/.test(path)) { await this.handleExportDownload(req, res, path); return; }
      this.reply(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `无此路由：${path}（配对码创建走本机可信 UI）` } });
    } catch (error) {
      this.log(`[remote] http error ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) this.reply(res, 500, { ok: false, error: { code: 'INTERNAL', message: '服务内部错误' } });
      else res.end();
    }
  }

  private reply(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(json);
  }

  private readBody(req: IncomingMessage, cap: number): Promise<Buffer> {
    return new Promise((resolveB, rejectB) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (c: Buffer) => {
        total += c.length;
        if (total > cap) { rejectB(new Error('PAYLOAD_TOO_LARGE')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolveB(Buffer.concat(chunks)));
      req.on('error', rejectB);
    });
  }

  /** /pair：唯一免既有 token 的入口——仍核对 Origin/Host + JSON 类型 + 大小限制。 */
  private async handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.originAllowed(req)) { this.reply(res, 403, { ok: false, error: { code: 'ORIGIN_FORBIDDEN', message: 'Origin 不在白名单（本机配置推导）' } }); return; }
    const ct = String(req.headers['content-type'] ?? '');
    if (!ct.startsWith('application/json')) { this.reply(res, 415, { ok: false, error: { code: 'BAD_CONTENT_TYPE', message: '仅接受 application/json' } }); return; }
    let body: { pairingId?: string; code?: string; deviceName?: string; clientNonce?: string };
    try {
      const raw = await this.readBody(req, BODY_CAP_SMALL);
      body = JSON.parse(raw.toString('utf8')) as typeof body;
    } catch {
      this.reply(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: '请求体不是合法 JSON（≤8KB）' } });
      return;
    }
    if (typeof body.pairingId !== 'string' || typeof body.code !== 'string' || typeof body.deviceName !== 'string' || typeof body.clientNonce !== 'string' || body.clientNonce.length > 128) {
      this.reply(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: '缺少 pairingId/code/deviceName/clientNonce' } });
      return;
    }
    const ip = req.socket.remoteAddress ?? 'unknown';
    const now = this.now();
    const outcome = consumePairingCode(this.deps.db, ip, body.pairingId, body.code, body.deviceName, body.clientNonce, now, this.deps.testing);
    if (!outcome.ok) {
      if (outcome.status === 429) {
        res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(outcome.retryAfterSec ?? 60), 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: { code: 'RATE_LIMITED', message: '尝试过于频繁——稍后再试' } }));
        this.log(`[remote] pair 429 ip=${ip}`);
        return;
      }
      this.reply(res, 401, { ok: false, error: { code: 'PAIR_REJECTED', message: '配对码无效或已使用/过期' }, reason: outcome.reason, clientNonce: outcome.clientNonce });
      this.log(`[remote] pair rejected pairing=${body.pairingId.slice(0, 8)}… reason=${outcome.reason}`);
      return;
    }
    this.log(`[remote] pair ok device=${outcome.deviceId}`);
    this.reply(res, 200, { ok: true, deviceId: outcome.deviceId, deviceCredential: outcome.deviceCredential, clientNonce: outcome.clientNonce });
  }

  private bearer(req: IncomingMessage): string | null {
    const h = String(req.headers.authorization ?? '');
    if (!h.startsWith('Bearer ')) return null;
    return h.slice(7).trim();
  }

  private checkToken(token: string | null): { deviceId: string; expiresAt: number; deviceEpoch: number } | { status: number; code: string; message: string } {
    if (token == null || token.length === 0) return { status: 401, code: 'UNAUTHENTICATED', message: '缺少 Bearer accessToken' };
    const entry = this.tokens.get(token);
    if (entry == null) return { status: 401, code: 'TOKEN_INVALID', message: 'accessToken 无效或已吊销' };
    if (entry.expiresAt <= this.now()) {
      this.tokens.delete(token);
      return { status: 401, code: 'TOKEN_EXPIRED', message: 'accessToken 已过期——用 deviceCredential 换新' };
    }
    const live = this.deviceLive(entry.deviceId, entry.deviceEpoch);
    if (!live.ok) {
      this.tokens.delete(token);
      return { status: 401, code: live.code === 'TOKEN_EXPIRED' ? 'TOKEN_EXPIRED' : 'DEVICE_REVOKED', message: live.message };
    }
    return { deviceId: entry.deviceId, expiresAt: entry.expiresAt, deviceEpoch: entry.deviceEpoch };
  }

  /** /session：Device 凭据 → 15 分钟 accessToken（仅内存；轮换不撤销 deviceCredential）。 */
  private async handleSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.originAllowed(req)) { this.reply(res, 403, { ok: false, error: { code: 'ORIGIN_FORBIDDEN', message: 'Origin 不在白名单' } }); return; }
    const h = String(req.headers.authorization ?? '');
    if (!h.startsWith('Device ')) { this.reply(res, 401, { ok: false, error: { code: 'UNAUTHENTICATED', message: '缺少 Device 凭据（不接受用户名自报）' } }); return; }
    const credential = h.slice(7).trim();
    const now = this.now();
    const dev = verifyDeviceCredential(this.deps.db, credential, now);
    if (dev == null) { this.reply(res, 401, { ok: false, error: { code: 'CREDENTIAL_INVALID', message: '设备凭据无效或已吊销' } }); this.log('[remote] session rejected'); return; }
    const token = randomBytes(32).toString('base64url');
    // 环境可调（第三十二轮五：打包形态的页面级到期续换验证；生产默认 15 分钟）。
    const envTtl = Number(process.env.ZS_REMOTE_TOKEN_TTL_MS);
    const ttl = this.deps.testing?.tokenTtlMs ?? (Number.isFinite(envTtl) && envTtl > 0 ? envTtl : 15 * 60_000);
    const epoch = (this.deps.db.prepare('SELECT auth_epoch FROM remote_devices WHERE device_id = ?').get(dev.deviceId) as { auth_epoch: number }).auth_epoch;
    this.tokens.set(token, { deviceId: dev.deviceId, expiresAt: now + ttl, deviceEpoch: epoch });
    this.log(`[remote] session ok device=${dev.deviceId}`);
    this.reply(res, 200, { ok: true, accessToken: token, tokenType: 'bearer', expiresIn: Math.floor(ttl / 1000) });
  }

  /** /ws-ticket：Bearer token → 30 秒单次票据（完整绑定 device+origin+会话+设备代次）。 */
  private async handleWsTicket(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.originAllowed(req)) { this.reply(res, 403, { ok: false, error: { code: 'ORIGIN_FORBIDDEN', message: 'Origin 不在白名单' } }); return; }
    const token = this.bearer(req);
    const check = this.checkToken(token);
    if ('status' in check) { this.reply(res, check.status, { ok: false, error: { code: check.code, message: check.message } }); return; }
    const origin = String(req.headers.origin ?? '').toLowerCase();
    const ticket = randomBytes(32).toString('base64url');
    const ttl = this.deps.testing?.ticketTtlMs ?? 30_000;
    this.tickets.set(ticket, {
      deviceId: check.deviceId,
      origin,
      sessionTokenHash: digestOf('session', String(token)),
      sessionExpiresAt: check.expiresAt,
      deviceEpoch: check.deviceEpoch,
      expiresAt: this.now() + ttl,
    });
    this.reply(res, 200, { ok: true, ticket, expiresIn: Math.floor(ttl / 1000) });
  }

  /** /cmd：Bearer token → 同一命令面（同权限/同幂等 scope；阻断本机保留方法）。 */
  private async handleCmd(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.originAllowed(req)) { this.reply(res, 403, { ok: false, error: { code: 'ORIGIN_FORBIDDEN', message: 'Origin 不在白名单' } }); return; }
    const token = this.bearer(req);
    const check = this.checkToken(token);
    if ('status' in check) { this.reply(res, check.status, { ok: false, error: { code: check.code, message: check.message } }); return; }
    let body: { commandId?: string; method?: string; params?: unknown; expectedRevision?: number };
    try {
      const raw = await this.readBody(req, BODY_CAP_CMD);
      body = JSON.parse(raw.toString('utf8')) as typeof body;
    } catch {
      this.reply(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: '请求体不是合法 JSON（≤48MB）' } });
      return;
    }
    if (typeof body.commandId !== 'string' || typeof body.method !== 'string') {
      this.reply(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: '缺少 commandId/method' } });
      return;
    }
    // **吊销重查（第三十二轮一）**：大请求体（附件 base64）读取/解析期间设备可能被吊销——
    // 派发前重查 token/代次/吊销事实，不放过在途窗口。
    const recheck = this.checkToken(token);
    if ('status' in recheck) { this.reply(res, recheck.status, { ok: false, error: { code: recheck.code, message: recheck.message } }); return; }
    if (REMOTE_BLOCKED_METHODS.has(body.method)) {
      this.reply(res, 403, { ok: false, error: { code: 'REMOTE_METHOD_BLOCKED', message: `远程通道不开放：${body.method}（仅本机可信 UI）` } });
      this.log(`[remote] cmd blocked device=${recheck.deviceId} method=${body.method}`);
      return;
    }
    const envelope: Record<string, unknown> = { protocolVersion: 1, commandId: body.commandId, method: body.method, params: body.params ?? {} };
    if (body.expectedRevision != null) envelope.expectedRevision = body.expectedRevision;
    // CallerContext 由服务端构造（deviceId+deviceEpoch+gate 提交前重查闭包）——业务作者恒 localUserId。
    const ctx: RemoteCallContext = {
      deviceId: recheck.deviceId,
      deviceEpoch: recheck.deviceEpoch,
      gate: (): RemoteGateOutcome => this.deviceLive(recheck.deviceId, recheck.deviceEpoch, token),
    };
    const result = await this.deps.dispatch(envelope, ctx);
    this.log(`[remote] cmd device=${recheck.deviceId} method=${body.method} ok=${(result as { ok?: boolean }).ok === true}`);
    this.reply(res, 200, result);
  }

  /** /export/:id/download：获准下载——audience 重查+实根+逐文件完整性+明确限额+异步 zip。 */
  private async handleExportDownload(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (!this.originAllowedForDownload(req)) { this.reply(res, 403, { ok: false, error: { code: 'ORIGIN_FORBIDDEN', message: 'Origin 不在白名单' } }); return; }
    const token = this.bearer(req);
    const check = this.checkToken(token);
    if ('status' in check) { this.reply(res, check.status, { ok: false, error: { code: check.code, message: check.message } }); return; }
    const parts = path.split('/');
    const exportId = parts[2] ?? '';
    if (!/^exp_[A-Za-z0-9_-]+$/.test(exportId)) { this.reply(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: '非法 exportId' } }); return; }
    const base = resolve(join(this.deps.appDataDir, 'exports'));
    const dir = resolve(join(base, exportId));
    const sepCh = base.includes('/') ? '/' : String.fromCharCode(92);
    if (!dir.startsWith(base + sepCh)) {
      this.reply(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: '路径越界拒绝' } });
      return;
    }
    // 实根（第三十二轮三）：realpath 核对实际文件身份（链接/junction 拒）。
    let realDir: string;
    let realBase: string;
    try {
      realDir = realpathSync(dir);
      realBase = realpathSync(base);
    } catch {
      this.reply(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `导出不存在：${exportId}` } });
      return;
    }
    if (!realDir.startsWith(realBase + sepCh)) { this.reply(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: '路径含链接越界（realpath 拒绝）' } }); return; }
    // audience 重查（第三十二轮三）：manifest 记录导出目标会话——DM=本人参与才可下载；
    // 清单缺失/损坏=不可核验归属，明确拒绝（不冒充可下载）。
    let manifest: { conversationId?: string; files?: Array<{ file: string; bytes: number; sha256: string }>; primary?: { file: string; bytes: number; sha256: string } };
    try {
      manifest = JSON.parse(readFileSync(join(realDir, 'manifest.json'), 'utf8')) as typeof manifest;
    } catch {
      this.reply(res, 410, { ok: false, error: { code: 'EXPORT_UNVERIFIABLE', message: '导出清单缺失或损坏——归属不可核验，拒绝下载' } });
      return;
    }
    if (typeof manifest.conversationId !== 'string' || !Array.isArray(manifest.files)) {
      this.reply(res, 410, { ok: false, error: { code: 'EXPORT_UNVERIFIABLE', message: '导出清单结构不符——拒绝下载' } });
      return;
    }
    const conv = this.deps.db.prepare('SELECT id, kind FROM conversations WHERE id = ?').get(manifest.conversationId) as { id: string; kind: string } | undefined;
    if (conv == null) { this.reply(res, 410, { ok: false, error: { code: 'EXPORT_UNVERIFIABLE', message: '导出目标会话已不存在——拒绝下载' } }); return; }
    if (conv.kind === 'dm') {
      const inDm = this.deps.db.prepare("SELECT 1 FROM dm_participants dp WHERE dp.conversation_id = ? AND dp.principal_type = 'human' AND dp.principal_id = ?").get(conv.id, this.deps.localUserId);
      if (inDm == null) { this.reply(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: '导出目标属他人私信会话——拒绝下载' } }); return; }
    }
    // **资产额度与必要元文件分离（第三十三轮五）**：额度=manifest.files（资产附件）；
    // index.md/index.html/export.docx 与 manifest.json 是必要元文件，不占资产额度——
    // 合法的 200 件资产导出（+正文+清单=202 个文件）完整下载，201 件资产明确拒绝。
    if (manifest.files.length > EXPORT_MAX_ASSETS) {
      this.reply(res, 413, { ok: false, error: { code: 'EXPORT_TOO_LARGE', message: `导出资产 ${manifest.files.length} 件超上限 ${EXPORT_MAX_ASSETS}——明确拒绝（正文/清单等必要元文件不占额度）` } });
      return;
    }
    // 收集全量条目（不提前 break——超限在资产额度上明确拒绝，不静默截断）。
    const entries: Array<{ rel: string; abs: string; size: number }> = [];
    const walk = (d: string, rel: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const abs = join(d, e.name);
        const r = rel.length === 0 ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) walk(abs, r);
        else entries.push({ rel: r, abs, size: statSync(abs).size });
      }
    };
    try { walk(realDir, ''); } catch {
      this.reply(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '导出目录不可读' } });
      return;
    }
    if (entries.length === 0) { this.reply(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '导出目录为空' } }); return; }
    const total = entries.reduce((s2, e) => s2 + e.size, 0);
    if (total > EXPORT_MAX_TOTAL_BYTES) { this.reply(res, 413, { ok: false, error: { code: 'EXPORT_TOO_LARGE', message: `导出包 ${total}B 超下载上限` } }); return; }
    // 逐文件完整性（第三十三轮五重做）：**单次受控读取**——同一句柄读出的字节先 sha256 对
    // manifest 核验，**核验通过的字节直接保留进 ZIP**（不再校验后另读一次——ZIP 使用的恒为
    // 已验证字节）；主文件（index/export.docx）哈希核验同样执行（旧实现 bytes 后 continue
    // 使主文件核验不可达——同长度篡改正文曾可过）。
    const manifestByName = new Map(manifest.files.map((f) => [f.file, f]));
    const primaryName = typeof manifest.primary?.file === 'string' ? manifest.primary.file : null;
    const verified: Record<string, Uint8Array> = {};
    try {
      // 反向核对：清单所列资产文件必须都在目录中（缺失=不完整——200 件附件不得被截）。
      const entryRels = new Set(entries.map((e) => e.rel));
      for (const f of manifest.files) {
        if (!entryRels.has(f.file)) throw new Error(`清单文件缺失：${f.file}`);
      }
      if (primaryName != null && !entryRels.has(primaryName)) throw new Error(`导出主文件缺失：${primaryName}`);
      for (const e of entries) {
        if (e.rel === 'manifest.json') { verified[e.rel] = new Uint8Array(await fsp.readFile(e.abs)); continue; } // 清单自身由结构校验承载
        const expect = e.rel === primaryName ? manifest.primary : manifestByName.get(e.rel);
        if (expect == null) throw new Error(`目录存在清单未列文件：${e.rel}`);
        if (expect.bytes !== e.size) throw new Error(`导出内容与清单不符：${e.rel}`);
        const fh = await fsp.open(e.abs, 'r');
        let bytes: Buffer;
        try {
          bytes = Buffer.allocUnsafe(e.size);
          let off = 0;
          for (; off < e.size;) {
            const { bytesRead } = await fh.read(bytes, off, e.size - off, null);
            if (bytesRead <= 0) break;
            off += bytesRead;
          }
          if (off !== e.size) throw new Error(`读取不完整：${e.rel}`);
        } finally { await fh.close().catch(() => { /* 尽力 */ }); }
        if (createHash('sha256').update(bytes).digest('hex') !== expect.sha256) throw new Error(`导出文件完整性不符：${e.rel}`);
        verified[e.rel] = new Uint8Array(bytes); // 已验证字节直接进 ZIP
      }
    } catch (error) {
      this.reply(res, 410, { ok: false, error: { code: 'EXPORT_TAMPERED', message: `导出完整性核验失败（${error instanceof Error ? error.message : String(error)}）——拒绝下载` } });
      return;
    }
    // 发送前重查下载权限（第三十三轮五）：异步核验期间 token 可能到期/设备被吊销。
    const preSend = this.checkToken(token);
    if ('status' in preSend) { this.reply(res, preSend.status, { ok: false, error: { code: preSend.code, message: preSend.message } }); return; }
    // fflate 异步 zip（worker 池承接 deflate——不阻塞事件循环）。
    const zipBytes = await new Promise<Uint8Array>((resolveZ, rejectZ) => {
      zip(verified, { level: 1 }, (err, data) => { if (err != null) rejectZ(err); else resolveZ(data); });
    });
    const zipBuf = Buffer.from(zipBytes);
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(zipBuf.length), 'content-disposition': `attachment; filename="${exportId}.zip"`, 'cache-control': 'no-store' });
    res.end(zipBuf);
    this.log(`[remote] export download device=${check.deviceId} export=${exportId} files=${entries.length} assets=${manifest.files.length} bytes=${zipBuf.length}`);
  }

  // ---------- WSS（ws 库承接握手/帧；应用层合同在此） ----------
  private handleUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/events') { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    if (!this.hostAllowed(req) || !this.originAllowed(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    // 未认证连接限额（第三十三轮二实装）：**按真实来源地址** 2 个+全局 32——第三十二轮取
    // addr 后 void 掉只查全局，每地址限额形同虚设。
    const addr = (socket as unknown as { remoteAddress?: string }).remoteAddress ?? (req.socket.remoteAddress ?? 'unknown');
    const perAddr = this.deps.testing?.unauthPerAddr ?? WS_UNAUTH_PER_ADDR;
    const global = this.deps.testing?.unauthGlobal ?? WS_UNAUTH_GLOBAL;
    const unauthAddr = [...this.conns].filter((c) => !c.authed && !c.closed && c.addr === addr).length;
    const unauthTotal = [...this.conns].filter((c) => !c.authed && !c.closed).length;
    if (unauthAddr >= perAddr || unauthTotal >= global) { socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); socket.destroy(); return; }
    // ws 库校验 Sec-WebSocket-Key/版本并完成 101 应答；maxPayload 承接帧上限。
    this.wss?.handleUpgrade(req, socket, head, (ws) => this.onWsConnection(ws, req, addr));
  }

  private onWsConnection(ws: WsSocket, req: IncomingMessage, addr: string): void {
    const conn: WsConn = {
      ws,
      addr,
      origin: String(req.headers.origin ?? '').toLowerCase(),
      authed: false,
      deviceId: null,
      sessionExpiresAt: 0,
      subs: new Set(),
      authBase: 0,
      projNext: new Map(),
      closed: false,
      closing: false,
      authTimer: null,
      sessionTimer: null,
      closeTimer: null,
    };
    this.conns.add(conn);
    conn.authTimer = setTimeout(() => {
      if (!conn.authed && !conn.closed) {
        this.log('[remote] ws auth timeout');
        this.closeConn(conn, 1008, 'auth-timeout');
      }
    }, this.deps.testing?.authWindowMs ?? 5000);
    ws.on('message', (data) => {
      try {
        this.onWsMessage(conn, data.toString('utf8'));
      } catch (error) {
        // 协议处理异常只关该连接（第三十二轮二：null 首帧等结构错误曾未捕获冒泡）。
        this.log(`[remote] ws protocol error ${error instanceof Error ? error.message : String(error)}`);
        this.closeConn(conn, 1011, 'protocol-error');
      }
    });
    ws.on('error', () => this.closeConn(conn, 1011, 'socket-error'));
    ws.on('close', () => this.cleanupConn(conn));
  }

  /** 真正的清理：只在连接关闭（或强杀核实）后释放——计数（每地址/全局）随之准确。 */
  private cleanupConn(conn: WsConn): void {
    if (conn.closed) return;
    conn.closed = true;
    if (conn.authTimer != null) { clearTimeout(conn.authTimer); conn.authTimer = null; }
    if (conn.sessionTimer != null) { clearTimeout(conn.sessionTimer); conn.sessionTimer = null; }
    if (conn.closeTimer != null) { clearTimeout(conn.closeTimer); conn.closeTimer = null; }
    this.conns.delete(conn);
  }

  /**
   * 有界关闭收拢（第三十三轮二）：发起 close 握手→宽限（默认 3s）内等对端回应；到点
   * terminate 强杀并核实释放（客户端不回应关闭握手也能收口）。连接在真正关闭前保持在
   * conns（限额/计数不被提前释放）。
   */
  private closeConn(conn: WsConn, code: number, reason: string): void {
    if (conn.closed || conn.closing) return;
    conn.closing = true;
    const grace = this.deps.testing?.closeGraceMs ?? CLOSE_GRACE_MS;
    conn.closeTimer = setTimeout(() => {
      try { conn.ws.terminate(); } catch { /* 尽力 */ }
      this.cleanupConn(conn);
    }, grace);
    conn.closeTimer.unref?.();
    try { conn.ws.close(code, reason); } catch {
      try { conn.ws.terminate(); } catch { /* 尽力 */ }
    }
  }

  private sendJson(conn: WsConn, obj: unknown): void {
    if (conn.closed) return;
    // 慢客户端（第三十二轮二）：发送缓冲积压超限=消费不动——关闭该连接（不无限占内存）。
    if (conn.ws.bufferedAmount > WS_SLOW_CLIENT_BYTES) {
      this.log('[remote] ws slow-client close');
      this.closeConn(conn, 1013, 'slow-client');
      return;
    }
    conn.ws.send(JSON.stringify(obj));
  }

  private onWsMessage(conn: WsConn, text: string): void {
    // 结构验证（第三十二轮二）：JSON.parse 后必须是非 null 对象且 type 为 string——
    // null/数组/标量/坏 JSON 只关该连接（daemon 与其他客户端继续正常）。
    let msg: unknown;
    try { msg = JSON.parse(text); } catch { this.closeConn(conn, 1008, 'bad-json'); return; }
    if (msg == null || typeof msg !== 'object' || Array.isArray(msg) || typeof (msg as { type?: unknown }).type !== 'string') {
      this.closeConn(conn, 1008, 'bad-structure');
      return;
    }
    const m = msg as { type: string; ticket?: unknown; lastSeq?: unknown; projectId?: unknown };
    if (!conn.authed) {
      if (m.type !== 'authenticate' || typeof m.ticket !== 'string') { this.closeConn(conn, 1008, 'expected-authenticate'); return; }
      const ticket = this.tickets.get(m.ticket);
      this.tickets.delete(m.ticket); // 消费原子（无论成败）
      if (ticket == null || ticket.expiresAt <= this.now()) {
        this.closeConn(conn, 1008, 'ticket-invalid');
        this.log('[remote] ws ticket rejected');
        return;
      }
      // **消费核对（第三十二轮二）**：origin 必须与签发一致（含「合法 A 签发→合法 B 使用」
      // 拒绝——两 Origin 都在白名单也不行）；设备代次与会话有效期必须仍有效。
      if (ticket.origin !== conn.origin) { this.closeConn(conn, 1008, 'ticket-origin-mismatch'); this.log('[remote] ws ticket origin mismatch'); return; }
      if (ticket.sessionExpiresAt <= this.now()) { this.closeConn(conn, 1008, 'session-expired'); return; }
      const live = this.deviceLive(ticket.deviceId, ticket.deviceEpoch);
      if (!live.ok) { this.closeConn(conn, 1008, live.code === 'TOKEN_EXPIRED' ? 'session-expired' : 'device-revoked'); return; }
      conn.authed = true;
      conn.deviceId = ticket.deviceId;
      conn.sessionExpiresAt = ticket.sessionExpiresAt;
      if (conn.authTimer != null) { clearTimeout(conn.authTimer); conn.authTimer = null; }
      // 会话有效期收口（第三十二轮二）：到期关闭——客户端换新 token→新票据重连。
      const sessionTtl = Math.max(ticket.sessionExpiresAt - this.now(), 0);
      conn.sessionTimer = setTimeout(() => {
        if (!conn.closed) {
          this.log('[remote] ws session-expired close');
          this.closeConn(conn, 1008, 'session-expired');
        }
      }, sessionTtl);
      conn.sessionTimer.unref?.();
      const lastSeq = typeof m.lastSeq === 'number' && Number.isInteger(m.lastSeq) && m.lastSeq >= 0 ? m.lastSeq : null;
      const current = this.maxEventSeq();
      if (lastSeq == null) {
        conn.authBase = current;
        this.sendJson(conn, { type: 'authenticated', fromSeq: current });
      } else if (current - lastSeq > this.resumeWindow()) {
        conn.authBase = current; // 旧游标走同范围快照——客户端经 HTTP activity.list 拉取。
        this.sendJson(conn, { type: 'cursor-stale', fromSeq: current, hint: 'activity.list' });
      } else {
        conn.authBase = lastSeq;
        this.sendJson(conn, { type: 'authenticated', resume: true, fromSeq: lastSeq });
      }
      this.log(`[remote] ws authed device=${ticket.deviceId}`);
      return;
    }
    if (m.type === 'subscribe' && typeof m.projectId === 'string' && m.projectId.length > 0) {
      if (conn.subs.size >= WS_MAX_SUBS && !conn.subs.has(m.projectId)) {
        this.closeConn(conn, 1008, 'too-many-subscriptions');
        return;
      }
      conn.subs.add(m.projectId);
      // 迟后订阅（第三十三轮三）：项目水位从 latch/authBase 续发；积压超续传窗口→
      // cursor-stale（客户端拉同范围快照），水位跳到当前——不无限重扫。
      const cur = this.maxEventSeqFor(m.projectId);
      const latch = conn.projNext.get(m.projectId) ?? conn.authBase;
      if (cur - latch > this.resumeWindow()) {
        conn.projNext.set(m.projectId, cur);
        this.sendJson(conn, { type: 'cursor-stale', fromSeq: cur, projectId: m.projectId, hint: 'activity.list' });
        return;
      }
      this.sendJson(conn, { type: 'subscribed', projectId: m.projectId });
      return;
    }
    if (m.type === 'unsubscribe' && typeof m.projectId === 'string') { conn.subs.delete(m.projectId); this.sendJson(conn, { type: 'unsubscribed', projectId: m.projectId }); return; }
    if (m.type === 'ping') { this.sendJson(conn, { type: 'pong' }); return; }
    this.closeConn(conn, 1008, 'write-via-http'); // 写操作走认证 HTTP——WS 不收业务命令。
  }

  /**
   * 事件泵（第三十三轮三重做：**按项目游标**）：每连接每项目独立 latch，SQL 直接按订阅项目
   * 过滤——大量未订阅项目的事件不再阻塞已订阅项目（旧实现全局 LIMIT 500 先取再按订阅跳过：
   * 前 500 条属未订阅 P1 时，已订阅 P2 的事件永远发不出、游标永远不动）。
   * 未订阅项目不推进任何水位——迟后订阅仍从 latch/authBase 收到；已订阅项目中被 audience
   * 过滤的事件照常推进（客户端永远不该收到）。归属解析：缺 conversation_id 时沿
   * task/thread 反查真实会话；解析不出=不推（fail-closed——不自动视为公开）。
   */
  private pumpEvents(): void {
    if (this.stopped) return;
    const stmt = this.deps.db.prepare('SELECT seq, event_id, kind, created_at, project_id, conversation_id, thread_id, task_id, payload_json FROM domain_events WHERE project_id = ? AND seq > ? ORDER BY seq ASC LIMIT 300');
    const convKindStmt = this.deps.db.prepare('SELECT kind FROM conversations WHERE id = ?');
    const dmOkStmt = this.deps.db.prepare(`SELECT 1 FROM conversations c JOIN dm_participants dp ON dp.conversation_id = c.id WHERE c.id = ? AND c.kind = 'dm' AND dp.principal_type = 'human' AND dp.principal_id = ?`);
    const taskConvStmt = this.deps.db.prepare('SELECT conversation_id FROM tasks WHERE id = ?');
    const threadConvStmt = this.deps.db.prepare('SELECT conversation_id FROM conversation_threads WHERE id = ?');
    for (const conn of this.conns) {
      if (!conn.authed || conn.closed) continue;
      for (const pid of conn.subs) {
        const rows = stmt.all(pid, conn.projNext.get(pid) ?? conn.authBase) as Array<{ seq: number; event_id: string; kind: string; created_at: number; project_id: string; conversation_id: string | null; thread_id: string | null; task_id: string | null; payload_json: string }>;
        for (const e of rows) {
          conn.projNext.set(pid, Math.max(conn.projNext.get(pid) ?? conn.authBase, e.seq));
          const taskConv = e.task_id != null ? (taskConvStmt.get(e.task_id) as { conversation_id: string | null } | undefined) : undefined;
          const threadConv = e.thread_id != null ? (threadConvStmt.get(e.thread_id) as { conversation_id: string | null } | undefined) : undefined;
          const conversationId = e.conversation_id ?? taskConv?.conversation_id ?? threadConv?.conversation_id ?? null;
          if (conversationId == null) continue; // 归属解析不出：不推（fail-closed）
          const ck = convKindStmt.get(conversationId) as { kind: string } | undefined;
          if (ck == null) continue; // 会话已不存在：不推
          if (ck.kind === 'dm' && dmOkStmt.get(conversationId, this.deps.localUserId) == null) continue; // 他人 DM 不推送
          this.sendJson(conn, { type: 'event', seq: e.seq, eventId: e.event_id, kind: e.kind, at: e.created_at, projectId: e.project_id, conversationId, threadId: e.thread_id, taskId: e.task_id, payload: safePayload(e.payload_json) });
        }
      }
    }
  }

  // ---------- 进程内自检（隔离验收模式——第三十三轮六；第三十四轮三探针改独立对象） ----------
  /**
   * 机械负例自动化（仅 ZS_REMOTE_SELFCHECK=1 隔离验收模式；正式产品代码不提供该入口——
   * commands 层 remote.pairing.selfcheck 门禁）：对自身 HTTPS 监听执行——错码 401（核对
   * pairing 行 fail_count 递增——证明请求真实命中该行）、伪造 Host/Origin 403、无 token 401、
   * 正码配对→session→同 commandId 恰一次（replayed=true，**独立探针对象** remote.pairing.
   * selfcheckProbe——写 daemon_state 专用键，不触碰任何用户可见状态）+ **remote_audit_log
   * 本次设备/命令号/成败/重放事实核对**→自检设备吊销清理（后续 /cmd 401）。
   * **明文码只在进程内使用、结束即失效，不落任何存储**；探针临时键 finally 清理（审计行保留）。
   * 第三十四轮三：自检前后核对**导航偏好/全项目看板组数/已配对设备/在途任务不变**——任何路径
   * （成功/失败/中断）都登记不变性（第三十三轮 nav.preferences 探针会使用户看板归零——
   * visibleProjectIdsOf 按 viewer 最新行不分 client_id 取可见集）。
   */
  async runSelfcheck(): Promise<{ ok: boolean; items: Array<{ name: string; ok: boolean; detail: string }>; file: string }> {
    const items: Array<{ name: string; ok: boolean; detail: string }> = [];
    // 不变性基线（任何退出路径都在 finishSelfcheck 复核）。
    const baseline = await this.selfcheckBaseline();
    if (this.server == null || this.identity == null || this.boundPort === 0) {
      items.push({ name: '前置：远程服务运行中', ok: false, detail: '未启用——先在 UI 启用远程访问' });
      return await this.finishSelfcheck(items, null, baseline);
    }
    const record = (name: string, ok: boolean, detail: string): void => { items.push({ name, ok, detail }); this.log(`[selfcheck] ${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
    const port = this.boundPort;
    // 信任锚=本地 CA（第三十六轮一：服务证书由 CA 签发——锚定叶子会被判
    // 「self-signed certificate in certificate chain」）。
    const ca = readFileSync(join(this.deps.appDataDir, 'remote', 'ca-cert.pem'), 'utf8');
    const origin = `https://127.0.0.1:${port}`;
    const host = `127.0.0.1:${port}`;
    const post = (path: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; json: any }> => new Promise((resolveP) => {
      const payload = JSON.stringify(body);
      const req = https.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', origin, host, ...headers }, ca, servername: 'localhost', rejectUnauthorized: true, timeout: 15_000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let json: any = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; }
          resolveP({ status: res.statusCode ?? 0, json });
        });
      });
      req.on('error', (e) => resolveP({ status: -1, json: { error: { message: e.message } } }));
      req.on('timeout', () => { req.destroy(); resolveP({ status: -2, json: null }); });
      req.write(payload);
      req.end();
    });
    // 1) 错码 401 + fail_count 递增（请求真实命中配对行——不是泛 401）。
    const created = createPairingCode(this.deps.db, this.now(), {});
    if (!created.ok) { record('创建自检配对码', false, created.error); return await this.finishSelfcheck(items, null, baseline); }
    const failsBefore = (this.deps.db.prepare('SELECT fail_count f FROM remote_pairing_codes WHERE pairing_id = ?').get(created.pairingId) as { f: number }).f;
    const wrong = await post('/pair', { pairingId: created.pairingId, code: 'WRONGWRONG', deviceName: 'selfcheck', clientNonce: 'sc-wrong' }, {});
    const failsAfter = (this.deps.db.prepare('SELECT fail_count f FROM remote_pairing_codes WHERE pairing_id = ?').get(created.pairingId) as { f: number }).f;
    record('错码 → 401（配对行 fail_count 递增）', wrong.status === 401 && failsAfter === failsBefore + 1, `status=${wrong.status} fails=${failsBefore}->${failsAfter}${wrong.status < 0 ? ' err=' + String(wrong.json?.error?.message ?? '?') : ''}`);
    // 2) 伪造 Host / Origin / 无 token。
    const badHost = await post('/pair', { pairingId: 'pair_none', code: 'AAAAAAAA', deviceName: 'x', clientNonce: 'sc-h' }, { host: 'evil.example:1' });
    record('伪造 Host → 403', badHost.status === 403, 'status=' + badHost.status);
    const badOrigin = await post('/pair', { pairingId: 'pair_none', code: 'AAAAAAAA', deviceName: 'x', clientNonce: 'sc-o' }, { origin: 'https://evil.example' });
    record('伪造 Origin → 403', badOrigin.status === 403, 'status=' + badOrigin.status);
    const noToken = await post('/cmd', { commandId: 'selfcheck-no-token', method: 'conversation.list', params: {} }, {});
    record('无 token /cmd → 401', noToken.status === 401, 'status=' + noToken.status);
    // 3) 正码配对 → session → 同 commandId 恰一次（**独立探针对象**——不写用户可见状态）。
    const paired = await post('/pair', { pairingId: created.pairingId, code: created.code, deviceName: 'selfcheck-throwaway', clientNonce: 'sc-ok' }, {});
    if (paired.status !== 200 || paired.json?.ok !== true) {
      record('正码配对', false, `status=${paired.status}`);
      return await this.finishSelfcheck(items, null, baseline);
    }
    const deviceId: string = paired.json.deviceId;
    const credential: string = paired.json.deviceCredential;
    const sess = await post('/session', {}, { authorization: 'Device ' + credential });
    if (sess.status !== 200) {
      record('session 建立', false, `status=${sess.status}`);
      return await this.finishSelfcheck(items, deviceId, baseline);
    }
    const token: string = sess.json.accessToken;
    const auth = { authorization: 'Bearer ' + token };
    // 同 commandId 恰一次+审计：探针经**进程内 dispatch**（同一幂等网关+审计写入器；
    // remote.pairing.selfcheckProbe 在 HTTP 远程通道 REMOTE_BLOCKED——隔离验收模式外双保险拒绝）。
    const commandId = 'selfcheck-once-' + randomUUID().slice(0, 8);
    const probeParams = { round: 'r' + Date.now() };
    const ctx = { deviceId, deviceEpoch: (this.deps.db.prepare('SELECT auth_epoch FROM remote_devices WHERE device_id = ?').get(deviceId) as { auth_epoch: number }).auth_epoch, gate: (): RemoteGateOutcome => this.deviceLive(deviceId, (this.deps.db.prepare('SELECT auth_epoch FROM remote_devices WHERE device_id = ?').get(deviceId) as { auth_epoch: number }).auth_epoch) };
    const first = await this.deps.dispatch({ protocolVersion: 1, commandId, method: 'remote.pairing.selfcheckProbe', params: probeParams }, ctx) as { ok?: boolean };
    const replay = await this.deps.dispatch({ protocolVersion: 1, commandId, method: 'remote.pairing.selfcheckProbe', params: probeParams }, ctx) as { ok?: boolean; replayed?: boolean };
    record('同 commandId 恰一次（replayed=true——独立探针对象）', first?.ok === true && replay?.replayed === true, `first=${String(first?.ok)} replayed=${String(replay?.replayed)}`);
    const auditRows = this.deps.db.prepare('SELECT ok, replayed FROM remote_audit_log WHERE device_id = ? AND command_id = ? ORDER BY id').all(deviceId, commandId) as Array<{ ok: number; replayed: number }>;
    record('remote_audit_log 本次请求事实（设备+命令号+成败+重放）', auditRows.length === 2 && auditRows[0]!.ok === 1 && auditRows[0]!.replayed === 0 && auditRows[1]!.replayed === 1, `rows=${auditRows.length} facts=${JSON.stringify(auditRows)}`);
    // 4) 自检设备清理：吊销后 /cmd 401。
    revokeDeviceInDb(this.deps.db, deviceId, this.now());
    this.invalidateDevice(deviceId);
    const afterRevoke = await post('/cmd', { commandId: 'selfcheck-after-revoke', method: 'conversation.list', params: {} }, auth);
    record('自检设备吊销后 /cmd → 401（通道终态；运行中任务不受影响）', afterRevoke.status === 401, 'status=' + afterRevoke.status);
    return await this.finishSelfcheck(items, deviceId, baseline);
  }

  /** 自检不变性基线：导航偏好行集/全项目看板组数（**await 正式查询**——第三十五轮二：旧实现
   * 未 await 直接读 Promise.data 恒 -1，前后 -1 相等被误判 PASS）/设备清单/在途 run 数。
   * 看板查询失败/结构不符→boardGroups=null（**未取得数据不计通过**——结束核验明确失败）。 */
  private async selfcheckBaseline(): Promise<{ nav: string; boardGroups: number | null; devices: string; activeRuns: number }> {
    const nav = JSON.stringify(this.deps.db.prepare('SELECT client_id, revision, visible_project_ids_json FROM navigation_preferences ORDER BY client_id').all());
    const devices = JSON.stringify(listDevices(this.deps.db).map((d) => ({ id: d.deviceId, revokedAt: d.revokedAt })));
    const activeRuns = (this.deps.db.prepare("SELECT count(*) c FROM workflow_runs WHERE status IN ('RUNNING','WAITING','QUEUED','STOPPING')").get() as { c: number }).c;
    let boardGroups: number | null = null;
    try {
      const r = await this.deps.dispatch({ protocolVersion: 1, commandId: `selfcheck-board-${randomUUID().slice(0, 8)}`, method: 'board.view', params: { scope: 'all' } }, null) as { ok?: boolean; data?: { groups?: unknown } } | null;
      if (r != null && r.ok === true && Array.isArray(r.data?.groups)) boardGroups = r.data.groups.length;
    } catch { boardGroups = null; /* 查询失败如实 null——不计通过 */ }
    return { nav, boardGroups, devices, activeRuns };
  }

  private async finishSelfcheck(items: Array<{ name: string; ok: boolean; detail: string }>, selfcheckDeviceId: string | null, baseline: { nav: string; boardGroups: number | null; devices: string; activeRuns: number }): Promise<{ ok: boolean; items: Array<{ name: string; ok: boolean; detail: string }>; file: string }> {
    // finally：探针临时键清理（独立测试对象——不留业务状态；审计行保留为真实证据）。
    try {
      this.deps.db.prepare("DELETE FROM daemon_state WHERE key LIKE 'selfcheck:probe:%'").run();
    } catch { /* 尽力 */ }
    // 不变性核对（任何退出路径——成功/失败/中断都登记；**await 结束基线**——旧实现同步读
    // Promise 恒 -1）。看板查询未取得数据（前/后任一 null）→明确失败（不按「前后一致」通过）。
    const after = await this.selfcheckBaseline();
    const navUnchanged = after.nav === baseline.nav;
    const boardKnown = baseline.boardGroups != null && after.boardGroups != null;
    const boardUnchanged = boardKnown && after.boardGroups === baseline.boardGroups;
    items.push({ name: '导航偏好与全项目看板不受影响（独立探针对象；成功/失败路径均不变）', ok: navUnchanged && boardUnchanged, detail: `navRowsEqual=${navUnchanged} boardGroups=${baseline.boardGroups}->${after.boardGroups}${boardKnown ? '' : '（看板查询失败/未覆盖——不计通过）'}` });
    let devicesBefore: Array<{ id: string; revokedAt: number | null }>;
    let devicesAfter: Array<{ id: string; revokedAt: number | null }>;
    try {
      devicesBefore = JSON.parse(baseline.devices) as Array<{ id: string; revokedAt: number | null }>;
      devicesAfter = JSON.parse(after.devices) as Array<{ id: string; revokedAt: number | null }>;
    } catch { devicesBefore = []; devicesAfter = []; }
    const beforeIds = new Set(devicesBefore.map((d) => d.id));
    const afterIds = new Set(devicesAfter.map((d) => d.id));
    const diff = [...afterIds].filter((id) => !beforeIds.has(id));
    const selfcheckAdded = selfcheckDeviceId != null ? diff.every((id) => id === selfcheckDeviceId) && (diff.length === 0 || diff.length === 1) : diff.length === 0;
    const priorUntouched = devicesBefore.every((b) => {
      const a = devicesAfter.find((x) => x.id === b.id);
      return a != null && a.revokedAt === b.revokedAt;
    });
    items.push({ name: '已配对设备不受影响（自检一次性设备除外——已吊销清理）', ok: selfcheckAdded && priorUntouched, detail: `new=${diff.join(',')} priorUntouched=${priorUntouched}` });
    items.push({ name: '在途任务不受影响（自检零派发零运行）', ok: after.activeRuns === baseline.activeRuns, detail: `activeRuns=${baseline.activeRuns}->${after.activeRuns}` });
    // 明文码在 runSelfcheck 栈内已消费/失效；结果文件只含结论事实（无码/凭据/token）。
    const report = { at: new Date().toISOString(), items, pass: items.filter((i) => i.ok).length, total: items.length };
    const file = join(this.deps.appDataDir, 'selfcheck-latest.json');
    try {
      writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
    } catch { /* 尽力——返回值仍带全量事实 */ }
    return { ok: report.pass === report.total && report.total > 0, items, file };
  }
}

function safePayload(payloadJson: string): Record<string, unknown> {
  try {
    const p = JSON.parse(payloadJson) as unknown;
    return typeof p === 'object' && p != null ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function lanIps(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

/** 地址分类（第三十八轮可用性：多网卡不能把虚拟网卡当 LAN 推荐——Meta Tunnel 等代理/加速器
 * 常占 198.18.0.0/15 基准段；169.254 为链路本地；100.64/10 为 CGNAT）。返回 null=疑似真实 LAN。 */
export function lanAddressNoteOf(ip: string): string | null {
  if (/^198\.1[89]\./.test(ip)) return '虚拟网卡/隧道常见段（198.18.x.x——代理或加速器虚拟适配器，通常不是其它设备可达的地址）';
  if (/^169\.254\./.test(ip)) return '链路本地（169.254.x.x——无 DHCP 自配地址，一般不可用于访问）';
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return 'CGNAT 段（100.64.x.x——运营商级 NAT，局域网内通常不可达）';
  return null;
}

/** LAN 地址明细（UI 逐地址可复制+虚拟网卡标注）。 */
export function lanAddressDetails(port: number): Array<{ address: string; url: string; note: string | null }> {
  return lanIps().map((ip) => ({ address: ip, url: `https://${ip}:${port}`, note: lanAddressNoteOf(ip) }));
}

function primaryLanIp(): string | null {
  // 推荐/展示优先「无虚拟网卡疑点」的地址（第三十八轮：198.18.0.1 的本机自检通过≠另一台
  // 机器可达——不把 Meta Tunnel 地址当真实 LAN 推荐）。
  const ips = lanIps();
  const real = ips.find((ip) => lanAddressNoteOf(ip) == null);
  return real ?? (ips.length > 0 ? ips[0]! : null);
}
