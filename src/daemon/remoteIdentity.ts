/**
 * 远程服务身份（DEV-25 第三十一轮三建；第三十六轮一重写——本地 CA+服务证书两层）。
 *
 * 第三十六轮根因与修法：
 * - 旧实现 PowerShell New-SelfSignedCertificate 未传 -Subject——实际证书 **Subject/Issuer 均为空**、
 *   SAN 非 critical（真实双机验收取证：普通 Chrome 无法完成证书信任入口）。空 DN+非 critical
 *   SAN 不符合 RFC 5280（subject 为空时 SAN 必须 critical），Chrome 结构校验即拒。
 * - 重写为 **node-forge 纯 JS 两层**（跨平台一致，测试环境同路径）：
 *   · 本地 CA（CN=Zhongshuo Remote Access CA）：BasicConstraints CA:TRUE（critical）+
 *     KeyUsage keyCertSign/cRLSign（critical），10 年；**CA 私钥只留服务机** appData/remote/；
 *   · 服务证书（CN=zhongshuo-remote）：由 CA 签发，Subject/Issuer 明确；SAN **critical** 且覆盖
 *     127.0.0.1/localhost/[::1]/实际 LAN IP（**CN 不能代替 IP SAN**）；EKU serverAuth；KeyUsage
 *     digitalSignature+keyEncipherment；3 年。IP 变化只重签服务证书——**CA（用户信任根）不变**，
 *     客户端不必每次重新导入信任。
 * - **复用按实际 DER/PFX/PEM 核验**（不只信 identity.json）：Node X509Certificate 解析实际证书
 *   ——空 DN/过期/名称不覆盖/签名非本 CA 签发/证书与私钥不配/文件与记录指纹不符→**按明确规则
 *   重签/重生成**；旧证书与旧文件移入 remote/old-cert-diagnostics/<ts>/ 留诊断证据——**业务数据
 *   与 RESULTS 不动**（不要求删 server-data）。
 * - 用户核对/导入的是 **CA 证书**（remote/ca.cer——Windows「受信任的根」/Android 用户凭据）；
 *   页面呈现两枚指纹：服务证书指纹（页面所见）+CA 指纹（信任根）。系统信任由用户核对具体
 *   证书后完成——程序不自动安装信任根。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { createHash, createPublicKey, randomBytes, X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import forge from 'node-forge';

export interface RemoteServerIdentity {
  /** 服务证书私钥（PEM）+证书链（服务证书→CA）——https.createServer({key, cert})。 */
  keyPem: string;
  certChainPem: string;
  /** CA 证书 PEM（客户端可核对/导入的信任根）。 */
  caCertPem: string;
  /** 服务证书 DER SHA-256 指纹（hex——页面/拦截页所见证书的逐位核对值）。 */
  fingerprintSha256: string;
  /** CA 证书 DER SHA-256 指纹（hex——用户导入信任根时的核对值）。 */
  caFingerprintSha256: string;
  subject: string;
  issuer: string;
  notAfter: string;
  sans: string[];
  /** 本次调用是否发生重生成/重签（UI 据此提示「证书已更新——须重新核对信任」）。 */
  regenerated: null | { scope: 'ca' | 'server' | 'both'; reason: string; diagnosticsPath: string | null };
}

interface IdentityRecord {
  version: 2;
  caFingerprint: string;
  serverFingerprint: string;
  sans: string[];
  serverSubject: string;
  serverNotAfter: string;
  regenerated?: { scope: string; reason: string; at: number };
}

const CA_YEARS = 10;
const SERVER_YEARS = 3;

