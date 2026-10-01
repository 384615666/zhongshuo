/**
 * 迁移 038（第三十一轮三 DEV-25）：远程访问（本机/LAN 浏览器）。
 * - remote_devices：配对设备（长期凭据只存加盐摘要；吊销 revoked_at——吊销撤销凭据/全部
 *   token/票据/活跃连接由服务端内存承载，表存持久事实）；
 * - remote_pairing_codes：配对码（随机 8 位默认；加盐摘要、5 分钟有效、一次消费、失败计数
 *   ——同 pairingId 连续 5 次失效）；
 * - remote_config：单行服务配置（默认 disabled + 127.0.0.1——LAN 需用户显式启用并配置地址）。
 */
import type { Migration } from '../db.ts';

export const migration038: Migration = {
  id: 38,
  name: 'remote-access',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS remote_devices (
      device_id TEXT PRIMARY KEY,
      device_name TEXT NOT NULL,
      credential_salt TEXT NOT NULL,
      credential_digest TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      revoked_at INTEGER
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS remote_pairing_codes (
      pairing_id TEXT PRIMARY KEY,
      code_salt TEXT NOT NULL,
      code_digest TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      fail_count INTEGER NOT NULL DEFAULT 0
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS remote_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      listen_host TEXT NOT NULL DEFAULT '127.0.0.1',
      port INTEGER NOT NULL DEFAULT 0,
      allow_lan INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS remote_pairing_attempts (
      ip TEXT NOT NULL,
      at INTEGER NOT NULL
    );`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_remote_pairing_attempts_at ON remote_pairing_attempts(at)');
    db.prepare('INSERT OR IGNORE INTO remote_config (id, enabled, listen_host, port, allow_lan, updated_at) VALUES (1, 0, \'127.0.0.1\', 0, 0, 0)').run();
  },
};
