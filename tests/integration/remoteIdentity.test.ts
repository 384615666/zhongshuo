/**
 * DEV-25 远程证书身份（第三十六轮一）：本地 CA+服务证书两层——生成结构/复用核验/旧坏证书
 * 迁移反例/名称覆盖变化重签/业务数据不动。
 * 第三十六轮根因：旧 PowerShell 路径未传 Subject——实际证书 Subject/Issuer 均空+SAN 非
 * critical，普通 Chrome 无法完成信任入口（真实双机验收取证）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, X509Certificate, createPublicKey } from 'node:crypto';
import forge from 'node-forge';
import { ensureServerIdentity, sanSetFor } from '../../src/daemon/remoteIdentity.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-identity-'));
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* 句柄 */ } } });
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const ipBinary = (ip: string): string => ip.split('.').map((x) => Number(x) || 0).reduce((acc: number[], b) => { acc.push(b); return acc; }, []).length === 4
  ? String.fromCharCode(...(ip.split('.').map((x) => Number(x) || 0)))
  : String.fromCharCode(...new Array(16).fill(0).map((_, i) => (ip === '::1' && i === 15 ? 1 : 0)));

describe('证书两层：生成结构（Subject/Issuer/SAN critical/EKU/CA 边界）', () => {
  it('干净数据根首次生成：CA+服务证书结构合法，SAN 覆盖 LAN IP（CN 不代替 IP SAN）', () => {
    const dir = join(tmpRoot, 'fresh');
    const lan = ['192.168.1.100'];
    const r = ensureServerIdentity(dir, '0.0.0.0', lan);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    // 服务证书（identity.cer=DER）：Subject/Issuer 非空；SAN 覆盖 loopback+LAN IP；未过期。
    const der = readFileSync(join(dir, 'remote', 'identity.cer'));
    const x = new X509Certificate(der);
    expect(x.subject.length).toBeGreaterThan(0);
    expect(x.issuer.length).toBeGreaterThan(0);
    const sans = (x.subjectAltName ?? '').split(',').map((s) => s.trim());
    const sansJoined = sans.join(' ').toLowerCase();
    for (const need of ['localhost', '127.0.0.1', '192.168.1.100']) expect(sansJoined.includes(need)).toBe(true);
    expect(x.validToDate.getTime()).toBeGreaterThan(Date.now());
    // CA（ca-cert.pem）：CA:TRUE+keyCertSign；服务证书由 CA 签发且验签通过。
    const caPem = readFileSync(join(dir, 'remote', 'ca-cert.pem'), 'utf8');
    const caX = new X509Certificate(Buffer.from(caPem));
    const fc = forge.pki.certificateFromPem(caPem);
    const bc = fc.getExtension('basicConstraints') as { cA?: boolean } | null;
    expect(bc?.cA).toBe(true);
    const ku = fc.getExtension('keyUsage') as { keyCertSign?: boolean } | null;
    expect(ku?.keyCertSign).toBe(true);
    expect(x.issuer).toBe(caX.subject); // checkIssued 的 DER 序列化比较对 forge 等价 DN 有假阴性
    expect(x.verify(caX.publicKey)).toBe(true);
    // 服务证书 forge 侧：SAN critical + EKU serverAuth + KU。
    const svc = forge.pki.certificateFromPem(readFileSync(join(dir, 'remote', 'server-cert.pem'), 'utf8'));
    const sanExt = svc.getExtension('subjectAltName') as { altNames: Array<{ type: number; value: string }>; critical?: boolean } | null;
    expect(sanExt).not.toBeNull();
    expect(sanExt?.critical).toBe(true); // SAN critical（旧证书非 critical——空 DN 场景违反 RFC 5280）
    const eku = svc.getExtension('extKeyUsage') as { serverAuth?: boolean } | null;
    expect(eku?.serverAuth).toBe(true);
    const sku = svc.getExtension('keyUsage') as { digitalSignature?: boolean; keyEncipherment?: boolean } | null;
    expect(sku?.digitalSignature).toBe(true);
    expect(sku?.keyEncipherment).toBe(true);
    // 指纹=实际 DER 哈希；CA 指纹=CA DER 哈希。
    expect(r.identity.fingerprintSha256).toBe(sha(der));
    expect(r.identity.caFingerprintSha256).toBe(sha(Buffer.from(caPem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, ''), 'base64')));
    // ca.cer=CA DER（用户导入的信任根文件）。
    expect(existsSync(join(dir, 'remote', 'ca.cer'))).toBe(true);
    expect(r.identity.regenerated).toBeNull(); // 干净根首次生成不算「重生成」
  }, 60_000);

  it('复用：二次 ensure 同一指纹（不重生成）；SAN 需求扩大（新 LAN IP）→重签服务证书、CA 不变', () => {
    const dir = join(tmpRoot, 'reuse');
    const r1 = ensureServerIdentity(dir, '127.0.0.1', []);
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error('unreachable');
    const r2 = ensureServerIdentity(dir, '127.0.0.1', []);
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error('unreachable');
    expect(r2.identity.fingerprintSha256).toBe(r1.identity.fingerprintSha256);
    expect(r2.identity.caFingerprintSha256).toBe(r1.identity.caFingerprintSha256);
    expect(r2.identity.regenerated).toBeNull();
    // 新 LAN IP：服务证书重签（指纹变化）；CA（信任根）不变——客户端不必重新导入信任。
    const r3 = ensureServerIdentity(dir, '0.0.0.0', ['192.168.1.100']);
    expect(r3.ok).toBe(true);
    if (!r3.ok) throw new Error('unreachable');
    expect(r3.identity.caFingerprintSha256).toBe(r1.identity.caFingerprintSha256);
    expect(r3.identity.fingerprintSha256).not.toBe(r1.identity.fingerprintSha256);
    expect(r3.identity.regenerated?.scope).toBe('server');
    const x3 = new X509Certificate(readFileSync(join(dir, 'remote', 'identity.cer')));
    expect((x3.subjectAltName ?? '')).toContain('192.168.1.100');
  }, 60_000);
});

