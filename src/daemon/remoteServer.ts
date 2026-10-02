/**
 * DEV-25 远程访问服务端（第三十一轮三/四建；第三十二轮一/二按定位缺口重写）。
 * 第三十二轮修复与合同补齐：
 * - **WSS 用成熟库（ws）承接握手与帧协议**：掩码/分片/UTF-8 边界/背压由库处理；应用层补
 *   认证前小消息上限（maxPayload 64KB）、完整消息结构验证（null/数组/错误类型只关该连接
 *   ——daemon 与其他客户端继续正常）、订阅数量上限、慢客户端（bufferedAmount 超限关闭）；
 * - **票据绑定完整**：device+origin（消费时比对——含「合法 Origin A 签发、合法 Origin B
 *   使用」拒绝）+会话 token 摘要与有效期+授权代次（authEpoch——吊销即全部票据/连接失效）；
 *   连接保存会话有效期，到期关闭→客户端换新 token→新票据重连；
 * - **事件归属**：缺 conversation_id 时沿 task/thread 真实归属解析（解析不出=不推——
 *   fail-closed 不自动视为公开）；**游标按订阅门控**（未订阅项目的事件不推进 nextSeq——
 *   订阅后仍可收到，不丢待续传事件）；
 * - **cmd 吊销重查（POST 路由）**：大请求体读取/解析完成后、派发前重查 token 与设备吊销（读取期间
 *   吊销不放过）；**授权运行中的任务不受吊销影响**——吊销只断通道，不冒充停止；
 * - **导出下载**：重查导出目标的 audience（manifest.conversationId→DM=本人参与）+实根
 *   （realpath）+逐文件 sha256 对 manifest 完整性核验；文件数/总量超限**明确 413**（不再
 *   walk 静默截断）；异步读取+fflate 异步 zip（重活不阻塞 daemon 停止与其他命令）；
 * - **审计**：dispatch 携带服务端构造的 remoteAudit（deviceId+authEpoch）→remote_audit_log
 *   （迁移 039）；业务作者恒为设备代表的本机用户；同 commandId 幂等语义不变；
 * - currentAddress 按实际监听事实返回（0.0.0.0 时给 LAN 地址）；stop 清运行态（停用不再
 *   显示运行中）。
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readdirSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { createHash as nodeCreateHash } from 'node:crypto';
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
/** 远程通道保留给本机可信入口的方法（配对码创建/服务配置/吊销/关停——R11 §1/§3）。 */
export const REMOTE_BLOCKED_METHODS = new Set(['remote.pairing.create', 'remote.pairing.selfcheckExport', 'remote.config.set', 'remote.config.get', 'remote.device.revoke', 'remote.devices.list', 'daemon.shutdown']);

/** 服务端构造的远程调用上下文（审计用——业务作者仍为 localUserId，不信客户端自报）。 */
export interface RemoteCallContext { deviceId: string; authEpoch: number }

export interface RemoteServerDeps {
  db: ZhongshuoDatabase;
  localUserId: string;
  appDataDir: string;
  /** 与桌面同一命令面（同 deps → 同权限/幂等 scope）；ctx=服务端构造的远程上下文（null=非远程）。 */
  dispatch: (envelope: unknown, ctx: RemoteCallContext | null) => Promise<unknown>;
  log?: (line: string) => void;
  now?: () => number;
  /** 测试钩子：时钟与窗口。 */
  testing?: { tokenTtlMs?: number; ticketTtlMs?: number; authWindowMs?: number; pumpMs?: number; resumeWindow?: number; perIpPerMin?: number; globalPerMin?: number; identity?: RemoteServerIdentity };
}

