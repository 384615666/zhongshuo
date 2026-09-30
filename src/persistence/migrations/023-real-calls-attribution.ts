/**
 * 023（第十八轮三）：real_calls 归属与响应分列——
 * - run_id：正式会话归属（从 agent_turns 按 turnId 解析，TurnRequest 无此字段）；
 * - response_model：**服务端回报**模型（usage.updated.model 原样——与请求模型分列，不用请求值
 *   冒充实际后端；不回报则保持 NULL）；
 * - usage_json：终局用量事件引用（引用真实事件原文，不猜测/不折算）。
 */
import type { Migration } from '../db.ts';

export const realCallsAttributionMigration: Migration = {
  id: 23,
  name: 'real-calls-attribution',
  up: (db) => {
    db.exec('ALTER TABLE real_calls ADD COLUMN run_id TEXT');
    db.exec('ALTER TABLE real_calls ADD COLUMN response_model TEXT');
    db.exec('ALTER TABLE real_calls ADD COLUMN usage_json TEXT');
  },
};
