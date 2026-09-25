/**
 * 原型种子数据 · 消息与回复串
 *
 * 口径依据：
 *  - §3.4 顶层消息 thread_id = NULL，作为线程唯一 anchor；回复必须带 thread_id
 *  - §17.3 消息类型：进度、分工、报告、争议、授权、结果、系统
 *  - §11.2/TH-10 流式消息原地更新，重复到达不重复计数
 *  - AT-05 预算耗尽仍交付带异议报告，不显示全体一致
 *  - E1 讨论线程无任务号、不唤醒 agent、不显示跟进名单
 */

import * as I from './ids';
import type { Message } from './types';

const NOW = Date.now();
const min = (n: number) => n * 60_000;

let seqCounter = 0;
const nextId = () => `msg_${(++seqCounter).toString(36).padStart(3, '0')}`;

const base = {
  projectId: I.P_ZS,
  roomId: I.R_DEV,
  authorType: 'human' as const,
  authorId: I.M_HUMAN,
};

/* ============================================================
 * 任务 #12 · DELIBERATE 共同研讨（主池 anchor + 18 条串内回复）
 * ============================================================ */

export const anchor12: Message = {
  ...base,
  id: I.AM_12,
  kind: 'text',
  body: '@全体 请审查 src/ 下六个边界的实际依赖方向，找出违反契约的引用，并给出可执行的重构步骤。只分析，不要改文件。',
  createdAt: NOW - min(105),
  payload: { mentionIds: ['all'] },
};