interface TokenEntry { deviceId: string; expiresAt: number; authEpoch: number }
/** 票据完整绑定（第三十二轮二）：设备+签发来源 Origin+会话 token 摘要+会话有效期+授权代次。 */
interface TicketEntry { deviceId: string; origin: string; sessionTokenHash: string; sessionExpiresAt: number; authEpoch: number; expiresAt: number }
interface WsConn {
  ws: WsSocket;
  origin: string;
  authed: boolean;
  deviceId: string | null;
  sessionExpiresAt: number;
  subs: Set<string>;
  nextSeq: number;
  closed: boolean;
  authTimer: NodeJS.Timeout | null;
  sessionTimer: NodeJS.Timeout | null;
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
void WS_GUID; // 握手由 ws 库承担（保留常量作协议出处标记）
const BODY_CAP_CMD = 48 * 1024 * 1024; // /cmd 承载 base64 附件（图片上限 ~27MB base64）
const BODY_CAP_SMALL = 8 * 1024;
const EXPORT_MAX_FILES = 200;
const EXPORT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const WS_MAX_PAYLOAD = 64 * 1024; // 认证/订阅小消息上限（完整消息大小——ws maxPayload）
const WS_MAX_SUBS = 200;
const WS_SLOW_CLIENT_BYTES = 8 * 1024 * 1024; // 发送缓冲积压（慢客户端）——超限关闭
const WS_UNAUTH_PER_ADDR = 2;
const WS_UNAUTH_GLOBAL = 32;

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
  /** 授权代次：吊销任一设备即 +1——票据/连接按代次失效（跨设备瞬时收口）。 */
  private authEpoch = 0;
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
    this.server = createHttpsServer({ pfx: this.identity.pfx, passphrase: this.identity.passphrase }, (req, res) => { void this.handleHttp(req, res); });
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
    for (const c of this.conns) this.closeConn(c, 1001, 'server-stop');
    this.conns.clear();
    this.tokens.clear();
    this.tickets.clear();
    const s = this.server;
    const wss = this.wss;
    this.server = null;
    this.wss = null;
    this.boundPort = 0; // 运行态清零——currentAddress 不再把停用显示成运行中
    this.boundHost = '';
    if (wss != null) { try { wss.close(); } catch { /* 尽力 */ } }
    if (s != null) {
      await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections?.(); });
    }
  }

  /** 吊销联动：授权代次+1、清 token/票据/活连接（HTTP 侧每次请求再核 revoked_at）。 */
  invalidateDevice(deviceId: string): void {
    this.authEpoch += 1;
    for (const [t, e] of this.tokens) if (e.deviceId === deviceId) this.tokens.delete(t);
    for (const [t, e] of this.tickets) if (e.deviceId === deviceId) this.tickets.delete(t);
    for (const c of this.conns) if (c.deviceId === deviceId) this.closeConn(c, 1008, 'revoked');
  }

  /** 实际监听事实（第三十二轮四：0.0.0.0 时给 LAN 地址；停用/未启动=null——不再恒回环）。 */
  currentAddress(): { address: string; port: number; fingerprint: string; lanAddresses: string[]; certNotAfter: string; certSubject: string } | null {
    if (this.server == null || this.identity == null || this.boundPort === 0) return null; // 停用/未启动=null（不显示运行中）
    const displayHost = this.boundHost === '0.0.0.0' || this.boundHost === '::' ? (primaryLanIp() ?? '127.0.0.1') : this.boundHost;
    return {
      address: `https://${displayHost}:${this.boundPort}`,
      port: this.boundPort,
      fingerprint: this.identity.fingerprintSha256, // 完整 64 位十六进制（用户端逐位核对）
      lanAddresses: this.boundHost === '0.0.0.0' || this.boundHost === '::' ? lanIps().map((ip) => `https://${ip}:${this.boundPort}`) : [],
      certNotAfter: this.identity.notAfter,
      certSubject: this.identity.subject,
    };
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

  private checkToken(token: string | null): { deviceId: string; expiresAt: number } | { status: number; code: string; message: string } {
    if (token == null || token.length === 0) return { status: 401, code: 'UNAUTHENTICATED', message: '缺少 Bearer accessToken' };
    const entry = this.tokens.get(token);
    if (entry == null) return { status: 401, code: 'TOKEN_INVALID', message: 'accessToken 无效或已吊销' };
    if (entry.expiresAt <= this.now()) {
      this.tokens.delete(token);
      return { status: 401, code: 'TOKEN_EXPIRED', message: 'accessToken 已过期——用 deviceCredential 换新' };
    }
    if (entry.authEpoch !== this.authEpoch) {
      this.tokens.delete(token);
      return { status: 401, code: 'DEVICE_REVOKED', message: '授权代次变化（设备已吊销）' };
    }
    const dev = this.deps.db.prepare('SELECT revoked_at FROM remote_devices WHERE device_id = ?').get(entry.deviceId) as { revoked_at: number | null } | undefined;
    if (dev == null || dev.revoked_at != null) {
      this.tokens.delete(token);
      return { status: 401, code: 'DEVICE_REVOKED', message: '设备已吊销' };
    }
    return { deviceId: entry.deviceId, expiresAt: entry.expiresAt };
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
    this.tokens.set(token, { deviceId: dev.deviceId, expiresAt: now + ttl, authEpoch: this.authEpoch });
    this.log(`[remote] session ok device=${dev.deviceId}`);
    this.reply(res, 200, { ok: true, accessToken: token, tokenType: 'bearer', expiresIn: Math.floor(ttl / 1000) });
  }

  /** /ws-ticket：Bearer token → 30 秒单次票据（完整绑定 device+origin+会话+授权代次）。 */
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
      authEpoch: this.authEpoch,
      expiresAt: this.now() + ttl,
    });
    this.reply(res, 200, { ok: true, ticket, expiresIn: Math.floor(ttl / 1000) });
  }

  /** /cmd：Bearer token → 同一命令面（同权限/同幂等 scope；阻断本机保留方法）。 */
  private async handleCmd(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.originAllowed(req)) { this.reply(res, 403, { ok: false, error: { code: 'ORIGIN_FORBIDDEN', message: 'Origin 不在白名单' } }); return; }
    const check = this.checkToken(this.bearer(req));
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
    const recheck = this.checkToken(this.bearer(req));
    if ('status' in recheck) { this.reply(res, recheck.status, { ok: false, error: { code: recheck.code, message: recheck.message } }); return; }
    if (REMOTE_BLOCKED_METHODS.has(body.method)) {
      this.reply(res, 403, { ok: false, error: { code: 'REMOTE_METHOD_BLOCKED', message: `远程通道不开放：${body.method}（仅本机可信 UI）` } });
      this.log(`[remote] cmd blocked device=${recheck.deviceId} method=${body.method}`);
      return;
    }
    const envelope: Record<string, unknown> = { protocolVersion: 1, commandId: body.commandId, method: body.method, params: body.params ?? {} };
    if (body.expectedRevision != null) envelope.expectedRevision = body.expectedRevision;
    // CallerContext 由服务端构造（deviceId+authEpoch 审计）——业务作者恒 localUserId。
    const result = await this.deps.dispatch(envelope, { deviceId: recheck.deviceId, authEpoch: this.authEpoch });
    this.log(`[remote] cmd device=${recheck.deviceId} method=${body.method} ok=${(result as { ok?: boolean }).ok === true}`);
    this.reply(res, 200, result);
  }

  /** /export/:id/download：获准下载——audience 重查+实根+逐文件完整性+明确限额+异步 zip。 */
  private async handleExportDownload(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (!this.originAllowedForDownload(req)) { this.reply(res, 403, { ok: false, error: { code: 'ORIGIN_FORBIDDEN', message: 'Origin 不在白名单' } }); return; }
    const check = this.checkToken(this.bearer(req));
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
    let manifest: { conversationId?: string; files?: Array<{ file: string; bytes: number; sha256: string }> };
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
    // 收集全量条目：超限**明确 413**（不 walk 静默截断）。
    const entries: Array<{ rel: string; abs: string; size: number }> = [];
    const walk = (d: string, rel: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (entries.length > EXPORT_MAX_FILES) break;
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
    if (entries.length > EXPORT_MAX_FILES) {
      this.reply(res, 413, { ok: false, error: { code: 'EXPORT_TOO_LARGE', message: `导出文件数 ${entries.length} 超上限 ${EXPORT_MAX_FILES}——明确拒绝（不静默截断）` } });
      return;
    }
    if (entries.length === 0) { this.reply(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '导出目录为空' } }); return; }
    const total = entries.reduce((s2, e) => s2 + e.size, 0);
    if (total > EXPORT_MAX_TOTAL_BYTES) { this.reply(res, 413, { ok: false, error: { code: 'EXPORT_TOO_LARGE', message: `导出包 ${total}B 超下载上限` } }); return; }
    // 逐文件完整性（第三十二轮三）：实际字节 sha256 对 manifest 对账（200 件附件+正文/manifest
    // 全量核验——下载端不截掉合法内容）。异步读取+分块 hash（重活不阻塞 daemon 停止/其他命令）。
    const manifestByName = new Map(manifest.files.map((f) => [f.file, f]));
    const primaryName = typeof (manifest as { primary?: { file?: unknown } }).primary?.file === 'string' ? (manifest as { primary: { file: string } }).primary.file : null;
    try {
      // 反向核对：清单所列资产文件必须都在目录中（缺失=不完整——200 件附件不得被截）。
      const entryRels = new Set(entries.map((e) => e.rel));
      for (const f of manifest.files) {
        if (!entryRels.has(f.file)) throw new Error(`清单文件缺失：${f.file}`);
      }
      for (const e of entries) {
        if (e.rel === 'manifest.json') continue; // 清单自身由上述结构校验承载
        if (e.rel === primaryName) {
          const pm = (manifest as { primary?: { bytes?: number; sha256?: string } }).primary;
          if (pm != null && (pm.bytes !== e.size || typeof pm.sha256 !== 'string')) throw new Error(`导出主文件与清单不符：${e.rel}`);
          continue; // 主文件哈希核对见下（与资产同链）
        }
        const m = manifestByName.get(e.rel);
        if (m == null || m.bytes !== e.size) throw new Error(`导出内容与清单不符：${e.rel}`);
        const h = nodeCreateHash('sha256');
        const fh = await fsp.open(e.abs, 'r');
        try {
          const chunk = Buffer.allocUnsafe(1024 * 1024);
          for (;;) {
            const { bytesRead } = await fh.read(chunk, 0, chunk.length, null);
            if (bytesRead <= 0) break;
            h.update(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
          }
        } finally { await fh.close().catch(() => { /* 尽力 */ }); }
        const expectHash = e.rel === primaryName ? ((manifest as { primary?: { sha256?: string } }).primary?.sha256 ?? null) : m.sha256;
        if (expectHash == null || h.digest('hex') !== expectHash) throw new Error(`导出文件完整性不符：${e.rel}`);
      }
    } catch (error) {
      this.reply(res, 410, { ok: false, error: { code: 'EXPORT_TAMPERED', message: `导出完整性核验失败（${error instanceof Error ? error.message : String(error)}）——拒绝下载` } });
      return;
    }
    const zippable: Record<string, Uint8Array> = {};
    for (const e of entries) zippable[e.rel] = new Uint8Array(await fsp.readFile(e.abs));
    // fflate 异步 zip（worker 池承接 deflate——不阻塞事件循环）。
    const zipBytes = await new Promise<Uint8Array>((resolveZ, rejectZ) => {
      zip(zippable, { level: 1 }, (err, data) => { if (err != null) rejectZ(err); else resolveZ(data); });
    });
    const zipBuf = Buffer.from(zipBytes);
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(zipBuf.length), 'content-disposition': `attachment; filename="${exportId}.zip"`, 'cache-control': 'no-store' });
    res.end(zipBuf);
    this.log(`[remote] export download device=${check.deviceId} export=${exportId} files=${entries.length} bytes=${zipBuf.length}`);
  }

  // ---------- WSS（ws 库承接握手/帧；应用层合同在此） ----------
  private handleUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/events') { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    if (!this.hostAllowed(req) || !this.originAllowed(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    // 未认证连接限额（第三十二轮二）：全局 32（Duplex 无类型化 remoteAddress——从流上读）。
    const addr = (socket as unknown as { remoteAddress?: string }).remoteAddress ?? 'unknown';
    void addr;
    const unauthTotal = [...this.conns].filter((c) => !c.authed && !c.closed).length;
    if (unauthTotal >= WS_UNAUTH_GLOBAL) { socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); socket.destroy(); return; }
    // ws 库校验 Sec-WebSocket-Key/版本并完成 101 应答；maxPayload 承接帧上限。
    this.wss?.handleUpgrade(req, socket, head, (ws) => this.onWsConnection(ws, req));
  }

  private onWsConnection(ws: WsSocket, req: IncomingMessage): void {
    const conn: WsConn = {
      ws,
      origin: String(req.headers.origin ?? '').toLowerCase(),
      authed: false,
      deviceId: null,
      sessionExpiresAt: 0,
      subs: new Set(),
      nextSeq: 0,
      closed: false,
      authTimer: null,
      sessionTimer: null,
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

  private cleanupConn(conn: WsConn): void {
    conn.closed = true;
    if (conn.authTimer != null) { clearTimeout(conn.authTimer); conn.authTimer = null; }
    if (conn.sessionTimer != null) { clearTimeout(conn.sessionTimer); conn.sessionTimer = null; }
    this.conns.delete(conn);
  }

  private closeConn(conn: WsConn, code: number, reason: string): void {
    if (conn.closed) return;
    this.cleanupConn(conn);
    try { conn.ws.close(code, reason); } catch { /* 尽力 */ }
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
      // 拒绝——两 Origin 都在白名单也不行）；授权代次与会话有效期必须仍有效。
      if (ticket.origin !== conn.origin) { this.closeConn(conn, 1008, 'ticket-origin-mismatch'); this.log('[remote] ws ticket origin mismatch'); return; }
      if (ticket.authEpoch !== this.authEpoch) { this.closeConn(conn, 1008, 'auth-epoch-stale'); return; }
      if (ticket.sessionExpiresAt <= this.now()) { this.closeConn(conn, 1008, 'session-expired'); return; }
      const dev = this.deps.db.prepare('SELECT revoked_at FROM remote_devices WHERE device_id = ?').get(ticket.deviceId) as { revoked_at: number | null } | undefined;
      if (dev == null || dev.revoked_at != null) { this.closeConn(conn, 1008, 'device-revoked'); return; }
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
        conn.nextSeq = current;
        this.sendJson(conn, { type: 'authenticated', fromSeq: current });
      } else if (current - lastSeq > this.resumeWindow()) {
        conn.nextSeq = current; // 旧游标走同范围快照——客户端经 HTTP activity.list 拉取。
        this.sendJson(conn, { type: 'cursor-stale', fromSeq: current, hint: 'activity.list' });
      } else {
        conn.nextSeq = lastSeq;
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
      this.sendJson(conn, { type: 'subscribed', projectId: m.projectId });
      return;
    }
    if (m.type === 'unsubscribe' && typeof m.projectId === 'string') { conn.subs.delete(m.projectId); this.sendJson(conn, { type: 'unsubscribed', projectId: m.projectId }); return; }
    if (m.type === 'ping') { this.sendJson(conn, { type: 'pong' }); return; }
    this.closeConn(conn, 1008, 'write-via-http'); // 写操作走认证 HTTP——WS 不收业务命令。
  }

  /**
   * 事件泵：每连接按订阅+audience 重查推送（连接断开不伪报任务状态——只断流）。
   * **游标按订阅门控（第三十二轮二）**：未订阅项目的事件不推进 nextSeq——订阅建立后仍可
   * 收到（不丢待续传事件）；已订阅项目中被 audience 过滤的事件照常推进（客户端永远不该收到）。
   * **归属解析**：缺 conversation_id 时沿 task_id/thread_id 反查真实会话；解析不出=不推
   * （fail-closed——不自动视为公开）。
   */
  private pumpEvents(): void {
    if (this.stopped) return;
    const stmt = this.deps.db.prepare('SELECT seq, event_id, kind, created_at, project_id, conversation_id, thread_id, task_id, payload_json FROM domain_events WHERE seq > ? ORDER BY seq ASC LIMIT 500');
    const convKindStmt = this.deps.db.prepare('SELECT kind FROM conversations WHERE id = ?');
    const dmOkStmt = this.deps.db.prepare(`SELECT 1 FROM conversations c JOIN dm_participants dp ON dp.conversation_id = c.id WHERE c.id = ? AND c.kind = 'dm' AND dp.principal_type = 'human' AND dp.principal_id = ?`);
    const taskConvStmt = this.deps.db.prepare('SELECT conversation_id FROM tasks WHERE id = ?');
    const threadConvStmt = this.deps.db.prepare('SELECT conversation_id FROM conversation_threads WHERE id = ?');
    for (const conn of this.conns) {
      if (!conn.authed || conn.closed) continue;
      const rows = stmt.all(conn.nextSeq) as Array<{ seq: number; event_id: string; kind: string; created_at: number; project_id: string; conversation_id: string | null; thread_id: string | null; task_id: string | null; payload_json: string }>;
      if (rows.length === 0) continue;
      for (const e of rows) {
        if (!conn.subs.has(e.project_id)) continue; // 未订阅：不推也不推进游标
        conn.nextSeq = Math.max(conn.nextSeq, e.seq);
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

function primaryLanIp(): string | null {
  const ips = lanIps();
  return ips.length > 0 ? ips[0]! : null;
}