/** 需要覆盖的 SAN 集（loopback 基础 + LAN 地址——CN 不能代替 IP SAN）。 */
export function sanSetFor(listenHost: string, lanIps: string[]): string[] {
  const base = new Set<string>(['DNS:localhost', 'IP:127.0.0.1', 'IP:::1']);
  const host = listenHost.trim();
  // 通配监听（0.0.0.0/::）不是可连接名称——不进 SAN（实际访问名来自 LAN 地址/回环）。
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && host !== '127.0.0.1' && host !== '0.0.0.0') base.add(`IP:${host}`);
  else if (host.includes(':') && host !== '::' && host !== '::1') base.add(`IP:${host}`);
  else if (host !== '' && host !== 'localhost' && host !== '0.0.0.0' && host !== '127.0.0.1' && !host.includes(':')) base.add(`DNS:${host}`);
  for (const ip of lanIps) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== '127.0.0.1') base.add(`IP:${ip}`);
    else if (ip.includes(':') && ip !== '::1') base.add(`IP:${ip}`);
  }
  return [...base];
}

const sha256Hex = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

function pemOfDer(der: Buffer): string {
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').trim()}\n-----END CERTIFICATE-----\n`;
}
function derOfPem(pem: string): Buffer {
  const b64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  return Buffer.from(b64, 'base64');
}

/** IPv6 文本规范化为全展开形态（::1 与 0:0:…:0:1 视为同名——node X509 打印为全展开）。 */
function canonicalIp(ip: string): string {
  if (!ip.includes(':')) return ip;
  const parts = ip.split('::');
  const head = parts[0] != null && parts[0] !== '' ? parts[0].split(':').filter((x) => x !== '') : [];
  const tail = parts.length > 1 && parts[1] != null && parts[1] !== '' ? parts[1].split(':').filter((x) => x !== '') : [];
  const groups = [...head, ...new Array(8 - head.length - tail.length).fill('0'), ...tail].slice(0, 8);
  return groups.map((g) => (parseInt(g, 16) || 0).toString(16)).join(':');
}

/** X509Certificate.subjectAltName 形如 "DNS:localhost, IP:127.0.0.1"——归一为 sanSetFor 口径。 */
function sansOfCert(cert: X509Certificate): string[] {
  const raw = cert.subjectAltName ?? '';
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0).map((s) => {
    const low = s.toLowerCase();
    if (low.startsWith('dns:')) return `DNS:${s.slice(4)}`;
    if (low.startsWith('ip address:')) return `IP:${canonicalIp(s.slice('ip address:'.length))}`; // Node X509Certificate 形态（IPv6 为全展开）
    if (low.startsWith('ip:')) return `IP:${canonicalIp(s.slice(3))}`;
    return `IP:${canonicalIp(s)}`; // 无前缀形态
  });
}

function datesFromForge(forgeCert: forge.pki.Certificate): { notBefore: Date; notAfter: Date } {
  return { notBefore: forgeCert.validity.notBefore, notAfter: forgeCert.validity.notAfter };
}