const thread12: Message[] = [
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_12, taskId: I.TASK_12,
    threadMessageSeq: 1, authorType: 'system', authorId: 'system', kind: 'system',
    createdAt: NOW - min(104),
    body: 'PREPARE 完成',
    payload: {
      system: {
        // 减负 §4：正常过程说明移入「详情 → 活动与进展」，不长期占回复区域
        scope: 'process',
        tone: 'info',
        title: '阶段 PREPARE 完成 · 由程序执行，未调用模型',
        detail: '冻结名单 3 人：Codex、Claude、Codex#2。分析基线 baseline_a1f9 已生成（Git HEAD 3c91d2e + 2 个未提交修改，纳入 214 个文件，排除 .git / node_modules / 凭据文件）。预算预估：核心 6N+1 = 19 次，含一次修订路径 7N+2 = 23 次。',
      },
    },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_12, taskId: I.TASK_12,
    threadMessageSeq: 2, authorType: 'agent', authorId: I.M_CODEX, kind: 'report',
    createdAt: NOW - min(95),
    body: '独立初稿完成。核心发现：daemon → adapter 与 adapter → daemon 之间存在 4 处双向 import，违反单向下行原则；`src/adapter/codex/protocol.ts` 直接 import 了 `src/daemon/ipc.ts` 的端点常量。',
    payload: {
      report: {
        artifactId: I.ART_12_CODEX_IND, memberId: I.M_CODEX, revision: 1,
        baselineId: 'baseline_a1f9', claimCount: 7, openQuestions: 2,
        summary: 'daemon/adapter 双向引用 4 处，contracts 方向正确',
      },
    },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_12, taskId: I.TASK_12,
    threadMessageSeq: 3, authorType: 'agent', authorId: I.M_CLAUDE, kind: 'report',
    createdAt: NOW - min(93),
    body: '独立初稿完成。我按"厂商类型是否越过 adapter 边界"分类统计：CodexEvent 与 ClaudeStreamEvent 两个联合类型共出现在 domain 的 11 处签名里。整改顺序建议先冻结 contracts 的规范化事件，再逐个替换，否则会出现第三种临时类型。',
    payload: {
      report: {
        artifactId: I.ART_12_CLAUDE_IND, memberId: I.M_CLAUDE, revision: 1,
        baselineId: 'baseline_a1f9', claimCount: 9, openQuestions: 3,
        summary: 'domain 签名中厂商联合类型 11 处；建议先冻结规范化事件',
      },
    },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_12, taskId: I.TASK_12,
    threadMessageSeq: 4, authorType: 'agent', authorId: I.M_CODEX2, kind: 'report',
    createdAt: NOW - min(90),
    body: '独立初稿完成。补充一个两位都没提到的方向：ui → persistence 有 6 处直接 import 仓储类型。这条不在题目给的六个边界方向里，但同样是越界引用。',
    payload: {
      report: {
        artifactId: I.ART_12_CODEX2_IND, memberId: I.M_CODEX2, revision: 1,
        baselineId: 'baseline_a1f9', claimCount: 5, openQuestions: 1,
        summary: 'ui → persistence 直连 6 处（题目未要求的额外发现）',
      },
    },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_12, taskId: I.TASK_12,
    threadMessageSeq: 5, authorType: 'system', authorId: 'system', kind: 'system',
    createdAt: NOW - min(89),
    body: '阶段推进',
    payload: {
      system: {
        scope: 'process', // 减负 §4：路由推导属正常过程说明
        tone: 'info',
        title: 'INDEPENDENT → CROSS_REVIEW',
        detail: '3/3 成员完成初稿。三份初稿的 baselineId 相同，首轮上下文互不可见。阶段屏障打开，进入互评。',
      },
    },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_12, taskId: I.TASK_12,
    threadMessageSeq: 6, authorType: 'agent', authorId: I.M_CLAUDE, kind: 'progress',
    createdAt: NOW - min(84),
    body: '互评 @Codex：你列的 4 处双向引用我复核了 3 处，成立。第 4 处 `src/adapter/fake/runner.ts` 是测试替身，我认为不应算作生产依赖。另外你的结论里没提 domain 签名的 11 处厂商类型——按你的口径那 11 处也构成越界。【needs_evidence】',
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_12, taskId: I.TASK_12,
    threadMessageSeq: 7, authorType: 'agent', authorId: I.M_CODEX, kind: 'progress',
    createdAt: NOW - min(82),
    body: '互评 @Claude：接受你对测试替身的修正，我会把那处从清单删除。关于 11 处厂商类型，我的分类是"contracts 是否被反向引用"，与你的分类口径不同，不构成矛盾，建议在最终报告里并列两个口径而不是合并。',
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_12, taskId: I.TASK_12,
    threadMessageSeq: 8, authorType: 'agent', authorId: I.M_CODEX2, kind: 'progress',
    createdAt: NOW - min(79),
    body: '互评 @Claude：ui → persistence 那 6 处我有不同看法。其中 2 处是类型导入（`import type`），编译后被擦除，运行时不产生依赖。我建议区分"类型越界"和"运行时越界"，否则整改清单会虚高。',
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_12, taskId: I.TASK_12,
    threadMessageSeq: 9, authorType: 'system', authorId: 'system', kind: 'system',
    createdAt: NOW - min(76),
    body: '生成争议清单',
    payload: {
      system: {
        scope: 'process', // 减负 §4：阶段推进属正常过程说明
        tone: 'info',
        // 面向用户的系统卡：不裸露 CROSS_REVIEW → ISSUE_DISCUSSION 这类内部枚举，
        // 阶段名用中文（内部 key 仍保留在状态机里）
        title: '互评完成 · 进入分歧讨论',
        detail: '程序按互评中的 disagree / needs_evidence 生成 3 条结构化争议，冻结各自引用的报告版本。互评阶段共 3 次调用，累计 6/23。',
      },
    },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_12, taskId: I.TASK_12,
    threadMessageSeq: 10, authorType: 'agent', authorId: I.M_CODEX, kind: 'progress',
    createdAt: NOW - min(70),
    body: '议题 #12-1 立场：adapter 允许返回厂商原始事件对象，但必须在 contracts 中显式标注为 `diagnostic-only`，并禁止 domain 引用该字段。理由：诊断面板需要原始事件才能定位解析错误，规范化事件会丢掉 provider 自己的错误码。',
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_12, taskId: I.TASK_12,
    threadMessageSeq: 11, authorType: 'agent', authorId: I.M_CLAUDE, kind: 'dispute',
    createdAt: NOW - min(64),
    body: '议题 #12-1 我的立场是反对。',
    payload: {
      dispute: {
        issueId: 'issue_12_1',
        statement: 'adapter 层是否应允许直接返回厂商原始事件对象（供诊断面板使用）',
        revision: 3,
        status: 'open',
        positions: [
          { memberId: I.M_CODEX, stance: 'agree', reason: '诊断面板需要原始 provider 错误码；可用 diagnostic-only 标记隔离' },
          { memberId: I.M_CLAUDE, stance: 'disagree', reason: '任何厂商类型进入 contracts 都会被后续开发者顺手引用；原始事件应只落盘，不进内存契约' },
          { memberId: I.M_CODEX2, stance: 'needs_evidence', reason: '需要先看诊断面板实际用到了原始事件的哪些字段，否则无法判断规范化事件是否够用' },
        ],
      },
    },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_12, taskId: I.TASK_12,
    threadMessageSeq: 12, authorType: 'system', authorId: 'system', kind: 'system',
    createdAt: NOW - min(58),
    body: '第 3 轮复核检查点',
    payload: {
      system: {
        tone: 'warn',
        title: '已到第 3 轮强制复核检查点',
        detail: '主持者需评估是否仍有新证据值得继续。硬停由运行预算承担，不是固定三轮硬上限。当前 9/23 次调用。',
        actions: [
          { label: '继续讨论（有新证据）', api: 'task.steer' },
          { label: '进入整合（SYNTHESIS）', api: 'task.steer' },
        ],
      },
    },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_12, taskId: I.TASK_12,
    threadMessageSeq: 13, authorType: 'agent', authorId: I.M_CODEX2, kind: 'progress',
    createdAt: NOW - min(52),
    body: '补充新证据：我扫了诊断面板的原型实现，它实际只用到原始事件里的 `type`、`message`、`raw` 三个字段，其中 `raw` 是渲染用的大对象。按这个口径，规范化事件里加一个 `providerRawPreview` 字符串字段就够，确实不需要把厂商类型整体透传到 contracts。',
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_12, taskId: I.TASK_12,
    threadMessageSeq: 14, authorType: 'system', authorId: 'system', kind: 'system',
    createdAt: NOW - min(44),
    body: '成员超过缺席容忍',
    payload: {
      system: {
        tone: 'warn',
        title: '等 Claude（已 22 分钟，超过 20 分钟缺席容忍）',
        detail: '已按缺席继续：不打断仍在运行的成员，阶段屏障以现有成果推进并先生成部分成果，roster 标记 Claude 迟到。迟到成果到达后按阶段规则并入。缺席容忍（absenceGrace）与单轮硬保护（turnDeadline）是两个独立设置。',
        actions: [
          { label: '重试 Claude', api: 'task.retry' },
          { label: '按现有成员继续', api: 'run.allowMissing' },
        ],
      },
    },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_12, taskId: I.TASK_12,
    threadMessageSeq: 15, authorType: 'agent', authorId: I.M_CLAUDE, kind: 'progress',
    createdAt: NOW - min(38),
    body: '我接受 @Codex#2 的取证方式。立场修正为：允许 adapter 暴露原始事件，但只以字符串预览形式进入 contracts，domain 侧不可见。原反对意见撤回，保留一条条件——预览字段必须限长并脱敏，否则会把凭据带进诊断导出。',
    // "迟到纳入"不再写在正文开头，改用结构化标记渲染成标签：
    // 它是程序附加的运行状态，不是这位成员说的话。
    payload: { mentionIds: [I.M_CODEX2], progress: { status: 'late' } },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_12, taskId: I.TASK_12,
    threadMessageSeq: 16, authorType: 'agent', authorId: I.M_CODEX, kind: 'report',
    createdAt: NOW - min(30),
    body: '整合稿 R1 已完成，含 2 条共同确认结论、1 条仍开放的分歧（议题 #12-2 需要你决定）和 3 个未执行的验证项。这份是草稿，等议题 #12-2 有结论后再走 RATIFY。',
    payload: {
      report: {
        artifactId: I.ART_12_TEAM_REPORT, memberId: I.M_CODEX, revision: 1,
        baselineId: 'baseline_a1f9', claimCount: 12, openQuestions: 3,
        summary: '整合稿 R1（草稿）：2 条确认、1 条待你决定、3 项未验证',
        lateIncluded: true,
      },
    },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_12, taskId: I.TASK_12,
    threadMessageSeq: 17, authorType: 'human', authorId: I.M_HUMAN, kind: 'text',
    createdAt: NOW - min(18),
    body: '@Codex 议题 #12-2 我倾向不允许直连。但先别急着定，把 ui → persistence 的 6 处按"类型越界 / 运行时越界"拆开列一下，我看完再拍。',
    payload: { mentionIds: [I.M_CODEX] },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_12, taskId: I.TASK_12,
    threadMessageSeq: 18, authorType: 'system', authorId: 'system', kind: 'system',
    createdAt: NOW - min(16),
    body: '等待你的取舍决定',
    payload: {
      system: {
        tone: 'info',
        title: '议题 #12-2 已标记为 needs_user',
        detail: '主持人不能单方面把其他成员的反对标成同意，因此程序把它挂到"待我处理"，不会自动选一边。你在这条串里回复后，Codex 会拆开清单再走 RATIFY。',
      },
    },
  },
];