describe('旧坏证书复用反例（第三十六轮一）：不继续使用', () => {
  /** 伪造旧版现场：一层自签、Subject 空、SAN 覆盖当前需求、identity.json 声称良好。 */
  function plantLegacyState(dir: string, sans: string[]): void {
    const remote = join(dir, 'remote');
    mkdirSync(remote, { recursive: true });
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = 'ab12cd34ef56';
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600_000);
    cert.validity.notAfter = new Date(Date.now() + 3 * 365 * 24 * 3600_000);
    cert.setSubject([]); // 空 DN——旧版实际缺陷
    cert.setIssuer([]);
    cert.setExtensions([
      // 旧版 SAN 非 critical。
      { name: 'subjectAltName', altNames: sans.map((s) => s.startsWith('DNS:') ? { type: 2, value: s.slice(4) } : { type: 7, value: ipBinary(s.slice(3)) }), critical: false },
      { name: 'basicConstraints', cA: false },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const pem = forge.pki.certificateToPem(cert);
    const der = Buffer.from(pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, ''), 'base64');
    writeFileSync(join(remote, 'identity.cer'), der, 'binary');
    writeFileSync(join(remote, 'identity.pfx'), Buffer.from('legacy-pfx-bytes'));
    writeFileSync(join(remote, 'identity.json'), JSON.stringify({ thumbprint: sha(der), passphrase: 'x', sans, subject: '', notAfter: '' }), 'utf8');
    // 业务数据/用户文件标记——迁移不得动。
    writeFileSync(join(remote, 'keep-marker.txt'), 'business-data-keep', 'utf8');
  }

  it('旧证书（空 DN）即使 SAN 已覆盖当前需求→升级重生成，不再使用坏证书；旧件入诊断归档；业务数据保留', () => {
    const dir = join(tmpRoot, 'legacy');
    const needed = sanSetFor('0.0.0.0', ['192.168.1.100']);
    plantLegacyState(dir, needed);
    const oldDer = readFileSync(join(dir, 'remote', 'identity.cer'));
    const r = ensureServerIdentity(dir, '0.0.0.0', ['192.168.1.100']);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    // 新服务证书：Subject 非空+由本地 CA 签发；旧坏证书指纹不再使用。
    const newDer = readFileSync(join(dir, 'remote', 'identity.cer'));
    expect(sha(newDer)).not.toBe(sha(oldDer));
    const x = new X509Certificate(newDer);
    expect(x.subject.length).toBeGreaterThan(0);
    expect(x.issuer).toContain('Zhongshuo Remote Access CA');
    expect(r.identity.regenerated?.scope).toBe('both');
    // 旧件已移入诊断目录（identity.pfx/旧 identity.cer/旧记录），facts.json 记录旧证书事实。
    const diagRoot = join(dir, 'remote', 'old-cert-diagnostics');
    const diagDirs = readdirSync(diagRoot);
    expect(diagDirs.length).toBeGreaterThan(0);
    const facts = JSON.parse(readFileSync(join(diagRoot, diagDirs[0]!, 'facts.json'), 'utf8')) as { oldCert?: { subject?: string; fingerprint?: string } };
    expect(facts.oldCert?.subject ?? '').toBe(''); // 空 DN 在 Node X509 中为 undefined（JSON 序列化丢键）
    expect(facts.oldCert?.fingerprint).toBe(sha(oldDer));
    expect(existsSync(join(diagRoot, diagDirs[0]!, 'identity.pfx'))).toBe(true);
    // 业务数据与 server-data 其余内容保留（不要求删除 server-data）。
    expect(readFileSync(join(dir, 'remote', 'keep-marker.txt'), 'utf8')).toBe('business-data-keep');
  }, 60_000);

  it('identity.json 声称良好但实际 DER 与记录指纹不符→按实际 DER 判定重签', () => {
    const dir = join(tmpRoot, 'mismatch');
    const r1 = ensureServerIdentity(dir, '127.0.0.1', []);
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error('unreachable');
    // 篡改记录指纹（声称另一张好证书）——核验按实际文件：证书本身仍合法→复用不受虚假记录影响。
    const rec = JSON.parse(readFileSync(join(dir, 'remote', 'identity.json'), 'utf8')) as Record<string, unknown>;
    rec.serverFingerprint = '0'.repeat(64);
    writeFileSync(join(dir, 'remote', 'identity.json'), JSON.stringify(rec), 'utf8');
    const r2 = ensureServerIdentity(dir, '127.0.0.1', []);
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error('unreachable');
    expect(r2.identity.fingerprintSha256).toBe(r1.identity.fingerprintSha256); // 实际 DER 优先——不信记录
  }, 60_000);

  it('过期服务证书→重签（SAN 覆盖不变）', () => {
    const dir = join(tmpRoot, 'expired');
    const r1 = ensureServerIdentity(dir, '127.0.0.1', []);
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error('unreachable');
    // 用 CA 重签一张「昨天到期」的服务证书覆盖现有文件。
    const caCertPem = readFileSync(join(dir, 'remote', 'ca-cert.pem'), 'utf8');
    const caKeyPem = readFileSync(join(dir, 'remote', 'ca-key.pem'), 'utf8');
    const caCert = forge.pki.certificateFromPem(caCertPem);
    const caKey = forge.pki.privateKeyFromPem(caKeyPem);
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = 'ffeeddccbbaa';
    cert.validity.notBefore = new Date(Date.now() - 90 * 24 * 3600_000);
    cert.validity.notAfter = new Date(Date.now() - 24 * 3600_000); // 昨天到期
    cert.setSubject([{ name: 'commonName', value: 'zhongshuo-remote' }, { name: 'organizationName', value: 'Zhongshuo Local' }]);
    cert.setIssuer(caCert.subject.attributes);
    cert.setExtensions([
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, value: ipBinary('127.0.0.1') }, { type: 7, value: ipBinary('::1') }], critical: true },
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
    ]);
    cert.sign(caKey, forge.md.sha256.create());
    writeFileSync(join(dir, 'remote', 'server-cert.pem'), forge.pki.certificateToPem(cert), 'utf8');
    writeFileSync(join(dir, 'remote', 'server-key.pem'), forge.pki.privateKeyToPem(keys.privateKey), 'utf8');
    const r2 = ensureServerIdentity(dir, '127.0.0.1', []);
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error('unreachable');
    expect(r2.identity.regenerated?.scope).toBe('server');
    expect(r2.identity.regenerated?.reason).toContain('有效期');
    const x2 = new X509Certificate(readFileSync(join(dir, 'remote', 'identity.cer')));
    expect(x2.validToDate.getTime()).toBeGreaterThan(Date.now());
  }, 60_000);
});
