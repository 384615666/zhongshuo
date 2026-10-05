/**
 * schema 版本边界合同（r60，review-r59 §2 独立反例 future-schema-result.json）：
 * 旧程序（支持 45）打开 user_version=46 的库曾被放行——pending 为空即正常返回，
 * daemon 随后照常 applyRecovery/接受命令写入。修复合同：
 *  ① 当前库（=支持上限）正常重开——不新建备份、零迁移、无错误；
 *  ② 支持范围内旧库（子集前缀迁移建库=v44）正常升级到 45——迁移前一致性备份产生；
 *  ③ 更高版本（46+伪造迁移记录）**在任何写入之前拒绝**：SCHEMA_VERSION_UNSUPPORTED+
 *     操作提示（用更高版本程序/恢复匹配备份）；句柄关闭（同进程可复核）；user_version
 *     与未识别迁移记录**原样保留**（不降级、不删除）；
 *  ④ 备份失败安全拒启动：旧库+backupDir 不可写→抛错+句柄关闭+库未被改动。
 * 已发布迁移 001–045 冻结不改（入口检查在 db.ts，不在迁移实现内）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase, migrate } from '../../src/persistence/db.ts';
import { MIGRATIONS } from '../../src/persistence/migrations/index.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-svg60-'));
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

const latest = MIGRATIONS.reduce((max, m) => Math.max(max, m.id), 0);

describe('schema 版本边界（r60：更高版本拒写+备份失败安全拒启动）', () => {
  it('① 当前库正常重开：零迁移、不新建备份', () => {
    const file = join(tmpRoot, 'cur.sqlite');
    const backups = join(tmpRoot, 'cur-backups');
    const first = openDatabase(file, { backupDir: backups });
    const v1 = first.pragma('user_version', { simple: true }) as number;
    first.close();
    const second = openDatabase(file, { backupDir: backups }); // 重开=当前版本
    const v2 = second.pragma('user_version', { simple: true }) as number;
    second.close();
    expect(v1).toBe(latest);
    expect(v2).toBe(latest);
    expect(existsSync(backups)).toBe(false); // 无待迁移项→不新建备份（回退实证见 P2 演练，非目录存在性）
  }, 30_000);

  it('② 支持范围内旧库正常升级：迁移前一致性备份产生、升到支持上限', () => {
    const file = join(tmpRoot, 'old-upgrade.sqlite');
    const backups = join(tmpRoot, 'old-backups');
    // 子集前缀=真实旧程序建库路径（按序应用 1..N-1；从零用原始句柄构建，不经 full open）。
    const prefix = MIGRATIONS.filter((m) => m.id < latest);
    const old = new Database(file);
    old.pragma('journal_mode = WAL');
    old.pragma('foreign_keys = ON');
    const res0 = migrate(old, {}, prefix);
    old.close();
    expect(res0.toVersion).toBe(prefix[prefix.length - 1]!.id);
    // 顺带核：已升到 45 的库不能再被「更旧程序」（子集）打开——同一入口门。
    let downgrade: Error | null = null;
    const fresh45 = openDatabase(join(tmpRoot, 'full45.sqlite'));
    fresh45.close();
    try { migrate(new Database(join(tmpRoot, 'full45.sqlite')), {}, prefix); } catch (e) { downgrade = e as Error; }
    expect(String(downgrade?.message)).toContain('SCHEMA_VERSION_UNSUPPORTED');
    const upgraded = openDatabase(file, { backupDir: backups });
    const v = upgraded.pragma('user_version', { simple: true }) as number;
    upgraded.close();
    expect(v).toBe(latest);
    const files = existsSync(backups) ? readdirSync(backups).filter((f) => f.endsWith('.sqlite')) : [];
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(new RegExp(`^state-pre-v${prefix[prefix.length - 1]!.id}-\\d+\\.sqlite$`));
  }, 60_000);

  it('③ 更高版本拒写：任何写入前 SCHEMA_VERSION_UNSUPPORTED；版本与未识别记录原样保留', () => {
    const file = join(tmpRoot, 'future.sqlite');
    const base = openDatabase(file);
    base.pragma(`user_version = ${latest + 1}`);
    base.prepare('INSERT INTO schema_migrations (id, name, applied_at, checksum) VALUES (?, ?, ?, ?)').run(latest + 1, 'future-migration-x', Date.now(), 'fnv1a-future');
    base.close();
    let err: Error | null = null;
    try { openDatabase(file); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(String(err?.message)).toContain('SCHEMA_VERSION_UNSUPPORTED');
    expect(String(err?.message)).toContain('备份');
    // 句柄已关闭（openDatabase 失败路径统一 close）：同进程可用只读句柄复核事实未被改写。
    const ro = new Database(file, { readonly: true });
    const v = ro.pragma('user_version', { simple: true }) as number;
    const rec = ro.prepare('SELECT count(*) c FROM schema_migrations WHERE id = ?').get(latest + 1) as { c: number };
    const rows = ro.prepare('SELECT count(*) c FROM projects').get() as { c: number };
    ro.close();
    expect(v).toBe(latest + 1); // 不降级
    expect(rec.c).toBe(1); // 未识别迁移记录不删除
    expect(rows.c).toBe(0); // 零业务写入（project.open 反例场景在本修复下到不了命令层）
    // 再次打开一致拒绝（无状态损伤/无一次性吞错）。
    let err2: Error | null = null;
    try { openDatabase(file); } catch (e) { err2 = e as Error; }
    expect(String(err2?.message)).toContain('SCHEMA_VERSION_UNSUPPORTED');
  }, 30_000);

  it('④ 备份失败安全拒启动：抛错+句柄关闭+库未被改动', () => {
    const file = join(tmpRoot, 'backupfail.sqlite');
    const prefix = MIGRATIONS.filter((m) => m.id < latest);
    const old = new Database(file);
    old.pragma('journal_mode = WAL');
    old.pragma('foreign_keys = ON');
    migrate(old, {}, prefix);
    old.close();
    const vBefore = (() => { const ro = new Database(file, { readonly: true }); const v = ro.pragma('user_version', { simple: true }) as number; ro.close(); return v; })();
    // backupDir 指向已存在文件之下 → mkdir/VACUUM INTO 不可写。
    const blocker = join(tmpRoot, 'blocker-file');
    writeFileSync(blocker, 'x', 'utf8');
    let err: Error | null = null;
    try { openDatabase(file, { backupDir: join(blocker, 'backups') }); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    // 句柄已关闭+库未被改动（仍为旧版本，可由旧程序继续读取）。
    const ro = new Database(file, { readonly: true });
    const vAfter = ro.pragma('user_version', { simple: true }) as number;
    ro.close();
    expect(vAfter).toBe(vBefore);
  }, 60_000);
});
