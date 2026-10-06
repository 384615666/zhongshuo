/**
 * 迁移 048（第六十七轮）：project_members.description 列。
 *
 * 已批准原型的成员实例含「说明（它会做什么）」字段（pages-misc AddMemberDialog/成员卡），
 * 001 的 project_members 没有该列。R67 补 member.create 正式合同时一并补列（可空——
 * 旧行语义=无说明）。已发布 001–047 冻结不动；本迁移只加列，幂等。
 */
import type { Migration } from '../db.ts';

export const migration048: Migration = {
  id: 48,
  name: 'project_members.description（原型成员实例·说明——member.create 合同配套，可编辑显示字段）',
  async up(db) {
    db.exec('ALTER TABLE project_members ADD COLUMN description TEXT');
  },
};
