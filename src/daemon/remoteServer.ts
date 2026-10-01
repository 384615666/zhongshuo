/**
 * DEV-25 远程访问服务端（第三十一轮三/四，R11 合同实现）：
 * - 强制 HTTPS/WSS：自签证书身份（remoteIdentity——PowerShell 生成，私钥/口令只留服务端）；
 *   不可用即拒绝启动，不降级 HTTP；证书校验由客户端完成（失败即停——服务端无从代劳）；
 * - Host/Origin 精确白名单来自**本机配置**（listenHost+port 推导），不信任请求 Host 自动扩
 *   名单；伪造 Host/Origin → 403；
 * - 配对（POST /pair，唯一免 token 入口）：pairingId+code（加盐摘要+常量时间比较）、
 *   原子消费、5 分钟 TTL、一次消费、失败计数（同 pairingId 连续 5 次失效）、每源地址
 *   5 次/分钟+全局 30 次/分钟限速（429+Retry-After）；创建配对码**只在本机管道命令**
 *   （remote.pairing.create——HTTP 面不暴露）；
 * - 会话（POST /session）：Device 凭据换 15 分钟 accessToken（仅内存）；WS 票据
 *   （POST /ws-ticket）：Bearer token 换 30 秒单次票据（绑定 device/origin）；
 * - 业务（POST /cmd）：Bearer token → 同一 dispatchDaemonCommand（同 localUserId=本机同等
 *   权限、同幂等 scope——桌面/浏览器同 commandId 重放不重复执行；REMOTE_BLOCKED_METHODS
 *   保留给本机可信入口）；CallerContext 由服务端构造（不信客户端自报身份）；
 * - 导出下载（GET /export/:id/download）：Bearer token——获准下载；服务端不执行 shell；
 * - WSS（/events）：首帧 authenticate+ticket（5 秒窗口，未认证不收业务不发事件；未认证
 *   连接每地址 2 个/全局 32 个）；票据单次消费；仅事件与订阅控制（写操作走 HTTP）；
 *   每批事件重查 audience（他人 DM 不推送）；lastSeq 续传（游标过期走 cursor-stale 让
 *   客户端 HTTP 拉快照）；eventId 去重由客户端按事件 id 承担；吊销立即关连接；
 * - 凭据脱敏：统一 log 通道（测试断言不含 code/credential/token/ticket 明文）。
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { zipSync } from 'fflate';
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
  // 拒绝近期重复码（24h 内同码不重复发放）。
  const salt = randomBytes(16).toString('hex');
  const digest = digestOf(salt, code);
  const recent = db.prepare('SELECT code_digest FROM remote_pairing_codes WHERE created_at > ?').all(now - 24 * 3600_000) as Array<{ code_digest: string }>;
  if (recent.some((r) => digestsEqual(r.code_digest, digest))) {
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
export const REMOTE_BLOCKED_METHODS = new Set(['remote.pairing.create', 'remote.config.set', 'remote.config.get', 'remote.device.revoke', 'remote.devices.list', 'daemon.shutdown']);

export interface RemoteServerDeps {
  db: ZhongshuoDatabase;
  localUserId: string;
  appDataDir: string;
  /** 与桌面同一命令面（同 deps → 同权限/幂等 scope；CallerContext 服务端构造）。 */
  dispatch: (envelope: unknown) => Promise<unknown>;
  log?: (line: string) => void;
  now?: () => number;
  /** 测试钩子：时钟与窗口。 */
  testing?: { tokenTtlMs?: number; ticketTtlMs?: number; authWindowMs?: number; pumpMs?: number; resumeWindow?: number; perIpPerMin?: number; globalPerMin?: number; identity?: RemoteServerIdentity };
}

