/**
 * 众说原型 · 领域模型类型
 * 严格对齐设计报告 v1.8 §3.1 对象层级与 §12.2 表结构目录。
 * 原型不落库，但命名与关系保持与 daemon 契约一致。
 */

/* ---------- §10.1 状态机（业务状态与执行状态分离） ---------- */

export type TaskStatus =
  | 'OPEN'
  | 'ACTIVE'
  | 'WAITING_USER'
  | 'BLOCKED'
  | 'REVIEW'
  | 'DONE'
  | 'CANCELLED';

export type RunStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING'
  | 'STOPPING'
  | 'SUCCEEDED'
  | 'PARTIAL'
  | 'FAILED'
  | 'CANCELLED'
  | 'INTERRUPTED';

export type TurnStatus =
  | 'PENDING'
  | 'DISPATCHING'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'WAITING_INPUT'
  | 'STOPPING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'UNKNOWN';

export type MemberWorkState = 'running' | 'idle' | 'waiting' | 'error' | 'offline' | 'stopped';

/* ---------- §4.2 路由模式 ---------- */

/** AUTO=无 mention 由协调者接单；DELIBERATE=@全体/多 @ 共同研讨；DIRECT=@单人 */
export type RouteMode = 'AUTO' | 'DELIBERATE' | 'DIRECT';

/**
 * 顶层输入的发送意图（**2026-09-25 调整**）。
 *
 * 旧模型是常驻二选一 `'task' | 'discussion'`（决策 21 / E1）：用户每次都要先声明
 * 这次是"发起任务"还是"纯备注"。用户确认后改为：**普通输入默认与 AI 交流**，
 * 只想留字不留回复时用一次性的「仅记录，不请求回复」。
 *
 * 因此这里只剩两种：
 *  - `'ai'`     —— 交给 AI：主池新建根任务、任务串跟进当前任务（沿用既有路由与预算）；
 *  - `'record'` —— 仅记录：保存消息，不创建运行、不调用模型、不计预算、不 steering。
 * 内部任务引擎、任务号与持久化契约都不因这次改名而改变。
 */
export type InputIntent = 'ai' | 'record';

/** E6 定案：方式芯片，由 @ 结构推导，不手选协作模式 */
export type MethodChip =
  | { kind: 'plan_first'; on: boolean }      // 决策 03：不 @ 时「先给方案再执行」
  | { kind: 'skip_first_draft'; on: boolean } // 决策 05：@全体 时「跳过独立首稿」
  | { kind: 'split_work'; on: boolean };      // 决策 09：多 @ 时「分工执行」

/* ---------- §6.1 研讨阶段 ---------- */

export type StageKey =
  | 'PREPARE'
  | 'INDEPENDENT'
  | 'CROSS_REVIEW'
  | 'ISSUE_DISCUSSION'
  | 'SYNTHESIS'
  | 'RATIFY'
  | 'PUBLISH';

/** §6.5 共识状态：程序按确认记录计算，主持者不能单方面改写 */
export type Consensus = 'unanimous' | 'qualified' | 'disputed' | 'unconfirmed';

/* ---------- §16.5 统一错误码 ---------- */

export type ErrorCode =
  | 'RUNTIME_NOT_FOUND'
  | 'AUTH_REQUIRED'
  | 'CAPABILITY_UNSUPPORTED'
  | 'PROVIDER_LIMITED'
  | 'PROJECT_MISSING'
  | 'WORKSPACE_BUSY'
  | 'BASELINE_CHANGED'
  | 'OUTPUT_INVALID'
  | 'STALE_REVISION'
  | 'STORAGE_UNAVAILABLE'
  | 'WORKER_STILL_RUNNING'
  | 'RECONCILE_REQUIRED'
  | 'BUDGET_EXHAUSTED'
  | 'ARTIFACT_MISSING'
  | 'THREAD_SCOPE_MISMATCH'
  | 'CONTEXT_NOT_GRANTED'
  | 'ROOM_ARCHIVED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'SNAPSHOT_REQUIRED'
  /** 第十五批：深链/路由里的项目 ID 不存在或不可访问（不回落成"当前项目的同号对象"） */
  | 'PROJECT_NOT_FOUND';

/* ---------- 实体 ---------- */

export interface Project {
  id: string;
  displayName: string;
  /** 用户原始路径（§3.3 保留原始路径与解析后物理路径） */
  rootPath: string;
  canonicalPath: string;
  /** 目录身份；junction/符号链接检测依据（RT-09 目录锁域） */
  directoryIdentity: string;
  status: 'ok' | 'missing';
  revision: number;
  isGit: boolean;
  gitBranch?: string;
  /** 项目描述（可编辑，只影响显示，不写磁盘；见 updateProjectInfo） */
  description?: string;
  /**
   * 项目归档（第十七批 §八/§十）。
   *
   * 语义：**保留历史、退出日常项目树**，不是删除 —— 归档后其下房间不能发消息、
   * 建任务或被调度唤醒；恢复项目时**原本单独归档的房间仍保持归档**（不动 room.archivedAt）。
   * 与"隐藏"（只影响侧栏显示）和"移除"（从项目列表移除关联）是三件不同的事。
   */
  archivedAt?: number;
  /** 项目移除：从应用项目列表移除关联，**不删除磁盘文件、不丢弃历史数据**；可在设置里重新关联 */
  removedAt?: number;
  /**
   * 写入并发策略（v1.9 §14.1 / E20）。
   * single_writer 为默认：同一物理原目录最多 1 个受管理写入者。
   * parallel_writers 由用户在项目设置手动开启，必须同时满足 §14.1 的底线约束。
   */
  writeConcurrencyPolicy?: 'single_writer' | 'parallel_writers';
  /** 并行模式下的写入者上限（默认建议 2，超出排队） */
  maxParallelWriters?: number;
  /**
   * 任务验收开关（v1.12 §10.5 / RT-25，第十四批）。
   *
   * 语义：开启后任务交付需要用户确认；关闭后满足交付要求即 DONE。
   * 关键约束：
   *  - **只影响之后创建的用户任务**（创建时快照进 Task.reviewPolicy），
   *    不批量改变已有任务/待验收卡。
   *  - **与是否 Git 仓库无关**，也不放进成员权限下拉。
   *  - 关闭不等于自动批准权限、自动提交/推送或"测试通过"。
   *  - 缺字段的旧项目按 §10.5 保守迁移为开启，并标注"沿用旧项目的人工验收设置"。
   */
  taskReviewEnabled?: boolean;
  /** 该项目的 taskReviewEnabled 是否来自旧规则迁移（界面需如实标注来源） */
  taskReviewMigrated?: boolean;
  /**
   * 循环与预算的可配置项（§10.4）。
   * E4 要求缺席容忍"默认 20 分钟、可设置"；turnDeadline 分析/修改分别取值。
   */
  loopSettings?: {
    absenceGraceMin: number;
    analysisTurnDeadlineMin: number;
    modifyTurnDeadlineMin: number;
    maxConcurrentTurns: number;
  };
}

