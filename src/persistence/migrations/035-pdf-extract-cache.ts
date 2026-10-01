/**
 * 迁移 035（第二十八轮五）：artifacts.extracted_text_json——PDF 提取文本缓存
 * （{sourceHash, pages:[{page,text,truncated}], extractedAt, modelVersion}——同 hash 不重复
 * 解析；受限模型注入与分页预览共用；无此列的旧行按需现场提取并回写）。
 */
import type { Migration } from '../db.ts';

export const migration035: Migration = {
  id: 35,
  name: 'artifacts-extracted-text-cache',
  up: (db) => {
    db.exec('ALTER TABLE artifacts ADD COLUMN extracted_text_json TEXT;');
  },
};
