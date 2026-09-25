/**
 * 原型种子数据 · 核心实体
 * 全部为静态样例，不代表应用已有运行记录（§17.1 示意图脚注同口径）。
 */

import * as I from './ids';
import type {
  AppState,
  AttentionItem,
  ChangeSet,
  DiagnosticRecord,
  FinalReport,
  Project,
  ProjectMember,
  Room,
  RuntimeInstallation,
  StartupRecovery,
  Task,
  Thread,
  WorkflowRun,
  AgentTurn,
  Artifact,
  Issue,
} from './types';
import { messages } from './seeds-messages';
import { gitStates } from './seeds-git';
import { taskDeliveries } from './seeds-deliveries';
import {
  messageAttachments as seedMessageAttachments,
  resources as seedResources,
} from './seeds-resources';

const NOW = Date.now();
const min = (n: number) => n * 60_000;

/* ================= §3.3 项目 ================= */

export const projects: Project[] = [
  {
    id: I.P_ZS,
    displayName: '众说',
    rootPath: 'D:\\zhongshuo',
    canonicalPath: 'D:\\zhongshuo',
    directoryIdentity: 'vol:D: / fileid:0x0002a91c / no-reparse',
    status: 'ok',
    revision: 34,
    isGit: true,
    gitBranch: 'main',
    // v1.9 §14.1 / E20：默认单写者，可在项目设置改为并行
    writeConcurrencyPolicy: 'single_writer',
    maxParallelWriters: 2,
    /**
     * v1.12 §10.5：本项目是"旧项目且缺少新字段"。
     * 它原本按旧规则（代码人工审阅）走，因此**保守迁移为开启**，
     * 并标注来源，不静默给旧任务补造审批。
     */
    taskReviewEnabled: true,
    taskReviewMigrated: true,
    // §10.4：E4 要求缺席容忍"可设置"；turnDeadline 分析与修改分开取值
    loopSettings: {
      absenceGraceMin: 20,
      analysisTurnDeadlineMin: 20,
      modifyTurnDeadlineMin: 60,
      maxConcurrentTurns: 3,
    },
  },
  {
    id: I.P_BACKFILL,
    displayName: 'data-backfill',
    rootPath: 'D:\\work\\data-backfill',
    canonicalPath: 'D:\\work\\data-backfill',
    directoryIdentity: 'vol:D: / fileid:0x0007be31 / no-reparse',
    status: 'ok',
    revision: 12,
    isGit: true,
    gitBranch: 'feat/orders-etl',
    /** v1.12：这个项目有明确设置（用户为后续任务关掉了验收），不迁移、不覆盖 */
    taskReviewEnabled: false,
    taskReviewMigrated: false,
  },
  {
    // 目录失效态（§17.2 空状态：目录失效显示重新定位）
    id: I.P_MISSING,
    displayName: 'legacy-docs',
    rootPath: 'E:\\archive\\legacy-docs',
    canonicalPath: 'E:\\archive\\legacy-docs',
    directoryIdentity: 'vol:E: / fileid:unknown',
    status: 'missing',
    revision: 8,
    isGit: false,
    /**
     * v1.12 §10.5：**新项目默认关闭**。
     * 这个非 Git 项目用于演示"关闭验收也能查看文件与任务交付"，
     * 以及"关闭不初始化仓库、不要求先配 Git"。
     */
    taskReviewEnabled: false,
    taskReviewMigrated: false,
  },
  {
    /**
     * 第十五批：**非 Git 且目录正常**的项目（§9.4 专用）。
     *
     * 补这个数据的原因：在它之前，唯一的非 Git 项目目录也是失效的，
     * 于是"非 Git 的文件树与预览可用"这条验收用例**无法被演示或验证**
     * （实测该项目的树恒为 0 个节点）。这里给一个目录正常、不是 Git 仓库、
     * 但仍有成员/房间/任务的项目，让该用例真正可测。
     */
    id: I.P_NOTGIT,
    displayName: 'notes-vault',
    rootPath: 'D:\\notes\\vault',
    canonicalPath: 'D:\\notes\\vault',
    directoryIdentity: 'vol:D: / fileid:0x0009f210 / no-reparse',
    status: 'ok',
    revision: 5,
    isGit: false,
    /** 非 Git 项目同样可以有成员与任务；验收关闭（它没有版本控制可依赖） */
    taskReviewEnabled: false,
    taskReviewMigrated: false,
  },
];

/* ================= §9.1 决策 37：首版仅两个 runtime ================= */

export const runtimeInstallations: RuntimeInstallation[] = [
  {
    id: I.RT_CODEX,
    kind: 'codex-app-server',
    label: 'Codex App Server',
    executable: 'C:\\Users\\user\\AppData\\Roaming\\npm\\codex.cmd',
    version: '0.48.0',
    adapterVersion: 'zs-adapter-codex 0.1.0',
    health: 'ready',
    capabilities: {
      streaming: true,
      toolEvents: true,
      usage: true,
      interrupt: true,
      resume: true,
      // ADR-14：v0.1 不承诺阻止 runtime 原生读取/写入，界面如实展示
      restrictedRead: false,
    },
  },
  {
    id: I.RT_CLAUDE,
    kind: 'claude-code-headless',
    label: 'Claude Code（headless）',
    executable: 'C:\\Users\\user\\AppData\\Roaming\\npm\\claude.cmd',
    version: '2.0.11',
    adapterVersion: 'zs-adapter-claude 0.1.0',
    health: 'ready',
    capabilities: {
      streaming: true,
      toolEvents: true,
      // 实测：经中转配置的 Claude Code 返回 costBasis=unknown（§10.4）
      usage: true,
      interrupt: true,
      resume: true,
      restrictedRead: false,
    },
  },
];

/* ================= §3.1 成员 ================= */

export const members: ProjectMember[] = [
  {
    id: I.M_CODEX,
    projectId: I.P_ZS,
    profileId: I.PROF_CODEX,
    displayName: 'Codex',
    enabled: true,
    workState: 'running',
    workStateReason: '正在执行任务 #12 的分歧讨论（第 3 轮复核检查点）',
    model: 'gpt-5-codex',
    effort: 'high',
    internalSubagents: false,
    isCoordinatorDefault: true,
  },
  {
    id: I.M_CLAUDE,
    projectId: I.P_ZS,
    profileId: I.PROF_CLAUDE,
    displayName: 'Claude',
    enabled: true,
    workState: 'running',
    workStateReason: '正在修订报告 R2',
    model: 'claude-sonnet-4-5',
    effort: 'medium',
    internalSubagents: true,
    isCoordinatorDefault: false,
  },
  {
    id: I.M_CODEX2,
    projectId: I.P_ZS,
    profileId: I.PROF_CODEX2,
    // §3.2：同一 runtime 的第二成员实例，界面用名称与序号消歧
    displayName: 'Codex',
    ordinal: 2,
    enabled: true,
    workState: 'idle',
    workStateReason: '空闲，等待阶段推进',
    model: 'gpt-5-codex',
    effort: 'low',
    internalSubagents: false,
    isCoordinatorDefault: false,
  },

  /* ================= 第二个可用项目：data-backfill =================
     第十五批 §9.5 要求"两个项目同名房间、同任务号仍分组清楚"。
     为此这个项目**故意**复用一个同名房间「开发大厅」和一个同号任务 #1，
     用来验证看板/侧栏/深链不会把它们和众说的混在一起（同名 ≠ 同一实体）。
     成员复用同一份 profile，但 ProjectMember 身份独立（§17.7 第 6 条：
     同一个 profile/runtime 被多个项目使用时，成员身份和会话不能合并）。 */
  {
    id: I.M_BF_CODEX,
    projectId: I.P_BACKFILL,
    profileId: I.PROF_CODEX,
    displayName: 'Codex',
    enabled: true,
    workState: 'running',
    workStateReason: '正在执行订单表增量回填（#1）',
    model: 'gpt-5-codex',
    effort: 'medium',
    internalSubagents: false,
    isCoordinatorDefault: true,
  },
  {
    id: I.M_BF_CLAUDE,
    projectId: I.P_BACKFILL,
    profileId: I.PROF_CLAUDE,
    displayName: 'Claude',
    enabled: true,
    workState: 'idle',
    workStateReason: '空闲，等待回填结果复核',
    model: 'claude-sonnet-4-5',
    effort: 'medium',
    internalSubagents: true,
    isCoordinatorDefault: false,
  },

  /* notes-vault（非 Git 项目）：证明非 Git 项目同样有完整的成员/任务，不因无版本控制而降级 */
  {
    id: I.M_NG_CLAUDE,
    projectId: I.P_NOTGIT,
    profileId: I.PROF_CLAUDE,
    displayName: 'Claude',
    enabled: true,
    workState: 'idle',
    workStateReason: '空闲，等待整理下一批笔记',
    model: 'claude-sonnet-4-5',
    effort: 'medium',
    internalSubagents: false,
    isCoordinatorDefault: true,
  },
];