export interface RuntimeInstallation {
  id: string;
  /** 首版仅 Codex App Server 与 Claude Code headless（决策 37、§9.1） */
  kind: 'codex-app-server' | 'claude-code-headless';
  label: string;
  executable: string;
  version: string;
  adapterVersion: string;
  health: 'ready' | 'not_installed' | 'not_logged_in' | 'unverified' | 'incompatible';
  /** 能力协商结果；界面按真实能力显示，不承诺做不到的隔离（§9.3/ADR-14） */
  capabilities: {
    streaming: boolean;
    toolEvents: boolean;
    usage: boolean;
    interrupt: boolean;
    resume: boolean;
    /** 受控文件读取限制；v0.1 为 false，强制拦截归 DEV-20 */
    restrictedRead: boolean;
  };
}

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  runtimeInstallationId: string;
}

export interface ProjectMember {
  id: string;
  projectId: string;
  profileId: string;
  displayName: string;
  /** 同一 runtime 的第二成员实例用序号消歧（§3.2） */
  ordinal?: number;
  enabled: boolean;
  workState: MemberWorkState;
  workStateReason?: string;
  /** 决策 38：成员级模型与思考强度 */
  model: string;
  effort: 'low' | 'medium' | 'high';
  /** 决策 11：runtime 内部子助手开关，计入用量 */
  internalSubagents: boolean;
  isCoordinatorDefault: boolean;
}

export interface Room {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  /** E5：协调者是房间级字段 rooms.coordinator_member_id */
  coordinatorMemberId: string;
  memberIds: string[];
  archivedAt?: number;
  revision: number;
  unread: number;
}

export interface Thread {
  id: string;
  projectId: string;
  roomId: string;
  anchorMessageId: string;
  /** E1：讨论串 root_task_id 为空 */
  rootTaskId?: string;
  status: 'open' | 'archived';
  lastMessageSeq: number;
  revision: number;
}

/* ---------- §17.9：线程内部视图键 ----------
   定义放在 types.ts（本文件不 import 任何模块），由 lib/threadNav.ts 转出，
   避免 types ↔ threadNav 的循环引用。 */
export type ThreadTabKey =
  | 'replies'
  | 'artifacts'
  | 'activity'
  | 'members'
  | 'task'
  /** v1.12 §10.5：任务交付详情（可选验收的唯一主入口） */
  | 'delivery'
  | 'deliberation'
  | 'run';

export interface Message {
  id: string;
  projectId: string;
  roomId: string;
  /** 顶层消息为 undefined（thread_id = NULL） */
  threadId?: string;
  taskId?: string;
  replyToMessageId?: string;
  threadMessageSeq?: number;
  authorType: 'human' | 'agent' | 'system' | 'third_party_app';
  authorId: string;
  kind: MessageKind;
  body: string;
  createdAt: number;
  /** 流式消息：in-place 更新，终结时保存完整版本（§17.3） */
  streaming?: boolean;
  /**
   * 该消息携带的资源附件（UX-PREVIEW-01）。
   *
   * 用 ID 关联而不是内嵌资源：同一资源可能被多处消息引用，
   * 且引用/评论要绑定固定版本。**主池消息也可以有附件**，
   * 不需要 taskId —— 这正是旧 Artifact 模型做不到的事。
   */
  attachmentIds?: string[];
  reactions?: { emoji: string; by: string[] }[];
  saved?: boolean;
  /** §17.3 结构化卡片载荷 */
  payload?: MessagePayload;
  errorCode?: ErrorCode;
}

export type MessageKind =
  | 'text'
  | 'progress'
  | 'assignment'
  | 'report'
  | 'dispute'
  | 'approval'
  | 'result'
  | 'system';

export interface MessagePayload {
  /** 成员进度消息的结构化摘要；没有该字段时 UI 仍会按进度消息渲染降级卡片。 */
  progress?: ProgressCard;
  assignment?: AssignmentCard;
  report?: ReportCard;
  dispute?: DisputeCard;
  approval?: ApprovalCard;
  result?: ResultCard;
  system?: SystemCard;
  mentionIds?: string[];
  /**
   * 仅记录（2026-09-25）：这条消息是"只留字、不请求 AI 回复"保存下来的。
   *
   * 用途是把**非派发**这件事留在数据里而不是只在界面上：列表与详情据此标注「记录」，
   * 自动化用例也据此断言"没有产生模型派发"。历史讨论串里的消息同样带这个标记
   * （它们是同一件事的旧名字），但**不会**被自动升级成 AI 任务。
   */
  recordOnly?: boolean;
}

