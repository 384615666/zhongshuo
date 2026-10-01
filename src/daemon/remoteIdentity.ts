/**
 * 远程服务身份（DEV-25 第三十一轮三）：自签 TLS 证书的生成与复用。
 * - 生成：Windows PowerShell New-SelfSignedCertificate（SSLServerAuthentication，SAN 含
 *   localhost/127.0.0.1/[::1]/启用时的 LAN 地址）→ 导出 PFX（随机口令）+ DER 证书；
 * - 复用：appData/remote/identity.json（thumbprint/口令/SAN 集）+ identity.pfx 存在且 SAN
 *   覆盖当前监听地址即复用，不重复生成；覆盖变化→重新生成新证书（指纹随之变化——用户须
 *   重新核对信任，R11 §2「证书更换必须重新核对」）；
 * - 私钥与口令只留服务端 appData/remote/（不复制给客户端）；SHA-256 指纹=DER 证书字节哈希
 *   （用户在本机可信 UI 核对、浏览器端对证书完成信任）；
 * - 非 Windows / PowerShell 不可用=明确失败（不降级 HTTP——R11 强制 HTTPS/WSS）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

export interface RemoteServerIdentity {
  pfx: Buffer;
  passphrase: string;
  /** DER 证书 SHA-256 指纹（hex，冒号分组展示用原样小写）。 */
  fingerprintSha256: string;
  subject: string;
  notAfter: string;
  sans: string[];
}

interface IdentityRecord {
  thumbprint: string;
  passphrase: string;
  sans: string[];
  subject: string;
  notAfter: string;
}

/** 需要覆盖的 SAN 集（loopback 基础 + LAN 地址）。 */
export function sanSetFor(listenHost: string, lanIps: string[]): string[] {
  const base = new Set<string>(['DNS:localhost', 'IP:127.0.0.1', 'IP:::1']);
  const host = listenHost.trim();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && host !== '127.0.0.1') base.add(`IP:${host}`);
  else if (host.includes(':')) base.add(`IP:${host}`);
  else if (host !== '' && host !== 'localhost' && host !== '0.0.0.0') base.add(`DNS:${host}`);
  for (const ip of lanIps) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== '127.0.0.1') base.add(`IP:${ip}`);
    else if (ip.includes(':')) base.add(`IP:${ip}`);
  }
  return [...base];
}

function runPowerShell(script: string): { ok: true; stdout: string } | { ok: false; error: string } {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 60_000, encoding: 'utf8' });
  if (r.error != null) return { ok: false, error: `powershell 启动失败：${r.error.message}` };
  if (r.status !== 0) return { ok: false, error: `powershell 退出 ${r.status}：${(r.stderr ?? '').slice(0, 300)}` };
  return { ok: true, stdout: r.stdout ?? '' };
}

/**
 * 确保 TLS 身份可用：已存在且 SAN 覆盖→复用；否则生成。返回失败时明确报错（调用方拒绝
 * 启动远程服务——不降级）。
 */
export function ensureServerIdentity(appDataDir: string, listenHost: string, lanIps: string[]): { ok: true; identity: RemoteServerIdentity } | { ok: false; error: string } {
  const dir = join(appDataDir, 'remote');
  const recordPath = join(dir, 'identity.json');
  const pfxPath = join(dir, 'identity.pfx');
  const derPath = join(dir, 'identity.cer');
  const needed = sanSetFor(listenHost, lanIps);
  if (existsSync(recordPath) && existsSync(pfxPath) && existsSync(derPath)) {
    try {
      const rec = JSON.parse(readFileSync(recordPath, 'utf8')) as IdentityRecord;
      const covered = needed.every((s) => rec.sans.includes(s));
      if (covered) {
        const der = readFileSync(derPath);
        if (createHash('sha256').update(der).digest('hex').toLowerCase() === rec.thumbprint.toLowerCase()) {
          return {
            ok: true,
            identity: {
              pfx: readFileSync(pfxPath),
              passphrase: rec.passphrase,
              fingerprintSha256: rec.thumbprint.toLowerCase(),
              subject: rec.subject,
              notAfter: rec.notAfter,
              sans: rec.sans,
            },
          };
        }
      }
    } catch {
      // 记录损坏→重新生成（下面路径）。
    }
  }
  mkdirSync(dir, { recursive: true });
  const passphrase = randomBytes(24).toString('hex');
  const sanText = needed.map((s) => `'${s}'`).join(',');
  const ps = [
    '$ErrorActionPreference = "Stop"',
    `$dns = @(); $ips = @()`,
    `foreach ($s in @(${needed.map((x) => `"${x}"`).join(',')})) { if ($s.StartsWith("DNS:")) { $dns += $s.Substring(4) } else { $ips += $s.Substring(3) } }`,
    `$merged = "2.5.29.17={text}" + ((@($dns | ForEach-Object { "DNS=" + $_ }) + @($ips | ForEach-Object { "IPAddress=" + $_ })) -join "&")`,
    // 全部 SAN（含 localhost DNS）统一走 TextExtension——-DnsName 与 SAN 扩展互斥。
    `$cert = New-SelfSignedCertificate -Type SSLServerAuthentication -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(3) -CertStoreLocation Cert:\\CurrentUser\\My -TextExtension @($merged)`,
    `$pass = ConvertTo-SecureString -String "${passphrase}" -Force -AsPlainText`,
    `$bytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $pass)`,
    `[IO.File]::WriteAllBytes('${pfxPath.replaceAll('\\', '\\\\')}', $bytes)`,
    `$derBytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)`,
    `[IO.File]::WriteAllBytes('${derPath.replaceAll('\\', '\\\\')}', $derBytes)`,
    `$sha = [System.Security.Cryptography.SHA256]::Create()`,
    `$hash = ($sha.ComputeHash($derBytes) | ForEach-Object { $_.ToString("x2") }) -join ""`,
    `Write-Output ($hash + "|" + $cert.Subject + "|" + $cert.NotAfter.ToString("o"))`,
  ].join('\n');
  const ran = runPowerShell(ps);
  if (!ran.ok) return { ok: false, error: `证书生成失败（${ran.error}）——远程服务拒绝启动，不降级 HTTP` };
  const [thumbprint, subject, notAfter] = ran.stdout.trim().split('|');
  if (thumbprint == null || !/^[0-9a-f]{64}$/.test(thumbprint.trim())) {
    return { ok: false, error: `证书指纹解析失败（输出异常）——远程服务拒绝启动` };
  }
  const record: IdentityRecord = { thumbprint: thumbprint.trim(), passphrase, sans: needed, subject: subject ?? '', notAfter: notAfter ?? '' };
  writeFileSync(recordPath, JSON.stringify(record, null, 2), 'utf8');
  return {
    ok: true,
    identity: {
      pfx: readFileSync(pfxPath),
      passphrase,
      fingerprintSha256: thumbprint.trim(),
      subject: record.subject,
      notAfter: record.notAfter,
      sans: needed,
    },
  };
}
