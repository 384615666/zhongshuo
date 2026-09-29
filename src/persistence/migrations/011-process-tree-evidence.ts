/**
 * 011 迁移：进程树证据与启动窗口登记（第七轮·补，supervisor 衔接）。
 *
 * runtime_process_registry 重建（CHECK 扩展）：
 * - process_model 增 'unknown'：openSession 后、startTurn 前的 pre-launch 登记（进程模型
 *   尚未由 adapter 上报——崩溃在身份持久化前的窗口可区分「从未启动」与「请求可能已发出」）；
 * - identity_source 增 'pre-launch'：同上窗口标记；startTurn 成功后由完整登记 REPLACE。
 * probe 语义（processRegistry 侧）：exited 判定追加**存活子进程检查**——父进程退出不证明
 * 其工具子进程已结束；仅「父退出 + 无存活子进程（可枚举且为空）」才构成完整退出证据，
 * 否则降级 unknown（保护保留）。非 win32 平台无子进程枚举能力=未完整确认（能力矩阵如实）。
 */
import type { Migration } from '../db.ts';

export const processTreeEvidenceMigration: Migration = {
  id: 11,
  name: 'process-tree-evidence-prelaunch',
  up: (db) => {
    db.exec(`
      CREATE TABLE runtime_process_registry_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        adapter_kind TEXT NOT NULL,
        process_model TEXT NOT NULL CHECK (process_model IN ('per-turn','shared','none','unknown')),
        pid INTEGER,
        started_at_ms INTEGER,
        identity_source TEXT NOT NULL CHECK (identity_source IN ('os-starttime','pid-only','none','pre-launch')),
        registered_at INTEGER NOT NULL,
        closed_at INTEGER,
        note TEXT
      );
      INSERT INTO runtime_process_registry_v2
        SELECT id, turn_id, run_id, member_id, adapter_kind, process_model, pid, started_at_ms,
               identity_source, registered_at, closed_at, note
        FROM runtime_process_registry;
      DROP TABLE runtime_process_registry;
      ALTER TABLE runtime_process_registry_v2 RENAME TO runtime_process_registry;
      CREATE INDEX rpr_open ON runtime_process_registry(closed_at) WHERE closed_at IS NULL;
    `);
  },
};