/**
 * 成员进度消息的**附加**语义。
 *
 * 进度消息本身是一条普通消息（§17.3：简短发现、正在处理的内容、必要协作请求），
 * 正文就是 `Message.body`，不另外做一张卡片。
 * 这里只承载一件事：需要被看见的**异常**状态。
 *
 * 刻意不包含这些字段，它们都是这次修掉的 bug 的来源：
 *  - summary：正文就是摘要，另开字段等于两份正文
 *  - running / done / waiting：消息既然已经发出来，它就已经是过去时了，
 *    "进行中"没有信息量；执行状态属于 run / turn，不属于某条消息
 *  - 成员：作者已经在消息头写着，再渲染一次就是重复
 *  - stage：阶段推进由系统卡（"阶段推进 · X → Y"）明确标注，
 *    给每条进度都挂一个阶段标签只会造成噪声
 * 不填 = 不显示，没有兜底占位文字。
 */
export interface ProgressCard {
  status?: 'blocked' | 'late';
}

export interface AssignmentCard {
  /** 分工卡：负责人、子任务、依赖、交付标准、跳转入口 */
  subtasks: {
    key: string;
    taskId: string;
    number: number;
    title: string;
    assigneeMemberId: string;
    objective: string;
    dependsOn: string[];
    access: 'analyze' | 'modify';
    deliverable: string;
    acceptance: string[];
    status: TaskStatus;
  }[];
  integrationPlan: string;
}

export interface ReportCard {
  artifactId: string;
  memberId: string;
  revision: number;
  baselineId: string;
  summary: string;
  claimCount: number;
  openQuestions: number;
  lateIncluded?: boolean;
}

export interface DisputeCard {
  issueId: string;
  statement: string;
  revision: number;
  status: 'open' | 'resolved' | 'needs_user' | 'insufficient_evidence';
  positions: { memberId: string; stance: 'agree' | 'disagree' | 'needs_evidence' | 'unconfirmed'; reason: string }[];
}

export interface ApprovalCard {
  approvalId: string;
  memberId: string;
  taskId: string;
  action: string;
  scope: string;
  payloadHash: string;
  expiresAt: number;
  decision?: 'allow_once' | 'deny';
}

export interface ResultCard {
  outcome: 'succeeded' | 'partial' | 'failed';
  /**
   * 仅研讨（DELIBERATE）有共识语义（§6.5）。
   * DIRECT / AUTO 不适用时为 undefined —— 界面不渲染共识标签，
   * 而不是套一个"全体一致"造成假共识。
   */
  consensus?: Consensus;
  artifactIds: string[];
  changeSetIds: string[];
  absentMemberIds: string[];
  lateMemberIds: string[];
  note: string;
}

export interface SystemCard {
  tone: 'info' | 'warn' | 'error';
  title: string;
  detail: string;
  actions?: { label: string; api: string }[];
  /**
   * 这条系统卡的**归属视图**（界面信息减负施工任务书 §4）。
   *
   * - `'process'`：正常的过程说明（路由推导、程序校验通过、派发规则、阶段推进）。
   *   它解释"系统是怎么运转的"，不是"你要做什么"，因此不长期占回复区域，
   *   移到「详情 → 活动与进展」（任务概况仍给出本任务的派发摘要）。
   * - `'action'`（或未填）：需要用户看见/处理（授权、校验失败、阻塞、预算耗尽、
   *   成员不可用、待决定分歧、人工审阅）。
   *
   * 为什么用显式字段而不是"tone === 'info' 就当噪声"：很多需要你处理的卡片
   * 也是 info 色调（"议题 #12-2 已标记为 needs_user""代码需人工审阅"），
   * 按色调过滤会把它们一起藏起来。**未标记的一律留在回复视图**：
   * 宁可多显示一条，不可漏掉一条待处理。
   */
  scope?: 'process' | 'action';
}

export interface Task {
  id: string;
  projectId: string;
  roomId: string;
  conversationThreadId: string;
  rootMessageId?: string;
  /** 房间内递增显示号；ID 才是稳定主键（§25.5） */
  roomTaskNumber: number;
  ownerMemberId?: string;
  parentTaskId?: string;
  title: string;
  objective: string;
  status: TaskStatus;
  revision: number;
  reviewPolicy: 'auto_deliver' | 'user_review';
  /** 当前交付版本（v1.12 §10.5）；一个任务最多一个 pending 交付 */
  currentDeliveryId?: string;
  mode: RouteMode;
  displayNumber: number;
}

/**
 * 任务交付版本（v1.12 §10.5 / RT-25）。
 *
 * 为什么需要它，而不是直接用 ChangeSet 或 commit：
 *  - 用户任务的一次交付可能包含**多个 Agent、多个文件、多个 ChangeSet 和多次 commit**，
 *    而用户只需要对"这一次交付"做一次决定 → 所以必须有任务级的交付实体。
 *  - Git commit 表示"内容是否进入版本历史"，ChangeSet.applicationStatus 表示
 *    "文件是否已应用"，本实体表示"人工验收"。**三者必须分别保存，不能互相推断。**
 *  - 只允许一个当前 pending 版本；返工发布新版本时 revision 递增并**替换**当前待办，
 *    不追加第二条未处理卡；旧版与意见保留可查。
 */
export interface TaskDelivery {
  id: string;
  taskId: string;
  runId: string;
  /** 交付版本号，从 1 递增；返工一次加一 */
  revision: number;
  /** 冻结清单的 hash：验收决定必须针对它校验，避免批准到更新的内容 */
  manifestHash: string;
  status: 'pending' | 'accepted' | 'changes_requested' | 'not_required';
  /** 完成摘要（验收详情第一屏，先于 diff） */
  summary: string;
  /** 可用效果预览；原型为 mock，不声称真实运行 */
  preview?: { label: string; detail: string }[];
  /** 实际执行的验证与**未执行**的原因（不写"真实测试通过"） */
  verification: {
    label: string;
    result: 'passed' | 'failed' | 'not_run';
    detail: string;
  }[];
  /** 残余问题：交付时仍未解决的部分 */
  residuals: string[];
  artifactRefs: string[];
  changeSetRefs: string[];
  /** 关联的 commit（仅用于展示"这批提交属于本次交付"，不作为验收依据） */
  commitRefs?: string[];
  createdAt: number;
  reviewedBy?: string;
  reviewedAt?: number;
  /** 要求修改时的必填意见 */
  reviewNote?: string;
}

