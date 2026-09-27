/**
 * 本地连接凭据（修复轮 5）：daemon 启动生成随机 token，写 appData（0600 权限语义：
 * Windows 受管目录继承 + 显式 ACL 由 DEV-20 完整加固，此处至少不回显、不进日志）。
 * UI 进程（Electron main）从同机文件读取后经握手帧提交。
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LocalCredential {
  token: string;
  credentialPath: string;
}

export function ensureLocalCredential(appDataDir: string): LocalCredential {
  const credentialPath = join(appDataDir, 'local.token');
  if (existsSync(credentialPath)) {
    try {
      const token = readFileSync(credentialPath, 'utf8').trim();
      if (token.length >= 32) return { token, credentialPath };
    } catch {
      // 读失败按损坏处理：重生成。
    }
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(credentialPath, token, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(credentialPath, 0o600);
  } catch {
    // Windows chmod 非等价隔离（§2.1 受管文件口径）；DEV-20 完整加固。
  }
  return { token, credentialPath };
}