/* ================= §3.4 房间 ================= */

export const rooms: Room[] = [
  {
    id: I.R_DEV,
    projectId: I.P_ZS,
    name: '开发大厅',
    description: '核心实现讨论与代码改动，写入串行',
    // E5：协调者是房间级字段
    coordinatorMemberId: I.M_CODEX,
    memberIds: [I.M_CODEX, I.M_CLAUDE, I.M_CODEX2],
    revision: 6,
    unread: 5,
  },
  {
    id: I.R_DESIGN,
    projectId: I.P_ZS,
    name: '方案讨论',
    description: '只分析不改动；研讨结果沉淀为项目约定',
    coordinatorMemberId: I.M_CLAUDE,
    memberIds: [I.M_CODEX, I.M_CLAUDE],
    revision: 3,
    unread: 0,
  },
  {
    id: I.R_DOCS,
    projectId: I.P_ZS,
    name: '文档整理',
    description: '已归档：保留只读历史',
    coordinatorMemberId: I.M_CODEX,
    memberIds: [I.M_CODEX],
    archivedAt: NOW - min(60 * 24 * 3),
    revision: 11,
    unread: 0,
  },

  /* ================= 第十五批：其他项目的房间 =================
     同名房间「开发大厅」出现在两个项目里是**故意的**：看板与侧栏必须
     靠 projectId 区分，而不是靠房间名（§9.5）。 */
  {
    id: I.R_BF_DEV,
    projectId: I.P_BACKFILL,
    name: '开发大厅',
    description: '订单表增量回填，写入串行',
    coordinatorMemberId: I.M_BF_CODEX,
    memberIds: [I.M_BF_CODEX, I.M_BF_CLAUDE],
    revision: 4,
    unread: 1,
  },
  {
    id: I.R_NG_NOTES,
    projectId: I.P_NOTGIT,
    name: '笔记整理',
    description: '非 Git 项目：改动按整目录快照记录前像（E15）',
    coordinatorMemberId: I.M_NG_CLAUDE,
    memberIds: [I.M_NG_CLAUDE],
    revision: 2,
    unread: 0,
  },
  /* docs 项目（P_MISSING）**故意不建房间**：它是"目录失效 + 无成员 + 无任务"
     的空态用例（§17.7 第 8 条：不存在项目/无项目/目录失效均有明确状态）。
     给它编造房间和成员会让空态永远测不到。 */
];

/* ================= §3.4 线程 ================= */

export const threads: Thread[] = [
  { id: I.T_12, projectId: I.P_ZS, roomId: I.R_DEV, anchorMessageId: I.AM_12, rootTaskId: I.TASK_12, status: 'open', lastMessageSeq: 18, revision: 9 },
  { id: I.T_13, projectId: I.P_ZS, roomId: I.R_DEV, anchorMessageId: I.AM_13, rootTaskId: I.TASK_13, status: 'open', lastMessageSeq: 9, revision: 4 },
  { id: I.T_14, projectId: I.P_ZS, roomId: I.R_DEV, anchorMessageId: I.AM_14, rootTaskId: I.TASK_14, status: 'open', lastMessageSeq: 5, revision: 2 },
  { id: I.T_11, projectId: I.P_ZS, roomId: I.R_DEV, anchorMessageId: I.AM_11, rootTaskId: I.TASK_11, status: 'open', lastMessageSeq: 7, revision: 3 },
  // E1：讨论串 root_task_id 为空，无任务号、不唤醒 agent
  { id: I.T_D1, projectId: I.P_ZS, roomId: I.R_DEV, anchorMessageId: I.AM_D1, status: 'open', lastMessageSeq: 4, revision: 1 },

  /* 第十五批：data-backfill 的任务。
     它与众说的 TASK_12 **同项目外同号（都是 12）**，房间也同名（开发大厅），
     这是 §9.5 的关键用例：看板分组、卡片来源、深链都必须按 projectId 定位，
     不能靠编号或房间名猜。 */
  { id: I.T_BF12, projectId: I.P_BACKFILL, roomId: I.R_BF_DEV, anchorMessageId: I.AM_BF12, rootTaskId: I.TASK_BF12, status: 'open', lastMessageSeq: 6, revision: 2 },

  /* notes-vault（非 Git）：一个已完成的任务，让"非 Git 项目也有任务与交付"可演示 */
  { id: I.T_NG1, projectId: I.P_NOTGIT, roomId: I.R_NG_NOTES, anchorMessageId: I.AM_NG1, rootTaskId: I.TASK_NG1, status: 'open', lastMessageSeq: 3, revision: 1 },
];

/* ================= §3.4 任务 ================= */

