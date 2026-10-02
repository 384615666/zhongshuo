/**
 * 迁移 039（第三十二轮一）：remote_audit_log——远程通道请求审计（设备来源独立留痕）。
 * 每次 HTTP /cmd 请求（含回执重放）记一行：设备/方法/commandId/结果/授权代次；**不进
 * domain_events**（不污染业务事件流/Activity 面）。业务作者恒为设备所代表的本机用户
 * （remoteAudit 只做来源审计，不影响幂等 scope/业务语义）。
 */
import type { Migration } from '../db.ts';

export const migration039: Migration = {
  id: 39,
  name: 'remote-audit-log',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS remote_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      method TEXT NOT NULL,
      command_id TEXT NOT NULL,
      ok INTEGER NOT NULL,
      replayed INTEGER NOT NULL DEFAULT 0,
      auth_epoch INTEGER NOT NULL DEFAULT 0
    );`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_remote_audit_at ON remote_audit_log(at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_remote_audit_device ON remote_audit_log(device_id, at)');
  },
};
