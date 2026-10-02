/**
 * DEV-25 远程访问（第三十一轮三/四）：LAN-01—08 + RT-21 正反例。
 * - LAN-01 配对：错/对码、重复码（一次消费）、过期码、5 次失败失效、限速（每 IP 5/分+全局）；
 * - LAN-03 证书：客户端不信任自签证书 → TLS 握手拒绝（不降级、不关校验）；
 * - LAN-04 伪造 Host/Origin → 403（白名单来自本机配置）；
 * - LAN-05 票据：无票超时关闭、过期票、重放票；
 * - LAN-06 吊销：HTTP 401 + WS 活连接立即关闭 + token/票据全失效；
 * - LAN-07 断连续传：lastSeq 续传只补增量；游标过期 cursor-stale；他人 DM 事件不推送；
 * - LAN-08 凭据脱敏：服务端日志不含 code/credential/token/ticket 明文；
 * - RT-21：桌面与浏览器同 commandId → 恰一次（replayed=true、消息数=1）；
 * - 本机保留方法（配对码创建/配置/吊销）在 HTTP 面拒绝；导出获准下载。
 * 真实 TLS：证书经 PowerShell 生成一次（测试文件内复用），Node 客户端以该 DER 为信任锚。
 */
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import * as https from 'node:https';
import * as tls from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { RemoteAccessServer, createPairingCode, revokeDeviceInDb, listDevices } from '../../src/daemon/remoteServer.ts';
import { ensureServerIdentity, type RemoteServerIdentity } from '../../src/daemon/remoteIdentity.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_APP_DATA;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-remote-'));
const appData = join(tmpRoot, 'app-data');
mkdirSync(appData, { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* 句柄延迟 */ } } });

let identity: RemoteServerIdentity;
beforeAll(() => {
  const r = ensureServerIdentity(appData, '127.0.0.1', []);
  if (!r.ok) throw new Error(`证书生成失败：${r.error}`);
  identity = r.identity;
}, 120_000);

interface Harness {
  db: ZhongshuoDatabase;
  server: RemoteAccessServer;
  port: number;
  logs: string[];
  origin: string;
  host: string;
  close: () => Promise<void>;
}

async function boot(testing?: Record<string, unknown>, dispatchWrap?: (envelope: unknown, next: (envelope: unknown) => Promise<unknown>) => Promise<unknown>): Promise<Harness> {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?,'{}',0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('dm_a','p1','dm',NULL),('dm_b','p1','dm',NULL)`).run();
  db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','dm_a','human','u_local'),('p1','dm_a','agent','mA'),('p1','dm_b','human','u_other'),('p1','dm_b','agent','mA')`).run();
  const logs: string[] = [];
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData };
  const server = new RemoteAccessServer({
    db,
    localUserId: 'u_local',
    appDataDir: appData,
    dispatch: (envelope, ctx) => {
      const next = (e: unknown): Promise<unknown> => dispatchDaemonCommand({ ...deps, ...(ctx != null ? { remoteAudit: { deviceId: ctx.deviceId, authEpoch: ctx.deviceEpoch }, remoteGate: ctx.gate } : {}) }, e);
      return dispatchWrap != null ? dispatchWrap(envelope, next) : next(envelope);
    },
    log: (l) => logs.push(l),
    testing: { identity, pumpMs: 80, authWindowMs: 900, ticketTtlMs: 30_000, resumeWindow: 5000, perIpPerMin: 999, globalPerMin: 9999, ...(testing ?? {}) },
  });
  const started = await server.start({ enabled: true, listenHost: '127.0.0.1', port: 0, allowLan: false });
  return {
    db, server, port: started.port, logs,
    origin: `https://127.0.0.1:${started.port}`,
    host: `127.0.0.1:${started.port}`,
    close: async () => { await server.stop(); db.close(); },
  };
}

function httpsJson(h: Harness, method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const payload = body == null ? undefined : JSON.stringify(body);
    const req = https.request({
      hostname: '127.0.0.1',
      port: h.port,
      path,
      method,
      headers: { 'content-type': 'application/json', origin: h.origin, host: h.host, ...(payload != null ? { 'content-length': String(Buffer.byteLength(payload)) } : {}), ...headers },
      ca: CERT_PEM,
      servername: 'localhost',
      rejectUnauthorized: true,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = JSON.parse(text); } catch { json = text; }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

// 最小 WS 客户端（掩码帧——按 RFC 6455；解析服务端未掩码帧）。
interface WsClient {
  send: (obj: unknown) => void;
  frames: Array<{ type: string } & Record<string, unknown>>;
  waitFrame: (predicate: (f: Record<string, unknown>) => boolean, ms?: number) => Promise<Record<string, unknown>>;
  closed: Promise<{ code: number | null }>;
  closeSocket: () => void;
  sendRaw: (text: string) => void;
}
function wsConnect(h: Harness, headers: Record<string, string> = {}, originOverride?: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const socket = tls.connect({ host: '127.0.0.1', port: h.port, ca: CERT_PEM, servername: 'localhost', rejectUnauthorized: true }, () => {
      const CRLF = '\r\n';
      const extraHeaders = Object.entries(headers).map(([k, v]) => `${k}: ${v}${CRLF}`).join('');
      socket.write(`GET /events HTTP/1.1${CRLF}Host: ${h.host}${CRLF}Upgrade: websocket${CRLF}Connection: Upgrade${CRLF}Sec-WebSocket-Key: ${key}${CRLF}Sec-WebSocket-Version: 13${CRLF}Origin: ${originOverride ?? h.origin}${CRLF}${extraHeaders}${CRLF}`);
    });
    socket.on('error', reject);
    let buf = Buffer.alloc(0);
    let handshaken = false;
    const frames: Array<{ type: string } & Record<string, unknown>> = [];
    const waiters: Array<{ predicate: (f: Record<string, unknown>) => boolean; resolve: (f: Record<string, unknown>) => void; timer: NodeJS.Timeout }> = [];
    let closedResolve: ((v: { code: number | null }) => void) | null = null;
    const closed = new Promise<{ code: number | null }>((r) => { closedResolve = r; });
    let closeCode: number | null = null;
    const client: WsClient = {
      sendRaw: (text: string) => {
        const data = Buffer.from(text, 'utf8');
        const mask = randomBytes(4);
        let header: Buffer;
        if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
        else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
        else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
        const masked = Buffer.from(data);
        for (let i = 0; i < masked.length; i += 1) masked[i] = (masked[i] ?? 0) ^ (mask[i % 4] ?? 0);
        socket.write(Buffer.concat([header, mask, masked]));
      },
      send: (obj) => {
        const data = Buffer.from(JSON.stringify(obj), 'utf8');
        const mask = randomBytes(4);
        let header: Buffer;
        if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
        else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
        const masked = Buffer.from(data);
        for (let i = 0; i < masked.length; i += 1) masked[i] = (masked[i] ?? 0) ^ (mask[i % 4] ?? 0);
        socket.write(Buffer.concat([header, mask, masked]));
      },
      frames,
      waitFrame: (predicate, ms = 4000) => new Promise((res, rej) => {
        const existing = frames.find((f) => predicate(f));
        if (existing != null) { res(existing); return; }
        const timer = setTimeout(() => rej(new Error(`waitFrame 超时（已收帧：${JSON.stringify(frames)}）`)), ms);
        waiters.push({ predicate, resolve: res, timer });
      }),
      closed,
      closeSocket: () => socket.destroy(),
    };
    const emitFrame = (text: string): void => {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { type: 'unparseable' }; }
      frames.push(parsed as { type: string } & Record<string, unknown>);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i]!.predicate(parsed)) {
          const w = waiters[i]!;
          clearTimeout(w.timer);
          waiters.splice(i, 1);
          w.resolve(parsed);
        }
      }
    };
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!handshaken) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.subarray(0, idx).toString('utf8');
        if (!head.includes('101')) {
          closedResolve?.({ code: null });
          socket.destroy();
          reject(new Error(`upgrade 失败：${head.split('\r\n')[0]}`));
          return;
        }
        handshaken = true;
        buf = buf.subarray(idx + 4);
        resolve(client);
      }
      for (;;) {
        if (buf.length < 2) return;
        const opB0 = buf[0] ?? 0;
        const opB1 = buf[1] ?? 0;
        const opcode = opB0 & 0x0f;
        const len7 = opB1 & 0x7f;
        let off = 2;
        let len = len7;
        if (len7 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len7 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (opcode === 8) { closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : null; closedResolve?.({ code: closeCode }); socket.destroy(); return; }
        if (opcode === 1) emitFrame(payload.toString('utf8'));
        // ping/pong 忽略（服务端不主动 ping）
      }
    });
    socket.on('close', () => { closedResolve?.({ code: closeCode }); });
  });
}