export interface WorkflowRun {
  id: string;
  taskId: string;
  threadId: string;
  mode: RouteMode;
  taskRevision: number;
  status: RunStatus;
  stage: StageKey;
  roundNo: number;
  rosterRevision: number;
  budget: {
    maxAgentTurns: number;
    usedAgentTurns: number;
    /** E12：核心 6N+1；含修订 7N+2 */
    formula: string;
    reservedTail: number;
    mustReserve?: string;
  };
  consensus?: Consensus;
}

export interface AgentTurn {
  id: string;
  runId: string;
  threadId: string;
  memberId: string;
  stageKey: StageKey;
  attempt: number;
  epoch: number;
  status: TurnStatus;
  dispatchKey: string;
  startedAt: number;
  durationMs?: number;
  /** E4：缺席容忍计时，与 turnDeadline 职责分开 */
  absenceGraceMs: number;
  turnDeadlineMs: number;
  usage?: UsageRecord;
}

export interface UsageRecord {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** 费用三态：reported / estimated / unknown。未知不得显示为 0 */
  costQuality: 'reported' | 'estimated' | 'unknown';
  costAmount: number | null;
}

export interface Artifact {
  id: string;
  projectId: string;
  threadId: string;
  taskId: string;
  authorId: string;
  kind: 'report' | 'attachment' | 'export';
  title: string;
  revision: number;
  hash: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  /** §6.6 最终报告模板结构 */
  report?: FinalReport;
}

/* ============================================================
   UX-PREVIEW-01 / §17.9：资源契约（A 阶段核心）
   ============================================================

   为什么必须新增这一层，而不是给 Artifact 打补丁：
   `Artifact` 的 `taskId` / `threadId` 都是**必填**，而且 Message 完全没有
   附件字段。于是「主池里一条普通消息的附件」在旧模型下**无法表示** ——
   一旦要预览它，就会被逼着伪造一个 taskId（§17.9 第 1 条明确禁止）。

   所以这里把「可预览的资源」独立建模：资源有自己的身份与固定版本，
   通过 `MessageAttachment` 关联到消息，`taskId` 可以为空。
   Artifact 继续表示"任务成果"，不强行承载普通附件。

   边界（§3 / §17.9 第 10 条）：原型只用 mock fixture 提供**真实可解码的静态内容**，
   不读取真实磁盘、不做 Office 转换。真实资源服务属 DEV-01 契约增量。
*/

/**
 * 资源的**固定版本**。同一 resourceId 的不同 revision 是不同内容，
 * 因此引用/评论绑定的是 (resourceId, revision) 而不是"最新版"（§17.9 第 5 条）。
 */
export interface ResourceRevision {
  /** 版本号；成果/附件快照固定，工作区读取为递增读取代次 */
  revision: number;
  /** 内容 hash：同一快照必须可重复读取相同内容，不匹配即报错 */
  hash: string;
  sizeBytes: number;
  createdAt: number;
  /** 该版本的内容；工作区"当前文件"由 latestRevision 指向 */
  content: ResourceContent;
}

/**
 * 资源内容。**kind 决定渲染器**，不靠扩展名猜（§8.1 格式矩阵）。
 *
 * 这里只实现原型**真实可渲染**的类型；Office/PDF/视频等按 §8.1
 * 给出明确的「不支持/仅模拟」状态，绝不用假正文冒充真实解析
 * （施工说明 §3、§8.1 范围核对）。
 */
export type ResourceContent =
  | { kind: 'markdown'; text: string }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'csv'; text: string }
  | { kind: 'image'; mimeType: string; dataUrl: string; width: number; height: number }
  | { kind: 'diff'; left: string; right: string; leftLabel: string; rightLabel: string }
  /** 后端/转换能力未接通：如实显示，不假装能读 */
  | { kind: 'unsupported'; reason: UnsupportedReason; note: string };

export type UnsupportedReason =
  | 'not_connected'   // 真实读取/转换服务未接通（PDF/Office/视频）
  | 'binary'          // 二进制，不按文本预览
  | 'too_large'       // 过大，按需加载未实现
  | 'corrupt';        // 内容损坏/解码失败

/**
 * 资源本体。`origin` 描述它**真实属于哪里**（§17.9 第 1 条），
 * 与"这次从哪里点开"（openedFrom）是两件事。
 */
export interface PreviewResource {
  id: string;
  projectId: string;
  kind: 'artifact' | 'attachment' | 'worktree';
  title: string;
  /** 项目内相对路径（工作区资源）或展示用文件名 */
  relativePath?: string;
  mimeType: string;
  /** 真实归属：任务成果 / 房间消息附件 / 项目工作区文件 */
  origin: ResourceOrigin;
  /**
   * audience 可见范围（§17.9 第 7 条）。
   * 私信附件不能被同项目的群聊当成公共资源 —— 仅比较 projectId 不足以判断可见性。
   */
  audience: ResourceAudience;
  /** 固定版本表；至少一个 */
  revisions: ResourceRevision[];
  /** 工作区资源会随磁盘变化；成果/附件快照固定 */
  mutable?: boolean;
  createdAt: number;
  authorId?: string;
}

export type ResourceOrigin =
  | { kind: 'task'; taskId: string; threadId: string; roomId: string }
  | { kind: 'message'; messageId: string; roomId: string; threadId?: string }
  | { kind: 'dm'; conversationId: string; messageId?: string }
  | { kind: 'workspace' };

