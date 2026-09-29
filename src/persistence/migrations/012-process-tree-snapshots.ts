/**
 * 012（第八轮）：进程树持续归属登记。
 *
 * process_tree_snapshots：turn 活跃期间的进程树快照（每 turn 保留最新一代，REPLACE 语义
 * 由写入侧事务保证）。为什么需要：退出时刻只递归扫描现存父子关系，**中间代际已退出时
 * 其历史父子边随进程一起消失**（孙进程的 PPID 指向已死且未复用的中间 PID，从登记根
 * 无法连通）——持续快照是「孙进程遗留」这类执行载体的唯一可核对锚点（第八轮用户指令：
 * 按平台能力采用受管理的生命周期机制、持续归属登记或等效可验证方案）。
 * 写入方=worker（startTurn 成功后首拍+消费期间 5s 周期重拍）；核对方=probeTurnExit 的
 * 全树归属分析（analyzeProcessTree）。
 */
import type { Migration } from '../db.ts';

export const processTreeLateEventsMigration: Migration = {
  id: 12,
  name: 'process-tree-snapshots',
  up: (db) => {
    db.exec(`
      CREATE TABLE process_tree_snapshots (
        turn_id TEXT NOT NULL,
        root_pid INTEGER NOT NULL,
        pid INTEGER NOT NULL,
        ppid INTEGER NOT NULL,
        started_at_ms INTEGER,
        observed_at INTEGER NOT NULL,
        PRIMARY KEY (turn_id, pid)
      );
    `);
  },
};
