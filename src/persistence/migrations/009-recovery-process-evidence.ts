/**
 * 009 迁移：恢复链路的 OS 进程证据服务端化（第七轮）。
 *
 * runtime_process_registry——turn 启动时的进程身份登记（adapter 如实上报进程模型）：
 * - process_model：per-turn（每 turn 独立子进程，PID 专属该 turn）/ shared（常驻进程，
 *   PID 由多 turn 共享，不专属）/ none（无子进程——内联/模拟，无 OS 遗留进程可能）；
 * - pid + started_at_ms（登记时 OS 观测的启动时刻，null=不可得）：对账时 PID 复用检测的
 *   历史锚点；缺失时复用不可检测=退出判定退 unknown（不猜测）；
 * - closed_at：正常终态收口时刻（null=崩溃遗留登记——对账候选）。
 *
 * recovery_exit_probes——服务端生成的退出取证记录（recovery.probeProcess / reconcile 自动
 * 取证写入）：观测结果、复用检测、registry 关联。reconcile 可引用 probeId 复核（校验 turn
 * 归属与登记一致），不再接受调用方自报 alive=false。
 */
import type { Migration } from '../db.ts';

export const recoveryProcessEvidenceMigration: Migration = {
  id: 9,
  name: 'recovery-process-evidence',
  up: (db) => {
    db.exec(`
      CREATE TABLE runtime_process_registry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        adapter_kind TEXT NOT NULL,
        process_model TEXT NOT NULL CHECK (process_model IN ('per-turn','shared','none')),
        pid INTEGER,
        started_at_ms INTEGER,
        identity_source TEXT NOT NULL CHECK (identity_source IN ('os-starttime','pid-only','none')),
        registered_at INTEGER NOT NULL,
        closed_at INTEGER,
        note TEXT
      );
      CREATE INDEX rpr_open ON runtime_process_registry(closed_at) WHERE closed_at IS NULL;

      CREATE TABLE recovery_exit_probes (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        registry_id INTEGER,
        process_model TEXT NOT NULL,
        pid INTEGER,
        observed_at INTEGER NOT NULL,
        result TEXT NOT NULL CHECK (result IN ('exited','alive','unknown','no-os-process','identity-missing')),
        started_at_ms INTEGER,
        reuse_check TEXT CHECK (reuse_check IS NULL OR reuse_check IN ('same','different','unknown')),
        detail TEXT,
        created_by TEXT NOT NULL CHECK (created_by IN ('probe','reconcile'))
      );
      CREATE INDEX rep_by_turn ON recovery_exit_probes(turn_id, observed_at);
    `);
  },
};