export type ResourceAudience =
  /** 群聊/房间可见 */
  | { kind: 'room'; roomId: string }
  /** 私信独立 audience（§17.9 第 7 条） */
  | { kind: 'dm'; conversationId: string; memberIds: string[] }
  /** 项目工作区：项目成员可见 */
  | { kind: 'project' };

/**
 * 消息与资源的关联。**这是"主池普通附件能预览"的关键**：
 * 附件挂在消息上，消息可以没有 taskId / threadId。
 *
 * 为什么不让 Message 直接内嵌完整资源：资源有版本与 hash，
 * 引用/评论要绑定固定版本；内嵌会让"同一资源多处引用"各存一份而无法去重。
 */
export interface MessageAttachment {
  id: string;
  messageId: string;
  resourceId: string;
  /** 引用时默认使用的版本（附件快照固定；工作区可指向"当前读取"） */
  revision: number;
  /** 展示排序 */
  ordinal: number;
}

/**
 * 结构化引用（施工说明 §5.A.2）。
 *
 * 只保存 name/size 的旧附件**无法复原可读内容** ——
 * 不能靠文件名猜路径生成资源（会造出指向任意文件的伪引用）。
 * 因此旧草稿迁移时保留文字并标「需重新附加」（PV-36）。
 */
export interface DraftReference {
  resourceId: string;
  revision: number;
  hash: string;
  title: string;
  /** 摘录（用于引用卡展示） */
  excerpt?: string;
  /** 锚点：行范围 / 段落 / 单元格等（§7.3） */
  anchor?: ReferenceAnchor;
  /** 迁移失败标记：只保留了旧 name/size，内容已不可得 */
  needsReattach?: boolean;
}

export type ReferenceAnchor =
  | { kind: 'lines'; from: number; to: number }
  | { kind: 'paragraph'; text: string }
  | { kind: 'csv'; fromRow: number; toRow: number }
  | { kind: 'page'; page: number };

/** 预览标签页（§11.1）。key 含资源身份与固定版本，不用 basename */
export interface PreviewTab {
  key: string;
  resourceId: string;
  /** 该标签正在看的版本；工作区资源可重新读取而更新 */
  revision: number;
  /**
   * 本次打开位置（§17.9 第 1 条）。
   * 与 resource.origin 不同：例如在主池点开一份属于任务 #14 的成果，
   * origin 是 #14，openedFrom 是主池消息。
   */
  openedFrom: ContextLocation;
  /** 阅读位置，关闭/收起后恢复 */
  scrollTop: number;
  /** 标签创建顺序（用户可拖动调整，这里只记初始顺序） */
  ordinal: number;
  /** 请求代次：迟到响应不得覆盖新目标（§17.9 第 9 条 / PV-16/17） */
  requestGeneration: number;
  /**
   * 已从磁盘重新读取所需的新版本（PV-09）：
   * 文件更新只提示，不抢正文 —— 用户点击"重新加载"才切换。
   */
  pendingRevision?: number;
}

/** 工作上下文位置（§11.1 ContextTarget / ContextLocation） */
export type ContextTarget =
  | { kind: 'room'; projectId: string; roomId: string; view: 'chat' | 'tasks' | 'files' }
  | { kind: 'thread'; projectId: string; roomId: string; threadId: string; tab: ThreadTabKey }
  | { kind: 'dm'; projectId: string; conversationId: string; threadId?: string }
  /**
   * 项目文件/Git 工作区（L5）。
   *
   * **必须独立建模，不能借一个虚构 roomId 复用房间路由** ——
   * 那会让"这份文件来自某个房间"变成一句假话，来源栏、引用目标
   * 与 audience 判定都会跟着错（§7.5 明确禁止）。
   */
  | { kind: 'files'; projectId: string; view: 'files' | 'git'; selection?: string };

export interface ContextLocation {
  target: ContextTarget;
  /** 打开时的具体消息（"返回来源"要定位到它） */
  messageId?: string;
  /** 来源是搜索/收藏结果时的返回条件（§3.2 / PV-33） */
  fromSearch?: { kind: 'search' | 'saved'; query: string; returnRoute: string };
}

/** 预览会话：标签集合 + 活动标签 + 返回快照（§3.4） */
export interface PreviewSession {
  tabs: PreviewTab[];
  activeKey?: string;
  /** 是否收起（收起保留标签与阅读位置） */
  hidden: boolean;
  /** 是否放大（临时占满内容区） */
  maximized: boolean;
  /**
   * 返回快照：第一次从非预览布局进入预览时记录（§3.4）。
   * 期间只切文件/滚动则关闭时恢复它；主动切过上下文则不恢复（第 2 条）。
   */
  returnSnapshot?: ReturnSnapshot;
  /** 期间是否主动改变过左侧上下文（决定关闭时是否还原快照） */
  contextChangedSinceOpen: boolean;
  /**
   * 预览当前**并排的上下文侧**（§3.2 打开来源 + §3.3 打开后切换上下文）。
   *
   * 为什么需要这个字段，而不是每次从活动标签的 `openedFrom` 现算：
   *  · §3.2 说"打开"时保留你点击文件所在的那一侧（从主池打开 → 主池＋文件）；
   *  · §3.3 说打开之后**主动切换上下文**时"左侧切到新上下文，右侧仍看原文件"
   *    （点开另一条任务/回复串 → 回复串＋文件）。
   * 两句话的规则不同：一个看"从哪打开"，一个看"现在在哪"。
   * 只按 `openedFrom` 现算，就会出现"从主池打开文件后再点回复串，
   * 回复串根本不出来、必须先关掉文件"（用户实测反馈）。
   *
   * undefined = 老会话：按 `openedFrom` 兜底（行为与本次修改前一致）。
   */
  side?: 'thread' | 'pool';
}

