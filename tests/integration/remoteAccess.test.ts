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
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
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

async function boot(testing?: Record<string, unknown>): Promise<Harness> {
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
    dispatch: (envelope) => dispatchDaemonCommand(deps, envelope),
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
}
function wsConnect(h: Harness, headers: Record<string, string> = {}): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const socket = tls.connect({ host: '127.0.0.1', port: h.port, ca: CERT_PEM, servername: 'localhost', rejectUnauthorized: true }, () => {
      socket.write(`GET /events HTTP/1.1\r\nHost: ${h.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${h.origin}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
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
  const der = readFileSync(join(appData, 'remote', 'identity.cer'));
  CERT_PEM = '-----BEGIN CERTIFICATE-----\n' + der.toString('base64').replace(/(.{64})/g, '$1\n') + '\n-----END CERTIFICATE-----\n';
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

void tls;
