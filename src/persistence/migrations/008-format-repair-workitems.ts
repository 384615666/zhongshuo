/**
 * 008 迁移：格式修复工作项（第六轮·下：持久、精确绑定的修复链）+ 逐 turn 预算标记。
 *
 * format_repair_workitems——修复不再是"读后即删"的 kv：
 * - source_turn_id/output_hash/output_text/invalid_event_id 同轮绑定（源 turn 的**实际完成
 *   输出**经 thread.replyAdded(turnId) 定位，不用任务最后一条消息顶替）；
 * - logical_output_id=源 turn 身份（DIRECT 每 turn 即一份逻辑输出）——"每份逻辑输出最多一次"
 *   按 (task_id, source_turn_id) 唯一约束，不按整个任务；
 * - target_dispatch_key 定位目标派发；budget_run_id 记录预算归属（沿用原授权——修复 run 的
 *   usedTurns 由源任务累计播种，不因新 run 重置）；
 * - status: pending → consumed（与 run/turn 创建同事务原子落位）→ closed；损坏/不一致时
 *   blocked 留证。准入延期/组装失败/重启重领不丢失、不降级为普通重跑。
 *
 * agent_turns.budget_mark：逐 turn 预算处置标记（settled/refunded/NULL 未处置）——对账退款
 * 与结算可识别、幂等防双算；run 总账（budget_json）之外提供 turn 粒度核对锚点。
 */
import type { Migration } from '../db.ts';

export const formatRepairWorkitemsMigration: Migration = {
  id: 8,
  name: 'format-repair-workitems-turn-budget-mark',
  up: (db) => {
    db.exec(`
      CREATE TABLE format_repair_workitems (
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
        UNIQUE (task_id, source_turn_id)
      );
      CREATE INDEX frw_by_dispatch ON format_repair_workitems(target_dispatch_key, status);

      ALTER TABLE agent_turns ADD COLUMN budget_mark TEXT
        CHECK (budget_mark IS NULL OR budget_mark IN ('settled','refunded'));
    `);
  },
};
