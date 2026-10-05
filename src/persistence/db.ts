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
  try {
    // §8.2：WAL + foreign_keys=ON；busy_timeout 容忍同机读者。
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrate(db, options);
    return db;
  } catch (err) {
    // r60（review-r59 §2）：任何打开/迁移失败（含更高版本拒绝、备份失败）都关闭句柄——
    // 不留半开 WAL/锁占用；调用方（daemon entry）再释放单实例锁后拒绝启动。
    try { db.close(); } catch { /* 关闭失败不掩盖原始错误 */ }
    throw err;
  }
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
 * 入口先核版本范围：高于本程序支持的版本在**任何写入之前**拒绝（r60，review-r59 §2）。
 * 已有数据（fromVersion>0）且存在待应用迁移且传入 backupDir 时，先做**迁移前一致性备份**
 * （同步 VACUUM INTO——非复制活动主文件、非异步 backup API，§12.5；备份失败=拒绝启动写）。
 * 任一迁移失败：该事务回滚、user_version 不变、函数抛错——调用方（daemon 启动）据此拒绝
 * 启动写任务并保留备份；句柄由 openDatabase 统一关闭。
 */
export function migrate(
  db: ZhongshuoDatabase,
  options: OpenOptions = {},
  migrations: readonly Migration[] = MIGRATIONS,
): MigrateResult {
  const fromVersion = db.pragma('user_version', { simple: true }) as number;
  // r60（review-r59 §2 独立反例 future-schema-result.json）：不支持更高版本**先于任何写入**
  // 拒绝（此前 pending 为空即放行——旧程序误指新库会照常 applyRecovery/接受命令写入）。
  // 不降级版本号、不删除未识别的迁移记录；失败路径经 openDatabase 关闭句柄。
  const latestSupported = migrations.reduce((max, m) => Math.max(max, m.id), 0);
  if (fromVersion > latestSupported) {
    throw new Error(
      `SCHEMA_VERSION_UNSUPPORTED：库 schema 版本 ${fromVersion} 高于本程序支持的 ${latestSupported}` +
      '——请使用对应更高版本的程序打开此数据根，或恢复升级前生成的匹配备份；' +
      '本程序不降级版本号、不删除未识别的迁移记录后继续写入',
    );
  }
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
  const source = migration.up.toString();
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}-${source.length}`;
}
