/**
 * 数据库打开与迁移（§12.5：升级先备份、事务迁移、记录 schemaVersion；失败拒绝启动写任务）。
 * daemon 独占业务写入；renderer/CLI 不得直接打开本库（开工契约 §9）。
 */
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MIGRATIONS } from './migrations/index.ts';

export type ZhongshuoDatabase = DatabaseType;

export interface OpenOptions {
  /** 迁移前备份目录；已有数据且存在待应用迁移时先写备份（§12.5）。 */
  backupDir?: string;
}

export function openDatabase(path: string, options: OpenOptions = {}): ZhongshuoDatabase {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  // §8.2：WAL + foreign_keys=ON；busy_timeout 容忍同机读者。
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, options);
  return db;
}

export interface Migration {
  id: number;
  name: string;
  up: (db: ZhongshuoDatabase) => void;
}

export interface MigrateResult {
  fromVersion: number;
  toVersion: number;
  applied: number[];
}

/**
 * 迁移运行器：user_version 为当前 schema 版本；每条迁移与其审计记录同事务提交。
 * 已有数据（fromVersion>0）且有待应用迁移时，先执行一致性备份（SQLite backup API，
 * 非"复制主文件"，§12.5）。任一迁移失败：该事务回滚、user_version 不变、函数抛错——
 * 调用方（daemon 启动）据此拒绝启动写任务并保留备份。
 */
export function migrate(
  db: ZhongshuoDatabase,
  options: OpenOptions = {},
  migrations: readonly Migration[] = MIGRATIONS,
): MigrateResult {
  const fromVersion = db.pragma('user_version', { simple: true }) as number;
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    checksum TEXT NOT NULL
  )`);

  const pending = migrations.filter((m) => m.id > fromVersion);
  if (pending.length === 0) {
    return { fromVersion, toVersion: fromVersion, applied: [] };
  }

  if (fromVersion > 0 && options.backupDir != null) {
    const backupPath = join(options.backupDir, `state-pre-v${fromVersion}-${Date.now()}.sqlite`);
    mkdirSync(dirname(backupPath), { recursive: true });
    // VACUUM INTO：同步一致性快照（§12.5「SQLite 备份接口或等价一致性备份方案」；
    // better-sqlite3 的 db.backup 是异步 Promise，不适合同步迁移器；不能在事务内执行）。
    const quoted = backupPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${quoted}'`);
  }

  for (const migration of pending) {
    const apply = db.transaction((m: Migration) => {
      m.up(db);
      const checksum = checksumOf(m);
      db.prepare(
        'INSERT INTO schema_migrations (id, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
      ).run(m.id, m.name, Date.now(), checksum);
      db.pragma(`user_version = ${m.id}`);
    });
    // 默认 BEGIN（deferred）即可：迁移由 daemon 单写者执行。
    apply.immediate(migration);
  }
  const toVersion = db.pragma('user_version', { simple: true }) as number;
  return { fromVersion, toVersion, applied: pending.map((m) => m.id) };
}

/** 迁移内容指纹：实现源码文本摘要，防止同名迁移被静默改写（版本不可变）。 */
function checksumOf(migration: Migration): string {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- 仅取源码文本做指纹
  const source = migration.up.toString();
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}-${source.length}`;
}