/* ============================================================
 * 任务 #13 · DIRECT 指定成员（Codex 与 Claude#2 保持零调用）
 * ============================================================ */

export const anchor13: Message = {
  ...base,
  id: I.AM_13,
  kind: 'text',
  body: '@Claude build 脚本在中文路径下报 ENOENT，定位一下并修掉，改完给我验证记录。',
  createdAt: NOW - min(26),
  payload: { mentionIds: [I.M_CLAUDE] },
};

const thread13: Message[] = [
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_13, taskId: I.TASK_13,
    threadMessageSeq: 1, authorType: 'system', authorId: 'system', kind: 'system',
    createdAt: NOW - min(25),
    body: 'DIRECT 路由已确定',
    payload: {
      system: {
        scope: 'process', // 减负 §4：路由推导属正常过程说明
        tone: 'info',
        title: '模式 DIRECT：仅 Claude 被调用',
        detail: '解析结果 resolvedRoute = DIRECT / [Claude]。本任务的 delegationAllowed = false，其他房间成员新增模型调用数为 0。写入锁：D:\\zhongshuo 当前由本任务持有。',
      },
    },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_13, taskId: I.TASK_13,
    threadMessageSeq: 2, authorType: 'agent', authorId: I.M_CLAUDE, kind: 'progress',
    createdAt: NOW - min(22),
    body: '先复现。`node scripts/build-report.mjs "D:\\众说\\docs"` 在 Windows 上返回 ENOENT。根因不在中文本身：脚本第 13 行用了 `resolve(process.argv[2])`，但上游把路径当 URL 编码过一遍，`%E4%BC%97` 这类序列被当成字面文件名。',
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_13, taskId: I.TASK_13,
    threadMessageSeq: 3, authorType: 'agent', authorId: I.M_CLAUDE, kind: 'progress',
    createdAt: NOW - min(20),
    body: '修法：新增 `scripts/lib/paths.mjs`，用 `pathToFileURL` → `fileURLToPath` 收敛输入路径，替换 `resolve()` 调用。这个改动只碰 scripts/ 下 2 个文件，不动 src/。',
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_13, taskId: I.TASK_13,
    threadMessageSeq: 4, authorType: 'agent', authorId: I.M_CLAUDE, kind: 'approval',
    createdAt: NOW - min(15),
    body: '需要你确认一次 git commit 操作。',
    payload: {
      approval: {
        approvalId: 'apr_13_commit',
        memberId: I.M_CLAUDE,
        taskId: I.TASK_13,
        action: 'git commit -m "fix(scripts): 收敛中文路径解析"',
        scope: '仅本次 · 仅 scripts/build-report.mjs 与 scripts/lib/paths.mjs',
        payloadHash: 'sha256:6c1d90e4f7a2（原型伪摘要）',
        expiresAt: NOW + min(24),
      },
    },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_13, taskId: I.TASK_13,
    threadMessageSeq: 5, authorType: 'system', authorId: 'system', kind: 'system',
    createdAt: NOW - min(15),
    body: '授权请求已通知',
    payload: {
      system: {
        tone: 'warn',
        title: '等待你的授权（29 分钟后自动拒绝）',
        detail: '这是"权限请求"，与"成果审阅"是两个不同状态。agent 无权回应人类的授权请求，也不会自动扩大目录权限。',
      },
    },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_13, taskId: I.TASK_13,
    threadMessageSeq: 6, authorType: 'agent', authorId: I.M_CLAUDE, kind: 'progress',
    createdAt: NOW - min(9),
    body: '文件修改已完成（未提交）。验证：`node scripts/build-report.mjs "D:\\众说\\docs"` 退出码 0，报告已写出。附加验证记录 path-fix.log。注意 fixtures/large-corpus.bin 超过前像上限，无法做内容级撤销。',
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_13, taskId: I.TASK_13,
    threadMessageSeq: 7, authorType: 'agent', authorId: I.M_CLAUDE, kind: 'progress',
    createdAt: NOW - min(7),
    body: '另一条验证没跑：`pnpm build` 全量构建需要 6 分钟，你这次没要求，所以我没执行，报告里记为"未执行验证"。',
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_13, taskId: I.TASK_13,
    threadMessageSeq: 8, authorType: 'system', authorId: 'system', kind: 'system',
    createdAt: NOW - min(6),
    body: '进入 REVIEW',
    payload: {
      system: {
        tone: 'info',
        title: '代码需人工审阅（reviewPolicy = user_review）',
        detail: '报告的默认是自动交付，代码按项目设置为人工审阅。改动尚未合入原目录，ChangeSet 单独记录应用状态——"文件已修改"不等于"验收通过"。',
        actions: [
          { label: '查看改动 diff', api: 'changes.get' },
          { label: '接受并合入', api: 'changes.get' },
        ],
      },
    },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_13, taskId: I.TASK_13,
    threadMessageSeq: 9, authorType: 'agent', authorId: I.M_CLAUDE, kind: 'result',
    createdAt: NOW - min(5),
    body: '任务完成，等你审阅改动。',
    payload: {
      result: {
        outcome: 'succeeded',
        // consensus 字段留空：DIRECT 不计算共识（§6.5 只定义研讨的确认矩阵）。
        // resultConsensusLabel() 会据此渲染"无共识语义（非研讨模式）"。
        artifactIds: [I.ART_13_PATCH_NOTE],
        changeSetIds: [I.CS_13],
        absentMemberIds: [],
        lateMemberIds: [],
        note: '仅 Claude 参与本任务，其他房间成员新增调用数为 0。改动已进入待审阅状态。',
      },
    },
  },
];