export interface ReturnSnapshot {
  target: ContextTarget;
  /** 面板宽度比例（按布局模式分别保存） */
  sizes: Record<string, number>;
}

/** 引用插入草稿的待处理动作（异步读取完成后仍插入点击时捕获的目标，PV-06） */
export interface PendingQuote {
  id: number;
  /** 点击时捕获的目标草稿 key —— 用户之后切去别的任务也不改投 */
  draftKey: string;
  /** 目标展示名（提示"引用已加入任务 A 草稿"） */
  targetLabel: string;
  reference: DraftReference;
}

export interface FinalReport {
  goal: string;
  participants: string;
  actualParticipation: string;
  baseline: string;
  confirmed: { statement: string; evidence: string }[];
  plan: string[];
  disputes: { statement: string; detail: string }[];
  verification: { item: string; result: string }[];
  links: { label: string; ref: string }[];
  consensus: Consensus;
}

export interface ChangeSet {
  id: string;
  projectId: string;
  taskId: string;
  workspaceId: string;
  /** 现文只有 before_ref；E15 定案为非 Git 目录整目录快照做内容级前像 */
  beforeRef: string;
  afterRef: string;
  /**
   * 文件应用状态（v1.12 §10.5 改名，与"人工验收"解耦）。
   *
   * 原名 `status` 里的 `pending_review` 把两件事混在一起：
   * "文件是否已应用到原目录" vs "用户是否验收了这次交付"。
   * v1.12 明确要求分开：本字段只表示文件应用状态，
   * 人工验收一律来自 TaskDelivery.reviewStatus。
   *
   * 迁移注意（§10.5）：旧的 `status='pending_review'` **不能**直接映射成
   * `not_applied` —— 原目录可能早已写入。应映射为 `applied`（或 `partial`），
   * 并额外挂上一条 pending 交付来承载"待验收"语义。
   */
  applicationStatus: 'applied' | 'not_applied' | 'reverted' | 'partial';
  files: {
    path: string;
    change: 'added' | 'modified' | 'deleted' | 'renamed';
    additions: number;
    deletions: number;
    diff: DiffHunk[];
    /** 大文件无前像，无法内容级撤销（E15） */
    cannotRevert?: boolean;
    userPreExisting?: boolean;
  }[];
}

export interface DiffHunk {
  header: string;
  lines: { type: 'ctx' | 'add' | 'del'; text: string; oldNo?: number; newNo?: number }[];
}

/* ---------- Git 集成（用户要求「加 git」；完整客户端口径） ----------
 *
 * 设计取舍：这不是一个通用 Git 客户端，而是**把 Git 接到协作流程上**。
 * 关键差别在于每条提交都能回答"这是哪个任务、哪个改动集、谁批准的"。
 * 通用 Git 客户端做不到这件事，而众说的 ChangeSet 本来就有这些信息。
 *
 * 边界（文档 §14.5 原文口径已按本次需求修订）：
 *  - 用户原有未提交改动不因本功能被 stash / reset / 自动提交（§14.2 不变）
 *  - agent 的提交仍走 approval（任务 #13 的授权卡是同一机制），不在界面上被静默执行
 */

/** 工作区中单个文件的 Git 状态（`git status` 的两列口径） */
export type GitFileState =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted';

export interface GitStatusEntry {
  path: string;
  state: GitFileState;
  /** 已暂存（index 里有内容） */
  staged: boolean;
  additions: number;
  deletions: number;
  diff: DiffHunk[];
  /**
   * 该改动来自哪个任务的 ChangeSet。
   * 有值 = 这是 agent 干的，可跳回任务；无值 = 用户自己改的（RT-10 归属区分）。
   */
  changeSetId?: string;
  taskId?: string;
  /** 用户在本产品介入前就有的未提交改动（§14.2 / RT-10） */
  userPreExisting?: boolean;
  /** 冲突时保留三方内容，不提供一键覆盖（§14.2 attribution=ambiguous 口径） */
  conflict?: {
    base: string;
    ours: string;
    theirs: string;
  };
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  /** 首行标题；正文另存 */
  subject: string;
  body?: string;
  authorName: string;
  authorEmail: string;
  /** 提交者是人类还是某个成员（agent 提交必须留痕） */
  authoredBy: 'human' | 'agent';
  memberId?: string;
  committedAt: number;
  parents: string[];
  refs: string[];
  files: {
    path: string;
    change: 'added' | 'modified' | 'deleted' | 'renamed';
    additions: number;
    deletions: number;
    diff: DiffHunk[];
  }[];
  /**
   * 关联的改动集 / 任务 / 授权。
   * 这是众说的 Git 页与通用 Git 客户端最重要的区别：
   * 每条提交都能回溯到"哪个任务、谁批准的"。
   */
  changeSetId?: string;
  taskId?: string;
  approvalId?: string;
  /**
   * v1.12 §10.5 已**移除** `pendingReview`（commit 级审批）。
   *
   * 验收单位改为「任务交付」（TaskDelivery）后，单个 commit 不再是审批对象：
   * 一次交付可能含多个 commit，也可能一个都没有（非 Git 项目）。
   * 若重新加回这个字段，就等于恢复了被取消的 commit 审批队列，
   * 并会让同一份成果在交付与 commit 两处各被验收一次。
   *
   * 判断"这个提交是谁产出的"请用 `authoredBy`（人 / agent），
   * 它描述事实，不隐含审批状态。
   */
}

export interface GitBranch {
  name: string;
  /** 分支尖端提交 hash */
  head: string;
  upstream?: string;
  ahead: number;
  behind: number;
  isCurrent: boolean;
  /** 是否为本产品创建的隔离分支（§14.4 worktree 方向） */
  createdByZhongshuo?: boolean;
  updatedAt: number;
}