function genCa(): { certPem: string; keyPem: string; fingerprint: string } {
  const keys = forge.pki.rsa.generateKeyPair(3072);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomBytes(16).toString('hex');
  const { notBefore, notAfter } = validity(CA_YEARS);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;
  const attrs = [
    { name: 'commonName', value: 'Zhongshuo Remote Access CA', shortName: 'CN' },
    { name: 'organizationName', value: 'Zhongshuo Local', shortName: 'O' },
    { shortName: 'OU', value: 'remote-access' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  return { certPem, keyPem: forge.pki.privateKeyToPem(keys.privateKey), fingerprint: sha256Hex(derOfPem(certPem)) };
}

/** IP 转 forge altName type 7 所需的原始字节串（点分/IPv6 文本→二进制串——直接传文本会编出畸形 SAN）。 */
function ipToForgeBinary(ip: string): string {
  if (ip.includes(':')) {
    // IPv6（含 :: 缩写）——展开为 16 字节。
    const parts = ip.split('::');
    const head = parts[0] != null && parts[0] !== '' ? parts[0].split(':').filter((x) => x !== '') : [];
    const tail = parts.length > 1 && parts[1] !== '' ? (parts[1] ?? '').split(':').filter((x) => x !== '') : [];
    const blanks = new Array(8 - head.length - tail.length).fill('0');
    const groups = [...head, ...blanks, ...tail];
    let out = '';
    for (const g of groups) {
      const v = parseInt(g.length > 4 ? g.slice(0, 4) : g, 16) || 0;
      out += String.fromCharCode((v >> 8) & 0xff, v & 0xff);
    }
    return out;
  }
  const bytes = ip.split('.').map((x) => Number(x) || 0);
  return String.fromCharCode(...(bytes.length === 4 ? bytes : [127, 0, 0, 1]));
}

function validity(years: number): { notBefore: Date; notAfter: Date } {
  const notBefore = new Date(Date.now() - 24 * 3600_000); // 起 1 天前（时钟偏移余量）
  const notAfter = new Date(Date.now() + years * 365 * 24 * 3600_000);
  return { notBefore, notAfter };
}

function genServerCert(caCertPem: string, caKeyPem: string, sans: string[]): { certPem: string; keyPem: string; fingerprint: string } {
  const caCert = forge.pki.certificateFromPem(caCertPem);
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomBytes(16).toString('hex');
  const { notBefore, notAfter } = validity(SERVER_YEARS);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;
  const attrs = [
    { name: 'commonName', value: 'zhongshuo-remote', shortName: 'CN' },
    { name: 'organizationName', value: 'Zhongshuo Local', shortName: 'O' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(caCert.subject.attributes);
  const altNames: Array<{ type: number; value: string }> = [];
  for (const s of sans) {
    if (s.startsWith('DNS:')) altNames.push({ type: 2, value: s.slice(4) });
    else if (s.startsWith('IP:')) altNames.push({ type: 7, value: ipToForgeBinary(s.slice(3)) });
  }
  cert.setExtensions([
    // SAN **critical**（subject 非空时也标——明确名称边界；空 DN 场景按 RFC 必须 critical）。
    { name: 'subjectAltName', altNames, critical: true },
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectKeyIdentifier' },
    // 不设 authorityKeyIdentifier：forge 会误写为自身 SKI（≠CA 的 SKI）——openssl 按 AKI/SKI
    // 严格配链即「unable to get local issuer certificate」。RFC 允许缺省；链验证按 DN+签名。
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  return { certPem, keyPem: forge.pki.privateKeyToPem(keys.privateKey), fingerprint: sha256Hex(derOfPem(certPem)) };
}

/** 实际文件核验：CA 证书可解析、未过期、isCA（BasicConstraints）且与私钥配对。 */
function caLooksGood(caCertPem: string, caKeyPem: string): boolean {
  try {
    const pem = caCertPem.trim();
    if (!pem.startsWith('-----BEGIN CERTIFICATE-----')) return false;
    const fc = forge.pki.certificateFromPem(pem);
    const bc = fc.getExtension('basicConstraints');
    if (bc == null || !(bc as { cA?: boolean }).cA) return false;
    if (fc.validity.notAfter.getTime() < Date.now() + 30 * 24 * 3600_000) return false; // 剩余<30 天即换
    // CA 证书与私钥配对：node:crypto 导出双方 SPKI DER 比较。
    const keyPubDer = createPublicKey(caKeyPem).export({ type: 'spki', format: 'der' });
    const certPubDer = createPublicKey(forge.pki.publicKeyToPem(fc.publicKey)).export({ type: 'spki', format: 'der' });
    return keyPubDer.equals(certPubDer);
  } catch {
    return false;
  }
}

interface ServerCertVerdict {
  ok: boolean;
  reason: string;
  subject: string;
  issuer: string;
  sans: string[];
  notAfter: string;
  fingerprint: string;
}

/** 实际服务证书核验（DER 文件 + 私钥配对 + CA 签名 + 结构/名称/有效期——不信 identity.json）。 */
function verifyServerCert(serverCertDer: Buffer, serverKeyPem: string, caCertPem: string, neededSansRaw: string[]): ServerCertVerdict {
  const neededSans = neededSansRaw.map((s) => (s.startsWith('IP:') ? `IP:${canonicalIp(s.slice(3))}` : s));
  const fail = (reason: string): ServerCertVerdict => ({ ok: false, reason, subject: '', issuer: '', sans: [], notAfter: '', fingerprint: '' });
  try {
    const x = new X509Certificate(serverCertDer);
    const fingerprint = sha256Hex(serverCertDer);
    if (x.subject.trim() === '' || x.issuer.trim() === '') return { ...fail('空 Subject/Issuer（旧版缺陷证书）'), subject: x.subject, issuer: x.issuer, fingerprint };
    const sans = sansOfCert(x);
    const missing = neededSans.filter((s) => !sans.includes(s));
    if (missing.length > 0) return { ...fail(`SAN 不覆盖：${missing.join(',')}`), subject: x.subject, issuer: x.issuer, sans, notAfter: x.validToDate.toISOString(), fingerprint };
    if (x.validToDate.getTime() < Date.now() + 7 * 24 * 3600_000) return { ...fail('有效期不足 7 天'), subject: x.subject, issuer: x.issuer, sans, notAfter: x.validToDate.toISOString(), fingerprint };
    const caX = new X509Certificate(derOfPem(caCertPem));
    // 签发者核对：DN 字符串一致（checkIssued 的 DER 序列化比较对 forge 生成的等价 DN 有假阴性）
    // + **CA 公钥验签**（真伪由签名承载——见下）。
    if (x.issuer !== caX.subject) return { ...fail(`签发者不符（issuer=${x.issuer.slice(0, 60)}…）`), subject: x.subject, issuer: x.issuer, sans, notAfter: x.validToDate.toISOString(), fingerprint };
    // 签名真伪核验（checkIssued 只看名称——用 CA 公钥验签）。
    if (!x.verify(caX.publicKey)) return { ...fail('CA 签名验签失败'), subject: x.subject, issuer: x.issuer, sans, notAfter: x.validToDate.toISOString(), fingerprint };
    // 证书与私钥配对（公钥一致）。
    const keyObj = createPublicKey(serverKeyPem);
    const keyPubDer = keyObj.export({ type: 'spki', format: 'der' });
    const certPubDer = x.publicKey.export({ type: 'spki', format: 'der' });
    if (!keyPubDer.equals(certPubDer)) return { ...fail('证书与私钥不配对'), subject: x.subject, issuer: x.issuer, sans, notAfter: x.validToDate.toISOString(), fingerprint };
    return { ok: true, reason: '', subject: x.subject, issuer: x.issuer, sans, notAfter: x.validToDate.toISOString(), fingerprint };
  } catch (error) {
    return fail(`解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 旧身份文件归档（诊断证据保留；业务数据/RESULTS 不动）。 */
function archiveLegacyIdentity(dir: string, facts: Record<string, unknown>): string | null {
  const legacyNames = ['identity.pfx', 'identity.cer', 'identity.json'];
  const present = legacyNames.filter((n) => existsSync(join(dir, n)));
  const alsoLegacy = ['server-cert.pem', 'server-key.pem'].filter((n) => existsSync(join(dir, n)));
  if (present.length === 0 && alsoLegacy.length === 0) return null;
  const stamp = new Date().toISOString().replace(/[:T]/g, '').slice(0, 14);
  const diag = join(dir, 'old-cert-diagnostics', `${stamp}-${randomBytes(2).toString('hex')}`);
  mkdirSync(diag, { recursive: true });
  writeFileSync(join(diag, 'facts.json'), JSON.stringify({ at: new Date().toISOString(), ...facts }, null, 2), 'utf8');
  for (const n of [...present, ...alsoLegacy]) {
    try { renameSync(join(dir, n), join(diag, n)); } catch { /* 尽力——诊断目录留已归档项 */ }
  }
  return diag;
}

function loadPem(path: string): string | null {
  try {
    const pem = readFileSync(path, 'utf8').trim();
    return pem.startsWith('-----BEGIN') ? pem : null;
  } catch {
    return null;
  }
}

/**
 * 确保 TLS 身份可用（两层）：CA 复用（过期/损坏→换 CA 并重签服务证书）；服务证书按实际核验
 * 失败原因重签。旧文件移入 old-cert-diagnostics 留证据——server-data 其余内容不动。
 */
export function ensureServerIdentity(appDataDir: string, listenHost: string, lanIps: string[]): { ok: true; identity: RemoteServerIdentity } | { ok: false; error: string } {
  const dir = join(appDataDir, 'remote');
  mkdirSync(dir, { recursive: true });
  const needed = sanSetFor(listenHost, lanIps);
  const caCertPath = join(dir, 'ca-cert.pem');
  const caKeyPath = join(dir, 'ca-key.pem');
  const caDerPath = join(dir, 'ca.cer');
  const serverCertPath = join(dir, 'server-cert.pem');
  const serverKeyPath = join(dir, 'server-key.pem');
  const serverDerPath = join(dir, 'identity.cer'); // 保留文件名：页面所见服务证书（DER）——SPKI 钉选/自检兼容
  const recordPath = join(dir, 'identity.json');

  let regenerated: RemoteServerIdentity['regenerated'] = null;
  const legacyFacts: Record<string, unknown> = { listenHost, lanIps, neededSans: needed };
  // ① 旧版（v1 一层 PowerShell 证书）文件在→先诊断归档（无论声称如何——空 DN 结构性缺陷）。
  let hadLegacy = false;
  try {
    if (existsSync(recordPath)) {
      const rec = JSON.parse(readFileSync(recordPath, 'utf8')) as { version?: number };
      if (rec.version !== 2) hadLegacy = true;
    }
    if (!hadLegacy && (existsSync(join(dir, 'identity.pfx')))) hadLegacy = true;
    if (hadLegacy) {
      try {
        const oldDer = readFileSync(join(dir, 'identity.cer'));
        const old = new X509Certificate(oldDer);
        legacyFacts.oldCert = { subject: old.subject, issuer: old.issuer, sans: old.subjectAltName ?? '', validTo: old.validToDate.toISOString(), fingerprint: sha256Hex(oldDer) };
      } catch (error) {
        legacyFacts.oldCert = { parseError: error instanceof Error ? error.message : String(error) };
      }
      const diag = archiveLegacyIdentity(dir, legacyFacts);
      regenerated = { scope: 'both', reason: '旧版一层证书（Subject/Issuer 空——结构缺陷）迁移为本地 CA+服务证书', diagnosticsPath: diag };
    }
  } catch { /* 诊断尽力 */ }

  // ② CA：实际核验（可解析/CA:TRUE/未临近过期/私钥配对）——失败即换（并清服务证书强制重签）。
  let caCertPem = loadPem(caCertPath);
  let caKeyPem = loadPem(caKeyPath);
  let caFingerprint: string;
  const hadCaFiles = caCertPem != null || caKeyPem != null;
  if (caCertPem != null && caKeyPem != null && caLooksGood(caCertPem, caKeyPem)) {
    caFingerprint = sha256Hex(derOfPem(caCertPem));
  } else {
    // 干净首代（此前无 CA 文件）不算「重生成」；替换既有坏/过期 CA 才标记。
    const diag = hadCaFiles ? archiveLegacyIdentity(dir, { reason: 'CA 证书核验失败（过期/损坏/与私钥不配）——重新生成', previousCaFingerprint: caCertPem != null ? sha256Hex(derOfPem(caCertPem)) : null }) : null;
    const ca = genCa();
    caCertPem = ca.certPem;
    caKeyPem = ca.keyPem;
    caFingerprint = ca.fingerprint;
    writeFileSync(caCertPath, caCertPem, 'utf8');
    writeFileSync(caKeyPath, caKeyPem, 'utf8');
    writeFileSync(caDerPath, derOfPem(caCertPem), 'binary');
    if (hadCaFiles) regenerated = regenerated == null ? { scope: 'ca', reason: 'CA 核验失败——重新生成（服务证书随之重签）', diagnosticsPath: diag } : { ...regenerated, scope: 'both' };
  }

  // ③ 服务证书：实际核验（空 DN/SAN 覆盖/有效期/CA 签发+验签/私钥配对）——失败重签。
  let serverCertPem = loadPem(serverCertPath);
  let serverKeyPem = loadPem(serverKeyPath);
  let verdict: ServerCertVerdict;
  if (serverCertPem != null && serverKeyPem != null) {
    verdict = verifyServerCert(derOfPem(serverCertPem), serverKeyPem, caCertPem, needed);
  } else {
    verdict = { ok: false, reason: '服务证书/私钥文件缺失', subject: '', issuer: '', sans: [], notAfter: '', fingerprint: '' };
  }
  if (!verdict.ok) {
    if (regenerated == null && (serverCertPem != null || existsSync(serverDerPath))) {
      const diag = archiveLegacyIdentity(dir, { reason: `服务证书核验失败：${verdict.reason}`, previous: { subject: verdict.subject, issuer: verdict.issuer, sans: verdict.sans, fingerprint: verdict.fingerprint } });
      regenerated = { scope: 'server', reason: verdict.reason, diagnosticsPath: diag };
    }
    const sv = genServerCert(caCertPem, caKeyPem, needed);
    serverCertPem = sv.certPem;
    serverKeyPem = sv.keyPem;
    writeFileSync(serverCertPath, serverCertPem, 'utf8');
    writeFileSync(serverKeyPath, serverKeyPem, 'utf8');
    const der = derOfPem(serverCertPem);
    writeFileSync(serverDerPath, der, 'binary');
    verdict = verifyServerCert(der, serverKeyPem, caCertPem, needed);
    if (!verdict.ok) return { ok: false, error: `服务证书重签后核验仍失败：${verdict.reason}` };
  }
  if (serverCertPem == null || serverKeyPem == null || caCertPem == null) return { ok: false, error: '证书文件缺失（不可达）' };

  const record: IdentityRecord = {
    version: 2,
    caFingerprint,
    serverFingerprint: verdict.fingerprint,
    sans: needed,
    serverSubject: verdict.subject,
    serverNotAfter: verdict.notAfter,
    ...(regenerated != null ? { regenerated: { scope: regenerated.scope, reason: regenerated.reason, at: Date.now() } } : {}),
  };
  writeFileSync(recordPath, JSON.stringify(record, null, 2), 'utf8');
  return {
    ok: true,
    identity: {
      keyPem: serverKeyPem,
      certChainPem: `${serverCertPem}\n${caCertPem}`,
      caCertPem,
      fingerprintSha256: verdict.fingerprint,
      caFingerprintSha256: caFingerprint,
      subject: verdict.subject,
      issuer: verdict.issuer,
      notAfter: verdict.notAfter,
      sans: verdict.sans,
      regenerated,
    },
  };
}

/** 最近一次身份诊断归档目录（设置面/自检展示用；无则 null）。 */
export function latestCertDiagnostics(appDataDir: string): string | null {
  const root = join(appDataDir, 'remote', 'old-cert-diagnostics');
  try {
    const entries = readdirSync(root).filter((n) => !n.startsWith('.')).sort();
    return entries.length > 0 ? join(root, entries[entries.length - 1]!) : null;
  } catch {
    return null;
  }
}
