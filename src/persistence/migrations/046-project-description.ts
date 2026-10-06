/**
 * 迁移 046（第六十五轮）：projects.description 列。
 *
 * 原型项目属性含可编辑「描述」（只影响显示，不写磁盘目录——v1.9 §3/§七）。001 的
 * projects 表没有该列，旧实现无处保存。本迁移补 `description TEXT`（可空——旧行语义
 * 为「无描述」，不猜默认文案）。已发布 001–045 冻结不动；本迁移只加列，幂等。
 */
import type { Migration } from '../db.ts';

export const migration046: Migration = {
  id: 46,
  name: 'projects.description（原型项目属性·描述——可编辑显示字段，不写磁盘目录）',
  async up(db) {
    db.exec('ALTER TABLE projects ADD COLUMN description TEXT');
  },
};