export const tasks: Task[] = [
  {
    id: I.TASK_12,
    projectId: I.P_ZS,
    roomId: I.R_DEV,
    conversationThreadId: I.T_12,
    rootMessageId: I.AM_12,
    roomTaskNumber: 12,
    ownerMemberId: I.M_CODEX,
    title: '分析模块划分并给出重构建议',
    objective: '审查 src/ 六边界的实际依赖方向，找出违反契约的引用并给出可执行的重构步骤',
    status: 'ACTIVE',
    revision: 5,
    reviewPolicy: 'auto_deliver',
    mode: 'DELIBERATE',
    displayNumber: 12,
  },
  {
    id: I.TASK_13,
    projectId: I.P_ZS,
    roomId: I.R_DEV,
    conversationThreadId: I.T_13,
    rootMessageId: I.AM_13,
    roomTaskNumber: 13,
    ownerMemberId: I.M_CLAUDE,
    title: '修复 build 脚本在中文路径下失败',
    objective: '定位 Windows 中文路径导致的 ENOENT，修改 scripts/ 并给出验证记录',
    /**
     * §10.5：开启验收时交付进入 REVIEW（等用户决定）。
     * 注意这与"文件是否已应用"无关 —— CS_13 的 applicationStatus 仍是 applied。
     */
    status: 'REVIEW',
    revision: 3,
    // 决策 28：代码人工审阅
    reviewPolicy: 'user_review',
    /** v1.12 §10.5：当前交付版本（返工后指向 r2，旧版 r1 仍可查） */
    currentDeliveryId: 'delivery_13_r2',
    mode: 'DIRECT',
    displayNumber: 13,
  },
  {
    id: I.TASK_14,
    projectId: I.P_ZS,
    roomId: I.R_DEV,
    conversationThreadId: I.T_14,
    rootMessageId: I.AM_14,
    roomTaskNumber: 14,
    ownerMemberId: I.M_CODEX,
    title: '整理本周演化日志并写周报',
    objective: '从 docs/ 提取本周变更，生成可直接发送的周报草稿',
    status: 'ACTIVE',
    revision: 1,
    reviewPolicy: 'auto_deliver',
    mode: 'AUTO',
    displayNumber: 14,
  },
  {
    id: I.TASK_11,
    projectId: I.P_ZS,
    roomId: I.R_DEV,
    conversationThreadId: I.T_11,
    rootMessageId: I.AM_11,
    roomTaskNumber: 11,
    ownerMemberId: I.M_CODEX,
    title: '评审 §12.2 表结构目录',
    objective: '检查线程与任务的绑定关系是否足以支撑双任务不串线',
    /**
     * §10.5：这是**旧的 auto_deliver 报告任务**，保持自己的 reviewPolicy 不变，
     * 不因项目迁移为开启而变成待验收，也不给它补造审批记录。
     * 交付 reviewStatus='not_required' —— 注意这**不是**"已验收"，两者不能互相冒充。
     */
    status: 'DONE',
    revision: 4,
    reviewPolicy: 'auto_deliver',
    currentDeliveryId: 'delivery_11_r1',
    mode: 'DELIBERATE',
    displayNumber: 11,
  },
  {
    id: I.SUB_12_ARCH,
    projectId: I.P_ZS,
    roomId: I.R_DEV,
    // 子任务默认绑定根任务的同一 thread_id（§3.4）
    conversationThreadId: I.T_12,
    roomTaskNumber: 12,
    ownerMemberId: I.M_CLAUDE,
    parentTaskId: I.TASK_12,
    title: '核对 adapter 层的厂商类型泄漏',
    objective: '列出 src/adapter 中泄漏至 domain 的厂商类型符号',
    status: 'ACTIVE',
    revision: 2,
    reviewPolicy: 'auto_deliver',
    mode: 'DELIBERATE',
    displayNumber: 12,
  },
  {
    id: I.SUB_12_DATA,
    projectId: I.P_ZS,
    roomId: I.R_DEV,
    conversationThreadId: I.T_12,
    roomTaskNumber: 12,
    ownerMemberId: I.M_CODEX2,
    parentTaskId: I.TASK_12,
    title: '核对持久化层的跨边界引用',
    objective: '检查 persistence 是否被 ui 直接引用',
    status: 'DONE',
    revision: 3,
    reviewPolicy: 'auto_deliver',
    mode: 'DELIBERATE',
    displayNumber: 12,
  },

  /* ================= 第十五批：data-backfill 的根任务 =================
     编号 **12** 与众说项目的 TASK_12 相同，房间名也是「开发大厅」——
     这是刻意构造的"同号 + 同名"对照，用于验证看板分组不会把两个项目的
     任务并到一组（§9.5）。项目 taskReviewEnabled=false：它有正在进行的
     工作，但**不产生待验收**，用来证明"看板有内容 ≠ 有待办"。 */
  {
    id: I.TASK_BF12,
    projectId: I.P_BACKFILL,
    roomId: I.R_BF_DEV,
    conversationThreadId: I.T_BF12,
    rootMessageId: I.AM_BF12,
    roomTaskNumber: 12,
    ownerMemberId: I.M_BF_CODEX,
    title: '订单表增量回填脚本',
    objective: '为 orders 表编写可重跑的增量回填，支持断点续传与幂等',
    status: 'ACTIVE',
    revision: 2,
    reviewPolicy: 'auto_deliver',
    mode: 'DIRECT',
    displayNumber: 12,
  },

  /* notes-vault（非 Git）：一个**已完成**任务。
     用途：①证明非 Git 项目照样有任务与交付；②它的改动集是"整目录快照"前像，
     用来对照 §14.2「非 Git 目录修改前做整目录快照作内容级前像」。 */
  {
    id: I.TASK_NG1,
    projectId: I.P_NOTGIT,
    roomId: I.R_NG_NOTES,
    conversationThreadId: I.T_NG1,
    rootMessageId: I.AM_NG1,
    roomTaskNumber: 1,
    ownerMemberId: I.M_NG_CLAUDE,
    title: '把散落的会议笔记归档成主题索引',
    objective: '按主题归类 docs/ 下的会议笔记，生成一份可检索的索引文件',
    status: 'DONE',
    revision: 2,
    reviewPolicy: 'auto_deliver',
    mode: 'AUTO',
    displayNumber: 1,
  },
];

/* ================= §10.4 运行与预算 ================= */

export const runs: WorkflowRun[] = [
  {
    id: I.RUN_12,
    taskId: I.TASK_12,
    threadId: I.T_12,
    mode: 'DELIBERATE',
    taskRevision: 3,
    status: 'RUNNING',
    stage: 'ISSUE_DISCUSSION',
    roundNo: 3,
    rosterRevision: 2,
    budget: {
      // E12：N=3 → 核心 6N+1=19，含一次修订 7N+2=23
      maxAgentTurns: 23,
      usedAgentTurns: 9,
      formula: '7N+2（N=3，含一次整合修订路径）',
      reservedTail: 4,
      mustReserve: 'SYNTHESIS 1 次 + RATIFY 3 次',
    },
    consensus: 'disputed',
  },
  {
    id: I.RUN_13,
    taskId: I.TASK_13,
    threadId: I.T_13,
    mode: 'DIRECT',
    taskRevision: 2,
    status: 'RUNNING',
    stage: 'INDEPENDENT',
    roundNo: 0,
    rosterRevision: 1,
    budget: { maxAgentTurns: 6, usedAgentTurns: 2, formula: 'DIRECT 固定 6', reservedTail: 0 },
  },
  {
    id: I.RUN_14,
    taskId: I.TASK_14,
    threadId: I.T_14,
    mode: 'AUTO',
    taskRevision: 1,
    status: 'RUNNING',
    stage: 'PREPARE',
    roundNo: 0,
    rosterRevision: 1,
    budget: { maxAgentTurns: 20, usedAgentTurns: 2, formula: 'AUTO 固定 20', reservedTail: 0 },
  },
  {
    id: I.RUN_11,
    taskId: I.TASK_11,
    threadId: I.T_11,
    mode: 'DELIBERATE',
    taskRevision: 2,
    status: 'PARTIAL',
    stage: 'RATIFY',
    roundNo: 3,
    rosterRevision: 1,
    budget: { maxAgentTurns: 19, usedAgentTurns: 19, formula: '6N+1（N=3）', reservedTail: 4 },
    // AT-05：预算耗尽仍交付带异议报告
    consensus: 'unconfirmed',
  },

  /* 第十五批：data-backfill 的 #12（DIRECT，进行中）。
     跨项目看板要能显示"另一个项目也在跑"，所以这个 run 是 RUNNING。 */
  {
    id: I.RUN_BF12,
    taskId: I.TASK_BF12,
    threadId: I.T_BF12,
    mode: 'DIRECT',
    taskRevision: 2,
    status: 'RUNNING',
    stage: 'INDEPENDENT',
    roundNo: 0,
    rosterRevision: 1,
    budget: { maxAgentTurns: 7, usedAgentTurns: 2, formula: '6N+1（N=1，定向）', reservedTail: 1 },
    consensus: 'unconfirmed',
  },

  /* notes-vault（非 Git）：已完成的一次 AUTO 运行 */
  {
    id: I.RUN_NG1,
    taskId: I.TASK_NG1,
    threadId: I.T_NG1,
    mode: 'AUTO',
    taskRevision: 2,
    status: 'SUCCEEDED',
    stage: 'PUBLISH',
    roundNo: 0,
    rosterRevision: 1,
    budget: { maxAgentTurns: 7, usedAgentTurns: 3, formula: '6N+1（N=1，自动）', reservedTail: 1 },
    consensus: 'unconfirmed',
  },
];