export interface GitRemote {
  name: string;
  url: string;
  /** 未配置凭据时明确显示，不假装能推送 */
  authState: 'ok' | 'missing' | 'expired';
}

export interface GitState {
  /** 当前分支名；与 Project.gitBranch 同步 */
  currentBranch: string;
  branches: GitBranch[];
  remotes: GitRemote[];
  /** 按时间倒序（新提交在前） */
  commits: GitCommit[];
  /** 工作区待提交内容 */
  status: GitStatusEntry[];
  /** 已经写好的提交信息草稿 */
  commitMessage: string;
  /** 最近一次操作的如实结果；失败时保留原因而不是静默 */
  lastOp?: {
    op: string;
    ok: boolean;
    detail: string;
    at: number;
  };
  /** 近期 reflog，供"撤销这次提交"用（不做 reset --hard，§14.5） */
  reflog: { at: number; op: string; ref: string; detail: string }[];
}

export interface Issue {
  id: string;
  runId: string;
  statement: string;
  revision: number;
  status: 'open' | 'resolved' | 'needs_user' | 'insufficient_evidence';
  evidenceRefs: string[];
  /**
   * §12.2 的 positions 表：按 (issue_id, issue_revision, member_id) 唯一。
   * 确认矩阵读这里，而不是从某条消息里反推——成员立场是持久记录。
   */
  positions: {
    memberId: string;
    stance: 'agree' | 'disagree' | 'needs_evidence' | 'unconfirmed';
    reason: string;
  }[];
}

export interface AttentionItem {
  id: string;
  kind: 'mention' | 'approval' | 'decision' | 'blocked' | 'done' | 'failed' | 'unread' | 'absence' | 'review';
  projectId: string;
  roomId: string;
  threadId: string;
  messageId?: string;
  /**
   * 任务交付待办（v1.12 §10.5）：指向唯一交付版本。
   *
   * 为什么必须带 deliveryId + revision 而不是只用 taskId：
   * 返工会产生新版本，"批准"必须针对一个**具体版本**做校验，
   * 否则旧页面上遗留的按钮会错误批准刚发布的新结果（RT-25 ⑥）。
   * 角标也按 deliveryId 去重，避免同一交付的多个文件/ChangeSet/commit 各算一次。
   */
  deliveryId?: string;
  deliveryRevision?: number;
  title: string;
  detail: string;
  createdAt: number;
  readAt?: number;
  /** 仅"关于我"的动作类才进待我处理；普通讨论只积累线程未读 */
  requiresAction: boolean;
}

/**
 * 私信会话（决策 24，M3 批次；§12.2 的 conversations / conversation_members / dm_participants）
 *
 * 产品口径：
 *  - 私信使用**独立 audience 与会话**，不是"@某人"的替代品
 *  - 一个成员可以有**多个**私聊（同一成员的不同话题分开）
 *  - 会话可**归档**：归档后只读、不接收新消息，可取消归档
 *  - 项目内所有成员都可作为私聊对象
 */
export interface DmConversation {
  id: string;
  projectId: string;
  /** 会话标题：用户可改，默认取参与者名字 */
  title: string;
  /** 参与者（含 agent 成员；人类自己不入列） */
  memberIds: string[];
  /** 独立线程与消息（§12.2：DM 使用独立 audience） */
  threadId: string;
  createdAt: number;
  lastMessageAt: number;
  archivedAt?: number;
  unread: number;
  /** 是否置顶（CH-06：自己可见的排序偏好） */
  pinned?: boolean;
}

export interface PendingReminder {  id: string;
  ownerMemberId: string;
  threadId: string;
  taskId?: string;
  timezone: string;
  schedule: string;
  nextRunAt: number;
  enabled: boolean;
}

export interface PairedDevice {
  id: string;
  name: string;
  kind: 'this-machine' | 'lan';
  address: string;
  pairedAt: number;
  lastSeenAt: number;
  tokenPrefix: string;
}

export interface DiagnosticRecord {
  id: string;
  at: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  /** §18.1 关联与诊断：每条诊断带完整追溯键 */
  trace: {
    projectId?: string;
    taskId?: string;
    runId?: string;
    turnId?: string;
    dispatchKey?: string;
    adapterVersion?: string;
  };
}

/* ---------- §16.4 启动恢复 ---------- */

export interface RecoveryItem {
  id: string;
  kind: 'run' | 'turn' | 'result_unflushed' | 'workspace';
  title: string;
  detail: string;
  resumable: boolean;
  status: string;
}

/* ---------- E7：不自动续跑 ---------- */

export interface StartupRecovery {
  needsAttention: boolean;
  checkedAt: number;
  items: RecoveryItem[];
  /** 未派发工作重新排队但不自动派发（决策 44） */
  awaitingUserConfirm: boolean;
}

/* ---------- 全局应用状态 ---------- */

/**
 * 导航显示偏好（第十五批 §17.7）。
 *
 * 三个概念必须分开，混用会直接导致"勾选项目"被误当成"切换任务归属"：
 *  - activeProjectId：当前项目上下文（焦点），**始终单值**，任务派发只认它；
 *  - visibleProjectIds：侧栏显示的有序去重集合，纯显示，不改变任何执行目标；
 *  - 页面 scope：看板/搜索等聚合页自己的展示范围（见各页 query 参数）。
 *
 * 正式版由 `navigation_preferences` 按 viewer/client 保存；原型用带版本号的
 * 独立 localStorage key，刷新恢复，且不触碰其它原型数据。
 */
export interface NavigationPreferences {
  version: 1;
  activeProjectId?: string;
  visibleProjectIds: string[];
  expandedProjectIds: string[];
  /** 置顶项目（有序）：排在项目列表前部。只影响顺序，不复制出第二个入口（§七） */
  pinnedProjectIds: string[];
  /** 文件与 Git 合页的标签记忆，按 projectId 各存一份 */
  fileGitTabs: Record<string, 'files' | 'git'>;
}

