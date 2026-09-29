/**
 * 010 迁移：格式修复按「逻辑输出」限制一次（第七轮：禁止修复套修复）。
 *
 * 008 的 UNIQUE(task_id, source_turn_id) 只限制同一 turn 被直接修复一次——修复 turn 自身
 * 失败后仍可作为新的 source_turn 再获得资格（修复套修复）。本迁移重建表，改按
 * **根逻辑输出身份**唯一：UNIQUE(task_id, logical_output_id)。
 * - 初始 DIRECT 输出的逻辑输出身份=该 turn；修复轮继承其消费的工作项的 logical_output_id；
 * - 因此同一逻辑输出（含其修复尝试）总共最多一个工作项=最多一次修复；
 * - 用户后续正式发起的独立输出（新 turn）有自己的逻辑输出身份与修复资格；
 * - 保留 UNIQUE(task_id, source_turn_id)（同一 turn 不重复直接修复）。
 * 存量数据 logical_output_id=source_turn_id（皆为初始输出），等价迁移。
 */
import type { Migration } from '../db.ts';

export const logicalOutputRepairMigration: Migration = {
  id: 10,
  name: 'logical-output-repair-identity',
  up: (db) => {
    db.exec(`
      CREATE TABLE format_repair_workitems_v2 (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        source_turn_id TEXT NOT NULL,
        source_result_key TEXT NOT NULL,
        logical_output_id TEXT NOT NULL,
        invalid_event_id TEXT NOT NULL,
        source_output_hash TEXT NOT NULL,
        source_output_text TEXT NOT NULL,
        invalid_issues_json TEXT NOT NULL,
        target_dispatch_key TEXT NOT NULL,
        budget_run_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','consumed','closed','blocked'))
          DEFAULT 'pending',
        consumed_turn_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        note TEXT,
        UNIQUE (task_id, logical_output_id),
        UNIQUE (task_id, source_turn_id)
      );
      INSERT INTO format_repair_workitems_v2
        SELECT id, task_id, source_turn_id, source_result_key, logical_output_id, invalid_event_id,
               source_output_hash, source_output_text, invalid_issues_json, target_dispatch_key,
               budget_run_id, status, consumed_turn_id, created_at, updated_at, note
        FROM format_repair_workitems;
      DROP TABLE format_repair_workitems;
      ALTER TABLE format_repair_workitems_v2 RENAME TO format_repair_workitems;
      CREATE INDEX frw_by_dispatch ON format_repair_workitems(target_dispatch_key, status);
    `);
  },
};