/* ================= AgentTurn ================= */

export const turns: AgentTurn[] = [
  /* 第十五批：data-backfill 正在跑的一个 turn（跨项目"谁在工作"要看得到） */
  {
    id: I.TURN_BF12_CODEX,
    runId: I.RUN_BF12,
    threadId: I.T_BF12,
    memberId: I.M_BF_CODEX,
    stageKey: 'INDEPENDENT',
    attempt: 1,
    epoch: 1,
    status: 'RUNNING',
    dispatchKey: 'dsp_bf12_codex_ind_1',
    startedAt: NOW - min(6),
    absenceGraceMs: min(20),
    turnDeadlineMs: min(60),
    usage: { inputTokens: 21400, cachedInputTokens: 8800, outputTokens: 1620, costQuality: 'estimated', costAmount: 0.0832 },
  },
  {
    id: I.TURN_12_CODEX_HOST,
    runId: I.RUN_12,
    threadId: I.T_12,
    memberId: I.M_CODEX,
    stageKey: 'ISSUE_DISCUSSION',
    attempt: 2,
    epoch: 3,
    status: 'RUNNING',
    dispatchKey: 'dsp_12_codex_iss_2',
    startedAt: NOW - min(4),
    // E4：缺席容忍 20 分钟与 turnDeadline 分开
    absenceGraceMs: min(20),
    turnDeadlineMs: min(20),
    usage: { inputTokens: 84210, cachedInputTokens: 61200, outputTokens: 7340, costQuality: 'reported', costAmount: 0.4128 },
  },
  {
    id: I.TURN_12_CLAUDE_REV,
    runId: I.RUN_12,
    threadId: I.T_12,
    memberId: I.M_CLAUDE,
    stageKey: 'ISSUE_DISCUSSION',
    attempt: 1,
    epoch: 3,
    status: 'RUNNING',
    dispatchKey: 'dsp_12_claude_iss_1',
    startedAt: NOW - min(11),
    absenceGraceMs: min(20),
    turnDeadlineMs: min(20),
  },
  {
    id: I.TURN_12_CODEX2_REV,
    runId: I.RUN_12,
    threadId: I.T_12,
    memberId: I.M_CODEX2,
    stageKey: 'ISSUE_DISCUSSION',
    attempt: 1,
    epoch: 3,
    status: 'SUCCEEDED',
    dispatchKey: 'dsp_12_codex2_iss_1',
    startedAt: NOW - min(26),
    durationMs: min(6) + 12_000,
    absenceGraceMs: min(20),
    turnDeadlineMs: min(20),
    usage: { inputTokens: 51030, cachedInputTokens: 40200, outputTokens: 4180, costQuality: 'reported', costAmount: 0.2441 },
  },
  {
    id: I.TURN_12_CODEX_IND,
    runId: I.RUN_12,
    threadId: I.T_12,
    memberId: I.M_CODEX,
    stageKey: 'INDEPENDENT',
    attempt: 1,
    epoch: 1,
    status: 'SUCCEEDED',
    dispatchKey: 'dsp_12_codex_ind',
    startedAt: NOW - min(96),
    durationMs: min(9) + 40_000,
    absenceGraceMs: min(20),
    turnDeadlineMs: min(20),
    usage: { inputTokens: 76320, cachedInputTokens: 55000, outputTokens: 6120, costQuality: 'reported', costAmount: 0.3702 },
  },
  {
    id: I.TURN_12_CLAUDE_IND,
    runId: I.RUN_12,
    threadId: I.T_12,
    memberId: I.M_CLAUDE,
    stageKey: 'INDEPENDENT',
    attempt: 1,
    epoch: 1,
    status: 'SUCCEEDED',
    dispatchKey: 'dsp_12_claude_ind',
    startedAt: NOW - min(94),
    durationMs: min(11) + 5_000,
    absenceGraceMs: min(20),
    turnDeadlineMs: min(20),
    // 中转配置：费用口径未知，界面必须显示"费用未知"而不是 0
    usage: { inputTokens: 91040, cachedInputTokens: 0, outputTokens: 8010, costQuality: 'unknown', costAmount: null },
  },
  {
    id: I.TURN_12_CODEX2_IND,
    runId: I.RUN_12,
    threadId: I.T_12,
    memberId: I.M_CODEX2,
    stageKey: 'INDEPENDENT',
    attempt: 1,
    epoch: 1,
    status: 'SUCCEEDED',
    dispatchKey: 'dsp_12_codex2_ind',
    startedAt: NOW - min(93),
    durationMs: min(8) + 20_000,
    absenceGraceMs: min(20),
    turnDeadlineMs: min(20),
    usage: { inputTokens: 68800, cachedInputTokens: 51000, outputTokens: 5240, costQuality: 'reported', costAmount: 0.3221 },
  },
  {
    id: I.TURN_13_CLAUDE,
    runId: I.RUN_13,
    threadId: I.T_13,
    memberId: I.M_CLAUDE,
    stageKey: 'INDEPENDENT',
    attempt: 1,
    epoch: 1,
    status: 'RUNNING',
    dispatchKey: 'dsp_13_claude_impl',
    startedAt: NOW - min(18),
    absenceGraceMs: min(20),
    turnDeadlineMs: min(60),
  },
  {
    id: I.TURN_14_CODEX,
    runId: I.RUN_14,
    threadId: I.T_14,
    memberId: I.M_CODEX,
    stageKey: 'PREPARE',
    attempt: 1,
    epoch: 1,
    status: 'RUNNING',
    dispatchKey: 'dsp_14_codex_plan',
    startedAt: NOW - min(2),
    absenceGraceMs: min(20),
    turnDeadlineMs: min(20),
  },
];

/* ================= §6.5 争议 ================= */

export const issues: Issue[] = [
  {
    id: 'issue_12_1',
    runId: I.RUN_12,
    statement: 'adapter 层是否应允许直接返回厂商原始事件对象（供诊断面板使用）',
    revision: 3,
    status: 'open',
    evidenceRefs: [I.ART_12_CLAUDE_IND, I.ART_12_CODEX_IND],
    positions: [
      { memberId: I.M_CODEX, stance: 'agree', reason: '诊断面板需要原始 provider 错误码；可用 diagnostic-only 标记隔离' },
      { memberId: I.M_CLAUDE, stance: 'disagree', reason: '任何厂商类型进入 contracts 都会被后续开发者顺手引用；原始事件应只落盘，不进内存契约' },
      { memberId: I.M_CODEX2, stance: 'needs_evidence', reason: '需要先看诊断面板实际用到了原始事件的哪些字段' },
    ],
  },
  {
    id: 'issue_12_2',
    runId: I.RUN_12,
    statement: 'ui/ 是否允许直接 import persistence 的仓储类型以省去一层 DTO',
    revision: 2,
    status: 'needs_user',
    evidenceRefs: [I.ART_12_CODEX2_IND],
    positions: [
      { memberId: I.M_CODEX2, stance: 'needs_evidence', reason: '6 处里有 2 处是 import type，编译后被擦除；需要区分类型越界与运行时越界' },
      { memberId: I.M_CLAUDE, stance: 'disagree', reason: '类型导入同样是边界泄漏，且会诱导后续真实的运行时导入' },
      { memberId: I.M_CODEX, stance: 'unconfirmed', reason: '主持人未表态，等你先拍方向' },
    ],
  },
  {
    id: 'issue_12_3',
    runId: I.RUN_12,
    statement: 'daemon 的单实例锁在 Windows 上是否需要额外的崩溃残留清理',
    revision: 1,
    status: 'resolved',
    evidenceRefs: [I.ART_12_CODEX_IND],
    positions: [
      { memberId: I.M_CODEX, stance: 'agree', reason: '命名管道随进程销毁即释放，无需额外清理；PID 文件不作为唯一依据' },
      { memberId: I.M_CODEX2, stance: 'agree', reason: '复核了单实例锁的实现路径，同意' },
      { memberId: I.M_CLAUDE, stance: 'agree', reason: '同意' },
    ],
  },
];