let CERT_PEM = '';
beforeAll(() => {
  // 信任锚=本地 CA（第三十六轮一：服务证书由 CA 签发——锚定叶子不再有效）。
  CERT_PEM = readFileSync(join(appData, 'remote', 'ca-cert.pem'), 'utf8');
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function seedEvent(db: ZhongshuoDatabase, eventId: string, conversationId: string | null, at = Date.now()): number {
  const r = db.prepare(`INSERT INTO domain_events (event_id, schema_version, project_id, conversation_id, kind, payload_json, created_at) VALUES (?,1,'p1',?,'message.submitted',?,?)`).run(eventId, conversationId, JSON.stringify({ note: eventId }), at);
  return Number(r.lastInsertRowid);
}

describe('LAN-01 配对与限速', () => {
  it('错码/对码/重复码/过期码/5 次失效', async () => {
    const h = await boot();
    const created = createPairingCode(h.db, Date.now(), { code: 'TESTCODE8' });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('unreachable');
    const wrong = await httpsJson(h, 'POST', '/pair', { pairingId: created.pairingId, code: 'WRONGCODE', deviceName: '测试设备', clientNonce: 'n1' });
    expect(wrong.status).toBe(401);
    const okr = await httpsJson(h, 'POST', '/pair', { pairingId: created.pairingId, code: 'TESTCODE8', deviceName: '测试设备', clientNonce: 'n2' });
    expect(okr.status).toBe(200);
    expect(typeof okr.json.deviceCredential).toBe('string');
    // 重复消费：同码再用=拒绝。
    const again = await httpsJson(h, 'POST', '/pair', { pairingId: created.pairingId, code: 'TESTCODE8', deviceName: '测试设备', clientNonce: 'n3' });
    expect(again.status).toBe(401);
    // 过期码。
    const exp = createPairingCode(h.db, Date.now() - 10_000, { code: 'EXPIREDC8', ttlMs: 1000 });
    if (!exp.ok) throw new Error('unreachable');
    const expR = await httpsJson(h, 'POST', '/pair', { pairingId: exp.pairingId, code: 'EXPIREDC8', deviceName: 'x', clientNonce: 'n4' });
    expect(expR.status).toBe(401);
    // 5 次失败失效：错 5 次后正确码也被拒。
    const five = createPairingCode(h.db, Date.now(), { code: 'FIVECODE8' });
    if (!five.ok) throw new Error('unreachable');
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await httpsJson(h, 'POST', '/pair', { pairingId: five.pairingId, code: 'BADCODE00', deviceName: 'x', clientNonce: 'n' });
      expect(r.status).toBe(401);
    }
    const lateRight = await httpsJson(h, 'POST', '/pair', { pairingId: five.pairingId, code: 'FIVECODE8', deviceName: 'x', clientNonce: 'n' });
    expect(lateRight.status).toBe(401);
    await h.close();
  }, 60_000);

  it('限速：每 IP 5 次/分钟 → 429+Retry-After', async () => {
    const h = await boot({ perIpPerMin: 5, globalPerMin: 30 });
    let saw429 = false;
    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await httpsJson(h, 'POST', '/pair', { pairingId: 'pair_nonexist' + i, code: 'AAAAAAAA', deviceName: 'x', clientNonce: 'n' });
      if (r.status === 429) {
        saw429 = true;
        expect(r.headers['retry-after']).toBeDefined();
        break;
      }
      expect(r.status).toBe(401);
    }
    expect(saw429).toBe(true);
    await h.close();
  }, 60_000);
});

describe('LAN-03 证书信任', () => {
  it('客户端不信任自签证书 → TLS 握手拒绝（不关闭证书校验）', async () => {
    const h = await boot();
    await new Promise<void>((resolve) => {
      const req = https.request({ hostname: '127.0.0.1', port: h.port, path: '/', method: 'GET', rejectUnauthorized: true }, () => { resolve(); throw new Error('不应成功'); });
      req.on('error', (e: Error & { code?: string }) => {
        expect(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(e.code ?? '') || /certificate/i.test(e.message)).toBe(true);
        resolve();
      });
      req.end();
    });
    await h.close();
  }, 60_000);
});

describe('LAN-04 伪造 Host/Origin', () => {
  it('Host/Origin 白名单来自本机配置——伪造即 403', async () => {
    const h = await boot();
    const badHost = await httpsJson(h, 'POST', '/pair', { pairingId: 'x', code: 'y', deviceName: 'z', clientNonce: 'n' }, { host: 'evil.example:1234' });
    expect(badHost.status).toBe(403);
    const badOrigin = await httpsJson(h, 'POST', '/pair', { pairingId: 'x', code: 'y', deviceName: 'z', clientNonce: 'n' }, { origin: 'https://evil.example' });
    expect(badOrigin.status).toBe(403);
    const noOrigin = await httpsJson(h, 'POST', '/pair', { pairingId: 'x', code: 'y', deviceName: 'z', clientNonce: 'n' }, { origin: '' });
    expect(noOrigin.status).toBe(403);
    await h.close();
  }, 60_000);
});

describe('会话/命令面（RT-21 同 commandId 恰一次）', () => {
  it('Device→token→/cmd；本机保留方法拒绝；桌面+浏览器同 commandId replayed', async () => {
    const h = await boot();
    const created = createPairingCode(h.db, Date.now(), { code: 'CMDTEST88' });
    if (!created.ok) throw new Error('unreachable');
    const paired = await httpsJson(h, 'POST', '/pair', { pairingId: created.pairingId, code: 'CMDTEST88', deviceName: '浏览器端', clientNonce: 'nn' });
    expect(paired.status).toBe(200);
    const credential: string = paired.json.deviceCredential;
    const badSession = await httpsJson(h, 'POST', '/session', {}, { authorization: 'Device zc_bogus' });
    expect(badSession.status).toBe(401);
    const sess = await httpsJson(h, 'POST', '/session', {}, { authorization: `Device ${credential}` });
    expect(sess.status).toBe(200);
    const token: string = sess.json.accessToken;
    const auth = { authorization: `Bearer ${token}` };
    // 业务命令：与桌面同一命令面。
    const commandId = `rt21-${randomUUID().slice(0, 8)}`;
    const params = { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: 'RT-21 远程提交暗号 REMOTE-ONCE-551', intent: 'record_only', mentions: [] };
    const desktop = await dispatchDaemonCommand({ db: h.db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData }, { protocolVersion: 1, commandId, method: 'message.submit', params }) as { ok: boolean; replayed?: boolean };
    expect(desktop.ok).toBe(true);
    const remote = await httpsJson(h, 'POST', '/cmd', { commandId, method: 'message.submit', params }, auth);
    expect(remote.status).toBe(200);
    expect(remote.json.ok).toBe(true);
    expect(remote.json.replayed).toBe(true); // 同 commandId 恰一次
    const count = (h.db.prepare(`SELECT count(*) c FROM messages WHERE conversation_id = 'dm_a'`).get() as { c: number }).c;
    expect(count).toBe(1);
    // 本机保留方法在 HTTP 面拒绝。
    const blocked = await httpsJson(h, 'POST', '/cmd', { commandId: 'remote-cmd-blocked-1', method: 'remote.pairing.create', params: {} }, auth);
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.code).toBe('REMOTE_METHOD_BLOCKED');
    const blocked2 = await httpsJson(h, 'POST', '/cmd', { commandId: 'remote-cmd-blocked-2', method: 'daemon.shutdown', params: {} }, auth);
    expect(blocked2.status).toBe(403);
    // 读取链可用。
    const hist = await httpsJson(h, 'POST', '/cmd', { commandId: 'remote-cmd-history-1', method: 'conversation.history', params: { conversationId: 'dm_a', limit: 10 } }, auth);
    expect(hist.json.ok).toBe(true);
    await h.close();
  }, 60_000);

  it('导出获准下载：Bearer → zip；无 token 401', async () => {
    const h = await boot();
    const created = createPairingCode(h.db, Date.now(), { code: 'EXPTEST88' });
    if (!created.ok) throw new Error('unreachable');
    const paired = await httpsJson(h, 'POST', '/pair', { pairingId: created.pairingId, code: 'EXPTEST88', deviceName: '导出设备', clientNonce: 'nn' });
    const sess = await httpsJson(h, 'POST', '/session', {}, { authorization: `Device ${paired.json.deviceCredential}` });
    const token: string = sess.json.accessToken;
    await dispatchDaemonCommand({ db: h.db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData }, { protocolVersion: 1, commandId: 'remote-export-host-1', method: 'message.submit', params: { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '导出宿主 EXPORT-DL-331', intent: 'record_only', mentions: [] } });
    const exp = await httpsJson(h, 'POST', '/cmd', { commandId: 'remote-export-create-2', method: 'export.create', params: { target: { kind: 'conversation', projectId: 'p1', conversationId: 'dm_a' }, format: 'md' } }, { authorization: `Bearer ${token}` });
    expect(exp.json.ok).toBe(true);
    const exportId: string = exp.json.data.exportId;
    const download = await new Promise<{ status: number; body: Buffer }>((resolve) => {
      https.get({ hostname: '127.0.0.1', port: h.port, path: `/export/${exportId}/download`, ca: CERT_PEM, servername: 'localhost', rejectUnauthorized: true, headers: { authorization: `Bearer ${token}`, origin: h.origin, host: h.host } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      }).on('error', () => resolve({ status: -1, body: Buffer.alloc(0) }));
    });
    expect(download.status).toBe(200);
    expect(download.body[0]).toBe(0x50); // 'P' (zip)
    const { unzipSync } = await import('fflate');
    const files = unzipSync(new Uint8Array(download.body));
    expect(Object.keys(files)).toContain('index.md');
    const noAuth = await new Promise<{ status: number }>((resolve) => {
      https.get({ hostname: '127.0.0.1', port: h.port, path: `/export/${exportId}/download`, ca: CERT_PEM, servername: 'localhost', rejectUnauthorized: true, headers: { origin: h.origin, host: h.host } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0 })); }).on('error', () => resolve({ status: -1 }));
    });
    expect(noAuth.status).toBe(401);
    await h.close();
  }, 120_000);
});