/* ============================================================
 * 任务 #14 · AUTO 自动分工（无 mention，协调者接单）
 * ============================================================ */

export const anchor14: Message = {
  ...base,
  id: I.AM_14,
  kind: 'text',
  body: '整理一下本周的演化日志，出一份能直接发出去的周报草稿。',
  createdAt: NOW - min(4),
};

const thread14: Message[] = [
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_14, taskId: I.TASK_14,
    threadMessageSeq: 1, authorType: 'system', authorId: 'system', kind: 'system',
    createdAt: NOW - min(4),
    body: 'AUTO 路由已确定',
    payload: {
      system: {
        scope: 'process', // 减负 §4：路由推导属正常过程说明
        tone: 'info',
        title: '模式 AUTO：默认协调者接单',
        detail: '本条没有 @，按路由表由房间协调者 Codex 接单。它可以直接回答，也可以提交结构化分工计划。协调者等待子任务期间不占用活跃模型调用槽。',
      },
    },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_14, taskId: I.TASK_14,
    threadMessageSeq: 2, authorType: 'agent', authorId: I.M_CODEX, kind: 'assignment',
    createdAt: NOW - min(3),
    body: '这条我拆成两个子任务，互不依赖，可以并行取证。',
    payload: {
      assignment: {
        subtasks: [
          {
            key: 'digest', taskId: 'task_14_sub_digest', number: 14,
            title: '从 docs/ 提取本周变更要点',
            assigneeMemberId: I.M_CODEX2,
            objective: '按日期筛出本周新增/修改的文档与设计决策，输出要点清单',
            dependsOn: [], access: 'analyze',
            deliverable: '带文件引用与版本号的要点清单',
            acceptance: ['每条要点标注来源文件与章节', '区分"已拍板"与"仍待决"'],
            status: 'ACTIVE',
          },
          {
            key: 'timeline', taskId: 'task_14_sub_timeline', number: 14,
            title: '整理决策时间线',
            assigneeMemberId: I.M_CLAUDE,
            objective: '把本周的决策按时间顺序排成时间线，标出互相依赖项',
            dependsOn: [], access: 'analyze',
            deliverable: 'Markdown 时间线',
            acceptance: ['日期与来源可追溯', '标注被后续决策覆盖的条目'],
            status: 'OPEN',
          },
        ],
        integrationPlan: '汇总两份要点，按"功能进展 / 决策变更 / 风险"三段生成周报草稿。',
      },
    },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_14, taskId: I.TASK_14,
    threadMessageSeq: 3, authorType: 'system', authorId: 'system', kind: 'system',
    createdAt: NOW - min(3),
    body: '分工计划校验通过',
    payload: {
      system: {
        scope: 'process', // 减负 §4：程序校验通过属正常过程说明（校验失败仍留在回复视图）
        tone: 'info',
        title: '程序校验通过后才生成任务',
        detail: '校验项：无跨项目依赖、无循环依赖、负责人均在房间内、未提升你未授权的权限、子任务数 2 ≤ 6、拆分深度 1 层。本任务未拆分时界面会记录"本次未拆分"，不靠自然语言判断成功。',
      },
    },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_14, taskId: I.TASK_14,
    threadMessageSeq: 4, authorType: 'agent', authorId: I.M_CODEX, kind: 'progress',
    createdAt: NOW - min(2),
    body: '两个子任务都已派发。Claude 那条在等 #13 释放写入锁——同物理目录最多 1 个受管理写入者，即使这只是只读任务，也要先确认。#13 结束前它会一直排队。',
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_14, taskId: I.TASK_14,
    threadMessageSeq: 5, authorType: 'agent', authorId: I.M_CODEX2, kind: 'progress',
    createdAt: NOW - min(1),
    body: '我这边开始扫 docs/ 了，大约需要 3 分钟。',
  },
];