/* ================= 最终报告（§6.6 模板） ================= */

const report12: FinalReport = {
  goal: '审查 src/ 六边界的实际依赖方向，找出违反契约的引用并给出可执行的重构步骤',
  participants: 'Codex、Claude、Codex#2（冻结名单 3 人）',
  actualParticipation: '3 人完成独立初稿；Codex#2 全程参与；Claude 在第 3 轮复核检查点迟到 22 分钟后纳入',
  baseline: 'baseline_a1f9（Git HEAD 3c91d2e + 2 个未提交修改文件，清单 214 个文件，排除 .git/node_modules）',
  confirmed: [
    { statement: 'contracts 未被任何上层反向引用，边界方向正确', evidence: '依赖图快照 deps_2026-09-19.svg，214 文件中命中 0 次反向引用' },
    { statement: 'daemon 与 adapter 之间存在双向 import，违反单向下行原则', evidence: 'src/adapter/codex/protocol.ts → src/daemon/ipc.ts 等 4 处' },
  ],
  plan: [
    '把 adapter 需要的 IPC 端点抽到 contracts/ipc.ts，daemon 只实现接口',
    'domain 中出现的 CodexEvent 类型改为 contracts 内的规范化事件联合类型',
    '在 eslint import 规则中固化六边界方向，禁止 domain → adapter 与 domain → persistence',
  ],
  disputes: [
    {
      statement: 'adapter 层是否应允许直接返回厂商原始事件对象（供诊断面板使用）',
      detail: 'Codex 认为诊断面板需要原始事件，应允许透传并在 contracts 中标注为 diagnostic-only；Claude#R2 认为任何厂商类型进入 contracts 都会泄漏到领域模型，主张原始事件只落盘不进内存契约。议题仍开放，未达成一致。',
    },
  ],
  verification: [
    { item: '依赖图静态扫描（自建脚本，含动态 import）', result: '已执行，见 changes/scan-deps.log' },
    { item: 'eslint 边界规则试跑', result: '未执行——需要先确定规则文件位置' },
    { item: '真实构建', result: '未执行（本期为只读分析任务）' },
  ],
  links: [
    { label: 'Codex 初稿 R1', ref: I.ART_12_CODEX_IND },
    { label: 'Claude 初稿 R1', ref: I.ART_12_CLAUDE_IND },
    { label: 'Codex#2 初稿 R1', ref: I.ART_12_CODEX2_IND },
  ],
  // 有未解决反对 + 迟到纳入，程序计算出的共识状态
  consensus: 'disputed',
};

/* ================= §3.1 成果 ================= */

export const artifacts: Artifact[] = [
  {
    id: I.ART_12_TEAM_REPORT,
    projectId: I.P_ZS,
    threadId: I.T_12,
    taskId: I.TASK_12,
    authorId: I.M_CODEX,
    kind: 'report',
    title: '模块划分审查 · 团队报告 R1（草稿，未发布）',
    revision: 1,
    hash: 'sha256:7b21c0d8',
    mimeType: 'text/markdown',
    sizeBytes: 24_812,
    createdAt: NOW - min(30),
    report: report12,
  },
  {
    id: I.ART_12_CODEX_IND,
    projectId: I.P_ZS,
    threadId: I.T_12,
    taskId: I.TASK_12,
    authorId: I.M_CODEX,
    kind: 'report',
    title: '独立初稿：daemon/adapter 双向引用清单',
    revision: 1,
    hash: 'sha256:3f9a11c4',
    mimeType: 'text/markdown',
    sizeBytes: 9_204,
    createdAt: NOW - min(88),
  },
  {
    id: I.ART_12_CLAUDE_IND,
    projectId: I.P_ZS,
    threadId: I.T_12,
    taskId: I.TASK_12,
    authorId: I.M_CLAUDE,
    kind: 'report',
    title: '独立初稿：厂商类型泄漏面与整改顺序',
    revision: 1,
    hash: 'sha256:a10e77b2',
    mimeType: 'text/markdown',
    sizeBytes: 11_530,
    createdAt: NOW - min(85),
  },
  {
    id: I.ART_12_CODEX2_IND,
    projectId: I.P_ZS,
    threadId: I.T_12,
    taskId: I.TASK_12,
    authorId: I.M_CODEX2,
    kind: 'report',
    title: '独立初稿：ui → persistence 直连统计',
    revision: 1,
    hash: 'sha256:c4d20f19',
    mimeType: 'text/markdown',
    sizeBytes: 7_640,
    createdAt: NOW - min(83),
  },
  {
    id: I.ART_11_REPORT,
    projectId: I.P_ZS,
    threadId: I.T_11,
    taskId: I.TASK_11,
    authorId: I.M_CODEX,
    kind: 'report',
    title: '表结构目录评审 · 带异议报告（预算耗尽）',
    revision: 2,
    hash: 'sha256:5e77b0aa',
    mimeType: 'text/markdown',
    sizeBytes: 16_128,
    createdAt: NOW - min(60 * 20),
  },
  {
    id: I.ART_13_PATCH_NOTE,
    projectId: I.P_ZS,
    threadId: I.T_13,
    taskId: I.TASK_13,
    authorId: I.M_CLAUDE,
    kind: 'attachment',
    title: 'path-fix.log（验证记录）',
    revision: 1,
    hash: 'sha256:91bb4d02',
    mimeType: 'text/plain',
    sizeBytes: 3_412,
    createdAt: NOW - min(9),
  },
];

/* ================= §14 改动集 ================= */