describe('WSS 票据/续传/吊销（LAN-05/06/07）', () => {
  it('无票超时关闭；错票拒绝；正常链路+订阅+事件推送；他人 DM 不推送', async () => {
    const h = await boot();
    // 无票：authWindow 后关闭。
    const noTicket = await wsConnect(h);
    const closed1 = await noTicket.closed;
    expect(closed1.code).toBe(1008);
    // 错票。
    const badTicket = await wsConnect(h);
    badTicket.send({ type: 'authenticate', ticket: 'bogus-ticket' });
    const closed2 = await badTicket.closed;
    expect(closed2.code).toBe(1008);
    // 正常链路。
    const created = createPairingCode(h.db, Date.now(), { code: 'WSTEST888' });
    if (!created.ok) throw new Error('unreachable');
    const paired = await httpsJson(h, 'POST', '/pair', { pairingId: created.pairingId, code: 'WSTEST888', deviceName: 'ws 设备', clientNonce: 'nn' });
    const sess = await httpsJson(h, 'POST', '/session', {}, { authorization: `Device ${paired.json.deviceCredential}` });
    const token: string = sess.json.accessToken;
    const t = await httpsJson(h, 'POST', '/ws-ticket', {}, { authorization: `Bearer ${token}` });
    expect(t.status).toBe(200);
    const ws = await wsConnect(h);
    ws.send({ type: 'authenticate', ticket: t.json.ticket });
    const authed = await ws.waitFrame((f) => f.type === 'authenticated');
    expect(typeof authed.fromSeq).toBe('number'); // 本测试事件在认证后才播种——fromSeq=0 合法
    ws.send({ type: 'subscribe', projectId: 'p1' });
    await ws.waitFrame((f) => f.type === 'subscribed');
    seedEvent(h.db, `evt-ws-${randomUUID().slice(0, 6)}`, 'dm_a');
    seedEvent(h.db, `evt-otherdm-${randomUUID().slice(0, 6)}`, 'dm_b'); // 他人 DM——不推送
    const got = await ws.waitFrame((f) => f.type === 'event');
    expect(got.projectId).toBe('p1');
    expect(String(got.eventId)).not.toContain('otherdm');
    // 他人 DM 事件确实存在但 4s 内不达（audience 过滤）。
    await expect(ws.waitFrame((f) => f.type === 'event' && String(f.eventId).includes('otherdm'), 1500)).rejects.toThrow();
    ws.closeSocket();
    await h.close();
  }, 90_000);

  it('票据重放与过期拒绝（LAN-05）', async () => {
    const h = await boot({ ticketTtlMs: 250 });
    const created = createPairingCode(h.db, Date.now(), { code: 'TKTTEST8' });
    if (!created.ok) throw new Error('unreachable');
    const paired = await httpsJson(h, 'POST', '/pair', { pairingId: created.pairingId, code: 'TKTTEST8', deviceName: 'tk', clientNonce: 'nn' });
    const sess = await httpsJson(h, 'POST', '/session', {}, { authorization: `Device ${paired.json.deviceCredential}` });
    const t1 = await httpsJson(h, 'POST', '/ws-ticket', {}, { authorization: `Bearer ${sess.json.accessToken}` });
    const t2 = await httpsJson(h, 'POST', '/ws-ticket', {}, { authorization: `Bearer ${sess.json.accessToken}` });
    const ws1 = await wsConnect(h);
    ws1.send({ type: 'authenticate', ticket: t1.json.ticket });
    await ws1.waitFrame((f) => f.type === 'authenticated');
    // 重放同一票据：第二连接拒绝。
    const ws2 = await wsConnect(h);
    ws2.send({ type: 'authenticate', ticket: t1.json.ticket });
    const closed2 = await ws2.closed;
    expect(closed2.code).toBe(1008);
    // 过期票据。
    await sleep(400);
    const ws3 = await wsConnect(h);
    ws3.send({ type: 'authenticate', ticket: t2.json.ticket });
    const closed3 = await ws3.closed;
    expect(closed3.code).toBe(1008);
    ws1.closeSocket();
    await h.close();
  }, 90_000);

  it('断连续传：lastSeq 只补增量；游标过期 cursor-stale（LAN-07）', async () => {
    const h = await boot({ resumeWindow: 3 });
    const seq1 = seedEvent(h.db, `evt-r1-${randomUUID().slice(0, 6)}`, 'dm_a');
    const created = createPairingCode(h.db, Date.now(), { code: 'RESUME188' });
    if (!created.ok) throw new Error('unreachable');
    const paired = await httpsJson(h, 'POST', '/pair', { pairingId: created.pairingId, code: 'RESUME188', deviceName: 'rs', clientNonce: 'nn' });
    const sess = await httpsJson(h, 'POST', '/session', {}, { authorization: `Device ${paired.json.deviceCredential}` });
    const t = await httpsJson(h, 'POST', '/ws-ticket', {}, { authorization: `Bearer ${sess.json.accessToken}` });
    const seq2 = seedEvent(h.db, `evt-r2-${randomUUID().slice(0, 6)}`, 'dm_a');
    // 续传：从 seq1 之后补——只收 seq2（不重推 seq1）。
    const ws = await wsConnect(h);
    ws.send({ type: 'authenticate', ticket: t.json.ticket, lastSeq: seq1 });
    const authed = await ws.waitFrame((f) => f.type === 'authenticated');
    expect(authed.resume).toBe(true);
    ws.send({ type: 'subscribe', projectId: 'p1' });
    const ev = await ws.waitFrame((f) => f.type === 'event');
    expect(ev.seq).toBe(seq2);
    expect(ws.frames.filter((f) => f.type === 'event').every((f) => Number(f.seq) > seq1)).toBe(true);
    ws.closeSocket();
    // 游标过期：补播事件拉开距离（current - lastSeq > resumeWindow）→ cursor-stale。
    for (let i = 0; i < 6; i += 1) seedEvent(h.db, `evt-stale-${randomUUID().slice(0, 6)}`, 'dm_a');
    await sleep(200);
    const t2 = await httpsJson(h, 'POST', '/ws-ticket', {}, { authorization: `Bearer ${sess.json.accessToken}` });
    const ws2 = await wsConnect(h);
    ws2.send({ type: 'authenticate', ticket: t2.json.ticket, lastSeq: seq1 });
    const stale = await ws2.waitFrame((f) => f.type === 'cursor-stale');
    expect(stale.hint).toBe('activity.list');
    ws2.closeSocket();
    await h.close();
  }, 90_000);

  it('吊销：HTTP 401 + WS 立即关闭 + 票据失效（LAN-06）', async () => {
    const h = await boot();
    const created = createPairingCode(h.db, Date.now(), { code: 'REVOKET88' });
    if (!created.ok) throw new Error('unreachable');
    const paired = await httpsJson(h, 'POST', '/pair', { pairingId: created.pairingId, code: 'REVOKET88', deviceName: 'rv', clientNonce: 'nn' });
    const deviceId: string = paired.json.deviceId;
    const sess = await httpsJson(h, 'POST', '/session', {}, { authorization: `Device ${paired.json.deviceCredential}` });
    const token: string = sess.json.accessToken;
    const t = await httpsJson(h, 'POST', '/ws-ticket', {}, { authorization: `Bearer ${token}` });
    const ws = await wsConnect(h);
    ws.send({ type: 'authenticate', ticket: t.json.ticket });
    await ws.waitFrame((f) => f.type === 'authenticated');
    expect(listDevices(h.db).some((d) => d.deviceId === deviceId && d.revokedAt == null)).toBe(true);
    revokeDeviceInDb(h.db, deviceId, Date.now());
    h.server.invalidateDevice(deviceId);
    const closed = await ws.closed;
    expect(closed.code).toBe(1008);
    const after = await httpsJson(h, 'POST', '/cmd', { commandId: 'remote-cmd-after-revoke', method: 'conversation.list', params: {} }, { authorization: `Bearer ${token}` });
    expect(after.status).toBe(401);
    expect(['TOKEN_INVALID', 'DEVICE_REVOKED']).toContain(after.json.error.code); // 吊销联动清 token——两种口径都是拒绝
    const credDead = await httpsJson(h, 'POST', '/session', {}, { authorization: `Device ${paired.json.deviceCredential}` });
    expect(credDead.status).toBe(401);
    ws.closeSocket();
    await h.close();
  }, 90_000);
});

describe('LAN-08 凭据脱敏', () => {
  it('服务端日志不含 code/credential/token/ticket 明文', async () => {
    const h = await boot();
    const created = createPairingCode(h.db, Date.now(), { code: 'SECRETC88' });
    if (!created.ok) throw new Error('unreachable');
    const paired = await httpsJson(h, 'POST', '/pair', { pairingId: created.pairingId, code: 'SECRETC88', deviceName: 'log 设备', clientNonce: 'nn' });
    const sess = await httpsJson(h, 'POST', '/session', {}, { authorization: `Device ${paired.json.deviceCredential}` });
    await httpsJson(h, 'POST', '/ws-ticket', {}, { authorization: `Bearer ${sess.json.accessToken}` });
    await httpsJson(h, 'POST', '/cmd', { commandId: 'remote-cmd-logcheck-xx', method: 'conversation.list', params: {} }, { authorization: `Bearer ${sess.json.accessToken}` });
    const joined = h.logs.join('\n');
    expect(joined).not.toContain('SECRETC88');
    expect(joined).not.toContain(paired.json.deviceCredential as string);
    expect(joined).not.toContain(sess.json.accessToken as string);
    expect(joined).not.toContain('ticket'); // 票据值不入日志（键名也不出现——统一脱敏通道）
    await h.close();
  }, 60_000);
});