/* ============================================================
 * 任务 #11 · 已交付（预算耗尽 + 成员缺席，AT-05）
 * ============================================================ */

export const anchor11: Message = {
  ...base,
  id: I.AM_11,
  kind: 'text',
  body: '@全体 评审一下 §12.2 的表结构目录，重点是线程与任务的绑定关系够不够支撑两个任务同时跑不串线。',
  createdAt: NOW - min(60 * 22),
  payload: { mentionIds: ['all'] },
};

/* ============================================================
 * 第十五批：data-backfill 项目的任务 #12（与众说 #12 同号）
 *
 * 这条记录存在的唯一目的是让"同号任务 + 同名房间"可被实测：
 * 它和众说的 #12 编号相同、房间都叫「开发大厅」，但属于另一个项目。
 * 任何按编号或房间名拼深链的实现都会在这里露馅。
 * ============================================================ */

export const anchorBf12: Message = {
  projectId: I.P_BACKFILL,
  roomId: I.R_BF_DEV,
  authorType: 'human' as const,
  authorId: I.M_HUMAN,
  id: I.AM_BF12,
  kind: 'text',
  body: '给 orders 表写一个可重跑的增量回填脚本，要支持断点续传，跑第二遍不能重复写入。',
  createdAt: NOW - min(300),
  payload: { mentionIds: [I.M_BF_CODEX] },
};

/* ============================================================
 * 第十五批：notes-vault（**非 Git 且目录正常**的项目）
 *
 * 存在的理由（§9.4）：在它之前唯一的非 Git 项目目录也是失效的，
 * 于是"非 Git 的文件树与预览可用"这条验收用例根本无法被演示。
 * 这个项目目录正常、不是 Git 仓库、有成员与一个已完成任务。
 * ============================================================ */

export const anchorNg1: Message = {
  projectId: I.P_NOTGIT,
  roomId: I.R_NG_NOTES,
  authorType: 'human' as const,
  authorId: I.M_HUMAN,
  id: I.AM_NG1,
  kind: 'text',
  body: '把这一季散落在 docs/ 下的会议笔记按主题归类，生成一份能检索的索引。',
  createdAt: NOW - min(60 * 30),
  payload: { mentionIds: [] },
};

const threadNg1: Message[] = [
  {
    id: nextId(), projectId: I.P_NOTGIT, roomId: I.R_NG_NOTES, threadId: I.T_NG1, taskId: I.TASK_NG1,
    threadMessageSeq: 1, authorType: 'system', authorId: 'system', kind: 'system',
    createdAt: NOW - min(60 * 30 - 1), body: '已按 AUTO 派发',
    payload: { system: { scope: 'process', tone: 'info', title: 'AUTO 派发', detail: '无 @：由协调者接单。本项目不是 Git 仓库，改动按整目录快照记录前像（E15）。' } },
  },
  {
    id: nextId(), projectId: I.P_NOTGIT, roomId: I.R_NG_NOTES, threadId: I.T_NG1, taskId: I.TASK_NG1,
    threadMessageSeq: 2, authorType: 'agent', authorId: I.M_NG_CLAUDE, kind: 'text',
    createdAt: NOW - min(60 * 28),
    body: '已按主题（架构 / 排期 / 复盘）归类 14 篇笔记，生成 docs/index.md。非 Git 目录下改动仍可用 diff 查看并按前像撤销。',
  },
];

const threadBf12: Message[] = [
  {
    id: nextId(), projectId: I.P_BACKFILL, roomId: I.R_BF_DEV, threadId: I.T_BF12, taskId: I.TASK_BF12,
    threadMessageSeq: 1, authorType: 'system', authorId: 'system', kind: 'system',
    createdAt: NOW - min(299), body: '已按 DIRECT 派发给 Codex',
    payload: { system: { scope: 'process', tone: 'info', title: 'DIRECT 派发', detail: '单成员定向跟进；本项目未开启任务验收，完成后直接交付。' } },
  },
  {
    id: nextId(), projectId: I.P_BACKFILL, roomId: I.R_BF_DEV, threadId: I.T_BF12, taskId: I.TASK_BF12,
    threadMessageSeq: 2, authorType: 'agent', authorId: I.M_BF_CODEX, kind: 'text',
    createdAt: NOW - min(280),
    body: '先按 `updated_at` 水位分批，每批 5 万行；断点写进 `etl_checkpoint` 表，重跑时从水位续。写入用 `INSERT ... ON CONFLICT DO NOTHING` 保证幂等。',
  },
];