export const changeSets: ChangeSet[] = [
  {
    id: I.CS_13,
    projectId: I.P_ZS,
    taskId: I.TASK_13,
    workspaceId: 'ws_zs_primary',
    beforeRef: 'git:HEAD@3c91d2e + snapshot:snap_20260919_1042（含未提交内容前像，E15）',
    afterRef: 'git:WORKTREE@uncommitted',
    /**
     * v1.12 §10.5 迁移：原来这里是 status='pending_review'，把"文件已写入原目录"
     * 和"用户尚未验收"混成了一个字段。现在拆开：
     *  - 文件应用状态 → applicationStatus='applied'（直接原目录模式，改动**已经发生**，
     *    不能因为"还没验收"就说没应用，§14.3）
     *  - 人工验收 → delivery_13_r2（pending）
     */
    applicationStatus: 'applied',
    files: [
      {
        path: 'scripts/build-report.mjs',
        change: 'modified',
        additions: 14,
        deletions: 5,
        diff: [
          {
            header: '@@ -11,9 +11,18 @@ import { readFile, writeFile } from \'node:fs/promises\';',
            lines: [
              { type: 'ctx', text: "import { readFile, writeFile } from 'node:fs/promises';", oldNo: 11, newNo: 11 },
              { type: 'ctx', text: "import { resolve, join } from 'node:path';", oldNo: 12, newNo: 12 },
              { type: 'del', text: "const outDir = resolve(process.argv[2] ?? 'dist');", oldNo: 13 },
              { type: 'add', text: "// Windows 中文路径：必须先规范化为本地文件系统路径，", newNo: 13 },
              { type: 'add', text: "// 否则 Node 会把 'D:\\\\众说' 当成 URL 编码后的无效路径。", newNo: 14 },
              { type: 'add', text: "const outDir = resolve(fileURLToPath(pathToFileURL(process.argv[2] ?? 'dist')));", newNo: 15 },
              { type: 'ctx', text: '', oldNo: 14, newNo: 16 },
              { type: 'add', text: "// GBK 输出兜底：报告正文按 UTF-8 写盘，终端提示单独转码。", newNo: 17 },
              { type: 'ctx', text: 'await writeFile(join(outDir, \'report.md\'), md, \'utf8\');', oldNo: 15, newNo: 18 },
            ],
          },
        ],
      },
      {
        path: 'scripts/lib/paths.mjs',
        change: 'added',
        additions: 22,
        deletions: 0,
        diff: [
          {
            header: '@@ -0,0 +1,22 @@',
            lines: [
              { type: 'add', text: "import { fileURLToPath, pathToFileURL } from 'node:url';", newNo: 1 },
              { type: 'add', text: '', newNo: 2 },
              { type: 'add', text: '/** 把任意用户输入路径收敛为本机绝对路径。 */', newNo: 3 },
              { type: 'add', text: 'export function toLocalPath(input) {', newNo: 4 },
              { type: 'add', text: '  const url = pathToFileURL(input);', newNo: 5 },
              { type: 'add', text: '  return fileURLToPath(url);', newNo: 6 },
              { type: 'add', text: '}', newNo: 7 },
            ],
          },
        ],
      },
      {
        // E15：超限大文件显式警告无法内容级撤销
        path: 'fixtures/large-corpus.bin',
        change: 'modified',
        additions: 0,
        deletions: 0,
        cannotRevert: true,
        diff: [],
      },
      {
        // RT-10：用户在任务开始前已有的未提交改动，必须与任务改动区分
        path: 'docs/README.md',
        change: 'modified',
        additions: 3,
        deletions: 1,
        userPreExisting: true,
        diff: [
          {
            header: '@@ -1,4 +1,6 @@',
            lines: [
              { type: 'ctx', text: '# 众说', oldNo: 1, newNo: 1 },
              { type: 'del', text: '开发中。', oldNo: 2 },
              { type: 'add', text: '本地项目群聊多 Agent 协同工作台。', newNo: 2 },
              { type: 'add', text: '', newNo: 3 },
              { type: 'add', text: '> 本节由你在任务 #13 开始前手动修改，不属于任务改动。', newNo: 4 },
            ],
          },
        ],
      },
    ],
  },
  {
    id: I.CS_11,
    projectId: I.P_ZS,
    taskId: I.TASK_11,
    workspaceId: 'ws_zs_primary',
    beforeRef: 'git:HEAD@88a0f31',
    afterRef: 'git:HEAD@88a0f31（未产生写入）',
    /** 没有实际文件改动：not_applied（不是 pending_review——那个旧值已按 §10.5 拆分） */
    applicationStatus: 'not_applied',
    files: [],
  },
  {
    /**
     * notes-vault（**非 Git**）的改动集。
     *
     * 关键差别（E15 / §14.2）：非 Git 目录没有 ref 可用，前像必须是
     * **整目录快照**（内容级），而不是 git ref。这里如实写成 snapshot，
     * 用来验证界面不会对非 Git 项目假装有版本控制。
     */
    id: I.CS_NG1,
    projectId: I.P_NOTGIT,
    taskId: I.TASK_NG1,
    workspaceId: 'ws_ng_primary',
    beforeRef: 'snapshot:snap_notes_20260920_0900（整目录快照：非 Git 目录无 ref 可用，E15）',
    afterRef: 'snapshot:snap_notes_20260920_0930',
    applicationStatus: 'applied',
    files: [
      {
        path: 'docs/index.md',
        change: 'added',
        additions: 18,
        deletions: 0,
        diff: [
          {
            header: '@@ -0,0 +1,10 @@',
            lines: [
              { type: 'add', text: '# 笔记索引', newNo: 1 },
              { type: 'add', text: '', newNo: 2 },
              { type: 'add', text: '## 架构', newNo: 3 },
              { type: 'add', text: '- 2026-08-14 六边界与依赖方向.md', newNo: 4 },
              { type: 'add', text: '- 2026-09-02 目录锁域判定.md', newNo: 5 },
            ],
          },
        ],
      },
      {
        path: 'docs/meetings/2026-09-18-path-incident.md',
        change: 'modified',
        additions: 4,
        deletions: 1,
        diff: [
          {
            header: '@@ -6,3 +6,6 @@',
            lines: [
              { type: 'ctx', text: '根因：未先规范化路径就进入 fs 调用。', oldNo: 6, newNo: 6 },
              { type: 'del', text: '改进：待定。', oldNo: 7 },
              { type: 'add', text: '改进：路径先规范化再进 fs；报告正文按 UTF-8 写盘。', newNo: 7 },
            ],
          },
        ],
      },
    ],
  },
];

/* ================= §25.4 待我处理 ================= */

