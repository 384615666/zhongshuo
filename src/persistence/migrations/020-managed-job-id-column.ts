/**
 * 020（第十四轮二）：runtime_process_registry 增列 managed_job_id——受管身份正式绑定。
 *
 * 第十二/十三轮把 jobId 塞在 note 字段（非正式）；releaseProtection 按 pid 查受管句柄，
 * 与「jobId 稳定身份、PID 仅辅助」的报告口径不一致（PID 复用可命中他人 job 的证据）。
 * 本迁移把受管稳定身份提升为独立列：
 * - 登记（worker）：adapter 上报 managedJobId（bridge 进程对象的稳定身份）随登记持久化；
 * - probe/reconcile/releaseProtection：按 managed_job_id 查找并核对（pid 仅辅助属性）；
 * - 缺列值/不匹配/PID 复用/其他 turn 的 job 证据 → 拒绝自动解除。
 * 历史行：019 之前登记的 managed-job 行若无 note jobId，managed_job_id=NULL——按登记不完整
 * 拒绝自动解除（保守，不追认）。新列可空、无 CHECK——ALTER ADD COLUMN 即可（不重建表）。
 */
import type { Migration } from '../db.ts';

export const managedJobIdColumnMigration: Migration = {
  id: 20,
  name: 'managed-job-id-column',
  up: (db) => {
    db.exec('ALTER TABLE runtime_process_registry ADD COLUMN managed_job_id TEXT');
    // 存量搬运：第十三轮测试链把受管稳定身份（job-<ts>-<pid> 形态）塞在 note——升为正式列。
    db.exec(`UPDATE runtime_process_registry SET managed_job_id = note WHERE identity_source = 'managed-job' AND note LIKE 'job-%'`);
  },
};