const thread11: Message[] = [
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_11, taskId: I.TASK_11,
    threadMessageSeq: 1, authorType: 'system', authorId: 'system', kind: 'system',
    createdAt: NOW - min(60 * 22), body: 'PREPARE 完成',
    payload: { system: { scope: 'process', tone: 'info', title: '阶段 PREPARE 完成', detail: '冻结名单 3 人，基线 baseline_5c02，预算 6N+1 = 19 次。' } },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_11, taskId: I.TASK_11,
    threadMessageSeq: 2, authorType: 'agent', authorId: I.M_CODEX, kind: 'report',
    createdAt: NOW - min(60 * 21),
    body: '独立初稿：`conversation_threads.anchor_message_id` 上的唯一索引 `one_thread_per_anchor` 已经足够保证"一个顶层消息最多一个串"，配合 `messages.thread_id IS NULL` 的顶层谓词，双任务不会互相污染。',
    payload: { report: { artifactId: 'artifact_11_codex_ind', memberId: I.M_CODEX, revision: 1, baselineId: 'baseline_5c02', claimCount: 6, openQuestions: 1, summary: '唯一索引 + 顶层谓词足以保证串不混' } },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_11, taskId: I.TASK_11,
    threadMessageSeq: 3, authorType: 'agent', authorId: I.M_CODEX2, kind: 'report',
    createdAt: NOW - min(60 * 21 + 20),
    body: '独立初稿：我担心 `thread_message_seq` 的并发写入。两个 turn 同时往同一串追加时，seq 由谁分配？如果由应用层"读最大值 + 1"会产生竞态，必须由 SQLite 事务内分配。',
    payload: { report: { artifactId: 'artifact_11_codex2_ind', memberId: I.M_CODEX2, revision: 1, baselineId: 'baseline_5c02', claimCount: 4, openQuestions: 2, summary: 'thread_message_seq 的并发分配存在竞态风险' } },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_11, taskId: I.TASK_11,
    threadMessageSeq: 4, authorType: 'system', authorId: 'system', kind: 'system',
    createdAt: NOW - min(60 * 20 + 40), body: '成员不可用',
    payload: {
      system: {
        tone: 'error',
        title: 'Claude 无法参与本轮（PROVIDER_LIMITED）',
        detail: '额度耗尽。direct 模式下不自动换人；这里是 DELIBERATE，程序不悄悄排除它，也没有把它记作已完成。你可以重试它，或选择"按现有成员继续"。',
        actions: [{ label: '重试 Claude', api: 'task.retry' }, { label: '按现有成员继续', api: 'run.allowMissing' }],
      },
    },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_11, taskId: I.TASK_11,
    threadMessageSeq: 5, authorType: 'agent', authorId: I.M_CODEX, kind: 'progress',
    createdAt: NOW - min(60 * 20 + 20),
    body: '整合：@Codex#2 关于 seq 竞态的担心成立，我建议在 §12.3 补一条 `thread_message_order` 之外的写入约束说明。Claude 的缺席我会在报告里如实写，不会标成全体一致。',
    payload: { mentionIds: [I.M_CODEX2] },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_11, taskId: I.TASK_11,
    threadMessageSeq: 6, authorType: 'system', authorId: 'system', kind: 'system',
    createdAt: NOW - min(60 * 20 + 5), body: '预算耗尽',
    payload: {
      system: {
        tone: 'warn',
        title: '运行预算耗尽（19/19 次调用）',
        detail: '耗尽后仍生成诚实的整合报告，结论标记 unconfirmed，不伪造缺席意见。已为整合与确认阶段预留尾部配额，本次仍可交付。你可以在任务卡上增加预算继续讨论剩余分歧。',
      },
    },
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_11, taskId: I.TASK_11,
    threadMessageSeq: 7, authorType: 'agent', authorId: I.M_CODEX, kind: 'result',
    createdAt: NOW - min(60 * 20),
    body: '报告已交付，附缺席说明。',
    payload: {
      result: {
        outcome: 'partial',
        consensus: 'unconfirmed',
        artifactIds: [I.ART_11_REPORT],
        changeSetIds: [],
        absentMemberIds: [I.M_CLAUDE],
        lateMemberIds: [],
        note: 'Claude 因额度耗尽缺席，未取得其确认；报告不标注"全体一致"。',
      },
    },
  },
];

/* ============================================================
 * 讨论串（E1）：无任务号、不唤醒 agent、无跟进名单
 * ============================================================ */

export const anchorD1: Message = {
  ...base,
  id: I.AM_D1,
  kind: 'text',
  body: '【讨论】记录一下：我倾向把"导入 Word"排在"导出 Word"之后做，因为导入要处理的样式兼容比导出麻烦得多。这条先不派活。',
  createdAt: NOW - min(150),
};

const threadD1: Message[] = [
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_D1,
    threadMessageSeq: 1, authorType: 'human', authorId: I.M_HUMAN, kind: 'text',
    createdAt: NOW - min(148),
    body: '补充：如果导入只做"纯文本段落 + 标题层级"，工作量其实可以接受。主要还是表格和图。',
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_D1,
    threadMessageSeq: 2, authorType: 'human', authorId: I.M_HUMAN, kind: 'text',
    createdAt: NOW - min(146),
    body: '先记着，等 M3 排到导出那批再回来看这条。',
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_D1,
    threadMessageSeq: 3, authorType: 'human', authorId: I.M_HUMAN, kind: 'text',
    createdAt: NOW - min(144),
    body: '同一条串里再追加一条，验证讨论串可以有独立回复历史，但它没有任务号，也不会唤醒任何成员。',
  },
  {
    id: nextId(), projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_D1,
    threadMessageSeq: 4, authorType: 'human', authorId: I.M_HUMAN, kind: 'text',
    createdAt: NOW - min(142),
    body: '好，这条讨论到此为止。',
  },
  /**
   * 讨论串里的**消息附件**（界面信息减负 §2 的讨论变体）。
   *
   * 讨论串没有 taskId，成果列表恒为空；但消息附件是独立聚合的，所以
   * 「附件」入口和共享预览对讨论串同样必须可达。这条 fixture 就是那条路径的实测依据。
   */
  {
    id: 'msg_d1_attach', projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_D1,
    threadMessageSeq: 5, authorType: 'human', authorId: I.M_HUMAN, kind: 'text',
    createdAt: NOW - min(140),
    body: '把刚才口头说的排期原则写成一张便签贴这儿，方便以后对。',
    attachmentIds: ['res_disc_note_md'],
  },
];