export const attention: AttentionItem[] = [
  {
    id: 'att_1',
    kind: 'decision',
    projectId: I.P_ZS,
    roomId: I.R_DEV,
    threadId: I.T_12,
    title: '议题 #12-2 需要你决定',
    detail: 'ui/ 是否允许直接 import persistence 的仓储类型。Codex 与 Claude 立场相反，程序不会替你选。',
    createdAt: NOW - min(12),
    requiresAction: true,
  },
  {
    id: 'att_2',
    kind: 'approval',
    projectId: I.P_ZS,
    roomId: I.R_DEV,
    threadId: I.T_13,
    title: 'Claude 请求执行 git commit',
    detail: '作用范围：仅本次，仅限 scripts/ 下的 2 个文件。到期未处理将自动拒绝。',
    createdAt: NOW - min(6),
    requiresAction: true,
  },
  {
    /**
     * 任务交付待办（v1.12 §10.5，第十四批）。
     *
     * 这是**唯一**的任务验收待办：任务 #13 的当前交付 r2。
     * 携带 deliveryId + deliveryRevision，因为：
     *  - 返工后 r3 会替换这条，旧页面上的按钮必须因版本不匹配而失败，
     *    不能批准到新结果（RT-25 ⑥）
     *  - 角标按 deliveryId 去重：同一交付的 2 个文件、1 个 ChangeSet、0 个 commit
     *    仍然只算 1 条，不会因为文件多就多出几张卡
     * 注意它**不是** approval（权限请求），两者机制独立：验收通过不会顺带批准权限。
     */
    id: 'att_delivery_13',
    kind: 'review',
    projectId: I.P_ZS,
    roomId: I.R_DEV,
    threadId: I.T_13,
    deliveryId: 'delivery_13_r2',
    deliveryRevision: 2,
    title: '任务 #13 的交付等你验收',
    detail: '修复 build 脚本中文路径失败，改动 2 个文件。验收只确认交付结果，不会提交或推送 Git。',
    createdAt: NOW - min(5),
    requiresAction: true,
  },
  {
    id: 'att_3',
    kind: 'absence',
    projectId: I.P_ZS,
    roomId: I.R_DEV,
    threadId: I.T_11,
    title: '任务 #11 有成员缺席后交付',
    detail: 'Claude 额度耗尽，报告以 unconfirmed 状态交付，未标注全体一致。',
    createdAt: NOW - min(60 * 19),
    requiresAction: true,
  },
  {
    id: 'att_4',
    kind: 'blocked',
    projectId: I.P_ZS,
    roomId: I.R_DEV,
    threadId: I.T_13,
    title: '写入目录当前被任务 #13 持有',
    detail: '任务 #14 的修改子步骤在排队；同物理目录最多 1 个受管理写入者。',
    createdAt: NOW - min(4),
    requiresAction: false,
  },
  {
    id: 'att_5',
    kind: 'mention',
    projectId: I.P_ZS,
    roomId: I.R_DEV,
    threadId: I.T_12,
    title: 'Codex 在 #12 中 @了你',
    detail: '「整合稿需要一个取舍决定：是否接受 R2 的条件性同意。」',
    createdAt: NOW - min(21),
    readAt: NOW - min(18),
    requiresAction: false,
  },
  {
    id: 'att_6',
    kind: 'done',
    projectId: I.P_ZS,
    roomId: I.R_DEV,
    threadId: I.T_11,
    title: '任务 #11 报告已交付',
    detail: '带异议交付（预算耗尽，19/19 次调用）。',
    createdAt: NOW - min(60 * 20),
    readAt: NOW - min(60 * 19),
    requiresAction: false,
  },

  /* ================= 第十五批：属于**非当前、且默认隐藏**项目的待办 =================
     为什么必须有这条数据：§17.7「底部范围固定」要求"待我处理默认汇总全部可访问项目，
     隐藏项目不丢待办"，但此前所有 attention 都属于众说（当前且可见），
     这条规则**无法被演示或验证**（实测：0 张卡片带"侧栏已隐藏"标记）。
     现在这条来自 data-backfill —— 默认不在侧栏显示，于是：
       ①待办总数包含它（隐藏 ≠ 丢掉）；
       ②卡片标出来源项目与"侧栏已隐藏"；
       ③点它会自动把该项目补进侧栏并聚焦。
     注意它的 requiresAction=true 且未读，会真实影响角标。 */
  {
    id: 'att_bf_approval',
    kind: 'approval',
    projectId: I.P_BACKFILL,
    roomId: I.R_BF_DEV,
    threadId: I.T_BF12,
    title: 'Codex 请求执行数据库写入',
    detail: '作用范围：仅本次，orders 表的增量回填批次（本项目默认不在侧栏显示，但待办不会因此丢失）。',
    createdAt: NOW - min(9),
    requiresAction: true,
  },
];

/* ================= 诊断（§18.1） ================= */

export const diagnostics: DiagnosticRecord[] = [
  {
    id: 'diag_1',
    at: NOW - min(2),
    level: 'info',
    message: 'outbox 派发：dsp_14_codex_plan → codex-app-server，租约 90s',
    trace: { projectId: I.P_ZS, taskId: I.TASK_14, runId: I.RUN_14, turnId: I.TURN_14_CODEX, dispatchKey: 'dsp_14_codex_plan', adapterVersion: 'zs-adapter-codex 0.1.0' },
  },
  {
    id: 'diag_2',
    at: NOW - min(9),
    level: 'warn',
    message: 'Claude 返回 costBasis=unknown，费用按"未知"呈现，不参与合计',
    trace: { projectId: I.P_ZS, taskId: I.TASK_12, runId: I.RUN_12, turnId: I.TURN_12_CLAUDE_IND, adapterVersion: 'zs-adapter-claude 0.1.0' },
  },
  {
    id: 'diag_3',
    at: NOW - min(11),
    level: 'info',
    message: '事件去重：completed 重复到达，replyCount 仅自增一次',
    trace: { projectId: I.P_ZS, taskId: I.TASK_12, runId: I.RUN_12, adapterVersion: 'zs-adapter-codex 0.1.0' },
  },
  {
    id: 'diag_4',
    at: NOW - min(22),
    level: 'warn',
    message: 'Claude 超过缺席容忍 20 分钟；已按缺席继续，不打断仍在运行的成员',
    trace: { projectId: I.P_ZS, taskId: I.TASK_12, runId: I.RUN_12, turnId: I.TURN_12_CLAUDE_REV },
  },
  {
    id: 'diag_5',
    at: NOW - min(35),
    level: 'error',
    message: '任务 #11 运行预算耗尽（19/19），发布带异议版本',
    trace: { projectId: I.P_ZS, taskId: I.TASK_11, runId: I.RUN_11 },
  },
  {
    id: 'diag_6',
    at: NOW - min(40),
    level: 'info',
    message: '局域网配对成功：设备「客厅 Surface」取得同等权限；配对码一次一用已失效',
    trace: { projectId: I.P_ZS },
  },
];

/* ================= §16.4 启动恢复（E7：不自动续跑） ================= */

export const startupRecovery: StartupRecovery = {
  needsAttention: true,
  checkedAt: NOW - min(1),
  awaitingUserConfirm: true,
  items: [
    {
      id: 'rec_1',
      kind: 'run',
      title: '任务 #12「分析模块划分并给出重构建议」',
      detail: 'WorkflowRun 处于 ISSUE_DISCUSSION 第 3 轮，2 个 turn 中断；进程已退出，会话可续接。',
      resumable: true,
      status: 'RUNNING',
    },
    {
      id: 'rec_2',
      kind: 'run',
      title: '任务 #13「修复 build 脚本在中文路径下失败」',
      detail: '写入租约仍被占用；需先核对进程是否真的退出，不能凭 PID 存在就认定是原进程。',
      resumable: true,
      status: 'RECONCILE_REQUIRED',
    },
    {
      id: 'rec_3',
      kind: 'result_unflushed',
      title: 'Claude 在任务 #12 的一份修订稿',
      detail: '工作目录已出现报告文件但数据库未引用（RT-04）。不会显示成功，可在恢复记录中核对。',
      resumable: false,
      status: 'UNKNOWN',
    },
    {
      id: 'rec_4',
      kind: 'run',
      title: '任务 #11 的表结构评审',
      detail: '已交付带异议报告，无未派发工作。',
      resumable: false,
      status: 'PARTIAL',
    },
  ],
};

/* ================= 状态装配 ================= */

