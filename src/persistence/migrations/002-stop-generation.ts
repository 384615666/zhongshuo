/**
 * 002 迁移：停止代次 + 初始路由落库。
 * - tasks.stop_generation（§11.4：停止代次持久化，回执携带关联值）。
 * - tasks.route_json：message.submit 的 resolvedRoute（服务端二次校验后的最终事实，§15.2），
 *   派发 worker 据此创建 WorkflowRun（M0 消费 DIRECT；DELIBERATE/AUTO 后续包扩展）。
 */
import type { Migration } from '../db.ts';

export const stopGenerationMigration: Migration = {
  id: 2,
  name: 'tasks-stop-generation-and-route',
  up: (db) => {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN stop_generation INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN route_json TEXT;
    `);
  },
};