/* ============================================================
 * 私信会话（决策 24，M3 批次）
 *
 * 评审指出：列表显示"2 条未读"、打开却是"还没有消息"，样例自相矛盾，
 * 无法据此判断小群体验。这里为每个会话补上自洽的历史。
 * 私信使用独立 audience（threadId 形如 dm_thread_*），不是房间消息。
 * ============================================================ */

const dmBase = { projectId: I.P_ZS, roomId: 'dm', authorType: 'human' as const };

/** Claude · 评审口径：2 条未读 */
export const dmThread1: Message[] = [
  {
    ...dmBase, id: 'dm1_1', threadId: 'dm_thread_1', threadMessageSeq: 1,
    authorType: 'human', authorId: I.M_HUMAN, kind: 'text',
    createdAt: NOW - min(60 * 26),
    body: '想私下确认一下：你在群里的互评用词可以更直接一点，不用先肯定再说问题。',
  },
  {
    ...dmBase, id: 'dm1_2', threadId: 'dm_thread_1', threadMessageSeq: 2,
    authorType: 'agent', authorId: I.M_CLAUDE, kind: 'text',
    createdAt: NOW - min(60 * 25),
    body: '明白。我把"总体不错，但是……"这种句式去掉，直接给结论和依据。需要我同时在报告里保留一条"我已确认的前提"吗？',
  },
  {
    ...dmBase, id: 'dm1_3', threadId: 'dm_thread_1', threadMessageSeq: 3,
    authorType: 'human', authorId: I.M_HUMAN, kind: 'text',
    createdAt: NOW - min(60 * 24),
    body: '要的，那条有用。',
  },
  {
    ...dmBase, id: 'dm1_4', threadId: 'dm_thread_1', threadMessageSeq: 4,
    authorType: 'agent', authorId: I.M_CLAUDE, kind: 'text',
    createdAt: NOW - min(38),
    body: '已按这个口径改了。另外提醒一句：任务 #12 里我对 adapter 那项的反对还没撤，等你定方向。',
  },
  {
    ...dmBase, id: 'dm1_5', threadId: 'dm_thread_1', threadMessageSeq: 5,
    authorType: 'agent', authorId: I.M_CLAUDE, kind: 'text',
    createdAt: NOW - min(35),
    body: '补一条：如果你倾向不允许，我这边可以直接把 ui → persistence 那 6 处按类型/运行时拆开列出来。',
  },
];

/** Claude · 测试策略（同一成员的第二条私聊，验证"一个成员多条私聊"） */
export const dmThread2: Message[] = [
  {
    ...dmBase, id: 'dm2_1', threadId: 'dm_thread_2', threadMessageSeq: 1,
    authorType: 'human', authorId: I.M_HUMAN, kind: 'text',
    createdAt: NOW - min(60 * 8),
    body: '这条单独开：周报里提到的"未执行验证"那些项，你有没有办法自动补跑？',
  },
  {
    ...dmBase, id: 'dm2_2', threadId: 'dm_thread_2', threadMessageSeq: 2,
    authorType: 'agent', authorId: I.M_CLAUDE, kind: 'text',
    createdAt: NOW - min(60 * 3),
    body: '可以，但要有取舍：全量 build 要 6 分钟，测试套件的部分更久。建议只补跑与改动文件相关的用例，其余仍记为"未执行"。',
  },
];

/** Codex · 重构排期 */
export const dmThread3: Message[] = [
  {
    ...dmBase, id: 'dm3_1', threadId: 'dm_thread_3', threadMessageSeq: 1,
    authorType: 'human', authorId: I.M_HUMAN, kind: 'text',
    createdAt: NOW - min(60 * 50),
    body: '六边界整改你估计要几个包？',
  },
  {
    ...dmBase, id: 'dm3_2', threadId: 'dm_thread_3', threadMessageSeq: 2,
    authorType: 'agent', authorId: I.M_CODEX, kind: 'text',
    createdAt: NOW - min(60 * 20),
    body: '先冻结 contracts 再逐层替换，两个包够：一个做规范化事件，一个做方向约束的 lint 规则。',
  },
];

/**
 * 周报分工（1 对 1：与 Codex）
 *
 * 2026-09-25 用户决定私聊收敛为 1 对 1、去掉小群，这条种子随之从
 * "Codex + Codex#2 小群"改为单一成员；消息里的两位发言人合成为 Codex 一人，
 * 避免出现"参与者之外的成员在会话里说话"这种自相矛盾的状态。
 */
export const dmThread4: Message[] = [
  {
    ...dmBase, id: 'dm4_1', threadId: 'dm_thread_4', threadMessageSeq: 1,
    authorType: 'human', authorId: I.M_HUMAN, kind: 'text',
    createdAt: NOW - min(60 * 4),
    body: '周报这块交给你："功能进展"和"决策变更"两段都由你出。',
  },
  {
    ...dmBase, id: 'dm4_2', threadId: 'dm_thread_4', threadMessageSeq: 2,
    authorType: 'agent', authorId: I.M_CODEX, kind: 'text',
    createdAt: NOW - min(60 * 3),
    body: '收到。我这边等 docs/ 的扫描结果回来就写。',
  },
  {
    ...dmBase, id: 'dm4_3', threadId: 'dm_thread_4', threadMessageSeq: 3,
    authorType: 'agent', authorId: I.M_CODEX, kind: 'text',
    createdAt: NOW - min(60 * 2),
    body: '我列决策变更时会把被后续决策覆盖的条目单独标出来，避免读者以为两条都还有效。',
  },
];

