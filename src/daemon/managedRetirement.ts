/**
 * 受管 job 收尾闸门（第十四轮二：资源回收归属——不依赖测试手动 dispose）。
 *
 * 归属规则：
 * - per-turn job：turn 终态（SUCCEEDED/FAILED/CANCELLED——正常成功/失败/取消/UNKNOWN 收口
 *   后的 FAILED）settle 时收尾，或 releaseProtection 消费证据后收尾；前提=无其他 open 登记
 *   共享该 job（防御：共享者仍需证据/句柄时不关）；
 * - shared job（常驻进程，多 turn 共享执行载体）：**不随单 turn 收尾**——其他任务与 adapter
 *   可能仍需；收尾归 daemon stop（disposeAllManagedJobs）与 adapter dispose；
 * - 顺序约定：证据查询 → DB 事务（租约/事件）→ markConsumed → 准入联动 → 本闸门（最后）。
 *   闸门前的失败可重试——job 句柄与证据不提前丢失；闸门幂等（dispose 二次调用 no-op）。
 */
import { getTurnProcessRegistration, openManagedJobRegistrations, type RegistryDb } from './processRegistry.ts';
import { disposeManagedJob } from './managed/bridge.ts';

export type ManagedRetireOutcome =
  | { outcome: 'disposed'; jobId: string }
  | { outcome: 'retained'; jobId: string; reason: string }
  | { outcome: 'not-managed' };

/** 按登记收尾该 turn 关联的受管 job（终态 settle / 证据消费后调用）。 */
export function retireManagedJob(db: RegistryDb, turnId: string): ManagedRetireOutcome {
  const reg = getTurnProcessRegistration(db, turnId);
  if (reg == null || reg.identity_source !== 'managed-job' || reg.managed_job_id == null) {
    return { outcome: 'not-managed' };
  }
  if (reg.process_model === 'shared') {
    return { outcome: 'retained', jobId: reg.managed_job_id, reason: 'shared 常驻 job——其他任务/adapter 可能仍需，收尾归 daemon stop（不因单 turn 收口关闭）' };
  }
  const others = openManagedJobRegistrations(db, reg.managed_job_id, turnId);
  if (others.length > 0) {
    return { outcome: 'retained', jobId: reg.managed_job_id, reason: `仍有 ${others.length} 个 open 登记共享该 job（${others.map((o) => o.turn_id).slice(0, 4).join('、')}）——句柄保留` };
  }
  disposeManagedJob(reg.managed_job_id);
  return { outcome: 'disposed', jobId: reg.managed_job_id };
}
