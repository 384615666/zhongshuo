/**
 * 024（第十八轮四）：协作时限快照——派发时把本轮有效时限（已解析：项目值或全局默认）
 * 与配置版本（projects.revision）存入 turn。生效边界=「新派发 turn 起生效（在途不变）」：
 * 在途 turn 的单轮截止/缺席有效执行时间/审批暂停扣除都用快照，泵不再每次读最新项目配置；
 * 重启沿持久快照恢复（不重新套当前配置）。NULL 列=快照前历史行，消费侧回落现行配置。
 */
import type { Migration } from '../db.ts';

export const collabSnapshotMigration: Migration = {
  id: 24,
  name: 'collab-limit-snapshot',
  up: (db) => {
    db.exec('ALTER TABLE agent_turns ADD COLUMN collab_absence_ms INTEGER');
    db.exec('ALTER TABLE agent_turns ADD COLUMN collab_turn_deadline_ms INTEGER');
    db.exec('ALTER TABLE agent_turns ADD COLUMN collab_config_revision INTEGER');
  },
};