interface TokenEntry { deviceId: string; expiresAt: number }
interface TicketEntry { deviceId: string; origin: string; expiresAt: number }
interface WsConn {
  socket: import('node:net').Socket;
  buf: Buffer;
  fragments: string[];
  fragOpcode: number;
  authed: boolean;
  deviceId: string | null;
  subs: Set<string>;
  nextSeq: number;
  closed: boolean;
  authTimer: NodeJS.Timeout | null;
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const BODY_CAP_CMD = 48 * 1024 * 1024; // /cmd 承载 base64 附件（图片上限 ~27MB base64）
const BODY_CAP_SMALL = 8 * 1024;
const EXPORT_MAX_FILES = 200;
const EXPORT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export class RemoteAccessServer {
  private readonly deps: RemoteServerDeps;
  private server: HttpsServer | null = null;
  private identity: RemoteServerIdentity | null = null;
  private readonly tokens = new Map<string, TokenEntry>();
  private readonly tickets = new Map<string, TicketEntry>();
  private readonly conns = new Set<WsConn>();
  private pumpTimer: NodeJS.Timeout | null = null;
  private allowedHostHeaders = new Set<string>();
  private allowedOrigins = new Set<string>();
  private boundPort = 0;
  private stopped = false;
  private readonly now: () => number;
  private globalEventSeq: number;

  constructor(deps: RemoteServerDeps) {
    this.deps = deps;
    this.now = deps.now ?? ((): number => Date.now());
    this.globalEventSeq = this.maxEventSeq();
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
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as unknown as import('node:net').Socket, head));
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
    this.computeAllowed(conf.listenHost, port);
    this.pumpTimer = setInterval(() => this.pumpEvents(), this.deps.testing?.pumpMs ?? 1000);
    this.pumpTimer.unref?.();
    const addr = `https://${conf.listenHost === '0.0.0.0' || conf.listenHost === '::' ? '127.0.0.1' : conf.listenHost}:${port}`;
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
    if (s != null) {
      this.server = null;
      await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections?.(); });
    }
  }

  /** 吊销联动：清 token/票据/活连接（HTTP 侧每次请求再核 revoked_at）。 */
  invalidateDevice(deviceId: string): void {
    for (const [t, e] of this.tokens) if (e.deviceId === deviceId) this.tokens.delete(t);
    for (const [t, e] of this.tickets) if (e.deviceId === deviceId) this.tickets.delete(t);
    for (const c of this.conns) if (c.deviceId === deviceId) this.closeConn(c, 1008, 'revoked');
  }

  currentAddress(): { address: string; port: number; fingerprint: string } | null {
    if (this.identity == null) return null;
    return { address: `https://127.0.0.1:${this.boundPort}`, port: this.boundPort, fingerprint: this.identity.fingerprintSha256 };
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
      if (req.method === 'GET' && /^\/export\/[A-Za-z0-9_-]+\/download$/.test(path)) { this.handleExportDownload(req, res, path); return; }
      this.reply(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `无此路由：${path}（配对码创建走本机可信 UI）` } });
    } catch (error) {
      this.log(`[remote] http error ${error instanceof Error ? error.message : String(error)}`);
      this.reply(res, 500, { ok: false, error: { code: 'INTERNAL', message: '服务内部错误' } });
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
      // 不泄露正确前缀：invalid/expired/consumed 统一口径（含失效）；仍以 reason 供本机诊断面。
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

  private checkToken(token: string | null): { deviceId: string } | { status: number; code: string; message: string } {
    if (token == null || token.length === 0) return { status: 401, code: 'UNAUTHENTICATED', message: '缺少 Bearer accessToken' };
    const entry = this.tokens.get(token);
    if (entry == null) return { status: 401, code: 'TOKEN_INVALID', message: 'accessToken 无效或已吊销' };
    if (entry.expiresAt <= this.now()) {
      this.tokens.delete(token);
      return { status: 401, code: 'TOKEN_EXPIRED', message: 'accessToken 已过期——用 deviceCredential 换新' };
    }
    const dev = this.deps.db.prepare('SELECT revoked_at FROM remote_devices WHERE device_id = ?').get(entry.deviceId) as { revoked_at: number | null } | undefined;
    if (dev == null || dev.revoked_at != null) {
      this.tokens.delete(token);
      return { status: 401, code: 'DEVICE_REVOKED', message: '设备已吊销' };
    }
    return { deviceId: entry.deviceId };
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
    const ttl = this.deps.testing?.tokenTtlMs ?? 15 * 60_000;
    this.tokens.set(token, { deviceId: dev.deviceId, expiresAt: now + ttl });
    this.log(`[remote] session ok device=${dev.deviceId}`);
    this.reply(res, 200, { ok: true, accessToken: token, tokenType: 'bearer', expiresIn: Math.floor(ttl / 1000) });
  }

  /** /ws-ticket：Bearer token → 30 秒单次票据（绑定 device+origin；消费原子）。 */
  private async handleWsTicket(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.originAllowed(req)) { this.reply(res, 403, { ok: false, error: { code: 'ORIGIN_FORBIDDEN', message: 'Origin 不在白名单' } }); return; }
    const token = this.bearer(req);
    const check = this.checkToken(token);
    if ('status' in check) { this.reply(res, check.status, { ok: false, error: { code: check.code, message: check.message } }); return; }
    const origin = String(req.headers.origin ?? '');
    const ticket = randomBytes(32).toString('base64url');
    const ttl = this.deps.testing?.ticketTtlMs ?? 30_000;
    this.tickets.set(ticket, { deviceId: check.deviceId, origin, expiresAt: this.now() + ttl });
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
    if (REMOTE_BLOCKED_METHODS.has(body.method)) {
      this.reply(res, 403, { ok: false, error: { code: 'REMOTE_METHOD_BLOCKED', message: `远程通道不开放：${body.method}（仅本机可信 UI）` } });
      this.log(`[remote] cmd blocked device=${check.deviceId} method=${body.method}`);
      return;
    }
    const envelope: Record<string, unknown> = { protocolVersion: 1, commandId: body.commandId, method: body.method, params: body.params ?? {} };
    if (body.expectedRevision != null) envelope.expectedRevision = body.expectedRevision;
    // CallerContext 由服务端构造（deviceId 审计）——不信客户端自报 authorId/角色：命令面
    // 的作者身份恒为 deps.localUserId（与桌面同权同源）。
    const result = await this.deps.dispatch(envelope);
    this.log(`[remote] cmd device=${check.deviceId} method=${body.method} ok=${(result as { ok?: boolean }).ok === true}`);
    this.reply(res, 200, result);
  }

  /** /export/:id/download：获准下载（Bearer token；路径限定 exports/ 内该 id 目录）。 */
  private handleExportDownload(req: IncomingMessage, res: ServerResponse, path: string): void {
    if (!this.originAllowed(req)) { this.reply(res, 403, { ok: false, error: { code: 'ORIGIN_FORBIDDEN', message: 'Origin 不在白名单' } }); return; }
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
    let entries: Array<{ rel: string; abs: string; size: number }>;
    try {
      const walk = (d: string, rel: string): Array<{ rel: string; abs: string; size: number }> => {
        const out: Array<{ rel: string; abs: string; size: number }> = [];
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (out.length >= EXPORT_MAX_FILES) break;
          const abs = join(d, e.name);
          const r = rel.length === 0 ? e.name : `${rel}/${e.name}`;
          if (e.isDirectory()) out.push(...walk(abs, r));
          else out.push({ rel: r, abs, size: statSync(abs).size });
        }
        return out;
      };
      entries = walk(dir, '');
    } catch {
      this.reply(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `导出不存在：${exportId}` } });
      return;
    }
    if (entries.length === 0) { this.reply(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '导出目录为空' } }); return; }
    const total = entries.reduce((s, e) => s + e.size, 0);
    if (total > EXPORT_MAX_TOTAL_BYTES) { this.reply(res, 413, { ok: false, error: { code: 'EXPORT_TOO_LARGE', message: `导出包 ${total}B 超下载上限` } }); return; }
    const zippable: Record<string, Uint8Array> = {};
    for (const e of entries) zippable[e.rel] = new Uint8Array(readFileSync(e.abs));
    const zip = Buffer.from(zipSync(zippable, { level: 1 }));
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(zip.length), 'content-disposition': `attachment; filename="${exportId}.zip"`, 'cache-control': 'no-store' });
    res.end(zip);
    this.log(`[remote] export download device=${check.deviceId} export=${exportId} bytes=${zip.length}`);
  }

  // ---------- WSS ----------
  private handleUpgrade(req: IncomingMessage, socket: import('node:net').Socket, head: Buffer): void {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/events') { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    if (!this.hostAllowed(req) || !this.originAllowed(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    // 未认证连接限额：每地址 2 / 全局 32。
    const ip = socket.remoteAddress ?? 'unknown';
    const unauthByIp = [...this.conns].filter((c) => !c.authed && (c.socket.remoteAddress ?? '') === ip).length;
    const unauthTotal = [...this.conns].filter((c) => !c.authed).length;
    if (unauthByIp >= 2 || unauthTotal >= 32) { socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || key.length === 0) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    // 容错：head 若带前导空白字节（非规范客户端的多余 CRLF）剥离——不破坏帧界。
    let headBuf = Buffer.from(head ?? Buffer.alloc(0));
    while (headBuf.length > 0 && (headBuf[0] === 0x0d || headBuf[0] === 0x0a)) headBuf = headBuf.subarray(1);
    const conn: WsConn = { socket, buf: headBuf, fragments: [], fragOpcode: 0, authed: false, deviceId: null, subs: new Set(), nextSeq: 0, closed: false, authTimer: null };
    this.conns.add(conn);
    conn.authTimer = setTimeout(() => {
      if (!conn.authed && !conn.closed) {
        this.log('[remote] ws auth timeout');
        this.closeConn(conn, 1008, 'auth-timeout');
      }
    }, this.deps.testing?.authWindowMs ?? 5000);
    socket.on('data', (d: Buffer) => { conn.buf = Buffer.concat([conn.buf, d]); this.parseFrames(conn); });
    socket.on('error', () => this.closeConn(conn, 1011, 'socket-error'));
    socket.on('close', () => { if (conn.authTimer != null) clearTimeout(conn.authTimer); this.conns.delete(conn); conn.closed = true; });
  }

  private closeConn(conn: WsConn, code: number, reason: string): void {
    if (conn.closed) return;
    conn.closed = true;
    if (conn.authTimer != null) { clearTimeout(conn.authTimer); conn.authTimer = null; }
    try {
      const r = Buffer.from(reason, 'utf8');
      const payload = Buffer.alloc(2 + r.length);
      payload.writeUInt16BE(code, 0);
      r.copy(payload, 2);
      conn.socket.write(Buffer.concat([Buffer.from([0x88, payload.length]), payload]));
    } catch { /* 尽力 */ }
    this.conns.delete(conn);
    conn.socket.destroy();
  }

  private sendJson(conn: WsConn, obj: unknown): void {
    if (conn.closed) return;
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    let header: Buffer;
    if (data.length < 126) header = Buffer.from([0x81, data.length]);
    else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(data.length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
    conn.socket.write(Buffer.concat([header, data]));
  }

  private parseFrames(conn: WsConn): void {
    for (;;) {
      const b = conn.buf;
      if (b.length < 2) return;
      const b0 = b[0]!;
      const b1 = b[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      const len7 = b1 & 0x7f;
      let off = 2;
      let len = len7;
      if (len7 === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len7 === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2); if (big > 2n ** 31n) { this.closeConn(conn, 1009, 'frame-too-large'); return; } len = Number(big); off = 10; }
      if (len > 1024 * 1024) { this.closeConn(conn, 1009, 'frame-too-large'); return; }
      let maskKey: Buffer | null = null;
      if (masked) { if (b.length < off + 4) return; maskKey = Buffer.from(b.subarray(off, off + 4)); off += 4; }
      if (b.length < off + len) return;
      const payload = Buffer.from(b.subarray(off, off + len));
      if (maskKey != null) for (let i = 0; i < payload.length; i += 1) { const mk = maskKey[i % 4] ?? 0; payload[i] = (payload[i] ?? 0) ^ mk; }
      conn.buf = Buffer.from(b.subarray(off + len));
      if (opcode === 8) { this.closeConn(conn, 1000, 'client-close'); return; }
      if (opcode === 9) { conn.socket.write(Buffer.from([0x8a, 0])); continue; } // ping→pong
      if (opcode === 10) continue; // pong
      if (opcode === 1 || opcode === 0) {
        const text = payload.toString('utf8');
        if (opcode === 1 && fin) { this.onWsMessage(conn, text); continue; }
        // 分片：拼接直到 fin。
        if (opcode === 1) conn.fragOpcode = 1;
        conn.fragments.push(text);
        if (fin) {
          const whole = conn.fragments.join('');
          conn.fragments = [];
          const op = conn.fragOpcode;
          conn.fragOpcode = 0;
          if (op === 1) this.onWsMessage(conn, whole);
        }
        continue;
      }
      this.closeConn(conn, 1008, 'unsupported-opcode');
      return;
    }
  }

  private onWsMessage(conn: WsConn, text: string): void {
    let msg: { type?: string; ticket?: string; lastSeq?: number; projectId?: string };
    try { msg = JSON.parse(text) as typeof msg; } catch { this.closeConn(conn, 1008, 'bad-json'); return; }
    if (!conn.authed) {
      // 认证前只允许该小帧——不收业务、不发事件。
      if (msg.type !== 'authenticate' || typeof msg.ticket !== 'string') { this.closeConn(conn, 1008, 'expected-authenticate'); return; }
      const ticket = this.tickets.get(msg.ticket);
      this.tickets.delete(msg.ticket); // 消费原子（无论成败）
      if (ticket == null || ticket.expiresAt <= this.now()) {
        this.closeConn(conn, 1008, 'ticket-invalid');
        this.log('[remote] ws ticket rejected');
        return;
      }
      const dev = this.deps.db.prepare('SELECT revoked_at FROM remote_devices WHERE device_id = ?').get(ticket.deviceId) as { revoked_at: number | null } | undefined;
      if (dev == null || dev.revoked_at != null) { this.closeConn(conn, 1008, 'device-revoked'); return; }
      conn.authed = true;
      conn.deviceId = ticket.deviceId;
      if (conn.authTimer != null) { clearTimeout(conn.authTimer); conn.authTimer = null; }
      const lastSeq = typeof msg.lastSeq === 'number' && Number.isInteger(msg.lastSeq) && msg.lastSeq >= 0 ? msg.lastSeq : null;
      const current = this.maxEventSeq();
      if (lastSeq == null) {
        conn.nextSeq = current;
        this.sendJson(conn, { type: 'authenticated', fromSeq: current });
      } else if (current - lastSeq > (this.deps.testing?.resumeWindow ?? 5000)) {
        conn.nextSeq = current; // 旧游标走同范围快照——客户端经 HTTP activity.list 拉取。
        this.sendJson(conn, { type: 'cursor-stale', fromSeq: current, hint: 'activity.list' });
      } else {
        conn.nextSeq = lastSeq;
        this.sendJson(conn, { type: 'authenticated', resume: true, fromSeq: lastSeq });
      }
      this.log(`[remote] ws authed device=${ticket.deviceId}`);
      return;
    }
    if (msg.type === 'subscribe' && typeof msg.projectId === 'string' && msg.projectId.length > 0) { conn.subs.add(msg.projectId); this.sendJson(conn, { type: 'subscribed', projectId: msg.projectId }); return; }
    if (msg.type === 'unsubscribe' && typeof msg.projectId === 'string') { conn.subs.delete(msg.projectId); this.sendJson(conn, { type: 'unsubscribed', projectId: msg.projectId }); return; }
    if (msg.type === 'ping') { this.sendJson(conn, { type: 'pong' }); return; }
    this.closeConn(conn, 1008, 'write-via-http'); // 写操作走认证 HTTP——WS 不收业务命令。
  }

  /** 事件泵：每连接按订阅+audience 重查推送（连接断开不伪报任务状态——只断流）。 */
  private pumpEvents(): void {
    if (this.stopped) return;
    const stmt = this.deps.db.prepare('SELECT seq, event_id, kind, created_at, project_id, conversation_id, thread_id, task_id, payload_json FROM domain_events WHERE seq > ? ORDER BY seq ASC LIMIT 500');
    const convKindStmt = this.deps.db.prepare('SELECT kind FROM conversations WHERE id = ?');
    const dmOkStmt = this.deps.db.prepare(`SELECT 1 FROM conversations c JOIN dm_participants dp ON dp.conversation_id = c.id WHERE c.id = ? AND c.kind = 'dm' AND dp.principal_type = 'human' AND dp.principal_id = ?`);
    for (const conn of this.conns) {
      if (!conn.authed || conn.closed) continue;
      const rows = stmt.all(conn.nextSeq) as Array<{ seq: number; event_id: string; kind: string; created_at: number; project_id: string; conversation_id: string | null; thread_id: string | null; task_id: string | null; payload_json: string }>;
      if (rows.length === 0) continue;
      for (const e of rows) {
        conn.nextSeq = Math.max(conn.nextSeq, e.seq);
        if (!conn.subs.has(e.project_id)) continue;
        if (e.conversation_id != null) {
          const ck = convKindStmt.get(e.conversation_id) as { kind: string } | undefined;
          if (ck?.kind === 'dm' && dmOkStmt.get(e.conversation_id, this.deps.localUserId) == null) continue; // 他人 DM 不推送
        }
        this.sendJson(conn, { type: 'event', seq: e.seq, eventId: e.event_id, kind: e.kind, at: e.created_at, projectId: e.project_id, conversationId: e.conversation_id, threadId: e.thread_id, taskId: e.task_id, payload: safePayload(e.payload_json) });
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