export const initialState: AppState = {
  projects,
  activeProjectId: I.P_ZS,
  /**
   * 第十五批：可见项目只默认勾选当前项目（§17.7 第 4 条"首次使用只默认显示当前项目"）。
   * 其余项目由用户在顶栏菜单里勾选；这里不预先全选，否则"多选"这个功能
   * 在首次进入时就失去了示范意义，也无法验证"勾选只增加显示、不切焦点"。
   * store 启动时会被 localStorage 里的偏好覆盖（见 navPrefs.ts）。
   */
  visibleProjectIds: [I.P_ZS],
  expandedProjectIds: [I.P_ZS],
  pinnedProjectIds: [],
  fileGitTabs: {},
  runtimeInstallations,
  profiles: [
    { id: I.PROF_CODEX, name: 'Codex 实现者', description: '实现与重构，偏好直接给结论', runtimeInstallationId: I.RT_CODEX },
    { id: I.PROF_CLAUDE, name: 'Claude 审查者', description: '审查与反例，偏好保留条件', runtimeInstallationId: I.RT_CLAUDE },
    { id: I.PROF_CODEX2, name: 'Codex 校验者', description: '专项核对与证据补齐', runtimeInstallationId: I.RT_CODEX },
  ],
  members,
  rooms,
  threads,
  /** 私信会话（决策 24，M3 批次）：同一成员可以有多个私聊，且可归档 */
  dms: [
    {
      id: 'dm_1',
      projectId: I.P_ZS,
      title: 'Claude · 评审口径',
      memberIds: [I.M_CLAUDE],
      threadId: 'dm_thread_1',
      createdAt: NOW - min(60 * 26),
      lastMessageAt: NOW - min(35),
      unread: 2,
      pinned: true,
    },
    {
      id: 'dm_2',
      projectId: I.P_ZS,
      title: 'Claude · 另一条线：测试策略',
      memberIds: [I.M_CLAUDE],
      threadId: 'dm_thread_2',
      createdAt: NOW - min(60 * 8),
      lastMessageAt: NOW - min(60 * 3),
      unread: 0,
    },
    {
      id: 'dm_3',
      projectId: I.P_ZS,
      title: 'Codex · 重构排期',
      memberIds: [I.M_CODEX],
      threadId: 'dm_thread_3',
      createdAt: NOW - min(60 * 50),
      lastMessageAt: NOW - min(60 * 20),
      unread: 0,
    },
    {
      id: 'dm_4',
      projectId: I.P_ZS,
      title: 'Codex · 周报分工',
      memberIds: [I.M_CODEX],
      threadId: 'dm_thread_4',
      createdAt: NOW - min(60 * 4),
      lastMessageAt: NOW - min(60 * 2),
      unread: 1,
    },
    {
      id: 'dm_5',
      projectId: I.P_ZS,
      title: 'Codex · 已归档：上周的对账',
      memberIds: [I.M_CODEX],
      threadId: 'dm_thread_5',
      createdAt: NOW - min(60 * 24 * 9),
      lastMessageAt: NOW - min(60 * 24 * 7),
      archivedAt: NOW - min(60 * 24 * 6),
      unread: 0,
    },
    /* 第十七批：另一个项目的私信。
       统一私信入口要能证明两件事：跨项目会话并列展示、**两个项目里同名的 Codex
       是两条独立会话**（按 conversationId/projectId 隔离，不合并）。 */
    {
      id: 'dm_bf_1',
      projectId: I.P_BACKFILL,
      title: 'Codex · 回填口径确认',
      memberIds: [I.M_BF_CODEX],
      threadId: 'dm_thread_bf_1',
      createdAt: NOW - min(60 * 20),
      lastMessageAt: NOW - min(60 * 5),
      unread: 1,
    },
  ],
  messages,
  tasks,
  runs,
  turns,
  artifacts,
  /* ---------- UX-PREVIEW-01：共享预览资源层（§17.9） ----------
     普通主池附件在这里，**没有 taskId** —— 旧 Artifact 模型无法表示它们。 */
  resources: seedResources,
  messageAttachments: seedMessageAttachments,
  /** 预览会话：初始无标签、未收起 */
  preview: {
    tabs: [],
    activeKey: undefined,
    hidden: false,
    maximized: false,
    returnSnapshot: undefined,
    contextChangedSinceOpen: false,
  },
  pendingQuotes: [],
  changeSets,
  /** 任务交付版本（v1.12 §10.5）；人工验收的唯一权威来源 */
  taskDeliveries,
  /** Git 集成（按项目）。非 Git 目录留空对象，界面据此如实说明"不是仓库" */
  git: gitStates,
  issues,
  attention,
  reminders: [
    {
      id: 'rem_1',
      ownerMemberId: I.M_CLAUDE,
      threadId: I.T_13,
      taskId: I.TASK_13,
      timezone: 'Asia/Shanghai',
      schedule: '每工作日 09:30',
      nextRunAt: NOW + min(60 * 14),
      enabled: true,
    },
    {
      id: 'rem_2',
      ownerMemberId: I.M_CODEX,
      threadId: I.T_12,
      taskId: I.TASK_12,
      timezone: 'Asia/Shanghai',
      schedule: '一次性 · 明天 10:00',
      nextRunAt: NOW + min(60 * 20),
      enabled: false,
    },
  ],
  devices: [
    {
      id: 'dev_local',
      name: '这台电脑（本机界面）',
      kind: 'this-machine',
      address: '127.0.0.1',
      pairedAt: NOW - min(60 * 24 * 30),
      lastSeenAt: NOW,
      tokenPrefix: 'zs_tok_local',
    },
    {
      id: 'dev_surface',
      name: '客厅 Surface',
      kind: 'lan',
      address: '192.168.1.37',
      pairedAt: NOW - min(40),
      lastSeenAt: NOW - min(3),
      tokenPrefix: 'zs_tok_9f3c',
    },
    {
      id: 'dev_thinkpad',
      name: '旧 ThinkPad',
      kind: 'lan',
      address: '192.168.1.52',
      pairedAt: NOW - min(60 * 24 * 12),
      lastSeenAt: NOW - min(60 * 24 * 11),
      tokenPrefix: 'zs_tok_11ab',
    },
  ],
  diagnostics,
  startupRecovery,
  readStates: {
    [I.T_12]: 13,
    [I.T_13]: 9,
    [I.T_14]: 5,
    [I.T_11]: 7,
    [I.T_D1]: 4,
  },
  subscriptions: {
    [I.T_12]: { followed: true, muted: false },
    [I.T_13]: { followed: true, muted: false },
    [I.T_14]: { followed: true, muted: false },
    [I.T_11]: { followed: true, muted: true },
    [I.T_D1]: { followed: false, muted: false },
  },
  // 13B：跟进名单。移出=停止自动唤醒，历史保留，可再 @ 回来
  followers: {
    [I.T_12]: [I.M_CODEX, I.M_CLAUDE, I.M_CODEX2],
    [I.T_13]: [I.M_CLAUDE],
    [I.T_14]: [I.M_CODEX],
    [I.T_11]: [I.M_CODEX, I.M_CODEX2],
  },
  absence: {
    [I.T_12]: { memberId: I.M_CLAUDE, since: NOW - min(24), graceMs: min(20), continued: true },
  },
  /**
   * 写入租约按项目持有（§10.3：锁域是"同一物理原目录"）。
   * 这里只给众说一个租约（任务 #13 正在改 scripts/），
   * 其他项目（data-backfill / notes-vault）**没有租约** ——
   * 这样"看别的项目不会显示众说的锁"是可验证的，而不是靠运气。
   */
  writeLocks: {
    [I.P_ZS]: {
      lockDomain: 'D:\\zhongshuo（vol:D: / fileid:0x0002a91c）',
      ownerTaskId: I.TASK_13,
      ownerTaskLabel: '任务 #13 修复 build 脚本在中文路径下失败',
      parallelHolders: [I.TASK_13],
    },
  },
  drafts: {
    [`room:${I.R_DEV}`]: '',
    [`thread:${I.T_12}`]: '',
  },
  /** 结构化引用草稿（UX-PREVIEW-01）：与正文分开保存，保留版本身份 */
  draftRefs: {},
  /** 布局偏好与实际自适应结果（§5.2/§5.3） */
  layout: {
    sizes: {},
    navAutoHidden: false,
    navPinned: false,
  },
  /** 应用级设置（第十六批）：真实内存值，点击即变，不再是写死的 checked */
  appSettings: {
    launchAtLogin: true,
    keepInTray: true,
    // E7：重启后**不**自动续跑是默认值，必须先列出可继续任务等用户确认
    autoResumeTasks: false,
  },
  ui: {
    theme: 'light',
    activeRoomId: I.R_DEV,
    writeLog: [],
  },
};