/** 已归档的私信：只读，但历史仍在 */
export const dmThread5: Message[] = [
  {
    ...dmBase, id: 'dm5_1', threadId: 'dm_thread_5', threadMessageSeq: 1,
    authorType: 'human', authorId: I.M_HUMAN, kind: 'text',
    createdAt: NOW - min(60 * 24 * 8),
    body: '上周的对账先到这里，结论都已并入项目约定。',
  },
  {
    ...dmBase, id: 'dm5_2', threadId: 'dm_thread_5', threadMessageSeq: 2,
    authorType: 'agent', authorId: I.M_CODEX, kind: 'text',
    createdAt: NOW - min(60 * 24 * 7),
    body: '好的，我把它归档。需要时随时叫回来。',
  },
];

/**
 * data-backfill 项目的私信（第十七批）。
 *
 * 名字与「众说」项目里的 Codex 同名，但**另一个项目、另一位成员实体、
 * 另一条会话**：统一私信入口必须并列显示两条、互不合并，也不能靠显示名去认人。
 */
export const dmThreadBf1: Message[] = [
  {
    projectId: I.P_BACKFILL, roomId: 'dm', authorType: 'human' as const,
    id: 'dmbf1_1', threadId: 'dm_thread_bf_1', threadMessageSeq: 1,
    authorId: I.M_HUMAN, kind: 'text',
    createdAt: NOW - min(60 * 20),
    body: '回填脚本的断点续传口径，我们私下对一下：是按主键区间记进度，还是按已提交游标？',
  },
  {
    projectId: I.P_BACKFILL, roomId: 'dm', authorType: 'agent' as const,
    id: 'dmbf1_2', threadId: 'dm_thread_bf_1', threadMessageSeq: 2,
    authorId: I.M_BF_CODEX, kind: 'text',
    createdAt: NOW - min(60 * 5),
    body: '建议按已提交游标 —— 主键区间在并发补数据时会漏。我先把两种口径写成对照表，你挑一个我再改脚本。',
  },
];

/* ============================================================
 * 导出
 * ============================================================ */

/* ============================================================
 * UX-PREVIEW-01：带资源的消息（§17.9）
 * ============================================================
 *
 * 这几条消息存在的唯一目的，是让"点对话里的文件名打开预览"有落点 ——
 * 此前 Composer 的附件只有 {name,size}、从不落进 Message，
 * 消息里也没有任何可点击的文件引用，这条交互**无法被验证**。
 *
 * 关键：`msg_pool_attach_1/2` 是**主池普通消息**，没有 taskId、没有 threadId。
 * 旧 Artifact 模型要求 taskId/threadId 必填，因此这类附件在旧模型下
 * 根本表达不了 —— 它们是本轮资源契约的直接证据（PV-01）。
 */

/** 主池：人类发的普通消息，带一份 Markdown 文档（无任务归属） */
export const poolAttachMsg: Message = {
  ...base,
  id: 'msg_pool_attach_1',
  kind: 'text',
  body: '先把这份要点放这儿，回头开会用。不派任务，纯记录。',
  createdAt: NOW - min(95),
  attachmentIds: ['res_pool_design_md'],
};

/** 主池：另一条普通消息，带一张真实 PNG（验证图片预览） */
export const poolAttachMsg2: Message = {
  ...base,
  id: 'msg_pool_attach_2',
  kind: 'text',
  body: '布局草图我也贴一下，方便对着看。',
  createdAt: NOW - min(88),
  attachmentIds: ['res_room_image_png'],
};

/** 线程 #14 内：成果汇总消息，挂三份资源（含一份"不支持预览"的 PDF） */
export const thread14ArtifactsMsg: Message = {
  projectId: I.P_ZS, roomId: I.R_DEV, threadId: I.T_14, taskId: I.TASK_14,
  id: 'msg_t14_artifacts',
  threadMessageSeq: 90,
  authorType: 'agent', authorId: I.M_CODEX, kind: 'text',
  createdAt: NOW - min(45),
  body: '本轮产物都挂在这条下面：设计说明（含 v1—v3）、解析器实现，以及一份外部评审 PDF。',
  attachmentIds: ['res_art_design_md', 'res_art_resolver_ts', 'res_unsupported_pdf'],
};

/** 私信：带一张附件（独立 audience，切到群聊必须暂藏） */
export const dmAttachMsg: Message = {
  ...dmBase, id: 'msg_dm_attach_1', threadId: 'dm_thread_1', threadMessageSeq: 6,
  authorType: 'agent', authorId: I.M_CLAUDE, kind: 'text',
  createdAt: NOW - min(50),
  body: '截图放这里，你对照看一下对账口径。这个只在咱俩这条私信里。',
  attachmentIds: ['res_dm_image_png'],
};

export const messages: Message[] = [
  // 主池顶层消息（thread_id = NULL）
  anchorD1,
  anchor11,
  anchor12,
  anchor13,
  anchor14,
  anchorBf12,
  anchorNg1,
  // UX-PREVIEW-01：主池带附件的普通消息（无 taskId）
  poolAttachMsg,
  poolAttachMsg2,
  // 串内回复
  ...thread11,
  ...thread12,
  ...thread13,
  ...thread14,
  thread14ArtifactsMsg,
  ...threadBf12,
  ...threadNg1,
  ...threadD1,
  // 私信（独立 audience，roomId='dm'）
  ...dmThread1,
  dmAttachMsg,
  ...dmThread2,
  ...dmThread3,
  ...dmThread4,
  ...dmThread5,
  ...dmThreadBf1,
];
