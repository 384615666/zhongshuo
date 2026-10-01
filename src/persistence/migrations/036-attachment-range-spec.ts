/**
 * 迁移 036（第二十九轮四）：message_attachments.range_spec——表格类附件（XLSX/CSV）的
 * **注入范围**（如 "Sheet1!A1:D20"，随消息-附件关联持久）。范围选择进模型输入是有界默认
 * 的例外：用户可选工作表与单元格窗口，不把全部工作表无界发送；空=有界默认窗口（首表
 * 前 50×16），由组装层按缓存行列表裁剪。
 */
import type { Migration } from '../db.ts';

export const migration036: Migration = {
  id: 36,
  name: 'message-attachment-range-spec',
  up: (db) => {
    db.exec('ALTER TABLE message_attachments ADD COLUMN range_spec TEXT;');
  },
};
