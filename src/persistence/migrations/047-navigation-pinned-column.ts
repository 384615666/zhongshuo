/**
 * 迁移 047（第六十六轮·R65 遗留缺陷修复）：navigation_preferences.pinned_project_ids_json 列。
 *
 * R65 的 navigation.get/set（commands.ts）引用了 `pinned_project_ids_json`，但该列从未由
 * 任何迁移创建——fresh DB 与旧库上一执行 navigation.get 即 `no such column` 抛错：
 * applyServerNavPrefs 整体落入 catch → 服务端导航偏好永远不可用（重开后侧栏按本地空镜像
 * 隐藏，R66 门实测复现）。已发布 001–046 冻结不动；本迁移补列（可空——旧行语义=未置顶，
 * parseIds(null)=[]），幂等。
 */
import type { Migration } from '../db.ts';

export const migration047: Migration = {
  id: 47,
  name: 'navigation_preferences.pinned_project_ids_json（R65 navigation 命令引用列缺失——补列）',
  async up(db) {
    db.exec('ALTER TABLE navigation_preferences ADD COLUMN pinned_project_ids_json TEXT');
  },
};