describe('第三十二轮：合同补齐反例', () => {
  it('新 pairingId 复用近期码被拒（历史行 salt 核验）', async () => {
    const db = openDatabase32();
    const first = createPairingCode(db, Date.now(), { code: 'AUDITCODE8' });
    expect(first.ok).toBe(true);
    const second = createPairingCode(db, Date.now(), { code: 'AUDITCODE8' });
    expect(second.ok).toBe(false); // 同明文码 24h 内不重复发放（旧实现两码都成功——已修）
    if (!second.ok) expect(second.error).toContain('重复');
    const third = createPairingCode(db, Date.now(), { code: 'OTHERCODE8' });
    expect(third.ok).toBe(true); // 不同码不受影响
    db.close();
  }, 60_000);

  it('票据从合法 Origin A 签发、在另一个合法 Origin B 使用 → 拒绝', async () => {
    const h = await boot();
    const cred = await bootPair32(h, 'ORIGTEST8');
    // localhost 与 127.0.0.1 都在白名单（两个合法 Origin）。
    const sess = await httpsJson(h, 'POST', '/session', {}, { authorization: 'Device ' + cred });
    const t = await httpsJson(h, 'POST', '/ws-ticket', {}, { authorization: 'Bearer ' + sess.json.accessToken });
    expect(t.status).toBe(200);
    const ws = await wsConnect(h, {}, 'https://localhost:' + h.port); // 合法 B 携 A 的票据
    ws.send({ type: 'authenticate', ticket: t.json.ticket });
    const closed = await ws.closed;
    expect([1008]).toContain(closed.code); // origin 不匹配拒绝（不能只在白名单外拦）
    await h.close();
  }, 90_000);

  it('null/数组/错误类型首帧只关该连接——其他客户端不受影响', async () => {
    const h = await boot();
    const good = await bootWs32(h, 'STRUCT8A');
    for (const raw of ['null', '[1,2,3]', '"just-a-string"', '{"type":123}']) {
      const bad = await wsConnect(h);
      bad.sendRaw(raw);
      // eslint-disable-next-line no-await-in-loop
      const closed = await bad.closed;
      expect([1008, 1002, 1011]).toContain(closed.code);
    }
    // 观察者仍活着且可交互（协议错误不拖垮 daemon/其他连接）。
    good.send({ type: 'ping' });
    const pong = await good.waitFrame((f) => f.type === 'pong', 3000);
    expect(pong).toBeTruthy();
    good.closeSocket();
    await h.close();
  }, 90_000);

  it('超限帧（>64KB）被拒；订阅数量超限关闭', async () => {
    const h = await boot();
    const big = await wsConnect(h);
    big.sendRaw('x'.repeat(200 * 1024));
    const closed = await big.closed;
    expect(closed.code).toBe(1009); // message too big（ws maxPayload）
    const authed = await bootWs32(h, 'FRAME88B');
    for (let i = 0; i < 205; i += 1) authed.send({ type: 'subscribe', projectId: 'p_' + i });
    const closed2 = await authed.closed;
    expect(closed2.code).toBe(1008); // too-many-subscriptions
    await h.close();
  }, 90_000);

  it('events.list/task.get/task.stop 他人 DM 按 ID 直查拒绝；remote_audit_log 留痕（含重放）', async () => {
    const h = await boot();
    h.db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, author_type, author_id, body_json, status, created_at) VALUES ('m32','p1','dm_b',1,'human','u_other',?,'saved',1)`).run(JSON.stringify({ text: '他人 DM 32' }));
    h.db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, title, status, stop_generation, revision) VALUES ('task32','p1','dm_b','dm_turn','他人DM任务','ACTIVE',0,1)`).run();
    h.db.prepare(`INSERT INTO domain_events (event_id, schema_version, project_id, conversation_id, kind, payload_json, created_at) VALUES ('evt32-a',1,'p1','dm_b','message.submitted','{}',10)`).run();
    h.db.prepare(`INSERT INTO domain_events (event_id, schema_version, project_id, conversation_id, kind, payload_json, created_at) VALUES ('evt32-b',1,'p1','dm_a','message.submitted','{}',11)`).run();
    const a = await bootAuth32(h, 'AUDT32C8');
    // events.list：他人 DM 事件不可读（修复前按 projectId 全量泄出）。
    const ev = await httpsJson(h, 'POST', '/cmd', { commandId: 'r32-events-list-01', method: 'events.list', params: { projectId: 'p1', limit: 50 } }, a.headers);
    const evItems = (ev.json.data?.items ?? []) as Array<{ event_id: string }>;
    expect(evItems.some((x) => x.event_id === 'evt32-a')).toBe(false);
    expect(evItems.some((x) => x.event_id === 'evt32-b')).toBe(true); // 本人 DM 正常
    // task.get / task.stop：他人 DM 任务按 ID 拒。
    const tg = await httpsJson(h, 'POST', '/cmd', { commandId: 'r32-task-get-0001', method: 'task.get', params: { taskId: 'task32' } }, a.headers);
    expect(tg.json.ok).toBe(false);
    expect(tg.json.error.code).toBe('FORBIDDEN');
    const ts = await httpsJson(h, 'POST', '/cmd', { commandId: 'r32-task-stop-01', method: 'task.stop', params: { taskId: 'task32', targetRunId: 'run_x', expectedStopGeneration: 0 } }, a.headers);
    expect(ts.json.ok).toBe(false);
    expect(ts.json.error.code).toBe('FORBIDDEN');
    // 审计：写命令回执重放恰一次（读命令 events.list 无回执——每次都执行，各留一行审计）。
    const subParams = { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '审计重放恰一次 AUDIT-REPLAY-551', intent: 'record_only', mentions: [] };
    const sub1 = await httpsJson(h, 'POST', '/cmd', { commandId: 'r32-audit-submit-1', method: 'message.submit', params: subParams }, a.headers);
    expect(sub1.json.ok).toBe(true);
    const sub2 = await httpsJson(h, 'POST', '/cmd', { commandId: 'r32-audit-submit-1', method: 'message.submit', params: subParams }, a.headers);
    expect(sub2.json.replayed).toBe(true); // 同号同参原结果——恰一次
    const replay = { json: { replayed: true } };
    void replay;
    const auditRows = h.db.prepare('SELECT method, ok, replayed FROM remote_audit_log ORDER BY id').all() as Array<{ method: string; ok: number; replayed: number }>;
    expect(auditRows.filter((r) => r.method === 'events.list').length).toBe(1); // 读命令每次执行各留一行
    expect(auditRows.some((r) => r.method === 'task.stop' && r.ok === 0)).toBe(true);
    const cnt = (h.db.prepare(`SELECT count(*) c FROM messages WHERE conversation_id='dm_b'`).get() as { c: number }).c;
    expect(cnt).toBe(1);
    const cntA = (h.db.prepare(`SELECT count(*) c FROM messages WHERE conversation_id='dm_a' AND body_json LIKE '%AUDIT-REPLAY-551%'`).get() as { c: number }).c;
    expect(cntA).toBe(1); // 重放不重复执行
    expect(auditRows.filter((r) => r.method === 'message.submit').length).toBe(2); // 首次+重放各一行审计
    await h.close();
  }, 90_000);

  it('订阅未建立不推进游标（后订阅仍收到）；task_id 归属按任务会话过滤；未知归属不推', async () => {
    const h = await boot();
    const a = await bootAuth32(h, 'CURSOR8A');
    const seqBefore = seedEvent32(h.db, 'evt-gate-open-' + randomUUID().slice(0, 6), 'dm_a');
    const ws = await wsConnect(h);
    ws.send({ type: 'authenticate', ticket: a.ticket, lastSeq: seqBefore - 1 });
    await ws.waitFrame((f) => f.type === 'authenticated');
    await sleep(400); // 泵跑了——未订阅不得推进游标吞事件
    ws.send({ type: 'subscribe', projectId: 'p1' });
    const ev = await ws.waitFrame((f) => f.type === 'event', 4000);
    expect(Number(ev.seq)).toBe(seqBefore); // 事件未丢
    h.db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, title, status, stop_generation, revision) VALUES ('task-mine','p1','dm_a','dm_turn','我的','ACTIVE',0,1),('task-other','p1','dm_b','dm_turn','他人','ACTIVE',0,1)`).run();
    const seqMine = seedEvent32(h.db, 'evt-task-mine-' + randomUUID().slice(0, 6), null, 'task-mine', null);
    const seqOther = seedEvent32(h.db, 'evt-task-other-' + randomUUID().slice(0, 6), null, 'task-other', null);
    const seqUnknown = seedEvent32(h.db, 'evt-unknown-' + randomUUID().slice(0, 6), null, null, null);
    const gotMine = await ws.waitFrame((f) => f.type === 'event' && Number(f.seq) === seqMine, 4000);
    expect(gotMine).toBeTruthy();
    await expect(ws.waitFrame((f) => f.type === 'event' && Number(f.seq) === seqOther, 1200)).rejects.toThrow();
    await expect(ws.waitFrame((f) => f.type === 'event' && Number(f.seq) === seqUnknown, 1200)).rejects.toThrow();
    ws.closeSocket();
    await h.close();
  }, 90_000);

  it('大请求体读取期间吊销 → 派发前重查拒绝（不放过在途窗口）', async () => {
    const h = await boot();
    const a = await bootAuth32(h, 'SLOWBODY');
    const bigBody = JSON.stringify({ commandId: 'r32-slow-cmd-001', method: 'message.submit', params: { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '慢体提交 SLOW-BODY-771 ' + 'x'.repeat(2 * 1024 * 1024), intent: 'record_only', mentions: [] } });
    const result = await new Promise<{ status: number; body: string }>((resolve) => {
      const req = https.request({ hostname: '127.0.0.1', port: h.port, path: '/cmd', method: 'POST', headers: { 'content-type': 'application/json', origin: h.origin, host: h.host, authorization: 'Bearer ' + a.token, 'content-length': String(Buffer.byteLength(bigBody)) }, ca: CERT_PEM, servername: 'localhost', rejectUnauthorized: true }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', () => resolve({ status: -1, body: '' }));
      const half = Math.floor(bigBody.length / 2);
      req.write(bigBody.slice(0, half));
      setTimeout(() => {
        revokeDeviceInDb(h.db, a.deviceId, Date.now());
        h.server.invalidateDevice(a.deviceId);
        req.write(bigBody.slice(half));
        req.end();
      }, 250);
    });
    expect(result.status).toBe(401); // 派发前重查——读取期间吊销不放过
    const cnt = (h.db.prepare(`SELECT count(*) c FROM messages WHERE conversation_id='dm_a' AND body_json LIKE '%SLOW-BODY-771%'`).get() as { c: number }).c;
    expect(cnt).toBe(0); // 未派发（吊销≠停止——消息也没提交）
    await h.close();
  }, 90_000);

  it('会话到期关闭连接；换新 token+新票据重连可用（自动续换链）', async () => {
    const h = await boot({ tokenTtlMs: 1200 });
    const cred = await bootPair32(h, 'SESSXP88');
    const s1 = await httpsJson(h, 'POST', '/session', {}, { authorization: 'Device ' + cred });
    const t1 = await httpsJson(h, 'POST', '/ws-ticket', {}, { authorization: 'Bearer ' + s1.json.accessToken });
    const ws = await wsConnect(h);
    ws.send({ type: 'authenticate', ticket: t1.json.ticket });
    await ws.waitFrame((f) => f.type === 'authenticated');
    const closed = await ws.closed; // 会话到期（~1.2s）
    expect([1008]).toContain(closed.code);
    await sleep(50);
    const s2 = await httpsJson(h, 'POST', '/session', {}, { authorization: 'Device ' + cred });
    const t2 = await httpsJson(h, 'POST', '/ws-ticket', {}, { authorization: 'Bearer ' + s2.json.accessToken });
    const ws2 = await wsConnect(h);
    ws2.send({ type: 'authenticate', ticket: t2.json.ticket });
    const authed = await ws2.waitFrame((f) => f.type === 'authenticated');
    expect(authed.type).toBe('authenticated');
    ws2.closeSocket();
    await h.close();
  }, 90_000);
});

// ---------- 第三十二轮测试助手 ----------
function openDatabase32() {
  const db = openDatabase(':memory:');
  return db;
}
function seedEvent32(db: import('../../src/persistence/db.ts').ZhongshuoDatabase, eventId: string, conversationId: string | null, taskId: string | null = null, threadId: string | null = null, at = Date.now()): number {
  const r = db.prepare(`INSERT INTO domain_events (event_id, schema_version, project_id, conversation_id, thread_id, task_id, kind, payload_json, created_at) VALUES (?,1,'p1',?,?,?, 'message.submitted','{}',?)`).run(eventId, conversationId, threadId, taskId, at);
  return Number(r.lastInsertRowid);
}
async function bootPair32(h: Harness, codeHint?: string): Promise<string> {
  const code = codeHint ?? ('PAIR' + Math.random().toString(36).slice(2, 7).toUpperCase());
  const created = createPairingCode(h.db, Date.now(), { code });
  if (!created.ok) throw new Error('pairing create failed');
  const paired = await httpsJson(h, 'POST', '/pair', { pairingId: created.pairingId, code: created.code, deviceName: 'r32', clientNonce: 'nn' });
  expect(paired.status).toBe(200);
  return paired.json.deviceCredential as string;
}
async function bootAuth32(h: Harness, codeHint?: string): Promise<{ token: string; ticket: string; deviceId: string; headers: Record<string, string> }> {
  const cred = await bootPair32(h, codeHint);
  const sess = await httpsJson(h, 'POST', '/session', {}, { authorization: 'Device ' + cred });
  expect(sess.status).toBe(200);
  const tk = await httpsJson(h, 'POST', '/ws-ticket', {}, { authorization: 'Bearer ' + sess.json.accessToken });
  expect(tk.status).toBe(200);
  const deviceId = (h.db.prepare('SELECT device_id FROM remote_devices ORDER BY created_at DESC LIMIT 1').get() as { device_id: string }).device_id;
  return { token: sess.json.accessToken, ticket: tk.json.ticket, deviceId, headers: { authorization: 'Bearer ' + sess.json.accessToken } };
}
async function bootWs32(h: Harness, _tag?: string): Promise<Awaited<ReturnType<typeof wsConnect>>> {
  const a = await bootAuth32(h);
  const ws = await wsConnect(h);
  ws.send({ type: 'authenticate', ticket: a.ticket });
  await ws.waitFrame((f) => f.type === 'authenticated');
  ws.send({ type: 'subscribe', projectId: 'p1' });
  await ws.waitFrame((f) => f.type === 'subscribed');
  return ws;
}

describe('第三十五轮：读取链贯通/自检看板真异步/空态对照', () => {
  it('自检看板核验等待真实结果：非空看板真实组数（1->1，非 -1）；前置/结束查询失败均不计通过', async () => {
    const prevScEnv = process.env.ZS_REMOTE_SELFCHECK;
    process.env.ZS_REMOTE_SELFCHECK = '1';
    try {
      // ① 正常路径：可见=['p1'] → 1 组——detail 必须是真实数字（旧实现未 await 恒 -1->-1 假 PASS）。
      const h = await boot();
      const depsLocal = { db: h.db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData };
      await dispatchDaemonCommand(depsLocal, { protocolVersion: 1, commandId: 'r35-nav-01', method: 'nav.preferences', params: { clientId: 'user-ui', visibleProjectIds: ['p1'] } });
      const r1 = await h.server.runSelfcheck();
      expect(r1.ok).toBe(true);
      const boardItem1 = r1.items.find((i) => i.name.includes('导航偏好与全项目看板'));
      expect(boardItem1?.ok).toBe(true);
      expect(boardItem1?.detail).toContain('boardGroups=1->1'); // 真实组数——不是 -1->-1
      expect((h.db.prepare("SELECT count(*) c FROM daemon_state WHERE key LIKE 'selfcheck:probe:%'").get() as { c: number }).c).toBe(0);
      await h.close();
      // ② 前置查询失败：dispatch 对 board.view 恒抛 → 基线 null → 该项明确失败（不按前后一致通过）。
      const h2 = await boot(undefined, async (envelope, next) => {
        if ((envelope as { method?: string }).method === 'board.view') throw new Error('board view down (pre)');
        return next(envelope);
      });
      const r2 = await h2.server.runSelfcheck();
      expect(r2.ok).toBe(false);
      const boardItem2 = r2.items.find((i) => i.name.includes('导航偏好与全项目看板'));
      expect(boardItem2?.ok).toBe(false);
      expect(boardItem2?.detail).toContain('看板查询失败/未覆盖');
      await h2.close();
      // ③ 结束查询失败：第一次 board.view（前基线）成功、之后（结束核验）失败 → 真实前值+null 后值 → 不计通过。
      let boardCalls = 0;
      const h3 = await boot(undefined, async (envelope, next) => {
        if ((envelope as { method?: string }).method === 'board.view') {
          boardCalls += 1;
          if (boardCalls > 1) throw new Error('board view down (post)');
        }
        return next(envelope);
      });
      await dispatchDaemonCommand({ db: h3.db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData }, { protocolVersion: 1, commandId: 'r35-nav-03', method: 'nav.preferences', params: { clientId: 'user-ui', visibleProjectIds: ['p1'] } });
      const r3 = await h3.server.runSelfcheck();
      expect(r3.ok).toBe(false);
      const boardItem3 = r3.items.find((i) => i.name.includes('导航偏好与全项目看板'));
      expect(boardItem3?.ok).toBe(false);
      expect(boardItem3?.detail).toContain('boardGroups=1->null'); // 前值真实取得（await 生效）、后值失败如实 null
      await h3.close();
    } finally {
      if (prevScEnv == null) delete process.env.ZS_REMOTE_SELFCHECK; else process.env.ZS_REMOTE_SELFCHECK = prevScEnv;
    }
  }, 120_000);

  it('正常空数据对照：可见集为空 → board.view 成功返回 0 组（成功空响应≠读取失败）', async () => {
    const h = await boot();
    const depsLocal = { db: h.db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData };
    await dispatchDaemonCommand(depsLocal, { protocolVersion: 1, commandId: 'r35-nav-empty-01', method: 'nav.preferences', params: { clientId: 'user-ui', visibleProjectIds: [] } });
    const r = await dispatchDaemonCommand(depsLocal, { protocolVersion: 1, commandId: 'r35-board-empty-01', method: 'board.view', params: { scope: 'all' } }) as { ok: boolean; data?: { groups?: unknown[] } };
    expect(r.ok).toBe(true); // 成功响应（不是错误）
    expect(Array.isArray(r.data?.groups)).toBe(true);
    expect(r.data?.groups?.length).toBe(0); // 确实无可见项目——空态由成功响应承载
    await h.close();
  }, 60_000);
});

describe('第三十四轮：跨项目检查点/自检不变性/同请求中途吊销', () => {
  it('跨项目安全检查点：P2 1—301+P1 302、先订 P1、半批断线——重连后无漏无重（P2 的 301 补到）', async () => {
    const h = await boot({ resumeWindow: 1_000_000 });
    h.db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p2','项目2',?,?,'{}',0)`).run(tmpRoot, tmpRoot);
    // 用户复现场景：P2 有 1—301；P1 随后 302；订阅顺序 P1、P2。
    const p2Seqs: number[] = [];
    for (let i = 0; i < 301; i += 1) p2Seqs.push(seedEventP2(h.db, `evt-cp-p2-${String(i).padStart(3, '0')}-${randomUUID().slice(0, 4)}`, 'dm_a'));
    const p1Seq = seedEvent(h.db, `evt-cp-p1-302-${randomUUID().slice(0, 4)}`, 'dm_a');
    const a = await bootAuth32(h, 'CPCHK34A');
    const ws = await wsConnect(h);
    ws.send({ type: 'authenticate', ticket: a.ticket, lastSeq: 0 });
    await ws.waitFrame((f) => f.type === 'authenticated');
    ws.send({ type: 'subscribe', projectId: 'p1' });
    await ws.waitFrame((f) => f.type === 'subscribed');
    ws.send({ type: 'subscribe', projectId: 'p2' });
    await ws.waitFrame((f) => f.type === 'subscribed');
    // 第一泵：先 P1 的 302，再 P2 前 300（单泵页 300）——等两者到齐后**半批断线**。
    await ws.waitFrame((f) => f.type === 'event' && Number(f.seq) === p1Seq, 6000);
    await ws.waitFrame((f) => f.type === 'event' && Number(f.seq) === p2Seqs[299], 8000);
    expect(ws.frames.some((f) => f.type === 'event' && Number(f.seq) === p2Seqs[300])).toBe(false); // 301 未达（单泵页边界）
    ws.closeSocket();
    // 客户端持久水位（与 remoteClient 同法）：每项目取已投递最大，检查点=各跟踪项目 min。
    const wmP1 = p1Seq;
    const wmP2 = p2Seqs[299]!;
    const checkpoint = Math.min(wmP1, wmP2);
    expect(checkpoint).toBe(wmP2); // 复现要点：全局 max=302 会越过 P2 的 301；min=300 安全
    // 断线重连：authenticate lastSeq=安全检查点。
    const t2 = await httpsJson(h, 'POST', '/ws-ticket', {}, a.headers);
    const ws2 = await wsConnect(h);
    ws2.send({ type: 'authenticate', ticket: t2.json.ticket, lastSeq: checkpoint });
    await ws2.waitFrame((f) => f.type === 'authenticated');
    ws2.send({ type: 'subscribe', projectId: 'p1' });
    ws2.send({ type: 'subscribe', projectId: 'p2' });
    // P2 的 301 必须补到（旧全局 max 模型永远补不到）。
    await ws2.waitFrame((f) => f.type === 'event' && Number(f.seq) === p2Seqs[300], 8000);
    // 逐条核对无漏无重：两连接合并的 (project,seq) 键集==期望全量 302 条；呈现集（去重）无重复。
    const counts = new Map<string, number>();
    for (const f of [...ws.frames, ...ws2.frames]) {
      if (f.type !== 'event') continue;
      const key = `${String(f.projectId)}:${String(f.seq)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.get(`p1:${p1Seq}`)).toBeGreaterThanOrEqual(1);
    for (let i = 0; i <= 300; i += 1) expect(counts.get(`p2:${p2Seqs[i]}`)).toBeGreaterThanOrEqual(1);
    expect(counts.size).toBe(302); // 无漏：恰好 P1×1+P2×301
    // 无重（呈现语义）：去重后键数与总投递键数一致——服务端重投由 eventId 去重吸收。
    const deliveredTwice = [...counts.entries()].filter(([, c]) => c > 1).map(([k]) => k);
    expect(deliveredTwice.every((k) => k === `p1:${p1Seq}`)).toBe(true); // 允许的重投=检查点以下的 P1 302
    ws2.closeSocket();
    await h.close();
  }, 150_000);

  it('自检不动用户导航偏好/看板/设备/在途任务（成功+连续执行+失败路径；探针临时键清理）', async () => {
    const prevScEnv = process.env.ZS_REMOTE_SELFCHECK;
    process.env.ZS_REMOTE_SELFCHECK = '1'; // 隔离验收模式（自检命令面门禁）
    try {
    const h = await boot();
    const depsLocal = { db: h.db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData };
    // 建立用户偏好（正式命令）：可见=['p1']——看板 scope=all 据此聚合。
    await dispatchDaemonCommand(depsLocal, { protocolVersion: 1, commandId: 'r34-nav-user-01', method: 'nav.preferences', params: { clientId: 'user-ui', visibleProjectIds: ['p1'] } });
    const navSnapshot = (): string => JSON.stringify(h.db.prepare('SELECT client_id, revision, visible_project_ids_json FROM navigation_preferences ORDER BY client_id').all());
    const boardGroups = async (): Promise<number> => {
      const r = await dispatchDaemonCommand(depsLocal, { protocolVersion: 1, commandId: 'r34-board-' + randomUUID().slice(0, 6), method: 'board.view', params: { scope: 'all' } }) as { ok: boolean; data?: { groups?: unknown[] } };
      return Array.isArray(r.data?.groups) ? r.data.groups.length : -1;
    };
    const navBefore = navSnapshot();
    const groupsBefore = await boardGroups();
    expect(groupsBefore).toBeGreaterThanOrEqual(1); // 偏好生效（可见 p1→至少 1 组）
    const r1 = await h.server.runSelfcheck();
    for (const item of r1.items) expect({ name: item.name, ok: item.ok }).toEqual({ name: item.name, ok: true });
    const r2 = await h.server.runSelfcheck(); // 连续执行（第二轮同样全过且不变）
    for (const item of r2.items) expect({ name: item.name, ok: item.ok }).toEqual({ name: item.name, ok: true });
    expect(navSnapshot()).toBe(navBefore); // 偏好行集不变（自检不写 navigation_preferences）
    expect(await boardGroups()).toBe(groupsBefore); // 看板组数不变（不归零）
    expect((h.db.prepare("SELECT count(*) c FROM daemon_state WHERE key LIKE 'selfcheck:probe:%'").get() as { c: number }).c).toBe(0); // 探针临时键清理
    // 失败路径：停服后自检（前置失败）——偏好/看板仍不变。
    await h.server.stop();
    const r3 = await h.server.runSelfcheck();
    expect(r3.ok).toBe(false);
    expect(r3.items.some((i) => i.name.includes('导航偏好') && i.ok)).toBe(true); // 失败路径也登记不变性
    expect(navSnapshot()).toBe(navBefore);
    h.db.close();
    } finally { if (prevScEnv == null) delete process.env.ZS_REMOTE_SELFCHECK; else process.env.ZS_REMOTE_SELFCHECK = prevScEnv; }
  }, 120_000);

  it('同一请求导出等待中吊销→提交拒绝且零业务提交（异步窗口内——非「吊销后再调用」）', async () => {
    const h = await boot();
    const a = await bootAuth32(h, 'MIDREV34');
    await dispatchDaemonCommand({ db: h.db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData }, { protocolVersion: 1, commandId: 'r34-mid-seed-01', method: 'message.submit', params: { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '中途吊销宿主 MID-REVOKE-771', intent: 'record_only', mentions: [] } });
    const g = globalThis as { __zsTestExportHook?: () => void | Promise<void> };
    const expRoot = join(appData, 'exports');
    const dirsBefore = new Set(existsSync(expRoot) ? readdirSync(expRoot) : []);
    // 导出等待窗口（writeExport 完成/复核前）内吊销——同一请求在途，不是吊销后再发新请求。
    g.__zsTestExportHook = async () => {
      revokeDeviceInDb(h.db, a.deviceId, Date.now());
      h.server.invalidateDevice(a.deviceId);
    };
    try {
      const r = await httpsJson(h, 'POST', '/cmd', { commandId: 'r34-mid-revoke-01', method: 'export.create', params: { target: { kind: 'conversation', projectId: 'p1', conversationId: 'dm_a' }, format: 'md' } }, a.headers);
      expect(r.status).toBe(200); // HTTP 面正常应答
      expect(r.json.ok).toBe(false); // 提交前门禁拒绝（run() 边界——异步等待结束后）
      expect(r.json.error.code).toBe('DEVICE_REVOKED');
      // 零业务提交：无回执、无导出目录（失败清理）。
      expect((h.db.prepare('SELECT count(*) c FROM command_receipts WHERE command_id = ?').get('r34-mid-revoke-01') as { c: number }).c).toBe(0);
      const dirsAfter = existsSync(expRoot) ? readdirSync(expRoot) : [];
      const newDirs = dirsAfter.filter((n) => !dirsBefore.has(n)); // 共享 appData——只断言本次请求零新目录
      expect(newDirs.length).toBe(0);
      // 拒绝留审计（本次请求的设备+命令号+失败事实）。
      const audit = h.db.prepare('SELECT ok FROM remote_audit_log WHERE command_id = ?').all('r34-mid-revoke-01') as Array<{ ok: number }>;
      expect(audit.length).toBe(1);
      expect(audit[0]!.ok).toBe(0);
    } finally {
      delete g.__zsTestExportHook;
    }
    await h.close();
  }, 120_000);
});

describe('第三十三轮：设备级代次/限额/收拢/泵模型/下载门禁/自检', () => {
  it('设备级授权代次：吊销 A 不伤 B（B 现有 token/票据/WS 全部继续）', async () => {
    const h = await boot();
    const credA = await bootPair32(h, 'EPOCHDV8A');
    const credB = await bootPair32(h, 'EPOCHDV8B');
    const devA = (h.db.prepare("SELECT device_id FROM remote_devices WHERE revoked_at IS NULL ORDER BY created_at LIMIT 1 OFFSET 0").all() as Array<{ device_id: string }>);
    const devs = h.db.prepare('SELECT device_id FROM remote_devices ORDER BY created_at').all() as Array<{ device_id: string }>;
    expect(devs.length).toBe(2);
    const idA = devA[0]!.device_id;
    const idB = devs.find((d) => d.device_id !== idA)!.device_id;
    const sessA = await httpsJson(h, 'POST', '/session', {}, { authorization: 'Device ' + credA });
    const sessB = await httpsJson(h, 'POST', '/session', {}, { authorization: 'Device ' + credB });
    expect(sessA.status).toBe(200);
    expect(sessB.status).toBe(200);
    // B 先建活连接（订阅 p1——事件推送路径）。
    const tkB = await httpsJson(h, 'POST', '/ws-ticket', {}, { authorization: 'Bearer ' + sessB.json.accessToken });
    const wsB = await wsConnect(h);
    wsB.send({ type: 'authenticate', ticket: tkB.json.ticket });
    await wsB.waitFrame((f) => f.type === 'authenticated');
    wsB.send({ type: 'subscribe', projectId: 'p1' });
    await wsB.waitFrame((f) => f.type === 'subscribed');
    // A 的活连接。
    const tkA = await httpsJson(h, 'POST', '/ws-ticket', {}, { authorization: 'Bearer ' + sessA.json.accessToken });
    const wsA = await wsConnect(h);
    wsA.send({ type: 'authenticate', ticket: tkA.json.ticket });
    await wsA.waitFrame((f) => f.type === 'authenticated');
    // 吊销 A（DB+内存联动）。
    revokeDeviceInDb(h.db, idA, Date.now());
    h.server.invalidateDevice(idA);
    // A 全拒：token 401、活连接关闭。
    const afterA = await httpsJson(h, 'POST', '/cmd', { commandId: 'r33-a-after-revoke', method: 'conversation.list', params: {} }, { authorization: 'Bearer ' + sessA.json.accessToken });
    expect(afterA.status).toBe(401);
    const closedA = await wsA.closed;
    expect(closedA.code).toBe(1008);
    // **B 不受影响**：现有 token 继续可用（无需重登录）。
    const cmdB = await httpsJson(h, 'POST', '/cmd', { commandId: 'r33-b-token-alive', method: 'conversation.list', params: {} }, { authorization: 'Bearer ' + sessB.json.accessToken });
    expect(cmdB.status).toBe(200);
    expect(cmdB.json.ok).toBe(true);
    // B 活连接继续收事件。
    seedEvent(h.db, 'evt-epoch-b-' + randomUUID().slice(0, 6), 'dm_a');
    const evB = await wsB.waitFrame((f) => f.type === 'event' && String(f.eventId).includes('epoch-b'), 6000);
    expect(evB).toBeTruthy();
    // B 还能换新 token（设备凭据未被全局代次误伤）。
    const renewB = await httpsJson(h, 'POST', '/session', {}, { authorization: 'Device ' + credB });
    expect(renewB.status).toBe(200);
    // B 旧票据签发链路照常。
    const tkB2 = await httpsJson(h, 'POST', '/ws-ticket', {}, { authorization: 'Bearer ' + sessB.json.accessToken });
    expect(tkB2.status).toBe(200);
    wsB.closeSocket();
    await h.close();
  }, 120_000);

  it('WSS 每地址未认证限额：同源第 3 个拒绝；关闭后可再连；全局上限独立', async () => {
    const h = await boot();
    const c1 = await wsConnect(h);
    const c2 = await wsConnect(h);
    // 同地址第 3 个未认证连接：429（upgrade 拒绝）。
    await expect(wsConnect(h)).rejects.toThrow();
    // 关闭一个→释放→可再连。
    c1.closeSocket();
    await sleep(400);
    const c3 = await wsConnect(h);
    c3.closeSocket();
    c2.closeSocket();
    await h.close();
    // 全局上限（与每地址独立——每地址放宽到 10、全局 2）。
    const h2 = await boot({ unauthPerAddr: 10, unauthGlobal: 2 });
    const g1 = await wsConnect(h2);
    const g2 = await wsConnect(h2);
    await expect(wsConnect(h2)).rejects.toThrow();
    g1.closeSocket();
    g2.closeSocket();
    await h2.close();
  }, 90_000);

  it('有界关闭收拢：不回握的客户端宽限后 terminate；daemon.stop 有界完成', async () => {
    const h = await boot({ closeGraceMs: 300, stopDeadlineMs: 500 });
    const ws = await bootWs32(h, 'CLOSE33');
    const t0 = Date.now();
    // 吊销触发服务端关闭——测试客户端不回应关闭握手（不回 close 帧）。
    const devRow = h.db.prepare('SELECT device_id FROM remote_devices ORDER BY created_at DESC LIMIT 1').get() as { device_id: string };
    revokeDeviceInDb(h.db, devRow.device_id, Date.now());
    h.server.invalidateDevice(devRow.device_id);
    const closed = await ws.closed; // 宽限 300ms 后 terminate——closed 兑现（不无限等握手）
    void closed;
    expect(Date.now() - t0).toBeLessThan(3000);
    // daemon.stop 有界：留一个不认证也不回握的连接——stop 在截止内完成（不悬挂）。
    const stubborn = await wsConnect(h);
    void stubborn;
    const t1 = Date.now();
    await h.server.stop();
    expect(Date.now() - t1).toBeLessThan(5000);
    h.db.close();
  }, 90_000);

  it('泵按项目游标：600 条未订阅 P1 不阻塞已订阅 P2；迟订阅/取消订阅/重连不漏不重扫', async () => {
    const h = await boot({ resumeWindow: 1_000_000 });
    h.db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p2','项目2',?,?,'{}',0)`).run(tmpRoot, tmpRoot);
    // P1 600 条（未订阅）+ P2 1 条（将订阅）。
    for (let i = 0; i < 600; i += 1) seedEvent(h.db, `evt-p1-${String(i).padStart(3, '0')}-${randomUUID().slice(0, 4)}`, 'dm_a');
    const seqP2 = seedEventP2(h.db, 'evt-p2-marker-' + randomUUID().slice(0, 6), 'dm_a');
    const a = await bootAuth32(h, 'PUMP3388');
    const ws = await wsConnect(h);
    ws.send({ type: 'authenticate', ticket: a.ticket, lastSeq: 0 });
    await ws.waitFrame((f) => f.type === 'authenticated');
    // 只订阅 P2——尽管 P1 有 600 条更早事件，P2 事件必须送达（旧全局 LIMIT 500 模型发不出）。
    ws.send({ type: 'subscribe', projectId: 'p2' });
    await ws.waitFrame((f) => f.type === 'subscribed');
    const gotP2 = await ws.waitFrame((f) => f.type === 'event' && Number(f.seq) === seqP2, 6000);
    expect(gotP2).toBeTruthy();
    // 迟后订阅 P1：600 条全量补发（分批 300/泵）——末条（seq=600）也到（不遗漏、不无限重扫）。
    ws.send({ type: 'subscribe', projectId: 'p1' });
    await ws.waitFrame((f) => f.type === 'subscribed' && f.projectId === 'p1');
    await ws.waitFrame((f) => f.type === 'event' && f.projectId === 'p1' && Number(f.seq) === 600, 30_000); // 600 条全部到位（末条 seq=600）
    const p1Count = ws.frames.filter((f) => f.type === 'event' && f.projectId === 'p1').length;
    expect(p1Count).toBe(600);
    // 取消订阅 P1：新 P1 事件不再推。
    ws.send({ type: 'unsubscribe', projectId: 'p1' });
    await ws.waitFrame((f) => f.type === 'unsubscribed');
    seedEvent(h.db, 'evt-p1-after-unsub-' + randomUUID().slice(0, 6), 'dm_a');
    await expect(ws.waitFrame((f) => f.type === 'event' && String(f.eventId).includes('after-unsub'), 1500)).rejects.toThrow();
    // P2 照常。
    const seqP2b = seedEventP2(h.db, 'evt-p2-second-' + randomUUID().slice(0, 6), 'dm_a');
    const got2 = await ws.waitFrame((f) => f.type === 'event' && Number(f.seq) === seqP2b, 6000);
    expect(got2).toBeTruthy();
    ws.closeSocket();
    // 重连续传：断开后新事件，lastSeq 续传只补增量（去重按 eventId）。
    const seqP2c = seedEventP2(h.db, 'evt-p2-third-' + randomUUID().slice(0, 6), 'dm_a');
    const tk2 = await httpsJson(h, 'POST', '/ws-ticket', {}, a.headers);
    const ws2 = await wsConnect(h);
    ws2.send({ type: 'authenticate', ticket: tk2.json.ticket, lastSeq: seqP2b });
    await ws2.waitFrame((f) => f.type === 'authenticated');
    ws2.send({ type: 'subscribe', projectId: 'p2' });
    await ws2.waitFrame((f) => f.type === 'subscribed');
    const got3 = await ws2.waitFrame((f) => f.type === 'event' && Number(f.seq) === seqP2c, 6000);
    expect(got3).toBeTruthy();
    ws2.closeSocket();
    await h.close();
  }, 120_000);

  it('主文件同长度篡改 → 410；资产额度与元文件分离（200 合法/201 明确拒绝）', async () => {
    const h = await boot();
    const a = await bootAuth32(h, 'TAMPER33');
    await dispatchDaemonCommand({ db: h.db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData }, { protocolVersion: 1, commandId: 'r33-tamper-seed-01', method: 'message.submit', params: { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '主文件篡改宿主 TAMPER-MAIN-331', intent: 'record_only', mentions: [] } });
    const exp = await httpsJson(h, 'POST', '/cmd', { commandId: 'r33-tamper-create', method: 'export.create', params: { target: { kind: 'conversation', projectId: 'p1', conversationId: 'dm_a' }, format: 'md' } }, a.headers);
    expect(exp.json.ok).toBe(true);
    const exportId: string = exp.json.data.exportId;
    const dir = join(appData, 'exports', exportId);
    // 主文件同长度篡改：改一个字符、字节长度不变——旧实现 bytes 后 continue 跳过哈希核验可过。
    const idxPath = join(dir, 'index.md');
    const original = readFileSync(idxPath, 'utf8');
    const tampered = original.replace('TAMPER-MAIN-331', 'TAMPER-MAIN-33X');
    expect(tampered.length).toBe(original.length); // 同长度
    writeFileSync(idxPath, tampered, 'utf8');
    const dl1 = await downloadZip(h, exportId, a.token);
    expect(dl1.status).toBe(410);
    expect(dl1.json.error.code).toBe('EXPORT_TAMPERED');
    // 恢复后再验 200（结构未被破坏）。
    writeFileSync(idxPath, original, 'utf8');
    const dl2 = await downloadZip(h, exportId, a.token);
    expect(dl2.status).toBe(200);
    // 手工构造边界导出目录：200 件资产+正文+清单（=202 文件）合法；201 件资产明确 413。
    const mkBoundary = (id: string, assetCount: number): string => {
      const d = join(appData, 'exports', id);
      mkdirSync(join(d, 'assets'), { recursive: true });
      const files: Array<{ file: string; bytes: number; sha256: string }> = [];
      for (let i = 0; i < assetCount; i += 1) {
        const rel = `assets/att-${String(i).padStart(3, '0')}.txt`;
        const content = Buffer.from(`BOUNDARY-ASSET-${id}-${i}\n`, 'utf8');
        writeFileSync(join(d, rel.replaceAll('/', String.fromCharCode(92).repeat(1))), content);
        files.push({ file: rel, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
      }
      const primary = Buffer.from('# boundary primary\n', 'utf8');
      writeFileSync(join(d, 'index.md'), primary);
      writeFileSync(join(d, 'manifest.json'), JSON.stringify({ conversationId: 'dm_a', primary: { file: 'index.md', bytes: primary.length, sha256: createHash('sha256').update(primary).digest('hex') }, files }));
      return d;
    };
    mkBoundary('exp_bound200ok', 200);
    const ok200 = await downloadZip(h, 'exp_bound200ok', a.token);
    expect(ok200.status).toBe(200);
    if (ok200.status === 200) {
      const { unzipSync } = await import('fflate');
      const inner = unzipSync(new Uint8Array(ok200.body));
      expect(Object.keys(inner).length).toBe(202); // 200 资产+index.md+manifest.json——元文件不截
    }
    mkBoundary('exp_bound201rej', 201);
    const rej201 = await downloadZip(h, 'exp_bound201rej', a.token);
    expect(rej201.status).toBe(413);
    expect(rej201.json.error.code).toBe('EXPORT_TOO_LARGE');
    await h.close();
  }, 120_000);

  it('共享命令门禁（提交前重查）：上下文有效→提交；吊销后同上下文→拒绝且零提交', async () => {
    const h = await boot();
    const a = await bootAuth32(h, 'GATE3388');
    const epoch = (h.db.prepare('SELECT auth_epoch FROM remote_devices WHERE device_id = ?').get(a.deviceId) as { auth_epoch: number }).auth_epoch;
    const deps = {
      db: h.db,
      localUserId: 'u_local',
      interruptTurn: async () => {},
      appDataDir: appData,
      remoteAudit: { deviceId: a.deviceId, authEpoch: epoch },
      remoteGate: (): { ok: true } | { ok: false; code: string; message: string } => h.server.deviceLive(a.deviceId, epoch, a.token),
    };
    const params = { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '门禁提交前重查 GATE-COMMIT-771', intent: 'record_only', mentions: [] };
    const first = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: 'r33-gate-commit-01', method: 'message.submit', params }) as { ok: boolean };
    expect(first.ok).toBe(true);
    // 「请求体已读完→（异步/暂停后）提交」窗口内吊销：同上下文再提交→run() 边界拒绝、零提交。
    revokeDeviceInDb(h.db, a.deviceId, Date.now());
    h.server.invalidateDevice(a.deviceId);
    const second = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: 'r33-gate-commit-02', method: 'message.submit', params }) as { ok: boolean; error?: { code: string } };
    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe('DEVICE_REVOKED');
    const cnt = (h.db.prepare(`SELECT count(*) c FROM messages WHERE conversation_id='dm_a' AND body_json LIKE '%GATE-COMMIT-771%'`).get() as { c: number }).c;
    expect(cnt).toBe(1); // 第二次零提交（吊销≠停止——已提交的第一条不受影响）
    // 门禁拒绝也留审计（本次请求事实：设备+命令号+失败）。
    const audit = h.db.prepare('SELECT ok FROM remote_audit_log WHERE command_id = ?').all('r33-gate-commit-02') as Array<{ ok: number }>;
    expect(audit.length).toBe(1);
    expect(audit[0]!.ok).toBe(0);
    await h.close();
  }, 90_000);

  it('进程内自检（隔离验收模式）：全项通过+事实文件无凭据+自检设备清理', async () => {
    const prevScEnv33 = process.env.ZS_REMOTE_SELFCHECK;
    process.env.ZS_REMOTE_SELFCHECK = '1';
    try {
    const h = await boot();
    const report = await h.server.runSelfcheck();
    for (const item of report.items) {
      expect({ name: item.name, ok: item.ok }).toEqual({ name: item.name, ok: true });
    }
    expect(report.ok).toBe(true);
    expect(existsSync(report.file)).toBe(true);
    const raw = readFileSync(report.file, 'utf8');
    const parsed = JSON.parse(raw) as { items: Array<{ name: string; ok: boolean }>; pass: number; total: number };
    expect(parsed.pass).toBe(parsed.total);
    // 结果文件不含任何凭据明文（码/token/凭据）——只含结论事实。
    expect(raw).not.toMatch(/zc_[A-Za-z0-9_-]+/);
    expect(raw).not.toMatch(/"accessToken"/);
    // 自检设备已清理（吊销）。
    const leftover = h.db.prepare("SELECT count(*) c FROM remote_devices WHERE device_name = 'selfcheck-throwaway' AND revoked_at IS NULL").get() as { c: number };
    expect(leftover.c).toBe(0);
    // 审计事实：自检设备的恰一次命令留痕（replayed 0→1）。
    const audit = h.db.prepare("SELECT command_id, ok, replayed FROM remote_audit_log WHERE device_id IN (SELECT device_id FROM remote_devices WHERE device_name = 'selfcheck-throwaway') AND command_id LIKE 'selfcheck-once-%' ORDER BY id").all() as Array<{ command_id: string; ok: number; replayed: number }>;
    expect(audit.length).toBe(2);
    expect(audit[0]!.replayed).toBe(0);
    expect(audit[1]!.replayed).toBe(1);
    await h.close();
    } finally { if (prevScEnv33 == null) delete process.env.ZS_REMOTE_SELFCHECK; else process.env.ZS_REMOTE_SELFCHECK = prevScEnv33; }
  }, 90_000);
});

function seedEventP2(db: import('../../src/persistence/db.ts').ZhongshuoDatabase, eventId: string, conversationId: string | null, at = Date.now()): number {
  const r = db.prepare(`INSERT INTO domain_events (event_id, schema_version, project_id, conversation_id, kind, payload_json, created_at) VALUES (?,1,'p2',?,'message.submitted','{}',?)`).run(eventId, conversationId, at);
  return Number(r.lastInsertRowid);
}

function downloadZip(h: Harness, exportId: string, token: string): Promise<{ status: number; body: Buffer; json: any }> {
  return new Promise((resolve) => {
    https.get({ hostname: '127.0.0.1', port: h.port, path: `/export/${exportId}/download`, ca: CERT_PEM, servername: 'localhost', rejectUnauthorized: true, headers: { authorization: `Bearer ${token}`, origin: h.origin, host: h.host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        let json: any = null;
        try { json = JSON.parse(body.toString('utf8')); } catch { json = null; }
        resolve({ status: res.statusCode ?? 0, body, json });
      });
    }).on('error', () => resolve({ status: -1, body: Buffer.alloc(0), json: null }));
  });
}

void tls;