export interface AppState {
  projects: Project[];  activeProjectId: string;
  /** 第十五批：侧栏可见项目（有序去重）。显示 ≠ 焦点，见 NavigationPreferences */
  visibleProjectIds: string[];
  expandedProjectIds: string[];
  /** 置顶项目的顺序（§七：只影响排列，不复制出第二个入口；随导航偏好持久化） */
  pinnedProjectIds: string[];
  fileGitTabs: Record<string, 'files' | 'git'>;
  runtimeInstallations: RuntimeInstallation[];
  profiles: AgentProfile[];
  members: ProjectMember[];
  rooms: Room[];
  threads: Thread[];
  messages: Message[];
  /** 私信会话（决策 24，M3） */
  dms: DmConversation[];
  tasks: Task[];
  runs: WorkflowRun[];
  turns: AgentTurn[];
  artifacts: Artifact[];
  /* ---------- UX-PREVIEW-01：共享预览资源层（§17.9） ---------- */
  /** 可预览资源本体（含固定版本）。普通主池附件在此，无 taskId */
  resources: PreviewResource[];
  /** 消息 ↔ 资源关联 */
  messageAttachments: MessageAttachment[];
  /** 预览会话：标签、活动标签、收起/放大、返回快照 */
  preview: PreviewSession;
  /** 异步引用插入队列（点击时捕获目标，读取完成后仍插入该目标） */
  pendingQuotes: PendingQuote[];
  changeSets: ChangeSet[];
  /**
   * 任务交付版本（v1.12 §10.5）。
   * 一个任务最多一个 pending 版本；返工替换而非追加。
   * 这是**人工验收的唯一权威来源**——ChangeSet 与 commit 都不承载验收语义。
   */
  taskDeliveries: TaskDelivery[];
  /** Git 集成状态（按项目） */
  git: Record<string, GitState>;
  issues: Issue[];
  attention: AttentionItem[];
  reminders: PendingReminder[];
  devices: PairedDevice[];
  diagnostics: DiagnosticRecord[];
  startupRecovery: StartupRecovery;
  /** 线程阅读水位：thread_read_states */
  readStates: Record<string, number>;
  /** 关注与静音：thread_subscriptions，不是执行队列（§25.4） */
  subscriptions: Record<string, { followed: boolean; muted: boolean }>;
  /** 13B 跟进名单：移出=停止自动唤醒，历史保留，可 @ 回 */
  followers: Record<string, string[]>;
  /** 每线程已消费的缺席宽限（E4），原型只记录展示状态 */
  absence: Record<string, { memberId: string; since: number; graceMs: number; continued: boolean }>;
  /**
   * 写入租约（§10.3 / §14.1），**按项目分别持有**。
   *
   * 为什么必须是 Record 而不是单个对象：锁域是"同一物理原目录"（§10.3 / RT-09），
   * 不同项目就是不同目录，各自的锁互不相干。早期实现用一个全局 writeLock，
   * 结果是拿着众说的租约去看另一个项目的文件页，也会显示"任务 #13 正在写入" ——
   * 跨项目串了状态（实测于 notes-vault 的文件页）。
   *
   * single_writer（默认）：ownerTaskId 是唯一持有者。
   * parallel_writers：parallelHolders 记录多个持有者，受 maxParallelWriters 限制。
   */
  writeLocks: Record<string, {
    lockDomain: string;
    ownerTaskId: string;
    ownerTaskLabel: string;
    /** 仅并行模式下有意义；单写者模式视为 [ownerTaskId] */
    parallelHolders?: string[];
  }>;
  /** 草稿：主池与线程分别保存（§4.5） */
  drafts: Record<string, string>;
  /**
   * 结构化引用草稿（UX-PREVIEW-01）。
   *
   * 为什么和 `drafts` 分开：`drafts` 只有正文，而"引用了一份文件的哪个版本"
   * 属于这次输入的一部分。合并进纯文本会丢掉版本身份，
   * 让"已发送的引用绑定原快照"（§6.2）无法成立。
   */
  draftRefs: Record<string, DraftReference[]>;
  /**
   * 布局偏好与实际自适应结果（§5.2/§5.3）。
   * 按布局模式分别保存分隔比例，不用一份固定值套所有模式。
   */
  layout: {
    /** 各模式的分隔比例（0—1，文件/预览侧占比） */
    sizes: Record<string, number>;
    /** 导航是否被自动临时隐藏（不覆盖用户的显式展开偏好） */
    navAutoHidden: boolean;
    /** 用户是否锁定导航展开 */
    navPinned: boolean;
  };
  /**
   * 应用级设置（第十六批 §17.8）。
   *
   * 为什么需要真实状态而不是"点了弹个提示"：
   * 原型里这些开关此前是 `checked` 写死的，点击只 toast —— 实测点击前后
   * `[true, true, false]` 完全不变，用户会认为"设置没反应"。
   * 这里给它们真实的内存状态，点击即改变。
   *
   * 边界（必须如实）：原型**没有**系统桥接，所以改的只是内存里的模拟值，
   * 不声称真的改了开机自启/托盘行为；界面用「原型」标注说明这一点。
   */
  appSettings: {
    /** 开机自动启动（默认开） */
    launchAtLogin: boolean;
    /** 关闭窗口时继续在托盘运行（默认开） */
    keepInTray: boolean;
    /** 重启后自动继续未完成任务（默认关，E7 不自动续跑） */
    autoResumeTasks: boolean;
  };
  ui: {
    theme: 'light' | 'dark';
    activeThreadId?: string;
    activeRoomId: string;
    toast?: { text: string; tone: 'info' | 'warn' | 'error' | 'success' };
    /** 原型留痕，便于评审时回看每一步写操作 */
    writeLog: { at: number; api: string; detail: string }[];
  };
}
