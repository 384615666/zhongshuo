/**
 * 任务交付版本种子（v1.12 §10.5 / RT-25，第十四批）。
 *
 * 自洽约束（不能与已有种子打架）：
 *  - TASK_13 的 reviewPolicy='user_review'（决策 28 代码人工审阅），
 *    且 changeSets 里 CS_13 是"已写入原目录、等确认" → 对应一条 pending 交付
 *  - TASK_11 的 reviewPolicy='auto_deliver' 且是旧报告任务，
 *    §10.5 明确"不能给旧报告补造审批" → 交付 reviewStatus='not_required'，任务 DONE
 *  - TASK_12 / TASK_14 仍在跑（ACTIVE），还没有交付版本
 *  - CS_13 的 afterRef 是 git:WORKTREE@uncommitted → 交付不关联任何 commit，
 *    这恰好演示"交付与 Git 提交是两个维度"
 *
 * 刻意包含一个**返工历史**：TASK_13 有 r1（changes_requested，带必填意见）
 * 和 r2（pending，当前）。用于演示 §10.5 第 5 条：
 * 新版本递增 revision 并**替换**当前待办，不追加第二条未处理卡，旧版与意见可查。
 */

import * as I from './ids';
import type { TaskDelivery } from './types';

const NOW = Date.now();
const min = (n: number) => n * 60_000;

export const taskDeliveries: TaskDelivery[] = [
  /* ---------- 任务 #13 · 旧版：已被要求修改（保留历史与意见） ---------- */
  {
    id: 'delivery_13_r1',
    taskId: I.TASK_13,
    runId: I.RUN_13,
    revision: 1,
    manifestHash: 'sha256:1f4c2a（原型伪摘要）',
    status: 'changes_requested',
    summary: '修好中文路径解析，scripts/ 下 2 个文件改动，验证脚本退出码 0。',
    verification: [
      { label: 'node scripts/build-report.mjs "D:\\众说\\docs"', result: 'passed', detail: '退出码 0，报告已写出' },
    ],
    residuals: [],
    artifactRefs: [I.ART_13_PATCH_NOTE],
    changeSetRefs: [I.CS_13],
    createdAt: NOW - min(24),
    reviewedBy: '你',
    reviewedAt: NOW - min(18),
    reviewNote: '把「未执行验证」也写进交付说明——你没跑全量构建这件事我必须看见，不能只报通过的那条。',
  },

  /* ---------- 任务 #13 · 当前版：待验收（唯一 pending） ---------- */
  {
    id: 'delivery_13_r2',
    taskId: I.TASK_13,
    runId: I.RUN_13,
    revision: 2,
    manifestHash: 'sha256:6c1d90e4f7a2（原型伪摘要）',
    status: 'pending',
    summary:
      '修好中文路径导致的 ENOENT：新增 scripts/lib/paths.mjs 收敛输入路径，并替换 scripts/build-report.mjs 里的 resolve() 调用。改动只碰 scripts/ 下 2 个文件，不动 src/。',
    preview: [
      { label: '报告输出', detail: 'build-report 已能对中文路径正常写出 report.md（原型为模拟预览）' },
      { label: '改动范围', detail: '2 个文件：+36 −5，全部在 scripts/ 内' },
    ],
    verification: [
      {
        label: 'node scripts/build-report.mjs "D:\\众说\\docs"',
        result: 'passed',
        detail: '退出码 0；报告已写出',
      },
      {
        label: 'pnpm build 全量构建',
        result: 'not_run',
        detail: '需要约 6 分钟，你这次没有要求执行，因此未运行，不能记为通过',
      },
    ],
    residuals: [
      'fixtures/large-corpus.bin 超过内容级前像上限，无法按前像撤销该文件',
      '改动尚未提交到 Git（工作区仍有未提交内容），提交与本次验收相互独立',
    ],
    artifactRefs: [I.ART_13_PATCH_NOTE],
    changeSetRefs: [I.CS_13],
    // 刻意留空：CS_13 的 after_ref 是 git:WORKTREE@uncommitted
    commitRefs: [],
    createdAt: NOW - min(5),
  },

  /* ---------- 任务 #11 · 旧报告任务：无需验收（不是"已验收"） ---------- */
  {
    id: 'delivery_11_r1',
    taskId: I.TASK_11,
    runId: I.RUN_11,
    revision: 1,
    manifestHash: 'sha256:88a0f31（原型伪摘要）',
    status: 'not_required',
    summary:
      '按预算耗尽规则生成了诚实的整合报告：2 条确认结论、1 条未解决分歧，并如实记录 Claude 缺席。',
    verification: [
      { label: '成员确认记录核对', result: 'passed', detail: '确认矩阵与 positions 表一致' },
      { label: '全体一致校验', result: 'passed', detail: '存在缺席成员，未生成「全体一致」' },
    ],
    residuals: ['Claude 额度耗尽缺席，其意见未纳入；报告标注 unconfirmed，不冒充一致'],
    artifactRefs: [I.ART_11_REPORT],
    changeSetRefs: [I.CS_11],
    createdAt: NOW - min(60 * 20),
    // 无需验收：既没有 reviewedBy，也不是"已验收"
  },
];

/** 便于校验/断言：每个任务最多一个 pending 交付（§10.5 第 5 条） */
export function assertSinglePendingPerTask(list: TaskDelivery[]): string[] {
  const seen = new Map<string, number>();
  for (const d of list) {
    if (d.status !== 'pending') continue;
    seen.set(d.taskId, (seen.get(d.taskId) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([taskId, n]) => `${taskId} 有 ${n} 条 pending`);
}
