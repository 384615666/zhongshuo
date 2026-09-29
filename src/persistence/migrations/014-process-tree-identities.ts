/**
 * 014（第九轮）：进程树历史身份登记（按代次，不覆盖未确认身份）。
 *
 * 问题（用户令第九轮一）：012 的快照表每代快照先 DELETE 再 INSERT——后续快照从登记根
 * BFS，根退出后只写占位行，**父链已断但仍存活的后代（孙）从后续快照中消失**，历史归属
 * 丢失；且 PID 脱离启动时间不构成身份（复用不可检测）。
 *
 * 新表 process_tree_identities：**追加式**身份登记（按进程代次=pid+started_at_ms）。
 * - 每次观察（快照）只 upsert：更新 last_seen_alive_at；**从不删除**未确认身份；
 * - exit_confirmed_at 由 probe 核对后写（该代次进程已确认退出）；已确认身份不因后续
 *   快照缺席而丢失——释放判定核对的是身份全集，不是最后一帧快照；
 * - started_at_ms 为 NULL（CreationDate 不可得）的身份仍登记，但 probe 核对时无法与
 *   PID 复用区分——保守按不可确认处理（保护保留）。
 *
 * 配套判定收紧（同轮）：周期快照机制**不能**构成「全部受管执行已结束」的完整证明
 * （最后快照之后派生且父链已断的深层链不可排除）——probe 对 per-turn/shared 不再返回
 * exited；释放保护仅凭程序事实（none 模型 no-os-process）。观察事实（根已退出/历史身份
 * 已确认/现存树无存活）全部进 detail，不冒充完整退出证据。
 */
import type { Migration } from '../db.ts';

export const processTreeIdentitiesMigration: Migration = {
  id: 14,
  name: 'process-tree-identities',
  up: (db) => {
    db.exec(`
      CREATE TABLE process_tree_identities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        started_at_ms INTEGER,
        first_seen_at INTEGER NOT NULL,
        last_seen_alive_at INTEGER NOT NULL,
        exit_confirmed_at INTEGER,
        is_root INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX process_tree_identities_by_turn ON process_tree_identities(turn_id);
    `);
  },
};
