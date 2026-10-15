/**
 * daemon 命令面（DEV-07；修复轮 5 扩充）。
 * - 每连接经凭据握手后才进入此处；CallerContext 由验证入口构造（可信）。
 * - project.open：引导默认成员/房间/房间成员关系/会话（room_members 不再由测试补）。
 * - 只读查询：room.list / member.list / thread.history / task.get（UI 稳定返回值）。
 * - dispatch.resume 参数化（confirm:true 显式确认）+ runCommand 幂等。
 * - task.stop 委托 requestStop（自包幂等/中断）。
 * - run() 为同步事务（ADR-I37）；异步命令自包 runCommand。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync, realpathSync, rmSync, cpSync } from 'node:fs';
import { projectWriteAccess, snapshotTaskWriteAccess,physicalRootIdentity } from './projectWriteAccess.ts';
import { conversationFacts, conversationBlock, enqueueConversationReply } from './conversationReplies.ts';
import {fileWriteCapability} from '../adapter/writeCapability.ts';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { runCommand } from '../persistence/commandGateway.ts';
import { createRoomRootTask } from '../persistence/stores/roomRootTask.ts';
import {
  createDmConversation, listDmConversations, dmConversationOf, dmPeerOf, dmLocalUserOf,
  releaseDmPauseGate, pumpDmQueue, dmHasActiveRun, createDmTurn, holdDmPauseGate, reworkPendingOf,
} from '../persistence/stores/dm.ts';
import { assessTaskRedispatchReadiness } from '../persistence/stores/recoveryGuard.ts';
import { openProject } from './projectStore.ts';
import { computeNextAt, validateSchedule, checkReminderBudget, recheckReminderAuthority, type ReminderSchedule } from './reminderScheduler.ts';
import { dispatchReminderExecution, reminderCallUsage } from './reminderDispatch.ts';
import { resolveTopLevelRoute } from '../domain/routing/topLevelRoute.ts';
import type { TopLevelRouteOutcome, MentionNode } from '../contracts/routing.ts';
import { commandEnvelopeSchema } from '../contracts/commands.ts';
import { conversationFailedTasksParamsSchema, taskDetailsParamsSchema, taskHistoryParamsSchema } from '../contracts/taskDetails.ts';
import { computeCommandPayloadHash } from '../domain/idempotency.ts';
import { requestStop } from './stopFlow.ts';
import { readTaskDetails, readTaskHistory } from './taskDetails.ts';
import { memberManagementCommand, bindMemberRuntime, assertMemberProject, memberExecutableStatus } from './memberManagement.ts';
import { conversationTasksParamsSchema } from '../contracts/conversationTasks.ts';
import { atomicWriteFile } from '../contracts/atomicFile.ts';
import { appendDomainEvent, listEvents } from '../persistence/events.ts';
import { openDispatchGate } from '../persistence/daemonState.ts';
import { memberImageCapability, type ImageCapabilityReadContext } from './imageCapability.ts';
import { readMemberRuntimeBinding, resolveMemberRuntime, defaultModelOf } from './memberRuntime.ts';
import {runtimeOptions} from './runtimeOptions.ts';
import {chatAnswer} from '../contracts/chatAnswer.ts';
import { CLAUDE_ADAPTER_VERSION } from '../adapter/claude/cliAdapter.ts';
import { createHash } from 'node:crypto';
import { refundReservedTurn as _refundReservedTurn, settleTurn as _settleTurn } from '../contracts/deliberation.ts';
import { checkProcessLiveness, type LivenessResult, type TreeScan } from './processCheck.ts';
import { getProbe as getProbeRecord, getTurnProcessRegistration, probeTurnExit, type ManagedJobObservation, type ProbeOutcome } from './processRegistry.ts';
import { writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

/** DEV-24 文本附件（第二十六轮五）：副本上限与截断规则——超过 128KB 保存原文但预览/注入
 * 截断至 64KB（注明 originalBytes）；>256KB 拒绝（明确规则不静默）。 */
import { ATT_MAX_BYTES, ATT_EXCERPT_BYTES, ATT_TEXT_KINDS, ATT_IMAGE_MAX_BYTES, kindForFilename, readVerifiedCopy, readVerifiedFullText, readVerifiedBlob, readVerifiedStoreRaw, validateImageBuffer, truncateUtf8Bytes, decodeTextBytes } from './attachments.ts';
import { writeExport, TEXT_PREVIEW_EXTENSIONS, ExportWriterError } from './exportWriter.ts';
import { readRemoteConfig, writeRemoteConfig, createPairingCode, listDevices, revokeDeviceInDb, lanIps } from './remoteServer.ts';
import {
  PDF_MAX_BYTES, OFFICE_MAX_BYTES, CSV_MAX_BYTES, ARTIFACT_PARSE_KINDS,
  validateExtractCache, renderSheetWindow, parseSheetRangeSpec,
  type ExtractCache, type ParseJobKind,
} from './parseContracts.ts';
import { getParsePool } from './parsePool.ts';
import { safeUnzipWith as safeUnzip } from './zipGuard.ts';
import { buildPptxPages, validatePptxPagesCache, type PptxPages } from './pptxPages.ts';
import { getReceipt } from '../persistence/commandGateway.ts';

const deliberationBudgetFns = { refundReservedTurn: _refundReservedTurn, settleTurn: _settleTurn };
import { z } from 'zod';

export interface DaemonCommandDeps {
  /** No-inference configuration preparation before a new send is frozen. */
  prepareRuntimeConfiguration?:(memberId:string,projectId:string)=>Promise<void>;
  db: ZhongshuoDatabase;
  localUserId: string;
  interruptTurn: (turnId: string) => Promise<void>;
  /**
   * 远程访问服务控制（DEV-25 第三十一轮三；entry 注入——测试直连不注入时 remote.* 命令
   * 明确拒绝）：本机可信入口专用（配对码创建/配置/吊销/设备清单）。HTTP 远程通道在
   * remoteServer.REMOTE_BLOCKED_METHODS 拦截同名方法——「创建配对码仅本机可信 UI」。
   */
  /**
   * 远程通道上下文（第三十二轮一）：由 remoteServer 服务端构造（deviceId+设备级代次），
   * 桌面管道不注入。用于请求审计（remote_audit_log）——业务作者恒为 localUserId，
   * 不信任客户端自报身份；不影响幂等 scope/payloadHash。
   */
  remoteAudit?: { deviceId: string; authEpoch: number };
  /**
   * 远程门禁（第三十三轮二）：服务端构造的重查闭包（remoteServer.deviceLive——设备吊销/
   * 设备级代次/会话有效性实时核对）。dispatch 进入时与**业务提交前**（run() 边界）各核对
   * 一次——异步工作（附件解析/导出）完成后提交前同走此门禁。失败=明确拒绝（不提交）；
   * 吊销≠停止（已授权运行的任务按正式停止合同处理）。
   */
  remoteGate?: () => { ok: true } | { ok: false; code: string; message: string };
  remoteControl?: {
    restart: (cfg: { enabled: boolean; listenHost: string; port: number; allowLan: boolean }) => Promise<{ address: string; port: number; fingerprint: string } | { stopped: true }>;
    stop: () => Promise<void>;
    invalidateDevice: (deviceId: string) => void;
    current: () => { address: string; port: number; fingerprint: string; caFingerprint: string; lanAddresses: string[]; lanAddressDetails: Array<{ address: string; url: string; note: string | null }>; certNotAfter: string; certSubject: string; certIssuer: string } | null;
    /** LAN 绑定自检（第三十六轮二）：服务机本机经实际 LAN IP 的 HTTPS 探测（区分本机绑定/TLS 与跨机防火墙两层）。 */
    verifyLanBinding?: () => Promise<{ ok: boolean; checkedUrl: string; error: string | null }>;
    /** 隔离验收模式自检（ZS_REMOTE_SELFCHECK=1——双机包启动器注入；正式入口不带）。 */
    selfcheck?: () => Promise<{ ok: boolean; items: Array<{ name: string; ok: boolean; detail: string }>; file: string }>;
  };
  /** 应用数据目录（changeset.* 的受管理内容存储位置；entry 注入）。 */
  appDataDir?: string;
  /**
   * 同 daemon 内存联动钩子（DEV-13）：对账事务成功且 turn 已终态时释放 worker 准入账本中
   * 该 turn 的 UNKNOWN 保留占位（entry 接线 worker.reconcileRelease）。缺省（测试直连）不调用——
   * 持久事实（租约/UNKNOWN/gate）不依赖内存账本。
   */
  releaseAdmission?: (turnId: string) => void;
  /**
   * 进程存活查询函数（DEV-13 第七轮：OS 退出证据服务端生成）。缺省=checkProcessLiveness
   * （真实 OS 查询）；测试可注入故障（查询失败/PID 复用等场景仍走正式命令链）。
   */
  processQuery?: (pid: number) => LivenessResult;
  /**
   * 进程树归属分析注入（第八轮：测试故障模拟）；缺省=真实 analyzeProcessTree
   * （全表快照+现存树 BFS+活跃期快照历史代际核对）。
   */
  processTree?: (rootPid: number, historical: Array<{ pid: number; startedAt: number | null }>) => TreeScan;
  /**
   * 迟到成果泵（第八轮：entry 接线 worker.pumpLateEventsForTurn）。UNKNOWN turn 截止后
   * 到达的终态事件经 adapter 正式通道（lateEvents）进入生产路径。缺省（测试直连）时命令
   * 明确拒绝——不靠直调处理函数冒充生产支持。
   */
  pumpLateEvents?: (turnId: string) => Promise<{
    status: 'pumped' | 'not-found' | 'not-unknown' | 'unsupported-mode' | 'no-session' | 'unsupported';
    turnStatus?: string;
    reason?: string;
    applied?: Array<{ eventKey: string; outcome: string }>;
  }>;
  /**
   * 正式关闭入口（DEV-15 第十四轮三：daemon.shutdown——IPC 驱动的优雅停机；安装产物
   * 验证与 UI 宿主同路径）。注入方（standalone entry）自行调度实际 stop+退出（响应先于
   * 关闭发出）。缺省（内嵌测试实例）=命令明确拒绝——不经命令面伪造进程管理。
   */
  scheduleShutdown?: () => void;
}

export class DaemonCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DaemonCommandError';
    this.code = code;
  }
}

function memberRuntimeInfo(db: ZhongshuoDatabase, memberId: string, readContext?: ImageCapabilityReadContext) {
  const binding = readMemberRuntimeBinding(db, memberId);
  if (binding == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `成员不存在：${memberId}`);
  const installation = binding.installationId == null ? null
    : (db.prepare('SELECT id, kind, executable, capabilities_json FROM runtime_installations WHERE id = ?').get(binding.installationId) as { id: string; kind: string; executable: string; capabilities_json: string | null } | undefined) ?? null;
  const effective = resolveMemberRuntime(db, memberId, process.env.ZS_RUNTIME ?? null);
  const owner=db.prepare('SELECT project_id FROM project_members WHERE id=?').get(memberId) as {project_id:string};
  const access=projectWriteAccess(db,owner.project_id);
  const projectScope=db.prepare('SELECT canonical_path,root_path,status FROM projects WHERE id=?').get(owner.project_id) as {canonical_path:string;root_path:string;status:string};
  const cwd=projectScope.canonical_path;
  let scopeUsable=false;try{scopeUsable=access.authorized&&projectScope.status==='active'&&realpathSync.native(projectScope.root_path)===access.root&&physicalRootIdentity(cwd)===access.physicalIdentity;}catch{/* No grant is inferred from an unreadable directory. */}
  const writeCapability=fileWriteCapability(effective,cwd);
  const editable=scopeUsable && ['acceptEdits','dontAsk'].includes(effective.permissionMode??'') && ['claude','codex'].includes(effective.kind??'');
  const full=effective.permissionMode==null||effective.permissionMode==='bypassPermissions';
  const explicitReadonly=effective.permissionMode==='plan'||effective.permissionMode==='manual'||effective.permissionMode==='auto';
  const permissionExecution=['codex','claude'].includes(effective.kind??'')?full?{effective:'CLI 完整权限',reason:'新任务使用原生完整权限，可读写电脑并执行命令；原有只读任务不自动升级。'}:{effective:editable?(effective.kind==='claude'?'restricted · 文件创建/编辑':'workspace-write · 项目范围'):'read-only',reason:editable?'派发复查冻结授权、配置和物理目录；Shell/网络/委派未开放。真实认证仅以对应组合证据为准。':explicitReadonly?'成员保存的是只读档；项目范围授权不会改变该档，已有任务保留原权限快照。':!access.authorized?'项目范围编辑档尚未获得本项目授权；这不代表完整权限成员受限。':!scopeUsable?'授权目录身份已变化或不可用；未开放写入。':writeCapability.reason}:null;
  return { binding, installation, permissionExecution, writeCapability, executableStatus:memberExecutableStatus(binding.kind,binding.executable), effective: { source: binding.installationId != null ? 'binding' : effective.kind != null ? 'global-default' : 'unresolved',
    kind: effective.kind, model: effective.model ?? defaultModelOf(effective.kind), defaultKindEnv: process.env.ZS_RUNTIME ?? null },
    imageInput: memberImageCapability(db, memberId, readContext), environment: { realDispatchGuard: process.env.ZS_REAL_DISPATCH_GUARD === '1', allowFake: process.env.ZS_ALLOW_FAKE === '1' } };
}

function taskModeFromRoute(route: unknown): 'DIRECT' | 'AUTO' | 'DELIBERATE' | null {
  try { const mode = typeof route === 'string' ? (JSON.parse(route) as {mode?:unknown}).mode : null;
    return mode === 'DIRECT' || mode === 'AUTO' || mode === 'DELIBERATE' ? mode : null;
  } catch { return null; }
}

/**
 * 服务端退出取证解析（reconcile / releaseProtection 共用）：probeId 引用则校验
 * turn 归属/登记一致/新鲜（≤10 分钟）；否则按该 turn 已登记身份自动取证。
 * 只接受服务端生成的证据记录——调用方自报结果无从进入。
 */
function resolveServerProbe(deps: DaemonCommandDeps, turnId: string, probeId: string | undefined, now: number): ProbeOutcome {
  if (probeId != null) {
    const referenced = getProbeRecord(deps.db, probeId);
    if (referenced == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `引用的取证记录不存在：${probeId}`);
    if (referenced.turnId !== turnId) throw new DaemonCommandError('VALIDATION_INVALID', '取证记录不属于目标 turn（其他 turn 的证据不能冒充）');
    const reg = getTurnProcessRegistration(deps.db, turnId);
    if (reg == null || referenced.registryId !== reg.id) throw new DaemonCommandError('STALE_REVISION', '取证记录与当前进程登记不一致（登记已更新）——请重新取证');
    if (now - referenced.observedAt > 10 * 60 * 1000) throw new DaemonCommandError('STALE_REVISION', '取证记录已过期（>10 分钟）——请重新取证');
    return referenced;
  }
  return probeTurnExit(deps.db, turnId, deps.processQuery ?? ((pid: number) => checkProcessLiveness(pid)), {
    createdBy: 'reconcile', treeScan: deps.processTree,
    // 受管登记（第十四轮二）：按 managed_job_id 查现场——PID 复用/无句柄/错位不冒充证据。
    managedJob: managedJobObservation,
  });
}

/** 受管 job 现场观察（probe/reconcile 注入——jobId 查找+PID 辅助核对，第十四轮二）。 */
function managedJobObservation(jobId: string | null): ManagedJobObservation | null {
  if (jobId == null) return { held: false, pid: null, rootExited: false, activeCount: null };
  const mp = managedJobById(jobId);
  if (mp == null) return { held: false, pid: null, rootExited: false, activeCount: null };
  // rootExited 先取生命周期备忘（bridge close 后进程句柄已释放——handle 查询恒败，
  // 不能把「已完整结束」误报为「根仍存活」）；句柄在时以实时查询兜底。
  const memo = mp.lifecycle();
  return { held: true, pid: mp.pid, rootExited: memo.rootExited || !mp.waitRootExit(0).timedOut, activeCount: mp.activeCount() };
}

// REC-LIFE-1（第十四轮二）：受管证据按稳定身份（jobId）取用——PID 可复用，仅辅助核对。
import { managedJobById } from './managed/bridge.ts';
import { retireManagedJob } from './managedRetirement.ts';
import { stripSingleJsonFence } from './dispatchWorker.ts';

const localScope = (userId: string): string => `user:${userId}`;

/**
 * 用户可见项目集（第三十一轮二）：navigation_preferences.visibleProjectIds 的**最新一条**
 * 偏好行（无偏好行=全量项目可见——向后兼容；损坏/非数组=空集如实，不猜测）。scope=all
 * 的聚合面（看板/Activity）用它过滤；显式 projectId 查询不受限（query≠visible 既定区别）。
 */
/** 任务 audience（第三十二轮一）：DM 会话的任务仅该会话本人参与者可读/可操作；房间任务随
 * 项目可达。按 ID 直查入口（task.get/task.stop/task.redispatch 等）统一走此校验——读取、
 * 操作与回执重放不因「知道 ID」绕过私信边界。 */
function assertTaskAudience(db: ZhongshuoDatabase, viewerId: string, taskId: string): void {
  const row = db.prepare('SELECT t.conversation_id, c.kind AS conversation_kind FROM tasks t JOIN conversations c ON c.id = t.conversation_id WHERE t.id = ?').get(taskId) as { conversation_id: string | null; conversation_kind: string | null } | undefined;
  if (row == null) return; // 不存在由各命令自身的 RESOURCE_NOT_FOUND 分支处理
  if (row.conversation_kind !== 'dm') return;
  const inDm = db.prepare("SELECT 1 FROM dm_participants dp WHERE dp.conversation_id = ? AND dp.principal_type = 'human' AND dp.principal_id = ?").get(row.conversation_id, viewerId);
  if (inDm == null) throw new DaemonCommandError('FORBIDDEN', '任务属于他人私信会话——按 ID 直查不绕过 audience');
}

function assertTaskDispatchScope(db: ZhongshuoDatabase, taskId: string): void {
  const scope = db.prepare(`SELECT p.status AS project_status, c.archived_at AS conversation_archived,
    r.archived_at AS room_archived FROM tasks t JOIN projects p ON p.id = t.project_id
    JOIN conversations c ON c.id = t.conversation_id LEFT JOIN rooms r ON r.id = t.room_id WHERE t.id = ?`)
    .get(taskId) as { project_status: string; conversation_archived: number | null; room_archived: number | null } | undefined;
  if (scope != null && (scope.project_status !== 'active' || scope.conversation_archived != null || scope.room_archived != null)) {
    throw new DaemonCommandError('STALE_REVISION', '项目、房间或会话已归档或不可用——先恢复并刷新任务事实');
  }
}

function visibleProjectIdsOf(db: ZhongshuoDatabase, viewerId: string): string[] {
  const row = db.prepare('SELECT visible_project_ids_json FROM navigation_preferences WHERE viewer_id = ? ORDER BY revision DESC LIMIT 1').get(viewerId) as { visible_project_ids_json: string } | undefined;
  if (row == null) {
    return (db.prepare('SELECT id FROM projects ORDER BY rowid').all() as Array<{ id: string }>).map((r) => r.id);
  }
  try {
    const ids = JSON.parse(row.visible_project_ids_json) as unknown;
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) return [];
    return ids as string[];
  } catch {
    return [];
  }
}

/** project.open 的默认引导（成员/房间/房间成员关系/会话；重复打开不重复创建）。 */
function bootstrapProject(db: ZhongshuoDatabase, projectId: string, agentNames?: string[]): void {
  const memberCount = (db.prepare('SELECT count(*) c FROM project_members WHERE project_id = ?').get(projectId) as { c: number }).c;
  if (memberCount === 0) {
    // 可选多成员引导（M1 研讨用；缺省单成员「执行成员」不变）。
    const names = agentNames != null && agentNames.length > 0 ? agentNames : ['执行成员'];
    for (const [i, name] of names.entries()) {
      db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES (?, ?, ?, 'agent', 1)`)
        .run(`m_default_${projectId}_${i}`, projectId, name);
    }
  }
  const roomCount = (db.prepare('SELECT count(*) c FROM rooms WHERE project_id = ?').get(projectId) as { c: number }).c;
  if (roomCount === 0) {
    const defaultMember = (db.prepare('SELECT id FROM project_members WHERE project_id = ? ORDER BY id LIMIT 1').get(projectId) as { id: string }).id;
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES (?, ?, '默认房间', ?)`)
      .run(`room_default_${projectId}`, projectId, defaultMember);
  }
  const roomId = `room_default_${projectId}`;
  // 房间成员关系（修复轮 5：此前 smoke 手工 INSERT 绕过——正式链路必须引导）。
  db.prepare('INSERT OR IGNORE INTO room_members (room_id, member_id) SELECT ?, id FROM project_members WHERE project_id = ?')
    .run(roomId, projectId);
  const convCount = (db.prepare('SELECT count(*) c FROM conversations WHERE room_id = ?').get(roomId) as { c: number }).c;
  if (convCount === 0) {
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES (?, ?, 'room', ?)`)
      .run(`conv_default_${projectId}`, projectId, roomId);
  }
}

const messageSubmitParams = z.strictObject({
  target: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('room_root'),
      projectId: z.string().min(1),
      conversationId: z.string().min(1),
      roomId: z.string().min(1),
    }),
    // 线程跟进（修复轮 6）：目标在提交时固定，异步返回不随界面焦点漂移。
    z.strictObject({
      kind: z.literal('thread'),
      projectId: z.string().min(1),
      conversationId: z.string().min(1),
      threadId: z.string().min(1),
      replyToMessageId: z.string().min(1).optional(),
    }),
    // 私信（DEV-22；R4 §2.3）：目标是会话本身——无房间/线程/任务号语义。
    z.strictObject({
      kind: z.literal('dm'),
      projectId: z.string().min(1),
      conversationId: z.string().min(1),
    }),
  ]),
  // R66 P3（用户已批准的发送语义：只有文件也沿用当前模式——默认发 AI，仅记录只保存）：
  // 正文允许为空，但**必须**携带至少一个附件引用——真正空白（无正文且无可发送附件）仍拒绝，
  // 不合成占位正文、不静默改为记录。上限同前（正文 20K 语义不变）。
  body: z.string().max(20_000),
  intent: z.enum(['default', 'record_only']),
  mentions: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('member'), memberId: z.string().min(1) }),
    z.strictObject({ kind: z.literal('all') }),
  ])),
  attachmentRefs: z.array(z.string().min(1)).optional(),
  // 图片能力门（第二十九轮三）：omit-images=用户明确选择仅发送文字（注入如实注明图片未发送）。
  imageAck: z.literal('omit-images').optional(),
  // 表格注入范围（第二十九轮四）：artifactId → "Sheet1!A1:D20"；缺省=有界默认窗口（非全量）。
  attachmentRanges: z.record(z.string().min(1), z.string().min(1).max(200)).optional(),
}).superRefine((p, ctx) => {
  if (p.body.trim().length === 0 && (p.attachmentRefs == null || p.attachmentRefs.length === 0)) {
    ctx.addIssue({ code: 'custom', message: '正文与附件不能同时为空（没有正文时须携带至少一个可发送的附件引用；上传中/失败资源不算就绪附件）' });
  }
});

/**
 * R66 P3：任务标题推导（正文为空的文件-only 发送）——标题是**界面/列表标签**而非模型
 * 输入：正文非空沿用正文前 60 字；正文为空用**附件文件名**（用户决定的合法呈现——不合成
 * 假用户正文，不把界面说明当模型文件内容）。
 */
function taskTitleOf(body: string, attachmentNames: string[]): string {
  const trimmed = body.trim();
  if (trimmed.length > 0) return body.slice(0, 60);
  const fromNames = attachmentNames.filter((n) => n != null && n.length > 0).join('、');
  return fromNames.length > 0 ? `📎 ${fromNames}`.slice(0, 60) : '（无正文）';
}

function coordinatorOf(db: ZhongshuoDatabase, roomId: string): string {
  return (db.prepare('SELECT coordinator_member_id c FROM rooms WHERE id = ?').get(roomId) as { c: string } | undefined)?.c ?? '';
}
function enabledAgents(db: ZhongshuoDatabase, roomId: string): string[] {
  return (db.prepare(`SELECT rm.member_id FROM room_members rm JOIN project_members pm ON pm.id = rm.member_id WHERE rm.room_id = ? AND pm.enabled = 1`).all(roomId) as Array<{ member_id: string }>).map((r) => r.member_id);
}
function reviewPolicyOf(db: ZhongshuoDatabase, projectId: string): 'auto_deliver' | 'user_review' {
  const row = db.prepare('SELECT task_review_enabled FROM projects WHERE id = ?').get(projectId) as { task_review_enabled: number } | undefined;
  return row?.task_review_enabled === 1 ? 'user_review' : 'auto_deliver';
}

/**
 * 附件归属与能力校验（第二十七轮二：主池/任务线程/记录线程/DM 四通道共用）。
 * ref=artifacts.id；上传侧（attachment.upload*）已校验 audience/归档/大小——此处对每个
 * 引用再核：存在、kind 支持、**归属会话与提交目标一致**（跨会话引用=audience 拒绝）。
 * 不存在/不支持/跨会话都明确拒绝——绝不静默丢附件。第二十九轮三/四：图片与 Office 类
 * 进引用面（图片走能力门 imageGate；Office 类注入走提取缓存+可选范围）。
 */
const ATTACHABLE_KINDS = [...(ATT_TEXT_KINDS as readonly string[]), 'image_file', 'pdf_file', 'docx_file', 'sheet_file', 'slides_file'] as const;
function resolveAttachmentRefs(
  db: ZhongshuoDatabase,
  conversationId: string,
  refs: string[] | undefined,
): Array<{ artifactId: string; displayName: string; hash: string; kind: string }> {
  if (refs == null || refs.length === 0) return [];
  const out: Array<{ artifactId: string; displayName: string; hash: string; kind: string }> = [];
  for (const attId of refs) {
    const att = db.prepare('SELECT conversation_id, kind, source_name, hash FROM artifacts WHERE id = ?').get(attId) as
      | { conversation_id: string; kind: string; source_name: string | null; hash: string }
      | undefined;
    if (att == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `附件不存在：${attId}`);
    if (!(ATTACHABLE_KINDS as readonly string[]).includes(att.kind)) throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', `仅文本/代码/图片/PDF/DOCX/表格/幻灯片附件（已支持批次）——${attId} 为 ${att.kind}`);
    if (att.conversation_id !== conversationId) throw new DaemonCommandError('FORBIDDEN', '附件不属于该会话（audience 拒绝）');
    out.push({ artifactId: attId, displayName: att.source_name ?? attId, hash: att.hash, kind: att.kind });
  }
  return out;
}

/**
 * 图片能力门（R76）：按实测 CLI/适配器/渠道/模型组合判断，未认证组合不能宣称模型已读图
 * ——引用图片附件且本次会派发时，不允许悄悄省略图片后以任务成功冒充处理完成。用户须明确
 * 选择：仅发送文字（imageAck:"omit-images"——组装注入明示「图片未发送+用户已确认」）或
 * 仅记录（record_only，零派发）。保存/预览不受此门影响。
 */
function assertImageGate(
  resolved: Array<{ artifactId: string; displayName: string; kind: string }>,
  willDispatch: boolean,
  imageAck: string | undefined,
  /** R66 P3：正文（文件-only 语义下可为空）——仅图片+「继续文字」+空正文会形成**空模型输入**。 */
  bodyForModel?: string,
  imagesSupported = false,
): void {
  if (!willDispatch) return; // record_only/记录串/无派发路由：不进模型，无门禁
  const images = resolved.filter((a) => a.kind === 'image_file');
  if (images.length === 0) return;
  if (imageAck === 'omit-images') {
    // 「仅发送文字」但没有任何可用文字（正文空且其余附件也全是图片——其余 kind 均有文本
    // 提取注入，不在此列）：不得形成空模型输入，给出可行选择（加文字或改仅记录）。
    const nonImages = resolved.filter((a) => a.kind !== 'image_file');
    if ((bodyForModel ?? '').trim().length === 0 && nonImages.length === 0) {
      throw new DaemonCommandError('VALIDATION_INVALID', 'EMPTY_MODEL_INPUT：已选择「仅发送文字」，但没有可用文字（正文为空且附件只有未认证图片）。请先添加文字，或改为「仅记录」（intent:"record_only"——只保存消息与文件，不派发不扣预算），或选择其他附件。');
    }
    return; // 用户明确选择仅发送文字（组装侧如实注入说明）
  }
  if (imagesSupported) return;
  throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', `IMAGE_INPUT_UNVERIFIED：目标成员的模型图片输入能力未认证，不能发送图片后宣称模型已读。请明确选择其一：仅发送文字（imageAck:"omit-images"——消息与注入文本将注明图片未发送及用户确认）或仅记录（intent:"record_only"，不派发）。${images.map((i) => i.displayName).join('、')}`);
}

/** 注入范围校验（第二十九轮四）：仅表格类；格式与窗口边界在提交时早失败（不静默截别人选的范围）。 */
function assertAttachmentRanges(
  db: ZhongshuoDatabase,
  resolved: Array<{ artifactId: string; kind: string }>,
  ranges: Record<string, string> | undefined,
): void {
  if (ranges == null) return;
  const byId = new Map(resolved.map((a) => [a.artifactId, a]));
  for (const [attId, spec] of Object.entries(ranges)) {
    const att = byId.get(attId);
    if (att == null) throw new DaemonCommandError('VALIDATION_INVALID', `注入范围引用了未随消息发送的附件：${attId}`);
    if (att.kind !== 'sheet_file') throw new DaemonCommandError('VALIDATION_INVALID', `注入范围仅支持表格类附件（XLSX/CSV）——${attId} 为 ${att.kind}`);
    const row = db.prepare('SELECT hash, extracted_text_json FROM artifacts WHERE id = ?').get(attId) as { hash: string; extracted_text_json: string | null } | undefined;
    const cache = row != null ? validateExtractCache(row?.extracted_text_json ?? null, row.hash, 'sheet') : null;
    if (cache == null || cache.kind !== 'sheet') throw new DaemonCommandError('STORAGE_UNAVAILABLE', `表格附件提取缓存缺失/无效（${attId}）——先重新预览生成缓存再选范围`);
    const rendered = renderSheetWindow(cache, spec, ATT_EXCERPT_BYTES);
    if (!rendered.ok) throw new DaemonCommandError('VALIDATION_INVALID', rendered.error);
  }
}

const DOC_ARTIFACT_KINDS = ['pdf_file', 'docx_file', 'sheet_file', 'slides_file'] as const;

/** 文档附件上传共享链（第二十九轮二/四）。幂等三层：①同 commandId 回执预查（**先于解析**——
 * 重放不重复解析不重复建记录）；②同会话同 hash 去重（返回既有资源，不新建记录）；③跨会话
 * 同 hash 缓存复用（独立 audience 各建行，但不重复解析）。解析走 parsePool 子进程（隔离边界）；
 * 提交前事务内重检归档/audience——解析期间会话归档即失败，不留 artifact/半截缓存/错误关联
 * （内容寻址孤儿 blob 不是业务记录，可被后续同内容上传复用）。 */
type RunTx = <T>(handler: () => T) => { data: T; replayed: boolean };
async function uploadDocumentAttachment(
  deps: DaemonCommandDeps,
  runTx: RunTx,
  ctx: { scope: string; commandId: string; payloadHash: string },
  params: {
    conversationId: string;
    filename: string;
    contentBase64: string;
    byteCap: number;
    parseKind: 'pdf' | 'csv' | 'office';
  },
): Promise<{ data: Record<string, unknown>; replayed: boolean }> {
  // ① 归属+audience+归档先于回执（第三十一轮一：重放同样过当前权限——旧回执不绕过
  // 会话归档/访问变化；同号同参仍回原结果、同号异参仍冲突）。
  const convInfo = assertConversationAudience(deps.db, deps.localUserId, params.conversationId);
  const convArchived = (deps.db.prepare('SELECT archived_at FROM conversations WHERE id = ?').get(params.conversationId) as { archived_at: number | null }).archived_at;
  if (convArchived != null) throw new DaemonCommandError('CONVERSATION_ARCHIVED', '会话已归档：禁止新上传（历史附件仍可预览）');
  // ② 回执预查（早于一切解析；归属已核）。
  const receipt = getReceipt(deps.db, ctx.scope, ctx.commandId);
  if (receipt != null) {
    if (receipt.payload_hash !== ctx.payloadHash) throw new DaemonCommandError('IDEMPOTENCY_CONFLICT', '同 commandId 携带不同参数——幂等键冲突拒绝');
    if (receipt.result_json == null) throw new DaemonCommandError('RESULT_EXPIRED', '回执正文已按清理策略删除：用新 commandId 重新提交');
    return { data: JSON.parse(receipt.result_json) as Record<string, unknown>, replayed: true };
  }
  const raw = Buffer.from(params.contentBase64, 'base64');
  if (raw.length === 0) throw new DaemonCommandError('VALIDATION_INVALID', '文档内容为空');
  if (raw.length > params.byteCap) throw new DaemonCommandError('VALIDATION_INVALID', `文档原件 ${raw.length.toLocaleString('en-US')}B（约 ${(raw.length / 1048576).toFixed(1)}MiB）超过上限 ${(params.byteCap / 1048576).toFixed(0)}MiB（明确规则拒绝——不静默截断保存）`);
  const hash = createHash('sha256').update(raw).digest('hex');
  const blobRoot = join(deps.appDataDir ?? process.env.ZS_APP_DATA ?? process.cwd(), 'blobstore');
  mkdirSync(blobRoot, { recursive: true });
  const blobPath = join(blobRoot, `${hash}.bin`);
  if (!existsSync(blobPath)) atomicWriteFile(blobPath, raw); // 内容寻址——同内容单副本
  const summaryOf = (cache: ExtractCache): Record<string, unknown> => {
    switch (cache.kind) {
      case 'pdf': return { pages: cache.totalPages, truncatedTotal: cache.truncatedTotal };
      case 'docx': return { paragraphCount: cache.paragraphCount, truncatedTotal: cache.truncatedTotal };
      case 'sheet': return { sheets: cache.sheets.length, sourceFormat: cache.sourceFormat, encoding: cache.encoding, truncatedTotal: cache.truncatedTotal };
      case 'slides': return { slides: cache.totalSlides, truncatedTotal: cache.truncatedTotal };
    }
  };
  // ② 同会话同 hash 去重（无新记录、无重复解析）。
  const existing = deps.db.prepare(`SELECT id, revision, kind, extracted_text_json FROM artifacts WHERE conversation_id = ? AND hash = ? AND kind IN (${DOC_ARTIFACT_KINDS.map(() => '?').join(',')}) ORDER BY rowid LIMIT 1`)
    .get(params.conversationId, hash, ...DOC_ARTIFACT_KINDS) as { id: string; revision: number; kind: string; extracted_text_json: string | null } | undefined;
  if (existing != null) {
    const existingCacheKind = (ARTIFACT_PARSE_KINDS[existing.kind] ?? { cache: 'pdf' as const }).cache;
    const validatedExisting = validateExtractCache(existing.extracted_text_json, hash, existingCacheKind);
    if (validatedExisting != null) {
      const tx = deps.db.transaction((): Record<string, unknown> => {
        assertConversationAudience(deps.db, deps.localUserId, params.conversationId); // 事务内重检（去重路径同样不放过解析等待期间的变化）
        const archived2 = (deps.db.prepare('SELECT archived_at FROM conversations WHERE id = ?').get(params.conversationId) as { archived_at: number | null }).archived_at;
        if (archived2 != null) throw new DaemonCommandError('CONVERSATION_ARCHIVED', '会话已归档：禁止新上传');
        return { attachmentId: existing.id, hash, bytes: raw.length, deduped: true, revision: existing.revision, ...summaryOf(validatedExisting) };
      });
      const r = runTx(tx);
      return { data: r.data as Record<string, unknown>, replayed: r.replayed };
    }
  }
  // ③ 跨会话缓存复用（同 hash 已解析过且缓存按当前口径有效——独立 audience 各建行，不重复解析）。
  let cacheJson: string | null = null;
  const sibling = deps.db.prepare(`SELECT kind, extracted_text_json FROM artifacts WHERE hash = ? AND kind IN (${DOC_ARTIFACT_KINDS.map(() => '?').join(',')}) ORDER BY rowid LIMIT 1`)
    .get(hash, ...DOC_ARTIFACT_KINDS) as { kind: string; extracted_text_json: string | null } | undefined;
  if (sibling != null) {
    const cacheKind = (ARTIFACT_PARSE_KINDS[sibling.kind] ?? { cache: 'pdf' as const }).cache;
    const validated = validateExtractCache(sibling.extracted_text_json, hash, cacheKind);
    if (validated != null) cacheJson = JSON.stringify(validated);
  }
  let cache: ExtractCache | null = null;
  let extractionFailed: { code: string; message: string } | null = null;
  if (cacheJson != null) {
    cache = JSON.parse(cacheJson) as ExtractCache;
  } else {
    // R69 P1-D：Office **软解析失败不再吞掉整次上传**——原件已按内容寻址落盘（上方 blobPath），
    // 「保存原件/本地静态预览」与「文本提取/模型注入」分列：结构解析失败（损坏/解析器覆盖不足）
    // 时仍建 artifact（kind 按主 part 定类），extracted_text_json=null（注入侧既有 fail-closed：
    // 明确拒派发并提示重新预览生成缓存——预览时 ensureDocumentCache 会重试解析，成功则回写）。
    // **硬拒绝不变**：宏主文档（docx-macro）、ZIP 护栏（zip-*）、非 Office zip（office-corrupt/
    // PK 头缺失）、超限——安全边界不因分列放宽。
    const parseOutcome = params.parseKind === 'office'
      ? await runOfficeSniff(blobPath, hash)
      // R71：pdf/csv 截止维持默认 30s（此处 parseKind 只为这两种；office 分支在 runOfficeSniff）。
      : await getParsePool().run(params.parseKind, blobPath, hash);
    if (!parseOutcome.ok) {
      const hardReject = parseOutcome.error.code === 'docx-macro' || parseOutcome.error.code.startsWith('zip-')
        || parseOutcome.error.code === 'office-corrupt' || parseOutcome.error.code === 'office-too-large'
        || parseOutcome.error.code === `${params.parseKind}-too-large`;
      if (params.parseKind !== 'office' || hardReject) {
        throw new DaemonCommandError('VALIDATION_INVALID', `[${parseOutcome.error.code}] ${parseOutcome.error.message}`);
      }
      // 同会话同 hash 已有「提取失败」占位行（此前软失败上传）→ 去重返回，不重复建行。
      const failedExisting = deps.db.prepare(`SELECT id, revision FROM artifacts WHERE conversation_id = ? AND hash = ? AND kind IN (${DOC_ARTIFACT_KINDS.map(() => '?').join(',')}) AND extracted_text_json IS NULL ORDER BY rowid LIMIT 1`)
        .get(params.conversationId, hash, ...DOC_ARTIFACT_KINDS) as { id: string; revision: number } | undefined;
      if (failedExisting != null) {
        const txDedup = deps.db.transaction((): Record<string, unknown> => {
          assertConversationAudience(deps.db, deps.localUserId, params.conversationId);
          const archived3 = (deps.db.prepare('SELECT archived_at FROM conversations WHERE id = ?').get(params.conversationId) as { archived_at: number | null }).archived_at;
          if (archived3 != null) throw new DaemonCommandError('CONVERSATION_ARCHIVED', '会话已归档：禁止新上传');
          return { attachmentId: failedExisting.id, hash, bytes: raw.length, deduped: true, revision: failedExisting.revision, extraction: 'failed', extractionCode: parseOutcome.error.code };
        });
        const rDedup = runTx(txDedup);
        return { data: rDedup.data as Record<string, unknown>, replayed: rDedup.replayed };
      }
      extractionFailed = { code: parseOutcome.error.code, message: parseOutcome.error.message };
    } else {
      cache = parseOutcome.result;
      const { artifactKind: _ak, ...cacheBody } = cache as ExtractCache & { artifactKind?: string };
      cacheJson = JSON.stringify(cacheBody);
    }
  }
  // 软失败占位行的 kind：按扩展名三类（结构未解析成——不以扩展名冒充服务端定类事实，
  // 但保存/本地渲染只依赖原件字节与扩展名入口）。
  const artifactKind = cache != null
    ? (cache.kind === 'pdf' ? 'pdf_file' : cache.kind === 'docx' ? 'docx_file' : cache.kind === 'slides' ? 'slides_file' : 'sheet_file')
    : (/\.(xlsx)$/i.test(params.filename) ? 'sheet_file' : /\.(pptx)$/i.test(params.filename) ? 'slides_file' : 'docx_file');
  const tx = deps.db.transaction((): Record<string, unknown> => {
    assertConversationAudience(deps.db, deps.localUserId, params.conversationId); // 事务内重检
    const archived2 = (deps.db.prepare('SELECT archived_at FROM conversations WHERE id = ?').get(params.conversationId) as { archived_at: number | null }).archived_at;
    if (archived2 != null) throw new DaemonCommandError('CONVERSATION_ARCHIVED', '解析期间会话已归档：上传失败，不留记录（内容寻址副本不构成业务关联）');
    const attachmentId = `art_${randomUUID()}`;
    deps.db.prepare(`INSERT INTO artifacts (id, project_id, conversation_id, author_id, kind, revision, hash, blob_path, source_name, created_at, extracted_text_json)
                     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
      .run(attachmentId, convInfo.projectId, params.conversationId, deps.localUserId, artifactKind, hash, blobPath, params.filename, Date.now(), cacheJson);
    return {
      attachmentId, hash, bytes: raw.length,
      ...(cache == null
        ? { extraction: 'failed' as const, extractionCode: extractionFailed?.code, extractionMessage: extractionFailed?.message }
        : summaryOf(cache)),
    };
  });
  const r = runTx(tx);
  return { data: r.data as Record<string, unknown>, replayed: r.replayed };
}

/** Office 上传前置（zip 头核对——**定类在 worker 按解压后的 [Content_Types]**：zip 条目已
 * 压缩，字面嗅探不可靠）。 */
async function runOfficeSniff(blobPath: string, hash: string): Promise<{ ok: true; result: ExtractCache & { artifactKind?: string } } | { ok: false; error: { code: string; message: string } }> {
  const raw = readFileSync(blobPath);
  if (raw.subarray(0, 4).toString('latin1') !== 'PK\u0003\u0004') {
    return { ok: false, error: { code: 'office-corrupt', message: '内容不是 Office 文档（zip 头 PK 缺失——不以扩展名冒充）' } };
  }
  return getParsePool().run('office', blobPath, hash, { deadlineMs: 120_000 });
}

/** 文档缓存保障（预览/注入共用）：副本实根+实身份+sha256 核对 → 缓存严格校验 → 无效则
 * 隔离重提并回写（事务内重检 audience）。失败=明确错误（不虚构缓存）。 */
async function ensureDocumentCache(
  deps: DaemonCommandDeps,
  row: { id: string; conversation_id: string; hash: string; blob_path: string; kind: string; revision: number; extracted_text_json: string | null },
  cacheKind: ExtractCache['kind'],
): Promise<ExtractCache> {
  const verified = readVerifiedBlob(row.blob_path, row.hash, join(deps.appDataDir ?? process.env.ZS_APP_DATA ?? process.cwd(), 'blobstore'));
  if (!verified.ok) throw new DaemonCommandError('STORAGE_UNAVAILABLE', verified.error.message);
  const cached = validateExtractCache(row.extracted_text_json, row.hash, cacheKind);
  if (cached != null) return cached;
  const parseKind: ParseJobKind = cacheKind === 'sheet' ? 'xlsx' : cacheKind === 'slides' ? 'pptx' : cacheKind;
  const parsed = await getParsePool().run(parseKind, row.blob_path, row.hash);
  if (!parsed.ok) throw new DaemonCommandError('STORAGE_UNAVAILABLE', `原件已不可解析：[${parsed.error.code}] ${parsed.error.message}`);
  const cache = { ...(parsed.result as ExtractCache & { artifactKind?: string }) };
  delete (cache as { artifactKind?: string }).artifactKind;
  // 迟到结果防覆盖（第三十轮三）：重提是慢路径——期间资源可能被重传/更新（新 hash/revision）；
  // 回写绑定读取时快照（id+hash+revision），受影响行=0 即放弃回写（本次预览用内存结果，不覆盖新资源缓存）。
  deps.db.transaction(() => {
    assertConversationAudience(deps.db, deps.localUserId, row.conversation_id); // 重提期间 audience 变化=不回写
    deps.db.prepare('UPDATE artifacts SET extracted_text_json = ? WHERE id = ? AND hash = ? AND revision = ?').run(JSON.stringify(cache), row.id, row.hash, row.revision);
  }).immediate();
  return cache;
}

/** 消息-附件关联（与消息插入同一事务调用——消息落库与关联原子）。range_spec=表格类注入
 * 范围（第二十九轮四，迁移 036；已在提交时校验合法）。 */
function attachMessageRefs(
  db: ZhongshuoDatabase,
  messageId: string,
  resolved: Array<{ artifactId: string; displayName: string; hash: string }>,
  ranges?: Record<string, string>,
  imageMode?: 'include' | 'omit' | 'local-only',
): void {
  if (imageMode != null) {
    db.prepare("UPDATE messages SET body_json=json_set(body_json,'$.imageInput',?) WHERE id=?").run(imageMode, messageId);
  }
  for (const a of resolved) {
    db.prepare('INSERT INTO message_attachments (id, message_id, artifact_id, display_name, source_hash, range_spec) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`matt_${randomUUID()}`, messageId, a.artifactId, a.displayName, a.hash, ranges?.[a.artifactId] ?? null);
  }
}

/** 历史读取用：批量取消息附件摘要（artifactId/filename——点击预览经 attachment.previewText
 * 走 audience+完整性校验，此处只发 id 与名字不下发正文）。 */
function messageAttachmentSummaries(db: ZhongshuoDatabase, messageIds: string[]): Map<string, Array<{ artifactId: string; filename: string; kind: string }>> {
  const out = new Map<string, Array<{ artifactId: string; filename: string; kind: string }>>();
  if (messageIds.length === 0) return out;
  const rows = db.prepare(
    `SELECT ma.message_id, ma.artifact_id, ma.display_name, a.kind FROM message_attachments ma JOIN artifacts a ON a.id = ma.artifact_id WHERE ma.message_id IN (${messageIds.map(() => '?').join(',')}) ORDER BY ma.rowid`,
  ).all(...messageIds) as Array<{ message_id: string; artifact_id: string; display_name: string | null; kind: string }>;
  for (const r of rows) {
    const list = out.get(r.message_id) ?? [];
    list.push({ artifactId: r.artifact_id, filename: r.display_name ?? r.artifact_id, kind: r.kind });
    out.set(r.message_id, list);
  }
  return out;
}

/** 就地为驼峰历史条目（thread.history items）填 attachments 摘要。 */
function attachMessageSummaries(db: ZhongshuoDatabase, items: Array<{ id: string; attachments?: unknown }>): void {
  const byMsg = messageAttachmentSummaries(db, items.map((i) => i.id));
  for (const it of items) it.attachments = byMsg.get(it.id) ?? [];
}

/** 线程内插入一条消息（修复轮 6：thread 目标提交的持久化路径；会话/线程序号事务内分配）。 */
function insertThreadMessage(
  db: ZhongshuoDatabase,
  input: {
    projectId: string;
    conversationId: string;
    roomId: string;
    threadId: string;
    threadMessageSeq: number;
    body: string;
    mentions: readonly MentionNode[];
    authorId: string;
    taskId: string | null;
  },
): { messageId: string; conversationId: string; threadId: string; threadMessageSeq: number } {
  const messageId = `msg_${randomUUID()}`;
  const conversationSeq = (db.prepare('UPDATE conversations SET last_message_seq = last_message_seq + 1 WHERE id = ? RETURNING last_message_seq').get(input.conversationId) as { last_message_seq: number }).last_message_seq;
  db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, task_id, thread_message_seq, author_type, author_id, body_json, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'human', ?, ?, 'saved', ?)`)
    .run(messageId, input.projectId, input.conversationId, conversationSeq, input.roomId, input.threadId, input.taskId, input.threadMessageSeq, input.authorId, JSON.stringify({ text: input.body, mentions: input.mentions }), Date.now());
  db.prepare('UPDATE conversation_threads SET last_message_seq = ?, revision = revision + 1 WHERE id = ?')
    .run(input.threadMessageSeq, input.threadId);
  appendDomainEvent(db, {
    schemaVersion: 1,
    eventId: `evt_${randomUUID()}`,
    projectId: input.projectId,
    conversationId: input.conversationId,
    threadId: input.threadId,
    taskId: input.taskId ?? undefined,
    kind: 'thread.replyAdded',
    createdAt: Date.now(),
    payload: { messageId },
  });
  return { messageId, conversationId: input.conversationId, threadId: input.threadId, threadMessageSeq: input.threadMessageSeq };
}

/**
 * 会话级 audience 校验（DEV-18 第二三轮三）：统一按目标**实际 conversation** 核对——
 * DM=双成员（本地用户必须是人参与者；否则任何链接形态/汇总都不得泄露）；房间=项目可达。
 * #task/#delivery/#msg/mine.pending/task.review 全走这一处，不留下可绕过的链接形态。
 */
function assertConversationAudience(db: ZhongshuoDatabase, localUserId: string, conversationId: string): { projectId: string; kind: string } {
  const conv = db.prepare('SELECT project_id AS project_id_, kind FROM conversations WHERE id = ?').get(conversationId) as { project_id_: string; kind: string } | undefined;
  if (conv == null) throw new DaemonCommandError('NOT_FOUND', `会话不存在或已删除：${conversationId}`);
  if (conv.kind === 'dm') {
    if (dmLocalUserOf(db, conversationId) !== localUserId) throw new DaemonCommandError('FORBIDDEN', '目标属于他人私信（audience 校验拒绝）');
  } else if (db.prepare('SELECT id FROM projects WHERE id = ?').get(conv.project_id_) == null) {
    throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '会话所属项目不可达');
  }
  return { projectId: conv.project_id_, kind: conv.kind };
}

/** 项目根路径（深链跨项目切换用：renderer 需以 path 打开来源项目——project.open 按 path）。 */
function rootPathOf(db: ZhongshuoDatabase, projectId: string): string | null {
  return (db.prepare('SELECT canonical_path FROM projects WHERE id = ?').get(projectId) as { canonical_path: string } | undefined)?.canonical_path ?? null;
}

/** 任务受阻/失败原因（第三十八轮 #4：BLOCKED/FAILED 行显示人话——不做无解释的「blocked」）。
 * 取任务最近一条相关事件（turn.startupFailed / task.statusChanged BLOCKED / 准入拒绝），按事件
 * reason/message 映射；无事件=如实 null（不虚构）。纯读。 */
export function taskStatusReasonOf(db: ZhongshuoDatabase, taskId: string): string | null {
  interface EvRow { kind: string; payload_json: string }
  const rows = db.prepare(
    `SELECT kind, payload_json FROM domain_events
     WHERE task_id = ? AND kind IN ('turn.startupFailed', 'task.statusChanged', 'task.memberDisabledBlocked', 'task.deliberationPrepareFailed', 'task.contextAssemblyFailed')
     ORDER BY seq DESC LIMIT 8`,
  ).all(taskId) as EvRow[];
  for (const r of rows) {
    let p: Record<string, unknown> = {};
    try { p = JSON.parse(r.payload_json) as Record<string, unknown>; } catch { continue; }
    if (r.kind === 'turn.startupFailed') {
      const m = typeof p.message === 'string' ? p.message : null;
      return m == null ? null : m.slice(0, 200);
    }
    if (r.kind === 'task.statusChanged' && p.status === 'BLOCKED') {
      const reason = typeof p.reason === 'string' ? p.reason : '';
      if (reason === 'mode_unavailable_in_m0') return 'M0 模式下房间任务需 @ 指定成员（AUTO/DELIBERATE 未开放）——重新发送并指派成员';
      if (typeof p.message === 'string') return p.message.slice(0, 200);
      return reason.length > 0 ? `受阻：${reason}` : '受阻（无原因事件——见活动页审计）';
    }
    if (r.kind === 'task.memberDisabledBlocked') return '成员已停用：任务阻塞（不派发）；重新启用后经「追加执行」续跑';
    if (r.kind === 'task.deliberationPrepareFailed' || r.kind === 'task.contextAssemblyFailed') {
      const m = typeof p.message === 'string' ? p.message : typeof p.reason === 'string' ? p.reason : null;
      if (m != null) return m.slice(0, 200);
    }
  }
  return null;
}

/** 远程通道审计写入（第三十二轮一）：HTTP /cmd 由服务端注入 remoteAudit（deviceId+authEpoch
 * ——服务端构造的可信上下文，业务作者仍为其代表的本机用户）。best-effort：审计失败不
 * 改变命令结果；不进命令事务（幂等语义不受影响——回执重放不重复执行业务）。 */
function writeRemoteAudit(deps: DaemonCommandDeps, method: string, commandId: string, ok: boolean, replayed: boolean): void {
  if (deps.remoteAudit == null) return;
  try {
    deps.db.prepare('INSERT INTO remote_audit_log (at, device_id, method, command_id, ok, replayed, auth_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), deps.remoteAudit.deviceId, method, commandId, ok ? 1 : 0, replayed ? 1 : 0, deps.remoteAudit.authEpoch);
  } catch { /* 审计尽力——不改变业务结果 */ }
}

export async function dispatchDaemonCommand(deps: DaemonCommandDeps, envelope: unknown): Promise<unknown> {
  // 远程审计包装（第三十二轮一）：请求事实（含重放）独立留痕；上下文由服务端注入——
  // 不信客户端自报身份；同 commandId 幂等语义不变（重放不重复执行业务）。
  const method0 = (envelope as { method?: unknown })?.method;
  const commandId0 = (envelope as { commandId?: unknown })?.commandId;
  const started = Date.now();
  // 远程门禁·进入时（第三十三轮二）：请求体已读完→设备吊销/代次变化/会话失效→进命令面前拒绝。
  if (deps.remoteGate != null) {
    const gate = deps.remoteGate();
    if (!gate.ok) {
      if (typeof method0 === 'string' && typeof commandId0 === 'string') {
        writeRemoteAudit(deps, method0, commandId0, false, false);
      }
      return { commandId: commandId0, ok: false, error: { code: gate.code, message: gate.message, retryable: false } };
    }
  }
  let outcome: unknown;
  try {
    outcome = await dispatchDaemonCommandInner(deps, envelope);
  } catch (error) {
    if (typeof method0 === 'string' && typeof commandId0 === 'string') {
      writeRemoteAudit(deps, method0, commandId0, false, false);
    }
    throw error;
  }
  if (typeof method0 === 'string' && typeof commandId0 === 'string') {
    writeRemoteAudit(deps, method0, commandId0, (outcome as { ok?: boolean })?.ok === true, (outcome as { replayed?: boolean })?.replayed === true);
  }
  void started;
  return outcome;
}

async function dispatchDaemonCommandInner(deps: DaemonCommandDeps, envelope: unknown): Promise<unknown> {
  const parsedEnvelope = commandEnvelopeSchema(z.unknown()).safeParse(envelope);
  // 信封校验失败时 commandId 尽力取原始 envelope 的（可能缺失）——客户端丢弃无等待者响应。
  const fallbackCommandId = (envelope as { commandId?: string })?.commandId;
  if (!parsedEnvelope.success) {
    return { commandId: fallbackCommandId, ok: false, error: { code: 'VALIDATION_INVALID', message: `信封校验失败：${parsedEnvelope.error?.issues[0]?.message ?? '无效'}`, retryable: false } };
  }
  const env = parsedEnvelope.data;
  // 所有可关联回执（成功与错误）都带 commandId：客户端按它配对响应（修复轮 6）。
  const withCommandId = (result: object): object => ({ commandId: env.commandId, ...result });
  const payloadHash = computeCommandPayloadHash({ method: env.method, target: null, params: env.params, expectedRevision: env.expectedRevision ?? null });
  const scope = localScope(deps.localUserId);
  // runCommand 为同步事务：handler 必须同步返回（异步命令自包 runCommand，如 task.stop）。
  // replayGuard（第三十一轮一）：重放返回持久结果前执行的纯校验——旧回执不绕过当前
  // 权限变化（会话归档/audience 变化后重放同号同参请求=明确拒绝）。
  const run = <T>(handler: () => T, replayGuard?: () => void): { data: T; replayed: boolean } => {
    // 远程门禁·业务提交前（第三十三轮二）：异步工作（附件解析/导出等）完成后、进幂等事务
    // 提交前重查设备/代次/会话——「请求体已读完→解析暂停→吊销→提交拒绝」在此收口。
    if (deps.remoteGate != null) {
      const gate = deps.remoteGate();
      if (!gate.ok) throw new DaemonCommandError(gate.code, gate.message);
    }
    const outcome = runCommand<T>(deps.db, { idempotencyScope: scope, commandId: env.commandId, payloadHash, now: Date.now(), ...(replayGuard != null ? { replayGuard } : {}) }, handler);
    if (!outcome.ok) throw new DaemonCommandError(outcome.error.code, outcome.error.message);
    return { data: outcome.data, replayed: outcome.replayed };
  };

  try {
    const management = memberManagementCommand(deps.db, env.method, env.params, run, (code,message) => { throw new DaemonCommandError(code,message); }, deps.remoteAudit != null);
    if (management != null) return withCommandId({ok:true,...management});
    switch (env.method) {
      case 'project.writeAccess.get': {
        if(deps.remoteAudit) throw new DaemonCommandError('FORBIDDEN','项目写入授权仅限本机');
        const p=z.strictObject({projectId:z.string().min(1)}).parse(env.params);
        if(!deps.db.prepare('SELECT 1 FROM projects WHERE id=?').get(p.projectId)) throw new DaemonCommandError('RESOURCE_NOT_FOUND','项目不存在');
        return withCommandId({ok:true,data:projectWriteAccess(deps.db,p.projectId)});
      }
      case 'project.writeAccess.set': {
        if(deps.remoteAudit) throw new DaemonCommandError('FORBIDDEN','项目写入授权仅限本机明确操作');
        const p=z.strictObject({projectId:z.string().min(1),expectedRevision:z.number().int().nonnegative(),authorized:z.boolean()}).parse(env.params);
        const result=run(()=>{
          const project=deps.db.prepare('SELECT status,canonical_path,root_path FROM projects WHERE id=?').get(p.projectId) as {status:string;canonical_path:string;root_path:string}|undefined;
          if(!project) throw new DaemonCommandError('RESOURCE_NOT_FOUND','项目不存在');
          if(project.status!=='active') throw new DaemonCommandError('FORBIDDEN','归档、移除或失效项目不能变更写入授权');
          const current=projectWriteAccess(deps.db,p.projectId);
          if(current.revision!==p.expectedRevision) throw new DaemonCommandError('STALE_REVISION','写入授权已变化，请回读后重新决定');
          const held=deps.db.prepare(`SELECT 1 FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id WHERE t.project_id=? AND (a.status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT','STOPPING','UNKNOWN') OR a.protection_state='retained') LIMIT 1`).get(p.projectId);
          if(held) throw new DaemonCommandError('WORKER_STILL_RUNNING','仍有运行或结果未知：请先明确停止并确认退出，再变更授权；未自动停止或重发');
          const root=realpathSync.native(project.canonical_path);
          if(realpathSync.native(project.root_path)!==root) throw new DaemonCommandError('FORBIDDEN','项目入口的物理目录已变化，请先重新定位并核对目标');
          if(p.authorized && root.replace(/[\\/]+$/,'')===resolve(root,'..').replace(/[\\/]+$/,'')) throw new DaemonCommandError('FORBIDDEN','不能授权整盘根目录，请打开明确项目子目录');
          deps.db.prepare(`INSERT INTO project_write_authorizations(project_id,authorized,canonical_root,physical_identity,revision,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET authorized=excluded.authorized,canonical_root=excluded.canonical_root,physical_identity=excluded.physical_identity,revision=excluded.revision,updated_at=excluded.updated_at`).run(p.projectId,p.authorized?1:0,root,physicalRootIdentity(root),current.revision+1,Date.now());
          return projectWriteAccess(deps.db,p.projectId);
        });
        return withCommandId({ok:true,data:result.data,replayed:result.replayed});
      }
      case 'project.list': {
        // R65（review-r64 §1A）：注册表只读——多项目前端集合的事实源（此前 UI 只装当前单个，
        // 误标「无多项目注册表」）。status 原样（active/archived/directory_missing/removed）；
        // 目录可访问性按 canonical_path existsSync 快检（不可访问=directory_missing 融合显示，
        // 不改库）。含已移除/归档（前端按生命周期过滤呈现）。
        z.strictObject({}).parse(env.params);
        const rows = deps.db.prepare('SELECT id, display_name, root_path, canonical_path, directory_identity, status, revision, description, task_review_enabled, created_at FROM projects ORDER BY created_at, rowid').all() as Array<{
          id: string; display_name: string; root_path: string; canonical_path: string; directory_identity: string;
          status: string; revision: number; description: string | null; task_review_enabled: number; created_at: number;
        }>;
        const items = rows.map((r) => ({
          id: r.id, displayName: r.display_name, rootPath: r.root_path, canonicalPath: r.canonical_path,
          directoryIdentity: r.directory_identity,
          status: r.status === 'active' && !existsSync(r.canonical_path) ? 'directory_missing' : r.status,
          revision: r.revision, description: r.description ?? null,
          taskReviewEnabled: r.task_review_enabled === 1, createdAt: r.created_at,
        }));
        return withCommandId({ ok: true, data: { items } });
      }
      case 'project.memberWorkload': {
        const params = z.strictObject({ projectId: z.string().min(1) }).parse(env.params);
        if (deps.db.prepare('SELECT 1 FROM projects WHERE id=?').get(params.projectId) == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', '项目不存在');
        const rows = deps.db.prepare(`WITH visible_tasks AS (
          SELECT t.id,t.owner_member_id,t.status FROM tasks t JOIN conversations c ON c.id=t.conversation_id
          WHERE t.project_id=? AND (c.kind<>'dm' OR EXISTS(SELECT 1 FROM dm_participants dp WHERE dp.conversation_id=c.id AND dp.principal_type='human' AND dp.principal_id=?))
        ), owned AS (SELECT owner_member_id,COUNT(*) n FROM visible_tasks WHERE status NOT IN ('DONE','CANCELLED') GROUP BY owner_member_id),
        executing AS (SELECT a.member_id,SUM(CASE WHEN a.status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT','STOPPING') THEN 1 ELSE 0 END) active_n,
          SUM(CASE WHEN a.status='UNKNOWN' THEN 1 ELSE 0 END) unknown_n FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id JOIN visible_tasks t ON t.id=r.task_id GROUP BY a.member_id)
        SELECT pm.id memberId,COALESCE(o.n,0) unfinishedTasks,COALESCE(e.active_n,0) activeTurns,COALESCE(e.unknown_n,0) unknownTurns
        FROM project_members pm LEFT JOIN owned o ON o.owner_member_id=pm.id LEFT JOIN executing e ON e.member_id=pm.id WHERE pm.project_id=? ORDER BY pm.id LIMIT 501`)
          .all(params.projectId, deps.localUserId, params.projectId);
        return withCommandId({ ok: true, data: { projectId: params.projectId, items: rows.slice(0,500), truncated: rows.length>500 } });
      }
      case 'project.taskSummary': {
        const params = z.strictObject({ projectId: z.string().min(1) }).parse(env.params);
        if (deps.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(params.projectId) == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', '项目不存在');
        const audience = `AND (c.kind <> 'dm' OR EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.conversation_id = c.id AND dp.principal_type = 'human' AND dp.principal_id = ?))`;
        const unfinishedTasks = (deps.db.prepare(`SELECT COUNT(*) AS n FROM tasks t JOIN conversations c ON c.id = t.conversation_id WHERE t.project_id = ? AND t.status NOT IN ('DONE', 'CANCELLED') ${audience}`)
          .get(params.projectId, deps.localUserId) as { n: number }).n;
        const activeTurns = (deps.db.prepare(`SELECT COUNT(*) AS n FROM agent_turns a JOIN workflow_runs r ON r.id = a.run_id JOIN tasks t ON t.id = r.task_id JOIN conversations c ON c.id = t.conversation_id WHERE t.project_id = ? AND a.status IN ('PENDING', 'DISPATCHING', 'RUNNING', 'WAITING_APPROVAL', 'WAITING_INPUT', 'STOPPING') ${audience}`)
          .get(params.projectId, deps.localUserId) as { n: number }).n;
        return withCommandId({ ok: true, data: { projectId: params.projectId, unfinishedTasks, activeTurns } });
      }
      case 'project.update': {
        // R65（review-r64 §4B）：项目属性真实写——displayName/description（描述=migration 046 列；
        // 不重命名磁盘目录）。expectedRevision 乐观锁（A 的编辑不写进 B；过时=STALE_REVISION）。
        const params = z.strictObject({
          projectId: z.string().min(1), expectedRevision: z.number().int().nonnegative(),
          displayName: z.string().min(1).max(120).optional(), description: z.string().max(2000).optional(),
        }).refine((p2) => p2.displayName != null || p2.description != null, { message: '无更新字段' }).parse(env.params);
        const result = run(() => {
          const cur = deps.db.prepare('SELECT revision, status FROM projects WHERE id = ?').get(params.projectId) as { revision: number; status: string } | undefined;
          if (cur == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目不存在：${params.projectId}`);
          if (cur.revision !== params.expectedRevision) throw new DaemonCommandError('STALE_REVISION', `项目已变更（当前 revision ${cur.revision}，请求按 ${params.expectedRevision}）——请刷新后重试`);
          if (cur.status === 'removed') throw new DaemonCommandError('FORBIDDEN', '已移除的项目不可编辑（恢复后再改）');
          deps.db.prepare('UPDATE projects SET display_name = COALESCE(?, display_name), description = COALESCE(?, description), revision = revision + 1 WHERE id = ?')
            .run(params.displayName ?? null, params.description ?? null, params.projectId);
          const after = deps.db.prepare('SELECT id, display_name, description, revision FROM projects WHERE id = ?').get(params.projectId) as { id: string; display_name: string; description: string | null; revision: number };
          return { project: { id: after.id, displayName: after.display_name, description: after.description, revision: after.revision } };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'project.lifecycle': {
        // R65（review-r64 §4B）：归档/恢复/移除/重新关联——沿 001 schema 的 status 机：
        //  archive=保留历史退出日常树（房间只读）；remove=仅解除应用关联，不删磁盘文件/历史；
        //  restore=移除→active（归档房不跟着恢复）；relocate=目录失效后的重新定位（改路径身份）。
        // 归档/移除在有未结束工作时拒绝（不借生命周期操作自动停止/派发——确认框给去停止入口）。
        const params = z.strictObject({
          projectId: z.string().min(1), expectedRevision: z.number().int().nonnegative(),
          action: z.enum(['archive', 'unarchive', 'remove', 'restore', 'relocate']),
          newRootPath: z.string().min(1).max(1000).optional(),
        }).parse(env.params);
        const result = run(() => {
          const cur = deps.db.prepare('SELECT revision, status, root_path, canonical_path, directory_identity FROM projects WHERE id = ?').get(params.projectId) as { revision: number; status: string; root_path: string; canonical_path: string; directory_identity: string } | undefined;
          if (cur == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目不存在：${params.projectId}`);
          if (cur.revision !== params.expectedRevision) throw new DaemonCommandError('STALE_REVISION', `项目已变更（当前 revision ${cur.revision}）——请刷新后重试`);
          const unfinished = (deps.db.prepare("SELECT count(*) c FROM tasks WHERE project_id = ? AND status IN ('ACTIVE','WAITING_USER','BLOCKED','REVIEW')").get(params.projectId) as { c: number }).c;
          if ((params.action === 'archive' || params.action === 'remove') && unfinished > 0) {
            throw new DaemonCommandError('WORKER_STILL_RUNNING', `项目还有 ${unfinished} 个未结束的任务——先在房间/看板处理（停止或等完成）；归档/移除不会自动停止或派发`);
          }
          let nextStatus = cur.status;
          if (params.action === 'archive') nextStatus = 'archived';
          if (params.action === 'unarchive' || params.action === 'restore') nextStatus = 'active';
          if (params.action === 'remove') nextStatus = 'removed';
          if (params.action === 'relocate') {
            if (params.newRootPath == null) throw new DaemonCommandError('VALIDATION_INVALID', 'relocate 需要 newRootPath');
            if (!existsSync(params.newRootPath)) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `新目录不存在：${params.newRootPath}`);
            if(deps.db.prepare(`SELECT 1 FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id WHERE t.project_id=? AND (a.status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT','STOPPING','UNKNOWN') OR a.protection_state='retained') LIMIT 1`).get(params.projectId)) throw new DaemonCommandError('WORKER_STILL_RUNNING','运行或退出未确认时不能重定位项目；先明确停止并确认退出');
          }
          if (params.action === 'relocate') {
            const newPath = resolve(params.newRootPath ?? '');
            deps.db.prepare('UPDATE projects SET root_path = ?, canonical_path = ?, directory_identity = ?, status = ?, revision = revision + 1 WHERE id = ?')
              .run(newPath, newPath, `dir:${newPath}`, 'active', params.projectId);
          } else {
            deps.db.prepare('UPDATE projects SET status = ?, revision = revision + 1 WHERE id = ?').run(nextStatus, params.projectId);
          }
          if(['archive','remove','relocate'].includes(params.action)) deps.db.prepare('UPDATE project_write_authorizations SET authorized=0,revision=revision+1,updated_at=? WHERE project_id=?').run(Date.now(),params.projectId);
          const after = deps.db.prepare('SELECT id, status, revision FROM projects WHERE id = ?').get(params.projectId) as { id: string; status: string; revision: number };
          return { project: after };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'navigation.get': {
        // R65（review-r64 §4A）：服务端导航偏好（001 navigation_preferences 表——按 viewer+client）。
        // 无行=null（前端回落本地/全量默认）；列校验+去重在写入侧做，读取侧原样+投影有效 id。
        const params = z.strictObject({ clientId: z.string().min(1).max(120) }).parse(env.params);
        const row = deps.db.prepare('SELECT active_project_id, visible_project_ids_json, expanded_project_ids_json, pinned_project_ids_json, file_git_tabs_json, revision FROM navigation_preferences WHERE viewer_id = ? AND client_id = ?').get(deps.localUserId, params.clientId) as
          | { active_project_id: string | null; visible_project_ids_json: string; expanded_project_ids_json: string; pinned_project_ids_json: string | null; file_git_tabs_json: string | null; revision: number }
          | undefined;
        if (row == null) return withCommandId({ ok: true, data: { prefs: null } });
        const parseIds = (raw: string | null): string[] => {
          if (raw == null) return [];
          try { const a = JSON.parse(raw); return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
        };
        return withCommandId({ ok: true, data: { prefs: {
          activeProjectId: row.active_project_id,
          visibleProjectIds: parseIds(row.visible_project_ids_json),
          expandedProjectIds: parseIds(row.expanded_project_ids_json),
          pinnedProjectIds: parseIds(row.pinned_project_ids_json),
          fileGitTabs: (() => { try { const o = row.file_git_tabs_json == null ? null : JSON.parse(row.file_git_tabs_json); return o != null && typeof o === 'object' ? o as Record<string, string> : {}; } catch { return {}; } })(),
          revision: row.revision,
        } } });
      }
      case 'navigation.set': {
        // R65：服务端导航偏好写入（upsert by viewer+client；json 字段白名单校验——只收 string 数组
        // 与 files/git 二值表；active 可为 null）。前端本地 localStorage 仍作快速镜像，服务端为
        // 跨机权威；board.view scope=all 的可见集即读本表（无行=全量）。
        const params = z.strictObject({
          clientId: z.string().min(1).max(120),
          activeProjectId: z.string().min(1).nullable(),
          visibleProjectIds: z.array(z.string().min(1)).max(500),
          expandedProjectIds: z.array(z.string().min(1)).max(500),
          pinnedProjectIds: z.array(z.string().min(1)).max(500).optional(),
          fileGitTabs: z.record(z.string().min(1), z.enum(['files', 'git'])).optional(),
        }).parse(env.params);
        const dedup = (a: string[]): string[] => [...new Set(a)];
        const result = run(() => {
          deps.db.prepare(`INSERT INTO navigation_preferences (viewer_id, client_id, active_project_id, visible_project_ids_json, expanded_project_ids_json, pinned_project_ids_json, file_git_tabs_json, revision)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1)
             ON CONFLICT(viewer_id, client_id) DO UPDATE SET
               active_project_id = excluded.active_project_id,
               visible_project_ids_json = excluded.visible_project_ids_json,
               expanded_project_ids_json = excluded.expanded_project_ids_json,
               pinned_project_ids_json = COALESCE(excluded.pinned_project_ids_json, navigation_preferences.pinned_project_ids_json),
               file_git_tabs_json = COALESCE(excluded.file_git_tabs_json, navigation_preferences.file_git_tabs_json),
               revision = navigation_preferences.revision + 1`)
            .run(deps.localUserId, params.clientId, params.activeProjectId,
              JSON.stringify(dedup(params.visibleProjectIds)), JSON.stringify(dedup(params.expandedProjectIds)),
              params.pinnedProjectIds != null ? JSON.stringify(dedup(params.pinnedProjectIds)) : null,
              params.fileGitTabs != null ? JSON.stringify(params.fileGitTabs) : null);
          return { saved: true };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'room.update': {
        // R65（review-r64 §4C）：房间属性真实写——名称/描述（settings_json.description）/协调者
        //（须为房间成员）。expectedRevision 乐观锁；协调者移出前须先换（room.members.remove 另守）。
        const params = z.strictObject({
          roomId: z.string().min(1), expectedRevision: z.number().int().nonnegative(),
          name: z.string().min(1).max(60).optional(),
          description: z.string().max(1000).optional(),
          coordinatorMemberId: z.string().min(1).optional(),
        }).refine((p2) => p2.name != null || p2.description != null || p2.coordinatorMemberId != null, { message: '无更新字段' }).parse(env.params);
        const result = run(() => {
          const room = deps.db.prepare('SELECT id, project_id, name, settings_json, coordinator_member_id, revision, archived_at FROM rooms WHERE id = ?').get(params.roomId) as { id: string; project_id: string; name: string; settings_json: string | null; coordinator_member_id: string; revision: number; archived_at: number | null } | undefined;
          if (room == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `房间不存在：${params.roomId}`);
          if (room.revision !== params.expectedRevision) throw new DaemonCommandError('STALE_REVISION', `房间已变更（当前 revision ${room.revision}）——请刷新后重试`);
          if (room.archived_at != null) throw new DaemonCommandError('FORBIDDEN', '已归档房间只读——取消归档后再修改');
          if (params.coordinatorMemberId != null) {
            const inRoom = (deps.db.prepare('SELECT count(*) c FROM room_members WHERE room_id = ? AND member_id = ?').get(params.roomId, params.coordinatorMemberId) as { c: number }).c;
            const sameProject = (deps.db.prepare('SELECT count(*) c FROM project_members WHERE id = ? AND project_id = ?').get(params.coordinatorMemberId, room.project_id) as { c: number }).c;
            if (inRoom === 0 || sameProject === 0) throw new DaemonCommandError('VALIDATION_INVALID', '协调者必须是本房间的本项目成员');
          }
          const settings = room.settings_json == null ? {} : JSON.parse(room.settings_json) as Record<string, unknown>;
          if (params.description != null) settings.description = params.description;
          deps.db.prepare('UPDATE rooms SET name = COALESCE(?, name), coordinator_member_id = COALESCE(?, coordinator_member_id), settings_json = ?, revision = revision + 1 WHERE id = ?')
            .run(params.name ?? null, params.coordinatorMemberId ?? null, JSON.stringify(settings), params.roomId);
          const after = deps.db.prepare('SELECT id, name, settings_json, coordinator_member_id, revision FROM rooms WHERE id = ?').get(params.roomId) as { id: string; name: string; settings_json: string | null; coordinator_member_id: string; revision: number };
          return { room: { id: after.id, name: after.name, description: ((JSON.parse(after.settings_json ?? '{}') as { description?: string }).description) ?? null, coordinatorMemberId: after.coordinator_member_id, revision: after.revision } };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'room.archive': {
        // R65（review-r64 §4C）：房间归档/取消归档——archived_at 置位/清空（历史保留；归档=只读、
        // 不再接收新消息/建任务）。归档前真实检查：本房间存在未结束任务则拒绝（不自动停止）。
        const params = z.strictObject({ roomId: z.string().min(1), expectedRevision: z.number().int().nonnegative(), action: z.enum(['archive', 'unarchive']) }).parse(env.params);
        const result = run(() => {
          const room = deps.db.prepare('SELECT revision, archived_at FROM rooms WHERE id = ?').get(params.roomId) as { revision: number; archived_at: number | null } | undefined;
          if (room == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `房间不存在：${params.roomId}`);
          if (room.revision !== params.expectedRevision) throw new DaemonCommandError('STALE_REVISION', `房间已变更（当前 revision ${room.revision}）——请刷新后重试`);
          if (params.action === 'archive') {
            if (room.archived_at != null) return { room: { id: params.roomId, archivedAt: room.archived_at } };
            const unfinished = (deps.db.prepare("SELECT count(*) c FROM tasks t JOIN conversations c2 ON c2.id = t.conversation_id WHERE t.room_id = ? AND t.kind = 'room_task' AND t.status IN ('ACTIVE','WAITING_USER','BLOCKED','REVIEW')").get(params.roomId) as { c: number }).c;
            if (unfinished > 0) throw new DaemonCommandError('WORKER_STILL_RUNNING', `房间还有 ${unfinished} 个未结束的任务——先处理（停止/验收/等待完成）；归档不会自动停止`);
            const now = Date.now();
            deps.db.prepare('UPDATE rooms SET archived_at = ?, revision = revision + 1 WHERE id = ?').run(now, params.roomId);
            return { room: { id: params.roomId, archivedAt: now } };
          }
          deps.db.prepare('UPDATE rooms SET archived_at = NULL, revision = revision + 1 WHERE id = ?').run(params.roomId);
          return { room: { id: params.roomId, archivedAt: null } };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'room.members.set': {
        // R65（review-r64 §4C）：房间成员增删——add=项目成员入房（幂等）；remove=移出（协调者
        // 须先换人；正在运行研讨不悄悄改冻结名单——新增只对后续新任务生效，语义在界面注明）。
        const params = z.strictObject({ roomId: z.string().min(1), memberId: z.string().min(1), action: z.enum(['add', 'remove']) }).parse(env.params);
        const result = run(() => {
          const room = deps.db.prepare('SELECT project_id, coordinator_member_id FROM rooms WHERE id = ?').get(params.roomId) as { project_id: string; coordinator_member_id: string } | undefined;
          if (room == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `房间不存在：${params.roomId}`);
          const member = deps.db.prepare('SELECT id, project_id, principal_type FROM project_members WHERE id = ?').get(params.memberId) as { id: string; project_id: string; principal_type: string } | undefined;
          if (member == null || member.project_id !== room.project_id) throw new DaemonCommandError('VALIDATION_INVALID', '成员不属于本项目');
          if (params.action === 'add') {
            deps.db.prepare('INSERT OR IGNORE INTO room_members (room_id, member_id) VALUES (?, ?)').run(params.roomId, params.memberId);
            return { roomId: params.roomId, memberId: params.memberId, inRoom: true };
          }
          if (room.coordinator_member_id === params.memberId) throw new DaemonCommandError('VALIDATION_INVALID', '协调者不能移出——先在房间设置更换协调者');
          deps.db.prepare('DELETE FROM room_members WHERE room_id = ? AND member_id = ?').run(params.roomId, params.memberId);
          return { roomId: params.roomId, memberId: params.memberId, inRoom: false };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'project.open': {
        const params = z.strictObject({ path: z.string().min(1), displayName: z.string().optional(), agentNames: z.array(z.string().min(1)).optional() }).parse(env.params);
        const result = run(() => {
          const opened = openProject(deps.db, { rootPath: params.path, displayName: params.displayName, now: Date.now() });
          if (!opened.ok) throw new DaemonCommandError(opened.error.code, opened.error.message);
          bootstrapProject(deps.db, opened.value.project.id, params.agentNames ?? (process.env.ZS_BOOTSTRAP_AGENTS?.split(',').filter((n) => n.trim().length > 0)));
          return { project: opened.value.project, created: opened.value.created };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'room.create': {
        // 建房命令（M1 收口轮）：房间为项目的正式聚合单元——跨房间切换/隔离 UI 场景的前提。
        const params = z.strictObject({ projectId: z.string().min(1), name: z.string().min(1).max(60), memberIds: z.array(z.string().min(1)).optional() }).parse(env.params);
        if (params.name.trim().length === 0) throw new DaemonCommandError('VALIDATION_INVALID', '房间名称不能为空白');
        const assertRoomCreationScope = (): void => {
          const project = deps.db.prepare('SELECT status FROM projects WHERE id = ?').get(params.projectId) as { status: string } | undefined;
          if (project == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', '项目不存在');
          if (project.status === 'archived' || project.status === 'removed') throw new DaemonCommandError('VALIDATION_INVALID', '项目已归档或移除，不能新建房间；请先恢复项目');
          for (const memberId of params.memberIds ?? []) {
            if (deps.db.prepare('SELECT id FROM project_members WHERE id = ? AND project_id = ?').get(memberId, params.projectId) == null) {
              throw new DaemonCommandError('VALIDATION_INVALID', '房间成员不属于目标项目；请刷新成员列表');
            }
          }
        };
        assertRoomCreationScope();
        const result = run(() => {
          assertRoomCreationScope();
          const roomCount = (deps.db.prepare('SELECT count(*) c FROM rooms WHERE project_id = ?').get(params.projectId) as { c: number }).c;
          const roomId = `room_${randomUUID()}`;
          const defaultMember = (deps.db.prepare('SELECT id FROM project_members WHERE project_id = ? AND principal_type = ? ORDER BY id LIMIT 1').get(params.projectId, 'agent') as { id: string } | undefined)?.id;
          deps.db.prepare('INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES (?, ?, ?, ?)').run(roomId, params.projectId, params.name, defaultMember ?? null);
          const convId = `conv_${randomUUID()}`;
          deps.db.prepare("INSERT INTO conversations (id, project_id, kind, room_id) VALUES (?, ?, 'room', ?)").run(convId, params.projectId, roomId);
          const members = params.memberIds ?? (deps.db.prepare('SELECT id FROM project_members WHERE project_id = ?').all(params.projectId) as Array<{ id: string }>).map((m) => m.id);
          for (const memberId of members) {
            deps.db.prepare('INSERT OR IGNORE INTO room_members (room_id, member_id) VALUES (?, ?)').run(roomId, memberId);
          }
          return { room: { id: roomId, name: params.name, conversationId: convId }, roomIndex: roomCount + 1 };
        }, assertRoomCreationScope);
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'room.list': {
        const params = z.strictObject({ projectId: z.string().min(1) }).parse(env.params);
        // R65：补 description（settings_json）与 revision（房间属性乐观锁用）+ archivedAt 时间戳。
        const rooms = deps.db.prepare('SELECT id, name, archived_at, coordinator_member_id, settings_json, revision FROM rooms WHERE project_id = ? ORDER BY id').all(params.projectId) as Array<{ id: string; name: string; archived_at: number | null; coordinator_member_id: string | null; settings_json: string | null; revision: number }>;
        const items = rooms.map((r) => {
          const conversation = deps.db.prepare('SELECT id FROM conversations WHERE room_id = ? LIMIT 1').get(r.id) as { id: string } | undefined;
          let description: string | null = null;
          try { description = ((JSON.parse(r.settings_json ?? '{}') as { description?: string }).description) ?? null; } catch { description = null; }
          return { id: r.id, name: r.name, archived: r.archived_at != null, archivedAt: r.archived_at, conversationId: conversation?.id ?? null, coordinatorMemberId: r.coordinator_member_id ?? null, description, revision: r.revision };
        });
        return withCommandId({ ok: true, data: { items } });
      }
      case 'member.list': {
        const params = z.strictObject({ projectId: z.string().min(1), roomId: z.string().min(1).optional() }).parse(env.params);
        if(deps.db.prepare('SELECT id FROM projects WHERE id=?').get(params.projectId)==null)throw new DaemonCommandError('RESOURCE_NOT_FOUND','成员名单项目不存在');
        if(params.roomId!=null){const room=deps.db.prepare('SELECT project_id FROM rooms WHERE id=?').get(params.roomId) as {project_id:string}|undefined;if(room==null||room.project_id!==params.projectId)throw new DaemonCommandError('RESOURCE_NOT_FOUND','房间不存在或不属于名单项目');}
        const rows = params.roomId != null
          ? (deps.db.prepare(`SELECT pm.id, pm.display_name, pm.principal_type, pm.enabled, pm.description, pm.settings_revision FROM room_members rm JOIN project_members pm ON pm.id = rm.member_id WHERE rm.room_id = ? AND pm.project_id = ? ORDER BY pm.id`).all(params.roomId, params.projectId) as Array<{ id: string; display_name: string; principal_type: string; enabled: number; description: string | null; settings_revision:number }>)
          : (deps.db.prepare('SELECT id, display_name, principal_type, enabled, description, settings_revision FROM project_members WHERE project_id = ? ORDER BY id').all(params.projectId) as Array<{ id: string; display_name: string; principal_type: string; enabled: number; description: string | null; settings_revision:number }>);
        return withCommandId({ ok: true, data: { items: rows.map((r) => ({ id: r.id, displayName: r.display_name, principalType: r.principal_type, enabled: r.enabled === 1, description: r.description ?? undefined, revision:r.settings_revision })) } });
      }
      case 'member.create': {
        // R67 P4（review-r66 §4：已批准原型有成员添加/实例配置入口——无用户延期依据，补正式合同）：
        // 成员=项目级实例（同名不合并，displayName 可重复——前端按 ordinal 区分由 UI 层处理）。
        // 分配边界沿用原型「添加后会怎样」：自动加入本项目全部**未归档**房间的名单；**不**自动
        // 成为协调者（房间级字段）；**不**加入正在运行研讨（只影响之后派发）。runtime 绑定不在
        // 本命令（沿既有 member.setRuntime——配置成功≠已认证）；不新增真实认证调用。
        const params = z.strictObject({
          projectId: z.string().min(1),
          displayName: z.string().min(1).max(60),
          description: z.string().max(200).optional(),
        }).parse(env.params);
        if (params.displayName.trim().length === 0) {
          throw new DaemonCommandError('VALIDATION_INVALID', '成员名称不能为空白（全空格）');
        }
        // R68 §5A：项目状态守卫——归档=只读（保留历史）、移除=仅解除关联；新增实体不得绕过
        // 状态边界（独立反例：archived 项目 member.create 仍成功，成员 1→2）。
        const assertProjectOpen = (): void => {
          const row = deps.db.prepare('SELECT status FROM projects WHERE id = ?').get(params.projectId) as { status: string } | undefined;
          if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目不存在：${params.projectId}`);
          if (row.status === 'archived') throw new DaemonCommandError('VALIDATION_INVALID', `项目已归档（只读——历史保留）：不能新增成员；如需继续协作请先恢复项目（project.lifecycle unarchive）`);
          if (row.status === 'removed') throw new DaemonCommandError('VALIDATION_INVALID', `项目已移除（仅解除关联）：不能新增成员；如需继续使用请先恢复项目（project.lifecycle restore）`);
        };
        assertProjectOpen();
        const proj = deps.db.prepare('SELECT id FROM projects WHERE id = ?').get(params.projectId) as { id: string } | undefined;
        if (proj == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目不存在：${params.projectId}`);
        const result = run(() => {
          const memberId = `m_${randomUUID()}`;
          deps.db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled, description)
                           VALUES (?, ?, ?, 'agent', 1, ?)`)
            .run(memberId, params.projectId, params.displayName, params.description ?? null);
          const roomsJoined = (deps.db.prepare(`INSERT INTO room_members (room_id, member_id)
                                                SELECT r.id, ? FROM rooms r WHERE r.project_id = ? AND r.archived_at IS NULL
                                                  AND NOT EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = r.id AND rm.member_id = ?)`)
            .run(memberId, params.projectId, memberId).changes);
          return { memberId, roomsJoined, coordinator: false, note: '已加入全部未归档房间；不自动成为协调者；不影响在途研讨（只影响之后派发）' };
        }, assertProjectOpen); // 重放守卫：旧回执重放同样受**当前**项目状态约束（归档/移除后拒绝）
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'member.setEnabled': {
        // 协作参与设置（第十六轮六）：停用成员=不再参与之后派发（enabledAgents 过滤已在生产链路）；
        // 在途 turn 不受影响（派发时点读取）。协调者不可停用（AUTO 路由依赖，明确拒绝不静默换人）。
        const params = z.strictObject({ memberId: z.string().min(1), projectId:z.string().min(1).optional(),expectedRevision:z.number().int().nonnegative().optional(), enabled: z.boolean() }).parse(env.params);
        // 校验在事务外（run 内抛领域错会被幂等网关包装成 STORAGE_UNAVAILABLE——丢失错误码）。
        const member = deps.db.prepare('SELECT pm.id, pm.enabled, r.coordinator_member_id FROM project_members pm LEFT JOIN rooms r ON r.coordinator_member_id = pm.id WHERE pm.id = ? LIMIT 1').get(params.memberId) as { id: string; enabled: number; coordinator_member_id: string | null } | undefined;
        if (member == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `成员不存在：${params.memberId}`);
        if (params.enabled === false && member.coordinator_member_id === member.id) {
          throw new DaemonCommandError('VALIDATION_INVALID', '协调者不可停用（房间 AUTO 路由依赖协调者——如需更换请先调整协调者）');
        }
        const scope=()=>{const row=deps.db.prepare('SELECT project_id FROM project_members WHERE id=?').get(params.memberId) as {project_id:string};assertMemberProject(deps.db,row.project_id,(c,m)=>{throw new DaemonCommandError(c,m);});};scope();
        const checkTarget=()=>{const target=deps.db.prepare('SELECT project_id,settings_revision FROM project_members WHERE id=?').get(params.memberId) as {project_id:string;settings_revision:number}|undefined;if(target==null)throw new DaemonCommandError('RESOURCE_NOT_FOUND','成员不存在');if(params.projectId!=null&&target.project_id!==params.projectId)throw new DaemonCommandError('RESOURCE_NOT_FOUND','成员不属于目标项目');if(params.expectedRevision!=null&&target.settings_revision!==params.expectedRevision)throw new DaemonCommandError('STALE_REVISION','成员版本已变化，请刷新后确认');};
        const result = run(() => {
          checkTarget();
          deps.db.prepare('UPDATE project_members SET enabled = ?, settings_revision=settings_revision+1 WHERE id = ?').run(params.enabled ? 1 : 0, params.memberId);
          return { memberId: params.memberId, enabled: params.enabled, scope: '该成员之后的派发（在途 turn 不受影响）' };
        },()=>{scope();if(params.projectId!=null){const row=deps.db.prepare("SELECT project_id FROM project_members WHERE id=?").get(params.memberId) as {project_id:string};if(row.project_id!==params.projectId)throw new DaemonCommandError("RESOURCE_NOT_FOUND","成员不属于目标项目");}});
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'member.setRuntime': {
        // 成员级 runtime 绑定（DEV-10）：成员→profile→installation 链落库；派发侧按此选 adapter。
        // fake 仅显式开发模式（ZS_ALLOW_FAKE=1）；claude 必须显式模型（默认配置不被 CLI 接受）。
        // capabilities_json 分开记录工具能力三态/模型可用性/权限认证——不因配置成功宣称已认证。
        const params = z.strictObject({
          memberId: z.string().min(1),
          projectId:z.string().min(1).optional(),expectedRevision:z.number().int().nonnegative().optional(),
          kind: z.enum(['codex', 'claude', 'fake']),
          model: z.string().min(1).optional(),
          executable: z.string().min(1).optional(),
          permissionMode: z.enum(['plan', 'manual', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']).optional(),
          effort:z.enum(['none','minimal','low','medium','high','xhigh','max']).optional(),
        }).parse(env.params);
        if (params.kind === 'fake' && process.env.ZS_ALLOW_FAKE !== '1') {
          throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', 'fake runtime 仅限显式开发模式（ZS_ALLOW_FAKE=1）');
        }
        if (params.kind === 'claude' && (params.model == null || params.model.length === 0)) {
          throw new DaemonCommandError('VALIDATION_INVALID', 'claude 绑定必须显式指定模型（如 deepseek-flash）');
        }
        // 真实派发防护下拒绝绑定真实 runtime（第三十八轮 #2——双机验收卡死主根因：用户在防护
        // 包中绑定 claude 后所有任务派发被 adapterFor 拒绝，UI 无事前警示、任务静默 FAILED）。
        // 派发侧硬防护保留（ZS_REAL_DISPATCH_GUARD 语义不变）；此处只是把「绑定后必死」提前为
        // 「绑定时明确拒绝」——恢复路径 kind=fake 不受影响（可解绑回模拟）。正式部署不设该变量
        // =真实绑定正常可用。
        if (process.env.ZS_REAL_DISPATCH_GUARD === '1' && (params.kind === 'claude' || params.kind === 'codex')) {
          throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', `验收防护模式（ZS_REAL_DISPATCH_GUARD=1）下不可绑定真实 runtime（${params.kind}）：绑定后该成员的所有任务派发都会被防护拒绝（零真实调用护栏）。本包用于模拟/验收——请保持 fake（member.setRuntime kind=fake，需 ZS_ALLOW_FAKE=1），或在正式部署环境（不设该变量）绑定真实渠道`);
        }
        const scope = () => { const m=deps.db.prepare('SELECT project_id FROM project_members WHERE id=?').get(params.memberId) as {project_id:string}|undefined; if(m==null)throw new DaemonCommandError('RESOURCE_NOT_FOUND','成员不存在');assertMemberProject(deps.db,m.project_id,(c,m)=>{throw new DaemonCommandError(c,m);}); };
        scope();
        const checkTarget=()=>{const target=deps.db.prepare('SELECT project_id,settings_revision FROM project_members WHERE id=?').get(params.memberId) as {project_id:string;settings_revision:number}|undefined;if(target==null)throw new DaemonCommandError('RESOURCE_NOT_FOUND','成员不存在');if(params.projectId!=null&&target.project_id!==params.projectId)throw new DaemonCommandError('RESOURCE_NOT_FOUND','成员不属于目标项目');if(params.expectedRevision!=null&&target.settings_revision!==params.expectedRevision)throw new DaemonCommandError('STALE_REVISION','成员版本已变化，请刷新后确认');};
        if(params.effort&&params.kind!=='fake'&&!deps.db.prepare('SELECT 1 FROM command_receipts WHERE idempotency_scope=? AND command_id=?').get(localScope(deps.localUserId),env.commandId)) {
          checkTarget();
          const context=deps.db.prepare('SELECT p.canonical_path FROM project_members m JOIN projects p ON p.id=m.project_id WHERE m.id=?').get(params.memberId) as {canonical_path:string};
          const options=await runtimeOptions(params.kind,params.executable,params.model,context.canonical_path);
          if(!options.efforts.includes(params.effort))throw new DaemonCommandError('CAPABILITY_UNSUPPORTED',`当前实际配置未声明思考等级 ${params.effort}：${options.reason}`);
        }
        const result = run(() => {
          checkTarget();
          scope();
          const member = deps.db.prepare('SELECT id FROM project_members WHERE id = ?').get(params.memberId) as { id: string } | undefined;
          if (member == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `成员不存在：${params.memberId}`);
          return bindMemberRuntime(deps.db,params.memberId,{kind:params.kind,executable:params.executable??params.kind,model:params.model??null,permissionMode:params.permissionMode??(params.kind==='fake'?'plan':'bypassPermissions'),effort:params.effort??null});
        },()=>{scope();if(params.projectId!=null){const row=deps.db.prepare("SELECT project_id FROM project_members WHERE id=?").get(params.memberId) as {project_id:string};if(row.project_id!==params.projectId)throw new DaemonCommandError("RESOURCE_NOT_FOUND","成员不属于目标项目");}});
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'member.runtimeOptions': {
        if(deps.remoteAudit)throw new DaemonCommandError('PERMISSION_DENIED','CLI 选项读取仅限本机可信入口');
        const params=z.strictObject({projectId:z.string().min(1),kind:z.enum(['claude','codex','fake']),model:z.string().optional(),executable:z.string().optional()}).parse(env.params);
        const project=deps.db.prepare('SELECT canonical_path FROM projects WHERE id=?').get(params.projectId) as {canonical_path:string}|undefined;
        if(!project)throw new DaemonCommandError('RESOURCE_NOT_FOUND','项目不存在');
        return withCommandId({ok:true,data:await runtimeOptions(params.kind,params.executable,params.model,project.canonical_path)});
      }
      case 'member.runtime': {
        const params = z.strictObject({ memberId: z.string().min(1) }).parse(env.params);
        // R66 P5：**有效派发来源**分列（R65 反例：界面显示「未绑定」，实际未绑定成员回落到
        // 全局默认渠道 ZS_RUNTIME=claude——两件不同事实）。与派发侧 MemberRuntimeRegistry
        // 同一解析（resolveMemberRuntime：未绑定→defaultKind+默认模型），defaultKind 与
        // entry.ts 的 options.runtime 同源（ZS_RUNTIME）。
        // 环境模式（第三十八轮 #2：验收防护包真实渠道被拒绑——设置 UI 据此提供 fake 正路径，
        // 用户不再需要脚本自救；正式部署两标志皆 false=fake 不进产品设置面，原决策不变）。
        return withCommandId({ ok: true, data: memberRuntimeInfo(deps.db, params.memberId) });
      }
      case 'member.runtimes': {
        const params = z.strictObject({ projectId: z.string().min(1), memberIds: z.array(z.string().min(1)).max(500).optional() }).parse(env.params);
        if (deps.db.prepare('SELECT id FROM projects WHERE id=?').get(params.projectId) == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', '成员读取项目不存在');
        const selected = params.memberIds == null ? null : [...new Set(params.memberIds)];
        const rows = selected == null
          ? deps.db.prepare('SELECT id FROM project_members WHERE project_id=? ORDER BY id LIMIT 501').all(params.projectId) as Array<{id:string}>
          : selected.length === 0 ? [] : deps.db.prepare(`SELECT id FROM project_members WHERE project_id=? AND id IN (${selected.map(() => '?').join(',')})`).all(params.projectId, ...selected) as Array<{id:string}>;
        if (rows.length > 500) throw new DaemonCommandError('VALIDATION_INVALID', '项目成员超过批量读取上限500；请分批读取成员配置');
        const inProject = new Set(rows.map(r => r.id));
        const ids = selected ?? rows.map(r => r.id);
        if (ids.some(id => !inProject.has(id))) throw new DaemonCommandError('VALIDATION_INVALID', '批量读取中的成员不属于目标项目');
        const readContext: ImageCapabilityReadContext = new Map(); // Bounded to this one read command, not a cache across polls or sends.
        const items = ids.map(memberId => {
          try { return { memberId, info: memberRuntimeInfo(deps.db, memberId, readContext) }; }
          catch (error) { return { memberId, error: { code: error instanceof DaemonCommandError ? error.code : 'STORAGE_UNAVAILABLE', message: (error as Error).message } }; }
        });
        return withCommandId({ ok: true, data: { projectId: params.projectId, items, snapshot: 'one-read-request', dispatchRecheck: 'independent-before-send-and-spawn' } });
      }
      case 'thread.history': {
        const params = z.strictObject({ threadId: z.string().min(1), beforeSeq: z.number().int().optional(), limit: z.number().int().min(1).max(200).optional() }).parse(env.params);
        const scope=deps.db.prepare('SELECT conversation_id FROM conversation_threads WHERE id=?').get(params.threadId) as {conversation_id:string}|undefined;
        if(!scope)throw new DaemonCommandError('RESOURCE_NOT_FOUND','回复串不存在');
        assertConversationAudience(deps.db,deps.localUserId,scope.conversation_id);
        const limit = params.limit ?? 50;
        const rows = (params.beforeSeq != null
          ? deps.db.prepare('SELECT id, author_type, author_id, thread_message_seq, body_json, created_at FROM messages WHERE thread_id = ? AND thread_message_seq < ? ORDER BY thread_message_seq DESC LIMIT ?').all(params.threadId, params.beforeSeq, limit)
          : deps.db.prepare('SELECT id, author_type, author_id, thread_message_seq, body_json, created_at FROM messages WHERE thread_id = ? ORDER BY thread_message_seq DESC LIMIT ?').all(params.threadId, limit)) as Array<{ id: string; author_type: string; author_id: string; thread_message_seq: number; body_json: string; created_at: number }>;
        const items = rows.reverse().map((r) => ({ id: r.id, authorType: r.author_type, authorId: r.author_id, seq: r.thread_message_seq, body: JSON.parse(r.body_json) as { text: string }, createdAt: r.created_at }));
        // 消息附件（第二十七轮三：已发消息附件可点击预览——能力②闭环到页面）。
        attachMessageSummaries(deps.db, items);
        const requestRows=(items.length?deps.db.prepare(`SELECT r.message_id,r.status,r.error_message,r.run_id,r.turn_id FROM conversation_reply_requests r JOIN messages m ON m.id=r.message_id
          WHERE r.thread_id=? AND r.conversation_id=? AND r.project_id=m.project_id AND r.task_id=m.task_id AND r.thread_id=m.thread_id AND r.message_id IN (${items.map(()=>'?').join(',')})`).all(params.threadId,scope.conversation_id,...items.map(i=>i.id)):[]) as Array<{message_id:string;status:string;error_message:string|null;run_id:string|null;turn_id:string|null}>;
        const requestByMessage=new Map(requestRows.map(r=>[r.message_id,r]));
        for(const item of items){const r=requestByMessage.get(item.id);if(r)Object.assign(item,{replyExecution:{status:r.status,error:r.error_message,runId:r.run_id,turnId:r.turn_id}});}
        // 根消息（房间级锚消息——不在 thread 历史内）的附件摘要：线程视图锚块渲染芯片来源。
        const anchorId = (deps.db.prepare('SELECT anchor_message_id FROM conversation_threads WHERE id = ?').get(params.threadId) as { anchor_message_id: string | null } | undefined)?.anchor_message_id ?? null;
        const rootAttachments = anchorId != null ? (messageAttachmentSummaries(deps.db, [anchorId]).get(anchorId) ?? []) : [];
        return withCommandId({ ok: true, data: { items, rootAttachments } });
      }
      case 'thread.get': {
        // H2（第五十一轮）：线程实体+根消息投影——thread.history 只返回 items/rootAttachments，
        // 线程实体（归属/根任务/水位）与根消息正文此前由旧界面从主池卡片随路携带，深链直达
        // 线程时无来源。DTO 缺口正式补齐：只读、归属核验（线程→会话→audience），不猜字段。
        const params = z.strictObject({ threadId: z.string().min(1) }).parse(env.params);
        const th = deps.db.prepare(
          'SELECT id, project_id, conversation_id, room_id, anchor_message_id, root_task_id, status, last_message_seq, revision FROM conversation_threads WHERE id = ?',
        ).get(params.threadId) as
          | { id: string; project_id: string; conversation_id: string; room_id: string; anchor_message_id: string; root_task_id: string | null; status: string; last_message_seq: number; revision: number }
          | undefined;
        if (th == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `线程不存在或已删除：${params.threadId}`);
        assertConversationAudience(deps.db, deps.localUserId, th.conversation_id);
        const anchorRow = deps.db.prepare('SELECT id, author_type, author_id, body_json, created_at, conversation_seq FROM messages WHERE id = ?').get(th.anchor_message_id) as
          | { id: string; author_type: string; author_id: string; body_json: string; created_at: number; conversation_seq: number }
          | undefined;
        let anchor: { id: string; authorType: string; authorId: string; body: { text: string }; createdAt: number; conversationSeq: number; attachments: Array<{ artifactId: string; filename: string; kind: string }> } | null = null;
        if (anchorRow != null) {
          const attachments = messageAttachmentSummaries(deps.db, [anchorRow.id]).get(anchorRow.id) ?? [];
          try { anchor = { id: anchorRow.id, authorType: anchorRow.author_type, authorId: anchorRow.author_id, body: JSON.parse(anchorRow.body_json) as { text: string }, createdAt: anchorRow.created_at, conversationSeq: anchorRow.conversation_seq, attachments }; } catch { /* 残缺正文不虚构——anchor 置空由呈现层标注 */ }
        }
        const lastReadSeq = (deps.db.prepare('SELECT last_read_message_seq FROM thread_read_states WHERE thread_id = ? AND viewer_id = ?').get(params.threadId, deps.localUserId) as { last_read_message_seq: number } | undefined)?.last_read_message_seq ?? 0;
        return withCommandId({ ok: true, data: { thread: { id: th.id, projectId: th.project_id, conversationId: th.conversation_id, roomId: th.room_id, anchorMessageId: th.anchor_message_id, rootTaskId: th.root_task_id, status: th.status, lastMessageSeq: th.last_message_seq, revision: th.revision }, anchor, lastReadSeq } });
      }
      case 'task.get': {
        const params = z.strictObject({ taskId: z.string().min(1) }).parse(env.params);
        assertTaskAudience(deps.db, deps.localUserId, params.taskId); // 按 ID 直查不绕过私信边界（第三十二轮一）
        const task = deps.db.prepare('SELECT id, title, objective, status, project_id, conversation_id, room_id, conversation_thread_id, room_task_number, owner_member_id, parent_task_id, review_policy, current_delivery_id, response_kind, route_json, revision, stop_generation FROM tasks WHERE id = ?').get(params.taskId) as Record<string, unknown> | undefined;
        if (task == null) return withCommandId({ ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '任务不存在', retryable: false } });
        const activeRun = deps.db.prepare('SELECT id, status FROM workflow_runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1').get(params.taskId) as { id: string; status: string } | undefined;
        // 待验收交付（第九轮：验收操作绑定具体版本——UI 展示与提交同源）。
        const pendingDelivery = deps.db.prepare(`SELECT id, revision, manifest_hash FROM task_deliveries WHERE task_id = ? AND review_status = 'pending' LIMIT 1`).get(params.taskId) as { id: string; revision: number; manifest_hash: string } | undefined;
        // 最近一次启动失败原因（第十六轮四：验收防护拒绝等如实上屏——「待处理/失败」无解释=用户不可知）。
        const lastStartupFailure = (deps.db.prepare(
          `SELECT e.payload_json FROM domain_events e JOIN agent_turns t ON t.id = e.turn_id
           WHERE e.kind = 'turn.startupFailed' AND t.run_id IN (SELECT id FROM workflow_runs WHERE task_id = ?)
           ORDER BY e.seq DESC LIMIT 1`,
        ).get(params.taskId) as { payload_json: string } | undefined);
        let lastStartupFailureMessage: string | null = null;
        if (lastStartupFailure != null) {
          try { lastStartupFailureMessage = (JSON.parse(lastStartupFailure.payload_json) as { message?: string }).message?.slice(0, 200) ?? null; } catch { /* 残缺不虚构 */ }
        }
        // r58 返工待执行（验收与执行分离呈现：「意见已记录、尚未执行」/已入队）。
        // r59：完整执行身份随行（deliveryId/manifestHash/sourceRunId——命令快照绑定用）。
        const reworkDerived = reworkPendingOf(deps.db, params.taskId);
        const { route_json: route, ...facts } = task;
        return withCommandId({ ok: true, data: { task: { ...facts, mode: taskModeFromRoute(route), stopGeneration: task.stop_generation }, activeRun: activeRun ?? null, pendingDelivery: pendingDelivery ?? null, reworkPending: reworkDerived == null ? null : { deliveryId: reworkDerived.deliveryId, deliveryRevision: reworkDerived.deliveryRevision, manifestHash: reworkDerived.manifestHash, sourceRunId: reworkDerived.sourceRunId, note: reworkDerived.note, queued: reworkDerived.queued }, ...(lastStartupFailureMessage != null ? { lastStartupFailureMessage } : {}) } });
      }
      case 'task.history':
      case 'task.details': {
        // R78: bounded read-only projection. Bind claimed project/task/run before reading children,
        // turns, event payload summaries or private delivery history.
        const params = (env.method === 'task.history' ? taskHistoryParamsSchema : taskDetailsParamsSchema).parse(env.params);
        const target = deps.db.prepare('SELECT project_id, conversation_id FROM tasks WHERE id = ?').get(params.taskId) as
          | { project_id: string; conversation_id: string } | undefined;
        if (target == null || target.project_id !== params.projectId) throw new DaemonCommandError('RESOURCE_NOT_FOUND', '任务不属于目标项目或不存在');
        if (params.conversationId!=null&&params.conversationId!==target.conversation_id) throw new DaemonCommandError('RESOURCE_NOT_FOUND','任务不属于当前会话');
        assertConversationAudience(deps.db, deps.localUserId, target.conversation_id);
        if (params.runId != null && deps.db.prepare('SELECT 1 FROM workflow_runs WHERE id = ? AND task_id = ? AND conversation_id = ?').get(params.runId, params.taskId, target.conversation_id) == null) {
          throw new DaemonCommandError('RESOURCE_NOT_FOUND', '运行不属于目标任务或不存在');
        }
        return withCommandId({ ok: true, data: env.method === 'task.history' ? readTaskHistory(deps.db, taskHistoryParamsSchema.parse(env.params)) : readTaskDetails(deps.db, params.taskId, params.runId) });
      }
      case 'message.protocol': {
        const p=z.strictObject({projectId:z.string().min(1),messageId:z.string().min(1)}).parse(env.params);
        const row=deps.db.prepare('SELECT project_id,conversation_id,author_type,body_json FROM messages WHERE id=? AND project_id=?').get(p.messageId,p.projectId) as {project_id:string;conversation_id:string;author_type:string;body_json:string}|undefined;
        if(!row)throw new DaemonCommandError('RESOURCE_NOT_FOUND','消息不存在或不属于目标项目');
        assertConversationAudience(deps.db,deps.localUserId,row.conversation_id);
        const body=JSON.parse(row.body_json) as {text?:string;runtimeControlResult?:string};
        const text=row.author_type==='agent'?body.runtimeControlResult??(body.text&&chatAnswer(body.text,'agent')!==body.text?body.text:null):null;
        return withCommandId({ok:true,data:{text,sha256:text?createHash('sha256').update(text).digest('hex'):null,note:text?'原始运行结果，只读；普通复制使用可读回答':'这条消息没有运行控制协议'}});
      }
      case 'message.writeCapability':
      case 'message.imageCapability': {
        const params = z.strictObject({ target: messageSubmitParams.shape.target, mentions: messageSubmitParams.shape.mentions }).parse(env.params);
        const target = params.target;
        assertConversationAudience(deps.db, deps.localUserId, target.conversationId);
        const scope = deps.db.prepare('SELECT project_id, kind, room_id FROM conversations WHERE id=?').get(target.conversationId) as { project_id: string; kind: string; room_id: string | null } | undefined;
        if (scope == null || scope.project_id !== target.projectId || target.kind === 'dm' && scope.kind !== 'dm'
          || target.kind === 'room_root' && scope.room_id !== target.roomId) throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '图片能力读取目标与会话归属不一致');
        if (target.kind === 'thread') {
          const th = deps.db.prepare('SELECT conversation_id FROM conversation_threads WHERE id=?').get(target.threadId) as { conversation_id: string } | undefined;
          if (th?.conversation_id !== target.conversationId) throw new DaemonCommandError('THREAD_SCOPE_MISMATCH', '图片能力读取目标与线程归属不一致');
        }
        let members: string[] = []; let willDispatch = target.kind !== 'thread'; let direct = true;
        const conversation=target.kind==='thread'?conversationFacts(deps.db,target.threadId):null;
        if(conversation){willDispatch=true;members=[conversation.memberId];const blocked=conversationBlock(deps.db,conversation,process.env.ZS_RUNTIME??null,deps.localUserId);if(blocked)return withCommandId({ok:true,data:{willDispatch:true,blocked:true,modificationAuthorized:false,reason:blocked.message,supported:false,members:[]}});}
        if (target.kind === 'dm') {
          const peer = dmPeerOf(deps.db, target.conversationId); if (peer != null) members = [peer.principal_id];
        } else if (target.kind === 'room_root') {
          const route = resolveTopLevelRoute({ intent: 'default', mentions: params.mentions as MentionNode[], room: { coordinatorMemberId: coordinatorOf(deps.db, target.roomId), enabledAgentMemberIds: enabledAgents(deps.db, target.roomId) } });
          if (!route.ok) throw new DaemonCommandError(route.error.code, route.error.message);
          if (route.value.kind === 'dispatch') { members = [...route.value.frozenMemberIds]; direct = route.value.mode === 'DIRECT'; }
        }
        if(env.method==='message.writeCapability') {
          const full=members.length>0&&members.every(id=>{const runtime=resolveMemberRuntime(deps.db,id,process.env.ZS_RUNTIME??null);return runtime.permissionMode==null||runtime.permissionMode==='bypassPermissions';});
          if(willDispatch&&direct&&full)return withCommandId({ok:true,data:{willDispatch,fullAccess:true,modificationAuthorized:true,reason:'CLI 完整权限：可读写电脑并执行命令；仅按本次用户目标操作'}});
          const grant=projectWriteAccess(deps.db,target.projectId);
          const project=deps.db.prepare('SELECT canonical_path,root_path,status FROM projects WHERE id=?').get(target.projectId) as {canonical_path:string;root_path:string;status:string};
          let reason=!willDispatch?'线程跟进仅保存记录':!direct?'当前仅支持指定成员的 DIRECT 派发':!grant.authorized?'项目默认只读，尚未明确授权':null;
          if(!reason)try{if(project.status!=='active'||realpathSync.native(project.root_path)!==grant.root||physicalRootIdentity(project.canonical_path)!==grant.physicalIdentity)reason='项目目录身份已变化或不可用';}catch{reason='授权目录不可读取，未开放写入';}
          if(!reason && (!members.length||members.some(id=>{const r=resolveMemberRuntime(deps.db,id,process.env.ZS_RUNTIME??null);return !['claude','codex','fake'].includes(r.kind??'')||!['acceptEdits','dontAsk'].includes(r.permissionMode??'');}))) reason='执行成员仍为只读权限档';
          return withCommandId({ok:true,data:{willDispatch,modificationAuthorized:reason==null,reason:reason??'项目内文件编辑；Shell、网络工具与委派未开放，派发前再次核对授权与配置'}});
        }
        const capabilities = members.map((id) => memberImageCapability(deps.db, id));
        return withCommandId({ ok: true, data: { willDispatch, supported: !willDispatch || direct && capabilities.length > 0 && capabilities.every((c) => c.status === 'supported'), members: capabilities } });
      }
      case 'message.submit': {
        const params = messageSubmitParams.parse(env.params);
        // 重放守卫（第三十一轮一）：旧回执不绕过当前状态——重放同号同参请求时若目标
        // 会话已归档/归属变化/audience 失效，明确拒绝。
        const submitReplayGuard = (): void => {
          const t = params.target as { kind: string; projectId: string; conversationId: string; threadId?:string };
          if (t.kind === 'thread') {
            const th = deps.db.prepare('SELECT conversation_id, project_id FROM conversation_threads WHERE id = ?').get((params.target as { threadId: string }).threadId) as { conversation_id: string; project_id: string } | undefined;
            if (th == null || th.conversation_id !== t.conversationId || th.project_id !== t.projectId) throw new DaemonCommandError('THREAD_SCOPE_MISMATCH', '线程目标与项目/会话不一致（重放拒绝）');
          }
          const conv = deps.db.prepare('SELECT id, project_id, kind, archived_at FROM conversations WHERE id = ?').get(t.conversationId) as { id: string; project_id: string; kind: string; archived_at: number | null } | undefined;
          if (conv == null || conv.project_id !== t.projectId) throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '目标会话不存在或不属于该项目（重放拒绝）');
          assertConversationAudience(deps.db, deps.localUserId, t.conversationId);
          if(t.kind==='thread'){const th=deps.db.prepare('SELECT th.status,r.archived_at,p.status projectStatus FROM conversation_threads th JOIN rooms r ON r.id=th.room_id JOIN projects p ON p.id=th.project_id WHERE th.id=?').get(t.threadId) as {status:string;archived_at:number|null;projectStatus:string}|undefined;if(!th||th.status!=='open'||th.archived_at!=null||th.projectStatus!=='active')throw new DaemonCommandError('CONVERSATION_UNAVAILABLE','项目、房间或回复串已归档；不能追加消息');}
          if (t.kind === 'dm' && conv.archived_at != null) throw new DaemonCommandError('CONVERSATION_ARCHIVED', '对话已归档：禁止新发/续跑（重放拒绝）');
        };
        if(params.intent==='default'&&deps.prepareRuntimeConfiguration&&!deps.db.prepare('SELECT 1 FROM command_receipts WHERE idempotency_scope=? AND command_id=?').get(scope,env.commandId)){
          submitReplayGuard();
          let memberId:string|null=null;
          if(params.target.kind==='dm'){
            const audience=deps.db.prepare("SELECT principal_id FROM dm_participants WHERE conversation_id=? AND principal_type='agent'").get(params.target.conversationId) as {principal_id:string}|undefined;
            memberId=audience?.principal_id??null;
          }else if(params.target.kind==='thread'){const f=conversationFacts(deps.db,params.target.threadId);if(f){const blocked=conversationBlock(deps.db,f,process.env.ZS_RUNTIME??null,deps.localUserId);if(blocked)throw new DaemonCommandError(blocked.code,blocked.message);}memberId=f?.memberId??null;}
          else if(params.mentions.length===1&&params.mentions[0]?.kind==='member')memberId=params.mentions[0].memberId;
          if(memberId&&resolveMemberRuntime(deps.db,memberId,process.env.ZS_RUNTIME??null).kind==='codex'){
            try{await deps.prepareRuntimeConfiguration(memberId,params.target.projectId);}catch(e){throw new DaemonCommandError('CONFIGURATION_NOT_READY',`执行配置尚未就绪：${(e as Error).message}；没有提交模型输入，草稿保留`);}
          }
        }
        const result = run(() => {
          submitReplayGuard();
          if (params.target.kind === 'thread') {
            const target = params.target;
            // 线程跟进（修复轮 6）：沿用绑定线程的当前任务（§4.2 串内跟进）——
            // 不新建根任务；目标在提交时固定。M0 仅支持人类跟进输入（按 steering 落库）。
            return deps.db.transaction(() => {
              const thread = deps.db.prepare('SELECT id, project_id, conversation_id, room_id, root_task_id, last_message_seq FROM conversation_threads WHERE id = ?').get(target.threadId) as
                | { id: string; project_id: string; conversation_id: string; room_id: string; root_task_id: string | null; last_message_seq: number }
                | undefined;
              if (thread == null || thread.project_id !== params.target.projectId || thread.conversation_id !== params.target.conversationId) {
                throw new DaemonCommandError('THREAD_SCOPE_MISMATCH', '线程目标与项目/会话不一致，拒绝提交（§4.5）');
              }
              if (thread.root_task_id == null) {
                // 记录串（E1）：讨论线程永不唤醒 agent——默认仍是保存记录（图片门不适用：零派发）。
                const resolvedAtts = resolveAttachmentRefs(deps.db, target.conversationId, params.attachmentRefs);
                assertAttachmentRanges(deps.db, resolvedAtts, params.attachmentRanges);
                const saved = insertThreadMessage(deps.db, {
                  projectId: params.target.projectId,
                  conversationId: target.conversationId,
                  roomId: thread.room_id,
                  threadId: thread.id,
                  threadMessageSeq: thread.last_message_seq + 1,
                  body: params.body,
                  mentions: params.mentions as MentionNode[],
                  authorId: deps.localUserId,
                  taskId: null,
                });
                attachMessageRefs(deps.db, saved.messageId, resolvedAtts, params.attachmentRanges, params.intent === 'record_only' ? 'local-only' : params.imageAck === 'omit-images' ? 'omit' : 'include');
                return saved;
              }
              // 任务串：M0 阶段人类跟进先落消息并标记待处理（task.steer 的完整调度
              // 由 DEV-08/09 扩展；此处持久化目标+内容，不新建根任务、不假装已派发）。
              const ordinary=conversationFacts(deps.db,thread.id);
              const dispatchOrdinary=params.intent==='default'&&ordinary!=null;
              if(params.intent==='default'&&!ordinary&&deps.db.prepare("SELECT 1 FROM conversation_reply_requests WHERE task_id=?").get(thread.root_task_id)&&deps.db.prepare("SELECT 1 FROM task_deliveries WHERE task_id=?").get(thread.root_task_id))throw new DaemonCommandError('CONVERSATION_BECAME_WORK','这段对话已产生工作交付；请明确选择仅记录保存意见，再从原交付执行返工。输入保留');
              if(dispatchOrdinary){
                const blocked=conversationBlock(deps.db,ordinary,process.env.ZS_RUNTIME??null,deps.localUserId);
                if(blocked)throw new DaemonCommandError(blocked.code,blocked.message);
                if(params.mentions.some(m=>m.kind!=='member'||m.memberId!==ordinary.memberId))throw new DaemonCommandError('CONVERSATION_TARGET_CHANGED','普通续问绑定原执行成员，不能静默更换成员');
              }
              const resolvedAtts = resolveAttachmentRefs(deps.db, target.conversationId, params.attachmentRefs);
              assertImageGate(resolvedAtts,dispatchOrdinary,params.imageAck,params.body,ordinary!=null&&memberImageCapability(deps.db,ordinary.memberId).status==='supported');
              assertAttachmentRanges(deps.db, resolvedAtts, params.attachmentRanges);
              const message = insertThreadMessage(deps.db, {
                projectId: params.target.projectId,
                conversationId: params.target.conversationId,
                roomId: thread.room_id,
                threadId: thread.id,
                threadMessageSeq: thread.last_message_seq + 1,
                body: params.body,
                mentions: params.mentions as MentionNode[],
                authorId: deps.localUserId,
                taskId: thread.root_task_id,
              });
              attachMessageRefs(deps.db, message.messageId, resolvedAtts, params.attachmentRanges, params.intent === 'record_only' ? 'local-only' : params.imageAck === 'omit-images' ? 'omit' : 'include');
              deps.db.prepare("UPDATE messages SET body_json=json_set(body_json,'$.conversationIntent',?) WHERE id=?").run(params.intent,message.messageId);
              if(dispatchOrdinary){const dispatchKey=enqueueConversationReply(deps.db,ordinary,message.messageId,message.threadMessageSeq);return{...message,disposition:'enqueued' as const,taskId:thread.root_task_id,followUpRecorded:false,dispatchKey};}
              return { ...message, disposition: 'none' as const, taskId: thread.root_task_id, followUpRecorded: true };
            })();
          }
          const target = params.target;
          if (target.kind === 'dm') {
            // 私信发送（DEV-22；R4 §2.3/§4.6）：mentions 必空（无 @ 派工）；record_only 只保存；
            // 附件=DEV-24 文本首包（第二十六轮五）：attachmentRefs=artifacts.id——归属/能力校验
            // 走四通道共用 resolveAttachmentRefs（第二十七轮二），消息-附件关联同事务。
            if (params.mentions.length > 0) throw new DaemonCommandError('VALIDATION_INVALID', '私信不做 @ 派工（§4.6 一对一）：mentions 必须为空');
            const resolvedAtts = resolveAttachmentRefs(deps.db, target.conversationId, params.attachmentRefs);
            const imagePeer = dmPeerOf(deps.db, target.conversationId);
            assertImageGate(resolvedAtts, params.intent === 'default', params.imageAck, params.body, imagePeer != null && memberImageCapability(deps.db, imagePeer.principal_id).status === 'supported'); // 默认意图=派发（能力门先于落库；空正文+仅图片+仅文字=空模型输入拒）
            assertAttachmentRanges(deps.db, resolvedAtts, params.attachmentRanges);
            const conv = dmConversationOf(deps.db, target.conversationId);
            if (conv == null || conv.kind !== 'dm' || conv.project_id !== target.projectId) {
              throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '目标不是该项目的私信会话');
            }
            if (conv.archived_at != null) {
              throw new DaemonCommandError('CONVERSATION_ARCHIVED', '对话已归档：禁止新发/续跑，保留历史（R4 §2.1）');
            }
            const peer = dmPeerOf(deps.db, target.conversationId);
            if (peer == null) throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '私信会话缺少 Agent 对端（数据不完整）');
            return deps.db.transaction(() => {
              const r = createDmTurn(deps.db, {
                conversationId: target.conversationId,
                projectId: target.projectId,
                peerMemberId: peer.principal_id,
                localUserId: deps.localUserId,
                body: params.body,
                intent: params.intent,
                title: taskTitleOf(params.body, resolvedAtts.map((a) => a.displayName)),
                reviewPolicy: reviewPolicyOf(deps.db, target.projectId),
              });
              attachMessageRefs(deps.db, r.messageId, resolvedAtts, params.attachmentRanges, params.intent === 'record_only' ? 'local-only' : params.imageAck === 'omit-images' ? 'omit' : 'include');
              try{snapshotTaskWriteAccess(deps.db,r.taskId);}catch(e){throw new DaemonCommandError('CAPABILITY_UNSUPPORTED',(e as Error).message);}
              appendDomainEvent(deps.db, {
                schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: target.projectId,
                conversationId: target.conversationId, threadId: null, runId: null, taskId: r.taskId,
                turnId: null, kind: 'message.submitted', createdAt: Date.now(),
                payload: { target: 'dm', disposition: r.disposition, intent: params.intent, taskId: r.taskId, note: r.note ?? null },
              });
              return { messageId: r.messageId, conversationId: target.conversationId, threadId: null, taskId: r.taskId, disposition: r.disposition, note: r.note ?? null };
            })();
          }
          if (target.kind !== 'room_root') throw new DaemonCommandError('VALIDATION_INVALID', '路由目标缺失');
          // 附件（第二十七轮二：主池通道补齐——此前主池发送带 attachmentRefs 被后端静默忽略）：
          // 归属/能力校验共用；关联与 createRoomRootTask 同事务（根消息 id=ids.messageId，
          // record/dispatch 两类路由结果都挂——record_only 零派发只保存）。
          const resolvedAtts = resolveAttachmentRefs(deps.db, target.conversationId, params.attachmentRefs);
          const route = resolveTopLevelRoute({
            intent: params.intent,
            mentions: params.mentions as MentionNode[],
            room: {
              coordinatorMemberId: coordinatorOf(deps.db, target.roomId),
              enabledAgentMemberIds: enabledAgents(deps.db, target.roomId),
            },
          });
          if (!route.ok) throw new DaemonCommandError(route.error.code, route.error.message);
          assertImageGate(resolvedAtts, route.value.kind === 'dispatch', params.imageAck, params.body, route.value.kind === 'dispatch' && route.value.mode === 'DIRECT' && route.value.frozenMemberIds.every((id) => memberImageCapability(deps.db, id).status === 'supported')); // 派发路由才设门（record_only 零派发；空正文+仅图片+仅文字=空模型输入拒）
          assertAttachmentRanges(deps.db, resolvedAtts, params.attachmentRanges);
          return deps.db.transaction(() => {
            const ids = {
              messageId: `msg_${randomUUID()}`,
              threadId: `thread_${randomUUID()}`,
              taskId: `task_${randomUUID()}`,
              taskEventId: `evt_${randomUUID()}`,
              threadEventId: `evt_${randomUUID()}`,
            };
            const created = createRoomRootTask(deps.db, {
              ids,
              projectId: target.projectId,
              conversationId: target.conversationId,
              roomId: target.roomId,
              intent: params.intent,
              title: taskTitleOf(params.body, resolvedAtts.map((a) => a.displayName)),
              body: params.body,
              mentions: params.mentions as MentionNode[],
              author: { authorType: 'human', authorId: deps.localUserId },
              reviewPolicy: reviewPolicyOf(deps.db, params.target.projectId),
              sourceConnectionId: null,
              route: route.value as TopLevelRouteOutcome,
              now: Date.now(),
            });
            if (!created.ok) throw new DaemonCommandError(created.error.code, created.error.message);
            try{snapshotTaskWriteAccess(deps.db,ids.taskId);}catch(e){throw new DaemonCommandError('CAPABILITY_UNSUPPORTED',(e as Error).message);}
            attachMessageRefs(deps.db, ids.messageId, resolvedAtts, params.attachmentRanges, params.intent === 'record_only' ? 'local-only' : params.imageAck === 'omit-images' ? 'omit' : 'include');
            return created.value;
          })();
        }, submitReplayGuard);
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'thread.toolCalls': {
        // 线程内工具审计（2026-09-28 第五轮）：真源=worker 落库的 tool.started/tool.completed
        // 审计事件（非模型 executedVerifications 自述）。按线程→task 限定隔离；合并键=
        // turnId+toolCallId（带作用域——不同 turn/成员的同名 toolCallId 各自保留）；
        // started 取首、completed 取末（结果与完成时间取自同一条选定事件）；eventKey 重复
        // 不重复计数；身份不完整（缺 turnId 或 toolCallId）的事件保留为未归属条目，不按
        // 时间戳强行合并。字段范围：toolCallId/toolName/outcome/eventKey/成员与 turn 归属
        // ——工具参数正文不落库（worker 审计不含参数），因此查询面不含参数与凭据字段。
        const params = z.strictObject({ threadId: z.string().min(1) }).parse(env.params);
        const rows = deps.db.prepare(
          `SELECT de.kind, de.payload_json, de.created_at, de.turn_id
           FROM domain_events de
           WHERE de.kind IN ('tool.started','tool.completed')
             AND de.task_id IN (SELECT id FROM tasks WHERE conversation_thread_id = ?)
           ORDER BY de.seq`,
        ).all(params.threadId) as Array<{ kind: string; payload_json: string; created_at: number; turn_id: string | null }>;
        interface ToolCallItem {
          toolCallId: string; toolName: string | null; memberId: string | null; turnId: string | null;
          startedAt: number | null; completedAt: number | null; outcome: string | null;
          eventKeys: string[]; unattributed: boolean;
        }
        const byCall = new Map<string, ToolCallItem>();
        const pushEventKey = (item: ToolCallItem, eventKey: string | undefined): void => {
          if (eventKey != null && !item.eventKeys.includes(eventKey)) item.eventKeys.push(eventKey);
        };
        for (const r of rows) {
          const payload = JSON.parse(r.payload_json) as { toolCallId?: string; toolName?: string; outcome?: string; eventKey?: string };
          const hasIdentity = r.turn_id != null && payload.toolCallId != null;
          // 带作用域的合并键：turnId+toolCallId；身份不完整 → 每条事件独立未归属条目（seq 唯一）。
          const key = hasIdentity ? `${r.turn_id}:${payload.toolCallId}` : `unattributed:${r.created_at}:${r.kind}:${payload.eventKey ?? ''}`;
          let entry = byCall.get(key);
          if (entry == null) {
            entry = {
              toolCallId: payload.toolCallId ?? '(未归属)', toolName: null, memberId: null,
              turnId: r.turn_id, startedAt: null, completedAt: null, outcome: null,
              eventKeys: [], unattributed: !hasIdentity,
            };
            byCall.set(key, entry);
          }
          if (r.kind === 'tool.started' && entry.startedAt == null) {
            // started 取首：时间与工具名取自同一条选定事件。
            entry.startedAt = r.created_at;
            entry.toolName = payload.toolName ?? entry.toolName;
          }
          if (r.kind === 'tool.completed' && r.turn_id === entry.turnId) {
            // completed 取末：结果与完成时间取自同一条选定事件（不同 turn 的同名 id 不串）。
            entry.completedAt = r.created_at;
            entry.outcome = payload.outcome ?? null;
          }
          pushEventKey(entry, payload.eventKey);
        }
        // memberId：turn 归属成员（批量查询一次）。
        const items = [...byCall.values()];
        for (const item of items) {
          if (item.turnId != null) {
            const member = deps.db.prepare('SELECT member_id FROM agent_turns WHERE id = ?').get(item.turnId) as { member_id: string } | undefined;
            item.memberId = member?.member_id ?? null;
          }
        }
        return withCommandId({ ok: true, data: { items } });
      }
      case 'events.list': {
        // audience（第三十二轮一修复）：旧实现只按 projectId 查询——非参与者的 DM 事件可被
        // 按 ID 读出（HTTP /cmd 同样可达）。与 activity.list 同口径：DM 事件仅本人参与可见。
        const params = z.strictObject({ projectId: z.string().min(1), afterSeq: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(200).optional() }).parse(env.params);
        const raw = listEvents(deps.db, params.projectId, params.afterSeq ?? 0, Math.max((params.limit ?? 100) * 2, 100)) as unknown as Array<{ seq: number; event_id: string; kind: string; payload_json: string; conversation_id: string | null; thread_id: string | null; task_id: string | null }>;
        const items = raw.filter((e: { conversation_id: string | null }) => {
          if (e.conversation_id == null) return true;
          const ck = deps.db.prepare('SELECT kind FROM conversations WHERE id = ?').get(e.conversation_id) as { kind: string } | undefined;
          if (ck?.kind !== 'dm') return true;
          return deps.db.prepare("SELECT 1 FROM dm_participants dp WHERE dp.conversation_id = ? AND dp.principal_type = 'human' AND dp.principal_id = ?").get(e.conversation_id, deps.localUserId) != null;
        }).slice(0, params.limit ?? 100);
        return withCommandId({ ok: true, data: { items, hasMore: raw.length >= Math.max((params.limit ?? 100) * 2, 100) } });
      }
      case 'recovery.status': {
        // 只读恢复状态查询（修复轮 6）：禁止用「尝试恢复命令」探测门禁。
        // DEV-13 扩展：UNKNOWN turn 明细（对账入口）+ 上次 stop 记录 + 未收口撤销（DEV-12
        // 崩溃窗口续跑指引）+ 租约持有（daemon 死≠子进程死——身份核对如实，不假装可判活）。
        // 第七轮：附每个 UNKNOWN turn 的进程登记与最近退出取证（程序观测事实，供 UI 与人工判断分层展示）。
        const { isDispatchGateHeld } = await import('../persistence/daemonState.ts');
        const held = isDispatchGateHeld(deps.db);
        const pending = deps.db.prepare(`SELECT dispatch_key FROM outbox WHERE status = 'pending'`).all() as Array<{ dispatch_key: string }>;
        const interrupted = deps.db.prepare(`SELECT id, task_id, status FROM workflow_runs WHERE status IN ('INTERRUPTED')`).all() as Array<{ id: string; task_id: string; status: string }>;
        const unknownTurns = deps.db.prepare(
          `SELECT t.id, t.run_id AS runId, t.stage_key AS stageKey, r.task_id AS taskId, t.status FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE t.status = 'UNKNOWN'`,
        ).all();
        const processRegistry = unknownTurns.length > 0
          ? (deps.db.prepare(
            `SELECT r.turn_id AS turnId, r.process_model AS processModel, r.pid, r.started_at_ms AS startedAtMs,
                    r.identity_source AS identitySource, r.closed_at AS closedAt, r.adapter_kind AS adapterKind,
                    (SELECT p.result FROM recovery_exit_probes p WHERE p.turn_id = r.turn_id ORDER BY p.observed_at DESC LIMIT 1) AS lastProbeResult,
                    (SELECT p.detail FROM recovery_exit_probes p WHERE p.turn_id = r.turn_id ORDER BY p.observed_at DESC LIMIT 1) AS lastProbeDetail,
                    (SELECT p.observed_at FROM recovery_exit_probes p WHERE p.turn_id = r.turn_id ORDER BY p.observed_at DESC LIMIT 1) AS lastProbeAt
             FROM runtime_process_registry r`,
          ).all())
          : [];
        const stopRecordRow = deps.db.prepare(`SELECT value FROM daemon_state WHERE key = 'daemon:stop:last'`).get() as { value: string } | undefined;
        let stopRecord: unknown = null;
        if (stopRecordRow != null) { try { stopRecord = JSON.parse(stopRecordRow.value); } catch { stopRecord = null; } }
        const activeUndos = deps.db.prepare(`SELECT id, change_set_id AS changeSetId, status FROM change_set_undos WHERE status IN ('in_progress','failed')`).all();
        const heldLeases = deps.db.prepare(`SELECT lock_domain, owner_turn_id, status, heartbeat_at FROM workspace_leases WHERE status != 'released'`).all();
        // 「预算已处置、保护待解除」遗留保护（第四十一轮 §2：以 protection_state='retained'
        // 为准——无租约的人工退款保留项不再从恢复中心消失；leaseCount 如实分列）。
        const pendingRelease = deps.db.prepare(
          `SELECT t.id AS turnId, t.budget_mark AS budgetMark, t.status AS turnStatus, t.protection_state AS protectionState,
                  (SELECT count(*) FROM workspace_leases l WHERE l.owner_turn_id = t.id AND l.status != 'released') AS leaseCount,
                  (SELECT p.result FROM recovery_exit_probes p WHERE p.turn_id = t.id ORDER BY p.observed_at DESC LIMIT 1) AS lastProbeResult
           FROM agent_turns t
           WHERE t.protection_state = 'retained'`,
        ).all();
        return withCommandId({
          ok: true,
          data: {
            gateHeld: held,
            pendingDispatchCount: pending.length,
            pendingDispatchKeys: pending.map((p) => p.dispatch_key),
            interruptedRuns: interrupted,
            unknownTurns,
            processRegistry,
            pendingRelease,
            stopRecord,
            activeUndos,
            heldLeases,
            leaseNote: 'daemon 退出不证明 runtime 子进程已退出（单实例锁≠进程树）；expired 租约仍阻塞新写者（RT-07）。退出事实以服务端取证（recovery.probeProcess：按已登记进程身份做 OS 核对）为准——不接受调用方自报；人工声明后的遗留保护经 recovery.releaseProtection 按服务端证据收口',
            undoNote: '未收口撤销：续跑走 changeset.undo（三向判定区分未执行/已执行未记账/外部修改），不清空占位后放行',
          },
        });
      }
      case 'recovery.probeProcess': {
        // DEV-13 第七轮：服务端退出取证（只读，不改 turn/租约/预算状态）。
        // 按 turn 的**已登记身份**（runtime_process_registry——worker 启动时写入）做 OS 核对，
        // 生成服务端证据记录（recovery_exit_probes）。错误 PID、其他 turn 证据、PID 复用、
        // 缺失历史身份都不能冒充确认退出——各按结果枚举如实返回。
        const params = z.strictObject({ turnId: z.string().min(1) }).parse(env.params);
        const turn = deps.db.prepare('SELECT id FROM agent_turns WHERE id = ?').get(params.turnId) as { id: string } | undefined;
        if (turn == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `turn 不存在：${params.turnId}`);
        const probe = probeTurnExit(deps.db, params.turnId, deps.processQuery ?? ((pid: number) => checkProcessLiveness(pid)), {
          createdBy: 'probe', treeScan: deps.processTree,
          managedJob: managedJobObservation,
        });
        return withCommandId({ ok: true, data: probe });
      }
      case 'recovery.reconcile': {
        // DEV-13（第七轮重写）：执行事实/退出事实/成果事实分离——**退出证据由服务端生成与校验**。
        // - 执行事实 verdict（人工判断，需留人工依据 note）：notStarted|executed|keepUnknown。
        //   **仅 UNKNOWN turn 可对账**（含 keepUnknown）。
        // - 退出事实：executed 时由 daemon 按已登记身份做 OS 核对（自动取证，或校验调用方
        //   引用的此前服务端 probeId——校验 turn 归属/登记一致/观测新鲜）。调用方**不再能
        //   自报 alive=false**（旧 exitEvidence 参数已删除）。alive/unknown/复用/身份缺失 →
        //   保留租约与准入占位；exited（per-turn 专属进程退出；shared=共享载体退出，证据按
        //   模型标注）→ 释放；no-os-process（无子进程模型=程序事实无 OS 遗留进程可能）→ 释放。
        // - notStarted 人工分离：启动窗口崩溃的 UNKNOWN turn 无程序确认来源（确认未启动在
        //   启动窗口内当场收口，不遗留 UNKNOWN）。人工声明须 manualRiskAck=true（独立语义）：
        //   预算退款+turn FAILED，但**租约与准入保留**（存在未收口进程可能时不凭人工解除
        //   物理写入保护），事件 recordedAs='manual-claim'——不伪装为程序已确认事实。
        // - 成果事实：确认执行不自动等于业务失败也不伪造成功交付——无已入库产物证据时
        //   turn 记 FAILED（reason=executed-no-recorded-outcome，留证可复核）。
        // - 预算逐 turn 标记（budget_mark）幂等防双算；DELIB 尾部 turn 退款同步恢复尾部预留。
        // - 同 daemon 内存联动：对账事务成功后调用 releaseAdmission 钩子（entry 接线）。
        const params = z.strictObject({
          turnId: z.string().min(1),
          verdict: z.enum(['notStarted', 'executed', 'keepUnknown']),
          /** 人工依据说明（所有 verdict 必填——人工判断留痕，不冒充程序事实）。 */
          note: z.string().min(1).max(500),
          /** notStarted 人工风险确认（UNKNOWN turn 无程序确认来源时必填）。 */
          manualRiskAck: z.boolean().optional(),
          /** 引用此前服务端 probe 证据（executed 可选；缺省自动取证）。 */
          probeId: z.string().min(1).optional(),
        }).parse(env.params);
        if (params.verdict === 'notStarted' && params.manualRiskAck !== true) {
          throw new DaemonCommandError('VALIDATION_INVALID', 'notStarted 对 UNKNOWN turn 无程序确认来源：人工声明须 manualRiskAck=true（独立语义——退款但保留租约保护，不伪装为程序已确认）');
        }
        const result = run(() => {
          const turn = deps.db.prepare('SELECT id, run_id, status, stage_key, budget_mark FROM agent_turns WHERE id = ?').get(params.turnId) as { id: string; run_id: string; status: string; stage_key: string; budget_mark: string | null } | undefined;
          if (turn == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `turn 不存在：${params.turnId}`);
          if (turn.status !== 'UNKNOWN') {
            throw new DaemonCommandError('STALE_REVISION', `仅 UNKNOWN turn 可对账（实际：${turn.status}）——keepUnknown 亦不适用于非 UNKNOWN turn`);
          }
          if (turn.budget_mark === 'refunded' && params.verdict !== 'keepUnknown') {
            throw new DaemonCommandError('IDEMPOTENCY_CONFLICT', '该 turn 已按未启动退款：不得再按执行结算');
          }
          if (turn.budget_mark === 'settled' && params.verdict === 'notStarted') {
            throw new DaemonCommandError('IDEMPOTENCY_CONFLICT', '该 turn 已按执行结算：不得再改为未启动退款（事实矛盾）');
          }
          // budget_mark='settled' 且再次 executed=**补交退出证据**（首次退出未知时预算已结算、
          // 保护保留）——跳过预算重算，仅推进退出事实；不构成双算。
          const run = deps.db.prepare('SELECT id, task_id, budget_json FROM workflow_runs WHERE id = ?').get(turn.run_id) as { id: string; task_id: string; budget_json: string | null } | undefined;
          const projectId = run != null ? (deps.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(run.task_id) as { project_id: string } | undefined)?.project_id : undefined;
          const now = Date.now();
          const emit = (payload: Record<string, unknown>): void => {
            appendDomainEvent(deps.db, {
              schemaVersion: 1, eventId: `evt_${randomUUID()}`,
              projectId: projectId ?? 'unknown', taskId: run?.task_id, runId: turn.run_id, turnId: turn.id,
              kind: 'recovery.reconciled', createdAt: now,
              payload: { ...payload, manualNote: params.note },
            });
          };
          if (params.verdict === 'keepUnknown') {
            emit({ verdict: 'keepUnknown', note: '维持不确定：占位/租约/预算/状态全不动，不因时间流逝清空' });
            return { turnId: turn.id, verdict: 'keepUnknown' as const, stateChanged: false as const };
          }
          // 服务端退出取证（executed；notStarted 不需要——保护保留）：
          // probeId 引用则校验归属/登记一致/新鲜（≤10 分钟）；否则按登记身份自动取证。
          let probe: ProbeOutcome | null = null;
          if (params.verdict === 'executed') {
            probe = resolveServerProbe(deps, turn.id, params.probeId, now);
          }
          const releaseLeases = (): string[] => {
            const leases = deps.db.prepare(`SELECT lock_domain FROM workspace_leases WHERE owner_turn_id = ? AND status != 'released'`).all(turn.id) as Array<{ lock_domain: string }>;
            for (const l of leases) {
              deps.db.prepare(`UPDATE workspace_leases SET status = 'released' WHERE lock_domain = ? AND owner_turn_id = ?`).run(l.lock_domain, turn.id);
            }
            return leases.map((l) => l.lock_domain);
          };
          const tx = deps.db.transaction(() => {
            let releasedLeases: string[] = [];
            let turnFinalStatus: string;
            let reason: string;
            let protectionRetained = false;
            if (params.verdict === 'notStarted') {
              // 人工声明未启动（独立语义）：退款（I-1；DELIB 尾部预留恢复）+ turn FAILED，
              // 但**租约与准入保留**——存在未收口进程可能时不凭人工解除物理写入保护。
              if (run?.budget_json != null) {
                const budget = JSON.parse(run.budget_json) as { usedTurns: number; inFlightReservedTurns: number; runMaxTurns?: number; tailReservationByStage?: Record<string, number> };
                const next = deliberationBudgetFns.refundReservedTurn(budget as never) as typeof budget;
                const tailStage = turn.stage_key?.startsWith('delib.synthesis') ? 'SYNTHESIS' : turn.stage_key?.startsWith('delib.ratify') ? 'RATIFY' : null;
                if (tailStage != null && next.tailReservationByStage != null) {
                  next.tailReservationByStage = { ...next.tailReservationByStage, [tailStage]: (next.tailReservationByStage[tailStage] ?? 0) + 1 };
                }
                deps.db.prepare('UPDATE workflow_runs SET budget_json = ? WHERE id = ?').run(JSON.stringify(next), run.id);
              }
              deps.db.prepare(`UPDATE agent_turns SET status = 'FAILED', budget_mark = 'refunded', protection_state = 'retained' WHERE id = ?`).run(turn.id);
              turnFinalStatus = 'FAILED'; reason = 'manual-not-started-risk-ack'; protectionRetained = true;
              emit({ verdict: 'notStarted', recordedAs: 'manual-claim', protectionRetained, turnFinalStatus, reason, note: '人工声明（风险确认）：预算退款；租约/准入保留——程序未确认无遗留进程' });
            } else {
              // 执行事实=已执行：结算（U+1）——首次结算；补交退出证据的二次调用跳过（幂等）。
              if (run?.budget_json != null && turn.budget_mark == null) {
                const budget = JSON.parse(run.budget_json) as { usedTurns: number; inFlightReservedTurns: number };
                const next = deliberationBudgetFns.settleTurn(budget as never) as typeof budget;
                deps.db.prepare('UPDATE workflow_runs SET budget_json = ? WHERE id = ?').run(JSON.stringify(next), run.id);
              }
              if (turn.budget_mark == null) deps.db.prepare(`UPDATE agent_turns SET budget_mark = 'settled' WHERE id = ?`).run(turn.id);
              const p = probe!;
              if (p.result === 'no-os-process') {
                // 无子进程模型（程序事实）：无 OS 遗留进程可能——释放保护（041 权威状态=released）。
                releasedLeases = releaseLeases();
                deps.db.prepare(`UPDATE agent_turns SET status = 'FAILED', protection_state = 'released' WHERE id = ?`).run(turn.id);
                turnFinalStatus = 'FAILED'; reason = 'executed-no-os-process';
                emit({ verdict: 'executed', exitFact: 'no-os-process', probe: { probeId: p.probeId, result: p.result, detail: p.detail }, releasedLeases, turnFinalStatus, reason });
              } else {
                // alive/未完整确认（第九轮收紧：**周期快照不构成完整退出证明**——per-turn/
                // shared 的 exited 自动释放路径已关闭，probe 不再产生 exited）：结算预算但
                // **保留租约与准入占位**、turn 保持 UNKNOWN——观察事实见 probe.detail；
                // budget_mark 已防重复结算；解除待受管生命周期机制（Job Object/ETW 等另批）。
                // 041：保护保留=独立持久事实（无租约的 turn 同样不得因状态推导消失）。
                deps.db.prepare(`UPDATE agent_turns SET protection_state = 'retained' WHERE id = ?`).run(turn.id);
                turnFinalStatus = 'UNKNOWN'; reason = `executed-exit-${p.result}-protection-retained`; protectionRetained = true;
                emit({ verdict: 'executed', exitFact: p.result, protectionRetained: true, probe: { probeId: p.probeId, result: p.result, processModel: p.processModel, pid: p.pid, observedAt: p.observedAt, detail: p.detail }, reason });
              }
            }
            return {
              turnId: turn.id, verdict: params.verdict, stateChanged: true as const,
              releasedLeases, turnFinalStatus, reason, protectionRetained,
              admissionReleased: releasedLeases.length >= 0 && turnFinalStatus === 'FAILED' && reason !== 'manual-not-started-risk-ack',
            };
          });
          const out = tx();
          // 内存联动（DB 事务成功后）：释放该 turn 在 worker 准入账本的 UNKNOWN 保留占位。
          // 人工 notStarted 不联动（保护保留语义与租约一致）。
          if (out.admissionReleased && deps.releaseAdmission != null) {
            try { deps.releaseAdmission(params.turnId); } catch { /* 进程内钩子失败不回滚持久事实；重启后账本自然为空 */ }
          }
          return out;
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'recovery.releaseProtection': {
        // DEV-13（第七轮·补；第四十一轮 §2 修订）：解除「预算已处置、保护未解除」的遗留保护。
        // - 前置：该 turn 存在未释放租约**或 protection_state='retained'**（041 权威状态——
        //   无租约但保护保留的 turn 不得因「无租约」直接 no-op 当已闭环，须走服务端证据链）；
        //   预算处置必须已完成（budget_mark 非空）或 turn 已终态——顺序错误明确拒绝；
        //   两者皆无=幂等 no-op。
        // - 只按服务端取证解除（受管 Job 证据/no-os-process）：alive/unknown/身份缺失/复用→
        //   拒绝并保留保护；**不再退款、不再结算、不改写原人工声明**（budget_json/budget_mark
        //   全不动）；解除=protection_state='released'+事件（跨重启同判）。
        // - 同 daemon 联动 releaseAdmission；全部依据 DB——重启后可继续收口。
        const params = z.strictObject({
          turnId: z.string().min(1),
          note: z.string().min(1).max(500),
          probeId: z.string().min(1).optional(),
        }).parse(env.params);
        const result = run(() => {
          const turn = deps.db.prepare('SELECT id, run_id, status, budget_mark, protection_state FROM agent_turns WHERE id = ?').get(params.turnId) as { id: string; run_id: string; status: string; budget_mark: string | null; protection_state: string | null } | undefined;
          if (turn == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `turn 不存在：${params.turnId}`);
          const leases = deps.db.prepare(`SELECT lock_domain FROM workspace_leases WHERE owner_turn_id = ? AND status != 'released'`).all(turn.id) as Array<{ lock_domain: string }>;
          if (leases.length === 0 && turn.protection_state !== 'retained') {
            return { turnId: turn.id, stateChanged: false as const, releasedLeases: [] as string[], note: '该 turn 无未释放租约且无保留保护（protection_state 非 retained）——幂等 no-op' };
          }
          if (turn.budget_mark == null && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(turn.status)) {
            throw new DaemonCommandError('STALE_REVISION', `顺序错误：该 turn 仍 ${turn.status} 且预算未处置——先走 recovery.reconcile 对账，再解除保护`);
          }
          const now = Date.now();
          const probe = resolveServerProbe(deps, turn.id, params.probeId, now);
          const run = deps.db.prepare('SELECT id, task_id FROM workflow_runs WHERE id = ?').get(turn.run_id) as { id: string; task_id: string } | undefined;
          const projectId = (deps.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(run?.task_id ?? '') as { project_id: string } | undefined)?.project_id ?? 'unknown';
          const emit = (payload: Record<string, unknown>): void => {
            appendDomainEvent(deps.db, {
              schemaVersion: 1, eventId: `evt_${randomUUID()}`,
              projectId, taskId: run?.task_id, runId: turn.run_id, turnId: turn.id,
              kind: 'recovery.protectionReleased', createdAt: now,
              payload: { ...payload, manualNote: params.note, probe: { probeId: probe.probeId, result: probe.result, processModel: probe.processModel, pid: probe.pid, observedAt: probe.observedAt, detail: probe.detail } },
            });
          };
          // REC-LIFE-1（第十四轮二）：受管执行的解除证据——按登记的 managed_job_id（稳定
          // 身份）查找并核对，PID 仅辅助属性：缺 jobId/无句柄（重启/已收尾）/PID 不一致/
          // 其他 job 的证据一律拒绝自动解除。顺序：证据查询 → DB 事务（租约+事件）→
          // markConsumed → 准入联动 → 收尾闸门（per-turn 且无共享者才 dispose——失败可重试，
          // 证据不提前丢）。
          const reg = getTurnProcessRegistration(deps.db, turn.id);
          if (reg?.identity_source === 'managed-job') {
            if (reg.managed_job_id == null) {
              throw new DaemonCommandError('STALE_REVISION', '该 turn 登记为受管执行但缺受管稳定身份（managed_job_id）——登记不完整，拒绝自动解除，人工核对');
            }
            const mp = managedJobById(reg.managed_job_id);
            if (mp == null) {
              throw new DaemonCommandError('STALE_REVISION', '该 turn 登记为受管执行，但本进程未持有其 job 句柄（daemon 重启或已收尾）——无法核对完整结束，进入人工核对；「曾纳管」不追认为完整退出证据');
            }
            if (reg.pid != null && mp.pid !== reg.pid) {
              throw new DaemonCommandError('STALE_REVISION', `登记 PID(${reg.pid}) 与 job 实际 PID(${mp.pid}) 不一致（PID 复用或登记错位）——该 job 的证据不属本 turn，拒绝解除`);
            }
            const evidence = mp.releaseEvidence();
            if (!evidence.releasable) {
              throw new DaemonCommandError('STALE_REVISION', `受管执行未完整结束（拒绝解除）：${evidence.reason}`);
            }
            const txm = deps.db.transaction(() => {
              for (const l of leases) {
                deps.db.prepare(`UPDATE workspace_leases SET status = 'released' WHERE lock_domain = ? AND owner_turn_id = ?`).run(l.lock_domain, turn.id);
              }
              deps.db.prepare(`UPDATE agent_turns SET protection_state = 'released' WHERE id = ?`).run(turn.id);
              emit({ released: true, releasedLeases: leases.map((l) => l.lock_domain), reason: 'protection-released-managed-job-evidence', managedEvidence: evidence, managedJobId: reg.managed_job_id });
            });
            txm();
            mp.markConsumed(); // DB 事务成功后才消费（失败可重试——证据不提前丢）
            const retire = retireManagedJob(deps.db, turn.id); // 最后收尾：per-turn 且无共享者→dispose；shared/共享者→保留
            return { turnId: turn.id, stateChanged: true as const, releasedLeases: leases.map((l) => l.lock_domain), reason: 'protection-released-managed-job-evidence', managedRetire: retire };
          }
          if (probe.result !== 'no-os-process') {
            // 第九轮收紧：释放只凭**程序事实**（none 模型 no-os-process）。alive/未完整确认
            // 拒绝；**exited 观察同样不释放**（周期快照不构成完整退出证明——含升级前 ≤10min
            // 的历史 exited 取证记录，防御性拒绝并说明原因）。
            const detail = probe.result === 'exited'
              ? '该取证结果（exited）为升级前观察——周期快照机制不能证明全部受管执行已结束，自本轮起不再作为释放依据'
              : `${probe.result}：${probe.detail}`;
            emit({ released: false, reason: `release-denied-${probe.result}`, protectionRetained: true });
            throw new DaemonCommandError('STALE_REVISION', `服务端取证未确认执行已结束（${detail}）——保护保留，不得释放`);
          }
          const tx = deps.db.transaction(() => {
            for (const l of leases) {
              deps.db.prepare(`UPDATE workspace_leases SET status = 'released' WHERE lock_domain = ? AND owner_turn_id = ?`).run(l.lock_domain, turn.id);
            }
            deps.db.prepare(`UPDATE agent_turns SET protection_state = 'released' WHERE id = ?`).run(turn.id);
            // 预算处置与原人工声明不动（budget_json/budget_mark 均不写）。
            emit({ released: true, releasedLeases: leases.map((l) => l.lock_domain), reason: `protection-released-${probe.result}` });
          });
          tx();
          return { turnId: turn.id, stateChanged: true as const, releasedLeases: leases.map((l) => l.lock_domain), probeResult: probe.result };
        });
        const out = result.data as { stateChanged: boolean; releasedLeases: string[] };
        if (out.stateChanged && deps.releaseAdmission != null) {
          try { deps.releaseAdmission(params.turnId); } catch { /* 进程内钩子失败不回滚持久事实；重启后账本自然为空 */ }
        }
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'recovery.correctToExecuted': {
        // DEV-13（第七轮·补）：事实冲突纠正（人工声明未启动退款后，发现该 turn 实际执行过
        // ——渠道账单/迟到产物等人工证据）。账目纠正：budget_mark refunded→settled、
        // usedTurns 重记 U+1（退款已归还预留，不重复占用）；**原人工声明事件保留不改写**，
        // 纠正以 fact-conflict-correction 事件叠加记录。保护处置独立走 releaseProtection。
        const params = z.strictObject({
          turnId: z.string().min(1),
          note: z.string().min(1).max(500),
          evidence: z.strictObject({
            source: z.string().min(1).max(200), // 人工证据来源（渠道账单/迟到产物核对等）
            at: z.number().int().nonnegative(),
            ref: z.string().max(300).optional(),
          }),
        }).parse(env.params);
        const result = run(() => {
          const turn = deps.db.prepare('SELECT id, run_id, status, budget_mark FROM agent_turns WHERE id = ?').get(params.turnId) as { id: string; run_id: string; status: string; budget_mark: string | null } | undefined;
          if (turn == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `turn 不存在：${params.turnId}`);
          if (turn.budget_mark !== 'refunded') {
            throw new DaemonCommandError('STALE_REVISION', `事实纠正仅适用于已按未启动退款的 turn（实际 budget_mark=${turn.budget_mark ?? 'null'}）——无冲突可纠正`);
          }
          const now = Date.now();
          const run = deps.db.prepare('SELECT id, task_id, budget_json FROM workflow_runs WHERE id = ?').get(turn.run_id) as { id: string; task_id: string; budget_json: string | null } | undefined;
          const projectId = (deps.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(run?.task_id ?? '') as { project_id: string } | undefined)?.project_id ?? 'unknown';
          const tx = deps.db.transaction(() => {
            if (run?.budget_json != null) {
              const budget = JSON.parse(run.budget_json) as { usedTurns: number; inFlightReservedTurns: number };
              // 纠正重记：执行实际发生——U+1（预留已退款归还，不再重新占用 I）。
              deps.db.prepare('UPDATE workflow_runs SET budget_json = ? WHERE id = ?')
                .run(JSON.stringify({ ...budget, usedTurns: budget.usedTurns + 1 } as typeof budget), run.id);
            }
            deps.db.prepare(`UPDATE agent_turns SET budget_mark = 'settled' WHERE id = ?`).run(turn.id);
            appendDomainEvent(deps.db, {
              schemaVersion: 1, eventId: `evt_${randomUUID()}`,
              projectId, taskId: run?.task_id, runId: turn.run_id, turnId: turn.id,
              kind: 'recovery.factConflictCorrected', createdAt: now,
              payload: {
                recordedAs: 'fact-conflict-correction', fromBudgetMark: 'refunded', toBudgetMark: 'settled',
                manualNote: params.note, evidence: params.evidence,
                note: '人工声明未启动退款后取得执行证据——账目按实际事实纠正；原 manual-claim 声明事件保留不改写',
              },
            });
          });
          tx();
          return { turnId: turn.id, corrected: true as const, budgetMark: 'settled' as const };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'recovery.pumpLateEvents': {
        // 第八轮：迟到成果正式接收入口——UNKNOWN turn 截止/重启后到达的终态事件，经
        // adapter 正式通道（lateEvents：持久化会话记录/重连存量流）拉取并走 applyEvent
        // 生产路径（身份/停止代次/重复终态/被替代 run/退款冲突守卫在 worker 侧统一承载）。
        // 幂等=late_event_receipts（eventKey 回执）+ turn 终态 CAS；unsupported 各态如实返回。
        const params = z.strictObject({ turnId: z.string().min(1) }).parse(env.params);
        if (deps.pumpLateEvents == null) {
          throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', '该 daemon 未接线迟到事件泵（worker 不可达）——生产入口在 daemon entry');
        }
        const data = await deps.pumpLateEvents(params.turnId);
        return withCommandId({ ok: true, data });
      }
      case 'changeset.captureBaseline': {
        // DEV-12 正式命令：基线捕获（Git HEAD+索引状态+内容前像；变更归属 taskId/runId）。
        const params = z.strictObject({
          projectId: z.string().min(1),
          taskId: z.string().min(1).nullable().optional(),
          runId: z.string().min(1).nullable().optional(),
          paths: z.array(z.string().min(1)).optional(),
          maxBytes: z.number().int().positive().optional(),
        }).parse(env.params);
        if (deps.appDataDir == null) throw new DaemonCommandError('STORAGE_UNAVAILABLE', 'daemon 未配置 appDataDir（内容前像存储不可用）');
        const { captureBaseline } = await import('./changeset.ts');
        const r = captureBaseline(deps.db, {
          projectId: params.projectId, taskId: params.taskId ?? null, runId: params.runId ?? null,
          paths: params.paths, maxBytes: params.maxBytes, appDataDir: deps.appDataDir, now: Date.now(),
        });
        if (!r.ok) throw new DaemonCommandError(r.error.code, r.error.message);
        return withCommandId({ ok: true, data: r.value });
      }
      case 'changeset.finalize': {
        // 差异定型：捕获 after 前像+diff 入库（直接原目录模式 → application_status='applied'）。
        const params = z.strictObject({ changeSetId: z.string().min(1) }).parse(env.params);
        if (deps.appDataDir == null) throw new DaemonCommandError('STORAGE_UNAVAILABLE', 'daemon 未配置 appDataDir（内容前像存储不可用）');
        const { finalizeChangeset } = await import('./changeset.ts');
        const r = finalizeChangeset(deps.db, { changeSetId: params.changeSetId, appDataDir: deps.appDataDir, now: Date.now() });
        if (!r.ok) throw new DaemonCommandError(r.error.code, r.error.message);
        return withCommandId({ ok: true, data: r.value });
      }
      case 'changeset.undo': {
        // 非破坏撤销（§14.5）：执行前逐文件重验当前==after；冲突不覆盖；逐步持久化可恢复续跑。
        // 第十一轮：与产品内 Git 写操作互斥——撤销逐步恢复期间索引/工作区不得被 Git 写改。
        const params = z.strictObject({ changeSetId: z.string().min(1) }).parse(env.params);
        if (deps.appDataDir == null) throw new DaemonCommandError('STORAGE_UNAVAILABLE', 'daemon 未配置 appDataDir（内容前像存储不可用）');
        const csRow = deps.db.prepare('SELECT project_id FROM change_sets WHERE id = ?').get(params.changeSetId) as { project_id: string } | undefined;
        if (csRow == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `改动集不存在：${params.changeSetId}`);
        const csProject = deps.db.prepare('SELECT canonical_path FROM projects WHERE id = ?').get(csRow.project_id) as { canonical_path: string } | undefined;
        if (csProject != null) {
          const { repoWriteBusy } = await import('./gitWrite.ts');
          if (repoWriteBusy(csProject.canonical_path)) {
            throw new DaemonCommandError('WORKSPACE_BUSY', '该项目的 Git 写操作正在进行——请等其完成后再撤销（两侧互斥，防止撤销期间索引被改写）');
          }
        }
        const { undoChangeset } = await import('./changeset.ts');
        const r = undoChangeset(deps.db, { changeSetId: params.changeSetId, appDataDir: deps.appDataDir, now: Date.now() });
        if (!r.ok) throw new DaemonCommandError(r.error.code, r.error.message);
        return withCommandId({ ok: true, data: r.value });
      }
      case 'changeset.get': {
        // 只读查询：before/after 前像、应用状态与撤销进度（恢复/对账依据）。
        const params = z.strictObject({ changeSetId: z.string().min(1) }).parse(env.params);
        const { getChangeSet } = await import('./changeset.ts');
        const r = getChangeSet(deps.db, params.changeSetId);
        if (!r.ok) throw new DaemonCommandError(r.error.code, r.error.message);
        return withCommandId({ ok: true, data: r.value });
      }
      case 'changeset.readSnapshot': {
        const params=z.strictObject({projectId:z.string().min(1),taskId:z.string().min(1),changeSetId:z.string().min(1),path:z.string().min(1).max(4096).optional()}).parse(env.params);
        const target=deps.db.prepare('SELECT t.conversation_id FROM change_sets cs JOIN tasks t ON t.id=cs.task_id WHERE cs.id=? AND cs.project_id=? AND t.project_id=? AND t.id=?').get(params.changeSetId,params.projectId,params.projectId,params.taskId) as {conversation_id:string}|undefined;
        if(!target)throw new DaemonCommandError('RESOURCE_NOT_FOUND','改动集不属于此项目/任务');
        assertConversationAudience(deps.db,deps.localUserId,target.conversation_id);
        if(!deps.appDataDir)throw new DaemonCommandError('STORAGE_UNAVAILABLE','前像存储未提供');
        const {readChangeSnapshot}=await import('./changeSnapshot.ts');
        return withCommandId({ok:true,data:readChangeSnapshot(deps.db,deps.appDataDir,params.projectId,params.taskId,params.changeSetId,params.path)});
      }
      case 'changeset.listByTask': {
        // DEV-14（第八轮增强）：任务串的变更记录清单——application_status+文件级 state
        // +撤销进度/冲突原因（不可撤销与恢复进度的用户可见来源）。只读；撤销走
        // changeset.undo 正式命令。
        const params = z.strictObject({ taskId: z.string().min(1) }).parse(env.params);
        const sets = deps.db.prepare(
          `SELECT cs.id, cs.application_status AS applicationStatus, cs.before_ref, cs.after_ref,
                  (SELECT count(*) FROM change_set_files f WHERE f.change_set_id = cs.id AND f.role = 'after') AS fileCount,
                  (SELECT u.status FROM change_set_undos u WHERE u.change_set_id = cs.id ORDER BY u.id DESC LIMIT 1) AS undoStatus
           FROM change_sets cs WHERE cs.task_id = ? ORDER BY cs.rowid DESC`,
        ).all(params.taskId) as Array<{
          id: string; applicationStatus: string; before_ref: string; after_ref: string;
          fileCount: number; undoStatus: string | null;
        }>;
        const items = sets.map((cs) => {
          const undoRow = deps.db.prepare(
            `SELECT status, steps_json, failure_json, summary_json FROM change_set_undos WHERE change_set_id = ? ORDER BY id DESC LIMIT 1`,
          ).get(cs.id) as { status: string; steps_json: string; failure_json: string | null; summary_json: string | null } | undefined;
          let undoDetail: {
            status: string;
            totalSteps: number;
            doneSteps: number;
            /** 冲突/失败原因（不可继续撤销的具体说明——含冲突文件清单）。 */
            failure: string | null;
            /** 恢复进度说明：中断后可续跑（逐步幂等重验）。 */
            resumable: boolean;
          } | null = null;
          if (undoRow != null) {
            const steps = JSON.parse(undoRow.steps_json) as Array<{ state?: string }>;
            undoDetail = {
              status: undoRow.status,
              totalSteps: steps.length,
              doneSteps: steps.filter((st) => st.state === 'done').length,
              failure: undoRow.failure_json != null ? String(undoRow.failure_json).slice(0, 300) : null,
              resumable: undoRow.status === 'in_progress' || undoRow.status === 'failed',
            };
          }
          return {
            id: cs.id,
            applicationStatus: cs.applicationStatus,
            beforeRef: cs.before_ref,
            afterRef: cs.after_ref,
            fileCount: cs.fileCount,
            undoStatus: cs.undoStatus,
            undo: undoDetail,
            files: deps.db.prepare(
              `SELECT role, path, state FROM change_set_files WHERE change_set_id = ? ORDER BY role, path`,
            ).all(cs.id) as Array<{ role: string; path: string; state: string }>,
          };
        });
        return withCommandId({ ok: true, data: { taskId: params.taskId, items } });
      }
      case 'git.status': {
        // DEV-14/RT-24（第八轮）：仓库状态只读视图——真实 git 数据（暂存/未暂存/未跟踪
        // 严格区分），不改工作区（保留用户已有未提交内容）。Git 提交不等同任务验收
        // （RT-25）；写操作不在本命令。
        const params = z.strictObject({ projectId: z.string().min(1) }).parse(env.params);
        const project = deps.db.prepare('SELECT canonical_path FROM projects WHERE id = ?').get(params.projectId) as { canonical_path: string } | undefined;
        if (project == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目不存在：${params.projectId}`);
        const { gitRepoStatus } = await import('./gitStatus.ts');
        const r = await gitRepoStatus(project.canonical_path);
        // R71：NOT_A_GIT_REPO 保留原码透传（UI 中性态分列——普通目录≠失败；真实 Git 错误仍 STORAGE_UNAVAILABLE）。
        if (!r.ok) throw new DaemonCommandError(r.code === 'NOT_A_GIT_REPO' ? ('NOT_A_GIT_REPO' as never) : 'STORAGE_UNAVAILABLE', `${r.code}: ${r.message}`);
        return withCommandId({ ok: true, data: r });
      }
      case 'git.diff': {
        // DEV-14/RT-24（第九轮）：diff 正文只读视图——暂存/未暂存区分、重命名/删除标注、
        // 二进制与超限截断如实；路径校验（拒绝绝对路径/..越界）；不改索引与用户工作区。
        const params = z.strictObject({
          projectId: z.string().min(1),
          staged: z.boolean().optional(),
          path: z.string().min(1).max(400).optional(),
        }).parse(env.params);
        const project = deps.db.prepare('SELECT canonical_path FROM projects WHERE id = ?').get(params.projectId) as { canonical_path: string } | undefined;
        if (project == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目不存在：${params.projectId}`);
        const { gitDiff } = await import('./gitStatus.ts');
        const r = await gitDiff(project.canonical_path, { staged: params.staged, path: params.path });
        if (!r.ok) {
          const code = r.code === 'NOT_A_GIT_REPO' || r.code === 'PATH_OUT_OF_REPO' || r.code === 'PATH_IS_DIRECTORY' ? 'VALIDATION_INVALID' : 'STORAGE_UNAVAILABLE';
          throw new DaemonCommandError(code, r.message);
        }
        return withCommandId({ ok: true, data: r });
      }
      case 'git.remote.list':
      case 'git.stage':
      case 'git.unstage':
      case 'git.stageTask':
      case 'git.commit':
      case 'git.commitPreview':
      case 'git.history':
      case 'git.remoteHead':
      case 'git.branch.list':
      case 'git.branch.create':
      case 'git.checkout':
      case 'git.commitDiff':
      case 'git.push':
      case 'git.pull':
      case 'git.conflict.content':
      case 'git.conflict.resolve':
      case 'git.commit.undo': {
        // 第十轮·二：Git 写操作闭环（RT-24/§14.6/§15.2）。自包幂等（git_operations 日志+
        // 命令回执同事务；commit 另有尾部标记崩溃恢复），不经 run() 同步包装。
        // 边界：不做 reset --hard/rebase/强推；批量暂存跳过 userPreExisting；提交不改
        // ChangeSet/验收状态；保护租约生效时拒绝写操作；身份缺失如实报错不代改配置。
        const gitProjectId = z.object({ projectId: z.string().min(1) }).parse(env.params).projectId;
        const gitProject = deps.db.prepare('SELECT canonical_path FROM projects WHERE id = ?').get(gitProjectId) as { canonical_path: string } | undefined;
        if (gitProject == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目不存在：${gitProjectId}`);
        // 提交前门禁（第三十四轮四）：git 写走 gitWrite 自包 runCommand——journal 注入
        // commitGate（persistOperation 提交事务前重查设备/代次/会话）。
        const journal = { commandId: env.commandId, scope, payloadHash, now: Date.now(), commitGate: (): void => { if (deps.remoteGate != null) { const g = deps.remoteGate(); if (!g.ok) throw new DaemonCommandError(g.code, g.message); } } };
        const { GitWriteError: GWE } = await import('./gitWrite.ts');
        const mapErr = (error: unknown): DaemonCommandError => {
          if (error instanceof DaemonCommandError) return error;
          if (error instanceof GWE) return new DaemonCommandError(error.code, error.message);
          return new DaemonCommandError('STORAGE_UNAVAILABLE', error instanceof Error ? error.message : String(error));
        };
        try {
          if (env.method === 'git.stage') {
            const params = z.strictObject({ projectId: z.string().min(1), paths: z.array(z.string().min(1).max(400)).min(1).max(100) }).parse(env.params);
            const { gitStage } = await import('./gitWrite.ts');
            const data = await gitStage(deps.db, { ...params, projectRoot: gitProject.canonical_path, journal });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.unstage') {
            const params = z.strictObject({ projectId: z.string().min(1), paths: z.array(z.string().min(1).max(400)).min(1).max(100) }).parse(env.params);
            const { gitUnstage } = await import('./gitWrite.ts');
            const data = await gitUnstage(deps.db, { ...params, projectRoot: gitProject.canonical_path, journal });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.stageTask') {
            const params = z.strictObject({
              projectId: z.string().min(1),
              taskId: z.string().min(1).optional(),
              changeSetId: z.string().min(1).optional(),
            }).refine((p) => (p.taskId != null) !== (p.changeSetId != null), { message: 'taskId 与 changeSetId 二选一' }).parse(env.params);
            const { gitStageTask } = await import('./gitWrite.ts');
            const data = await gitStageTask(deps.db, { projectId: params.projectId, projectRoot: gitProject.canonical_path, taskId: params.taskId, changeSetId: params.changeSetId, journal });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.commitPreview') {
            const { gitCommitPreview } = await import('./gitWrite.ts');
            const data = await gitCommitPreview(deps.db, { projectId: (env.params as { projectId: string }).projectId, projectRoot: gitProject.canonical_path });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.commit') {
            const params = z.strictObject({
              projectId: z.string().min(1),
              message: z.string().min(1).max(2000),
              expectedHead: z.string().min(4).max(64).nullable(),
              expectedIndexTree: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
              expectedBranch: z.string().min(1).max(200).nullable(),
              taskId: z.string().min(1).optional(),
              changeSetIds: z.array(z.string().min(1)).max(50).optional(),
            }).parse(env.params);
            const { gitCommit } = await import('./gitWrite.ts');
            const data = await gitCommit(deps.db, {
              projectId: params.projectId, projectRoot: gitProject.canonical_path, message: params.message,
              expectedHead: params.expectedHead, expectedIndexTree: params.expectedIndexTree, expectedBranch: params.expectedBranch,
              taskId: params.taskId ?? null, changeSetIds: params.changeSetIds,
              journal,
            });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.remoteHead') {
            const params = z.strictObject({ projectId: z.string().min(1), remote: z.string().min(1).max(200), branch: z.string().min(1).max(200) }).parse(env.params);
            const { remoteHead, pushUrl, redactRemoteText } = await import('./gitWrite.ts');
            const { locateRepo } = await import('./gitStatus.ts');
            const loc = await locateRepo(gitProject.canonical_path);
            const [head, url] = await Promise.all([remoteHead(loc, params.remote, params.branch), pushUrl(loc, params.remote)]);
            return withCommandId({ ok: true, data: { remote: params.remote, branch: params.branch, head, url: redactRemoteText(url) } });
          }
          if (env.method === 'git.branch.list') {
            const { gitBranchList } = await import('./gitWrite.ts');
            const data = await gitBranchList({ projectId: gitProjectId, projectRoot: gitProject.canonical_path });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.remote.list') {
            // R65：远端真实清单（只读——repoGuard 同写路径；URL 原样，不做凭据推断）。
            const { gitRemoteList } = await import('./gitWrite.ts');
            const data = await gitRemoteList({ projectRoot: gitProject.canonical_path });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.branch.create') {
            const params = z.strictObject({ projectId: z.string().min(1), name: z.string().min(1).max(200), expectedHead: z.string().min(4).max(64).nullable() }).parse(env.params);
            const { gitBranchCreate } = await import('./gitWrite.ts');
            const data = await gitBranchCreate(deps.db, { ...params, projectRoot: gitProject.canonical_path, journal });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.checkout') {
            const params = z.strictObject({ projectId: z.string().min(1), branch: z.string().min(1).max(200), expectedHead: z.string().min(4).max(64).nullable(), expectedBranch: z.string().min(1).max(200) }).parse(env.params);
            const { gitCheckout } = await import('./gitWrite.ts');
            const data = await gitCheckout(deps.db, { ...params, projectRoot: gitProject.canonical_path, journal });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.commitDiff') {
            // parentOid（第十四轮五）：merge 提交选择比较父——数据与展示绑定该父 OID；
            // 非 merge 提交传非其父的值由 daemon 校验拒绝。
            const params = z.strictObject({ projectId: z.string().min(1), oid: z.string().regex(/^[0-9a-f]{40}$/), parentOid: z.string().regex(/^[0-9a-f]{40}$/).optional() }).parse(env.params);
            const { gitCommitDiff } = await import('./gitWrite.ts');
            const data = await gitCommitDiff(deps.db, { ...params, projectRoot: gitProject.canonical_path });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.push') {
            // 推送绑定用户确认的远端/分支/两端头（§14.6 风险告知；仅快进，不强推）。
            const params = z.strictObject({ projectId: z.string().min(1), remote: z.string().min(1).max(200), branch: z.string().min(1).max(200), expectedHead: z.string().regex(/^[0-9a-f]{40}$/), expectedRemoteHead: z.string().regex(/^[0-9a-f]{40}$/).nullable(), expectedRemoteUrl: z.string().min(1).max(2000) }).parse(env.params);
            const { gitPush } = await import('./gitWrite.ts');
            const data = await gitPush(deps.db, { ...params, projectRoot: gitProject.canonical_path, journal });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.pull') {
            const params = z.strictObject({ projectId: z.string().min(1), remote: z.string().min(1).max(200), branch: z.string().min(1).max(200), expectedHead: z.string().regex(/^[0-9a-f]{40}$/) }).parse(env.params);
            const { gitPull } = await import('./gitWrite.ts');
            const data = await gitPull(deps.db, { ...params, projectRoot: gitProject.canonical_path, journal });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.conflict.content') {
            const params = z.strictObject({ projectId: z.string().min(1), path: z.string().min(1).max(400) }).parse(env.params);
            const { gitConflictContent } = await import('./gitWrite.ts');
            const data = await gitConflictContent({ ...params, projectRoot: gitProject.canonical_path });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.conflict.resolve') {
            // 三方内容+手动解决（§14.6：不提供整文件一键用某边覆盖——只接受用户提交的内容）。
            const params = z.strictObject({ projectId: z.string().min(1), path: z.string().min(1).max(400), content: z.string().max(4 * 1024 * 1024) }).parse(env.params);
            const { gitConflictResolve } = await import('./gitWrite.ts');
            const data = await gitConflictResolve(deps.db, { ...params, projectRoot: gitProject.canonical_path, journal });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.commit.undo') {
            // reflog 软回退（§14.6）：内容回工作区、文件不删；只允许撤销当前 HEAD 提交。
            const params = z.strictObject({ projectId: z.string().min(1), commitOid: z.string().regex(/^[0-9a-f]{40}$/), expectedHead: z.string().regex(/^[0-9a-f]{40}$/), expectedBranch: z.string().min(1).max(200) }).parse(env.params);
            const { gitCommitUndo } = await import('./gitWrite.ts');
            const data = await gitCommitUndo(deps.db, { ...params, projectRoot: gitProject.canonical_path, journal });
            return withCommandId({ ok: true, data });
          }
          const historyParams = z.strictObject({ projectId: z.string().min(1), limit: z.number().int().min(1).max(200).optional(), cursor: z.number().int().min(0).optional() }).parse(env.params);
          const { gitHistory } = await import('./gitWrite.ts');
          const data = await gitHistory(deps.db, { ...historyParams, projectRoot: gitProject.canonical_path });
          return withCommandId({ ok: true, data });
        } catch (error) {
          throw mapErr(error);
        }
      }
      case 'project.reviewPolicy.set': {
        // RT-25/§10.5/§15.2：项目级「任务验收」开关。CAS（expectedRevision）；只影响之后
        // 创建的用户任务（创建时快照 Task.reviewPolicy）——已有任务策略不批量改写；
        // 关闭不授权自动提交/推送，也不放宽 runtime 权限（RT-25①）。
        const params = z.strictObject({
          projectId: z.string().min(1),
          taskReviewEnabled: z.boolean(),
          expectedRevision: z.number().int().nonnegative(),
        }).parse(env.params);
        const result = run(() => {
          const row = deps.db.prepare('SELECT id, revision, task_review_enabled FROM projects WHERE id = ?').get(params.projectId) as { id: string; revision: number; task_review_enabled: number } | undefined;
          if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目不存在：${params.projectId}`);
          if (row.revision !== params.expectedRevision) {
            throw new DaemonCommandError('STALE_REVISION', `项目 revision 已变化（期望 ${params.expectedRevision}，当前 ${row.revision}）——请刷新后重试`);
          }
          if ((row.task_review_enabled === 1) === params.taskReviewEnabled) {
            return { projectId: params.projectId, taskReviewEnabled: params.taskReviewEnabled, revision: row.revision, unchanged: true };
          }
          const updated = deps.db
            .prepare('UPDATE projects SET task_review_enabled = ?, revision = revision + 1 WHERE id = ? AND revision = ?')
            .run(params.taskReviewEnabled ? 1 : 0, params.projectId, params.expectedRevision);
          if (updated.changes !== 1) throw new DaemonCommandError('STALE_REVISION', '并发更新冲突（revision 条件更新未命中）——请刷新后重试');
          appendDomainEvent(deps.db, {
            schemaVersion: 1,
            eventId: `evt_${randomUUID()}`,
            projectId: params.projectId,
            kind: 'project.reviewPolicyUpdated',
            createdAt: Date.now(),
            payload: { taskReviewEnabled: params.taskReviewEnabled, effect: '仅影响之后创建的用户任务；已有任务保持创建时策略快照' },
          });
          return { projectId: params.projectId, taskReviewEnabled: params.taskReviewEnabled, revision: params.expectedRevision + 1, unchanged: false };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'project.collab.get':
      case 'project.collab.set': {
        // §17.8 协作限制（第十七轮三）：缺席等待（absenceTolerance）与单轮运行时限
        //（turnDeadline）项目级配置。NULL=回落 daemon 全局默认；生效边界=新派发 turn 起
        // 读取（在途不变）；CAS 沿用 projects.revision。并行写入策略（§14.7）延期——不在
        // 本命令面（文件修改节=只读呈现，不伪造可配置）。
        if (env.method === 'project.collab.get') {
          const params = z.strictObject({ projectId: z.string().min(1) }).parse(env.params);
          const row = deps.db.prepare('SELECT revision, collab_absence_tolerance_ms, collab_turn_deadline_ms FROM projects WHERE id = ?').get(params.projectId) as { revision: number; collab_absence_tolerance_ms: number | null; collab_turn_deadline_ms: number | null } | undefined;
          if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目不存在：${params.projectId}`);
          return withCommandId({ ok: true, data: { projectId: params.projectId, revision: row.revision, absenceToleranceMs: row.collab_absence_tolerance_ms, turnDeadlineMs: row.collab_turn_deadline_ms, scope: '新派发 turn 起生效（在途 turn 保持派发时的时限）；NULL=回落 daemon 全局默认' } });
        }
        const params = z.strictObject({
          projectId: z.string().min(1),
          absenceToleranceMs: z.number().int().min(10_000).max(86_400_000).nullable().optional(),
          turnDeadlineMs: z.number().int().min(10_000).max(86_400_000).nullable().optional(),
          expectedRevision: z.number().int().nonnegative(),
        }).parse(env.params);
        const result = run(() => {
          const row = deps.db.prepare('SELECT id, revision FROM projects WHERE id = ?').get(params.projectId) as { id: string; revision: number } | undefined;
          if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目不存在：${params.projectId}`);
          if (row.revision !== params.expectedRevision) {
            throw new DaemonCommandError('STALE_REVISION', `配置版本冲突（期望 revision=${params.expectedRevision}，当前=${row.revision}）——请刷新后重试`);
          }
          const sets: string[] = [];
          const vals: unknown[] = [];
          if (params.absenceToleranceMs !== undefined) { sets.push('collab_absence_tolerance_ms = ?'); vals.push(params.absenceToleranceMs); }
          if (params.turnDeadlineMs !== undefined) { sets.push('collab_turn_deadline_ms = ?'); vals.push(params.turnDeadlineMs); }
          if (sets.length === 0) return { projectId: row.id, revision: row.revision, changed: false as const };
          deps.db.prepare(`UPDATE projects SET ${sets.join(', ')}, revision = revision + 1 WHERE id = ? AND revision = ?`).run(...vals, row.id, params.expectedRevision);
          const after = deps.db.prepare('SELECT revision, collab_absence_tolerance_ms, collab_turn_deadline_ms FROM projects WHERE id = ?').get(row.id) as { revision: number; collab_absence_tolerance_ms: number | null; collab_turn_deadline_ms: number | null };
          appendDomainEvent(deps.db, {
            schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: row.id, conversationId: null, threadId: null, taskId: null, runId: null, turnId: null,
            kind: 'project.collabUpdated', createdAt: Date.now(),
            payload: { fromRevision: params.expectedRevision, toRevision: after.revision, absenceToleranceMs: after.collab_absence_tolerance_ms, turnDeadlineMs: after.collab_turn_deadline_ms, note: '协作限制更新：新派发 turn 起生效（在途不变）' },
          });
          return { projectId: row.id, revision: after.revision, changed: true as const, absenceToleranceMs: after.collab_absence_tolerance_ms, turnDeadlineMs: after.collab_turn_deadline_ms };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'conversation.create': {
        // 私信会话创建（DEV-22；R4 §2.3；第十九轮三：新建/打开分离）——每个新的业务请求
        // 创建独立 conversationId（同成员可多条独立私信）；同 commandId 重试经幂等网关返回
        // 原创建结果；打开已有会话用 conversation.list/history + 明确 conversationId。
        const params = z.strictObject({
          projectId: z.string().min(1),
          peerMemberId: z.string().min(1),
          title: z.string().min(1).max(120).optional(),
        }).parse(env.params);
        const project = deps.db.prepare('SELECT id FROM projects WHERE id = ?').get(params.projectId) as { id: string } | undefined;
        if (project == null) throw new DaemonCommandError('PROJECT_MISSING', '项目不存在');
        const result = run(() => {
          const created = createDmConversation(deps.db, { projectId: params.projectId, peerMemberId: params.peerMemberId, title: params.title, localUserId: deps.localUserId });
          if (!created.ok) throw new DaemonCommandError(created.code, created.message);
          return { conversationId: created.conversationId };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'conversation.list': {
        const params = z.strictObject({ projectId: z.string().min(1).optional(), archived: z.boolean().optional() }).parse(env.params);
        const all = listDmConversations(deps.db, deps.localUserId, params.projectId);
        const rows = params.archived == null ? all : all.filter((c) => params.archived === (c.archivedAt != null));
        return withCommandId({ ok: true, data: { conversations: rows } });
      }
      case 'conversation.failedTasks': {
        // R78: failed DM attempts stay task ACTIVE. Surface only a viewer's own DM tasks,
        // with the exact retry snapshot and shared recovery guard; no automatic dispatch.
        const params = conversationFailedTasksParamsSchema.parse(env.params);
        const conv = assertConversationAudience(deps.db, deps.localUserId, params.conversationId);
        if (conv.projectId !== params.projectId || conv.kind !== 'dm') throw new DaemonCommandError('RESOURCE_NOT_FOUND', '目标不是该项目的私信会话');
        const archived = (deps.db.prepare('SELECT archived_at FROM conversations WHERE id = ?').get(params.conversationId) as { archived_at: number | null }).archived_at != null;
        const projectActive = (deps.db.prepare('SELECT status FROM projects WHERE id = ?').get(params.projectId) as { status: string }).status === 'active';
        const rows = deps.db.prepare(`SELECT t.id, t.title, t.revision, t.stop_generation, r.id AS run_id
          FROM tasks t JOIN workflow_runs r ON r.id = (
            SELECT rr.id FROM workflow_runs rr WHERE rr.task_id = t.id AND rr.conversation_id = t.conversation_id ORDER BY rr.rowid DESC LIMIT 1)
          WHERE t.project_id = ? AND t.conversation_id = ? AND t.kind = 'dm_turn' AND t.status = 'ACTIVE'
            AND t.stop_generation = 0 AND r.status = 'FAILED'
          ORDER BY t.rowid DESC LIMIT 21`).all(params.projectId, params.conversationId) as Array<{
            id: string; title: string; revision: number; stop_generation: number; run_id: string;
          }>;
        const items = rows.slice(0, 20).map((t) => {
          const pending = deps.db.prepare("SELECT 1 FROM outbox WHERE dispatch_key = ? AND status != 'done'")
            .get(`task:${t.id}:redispatch:${t.run_id}`) != null;
          const blocked = pending ? null : assessTaskRedispatchReadiness(deps.db, t.id);
          return { taskId: t.id, title: t.title, taskRevision: t.revision, stopGeneration: t.stop_generation,
            latestRunId: t.run_id, available: projectActive && !archived && !pending && blocked == null, pending,
            blockReason: !projectActive ? '项目已归档或不可用；先恢复项目。'
              : archived ? '私信已归档；先恢复会话，再重新核对任务状态。' : blocked?.message ?? null };
        });
        return withCommandId({ ok: true, data: { conversationId: params.conversationId, items, truncated: rows.length > 20 } });
      }
      case 'conversation.tasks': {
        const params=conversationTasksParamsSchema.parse(env.params);
        const conv=dmConversationOf(deps.db,params.conversationId);
        if(conv==null||conv.kind!=='dm'||conv.project_id!==params.projectId)throw new DaemonCommandError('RESOURCE_NOT_FOUND','私信不属于目标项目或不存在');
        assertConversationAudience(deps.db,deps.localUserId,params.conversationId);
        let before=Number.MAX_SAFE_INTEGER;
        if(params.beforeTaskId){const row=deps.db.prepare('SELECT rowid AS seq FROM tasks WHERE id=? AND project_id=? AND conversation_id=?').get(params.beforeTaskId,params.projectId,params.conversationId) as {seq:number}|undefined;if(!row)throw new DaemonCommandError('RESOURCE_NOT_FOUND','历史任务游标不属于当前私信');before=row.seq;}
        const rows=deps.db.prepare(`SELECT t.id,t.title,t.status,t.revision,r.id AS run_id,r.status AS run_status FROM tasks t
          LEFT JOIN workflow_runs r ON r.id=(SELECT w.id FROM workflow_runs w WHERE w.task_id=t.id AND w.conversation_id=t.conversation_id ORDER BY w.rowid DESC LIMIT 1)
          WHERE t.project_id=? AND t.conversation_id=? AND t.rowid<? ORDER BY t.rowid DESC LIMIT 21`).all(params.projectId,params.conversationId,before) as Array<{id:string;title:string;status:string;revision:number;run_id:string|null;run_status:string|null}>;
        return withCommandId({ok:true,data:{conversationId:params.conversationId,items:rows.slice(0,20).map(r=>({id:r.id,title:r.title,status:r.status,revision:r.revision,latestRun:r.run_id?{id:r.run_id,status:r.run_status}:null})),nextCursor:rows.length>20?rows[19]!.id:null}});
      }
      case 'conversation.history': {
        const params = z.strictObject({ conversationId: z.string().min(1), beforeSeq: z.number().int().positive().optional(), limit: z.number().int().min(1).max(200).optional() }).parse(env.params);
        const conv = dmConversationOf(deps.db, params.conversationId);
        if (conv == null || conv.kind !== 'dm') throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '会话不存在或非私信');
        if (dmLocalUserOf(deps.db, params.conversationId) !== deps.localUserId) {
          throw new DaemonCommandError('FORBIDDEN', '仅该私信 audience 可读取（R4 §2.3）');
        }
        const limit = params.limit ?? 50;
        const rows = (params.beforeSeq != null
          ? deps.db.prepare('SELECT id, conversation_seq, author_type, author_id, body_json, status, created_at FROM messages WHERE conversation_id = ? AND conversation_seq < ? ORDER BY conversation_seq DESC LIMIT ?').all(params.conversationId, params.beforeSeq, limit)
          : deps.db.prepare('SELECT id, conversation_seq, author_type, author_id, body_json, status, created_at FROM messages WHERE conversation_id = ? ORDER BY conversation_seq DESC LIMIT ?').all(params.conversationId, limit)) as Array<Record<string, unknown>>;
        const messages = rows.reverse();
        // 消息附件（第二十七轮三：已发消息附件可点击预览；raw 行补 attachments 键）。
        const attByMsg = messageAttachmentSummaries(deps.db, messages.map((m) => String(m.id)));
        for (const m of messages) {
          (m as { attachments?: unknown }).attachments = attByMsg.get(String(m.id)) ?? [];
        }
        return withCommandId({ ok: true, data: { messages, nextCursor: rows.length === limit ? rows[0]!.conversation_seq : null } });
      }
      case 'conversation.markRead': {
        // DEV-18 首包：通用阅读水位（房间/线程/DM）——幂等（同水位重复=advanced:false；
        // commandGateway 另有 commandId 级回执幂等）；**未来水位拒绝**（throughMessageSeq >
        // conversations.last_message_seq = 不吞未来消息——读到的才是已读）；DM=双成员校验
        // （不得替另一参与者标读），房间/线程=本地用户（projects 行存在即可达）。
        const params = z.strictObject({ conversationId: z.string().min(1), throughMessageSeq: z.number().int().min(0) }).parse(env.params);
        const conv = deps.db.prepare('SELECT id, project_id, kind, last_message_seq FROM conversations WHERE id = ?').get(params.conversationId) as { id: string; project_id: string; kind: string; last_message_seq: number } | undefined;
        if (conv == null) throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '会话不存在');
        if (params.throughMessageSeq > conv.last_message_seq) {
          throw new DaemonCommandError('VALIDATION_INVALID', `未来水位拒绝：throughMessageSeq=${params.throughMessageSeq} 超过会话最新消息序 ${conv.last_message_seq}（未读到的不算已读）`);
        }
        if (conv.kind === 'dm') {
          if (dmLocalUserOf(deps.db, params.conversationId) !== deps.localUserId) throw new DaemonCommandError('FORBIDDEN', '不得替另一参与者标记已读');
        } else if (deps.db.prepare('SELECT id FROM projects WHERE id = ?').get(conv.project_id) == null) {
          throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '会话所属项目不可达');
        }
        const result = deps.db.transaction((): { advanced: boolean } => {
          // UPSERT（DEV-18：房间/线程会话无预插 read_state 行——首标即插入；幂等=同水位不前进）。
          deps.db.prepare('INSERT OR IGNORE INTO conversation_read_states (project_id, conversation_id, viewer_id, last_read_seq) VALUES (?, ?, ?, 0)').run(conv.project_id, params.conversationId, deps.localUserId);
          const changes = deps.db.prepare(
            'UPDATE conversation_read_states SET last_read_seq = MAX(last_read_seq, ?), revision = revision + 1 WHERE conversation_id = ? AND viewer_id = ? AND last_read_seq < ?',
          ).run(params.throughMessageSeq, params.conversationId, deps.localUserId, params.throughMessageSeq).changes;
          return { advanced: changes > 0 };
        });
        // 经 commandGateway（DEV-18：commandId 级回执幂等——重试/重放同结果，与语义幂等双层）。
        const r = run(result);
        return withCommandId({ ok: true, data: r.data });
      }
      case 'thread.markRead': {
        // DEV-18（第二十三轮一）：线程独立阅读水位——thread_message_seq 域（会话序与线程序
        // 分开：打开房间≠读完所有线程、读线程 A 不影响 B）。幂等（同序 advanced:false+
        // commandGateway commandId 回执）；未来序号拒绝（>last_message_seq 不吞未来）；
        // 归属：线程→会话→项目（DM 线程=双成员校验；房间线程=项目可达）。
        const params = z.strictObject({ threadId: z.string().min(1), throughMessageSeq: z.number().int().min(0) }).parse(env.params);
        const thread = deps.db.prepare(
          'SELECT t.id AS thread_id, t.conversation_id, c.kind, c.project_id, t.last_message_seq FROM conversation_threads t JOIN conversations c ON c.id = t.conversation_id WHERE t.id = ?',
        ).get(params.threadId) as { thread_id: string; conversation_id: string; kind: string; project_id: string; last_message_seq: number } | undefined;
        if (thread == null) throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', `线程不存在：${params.threadId}`);
        if (params.throughMessageSeq > thread.last_message_seq) {
          throw new DaemonCommandError('VALIDATION_INVALID', `未来水位拒绝：throughMessageSeq=${params.throughMessageSeq} 超过线程最新消息序 ${thread.last_message_seq}`);
        }
        if (thread.kind === 'dm') {
          if (dmLocalUserOf(deps.db, thread.conversation_id) !== deps.localUserId) throw new DaemonCommandError('FORBIDDEN', '不得替另一参与者标记已读');
        } else if (deps.db.prepare('SELECT id FROM projects WHERE id = ?').get(thread.project_id) == null) {
          throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '线程所属项目不可达');
        }
        const tx = deps.db.transaction((): { advanced: boolean } => {
          // 表=001 预埋（列 last_read_message_seq/updated_at，无 project_id）——UPSERT 首标+单调。
          deps.db.prepare('INSERT OR IGNORE INTO thread_read_states (thread_id, viewer_id, last_read_message_seq, updated_at) VALUES (?, ?, 0, ?)').run(params.threadId, deps.localUserId, Date.now());
          const changes = deps.db.prepare(
            'UPDATE thread_read_states SET last_read_message_seq = MAX(last_read_message_seq, ?), updated_at = ? WHERE thread_id = ? AND viewer_id = ? AND last_read_message_seq < ?',
          ).run(params.throughMessageSeq, Date.now(), params.threadId, deps.localUserId, params.throughMessageSeq).changes;
          return { advanced: changes > 0 };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data });
      }
      case 'reminder.schedule': {
        // DEV-23（第二十四轮三——REM-5/6）：一次/循环计划。audience/owner 范围/DM 对端统一
        // 校验；reminderId **事务内**生成、返回 r.data——同 commandId 重放返回原 ID 与计划
        // （网关 run() 同事务存回执；同号异参被 payloadHash 拒绝）。autoDispatch=显式授权位
        // （sourceRef 字符串不构成授权事实——授权只能来自本地入口的显式选择并落库冻结）。
        const params = z.strictObject({
          projectId: z.string().min(1),
          conversationId: z.string().min(1),
          threadId: z.string().min(1).optional(),
          taskId: z.string().min(1).optional(),
          ownerMemberId: z.string().min(1),
          title: z.string().min(1).max(200),
          sourceRef: z.string().max(200).optional(),
          schedule: z.union([
            z.strictObject({ kind: z.literal('once'), at: z.number().int().positive() }),
            z.strictObject({ kind: z.literal('daily'), time: z.string().regex(/^\d{2}:\d{2}$/), tz: z.string().min(1).optional() }),
            z.strictObject({ kind: z.literal('weekly'), weekday: z.number().int().min(0).max(6), time: z.string().regex(/^\d{2}:\d{2}$/), tz: z.string().min(1).optional() }),
          ]),
          budgetLimit: z.strictObject({ sum: z.number().int().min(0) }).optional(),
          autoDispatch: z.boolean().optional(),
          maxTriggers: z.number().int().min(1).optional(),
        }).parse(env.params);
        const schedule = params.schedule as ReminderSchedule;
        const scheduleCheck = validateSchedule(schedule);
        if (!scheduleCheck.ok) throw new DaemonCommandError('VALIDATION_INVALID', `提醒计划无效：${scheduleCheck.error}`);
        const convInfo = assertConversationAudience(deps.db, deps.localUserId, params.conversationId);
        if (convInfo.projectId !== params.projectId) throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '会话不属于该项目');
        const nextAt = computeNextAt(schedule, Date.now());
        if (nextAt == null) throw new DaemonCommandError('VALIDATION_INVALID', '计划无法产生未来触发时刻（once.at 已过或循环无解）——请提供未来时刻');
        // owner 范围（REM-5，网关外只读校验——保住正式错误码，run() 内领域错会被包装
        // STORAGE_UNAVAILABLE）：项目成员+启用；DM 会话只能唤醒该对话的 agent 对端。
        const member = deps.db.prepare('SELECT id, enabled, project_id FROM project_members WHERE id = ?').get(params.ownerMemberId) as
          | { id: string; enabled: number; project_id: string } | undefined;
        if (member == null || member.project_id !== params.projectId) throw new DaemonCommandError('SCOPE_MISMATCH', 'owner 必须是该项目的成员');
        if (member.enabled !== 1) throw new DaemonCommandError('VALIDATION_INVALID', 'owner 成员已停用——不能作为唤醒对象');
        if (convInfo.kind === 'dm') {
          const peer = deps.db.prepare("SELECT 1 AS ok FROM dm_participants WHERE conversation_id = ? AND principal_type = 'agent' AND principal_id = ?").get(params.conversationId, params.ownerMemberId);
          if (peer == null) throw new DaemonCommandError('SCOPE_MISMATCH', '私信提醒只能唤醒该对话的 agent 对端');
        }
        if (params.taskId != null) {
          const task = deps.db.prepare('SELECT conversation_id FROM tasks WHERE id = ?').get(params.taskId) as { conversation_id: string } | undefined;
          if (task?.conversation_id !== params.conversationId) throw new DaemonCommandError('SCOPE_MISMATCH', '任务不属于目标会话');
        }
        if (params.threadId != null) {
          const thread = deps.db.prepare('SELECT conversation_id, root_task_id FROM conversation_threads WHERE id = ?').get(params.threadId) as { conversation_id: string; root_task_id: string | null } | undefined;
          if (thread?.conversation_id !== params.conversationId) throw new DaemonCommandError('SCOPE_MISMATCH', '线程不属于目标会话');
          if (thread.root_task_id == null) throw new DaemonCommandError('SCOPE_MISMATCH', '讨论串（无任务）不能作为提醒执行目标——请挂任务串或房间/私信会话');
        }
        const tx = deps.db.transaction((): { reminderId: string; nextAt: number } => {
          const reminderId = `rem_${randomUUID()}`;
          const now = Date.now();
          // 任务停止代次绑定快照（第二十五轮三）：绑定后发生**新**停止才判停——历史停止不永久禁止。
          const boundStopGeneration = params.taskId != null
            ? (deps.db.prepare('SELECT stop_generation FROM tasks WHERE id = ?').get(params.taskId) as { stop_generation: number } | undefined)?.stop_generation ?? 0
            : 0;
          deps.db.prepare(`INSERT INTO reminders (id, conversation_id, thread_id, task_id, owner_member_id, owner_user, title, source_ref, timezone, schedule_json, next_at, status, budget_json, auto_dispatch, max_triggers, bound_stop_generation, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`)
            .run(reminderId, params.conversationId, params.threadId ?? null, params.taskId ?? null, params.ownerMemberId, deps.localUserId, params.title, params.sourceRef ?? null,
              schedule.tz ?? 'UTC', JSON.stringify(schedule), nextAt,
              params.budgetLimit != null ? JSON.stringify(params.budgetLimit) : null, params.autoDispatch === true ? 1 : 0, params.maxTriggers ?? null, boundStopGeneration, now, now);
          return { reminderId, nextAt };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'reminder.snooze': {
        const params = z.strictObject({ reminderId: z.string().min(1), until: z.number().int().positive() }).parse(env.params);
        // 授权校验（每次——含重放）在网关外；状态类前置在事务内重读核对（第二十五轮二：
        // 并发取消/触发不被旧快照放行；重放先命中回执——状态校验不阻塞同号重试）。
        const rowPre = deps.db.prepare('SELECT id, conversation_id FROM reminders WHERE id = ?').get(params.reminderId) as { id: string; conversation_id: string } | undefined;
        if (rowPre == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `提醒不存在：${params.reminderId}`);
        assertConversationAudience(deps.db, deps.localUserId, rowPre.conversation_id);
        const tx = deps.db.transaction((): { snoozed: boolean } => {
          const row = deps.db.prepare('SELECT id, status, next_at FROM reminders WHERE id = ?').get(params.reminderId) as { id: string; status: string; next_at: number } | undefined;
          if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `提醒不存在：${params.reminderId}`);
          if (row.status !== 'active') throw new DaemonCommandError('VALIDATION_INVALID', `仅 active 提醒可贪睡（当前 ${row.status}）`);
          if (params.until <= row.next_at) throw new DaemonCommandError('VALIDATION_INVALID', '贪睡时刻必须晚于当前下次触发时刻');
          const changed = deps.db.prepare(`UPDATE reminders SET next_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND next_at = ? AND status = 'active'`).run(params.until, Date.now(), row.id, row.next_at).changes;
          return { snoozed: changed === 1 };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'reminder.update': {
        const params = z.strictObject({
          reminderId: z.string().min(1), expectedRevision: z.number().int().min(0),
          title: z.string().min(1).max(200).optional(),
          schedule: z.union([
            z.strictObject({ kind: z.literal('once'), at: z.number().int().positive() }),
            z.strictObject({ kind: z.literal('daily'), time: z.string().regex(/^\d{2}:\d{2}$/), tz: z.string().min(1).optional() }),
            z.strictObject({ kind: z.literal('weekly'), weekday: z.number().int().min(0).max(6), time: z.string().regex(/^\d{2}:\d{2}$/), tz: z.string().min(1).optional() }),
          ]).optional(),
          autoDispatch: z.boolean().optional(),
        }).parse(env.params);
        // 授权校验（网关外，每次）；revision/状态在事务内重读核对（并发安全+重放不阻塞）。
        const rowPre = deps.db.prepare('SELECT id, conversation_id FROM reminders WHERE id = ?').get(params.reminderId) as { id: string; conversation_id: string } | undefined;
        if (rowPre == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `提醒不存在：${params.reminderId}`);
        assertConversationAudience(deps.db, deps.localUserId, rowPre.conversation_id);
        const tx = deps.db.transaction((): { revision: number } => {
          const row = deps.db.prepare('SELECT id, revision, schedule_json, status FROM reminders WHERE id = ?').get(params.reminderId) as { id: string; revision: number; schedule_json: string; status: string } | undefined;
          if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `提醒不存在：${params.reminderId}`);
          if (row.revision !== params.expectedRevision) throw new DaemonCommandError('REVISION_CONFLICT', `期望 revision=${params.expectedRevision}，当前=${row.revision}`);
          if (row.status === 'cancelled') throw new DaemonCommandError('VALIDATION_INVALID', '已取消的提醒不能更新复活——请重新创建（取消后不复活）');
          const schedule = params.schedule != null ? (params.schedule as ReminderSchedule) : JSON.parse(row.schedule_json) as ReminderSchedule;
          const scheduleCheck = validateSchedule(schedule);
          if (!scheduleCheck.ok) throw new DaemonCommandError('VALIDATION_INVALID', `新计划无效：${scheduleCheck.error}`);
          const nextAt = computeNextAt(schedule, Date.now());
          if (nextAt == null) throw new DaemonCommandError('VALIDATION_INVALID', '新计划无法产生未来触发时刻');
          // timezone 列与 schedule_json 保持一致（第二十四轮二修复：旧实现改计划不同步列）。
          // paused→active=显式继续（authority 类暂停在下次触发重查时如实再判定；恢复不自动补跑）。
          deps.db.prepare(`UPDATE reminders SET title = COALESCE(?, title), schedule_json = ?, timezone = ?, next_at = ?, auto_dispatch = COALESCE(?, auto_dispatch),
                           status = 'active', paused_reason = NULL, revision = revision + 1, updated_at = ? WHERE id = ?`)
            .run(params.title ?? null, JSON.stringify(schedule), schedule.tz ?? 'UTC', nextAt, params.autoDispatch == null ? null : (params.autoDispatch ? 1 : 0), Date.now(), row.id);
          return { revision: row.revision + 1 };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'reminder.cancel': {
        const params = z.strictObject({ reminderId: z.string().min(1) }).parse(env.params);
        const rowPre = deps.db.prepare('SELECT id, conversation_id FROM reminders WHERE id = ?').get(params.reminderId) as { id: string; conversation_id: string } | undefined;
        if (rowPre == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `提醒不存在：${params.reminderId}`);
        assertConversationAudience(deps.db, deps.localUserId, rowPre.conversation_id);
        const tx = deps.db.transaction((): { cancelled: boolean; settledAwaiting: number } => {
          const row = deps.db.prepare('SELECT id, status FROM reminders WHERE id = ?').get(params.reminderId) as { id: string; status: string } | undefined;
          if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `提醒不存在：${params.reminderId}`);
          // once 到点后（done）仍有待确认触发→必须可取消（第二十五轮二：取消=结算待确认事项；
          // 已开始执行的任务不在此处冒充停止——按正式停止入口处理）。
          if (row.status === 'done') {
            const settled = deps.db.prepare("UPDATE reminder_occurrences SET outcome = 'cancelled_by_user', fired_at = COALESCE(fired_at, ?) WHERE reminder_id = ? AND outcome = 'awaiting_confirmation' AND status = 'fired'")
              .run(Date.now(), params.reminderId).changes;
            if (settled > 0) {
              deps.db.prepare("UPDATE reminders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'done'").run(Date.now(), params.reminderId);
              return { cancelled: true, settledAwaiting: settled };
            }
            return { cancelled: false, settledAwaiting: 0 }; // done 且无可结算事项——如实无变化
          }
          const changed = deps.db.prepare(`UPDATE reminders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('active','paused')`).run(Date.now(), params.reminderId).changes;
          if (changed === 1) {
            // 同步结算待确认触发（active/paused 取消路径同样适用——待我处理不再出现）。
            const settled = deps.db.prepare("UPDATE reminder_occurrences SET outcome = 'cancelled_by_user' WHERE reminder_id = ? AND outcome = 'awaiting_confirmation' AND status = 'fired'")
              .run(params.reminderId).changes;
            return { cancelled: true, settledAwaiting: settled };
          }
          return { cancelled: false, settledAwaiting: 0 };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'reminder.confirm': {
        // REM-8 正式确认入口：awaiting_confirmation 的 occurrence 经用户确认→正式执行派发
        // （任务+outbox+调用预占，author=system——不伪装人类）。状态/授权/预算**事务内重读
        // 核对**（并发取消/额度争用在提交前拦截——两条待确认争最后一格恰一条获准）；
        // 重放先命中回执（网关）——首次成功后的状态变化不阻塞同号重试。
        const params = z.strictObject({ reminderId: z.string().min(1), scheduledAt: z.number().int().positive() }).parse(env.params);
        const rowPre = deps.db.prepare('SELECT id, conversation_id FROM reminders WHERE id = ?').get(params.reminderId) as { id: string; conversation_id: string } | undefined;
        if (rowPre == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `提醒不存在：${params.reminderId}`);
        assertConversationAudience(deps.db, deps.localUserId, rowPre.conversation_id); // 授权每次重检（含重放）
        const tx = deps.db.transaction((): { taskId: string; confirmedAt: number } => {
          const row = deps.db.prepare('SELECT * FROM reminders WHERE id = ?').get(params.reminderId) as
            | { id: string; conversation_id: string; thread_id: string | null; task_id: string | null; owner_member_id: string; owner_user: string | null; title: string | null; source_ref: string | null; timezone: string; schedule_json: string; budget_json: string | null; auto_dispatch: number; bound_stop_generation: number; status: string }
            | undefined;
          if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `提醒不存在：${params.reminderId}`);
          if (row.status === 'cancelled') throw new DaemonCommandError('VALIDATION_INVALID', '提醒已取消——不能确认执行（待确认事项已结算）');
          const occ = deps.db.prepare('SELECT status, outcome, missed_count FROM reminder_occurrences WHERE reminder_id = ? AND scheduled_at = ?').get(params.reminderId, params.scheduledAt) as
            | { status: string; outcome: string; missed_count: number } | undefined;
          if (occ == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `触发记录不存在：${params.reminderId}@${params.scheduledAt}`);
          if (occ.status !== 'fired' || occ.outcome !== 'awaiting_confirmation') {
            throw new DaemonCommandError('VALIDATION_INVALID', `当前状态 ${occ.status}/${occ.outcome} 不可确认（仅待确认触发可确认）`);
          }
          const authority = recheckReminderAuthority(deps.db, row);
          if (!authority.ok) throw new DaemonCommandError('FORBIDDEN', `授权重查未通过：${authority.reason}`);
          const budget = checkReminderBudget(deps.db, row);
          if (!budget.ok) throw new DaemonCommandError('BUDGET_EXCEEDED', budget.reason === 'budget_corrupt' ? '预算记录损坏——拒绝派发（fail-closed）' : '预算已用尽——拒绝派发');
          const dispatch = dispatchReminderExecution(deps.db, {
            reminder: row,
            scheduledAt: params.scheduledAt,
            missedCount: occ.missed_count ?? 0,
            dispatchedCount: reminderCallUsage(deps.db, row.id),
            now: Date.now(),
          });
          const changed = deps.db.prepare(`UPDATE reminder_occurrences SET outcome = 'dispatched', task_id = ?, confirmed_at = ? WHERE reminder_id = ? AND scheduled_at = ? AND outcome = 'awaiting_confirmation'`)
            .run(dispatch.taskId, Date.now(), params.reminderId, params.scheduledAt).changes;
          if (changed !== 1) throw new DaemonCommandError('REVISION_CONFLICT', '确认竞态：触发状态已变化');
          return { taskId: dispatch.taskId, confirmedAt: Date.now() };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'reminder.list': {
        // REM-5：audience 过滤——他人 DM 的提醒（标题/计划/occurrence）不因列表泄露。
        const params = z.strictObject({ projectId: z.string().min(1).optional() }).parse(env.params);
        const audienceFilter = ' AND (c.kind != \'dm\' OR EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.conversation_id = c.id AND dp.principal_type = \'human\' AND dp.principal_id = ?))';
        const rows = (params.projectId != null
          ? deps.db.prepare(`SELECT r.*, c.project_id AS project_id_ FROM reminders r JOIN conversations c ON c.id = r.conversation_id WHERE c.project_id = ?${audienceFilter} ORDER BY r.rowid DESC`).all(params.projectId, deps.localUserId)
          : deps.db.prepare(`SELECT r.*, c.project_id AS project_id_ FROM reminders r JOIN conversations c ON c.id = r.conversation_id WHERE 1=1${audienceFilter} ORDER BY r.rowid DESC`).all(deps.localUserId)) as Array<Record<string, unknown>>;
        const items = rows.map((row) => ({
          reminderId: row.id, projectId: row.project_id_, conversationId: row.conversation_id, threadId: row.thread_id, taskId: row.task_id,
          ownerMemberId: row.owner_member_id, title: row.title, sourceRef: row.source_ref,
          schedule: JSON.parse(row.schedule_json as string) as ReminderSchedule,
          timezone: row.timezone,
          nextAt: row.next_at, status: row.status, pausedReason: row.paused_reason,
          budgetLimit: row.budget_json != null ? JSON.parse(row.budget_json as string) : null,
          revision: row.revision,
          autoDispatch: row.auto_dispatch === 1,
          lastFiredAt: row.last_fired_at,
          occurrences: (deps.db.prepare(`SELECT scheduled_at, status, outcome, missed_count, fired_at, task_id, confirmed_at FROM reminder_occurrences WHERE reminder_id = ? ORDER BY scheduled_at DESC LIMIT 200`).all(row.id) as Array<{ scheduled_at: number; status: string; outcome: string | null; missed_count: number; fired_at: number | null; task_id: string | null; confirmed_at: number | null }>),
        }));
        return withCommandId({ ok: true, data: { items } });
      }
      case 'thread.subscribe': {
        // DEV-18 关注/静音（第二十五轮四）：**人的阅读订阅**（thread_subscriptions——与
        // thread_agent_followers=Agent 执行跟进名单分列）。纯偏好写：不建运行/不停止任务/
        // 不改冻结参与者；未读/通知聚合按 muted 排除、followed 进待我处理（另处消费）。
        const params = z.strictObject({ threadId: z.string().min(1), follow: z.boolean().optional(), mute: z.boolean().optional() }).parse(env.params);
        const thread = deps.db.prepare('SELECT conversation_id, project_id FROM conversation_threads WHERE id = ?').get(params.threadId) as { conversation_id: string; project_id: string } | undefined;
        if (thread == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `线程不存在：${params.threadId}`);
        assertConversationAudience(deps.db, deps.localUserId, thread.conversation_id);
        const tx = deps.db.transaction((): { followed: boolean; muted: boolean } => {
          const cur = deps.db.prepare('SELECT followed, muted FROM thread_subscriptions WHERE thread_id = ? AND viewer_id = ?').get(params.threadId, deps.localUserId) as { followed: number; muted: number } | undefined;
          const followed = params.follow ?? cur?.followed === 1;
          const muted = params.mute ?? cur?.muted === 1;
          deps.db.prepare(`INSERT INTO thread_subscriptions (thread_id, viewer_id, followed, muted) VALUES (?, ?, ?, ?)
                           ON CONFLICT(thread_id, viewer_id) DO UPDATE SET followed = excluded.followed, muted = excluded.muted`)
            .run(params.threadId, deps.localUserId, followed ? 1 : 0, muted ? 1 : 0);
          return { followed, muted };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'thread.subscriptions': {
        const params = z.strictObject({ projectId: z.string().min(1).optional() }).parse(env.params);
        const rows = (params.projectId != null
          ? deps.db.prepare(`SELECT s.thread_id, s.followed, s.muted, c.project_id, t.root_task_id FROM thread_subscriptions s JOIN conversation_threads t ON t.id = s.thread_id JOIN conversations c ON c.id = t.conversation_id WHERE c.project_id = ? AND s.viewer_id = ?`)
          : deps.db.prepare(`SELECT s.thread_id, s.followed, s.muted, c.project_id, t.root_task_id FROM thread_subscriptions s JOIN conversation_threads t ON t.id = s.thread_id JOIN conversations c ON c.id = t.conversation_id WHERE s.viewer_id = ?`))
          .all(...(params.projectId != null ? [params.projectId, deps.localUserId] : [deps.localUserId])) as Array<{ thread_id: string; followed: number; muted: number; project_id: string; root_task_id: string | null }>;
        return withCommandId({ ok: true, data: { items: rows.map((r) => ({ threadId: r.thread_id, followed: r.followed === 1, muted: r.muted === 1, projectId: r.project_id, taskId: r.root_task_id })) } });
      }
      case 'search.query': {
        // DEV-18 搜索（第二十五轮四）：消息/线程锚文本/任务标题（附件**只随所在消息**检索
        // ——附件名命中即该消息命中；正文提取未实施不冒充）。范围：project=当前项目 /
        // all=全部可访问项目（同 mine.pending 口径——正式链无隐藏位）。audience：他人 DM
        // 的消息/线程/任务与摘要一律不返回。确定性排序（created_at/seq+id）+分页。
        const params = z.strictObject({
          text: z.string().min(1).max(200),
          scope: z.enum(['project', 'visible', 'all']).default('project'),
          projectId: z.string().min(1).optional(),
          conversationId: z.string().min(1).optional(),
          authorDisplayName: z.string().min(1).max(100).optional(),
          fromDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          toDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          kind: z.enum(['all', 'message', 'thread', 'task']).default('all'),
          page: z.number().int().min(1).default(1),
          pageSize: z.number().int().min(1).max(50).default(20),
        }).parse(env.params);
        if (params.scope === 'project' && params.projectId == null) throw new DaemonCommandError('VALIDATION_INVALID', 'scope=project 需要 projectId');
        // R67 P4：scope=visible（侧栏可见集）——与 board.view 同口径：navigation_preferences
        //（当前 viewer+client）的 visible 集；无偏好行=全部可访问项目（缺省不隐藏）；ACL
        // 语义不变（他人 DM 仍一律不返回；不可访问项目即便出现在偏好里也不返回）。
        let visibleProjectFilter: string[] | null = null;
        if (params.scope === 'visible') {
          const prefs = visibleProjectIdsOf(deps.db, deps.localUserId) as string[];
          const visibleIds = prefs;
          if (visibleIds != null && visibleIds.length >= 0) {
            const accessible = new Set((deps.db.prepare('SELECT id FROM projects WHERE status != ?').all('removed') as Array<{ id: string }>).map((r: { id: string }) => r.id));
            visibleProjectFilter = visibleIds.filter((id) => accessible.has(id));
          }
        }
        // 日期按**用户本地时区**解释（第二十六轮三：界面日期选择器即本地日——无 Z 后缀解析为
        // 本地午夜；toDay 含当日。UTC 日边界不冒充用户「当日」——北京时间凌晨边界用例锁定）。
        const localDayMs = (day: string, endExclusive = false): number => {
          const t = new Date(`${day}T00:00:00`).getTime(); // 本地午夜（无 Z）
          if (!Number.isFinite(t)) throw new DaemonCommandError('VALIDATION_INVALID', `日期无法解析：${day}`);
          return endExclusive ? t + 86_400_000 : t;
        };
        const escapeLike = (raw: string): string => raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
        const pattern = `%${escapeLike(params.text)}%`;
        const fromMs = params.fromDay != null ? localDayMs(params.fromDay) : null;
        const toMs = params.toDay != null ? localDayMs(params.toDay, true) : null;
        // 作者过滤：显示名→成员 id 集（跨项目同名都收——文本匹配如实）。
        const authorIds = params.authorDisplayName != null
          ? (deps.db.prepare('SELECT id FROM project_members WHERE display_name = ?').all(params.authorDisplayName) as Array<{ id: string }>).map((r) => r.id)
          : null;
        const audienceFilter = ` AND (c.kind != 'dm' OR EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.conversation_id = c.id AND dp.principal_type = 'human' AND dp.principal_id = ?))`;
        const convFilter = params.conversationId != null ? ' AND m.conversation_id = ?' : '';
        const authorFilter = authorIds != null ? ` AND m.author_id IN (${authorIds.map(() => '?').join(',') || "''"})` : '';
        const dateFilter = (fromMs != null ? ' AND m.created_at >= ?' : '') + (toMs != null ? ' AND m.created_at < ?' : '');
        const bind = (m: boolean): unknown[] => {
          const out: unknown[] = m ? [deps.localUserId] : [];
          if (params.scope === 'project') out.push(params.projectId!);
          if (visibleProjectFilter != null) out.push(...visibleProjectFilter);
          if (params.conversationId != null) out.push(params.conversationId);
          if (authorIds != null) out.push(...authorIds);
          if (fromMs != null) out.push(fromMs);
          if (toMs != null) out.push(toMs);
          return out;
        };
        const pageSize = params.pageSize;
        const offset = (params.page - 1) * pageSize;
        const snippetOf = (text: string): string => {
          const idx = text.indexOf(params.text);
          if (idx < 0) return text.slice(0, 48);
          return text.slice(Math.max(0, idx - 16), Math.min(text.length, idx + params.text.length + 24));
        };
        let messages: Array<Record<string, unknown>> = [];
        let threads: Array<Record<string, unknown>> = [];
        let tasks: Array<Record<string, unknown>> = [];
        // 过滤一致性（第二十六轮三）：作者/会话/日期过滤对**全部类型统一生效**（线程=锚消息
        // 作者/会话/创建时刻；任务=根消息作者/会话/创建时刻——任务标题命中但锚消息不符筛选
        // 时不混入 kind=all）。各类型 JOIN 根消息 m 统一承载过滤列。
        const scopeOnJoin = params.scope === 'project'
          ? ' AND m.project_id = ?'
          : visibleProjectFilter != null
            ? ` AND m.project_id IN (${visibleProjectFilter.map(() => '?').join(',') || "''"})`
            : '';
        // 任务分支按任务自身 project_id 过滤（同一可见集口径）。
        const scopeOnTask = params.scope === 'project'
          ? ' AND t.project_id = ?'
          : visibleProjectFilter != null
            ? ` AND t.project_id IN (${visibleProjectFilter.map(() => '?').join(',') || "''"})`
            : '';
        if (params.kind === 'all' || params.kind === 'message') {
          messages = (deps.db.prepare(
            `SELECT m.id, m.project_id, p.display_name AS project_name, m.conversation_id, m.thread_id, m.conversation_seq, m.created_at, m.author_type, m.author_id, json_extract(m.body_json, '$.text') AS text
             FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN projects p ON p.id = m.project_id
             WHERE (json_extract(m.body_json, '$.text') LIKE ? COLLATE NOCASE ESCAPE '\\'
                    OR EXISTS (SELECT 1 FROM message_attachments a WHERE a.message_id = m.id AND a.display_name LIKE ? COLLATE NOCASE ESCAPE '\\'))${audienceFilter}${scopeOnJoin}${convFilter}${authorFilter}${dateFilter}
             ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
          ).all(pattern, pattern, ...bind(true), pageSize, offset) as Array<{ id: string; project_id: string; project_name: string; conversation_id: string; thread_id: string | null; conversation_seq: number; created_at: number; author_type: string; author_id: string; text: string | null }>)
            .map((r) => ({ kind: 'message', messageId: r.id, projectId: r.project_id, projectName: r.project_name, conversationId: r.conversation_id, threadId: r.thread_id, seq: r.conversation_seq, createdAt: r.created_at, authorType: r.author_type, authorId: r.author_id, snippet: snippetOf(String(r.text ?? '')), locate: `#msg=${r.id}` }));
        }
        if (params.kind === 'all' || params.kind === 'thread') {
          threads = (deps.db.prepare(
            `SELECT t.id, t.project_id, p.display_name AS project_name, t.conversation_id, t.root_task_id, t.anchor_message_id, m.created_at, m.author_id, json_extract(m.body_json, '$.text') AS text
             FROM conversation_threads t
             JOIN messages m ON m.id = t.anchor_message_id
             JOIN conversations c ON c.id = t.conversation_id JOIN projects p ON p.id = t.project_id
             WHERE json_extract(m.body_json, '$.text') LIKE ? COLLATE NOCASE ESCAPE '\\'${audienceFilter}${scopeOnJoin}${convFilter}${authorFilter}${dateFilter}
             ORDER BY m.created_at DESC, t.id DESC LIMIT ? OFFSET ?`,
          ).all(pattern, ...bind(true), pageSize, offset) as Array<{ id: string; project_id: string; project_name: string; conversation_id: string; root_task_id: string | null; anchor_message_id: string; created_at: number; author_id: string; text: string | null }>)
            .map((r) => ({ kind: 'thread', threadId: r.id, projectId: r.project_id, projectName: r.project_name, conversationId: r.conversation_id, taskId: r.root_task_id, createdAt: r.created_at, snippet: snippetOf(String(r.text ?? '')), locate: r.root_task_id != null ? `#task=${r.root_task_id}` : `#msg=${r.anchor_message_id}` }));
        }
        if (params.kind === 'all' || params.kind === 'task') {
          // 任务过滤统一（第二十六轮三）：范围/会话按任务自身列；作者/日期按**根消息**
          // （LEFT JOIN——无根消息的任务仅在不设作者/日期过滤时可见；设过滤时无法匹配=如实排除）。
          tasks = (deps.db.prepare(
            `SELECT t.id, t.project_id, p.display_name AS project_name, t.conversation_id, t.title, t.status, m.created_at, m.author_id
             FROM tasks t
             LEFT JOIN messages m ON m.id = t.root_message_id
             JOIN conversations c ON c.id = t.conversation_id JOIN projects p ON p.id = t.project_id
             WHERE t.title LIKE ? COLLATE NOCASE ESCAPE '\\'${audienceFilter}${scopeOnTask}${params.conversationId != null ? ' AND t.conversation_id = ?' : ''}${authorFilter}${dateFilter}
             ORDER BY t.rowid DESC LIMIT ? OFFSET ?`,
          ).all(pattern, deps.localUserId, ...(params.scope === 'project' ? [params.projectId!] : (visibleProjectFilter ?? [])), ...(params.conversationId != null ? [params.conversationId] : []), ...(authorIds ?? []), ...(fromMs != null ? [fromMs] : []), ...(toMs != null ? [toMs] : []), pageSize, offset) as Array<{ id: string; project_id: string; project_name: string; conversation_id: string; title: string; status: string; created_at: number | null; author_id: string | null }>)
            .map((r) => ({ kind: 'task', taskId: r.id, projectId: r.project_id, projectName: r.project_name, conversationId: r.conversation_id, title: r.title, status: r.status, createdAt: r.created_at, authorId: r.author_id, locate: `#task=${r.id}` }));
        }
        return withCommandId({ ok: true, data: { page: params.page, pageSize, scope: params.scope, messages, threads, tasks, attachmentNote: '附件按所在消息的文件名检索；正文提取未实施（不冒充支持）；日期按本机时区解释' } });
      }
      case 'attachment.uploadText': {
        // DEV-24 文本/Markdown 首包（第二十六轮五；第二十七轮六扩代码类）——能力①保存副本：
        // 内容寻址落应用数据区（{appData}/blobstore/{hash}.txt——不在用户项目目录生成副本）；
        // artifacts 持久 hash/版本（revision）/来源文件名/conversation audience；同文件不同内容
        // =不同资源。**kind 按扩展名推导**（kindForFilename：源代码扩展名=code_file，其余=
        // text_file——同一读取/截断/完整性/注入链路）。规则：utf-8（BOM 容忍）；含 NUL 控制字节
        // =二进制拒绝；>256KB 拒绝；>64KB 保存全文但预览/注入截断（truncated+originalBytes 如实
        // 注明）。
        const params = z.strictObject({
          conversationId: z.string().min(1),
          filename: z.string().min(1).max(200),
          content: z.string().min(1).max(600_000),
        }).parse(env.params);
        const convInfo = assertConversationAudience(deps.db, deps.localUserId, params.conversationId);
        if (/[\u0000-\u0008\u000E-\u001F]/.test(params.content)) throw new DaemonCommandError('VALIDATION_INVALID', '内容含二进制控制字节——不是文本附件（七类二进制随后续批次）');
        const bytes = Buffer.byteLength(params.content, 'utf8');
        if (bytes > ATT_MAX_BYTES) throw new DaemonCommandError('VALIDATION_INVALID', `文件大小 ${bytes}B 超过文本附件上限 ${ATT_MAX_BYTES}B（明确规则：不静默截断保存）`);
        const convArchived = (deps.db.prepare('SELECT archived_at FROM conversations WHERE id = ?').get(params.conversationId) as { archived_at: number | null }).archived_at;
        if (convArchived != null) throw new DaemonCommandError('CONVERSATION_ARCHIVED', '会话已归档：禁止新上传（历史附件仍可预览）');
        const hash = createHash('sha256').update(params.content, 'utf8').digest('hex');
        const blobRoot = join(deps.appDataDir ?? process.env.ZS_APP_DATA ?? process.cwd(), 'blobstore');
        mkdirSync(blobRoot, { recursive: true });
        atomicWriteFile(join(blobRoot, `${hash}.txt`), params.content); // 内容寻址原件，失败不截断现有副本
        const tx = deps.db.transaction((): { attachmentId: string; hash: string; bytes: number; truncated: boolean; originalBytes: number } => {
          const attachmentId = `art_${randomUUID()}`;
          deps.db.prepare(`INSERT INTO artifacts (id, project_id, conversation_id, author_id, kind, revision, hash, blob_path, source_name, created_at)
                           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
            .run(attachmentId, convInfo.projectId, params.conversationId, deps.localUserId, kindForFilename(params.filename), hash, join(blobRoot, `${hash}.txt`), params.filename, Date.now());
          return { attachmentId, hash, bytes, truncated: bytes > ATT_EXCERPT_BYTES, originalBytes: bytes };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'attachment.uploadTextRaw': {
        // R69 P1-C：文本附件**原字节上传**——hash/副本=真实原字节（BOM/UTF-16/GB18030
        // 原样保存，另存原文件逐字节一致）；阅读/提取经 decodeTextBytes 检测链解码
        // （元信息随回执返回，解码失败=二进制/未知编码明确拒绝）。0 字节空文件允许保存
        // （预览显示 0B 空态；「发 AI 只有空文件」由发送侧能力门处理）。与 uploadText
        // （旧界面仍用）并存：同 blobstore/{hash}.txt 内容寻址。
        const params = z.strictObject({
          conversationId: z.string().min(1),
          filename: z.string().min(1).max(200),
          contentBase64: z.string().max(512 * 1024),
        }).parse(env.params);
        const convInfo = assertConversationAudience(deps.db, deps.localUserId, params.conversationId);
        const raw = Buffer.from(params.contentBase64, 'base64');
        if (raw.length > ATT_MAX_BYTES) throw new DaemonCommandError('VALIDATION_INVALID', `文件 ${raw.length}B 超过文本附件上限 ${ATT_MAX_BYTES}B（明确规则：不静默截断保存）`);
        const convArchived = (deps.db.prepare('SELECT archived_at FROM conversations WHERE id = ?').get(params.conversationId) as { archived_at: number | null }).archived_at;
        if (convArchived != null) throw new DaemonCommandError('CONVERSATION_ARCHIVED', '会话已归档：禁止新上传（历史附件仍可预览）');
        const dec = decodeTextBytes(raw);
        if (!dec.ok) throw new DaemonCommandError('VALIDATION_INVALID', `${dec.error.message}——请确认是文本文件后重选（未上传任何内容）`);
        if (/[\u0000-\u0008\u000E-\u001F]/.test(dec.text)) throw new DaemonCommandError('VALIDATION_INVALID', '解码后内容含二进制控制字节——不是文本附件（图片/PDF/Office 请用对应类型上传）');
        const hash = createHash('sha256').update(raw).digest('hex');
        const blobRoot = join(deps.appDataDir ?? process.env.ZS_APP_DATA ?? process.cwd(), 'blobstore');
        mkdirSync(blobRoot, { recursive: true });
        atomicWriteFile(join(blobRoot, `${hash}.txt`), raw); // 原字节；失败不截断现有副本
        const tx = deps.db.transaction((): { attachmentId: string; hash: string; bytes: number; truncated: boolean; originalBytes: number; encoding: string; kind: string } => {
          const attachmentId = `art_${randomUUID()}`;
          const kind = kindForFilename(params.filename);
          deps.db.prepare(`INSERT INTO artifacts (id, project_id, conversation_id, author_id, kind, revision, hash, blob_path, source_name, created_at)
                           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
            .run(attachmentId, convInfo.projectId, params.conversationId, deps.localUserId, kind, hash, join(blobRoot, `${hash}.txt`), params.filename, Date.now());
          return { attachmentId, hash, bytes: raw.length, truncated: raw.length > ATT_EXCERPT_BYTES, originalBytes: raw.length, encoding: dec.encoding, kind };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'attachment.previewText': {
        // 能力②预览+③提取正文：读**获准副本**（blob_path——原文件变化不改变已保存版本）；
        // audience：归属会话（或本地用户可达）——跨会话/他人 DM 拒绝。读取经共享完整性路径
        //（第二十七轮四：路径限定托管存储+sha256 实际字节核对——损坏明确拒绝）；UTF-8 **字节**
        // 截断（保留完整字符），原始大小/提取大小/截断事实分别注明。
        const params = z.strictObject({ attachmentId: z.string().min(1), conversationId: z.string().min(1).optional() }).parse(env.params);
        const row = deps.db.prepare('SELECT id, conversation_id, hash, blob_path, source_name, kind, revision FROM artifacts WHERE id = ?').get(params.attachmentId) as
          | { id: string; conversation_id: string; hash: string; blob_path: string; source_name: string; kind: string; revision: number } | undefined;
        if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `附件不存在：${params.attachmentId}`);
        const convId = params.conversationId ?? row.conversation_id;
        assertConversationAudience(deps.db, deps.localUserId, convId);
        if (convId !== row.conversation_id) throw new DaemonCommandError('FORBIDDEN', '附件不属于该会话（audience 校验拒绝）');
        if (!(ATT_TEXT_KINDS as readonly string[]).includes(row.kind)) throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', `该附件类型（${row.kind}）非文本/代码附件范围`);
        const verified = readVerifiedCopy(row.blob_path, row.hash, join(deps.appDataDir ?? process.env.ZS_APP_DATA ?? process.cwd(), 'blobstore'));
        if (!verified.ok) throw new DaemonCommandError('STORAGE_UNAVAILABLE', verified.error.message);
        return withCommandId({ ok: true, data: { attachmentId: row.id, filename: row.source_name, kind: row.kind, revision: row.revision, hash: verified.copy.hash, text: verified.copy.text, truncated: verified.copy.truncated, originalBytes: verified.copy.originalBytes, excerptBytes: verified.copy.excerptBytes } });
      }
      case 'attachment.readFull': {
        // R66 P2：完整文件读取（屏幕阅读通道）——与 previewText（64KB 提取窗=模型注入同源）
        // 分列：返回托管副本**全文**（无截断）。audience/完整性链与 previewText 完全一致；
        // 模型注入预算合同不变（仍走提取窗——不把整份文件无界发给模型）。
        const params = z.strictObject({ attachmentId: z.string().min(1), conversationId: z.string().min(1).optional() }).parse(env.params);
        const row = deps.db.prepare('SELECT id, conversation_id, hash, blob_path, source_name, kind, revision FROM artifacts WHERE id = ?').get(params.attachmentId) as
          | { id: string; conversation_id: string; hash: string; blob_path: string; source_name: string; kind: string; revision: number } | undefined;
        if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `附件不存在：${params.attachmentId}`);
        const convId = params.conversationId ?? row.conversation_id;
        assertConversationAudience(deps.db, deps.localUserId, convId);
        if (convId !== row.conversation_id) throw new DaemonCommandError('FORBIDDEN', '附件不属于该会话（audience 校验拒绝）');
        if (!(ATT_TEXT_KINDS as readonly string[]).includes(row.kind)) throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', `该附件类型（${row.kind}）非文本/代码附件范围（完整读取面向文本类）`);
        const full = readVerifiedFullText(row.blob_path, row.hash, join(deps.appDataDir ?? process.env.ZS_APP_DATA ?? process.cwd(), 'blobstore'));
        if (!full.ok) throw new DaemonCommandError('STORAGE_UNAVAILABLE', full.error.message);
        return withCommandId({ ok: true, data: { attachmentId: row.id, filename: row.source_name, kind: row.kind, revision: row.revision, hash: row.hash, text: full.text, originalBytes: full.originalBytes, complete: true, encoding: full.encoding ?? 'utf-8', note: '屏幕阅读=托管副本全文；模型注入仍走 64KB 提取窗（预算合同不变）' } });
      }
      case 'attachment.originalFile': {
        // R66 P5：下载原文件/另存为——按资源 kind 的实际存储扩展名读**原件字节**
        //（文本类={hash}.txt；其余={hash}.bin——与导出随包拷贝同链 readVerifiedStoreRaw：
        // 实根/实身份/受控句柄/实际字节 sha256）。audience 同 previewText。仅返回字节与
        // 身份；落盘由主进程「另存为」对话框完成（用户显式选路径——renderer 不能指定路径）。
        const params = z.strictObject({ attachmentId: z.string().min(1), conversationId: z.string().min(1).optional() }).parse(env.params);
        const row = deps.db.prepare('SELECT id, conversation_id, hash, blob_path, source_name, kind, revision FROM artifacts WHERE id = ?').get(params.attachmentId) as
          | { id: string; conversation_id: string; hash: string; blob_path: string; source_name: string | null; kind: string; revision: number } | undefined;
        if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `附件不存在：${params.attachmentId}`);
        const convId = params.conversationId ?? row.conversation_id;
        assertConversationAudience(deps.db, deps.localUserId, convId);
        if (convId !== row.conversation_id) throw new DaemonCommandError('FORBIDDEN', '附件不属于该会话（audience 校验拒绝）');
        const ext = (ATT_TEXT_KINDS as readonly string[]).includes(row.kind) ? 'txt' as const : 'bin' as const;
        const raw = readVerifiedStoreRaw(row.blob_path, row.hash, ext, join(deps.appDataDir ?? process.env.ZS_APP_DATA ?? process.cwd(), 'blobstore'));
        if (!raw.ok) throw new DaemonCommandError('STORAGE_UNAVAILABLE', raw.error.message);
        return withCommandId({ ok: true, data: { attachmentId: row.id, filename: row.source_name, kind: row.kind, revision: row.revision, hash: row.hash, bytes: raw.raw.length, bytesBase64: raw.raw.toString('base64') } });
      }
      case 'attachment.listByConversation': {
        const params = z.strictObject({ conversationId: z.string().min(1) }).parse(env.params);
        assertConversationAudience(deps.db, deps.localUserId, params.conversationId);
        const rows = deps.db.prepare(`SELECT a.id, a.source_name, a.hash, a.revision, a.kind, a.created_at FROM artifacts a WHERE a.conversation_id = ? AND a.kind IN ('text_file','code_file','image_file','pdf_file','docx_file','sheet_file','slides_file') ORDER BY a.rowid DESC`).all(params.conversationId) as Array<{ id: string; source_name: string | null; hash: string; revision: number; kind: string; created_at: number }>;
        return withCommandId({ ok: true, data: { items: rows.map((r) => ({ attachmentId: r.id, filename: r.source_name, kind: r.kind, hash: r.hash, revision: r.revision, createdAt: r.created_at })) } });
      }
      case 'delivery.document': {
        // R68 §6：正式 AI 交付文档的只读通道（共享预览第三来源）。交付本体=turn 最终输出
        //（artifact_refs 'turn:<id>:final'——manifest_hash 即其 sha256）；文本经自然链持久化
        // 为线程回复消息（dispatchWorker insertThreadReply：msg_<turnId>_<messageId>、
        // author=agent、status='final'）。本命令按交付引用定位该消息并**核对 hash**——
        // hashMatch=false / 找不到消息时如实返回（text=null + reason），不伪造文档。
        // audience 同 attachment.*（DM 双成员/房间项目可达）；版本绑定=交付 revision+manifestHash。
        const params = z.strictObject({ deliveryId: z.string().min(1) }).parse(env.params);
        const d = deps.db.prepare(
          `SELECT d.id, d.revision, d.manifest_hash, d.artifact_refs_json, t.title, t.conversation_id, t.conversation_thread_id, c.kind AS conv_kind
           FROM task_deliveries d JOIN tasks t ON t.id = d.task_id JOIN conversations c ON c.id = t.conversation_id WHERE d.id = ?`,
        ).get(params.deliveryId) as
          | { id: string; revision: number; manifest_hash: string; artifact_refs_json: string; title: string; conversation_id: string; conversation_thread_id: string | null; conv_kind: string }
          | undefined;
        if (d == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `交付不存在：${params.deliveryId}`);
        assertConversationAudience(deps.db, deps.localUserId, d.conversation_id);
        let turnRef: string | null = null;
        try {
          const refs = JSON.parse(d.artifact_refs_json) as unknown;
          if (Array.isArray(refs)) {
            const hit = refs.find((r) => typeof r === 'string' && r.startsWith('turn:') && r.endsWith(':final'));
            if (typeof hit === 'string') turnRef = hit.slice('turn:'.length, -':final'.length);
          }
        } catch { /* refs 损坏：按无引用处理（如实说明） */ }
        let text: string | null = null;
        let hashMatch: boolean | null = null;
        let note: string | null = null;
        if (turnRef == null) {
          note = '交付没有 turn:…:final 引用（非标准交付形态）——文档不可读';
        } else {
          const rows = deps.db.prepare(
            `SELECT id, body_json FROM messages WHERE id GLOB ? AND author_type = 'agent' AND status = 'final' ORDER BY rowid`,
          ).all(`msg_${turnRef}_*`) as Array<{ id: string; body_json: string }>;
          let chosen: { id: string; text: string } | null = null;
          let chosenMatch = false;
          for (const row of rows) {
            let text: string | null = null;
            try {
              const body=(JSON.parse(row.body_json??'{}')??{}) as {text?:unknown;runtimeControlResult?:unknown};
              const parsedText=body.runtimeControlResult??body.text;
              text = typeof parsedText === 'string' ? parsedText : null;
            } catch { text = null; }
            if (text == null) continue;
            // 优先取与 manifest hash 核对一致的候选（该 turn 可能先发进度消息再发最终输出）；
            // 无一致者取最后一条（如实报 hashMatch=false——正文仅供阅读，验收身份仍是 manifest）。
            const match = createHash('sha256').update(stripSingleJsonFence(text).text).digest('hex') === d.manifest_hash;
            if (match) { chosen = { id: row.id, text }; chosenMatch = true; break; }
            chosen = { id: row.id, text };
          }
          if (chosen == null) {
            note = rows.length === 0
              ? '该交付的最终输出消息未持久化（早期版本/被清理）——文档不可读，交付身份（版本/manifest）仍有效'
              : '该交付的最终输出消息正文不可解析——文档不可读';
          } else {
            text = chosen.text;
            hashMatch = chosenMatch;
          }
        }
        return withCommandId({
          ok: true,
          data: {
            deliveryId: d.id, revision: d.revision, manifestHash: d.manifest_hash, taskIdTitle: d.title,
            conversationId: d.conversation_id, threadId: d.conversation_thread_id, audience: d.conv_kind === 'dm' ? 'dm' : 'room',
            text, hashMatch, bytes: text != null ? Buffer.byteLength(text, 'utf8') : 0,
            ...(note != null ? { note } : {}),
          },
        });
      }
      case 'attachment.comment.add': {
        // 附件基础评论（第二十七轮六：文本/代码/Markdown）：行号/选区（quote 原文引用）+
        // 正文；**锚定评论时资源版本**（artifact_hash/revision 快照入库）——资源后续更新时
        // 旧评论标旧（list 比对当前 hash），行号/选区锚点不漂移不重算。audience=归属会话
        //（跨会话/他人 DM 拒绝）。
        const params = z.strictObject({
          attachmentId: z.string().min(1),
          body: z.string().min(1).max(2000),
          quote: z.string().max(500).optional(),
          lineFrom: z.number().int().min(1).optional(),
          lineTo: z.number().int().min(1).optional(),
          expectedHash: z.string().length(64),
          expectedRevision: z.number().int().min(1),
        }).parse(env.params);
        if (params.lineTo != null && params.lineFrom != null && params.lineTo < params.lineFrom) throw new DaemonCommandError('VALIDATION_INVALID', '行区间无效：lineTo < lineFrom');
        const row = deps.db.prepare('SELECT id, conversation_id, kind, hash, revision, blob_path FROM artifacts WHERE id = ?').get(params.attachmentId) as
          | { id: string; conversation_id: string; kind: string; hash: string; revision: number; blob_path: string } | undefined;
        if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `附件不存在：${params.attachmentId}`);
        assertConversationAudience(deps.db, deps.localUserId, row.conversation_id);
        if (!(ATT_TEXT_KINDS as readonly string[]).includes(row.kind)) throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', `该附件类型（${row.kind}）不支持评论（文本/代码/Markdown 首批）`);
        // 提取文本（共享完整性路径——损坏副本拒绝评论）：行范围/选区按用户可见范围校验。
        const verified = readVerifiedCopy(row.blob_path, row.hash, join(deps.appDataDir ?? process.env.ZS_APP_DATA ?? process.cwd(), 'blobstore'));
        if (!verified.ok) throw new DaemonCommandError('STORAGE_UNAVAILABLE', verified.error.message);
        const lineCount = verified.copy.text.split(String.fromCharCode(10)).length;
        if (params.lineFrom != null && params.lineFrom > lineCount) throw new DaemonCommandError('VALIDATION_INVALID', `行锚点越界：lineFrom=${params.lineFrom} 超出提取文本实际行数 ${lineCount}（截断时以预览所见为准）`);
        if (params.lineTo != null && params.lineTo > lineCount) throw new DaemonCommandError('VALIDATION_INVALID', `行锚点越界：lineTo=${params.lineTo} 超出提取文本实际行数 ${lineCount}`);
        if (params.quote != null && !verified.copy.text.includes(params.quote)) throw new DaemonCommandError('VALIDATION_INVALID', '引用选区不存在于提取文本——不实锚点拒绝');
        const tx = deps.db.transaction((): { commentId: string; anchoredRevision: number } => {
          // 事务内重读核对（第二十八轮三：并发版本变化不被外层旧快照放行）：用户看到的版本==当前版本才锚定。
          const now = deps.db.prepare('SELECT hash, revision FROM artifacts WHERE id = ?').get(row.id) as { hash: string; revision: number } | undefined;
          if (now == null || now.hash !== params.expectedHash || now.revision !== params.expectedRevision) {
            throw new DaemonCommandError('VERSION_CONFLICT', `附件版本已变化（用户看到 v${params.expectedRevision}/${params.expectedHash.slice(0, 8)}…，当前 v${now?.revision ?? '?'}/${(now?.hash ?? '').slice(0, 8)}…）——刷新预览后针对新版本评论`);
          }
          const commentId = `ac_${randomUUID()}`;
          deps.db.prepare(`INSERT INTO attachment_comments (id, artifact_id, author_id, quote, line_from, line_to, body, artifact_hash, artifact_revision, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(commentId, row.id, deps.localUserId, params.quote ?? null, params.lineFrom ?? null, params.lineTo ?? null, params.body, now.hash, now.revision, Date.now());
          return { commentId, anchoredRevision: now.revision };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'attachment.comment.list': {
        // 评论列表（audience 同上）：逐条带 anchoredTo（锚定 hash/revision）+stale（当前资源
        // hash ≠ 锚定 hash=资源已更新——旧评论明确标旧，不漂移到新版行号）。
        const params = z.strictObject({ attachmentId: z.string().min(1) }).parse(env.params);
        const row = deps.db.prepare('SELECT id, conversation_id, hash, revision FROM artifacts WHERE id = ?').get(params.attachmentId) as
          | { id: string; conversation_id: string; hash: string; revision: number } | undefined;
        if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `附件不存在：${params.attachmentId}`);
        assertConversationAudience(deps.db, deps.localUserId, row.conversation_id);
        const rows = deps.db.prepare('SELECT id, author_id, quote, line_from, line_to, body, artifact_hash, artifact_revision, created_at FROM attachment_comments WHERE artifact_id = ? ORDER BY created_at, rowid').all(params.attachmentId) as Array<{ id: string; author_id: string; quote: string | null; line_from: number | null; line_to: number | null; body: string; artifact_hash: string; artifact_revision: number; created_at: number }>;
        return withCommandId({ ok: true, data: { currentHash: row.hash, items: rows.map((c) => ({ commentId: c.id, authorId: c.author_id, quote: c.quote, lineFrom: c.line_from, lineTo: c.line_to, body: c.body, anchoredTo: { hash: c.artifact_hash, revision: c.artifact_revision }, stale: c.artifact_hash !== row.hash || c.artifact_revision !== row.revision, createdAt: c.created_at })) } });
      }
      case 'attachment.uploadImage': {
        // 图片附件首包（第二十八轮四）——能力①保存原件：内容寻址落 {appData}/blobstore/
        //{hash}.bin（二进制原件）；kind=image_file（hash/revision/来源/audience 同既有资源身份）；
        // **内容类型按 magic bytes 校验**（PNG/JPEG/GIF/WebP——扩展名不作依据）；尺寸/面积按
        // 格式头解析限幅；损坏/截断/超限明确拒绝（不静默缩放）。原件上限 8MB。
        const params = z.strictObject({
          conversationId: z.string().min(1),
          filename: z.string().min(1).max(200),
          contentBase64: z.string().min(1).max(12 * 1024 * 1024), // base64 膨胀裕量
        }).parse(env.params);
        const convInfo = assertConversationAudience(deps.db, deps.localUserId, params.conversationId);
        const convArchived = (deps.db.prepare('SELECT archived_at FROM conversations WHERE id = ?').get(params.conversationId) as { archived_at: number | null }).archived_at;
        if (convArchived != null) throw new DaemonCommandError('CONVERSATION_ARCHIVED', '会话已归档：禁止新上传（历史附件仍可预览）');
        const raw = Buffer.from(params.contentBase64, 'base64');
        if (raw.length === 0) throw new DaemonCommandError('VALIDATION_INVALID', '图片内容为空');
        if (raw.length > ATT_IMAGE_MAX_BYTES) throw new DaemonCommandError('VALIDATION_INVALID', `图片原件 ${raw.length}B 超过上限 ${ATT_IMAGE_MAX_BYTES}B（明确规则：不静默压缩）`);
        const meta = validateImageBuffer(raw);
        if (!meta.ok) throw new DaemonCommandError('VALIDATION_INVALID', meta.message);
        const hash = createHash('sha256').update(raw).digest('hex');
        const blobRoot = join(deps.appDataDir ?? process.env.ZS_APP_DATA ?? process.cwd(), 'blobstore');
        mkdirSync(blobRoot, { recursive: true });
        atomicWriteFile(join(blobRoot, `${hash}.bin`), raw); // 内容寻址原件，失败不截断现有副本
        const tx = deps.db.transaction((): { attachmentId: string; hash: string; bytes: number; width: number; height: number; mime: string } => {
          const attachmentId = `art_${randomUUID()}`;
          deps.db.prepare(`INSERT INTO artifacts (id, project_id, conversation_id, author_id, kind, revision, hash, blob_path, source_name, created_at)
                           VALUES (?, ?, ?, ?, 'image_file', 1, ?, ?, ?, ?)`)
            .run(attachmentId, convInfo.projectId, params.conversationId, deps.localUserId, hash, join(blobRoot, `${hash}.bin`), params.filename, Date.now());
          return { attachmentId, hash, bytes: raw.length, width: meta.meta.width, height: meta.meta.height, mime: meta.meta.mime };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'attachment.previewImage': {
        // 能力②预览：audience+实根+sha256 原件核对；返回 mime/尺寸/原件字节+dataUrl（渲染
        // 由 renderer <img>——浏览器沙箱解码；服务端零像素解码依赖）。能力③**OCR 提取正文=
        // 未实现（如实 unsupported）**；能力④按实际目标成员认证，独立于本地预览（R76）。
        const params = z.strictObject({ attachmentId: z.string().min(1), conversationId: z.string().min(1).optional() }).parse(env.params);
        const row = deps.db.prepare('SELECT id, conversation_id, hash, blob_path, source_name, kind, revision FROM artifacts WHERE id = ?').get(params.attachmentId) as
          | { id: string; conversation_id: string; hash: string; blob_path: string; source_name: string | null; kind: string; revision: number } | undefined;
        if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `附件不存在：${params.attachmentId}`);
        const convId = params.conversationId ?? row.conversation_id;
        assertConversationAudience(deps.db, deps.localUserId, convId);
        if (convId !== row.conversation_id) throw new DaemonCommandError('FORBIDDEN', '附件不属于该会话（audience 校验拒绝）');
        if (row.kind !== 'image_file') throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', `该附件类型（${row.kind}）非图片附件范围`);
        const verified = readVerifiedBlob(row.blob_path, row.hash, join(deps.appDataDir ?? process.env.ZS_APP_DATA ?? process.cwd(), 'blobstore'));
        if (!verified.ok) throw new DaemonCommandError('STORAGE_UNAVAILABLE', verified.error.message);
        const meta = validateImageBuffer(verified.raw);
        if (!meta.ok) throw new DaemonCommandError('STORAGE_UNAVAILABLE', `原件已不再可解析：${meta.message}`);
        return withCommandId({ ok: true, data: { attachmentId: row.id, filename: row.source_name, kind: row.kind, revision: row.revision, hash: verified.raw ? row.hash : row.hash, mime: meta.meta.mime, width: meta.meta.width, height: meta.meta.height, bytes: verified.raw.length, dataUrl: `data:${meta.meta.mime};base64,${verified.raw.toString('base64')}`, ocr: 'unsupported', modelInput: 'depends-on-target-member' } });
      }
      case 'attachment.uploadPdf': {
        // PDF 附件（第二十八轮五→第二十九轮二重构）：能力①保存原件+隔离解析验证（子进程
        // 边界）；加密/损坏/超页数/超大小明确拒绝；提取缓存随上传写入（schema v2 严格校验）；
        // 幂等三层（commandId 回执预查→同会话同 hash 去重→跨会话缓存复用）——同内容重复上传
        // /重放都不重复解析、不重复建业务记录。原件 {appData}/blobstore/{hash}.bin。
        const params = z.strictObject({
          conversationId: z.string().min(1),
          filename: z.string().min(1).max(200),
          contentBase64: z.string().min(1).max(28 * 1024 * 1024),
        }).parse(env.params);
        const r = await uploadDocumentAttachment(deps, run, { scope, commandId: env.commandId, payloadHash }, {
          conversationId: params.conversationId,
          filename: params.filename,
          contentBase64: params.contentBase64,
          byteCap: PDF_MAX_BYTES,
          parseKind: 'pdf',
        });
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'attachment.previewPdf': {
        // 能力②预览（文本层分页）+③提取正文（缓存优先、无效即隔离重提）；audience+实根+
        // 实身份+sha256 核对。扫描件无文本=如实空页（OCR 单列未实现）。视觉页面渲染=渲染器
        // 受限预览侧浏览器 canvas（第二十九轮三——includeBytes 一次取原件字节，翻页/缩放在
        // 渲染器本地完成，服务端零像素解码）。
        const params = z.strictObject({ attachmentId: z.string().min(1), page: z.number().int().min(1).optional(), conversationId: z.string().min(1).optional(), includeBytes: z.boolean().optional() }).parse(env.params);
        const row = deps.db.prepare('SELECT id, conversation_id, hash, blob_path, source_name, kind, revision, extracted_text_json FROM artifacts WHERE id = ?').get(params.attachmentId) as
          | { id: string; conversation_id: string; hash: string; blob_path: string; source_name: string | null; kind: string; revision: number; extracted_text_json: string | null } | undefined;
        if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `附件不存在：${params.attachmentId}`);
        const convId = params.conversationId ?? row.conversation_id;
        assertConversationAudience(deps.db, deps.localUserId, convId);
        if (convId !== row.conversation_id) throw new DaemonCommandError('FORBIDDEN', '附件不属于该会话（audience 校验拒绝）');
        if (row.kind !== 'pdf_file') throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', `该附件类型（${row.kind}）非 PDF 附件范围`);
        const cache = await ensureDocumentCache(deps, row, 'pdf');
        if (cache.kind !== 'pdf') throw new DaemonCommandError('STORAGE_UNAVAILABLE', '提取缓存类型不符（非 pdf）——拒绝以他类缓存冒充');
        const totalPages = cache.pages.length;
        const pageNo = Math.min(params.page ?? 1, Math.max(totalPages, 1));
        const page = cache.pages.find((pg) => pg.page === pageNo) ?? null;
        const verified = readVerifiedBlob(row.blob_path, row.hash, join(deps.appDataDir ?? process.env.ZS_APP_DATA ?? process.cwd(), 'blobstore'));
        if (!verified.ok) throw new DaemonCommandError('STORAGE_UNAVAILABLE', verified.error.message);
        return withCommandId({
          ok: true,
          data: {
            attachmentId: row.id, filename: row.source_name, kind: row.kind, revision: row.revision, hash: row.hash,
            totalPages, page: pageNo, text: page?.text ?? '', truncated: page?.truncated ?? false,
            truncatedTotal: cache.truncatedTotal, parser: `${cache.parserName}@${cache.parserVersion}`,
            pixelRendering: 'renderer-canvas', ocr: 'unsupported', extractedAt: cache.extractedAt,
            ...(params.includeBytes === true ? { bytesBase64: verified.raw.toString('base64') } : {}),
          },
        });
      }
      case 'attachment.uploadOffice': {
        // Office 三类（第二十九轮四）：zip 头+[Content_Types] 嗅探定类（DOCX/XLSX/PPTX）——
        // 逐类结构由解析子进程校验；宏/模板变体拒绝；外部关系不加载、公式不执行、图片不解码。
        // 四能力分别记录（保存/预览/提取/受限输入）——"可上传"不等于完成。
        // R71：base64 参数上限 48MiB（32MiB 原件 ×4/3≈44.9MiB；PDF 分道仍 28MiB）。
        const params = z.strictObject({
          conversationId: z.string().min(1),
          filename: z.string().min(1).max(200),
          contentBase64: z.string().min(1).max(48 * 1024 * 1024),
        }).parse(env.params);
        const r = await uploadDocumentAttachment(deps, run, { scope, commandId: env.commandId, payloadHash }, {
          conversationId: params.conversationId,
          filename: params.filename,
          contentBase64: params.contentBase64,
          byteCap: OFFICE_MAX_BYTES,
          parseKind: 'office',
        });
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'attachment.uploadCsv': {
        // CSV（第二十九轮四）：编码探测（UTF-8/UTF-8 BOM/UTF-16 BOM——其余明确 unsupported
        // 不静默转码）；RFC4180 引号+分隔符嗅探；kind=sheet_file（sourceFormat=csv 同缓存链）。
        const params = z.strictObject({
          conversationId: z.string().min(1),
          filename: z.string().min(1).max(200),
          contentBase64: z.string().min(1).max(8 * 1024 * 1024),
        }).parse(env.params);
        const r = await uploadDocumentAttachment(deps, run, { scope, commandId: env.commandId, payloadHash }, {
          conversationId: params.conversationId,
          filename: params.filename,
          contentBase64: params.contentBase64,
          byteCap: CSV_MAX_BYTES,
          parseKind: 'csv',
        });
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'attachment.previewOffice': {
        // Office 预览（第二十九轮四；第四十轮·选型决定 A 增补视觉字节通道）：DOCX=安全排版
        // HTML（白名单净化）+ 可选 docx-preview 视觉；表格=sheet 分列+预览窗口+合并单元格+
        // 公式缺失标注；PPTX=按页文字+备注 + pptx-renderer 渲染器侧视觉。注入范围由
        // message.submit 的 attachmentRanges 承接。OCR/页图能力如实分列。
        // includeBytes（第四十轮）：docx/slides 原件字节经 readVerifiedBlob（实根+sha256 核验
        // 后）一次性返回，供受限预览侧本地渲染（翻页/缩放零新增运行）；**字节上限在整份
        // 缓冲进入 renderer 前检查**（OFFICE_MAX_BYTES 20MiB——上传链已限，此处双保险）；
        // 超限/缺参=明确不带字节（visualBytesAvailable 如实分列，前端降级文字卡片）。
        const params = z.strictObject({ attachmentId: z.string().min(1), conversationId: z.string().min(1).optional(), includeBytes: z.boolean().optional() }).parse(env.params);
        const row = deps.db.prepare('SELECT id, conversation_id, hash, blob_path, source_name, kind, revision, extracted_text_json FROM artifacts WHERE id = ?').get(params.attachmentId) as
          | { id: string; conversation_id: string; hash: string; blob_path: string; source_name: string | null; kind: string; revision: number; extracted_text_json: string | null } | undefined;
        if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `附件不存在：${params.attachmentId}`);
        const convId = params.conversationId ?? row.conversation_id;
        assertConversationAudience(deps.db, deps.localUserId, convId);
        if (convId !== row.conversation_id) throw new DaemonCommandError('FORBIDDEN', '附件不属于该会话（audience 校验拒绝）');
        if (row.kind !== 'docx_file' && row.kind !== 'sheet_file' && row.kind !== 'slides_file') throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', `该附件类型（${row.kind}）非 Office 附件范围`);
        const cacheKind = (ARTIFACT_PARSE_KINDS[row.kind] ?? { cache: 'docx' as const }).cache;
        // R69 P1-D：提取缓存不可用（软解析失败/null 缓存——原件已保存）时**预览不整体失败**：
        // 返回字节通道 + extraction:'failed'（本地静态渲染可继续；模型注入保持 fail-closed）。
        // 读取原件字节与成功路径共用同一 readVerifiedBlob 完整性链。
        let cache: ExtractCache | null;
        try {
          cache = await ensureDocumentCache(deps, row, cacheKind);
          if (cache.kind !== cacheKind) throw new DaemonCommandError('STORAGE_UNAVAILABLE', '提取缓存类型不符——拒绝冒充');
        } catch (e) {
          const msg = String((e as Error).message);
          if (/原件已不可解析|提取缓存缺失/.test(msg)) {
            cache = null;
          } else {
            throw e;
          }
        }
        const common = { attachmentId: row.id, filename: row.source_name, kind: row.kind, revision: row.revision, hash: row.hash, ...(cache != null ? { extractedAt: cache.extractedAt, parser: `${cache.parserName}@${cache.parserVersion}`, truncatedTotal: cache.truncatedTotal } : { parser: 'unavailable', truncatedTotal: false }) };
        // 视觉字节通道（第四十轮；R69 起三类 Office 全带——Excel 本地渲染器同样吃原件字节）：
        // docx/slides/sheet 原件字节经 readVerifiedBlob（实根+sha256 核验后）一次性返回；
        // 上限双保险（OFFICE_MAX_BYTES 20MiB），超限/缺参=明确不带字节（前端如实降级）。
        let visualBytesBase64: string | undefined;
        let visualBytesAvailable = false;
        let visualBytesReason: string | null = null;
        if (params.includeBytes === true && (row.kind === 'docx_file' || row.kind === 'slides_file' || row.kind === 'sheet_file')) {
          const verified = readVerifiedBlob(row.blob_path, row.hash, join(deps.appDataDir ?? process.env.ZS_APP_DATA ?? process.cwd(), 'blobstore'));
          if (!verified.ok) throw new DaemonCommandError('STORAGE_UNAVAILABLE', verified.error.message);
          if (verified.raw.length > OFFICE_MAX_BYTES) {
            visualBytesReason = `原件 ${verified.raw.length.toLocaleString('en-US')}B（约 ${(verified.raw.length / 1048576).toFixed(1)}MiB）超视觉通道上限 ${(OFFICE_MAX_BYTES / 1048576).toFixed(0)}MiB——视觉预览不可用，文字提取不受影响`;
          } else {
            visualBytesBase64 = verified.raw.toString('base64');
            visualBytesAvailable = true;
          }
        }
        const visualBytes = visualBytesAvailable
          ? { visualBytesAvailable: true as const, bytesBase64: visualBytesBase64 }
          : (params.includeBytes === true
            ? { visualBytesAvailable: false as const, visualBytesReason }
            : {});
        if (cache == null) {
          // R69 P1-D 分列态：提取不可用（软解析失败）——字节/保存/引用不受影响；注入 fail-closed。
          return withCommandId({ ok: true, data: { ...common, extraction: 'failed' as const, modelInput: 'unavailable-fail-closed', pixelRendering: 'renderer-local-bytes', ...visualBytes } });
        }
        switch (cache.kind) {
          case 'docx':
            return withCommandId({ ok: true, data: { ...common, html: cache.html, htmlTruncated: cache.htmlTruncated, paragraphCount: cache.paragraphCount, ocr: 'unsupported', pixelRendering: 'safe-html+docx-preview', modelInput: 'extracted-text', ...visualBytes } });
          case 'sheet':
            return withCommandId({ ok: true, data: { ...common, sourceFormat: cache.sourceFormat, encoding: cache.encoding, sheets: cache.sheets, pixelRendering: 'renderer-xlsx+grid', formulaExecution: 'never-cached-values-only', modelInput: 'range-window', ...visualBytes } });
          case 'slides':
            return withCommandId({ ok: true, data: { ...common, slides: cache.slides, totalSlides: cache.totalSlides, totalTextBytes: cache.totalTextBytes, truncatedTotal: cache.truncatedTotal, pixelRendering: 'renderer-pptx-renderer', textInput: 'extracted-text', modelInput: 'extracted-text', ...visualBytes } });
          default:
            throw new DaemonCommandError('STORAGE_UNAVAILABLE', '提取缓存类型不符——拒绝冒充');
        }
      }
      case 'attachment.previewSlidesPages': {
        // PPTX 静态页预览（DEV-24 M3；第三十七轮四建立，第三十八轮四重写）：
        // - **重活进可终止子进程**（此前 daemon 主进程内 safeUnzip+buildPptxPages——绕过解析池
        //   的内存硬界/墙钟截止/终止梯）：kind='pptx-pages'，载荷经 outPath 文件（IPC 4MB 防御
        //   上限不承载大 SVG），父进程读回后**严格校验**（validatePptxPagesCache——结构/页序/
        //   尺寸/字节预算/SVG 白名单/转换器版本）再落缓存；
        // - **缓存命中也核对原件**（第三十八轮：此前命中在 readVerifiedBlob 之前直接返回——
        //   原件缺失/损坏/越界时仍返回旧预览）：先 readVerifiedBlob（实根/实身份/sha256），
        //   再验缓存；
        // - **绑定原件版本**：缓存键=`pages:slides:<artifactId>`，值内 sourceHash 必须等于当前
        //   行 hash（schema 2 起转换器版本一并绑定——旧 schema 1 缓存全量作废）；
        // - 写回前**重读 artifact 行**（迟到防覆盖从注释变为实现：行消失=跳过；hash 已变=按
        //   行内新事实弃写——本轮回执仍返回本次构建结果）。
        // - 与提取文本预览分列（previewOffice 的 slides 通道不变）；版面近似（图表/表格/
        //   SmartArt/组合显式「不渲染」占位标注——不静默白页），不冒充像素级还原。
        const params = z.strictObject({ attachmentId: z.string().min(1), conversationId: z.string().min(1).optional() }).parse(env.params);
        const row = deps.db.prepare('SELECT id, conversation_id, hash, blob_path, source_name, kind, revision FROM artifacts WHERE id = ?').get(params.attachmentId) as
          | { id: string; conversation_id: string; hash: string; blob_path: string; source_name: string | null; kind: string; revision: number } | undefined;
        if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `附件不存在：${params.attachmentId}`);
        const convId = params.conversationId ?? row.conversation_id;
        assertConversationAudience(deps.db, deps.localUserId, convId);
        if (convId !== row.conversation_id) throw new DaemonCommandError('FORBIDDEN', '附件不属于该会话（audience 校验拒绝）');
        if (row.kind !== 'slides_file') throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', `该附件类型（${row.kind}）非幻灯片附件`);
        // 原件先行核对（缓存命中不豁免——hash/实根/身份三重）。
        const verified = readVerifiedBlob(row.blob_path, row.hash, join(deps.appDataDir ?? process.env.ZS_APP_DATA ?? process.cwd(), 'blobstore'));
        if (!verified.ok) throw new DaemonCommandError('STORAGE_UNAVAILABLE', verified.error.message);
        const cacheKey = `pages:slides:${row.id}`;
        const cachedRaw = (deps.db.prepare('SELECT value FROM daemon_state WHERE key = ?').get(cacheKey) as { value: string } | undefined)?.value ?? null;
        const cached = validatePptxPagesCache(cachedRaw, row.hash);
        if (cached != null) {
          return withCommandId({ ok: true, data: { attachmentId: row.id, filename: row.source_name, kind: row.kind, revision: row.revision, hash: row.hash, cache: 'hit', pxW: cached.pxW, pxH: cached.pxH, totalSlides: cached.slides.length, slides: cached.slides.map((s) => ({ slide: s.slide, truncated: s.truncated, textTruncated: s.textTruncated, shapes: s.shapes, images: s.images, unsupported: s.unsupported, unsupportedKinds: s.unsupportedKinds, notes: s.notes, notesTruncated: s.notesTruncated, svg: s.svg })) } });
        }
        // 子进程转换：输出文件由本命令管理（成功读回/失败清理）。
        const outDir = join(deps.appDataDir ?? process.env.ZS_APP_DATA ?? process.cwd(), 'parse-out');
        const outPath = join(outDir, `pages-${randomUUID()}.json`);
        mkdirSync(outDir, { recursive: true });
        let pages: PptxPages;
        try {
          const runResult = await getParsePool().runPages(row.blob_path, row.hash, outPath, { deadlineMs: 45_000 });
          if (!runResult.ok) {
            throw new DaemonCommandError('STORAGE_UNAVAILABLE', `静态页构建失败（${runResult.error.message}）——提取文本预览仍可用（分列）`);
          }
          const rawJson = readFileSync(outPath, 'utf8');
          const validated = validatePptxPagesCache(rawJson, row.hash);
          if (validated == null) throw new DaemonCommandError('STORAGE_UNAVAILABLE', '静态页构建产物未过严格校验（结构/页序/预算/SVG 白名单）——拒绝缓存，提取文本预览仍可用');
          pages = validated;
        } catch (error) {
          if (error instanceof DaemonCommandError) throw error;
          throw new DaemonCommandError('STORAGE_UNAVAILABLE', `静态页构建失败（${error instanceof Error ? error.message : String(error)}）——提取文本预览仍可用（分列）`);
        } finally {
          try { rmSync(outPath, { force: true }); } catch { /* 清理尽力 */ }
        }
        // 写回前重读 artifact（迟到保护实现化：行消失/会话变化=弃写；hash 变化=按新事实弃写——
        // 下一次预览按新 hash 重建，不用本轮结果冒充）。
        deps.db.transaction(() => {
          const nowRow = deps.db.prepare('SELECT id, hash FROM artifacts WHERE id = ?').get(row.id) as { id: string; hash: string } | undefined;
          if (nowRow == null || nowRow.hash !== row.hash) return;
          assertConversationAudience(deps.db, deps.localUserId, row.conversation_id);
          deps.db.prepare(`INSERT INTO daemon_state (key, value, updated_at) VALUES (?, ?, ?)
                           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
            .run(cacheKey, JSON.stringify(pages), Date.now());
        }).immediate();
        return withCommandId({ ok: true, data: { attachmentId: row.id, filename: row.source_name, kind: row.kind, revision: row.revision, hash: row.hash, cache: 'built', pxW: pages.pxW, pxH: pages.pxH, totalSlides: pages.slides.length, slides: pages.slides.map((s) => ({ slide: s.slide, truncated: s.truncated, textTruncated: s.textTruncated, shapes: s.shapes, images: s.images, unsupported: s.unsupported, unsupportedKinds: s.unsupportedKinds, notes: s.notes, notesTruncated: s.notesTruncated, svg: s.svg })) } });
      }
      case 'saved.add': {
        // DEV-18 收藏（第二十五轮四）：独立持久（saved_refs——001 的 saved_items 为消息 FK
        // 专位保留）；重复收藏幂等（已存在=existed）；取消收藏不删原内容（saved.remove）。
        const params = z.strictObject({
          kind: z.enum(['message', 'link', 'task', 'delivery']),
          ref: z.string().min(1).max(500),
          title: z.string().max(200).optional(),
          projectId: z.string().min(1).optional(),
        }).parse(env.params);
        if (params.kind === 'link' && !/^https?:\/\//i.test(params.ref)) throw new DaemonCommandError('VALIDATION_INVALID', '链接收藏需 http(s) URL');
        const target = (() => {
          if (params.kind === 'message') {
            const row = deps.db.prepare('SELECT id, conversation_id FROM messages WHERE id = ?').get(params.ref) as { id: string; conversation_id: string } | undefined;
            return row == null ? null : { conversationId: row.conversation_id };
          }
          if (params.kind === 'task') {
            const row = deps.db.prepare('SELECT id, conversation_id, title FROM tasks WHERE id = ?').get(params.ref) as { id: string; conversation_id: string; title: string } | undefined;
            return row == null ? null : { conversationId: row.conversation_id };
          }
          if (params.kind === 'delivery') {
            const row = deps.db.prepare('SELECT d.id, t.conversation_id FROM task_deliveries d JOIN tasks t ON t.id = d.task_id WHERE d.id = ?').get(params.ref) as { id: string; conversation_id: string } | undefined;
            return row == null ? null : { conversationId: row.conversation_id };
          }
          return { conversationId: null as string | null }; // link：无会话归属
        })();
        if (target == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `收藏目标不存在：${params.ref}`);
        if (target.conversationId != null) assertConversationAudience(deps.db, deps.localUserId, target.conversationId);
        const tx = deps.db.transaction((): { saved: boolean; existed: boolean } => {
          const existing = deps.db.prepare('SELECT 1 AS ok FROM saved_refs WHERE viewer_id = ? AND kind = ? AND ref = ?').get(deps.localUserId, params.kind, params.ref);
          if (existing != null) return { saved: true, existed: true };
          deps.db.prepare('INSERT INTO saved_refs (viewer_id, kind, ref, title, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(deps.localUserId, params.kind, params.ref, params.title ?? null, params.projectId ?? null, Date.now());
          return { saved: true, existed: false };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'saved.remove': {
        const params = z.strictObject({ kind: z.enum(['message', 'link', 'task', 'delivery']), ref: z.string().min(1).max(500) }).parse(env.params);
        const tx = deps.db.transaction((): { removed: boolean } => {
          const changed = deps.db.prepare('DELETE FROM saved_refs WHERE viewer_id = ? AND kind = ? AND ref = ?').run(deps.localUserId, params.kind, params.ref).changes;
          return { removed: changed === 1 }; // 只删收藏行——原内容不动
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'saved.list': {
        // 逐条校验：目标存在+audience → ok/missing/forbidden（如实呈现；跳转复用正式深链）。
        const rows = deps.db.prepare('SELECT kind, ref, title, project_id, created_at FROM saved_refs WHERE viewer_id = ? ORDER BY created_at DESC, rowid DESC').all(deps.localUserId) as Array<{ kind: string; ref: string; title: string | null; project_id: string | null; created_at: number }>;
        const items = rows.map((row) => {
          const base = { kind: row.kind, ref: row.ref, title: row.title, projectId: row.project_id, createdAt: row.created_at };
          if (row.kind === 'link') return { ...base, status: 'ok', locate: null as string | null };
          if (row.kind === 'message') {
            const m = deps.db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(row.ref) as { conversation_id: string } | undefined;
            if (m == null) return { ...base, status: 'missing', locate: null };
            try { assertConversationAudience(deps.db, deps.localUserId, m.conversation_id); } catch { return { ...base, status: 'forbidden', locate: null }; }
            return { ...base, status: 'ok', locate: `#msg=${row.ref}` };
          }
          if (row.kind === 'task') {
            const t = deps.db.prepare('SELECT conversation_id FROM tasks WHERE id = ?').get(row.ref) as { conversation_id: string } | undefined;
            if (t == null) return { ...base, status: 'missing', locate: null };
            try { assertConversationAudience(deps.db, deps.localUserId, t.conversation_id); } catch { return { ...base, status: 'forbidden', locate: null }; }
            return { ...base, status: 'ok', locate: `#task=${row.ref}` };
          }
          const d = deps.db.prepare('SELECT t.conversation_id FROM task_deliveries d JOIN tasks t ON t.id = d.task_id WHERE d.id = ?').get(row.ref) as { conversation_id: string } | undefined;
          if (d == null) return { ...base, status: 'missing', locate: null };
          try { assertConversationAudience(deps.db, deps.localUserId, d.conversation_id); } catch { return { ...base, status: 'forbidden', locate: null }; }
          return { ...base, status: 'ok', locate: `#delivery=${row.ref}` };
        });
        return withCommandId({ ok: true, data: { items } });
      }
      case 'board.view': {
        // DEV-19 看板首包（第二十六轮四）：纯读聚合——复用正式任务/运行/交付数据（不建新表，
        // 不改任务状态——已有动作只接正式命令，看板不可拖动改库）。卡片保留项目/房间/taskId/
        // 线程身份（同名房间按 roomId 区分、同号任务按 taskId）；dm_turn 不进房间看板；
        // 他人 DM 不泄露。状态分列如实：running/review/blocked（runStatus=UNKNOWN 标注退出
        // 未确认）/stopped/waiting。子任务=根任务即卡片位（不重复计交付——pendingDelivery
        // 取最高 pending 一条）。
        const params = z.strictObject({ scope: z.enum(['project', 'all']).default('project'), projectId: z.string().min(1).optional() }).parse(env.params);
        if (params.scope === 'project' && params.projectId == null) throw new DaemonCommandError('VALIDATION_INVALID', 'scope=project 需要 projectId');
        // 可见范围（第三十一轮二）：scope=all ≠ 全部项目——按用户可见项目集
        // （navigation_preferences.visibleProjectIds，无偏好行=全量）过滤；scope=project 的
        // 显式指定不受可见集限制（query 范围与 visible 范围的既定区别）。
        const projects = (params.scope === 'project'
          ? deps.db.prepare('SELECT id, display_name FROM projects WHERE id = ?').all(params.projectId)
          : (deps.db.prepare('SELECT id, display_name FROM projects ORDER BY rowid').all() as Array<{ id: string; display_name: string }>).filter((p) => visibleProjectIdsOf(deps.db, deps.localUserId).includes(p.id))) as Array<{ id: string; display_name: string }>;
        const groups = projects.map((p) => {
          const rooms = (deps.db.prepare('SELECT id, name FROM rooms WHERE project_id = ? ORDER BY rowid').all(p.id) as Array<{ id: string; name: string }>).map((room) => {
            const cards = (deps.db.prepare(
              `SELECT t.id, t.title, t.status, t.stop_generation, t.conversation_thread_id, t.owner_member_id, t.room_task_number,
                      (SELECT r.id FROM workflow_runs r WHERE r.task_id = t.id ORDER BY r.rowid DESC LIMIT 1) AS run_id,
                      (SELECT r.status FROM workflow_runs r WHERE r.task_id = t.id ORDER BY r.rowid DESC LIMIT 1) AS run_status
               FROM tasks t JOIN conversations c ON c.id = t.conversation_id
               WHERE t.room_id = ? AND t.kind = 'room_task' AND c.project_id = ?
               ORDER BY t.rowid DESC`,
            ).all(room.id, p.id) as Array<{ id: string; title: string; status: string; stop_generation: number; conversation_thread_id: string | null; owner_member_id: string | null; room_task_number: number | null; run_id: string | null; run_status: string | null }>).map((t) => {
              const pendingDelivery = t.status === 'REVIEW'
                ? (deps.db.prepare(`SELECT id, revision, manifest_hash FROM task_deliveries WHERE task_id = ? AND review_status = 'pending' ORDER BY revision DESC LIMIT 1`).get(t.id) as { id: string; revision: number; manifest_hash: string } | undefined) ?? null
                : null;
              // 状态映射按**任务/run 状态机**（第二十七轮五修正）：任务终态如实分列（DONE/FAILED=
              // 已完成、CANCELLED=已停止）；stop_generation 是代次不是停止证明——历史停止后
              // 新运行照常按 run 状态列位（旧实现 stop_generation>0 恒落 stopped、DONE 落
              // waiting 两缺陷同修）。STOPPING=停止中；INTERRUPTED=中断（列停止，恢复入口
              // 另接——不冒充等待）。
              const column = t.status === 'REVIEW' ? 'review'
                : t.status === 'BLOCKED' ? 'blocked'
                : t.status === 'DONE' || t.status === 'FAILED' ? 'done'
                : t.status === 'CANCELLED' ? 'stopped'
                : t.run_status === 'STOPPING' ? 'stopped'
                : t.run_status === 'RUNNING' || t.run_status === 'WAITING' || t.run_status === 'QUEUED' ? 'running'
                : t.run_status === 'INTERRUPTED' ? 'stopped'
                : 'waiting';
              // 退出未确认：来自 turn/恢复事实——run INTERRUPTED 且该 run 存在 UNKNOWN turn
              // （不确定结局）。workflow_runs 状态机无 UNKNOWN（旧检查 run_status==='UNKNOWN'
              // 恒假——那是 agent_turns 状态，已删）。
              const exitUnconfirmed = t.run_status === 'INTERRUPTED' && t.run_id != null
                && ((deps.db.prepare("SELECT count(*) c FROM agent_turns WHERE run_id = ? AND status = 'UNKNOWN'").get(t.run_id) as { c: number }).c > 0);
              return {
                taskId: t.id, title: t.title, roomTaskNumber: t.room_task_number, threadId: t.conversation_thread_id,
                projectId: p.id, roomId: room.id, ownerMemberId: t.owner_member_id,
                taskStatus: t.status, runStatus: t.run_status, runId: t.run_id, stopGeneration: t.stop_generation, column,
                exitUnconfirmed,
                // 受阻/失败原因（第三十八轮 #4）：BLOCKED/FAILED 卡片带人话——远程与桌面共用本聚合。
                statusReason: t.status === 'BLOCKED' || t.status === 'FAILED' || t.run_status === 'FAILED' || t.run_status === 'INTERRUPTED'
                  ? taskStatusReasonOf(deps.db, t.id)
                  : null,
                pendingDelivery: pendingDelivery == null ? null : { deliveryId: pendingDelivery.id, revision: pendingDelivery.revision, manifestHash: pendingDelivery.manifest_hash },
                locate: `#task=${t.id}`,
              };
            });
            return { roomId: room.id, name: room.name, cards };
          });
          return { projectId: p.id, displayName: p.display_name, rooms };
        });
        return withCommandId({ ok: true, data: { groups, note: '只读聚合——不改变任何任务状态；动作走正式命令（停止/验收/追加执行）' } });
      }
      case 'remote.config.get': {
        // 远程配置读取（本机可信入口——remoteServer.REMOTE_BLOCKED_METHODS 在 HTTP 面拒绝）。
        // 第三十六轮二：**实际监听/绑定事实**分层呈现——running/address 来自实际监听（非配置
        // 保存成功）；LAN 模式附本机经实际 LAN IP 的 HTTPS 自检；仅本机模式明确提示其它设备
        // 无法连接；证书呈现服务证书指纹+CA（信任根）指纹+Subject/Issuer（两层证书）。
        const cfg = readRemoteConfig(deps.db);
        const cur = deps.remoteControl?.current() ?? null;
        const lanSelfCheck = cur != null && cfg.allowLan && deps.remoteControl?.verifyLanBinding != null
          ? await deps.remoteControl.verifyLanBinding()
          : null;
        return withCommandId({ ok: true, data: {
          ...cfg,
          ...(cur != null
            ? { running: true, address: cur.address, fingerprint: cur.fingerprint, caFingerprint: cur.caFingerprint, lanAddresses: cur.lanAddresses, lanAddressDetails: cur.lanAddressDetails, certNotAfter: cur.certNotAfter, certSubject: cur.certSubject, certIssuer: cur.certIssuer }
            : { running: false }),
          ...(lanSelfCheck != null ? { lanSelfCheck } : {}),
          lanIps: lanIps(),
          note: cfg.allowLan
            ? '局域网模式：核对实际监听地址与 LAN 自检；跨机不通时先取客户端具体错误码，再分层定位（证书信任/防火墙——见 README 排查段），不预判定性'
            : '仅本机模式：仅 127.0.0.1 可访问——其它设备无法连接；需要客户端访问请切换局域网模式并启用',
        } });
      }
      case 'remote.config.set': {
        // 远程配置写入+服务生命周期联动（entry 注入 remoteControl；测试直连=明确拒绝）。
        const params = z.strictObject({
          enabled: z.boolean(),
          listenHost: z.string().min(1).max(100),
          port: z.number().int().min(0).max(65535),
          allowLan: z.boolean(),
        }).refine((p) => !p.allowLan || p.listenHost !== '127.0.0.1', { message: 'allowLan=true 不能用回环地址——配置 LAN 地址（如 0.0.0.0 或具体 IP）', path: ['listenHost'] })
          .refine((p) => p.allowLan || p.listenHost === '127.0.0.1' || p.listenHost === 'localhost' || p.listenHost === '::1', { message: 'allowLan=false 时拒绝非回环监听地址（第三十二轮四）——选 LAN 需同时 allowLan=true', path: ['listenHost'] }).parse(env.params);
        if (deps.remoteControl == null) throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', '远程服务控制未接线（本命令由 UI 宿主注入执行）');
        const result = run(() => writeRemoteConfig(deps.db, params, Date.now()));
        const outcome = await deps.remoteControl.restart(params);
        return withCommandId({ ok: true, data: { config: result.data, ...(outcome !== undefined && 'stopped' in (outcome as object) ? { stopped: true } : outcome) } });
      }
      case 'remote.pairing.create': {
        // 配对码创建（仅本机可信 UI；HTTP 面不暴露）。码只在本响应出现一次（摘要落库）。
        const params = z.strictObject({ code: z.string().min(8).max(64).optional(), ttlMs: z.number().int().min(1000).max(600_000).optional() }).parse(env.params);
        const cur = deps.remoteControl?.current() ?? null;
        const created = createPairingCode(deps.db, Date.now(), params);
        if (!created.ok) throw new DaemonCommandError('VALIDATION_INVALID', created.error);
        return withCommandId({ ok: true, data: { pairingId: created.pairingId, code: created.code, expiresAt: created.expiresAt, address: cur?.address ?? null, fingerprint: cur?.fingerprint ?? null, note: '配对码 5 分钟内一次有效；地址与证书 SHA-256 指纹在设备端核对后完成信任（不降级 HTTP）' } });
      }
      case 'remote.pairing.selfcheckProbe': {
        // 自检幂等探针（第三十四轮三）：**独立测试对象**——写 daemon_state 专用键
        //（selfcheck:probe:<commandId>），不触碰任何用户可见状态（第三十三轮用
        // nav.preferences 做探针——visibleProjectIdsOf 按 viewer 最新行（不分 client_id）
        // 取可见集，空数组行会使全项目看板归零）。同 commandId 重放命中回执 replayed=true
        // 不重复执行——与真实业务同一幂等网关；finally 由自检清理（审计行保留）。
        // 仅隔离验收模式（与 remote.pairing.selfcheck 同门）；正式产品双保险拒绝。
        if (process.env.ZS_REMOTE_SELFCHECK !== '1') {
          throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', '自检探针仅在隔离验收模式开放（双机包启动器注入——正式入口不带）');
        }
        const params = z.strictObject({ round: z.string().min(1).max(64) }).parse(env.params);
        const result = run(() => {
          const key = `selfcheck:probe:${env.commandId}`;
          deps.db.prepare(`INSERT INTO daemon_state (key, value, updated_at) VALUES (?, ?, ?)
                           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
            .run(key, JSON.stringify({ round: params.round, at: Date.now() }), Date.now());
          return { probeKey: key, round: params.round };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'remote.pairing.selfcheck': {
        // 进程内自检（第三十三轮六重做）：**仅隔离验收模式**（ZS_REMOTE_SELFCHECK=1——双机包
        // 启动器注入；正式产品/桌面默认不带该变量=明确拒绝，辅助能力不进正式路径）。
        // 在 remoteServer 进程内创建码→执行机械负例→核对审计事实→吊销清理自检设备：
        // **明文码只在进程内使用、结束即失效，不落任何存储**（第三十二轮 selfcheckExport
        // 曾把明文码写 daemon_state——与 R11「只持久化加盐摘要」冲突，已废）。结果不含凭据。
        if (process.env.ZS_REMOTE_SELFCHECK !== '1') {
          throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', '自检辅助能力仅在隔离验收模式开放（双机包启动器注入——正式入口不带）');
        }
        if (deps.remoteControl?.selfcheck == null) throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', '自检未接线（本命令由 UI 宿主注入执行）');
        const report = await deps.remoteControl.selfcheck();
        return withCommandId({ ok: true, data: { ok: report.ok, pass: report.items.filter((i) => i.ok).length, total: report.items.length, items: report.items, resultsFile: report.file, note: '机械负例已在服务进程内执行（错码/伪造 Host/Origin/无 token/同号恰一次/审计核对/吊销清理）——结果文件不含任何凭据' } });
      }
      case 'remote.devices.list': {
        const devices = listDevices(deps.db);
        const cur = deps.remoteControl?.current() ?? null;
        return withCommandId({ ok: true, data: { devices, running: cur != null } });
      }
      case 'remote.device.revoke': {
        // 吊销：持久事实+服务端内存联动（token/票据/活连接全部失效——下一条请求/事件即拒）。
        const params = z.strictObject({ deviceId: z.string().min(1) }).parse(env.params);
        const result = run(() => revokeDeviceInDb(deps.db, params.deviceId, Date.now()));
        if (result.data) deps.remoteControl?.invalidateDevice(params.deviceId);
        return withCommandId({ ok: true, data: { deviceId: params.deviceId, revoked: result.data }, replayed: result.replayed });
      }
      case 'nav.preferences': {
        // 侧栏可见项目偏好（第三十一轮二）：scope=all 聚合面（看板/Activity）的正式真源。
        // set 为整体覆盖（visibleProjectIds 全量提交）；activeProjectId 为 UI 活动项目记录。
        // 隐藏项目 ≠ 归档——项目数据与显式查询不受影响，只是不进「全部」聚合面。
        const params = z.strictObject({
          clientId: z.string().min(1).max(200),
          visibleProjectIds: z.array(z.string().min(1)).optional(),
          activeProjectId: z.string().min(1).nullable().optional(),
        }).parse(env.params);
        const result = run(() => {
          const existing = deps.db.prepare('SELECT visible_project_ids_json, active_project_id, revision FROM navigation_preferences WHERE viewer_id = ? AND client_id = ?').get(deps.localUserId, params.clientId) as { visible_project_ids_json: string; active_project_id: string | null; revision: number } | undefined;
          if (params.visibleProjectIds == null && params.activeProjectId === undefined) {
            return { visibleProjectIds: JSON.parse(existing?.visible_project_ids_json ?? '[]') as string[], activeProjectId: existing?.active_project_id ?? null, revision: existing?.revision ?? 0, allWhenNoPreference: existing == null };
          }
          const known = new Set((deps.db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>).map((r) => r.id));
          const nextVisible = params.visibleProjectIds ?? JSON.parse(existing?.visible_project_ids_json ?? '[]') as string[];
          const unknown = nextVisible.filter((id) => !known.has(id));
          if (unknown.length > 0) throw new DaemonCommandError('VALIDATION_INVALID', `未知项目不能进可见集：${unknown.slice(0, 3).join('、')}`);
          const nextActive = params.activeProjectId !== undefined ? params.activeProjectId : existing?.active_project_id ?? null;
          if (nextActive != null && !known.has(nextActive)) throw new DaemonCommandError('VALIDATION_INVALID', `活动项目不存在：${nextActive}`);
          deps.db.prepare(
            `INSERT INTO navigation_preferences (viewer_id, client_id, visible_project_ids_json, active_project_id, expanded_project_ids_json, revision)
             VALUES (?, ?, ?, ?, '[]', 1)
             ON CONFLICT(viewer_id, client_id) DO UPDATE SET visible_project_ids_json = excluded.visible_project_ids_json, active_project_id = excluded.active_project_id, revision = revision + 1`,
          ).run(deps.localUserId, params.clientId, JSON.stringify(nextVisible), nextActive);
          return { visibleProjectIds: nextVisible, activeProjectId: nextActive, revision: (existing?.revision ?? 0) + 1, allWhenNoPreference: false };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'files.view': {
        // DEV-19 Files 集合（第二十七轮五）：**纯读**四类分列——项目文件（用户项目目录本身，
        // 非托管副本）/托管附件（artifacts——audience 过滤：房间全量+**本地用户参与的** DM，
        // 他人 DM 不进集合；私信资源标注 dm 不因聚合扩大可见性）/Agent 草稿（change_sets——
        // 变更集与应用状态）/交付成果（task_deliveries——深链 #delivery=）。逐项保留来源
        // （项目/会话/房间/任务）、版本、hash 与定位；不混成无来源文件列表。零运行零唤醒。
        const params = z.strictObject({ scope: z.enum(['project', 'all']).default('project'), projectId: z.string().min(1).optional() }).parse(env.params);
        if (params.scope === 'project' && params.projectId == null) throw new DaemonCommandError('VALIDATION_INVALID', 'scope=project 需要 projectId');
        const projects = (params.scope === 'project'
          ? deps.db.prepare('SELECT id, display_name, canonical_path FROM projects WHERE id = ?').all(params.projectId)
          : deps.db.prepare('SELECT id, display_name, canonical_path FROM projects ORDER BY rowid').all()) as Array<{ id: string; display_name: string; canonical_path: string }>;
        const groups = projects.map((p) => {
          const attachments = (deps.db.prepare(
            `SELECT a.id, a.source_name, a.hash, a.revision, a.kind, a.conversation_id, c.kind AS conversation_kind, c.room_id, a.created_at,
                    (SELECT ma.message_id FROM message_attachments ma WHERE ma.artifact_id = a.id ORDER BY ma.rowid LIMIT 1) AS message_id
             FROM artifacts a JOIN conversations c ON c.id = a.conversation_id
             WHERE c.project_id = ? AND (
               c.kind = 'room'
               OR (c.kind = 'dm' AND EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.conversation_id = c.id AND dp.principal_type = 'human' AND dp.principal_id = ?))
             ) ORDER BY a.rowid DESC LIMIT 200`,
          ).all(p.id, deps.localUserId) as Array<{ id: string; source_name: string | null; hash: string; revision: number; kind: string; conversation_id: string; conversation_kind: string; room_id: string | null; created_at: number; message_id: string | null }>).map((a) => ({
            attachmentId: a.id, filename: a.source_name ?? a.id, hash: a.hash, revision: a.revision, kind: a.kind,
            conversationId: a.conversation_id, conversationKind: a.conversation_kind, roomId: a.room_id,
            audience: a.conversation_kind === 'dm' ? 'dm' : 'room', createdAt: a.created_at,
            locate: a.message_id != null ? `#msg=${a.message_id}` : a.conversation_kind === 'dm' ? `#dm=${a.conversation_id}` : null,
          }));
          const drafts = (deps.db.prepare(
            `SELECT cs.id, cs.task_id, cs.application_status, cs.before_ref, cs.after_ref, t.title AS task_title
             FROM change_sets cs JOIN tasks t ON t.id = cs.task_id JOIN conversations c ON c.id=t.conversation_id
             WHERE cs.project_id = ? AND (c.kind='room' OR (c.kind='dm' AND EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.conversation_id=c.id AND dp.principal_type='human' AND dp.principal_id=?))) ORDER BY cs.rowid DESC LIMIT 100`,
          ).all(p.id,deps.localUserId) as Array<{ id: string; task_id: string | null; application_status: string; before_ref: string; after_ref: string; task_title: string | null }>).map((d) => ({
            changeSetId: d.id, taskId: d.task_id, taskTitle: d.task_title, applicationStatus: d.application_status,
            beforeRef: d.before_ref, afterRef: d.after_ref, locate: d.task_id != null ? `#task=${d.task_id}` : null,
          }));
          const deliveries = (deps.db.prepare(
            `SELECT d.id, d.revision, d.manifest_hash, d.reviewed_at, t.id AS task_id, t.title, c.kind AS conversation_kind, t.conversation_thread_id
             FROM task_deliveries d JOIN tasks t ON t.id = d.task_id JOIN conversations c ON c.id = t.conversation_id
             WHERE t.project_id = ? AND (
               c.kind = 'room'
               OR (c.kind = 'dm' AND EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.conversation_id = c.id AND dp.principal_type = 'human' AND dp.principal_id = ?))
             ) ORDER BY d.rowid DESC LIMIT 100`,
          ).all(p.id, deps.localUserId) as Array<{ id: string; revision: number; manifest_hash: string; reviewed_at: number | null; task_id: string; title: string; conversation_kind: string }>).map((d) => ({
            deliveryId: d.id, revision: d.revision, manifestHash: d.manifest_hash, taskId: d.task_id, title: d.title,
            audience: d.conversation_kind === 'dm' ? 'dm' : 'room', reviewedAt: d.reviewed_at, locate: `#delivery=${d.id}`,
          }));
          // 项目文件：项目根一层条目（来源=用户项目目录；只列名——浏览走系统资源管理器/Git 页）。
          let projectFiles: Array<{ name: string; dir: boolean }> = [];
          let projectFilesNote: string | null = null;
          try {
            const entries = readdirSync(p.canonical_path, { withFileTypes: true }).slice(0, 100);
            projectFiles = entries.map((e) => ({ name: e.name, dir: e.isDirectory() }));
          } catch (error) {
            projectFilesNote = `项目目录不可读：${error instanceof Error ? error.message : String(error)}`;
          }
          return { projectId: p.id, displayName: p.display_name, projectFiles, ...(projectFilesNote != null ? { projectFilesNote } : {}), attachments, drafts, deliveries };
        });
        return withCommandId({ ok: true, data: { groups, note: 'Files 集合（只读四类分列：项目文件/托管附件/Agent 草稿/交付成果——逐项保留来源/版本/hash/定位；私信资源仅本人可见）' } });
      }
      case 'message.react': {
        // 消息表情反应（第三十轮六，迁移 037）：本地用户操作（Agent 侧表情属 runtime 能力未开放）；
        // toggle 语义（同消息同人同表情幂等切换）；消息 audience 校验（他人 DM 拒）。
        const params = z.strictObject({ messageId: z.string().min(1), emoji: z.enum(['👍', '❤️', '😂', '🎉', '👀', '⚠️']) }).parse(env.params);
        const msg = deps.db.prepare('SELECT id, conversation_id FROM messages WHERE id = ?').get(params.messageId) as { id: string; conversation_id: string } | undefined;
        if (msg == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `消息不存在：${params.messageId}`);
        assertConversationAudience(deps.db, deps.localUserId, msg.conversation_id);
        const tx = deps.db.transaction((): { reacted: boolean; counts: Array<{ emoji: string; count: number }> } => {
          const existing = deps.db.prepare('SELECT id FROM message_reactions WHERE message_id = ? AND reactor_id = ? AND emoji = ?').get(params.messageId, deps.localUserId, params.emoji) as { id: string } | undefined;
          if (existing != null) deps.db.prepare('DELETE FROM message_reactions WHERE id = ?').run(existing.id);
          else deps.db.prepare('INSERT INTO message_reactions (id, message_id, reactor_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)').run(`mr_${randomUUID()}`, params.messageId, deps.localUserId, params.emoji, Date.now());
          const counts = deps.db.prepare('SELECT emoji, count(*) c FROM message_reactions WHERE message_id = ? GROUP BY emoji ORDER BY c DESC, emoji').all(params.messageId) as Array<{ emoji: string; c: number }>;
          return { reacted: existing == null, counts: counts.map((r) => ({ emoji: r.emoji, count: r.c })) };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'message.reactions': {
        // 反应读取（惰性呈现——消息行点开才拉取）。
        const params = z.strictObject({ messageId: z.string().min(1) }).parse(env.params);
        const msg = deps.db.prepare('SELECT id, conversation_id FROM messages WHERE id = ?').get(params.messageId) as { id: string; conversation_id: string } | undefined;
        if (msg == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `消息不存在：${params.messageId}`);
        assertConversationAudience(deps.db, deps.localUserId, msg.conversation_id);
        const rows = deps.db.prepare('SELECT emoji, reactor_id, created_at FROM message_reactions WHERE message_id = ? ORDER BY created_at').all(params.messageId) as Array<{ emoji: string; reactor_id: string; created_at: number }>;
        return withCommandId({ ok: true, data: { messageId: params.messageId, items: rows.map((r) => ({ emoji: r.emoji, reactorId: r.reactor_id, mine: r.reactor_id === deps.localUserId, createdAt: r.created_at })) } });
      }
      case 'activity.list': {
        // Activity 流（DEV-18 剩余，第三十轮六）：domain_events 只读聚合——可见性=房间事件随
        // 项目可达、DM 事件仅本人参与（他人 DM 不进流）；kind 中文映射+轻量摘要（payload 白
        // 名单提取）；分页 before 游标。零运行零唤醒。
        // 稳定游标（第三十一轮二）：created_at 同毫秒多事件不漏——(created_at, seq) 双键
        // 决定性排序；before/beforeSeq 成对（取上一页最后一条的 at/seq）。
        const params = z.strictObject({ projectId: z.string().min(1).optional(), scope: z.enum(['project', 'all']).default('all'), limit: z.number().int().min(1).max(200).default(80), before: z.number().optional(), beforeSeq: z.number().int().optional() }).parse(env.params);
        if (params.scope === 'project' && params.projectId == null) throw new DaemonCommandError('VALIDATION_INVALID', 'scope=project 需要 projectId');
        const projectIds = params.scope === 'project'
          ? [params.projectId!]
          : visibleProjectIdsOf(deps.db, deps.localUserId);
        if (projectIds.length === 0) return withCommandId({ ok: true, data: { items: [], note: '暂无项目' } });
        const KIND_LABEL: Record<string, string> = {
          'message.submitted': '消息提交', 'task.created': '任务创建', 'task.dispatched': '任务派发', 'task.completed': '任务完成',
          'task.stopped': '任务停止', 'task.reviewed': '人工验收', 'turn.started': '轮次开始', 'turn.completed': '轮次完成',
          'reminder.fired': '提醒触发', 'reminder.confirmed': '提醒确认', 'delivery.pending': '交付待验收', 'delivery.accepted': '验收通过',
          'delivery.changes_requested': '验收退回', 'conversation.archived': '会话归档', 'message.recorded': '消息记录',
          // r55 视觉核对补全：派发/线程/恢复/项目这些高频事件此前落到 kindLabel 兜底=英文原键
          //（显示层映射，不影响 DTO 形状；未知 kind 仍按原键如实透传）。
          'task.statusChanged': '任务状态变化', 'task.reviewRecorded': '验收记录', 'task.redispatchEnqueued': '重新派发入队', 'task.reworkEnqueued': '返工执行入队',
          'task.memberDisabledBlocked': '成员停用受阻', 'task.deliberationPrepareFailed': '研讨准备失败', 'task.contextAssemblyFailed': '上下文组装失败',
          'turn.statusChanged': '轮次状态变化', 'turn.startupFailed': '轮次启动失败', 'turn.lateCompletion': '迟到完成',
          'run.created': '运行创建', 'run.prepared': '运行就绪', 'run.statusChanged': '运行状态变化', 'run.stageAdvanced': '阶段推进',
          'run.stepArtifact': '阶段产物', 'run.stepFailed': '阶段失败', 'run.finalReportPublished': '最终报告发布',
          'run.participantAbsent': '参与者缺席', 'run.dispatchWaitExceeded': '派发等待超时', 'run.admissionDeferred': '准入延后',
          'run.deliberationBlocked': '研讨受阻', 'run.reconcileRequired': '需对账恢复',
          'thread.created': '线程创建', 'thread.replyAdded': '线程新回复', 'thread.collaborators': '线程名单更新',
          'reminder.budgetGateHeld': '预算门暂缓', 'recovery.reconciled': '恢复对账完成', 'recovery.protectionReleased': '保护已解除',
          'recovery.factConflictCorrected': '事实冲突已纠正', 'project.collabUpdated': '协作限制更新', 'project.reviewPolicyUpdated': '验收策略更新',
          'tool.started': '工具调用开始', 'tool.completed': '工具调用完成', 'usage.updated': '用量更新',
        };
        const rows = deps.db.prepare(
          `SELECT e.event_id, e.seq, e.kind, e.created_at, e.project_id, c.id AS conversation_id, COALESCE(e.thread_id, task.conversation_thread_id) AS thread_id, e.task_id, e.payload_json,
                  p.display_name AS project_name, c.kind AS conversation_kind
           FROM domain_events e
           LEFT JOIN projects p ON p.id = e.project_id
           LEFT JOIN tasks task ON task.id = e.task_id
           LEFT JOIN conversation_threads th ON th.id = e.thread_id
           LEFT JOIN conversations c ON c.id = COALESCE(task.conversation_id, th.conversation_id, e.conversation_id)
           WHERE e.project_id IN (${projectIds.map(() => '?').join(',')})
             AND (task.id IS NULL OR task.project_id = e.project_id)
             AND (c.id IS NULL OR c.project_id = e.project_id)
             AND (c.id IS NULL OR c.kind != 'dm' OR EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.conversation_id = c.id AND dp.principal_type = 'human' AND dp.principal_id = ?))
             ${params.before != null ? (params.beforeSeq != null ? 'AND (e.created_at < ? OR (e.created_at = ? AND e.seq < ?))' : 'AND e.created_at < ?') : ''}
           ORDER BY e.created_at DESC, e.seq DESC LIMIT ?`,
        ).all(...projectIds, deps.localUserId, ...(params.before != null ? (params.beforeSeq != null ? [params.before, params.before, params.beforeSeq] : [params.before]) : []), params.limit) as Array<{ event_id: string; seq: number; kind: string; created_at: number; project_id: string; conversation_id: string | null; thread_id: string | null; task_id: string | null; payload_json: string | null; project_name: string | null; conversation_kind: string | null }>;
        const items = rows.map((e) => {
          let summary = '';
          try {
            const payload = JSON.parse(e.payload_json ?? '{}') as Record<string, unknown>;
            const text = (payload.note ?? payload.reason ?? payload.status ?? payload.disposition ?? '') as string;
            summary = String(text).slice(0, 80);
          } catch { /* 残缺不虚构 */ }
          return {
            eventId: e.event_id, seq: e.seq, kind: e.kind, kindLabel: KIND_LABEL[e.kind] ?? e.kind, at: e.created_at, summary,
            projectId: e.project_id, projectName: e.project_name ?? e.project_id,
            conversationId: e.conversation_id, threadId: e.thread_id, taskId: e.task_id,
            locate: e.task_id != null ? `#task=${e.task_id}` : e.conversation_id != null ? (e.conversation_kind === 'dm' ? `#dm=${e.conversation_id}` : `#conv=${e.conversation_id}`) : null,
          };
        });
        return withCommandId({ ok: true, data: { items, note: 'Activity 流（只读——domain_events 聚合；DM 事件仅本人参与可见）' } });
      }
      case 'project.files.list': {
        // R64 原型还原（最小安全只读投影）：目录树懒装载——列出项目内某目录的直接子项
        //（名称/类型/大小/mtime）。同 project.file.read 的边界纪律：resolve 越界拒、realpath
        // 链接越界拒；不读文件内容、不进模型输入、不建 artifact。每目录最多 500 项（truncated
        // 如实标注）——排序目录在前、名称序，供树形 UI 直接呈现。
        const params = z.strictObject({ projectId: z.string().min(1), path: z.string().max(500).optional() }).parse(env.params);
        const proj = deps.db.prepare('SELECT id, canonical_path FROM projects WHERE id = ?').get(params.projectId) as { id: string; canonical_path: string } | undefined;
        if (proj == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目不存在：${params.projectId}`);
        const root = resolve(proj.canonical_path);
        const rel = (params.path ?? '').replace(/^[/\\]+/, '');
        const target = resolve(root, rel);
        const rootSep = root.includes('/') ? '/' : '\\';
        if (target !== root && !target.startsWith(root + rootSep)) {
          throw new DaemonCommandError('FORBIDDEN', `目录路径越界：${params.path ?? ''}——拒绝读取`);
        }
        let realTarget: string;
        let realRoot: string;
        try {
          realTarget = realpathSync(target);
          realRoot = realpathSync(root);
        } catch {
          throw new DaemonCommandError('RESOURCE_NOT_FOUND', `目录不存在或不可读：${params.path ?? '.'}`);
        }
        if (realTarget !== realRoot && !realTarget.startsWith(realRoot + rootSep)) {
          throw new DaemonCommandError('FORBIDDEN', '目录路径含链接越界（realpath 实身份拒绝）');
        }
        let dirents: import('node:fs').Dirent[];
        try {
          dirents = readdirSync(realTarget, { withFileTypes: true });
        } catch {
          throw new DaemonCommandError('RESOURCE_NOT_FOUND', `目录列举失败：${params.path ?? '.'}`);
        }
        const MAX_ENTRIES = 500;
        const sorted = dirents
          .filter((d) => d.name !== '.' && d.name !== '..')
          .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name, 'zh-CN') : a.isDirectory() ? -1 : 1));
        const truncated = sorted.length > MAX_ENTRIES;
        const entries = sorted.slice(0, MAX_ENTRIES).map((d) => {
          let sizeBytes: number | null = null;
          let modifiedAt: number | null = null;
          if (!d.isDirectory()) {
            try {
              const st = statSync(resolve(realTarget, d.name));
              sizeBytes = st.size;
              modifiedAt = st.mtimeMs;
            } catch { /* 单项 stat 失败=未知（null），不影响整目录列举 */
            }
          }
          return { name: d.name, kind: d.isDirectory() ? 'dir' as const : 'file' as const, sizeBytes, modifiedAt };
        });
        return withCommandId({ ok: true, data: { path: rel, entries, truncated } });
      }
      case 'project.file.read': {
        // 共享预览（第三十轮四）：项目文件**只读快照**（来源=用户项目目录——非托管副本）：
        // 路径限项目根内（resolve 边界+realpath 实身份——越界/链接拒）、≤256KB、文本白名单
        // 扩展、fatal UTF-8（二进制拒绝）。不进模型输入、不建 artifact——预览与复制引用专用。
        const params = z.strictObject({ projectId: z.string().min(1), path: z.string().min(1).max(500) }).parse(env.params);
        const proj = deps.db.prepare('SELECT id, canonical_path FROM projects WHERE id = ?').get(params.projectId) as { id: string; canonical_path: string } | undefined;
        if (proj == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目不存在：${params.projectId}`);
        const root = resolve(proj.canonical_path);
        const target = resolve(root, params.path.replace(/^[/\\]+/, ''));
        const rootSep = root.includes('/') ? '/' : '\\';
        if (target !== root && !target.startsWith(root + rootSep)) {
          throw new DaemonCommandError('FORBIDDEN', `项目文件路径越界：${params.path}——拒绝读取`);
        }
        let realTarget: string;
        let realRoot: string;
        try {
          realTarget = realpathSync(target);
          realRoot = realpathSync(root);
        } catch {
          throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目文件不存在或不可读：${params.path}`);
        }
        if (realTarget !== realRoot && !realTarget.startsWith(realRoot + rootSep)) {
          throw new DaemonCommandError('FORBIDDEN', '项目文件路径含链接越界（realpath 实身份拒绝）');
        }
        const dot = realTarget.lastIndexOf('.');
        const ext = dot >= 0 ? realTarget.slice(dot).toLowerCase() : '';
        const textOk = [...(ATT_TEXT_KINDS as readonly string[]), 'text_file'].length >= 0 && (TEXT_PREVIEW_EXTENSIONS.has(ext));
        if (!textOk) throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', `该项目文件类型（${ext || '无扩展名'}）不在只读文本预览白名单——二进制/未知格式不执行不转码`);
        let raw: Buffer;
        try {
          const st = statSync(realTarget);
          if (st.size > ATT_MAX_BYTES) throw new DaemonCommandError('VALIDATION_INVALID', `项目文件 ${st.size}B 超只读预览上限 ${ATT_MAX_BYTES}B`);
          raw = readFileSync(realTarget);
        } catch (error) {
          if (error instanceof DaemonCommandError) throw error;
          throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目文件读取失败：${params.path}`);
        }
        let content: string;
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
        catch { throw new DaemonCommandError('VALIDATION_INVALID', '项目文件不是有效 UTF-8 文本——只读预览拒绝（二进制走 Git/系统工具）'); }
        const cut = truncateUtf8Bytes(content, ATT_EXCERPT_BYTES);
        return withCommandId({ ok: true, data: { projectId: proj.id, path: params.path, baseName: basename(realTarget), bytes: raw.length, truncated: cut.truncated, excerptBytes: cut.excerptBytes, content: cut.text, note: '项目文件只读快照（非托管副本——源文件后续变化不追溯；不进模型输入）' } });
      }
      case 'project.file.stat': {
        // R68 §6：工作区文件**轻量 stat**（脏检测通道）——路径安全链与 readFull 同源，只
        // 返回 mtime/bytes（不读内容）。预览面板低频轮询比对读取快照，磁盘变化→提示「磁盘
        // 已更新」（用户显式重载才换版本；旧引用仍绑原版本）。
        const params = z.strictObject({ projectId: z.string().min(1), path: z.string().min(1).max(500) }).parse(env.params);
        const st = resolveProjectTextStat(deps, params.projectId, params.path);
        return withCommandId({ ok: true, data: { projectId: params.projectId, path: params.path, ...st } });
      }
      case 'project.file.readFull': {
        // R67 P1-A/P2-B（R69 §A 扩展二进制）：工作区**完整文件读取**（屏幕阅读通道）——
        // 文本类（白名单）解码全文（R69 起 decodeTextBytes：BOM/UTF-16/GB18030 与上传同一
        // 检测链，不再一律 fatal-UTF-8 拒）；二进制阅读类（图片/PDF/Office——与上传/预览
        // 同类型面）返回原字节快照（不建 artifact、不进模型输入）。includeBytes 时文本类也
        // 带原字节（保存原件=读取时快照）。路径安全链（resolve 边界+realpath 实身份+类型
        // 白名单+按类大小上限）不变。
        const params = z.strictObject({ projectId: z.string().min(1), path: z.string().min(1).max(500), includeBytes: z.boolean().optional() }).parse(env.params);
        const safe = resolveProjectPreviewFile(deps, params.projectId, params.path);
        if (safe.isBinary) {
          return withCommandId({ ok: true, data: {
            projectId: safe.projectId, path: params.path, baseName: safe.baseName, bytes: safe.raw.length, sha256: safe.sha256,
            content: null, binaryKind: safe.binaryKind, truncated: false, mtimeMs: safe.mtimeMs, bytesBase64: safe.raw.toString('base64'),
            note: '工作区二进制只读快照（本地渲染；不进模型输入）',
          } });
        }
        const dec = decodeTextBytes(safe.raw);
        if (!dec.ok) throw new DaemonCommandError('VALIDATION_INVALID', `项目文件${dec.error.message}——完整阅读拒绝（另存原件仍可用）`);
        return withCommandId({ ok: true, data: {
          projectId: safe.projectId, path: params.path, baseName: safe.baseName, bytes: safe.raw.length, sha256: safe.sha256,
          content: dec.text, encoding: dec.encoding, truncated: false, mtimeMs: safe.mtimeMs,
          ...(params.includeBytes === true ? { bytesBase64: safe.raw.toString('base64') } : {}),
          note: '完整文件只读快照（屏幕阅读全文；模型注入仍走 64KB 提取窗——分列）',
        } });
      }
      case 'project.file.originalFile': {
        // R67 P1-A（R69 扩展同 readFull 类型面）：工作区**原文件字节**（保存原件通道）——
        // 同一路径安全链+白名单+按类上限；返回原字节（不重编码：BOM/行尾保持）与实际
        // sha256。落盘由主进程「另存为」对话框完成；保存=读取时快照字节。
        const params = z.strictObject({ projectId: z.string().min(1), path: z.string().min(1).max(500) }).parse(env.params);
        const safe = resolveProjectPreviewFile(deps, params.projectId, params.path);
        return withCommandId({ ok: true, data: {
          projectId: safe.projectId, path: params.path, filename: safe.baseName, bytes: safe.raw.length, sha256: safe.sha256,
          bytesBase64: safe.raw.toString('base64'), mtimeMs: safe.mtimeMs,
          note: '工作区原文件字节（读取快照；非托管副本）',
        } });
      }
      case 'export.create': {
        // 导出（第三十轮五；第三十一轮一完整性收口）：
        // - 归属先于回执：目标会话+线程真实归属（threadId 必须属于声明的 conversation/project——
        //   「合法会话 A+其他会话线程 B」整笔拒绝零产物）与 audience 校验在回执预查**之前**
        //   （重放同样过当前权限——旧回执不绕过权限变化）；
        // - 快照在事务内核取（消息+附件一次固定）；附件逐项核对源会话（exportWriter）；
        // - 拷贝走受控校验（readVerifiedBlob：实根/实身份/实际字节 sha256——blobRoot 参与）；
        //   拷贝后事务复核归属/audience/引用版本（artifact id+revision+hash 不变——迟到变化
        //   整笔失败清理，防以旧版本冒充新资源导出）；manifest 与最终 assets 字节一致；
        // - 预算超限明确失败（提示收窄范围）不静默缩小；重活异步逐件让出不堵 daemon。
        const params = z.strictObject({
          target: z.discriminatedUnion('kind', [
            z.strictObject({ kind: z.literal('conversation'), projectId: z.string().min(1), conversationId: z.string().min(1) }),
            z.strictObject({ kind: z.literal('thread'), projectId: z.string().min(1), conversationId: z.string().min(1), threadId: z.string().min(1) }),
          ]),
          format: z.enum(['md', 'html', 'docx']),
        }).parse(env.params);
        // ① 归属+audience（先于回执——重放也过当前权限）。
        const conv = deps.db.prepare('SELECT id, project_id, kind, room_id, archived_at FROM conversations WHERE id = ?').get(params.target.conversationId) as { id: string; project_id: string; kind: string; room_id: string | null; archived_at: number | null } | undefined;
        if (conv == null || conv.project_id !== params.target.projectId) throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '导出目标会话不存在或不属于该项目');
        if (params.target.kind === 'thread') {
          const th = deps.db.prepare('SELECT id, conversation_id, project_id FROM conversation_threads WHERE id = ?').get(params.target.threadId) as { id: string; conversation_id: string; project_id: string } | undefined;
          if (th == null || th.conversation_id !== conv.id || th.project_id !== params.target.projectId) {
            throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', `导出目标线程不存在或不属于声明的会话/项目（threadId=${params.target.threadId.slice(0, 12)}…）——整笔拒绝`);
          }
        }
        assertConversationAudience(deps.db, deps.localUserId, conv.id); // audience 逐项（DM=本人参与）
        // ② 回执预查（归属/权限已核——同号同参原结果、同号异参冲突）。
        const priorReceipt = getReceipt(deps.db, scope, env.commandId);
        if (priorReceipt != null) {
          if (priorReceipt.payload_hash !== payloadHash) throw new DaemonCommandError('IDEMPOTENCY_CONFLICT', '同 commandId 携带不同参数——幂等键冲突拒绝');
          if (priorReceipt.result_json == null) throw new DaemonCommandError('RESULT_EXPIRED', '回执正文已按清理策略删除：用新 commandId 重新提交');
          return withCommandId({ ok: true, data: JSON.parse(priorReceipt.result_json), replayed: true });
        }
        const blobRoot = join(deps.appDataDir ?? process.env.ZS_APP_DATA ?? process.cwd(), 'blobstore');
        const exportId = `exp_${randomUUID().slice(0, 12)}`;
        const exportDir = join(deps.appDataDir ?? process.env.ZS_APP_DATA ?? process.cwd(), 'exports', exportId);
        // ③ 快照事务内核：归属复检+消息/附件一次固定（读侧一致视图）。
        const snapshot = deps.db.transaction(() => {
          const c2 = deps.db.prepare('SELECT id, project_id FROM conversations WHERE id = ?').get(conv.id) as { id: string; project_id: string } | undefined;
          if (c2 == null || c2.project_id !== params.target.projectId) throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '导出目标会话已不存在或归属变化——整笔拒绝');
          if (params.target.kind === 'thread') {
            const t2 = deps.db.prepare('SELECT conversation_id, project_id FROM conversation_threads WHERE id = ?').get(params.target.threadId) as { conversation_id: string; project_id: string } | undefined;
            if (t2 == null || t2.conversation_id !== conv.id || t2.project_id !== params.target.projectId) throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '导出目标线程归属变化——整笔拒绝');
          }
          assertConversationAudience(deps.db, deps.localUserId, conv.id);
          const messages = (params.target.kind === 'thread'
            ? deps.db.prepare('SELECT id, conversation_id, thread_id, thread_message_seq, author_type, author_id, body_json, created_at FROM messages WHERE thread_id = ? AND conversation_id = ? ORDER BY thread_message_seq').all(params.target.threadId, conv.id)
            : deps.db.prepare('SELECT id, conversation_id, thread_id, thread_message_seq, author_type, author_id, body_json, created_at FROM messages WHERE conversation_id = ? ORDER BY conversation_seq').all(conv.id)) as Array<{ id: string; conversation_id: string; thread_id: string | null; thread_message_seq: number | null; author_type: string; author_id: string; body_json: string; created_at: number }>;
          const msgIds = messages.map((m) => m.id);
          const attachments = msgIds.length === 0 ? [] : (deps.db.prepare(
            `SELECT ma.message_id, ma.display_name, a.id AS artifact_id, a.kind, a.hash, a.revision, a.blob_path, a.source_name, a.conversation_id
             FROM message_attachments ma JOIN artifacts a ON a.id = ma.artifact_id
             WHERE ma.message_id IN (${msgIds.map(() => '?').join(',')}) ORDER BY ma.rowid`,
          ).all(...msgIds) as Array<{ message_id: string; display_name: string | null; artifact_id: string; kind: string; hash: string; revision: number; blob_path: string; source_name: string | null; conversation_id: string }>);
          return { messages, attachments };
        })();
        try {
          const outcome = await writeExport({ conv, target: params.target, messages: snapshot.messages, attachments: snapshot.attachments, format: params.format, exportDir, blobRoot });
          // 测试注入口（第三十一轮一：拷贝后/复核前窗口——模拟「复制期间引用版本变化」；
          // 生产不设）。
          const hook = (globalThis as { __zsTestExportHook?: () => void | Promise<void> }).__zsTestExportHook;
          if (hook != null) await hook();
          // ④ 拷贝后复核事务：归属/audience/引用版本（id+revision+hash）不变才落回执——
          // 导出期间归档/资源变化=整笔失败清理（不留成功 artifact/半截导出/错误关联）。
          const verify = deps.db.transaction((): { exportId: string; dir: string; files: string[]; stats: { messages: number; attachments: number; missing: number }; manifest: unknown } => {
            const c3 = deps.db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(conv.id) as { project_id: string } | undefined;
            if (c3 == null || c3.project_id !== params.target.projectId) throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '导出完成时会话归属已变化——整笔拒绝（不留半截导出）');
            assertConversationAudience(deps.db, deps.localUserId, conv.id);
            for (const f of outcome.manifest.files) {
              const row = deps.db.prepare('SELECT revision, hash FROM artifacts WHERE id = ?').get(f.artifactId) as { revision: number; hash: string } | undefined;
              if (row == null || row.revision !== f.revision || row.hash !== f.sha256) {
                throw new DaemonCommandError('EXPORT_CONFLICT', `导出期间附件引用版本变化（${f.sourceName ?? f.artifactId}：现 v${row?.revision ?? '?'} ≠ 快照 v${f.revision}）——整笔拒绝（半截产物已清理）`);
              }
            }
            return { exportId, dir: exportDir, files: outcome.files, stats: outcome.stats, manifest: outcome.manifest };
          });
          const data = verify();
          const receipt = run(() => data); // 回执落库（重放幂等——不重复生成新目录）
          return withCommandId({ ok: true, data: receipt.data, replayed: receipt.replayed });
        } catch (error) {
          // 失败清理半截产物（不留半个导出目录）。
          try { rmSync(exportDir, { recursive: true, force: true }); } catch { /* 尽力 */ }
          if (error instanceof ExportWriterError) throw new DaemonCommandError(error.code, error.message);
          if (error instanceof DaemonCommandError) throw error;
          throw new DaemonCommandError('STORAGE_UNAVAILABLE', `导出失败（已清理半截产物）：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      case 'thread.collaborators': {
        // DEV-19 协作视图首包（第二十六轮四）：四列分列——人的关注（thread_subscriptions）/        // Agent 跟进名单（thread_agent_followers）/冻结参与者（route_json.frozenMemberIds）/
        // 实时执行（run_participants）。纯读零运行。
        const params = z.strictObject({ threadId: z.string().min(1) }).parse(env.params);
        const thread = deps.db.prepare('SELECT conversation_id, project_id FROM conversation_threads WHERE id = ?').get(params.threadId) as { conversation_id: string; project_id: string } | undefined;
        if (thread == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `线程不存在：${params.threadId}`);
        assertConversationAudience(deps.db, deps.localUserId, thread.conversation_id);
        const humanFollowers = (deps.db.prepare('SELECT count(*) c FROM thread_subscriptions WHERE thread_id = ? AND followed = 1').get(params.threadId) as { c: number }).c;
        const agentFollowers = (deps.db.prepare('SELECT member_id, status FROM thread_agent_followers WHERE thread_id = ? ORDER BY member_id').all(params.threadId) as Array<{ member_id: string; status: string }>).map((r) => ({ memberId: r.member_id, status: r.status }));
        const task = deps.db.prepare('SELECT id, route_json FROM tasks WHERE conversation_thread_id = ? ORDER BY rowid DESC LIMIT 1').get(params.threadId) as { id: string; route_json: string | null } | undefined;
        let frozenParticipants: string[] = [];
        if (task?.route_json != null) {
          try { const route = JSON.parse(task.route_json) as { frozenMemberIds?: string[] }; if (Array.isArray(route.frozenMemberIds)) frozenParticipants = route.frozenMemberIds; } catch { /* 损坏如实空列 */ }
        }
        const activeRun = task != null
          ? (() => {
            const run = deps.db.prepare("SELECT id, status FROM workflow_runs WHERE task_id = ? AND status IN ('RUNNING','WAITING') ORDER BY rowid DESC LIMIT 1").get(task.id) as { id: string; status: string } | undefined;
            if (run == null) return null;
            const participants = (deps.db.prepare('SELECT member_id, role, status FROM run_participants WHERE run_id = ? ORDER BY role, member_id').all(run.id) as Array<{ member_id: string; role: string; status: string }>).map((r) => ({ memberId: r.member_id, role: r.role, status: r.status }));
            return { runId: run.id, participants };
          })()
          : null;
        return withCommandId({ ok: true, data: { humanFollowers, agentFollowers, frozenParticipants, activeRun } });
      }
      case 'mine.pending': {
        // DEV-18 首包：待我处理=权威业务状态汇总（纯读——零新增运行/零预算）。覆盖全部项目
        // 行（正式链无隐藏位——"含隐藏项目"=全部 projects）。逐项：
        // - 待验收任务（tasks.status='REVIEW'，按任务逐条——同一会话多任务不因 conversation
        //   级 LIMIT1 漏项），每条绑定当前交付（pending 优先，其次最新行）：
        //   deliveryId/revision/manifestHash（验收按此核对——旧交付不能批准新版）；
        // - DM 未读（agent 消息且 conversation_seq > last_read_seq 的条数+最新序）。
        const projects = deps.db.prepare('SELECT id, display_name FROM projects ORDER BY rowid').all() as Array<{ id: string; display_name: string }>;
        const out = projects.map((p) => {
          // audience（第二十三轮三）：REVIEW 任务按其实际会话过滤——他人 DM 的任务/标题/版本
          // 一律不出现在汇总（不因聚合形态泄露；房间任务=项目内可见）。无 pending 交付的
          // REVIEW 任务 delivery 如实 null+actionable=false（已处理/被替代交付不因聚合成为
          // 可批准对象——验收入口据此拒绝并显示诊断，不假装正常待验收）。
          const reviewTasks = (deps.db.prepare(
            `SELECT t.id AS task_id, t.kind AS task_kind, t.title, t.conversation_id, c.kind AS conversation_kind, t.status,
                    d.id AS delivery_id, d.revision, d.manifest_hash
             FROM tasks t
             JOIN conversations c ON c.id = t.conversation_id
             LEFT JOIN task_deliveries d ON d.task_id = t.id AND d.review_status = 'pending'
             WHERE t.project_id = ? AND t.status = 'REVIEW'
               AND (c.kind != 'dm' OR EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.conversation_id = c.id AND dp.principal_type = 'human' AND dp.principal_id = ?))
             ORDER BY t.rowid`,
          ).all(p.id, deps.localUserId) as Array<{ task_id: string; task_kind: string; title: string; conversation_id: string | null; conversation_kind: string; status: string; delivery_id: string | null; revision: number | null; manifest_hash: string | null }>)
            .map((r) => ({ ...r, actionable: r.delivery_id != null }));
          const dmUnread = (deps.db.prepare(
            `SELECT c.id AS conversation_id, c.title,
                    (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.author_type = 'agent' AND m.conversation_seq > COALESCE((SELECT s.last_read_seq FROM conversation_read_states s WHERE s.conversation_id = c.id AND s.viewer_id = ?), 0)) AS unread,
                    (SELECT max(m2.conversation_seq) FROM messages m2 WHERE m2.conversation_id = c.id AND m2.author_type = 'agent') AS last_agent_seq
             FROM conversations c
             WHERE c.project_id = ? AND c.kind = 'dm' AND c.archived_at IS NULL
               AND EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.conversation_id = c.id AND dp.principal_type = 'human' AND dp.principal_id = ?)`,
          ).all(deps.localUserId, p.id, deps.localUserId) as Array<{ conversation_id: string; title: string | null; unread: number; last_agent_seq: number | null }>).filter((r) => r.unread > 0);
          // 线程未读（第二十三轮一）：主池聚合数据面——每线程 agent 回复 thread_message_seq >
          // 水位的条数（打开房间≠读完线程；读线程 A 不影响 B）。静音线程排除（第二十五轮四）。
          const threadUnread = (deps.db.prepare(
            `SELECT t.id AS thread_id,
                    (SELECT count(*) FROM messages m WHERE m.thread_id = t.id AND m.author_type = 'agent' AND m.thread_message_seq > COALESCE((SELECT s.last_read_message_seq FROM thread_read_states s WHERE s.thread_id = t.id AND s.viewer_id = ?), 0)) AS unread
             FROM conversation_threads t
             JOIN conversations c ON c.id = t.conversation_id
             WHERE t.project_id = ? AND c.kind = 'room'
               AND NOT EXISTS (SELECT 1 FROM thread_subscriptions sub WHERE sub.thread_id = t.id AND sub.viewer_id = ? AND sub.muted = 1)`,
          ).all(deps.localUserId, p.id, deps.localUserId) as Array<{ thread_id: string; unread: number }>).filter((r) => r.unread > 0);
          // 关注线程（第二十五轮四）：人的阅读订阅（与 Agent 执行名单分列）——有未读时进
          // 待我处理（muted 的关注仍排除未读——静音优先）。
          const followedThreads = (deps.db.prepare(
            `SELECT sub.thread_id, t.root_task_id, t.anchor_message_id,
                    (SELECT count(*) FROM messages m WHERE m.thread_id = t.id AND m.author_type = 'agent' AND m.thread_message_seq > COALESCE((SELECT s.last_read_message_seq FROM thread_read_states s WHERE s.thread_id = t.id AND s.viewer_id = ?), 0)) AS unread
             FROM thread_subscriptions sub
             JOIN conversation_threads t ON t.id = sub.thread_id
             JOIN conversations c ON c.id = t.conversation_id
             WHERE sub.viewer_id = ? AND sub.followed = 1 AND sub.muted = 0 AND c.project_id = ? AND c.kind = 'room'`,
          ).all(deps.localUserId, deps.localUserId, p.id) as Array<{ thread_id: string; root_task_id: string | null; anchor_message_id: string; unread: number }>).filter((r) => r.unread > 0);
          // 阻塞任务（第二十三轮三：如实列出——可见≠审批：不并入待验收，处理入口=线程本身；
          // 不把所有 BLOCKED 都当人工审批，授权请求（WAITING_APPROVAL）等其余未覆盖项见
          // continuation 登记范围）。
          const blockedTasks = (deps.db.prepare(
            `SELECT t.id AS task_id, t.kind AS task_kind, t.title, t.conversation_id, c.kind AS conversation_kind
             FROM tasks t JOIN conversations c ON c.id = t.conversation_id
             WHERE t.project_id = ? AND t.status = 'BLOCKED'
               AND (c.kind != 'dm' OR EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.conversation_id = c.id AND dp.principal_type = 'human' AND dp.principal_id = ?))
             ORDER BY t.rowid`,
          ).all(p.id, deps.localUserId) as Array<{ task_id: string; task_kind: string; title: string; conversation_id: string | null; conversation_kind: string }>)
            .map((b) => ({ ...b, reason: taskStatusReasonOf(deps.db, b.task_id) }));
          // 待确认提醒触发（REM-8）：确认入口由此可达；他人 DM 不泄露。locate（第二十六轮二）：
          // 服务端按目标实际形态构造准确深链——DM=#dm=；房间任务串=#task=；讨论串=#msg=锚。
          // notifyMuted=目标**线程**静音（提醒通知过滤——不能用未读聚合过滤代替；待办保留仅禁通知）。
          const reminderAwaitsRaw = (deps.db.prepare(
            `SELECT ro.reminder_id, ro.scheduled_at, ro.missed_count, r.title, r.conversation_id, r.thread_id, r.task_id, c.kind AS conversation_kind,
                    (SELECT t.root_task_id FROM conversation_threads t WHERE t.id = r.thread_id) AS root_task_id,
                    (SELECT t.anchor_message_id FROM conversation_threads t WHERE t.id = r.thread_id) AS anchor_message_id,
                    EXISTS(SELECT 1 FROM thread_subscriptions sub WHERE sub.thread_id = r.thread_id AND sub.viewer_id = ? AND sub.muted = 1) AS notify_muted
             FROM reminder_occurrences ro
             JOIN reminders r ON r.id = ro.reminder_id
             JOIN conversations c ON c.id = r.conversation_id
             WHERE c.project_id = ? AND ro.status = 'fired' AND ro.outcome = 'awaiting_confirmation'
               AND (c.kind != 'dm' OR EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.conversation_id = c.id AND dp.principal_type = 'human' AND dp.principal_id = ?))
             ORDER BY ro.scheduled_at`,
          ).all(deps.localUserId, p.id, deps.localUserId) as Array<{ reminder_id: string; scheduled_at: number; missed_count: number; title: string | null; conversation_id: string; thread_id: string | null; task_id: string | null; conversation_kind: string; root_task_id: string | null; anchor_message_id: string | null; notify_muted: number }>);
          const reminderAwaits = reminderAwaitsRaw.map((row) => ({
            reminderId: row.reminder_id, scheduledAt: row.scheduled_at, missedCount: row.missed_count, title: row.title,
            conversationId: row.conversation_id,
            locate: row.conversation_kind === 'dm'
              ? `#dm=${row.conversation_id}`
              : (row.task_id ?? row.root_task_id) != null ? `#task=${row.task_id ?? row.root_task_id}` : `#msg=${row.anchor_message_id}`,
            notifyMuted: row.notify_muted === 1, // 点击定位不受影响——仅系统通知禁发
          }));
          return { projectId: p.id, displayName: p.display_name, reviewTasks, dmUnread, threadUnread, blockedTasks, reminderAwaits, followedThreads };
        }).filter((p) => p.reviewTasks.length > 0 || p.dmUnread.length > 0 || p.threadUnread.length > 0 || p.blockedTasks.length > 0 || p.reminderAwaits.length > 0 || p.followedThreads.length > 0);
        return withCommandId({ ok: true, data: { projects: out, generatedAt: Date.now() } });
      }
      case 'deepLink.resolve': {
        // DEV-18 首包：深链按实体真实归属定位（纯读——零新增运行/零预算）。失效/无权限/归属
        // 矛盾明确报错（不静默跳转）。支持：#dm=/#task=/#delivery=/#msg=。
        const params = z.strictObject({ hash: z.string().min(1).max(200) }).parse(env.params);
        const m = /^#(dm|task|delivery|msg)=([A-Za-z0-9_:-]+)$/.exec(params.hash.trim());
        if (m == null) throw new DaemonCommandError('VALIDATION_INVALID', `深链格式无效：${params.hash.slice(0, 60)}`);
        const kind = m[1] as 'dm' | 'task' | 'delivery' | 'msg';
        const id = m[2] as string;
        const convOf = (conversationId: string): { projectId: string; kind: string } => {
          const row = deps.db.prepare('SELECT project_id, kind FROM conversations WHERE id = ?').get(conversationId) as { project_id: string; kind: string } | undefined;
          if (row == null) throw new DaemonCommandError('NOT_FOUND', `会话不存在或已删除：${conversationId}`);
          return { projectId: row.project_id, kind: row.kind };
        };
        if (kind === 'dm') {
          const conv0 = convOf(id);
          if (conv0.kind !== 'dm') throw new DaemonCommandError('LINK_TARGET_MISMATCH', `#${kind}=${id} 指向非私信会话（kind=${conv0.kind}）——深链与实体归属矛盾`);
          const conv = assertConversationAudience(deps.db, deps.localUserId, id);
          return withCommandId({ ok: true, data: { kind: 'dm', projectId: conv.projectId, conversationId: id, rootPath: rootPathOf(deps.db, conv.projectId) } });
        }
        if (kind === 'task') {
          const row = deps.db.prepare('SELECT id, project_id, conversation_id, conversation_thread_id FROM tasks WHERE id = ?').get(id) as { id: string; project_id: string; conversation_id: string; conversation_thread_id: string | null } | undefined;
          if (row == null) throw new DaemonCommandError('NOT_FOUND', `任务不存在或已删除：${id}`);
          const conv = assertConversationAudience(deps.db, deps.localUserId, row.conversation_id); // 任务经会话核 audience——链接形态不绕过私信限制
          return withCommandId({ ok: true, data: { kind: 'task', projectId: conv.projectId, conversationId: row.conversation_id, threadId: row.conversation_thread_id, taskId: row.id, rootPath: rootPathOf(deps.db, conv.projectId) } });
        }
        if (kind === 'delivery') {
          // 第五十二轮（review-r51 §3.1）：SELECT 补 t.conversation_thread_id——交付深链此前缺
          // threadId，前端把房间任务交付错误落到 /dm/<房间会话>（空私信页）。归属按真实线程返回。
          const row = deps.db.prepare(
            'SELECT d.id, d.revision, d.manifest_hash, t.id AS task_id, t.project_id, t.conversation_id, t.conversation_thread_id FROM task_deliveries d JOIN tasks t ON t.id = d.task_id WHERE d.id = ?',
          ).get(id) as { id: string; revision: number; manifest_hash: string; task_id: string; project_id: string; conversation_id: string; conversation_thread_id: string | null } | undefined;
          if (row == null) throw new DaemonCommandError('NOT_FOUND', `交付不存在或已删除：${id}`);
          const conv = assertConversationAudience(deps.db, deps.localUserId, row.conversation_id); // 交付经会话核 audience
          return withCommandId({ ok: true, data: { kind: 'delivery', projectId: conv.projectId, conversationId: row.conversation_id, threadId: row.conversation_thread_id, taskId: row.task_id, deliveryId: row.id, revision: row.revision, manifestHash: row.manifest_hash, rootPath: rootPathOf(deps.db, conv.projectId) } });
        }
        const msgRow = deps.db.prepare('SELECT id, conversation_id, conversation_seq, thread_id FROM messages WHERE id = ?').get(id) as { id: string; conversation_id: string; conversation_seq: number; thread_id: string | null } | undefined;
        if (msgRow == null) throw new DaemonCommandError('NOT_FOUND', `消息不存在或已删除：${id}`);
        const conv = assertConversationAudience(deps.db, deps.localUserId, msgRow.conversation_id); // 消息经会话核 audience（含线程归属消息）
        return withCommandId({ ok: true, data: { kind: 'msg', projectId: conv.projectId, conversationId: msgRow.conversation_id, threadId: msgRow.thread_id, messageId: msgRow.id, messageSeq: msgRow.conversation_seq, rootPath: rootPathOf(deps.db, conv.projectId) } });
      }
      case 'conversation.rename': {
        const params = z.strictObject({ conversationId: z.string().min(1), title: z.string().min(1).max(120), expectedRevision: z.number().int().min(0) }).parse(env.params);
        const conv = dmConversationOf(deps.db, params.conversationId);
        if (conv == null || conv.kind !== 'dm') throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '会话不存在或非私信');
        if (conv.revision !== params.expectedRevision) throw new DaemonCommandError('REVISION_CONFLICT', `期望 revision=${params.expectedRevision}，当前=${conv.revision}`);
        deps.db.prepare('UPDATE conversations SET title = ?, revision = revision + 1 WHERE id = ?').run(params.title, params.conversationId);
        return withCommandId({ ok: true, data: { conversationId: params.conversationId, revision: params.expectedRevision + 1 } });
      }
      case 'conversation.archive': {
        // 归档（第十九轮六：对齐基线 §2.1）——顺序：禁止新发/新派发（archived_at 事务内置位+
        // 队列挂起）→ 活动运行按停止规则处理（requestStop 正式流程+协议中断）→ 历史只读。
        // 停止退出无法确认时保留明确状态（stopPending——不伪称已停）；重复归档幂等返回。
        const params = z.strictObject({ conversationId: z.string().min(1), expectedRevision: z.number().int().min(0) }).parse(env.params);
        const conv = dmConversationOf(deps.db, params.conversationId);
        if (conv == null || conv.kind !== 'dm') throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '会话不存在或非私信');
        if (conv.archived_at != null) {
          return withCommandId({ ok: true, data: { conversationId: params.conversationId, archived: true, already: true, stopPending: dmHasActiveRun(deps.db, params.conversationId) } });
        }
        if (conv.revision !== params.expectedRevision) throw new DaemonCommandError('REVISION_CONFLICT', `期望 revision=${params.expectedRevision}，当前=${conv.revision}`);
        const activeRuns = deps.db.prepare(
          `SELECT t.id AS taskId, t.stop_generation AS stopGen, r.id AS runId FROM workflow_runs r JOIN tasks t ON t.id = r.task_id
           WHERE t.conversation_id = ? AND t.kind = 'dm_turn' AND r.status IN ('RUNNING','WAITING','STOPPING')`,
        ).all(params.conversationId) as Array<{ taskId: string; stopGen: number; runId: string }>;
        const result = run(() => {
          deps.db.prepare('UPDATE conversations SET archived_at = ?, revision = revision + 1 WHERE id = ?').run(Date.now(), params.conversationId);
          holdDmPauseGate(deps.db, params.conversationId, '归档：队列暂停（恢复会话不自动续跑——继续由 dm.resume 显式控制）');
          return { conversationId: params.conversationId, revision: params.expectedRevision + 1, archived: true, already: false, stopPending: activeRuns.length > 0 };
        });
        // 归档后对活动运行逐个走正式停止流程（请求≠退出确认；无法确认时状态如实保留）。
        for (const active of activeRuns) {
          try {
            await requestStop(deps.db, {
              taskId: active.taskId, targetRunId: active.runId, expectedStopGeneration: active.stopGen,
              commandId: `${env.commandId}:stop:${active.runId}`, idempotencyScope: scope, payloadHash, now: Date.now(),
              interruptTurn: deps.interruptTurn,
            });
          } catch (stopError) {
            // 单个停止失败不回滚归档（已禁止新发/派发）；状态以 stopPending 如实呈现。
            void stopError;
          }
        }
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'conversation.restore': {
        const params = z.strictObject({ conversationId: z.string().min(1) }).parse(env.params);
        const conv = dmConversationOf(deps.db, params.conversationId);
        if (conv == null || conv.kind !== 'dm') throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '会话不存在或非私信');
        if (conv.archived_at == null) return withCommandId({ ok: true, data: { conversationId: params.conversationId, restored: false } });
        deps.db.prepare('UPDATE conversations SET archived_at = NULL, revision = revision + 1 WHERE id = ?').run(params.conversationId);
        // restore 不自动续跑（R4）：清除停止挂起但不泵队列——排队消息保持排队等待发送或显式继续。
        releaseDmPauseGate(deps.db, params.conversationId);
        return withCommandId({ ok: true, data: { conversationId: params.conversationId, restored: true } });
      }
      case 'dm.resume': {
        // 显式继续（R4：停止后队列 paused，需用户继续）：清挂起并泵一条排队消息。
        const params = z.strictObject({ conversationId: z.string().min(1) }).parse(env.params);
        const conv = dmConversationOf(deps.db, params.conversationId);
        if (conv == null || conv.kind !== 'dm') throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '会话不存在或非私信');
        if (conv.archived_at != null) throw new DaemonCommandError('CONVERSATION_ARCHIVED', '对话已归档：禁止续跑');
        releaseDmPauseGate(deps.db, params.conversationId);
        const pumped = pumpDmQueue(deps.db, params.conversationId);
        return withCommandId({ ok: true, data: { conversationId: params.conversationId, enqueued: pumped.enqueued } });
      }
      case 'realCalls.summary': {
        // 真实调用护栏台账查询（第十七轮四：startTurn 级实际请求边界——batchId/状态/归属分列；
        // fake 不产生行）。只读诊断面，不用于绕过防护。
        const params = z.strictObject({ batchId: z.string().min(1).max(100).optional() }).parse(env.params);
        const { realCallSummary } = await import('./realCallLedger.ts');
        return withCommandId({ ok: true, data: realCallSummary(deps.db, params.batchId) });
      }
      case 'app.health': {
        z.strictObject({}).parse(env.params);
        return withCommandId({ok:true,data:{ready:true,at:Date.now()}});
      }
      case 'app.diagnostics': {
        if(deps.remoteAudit)throw new DaemonCommandError('FORBIDDEN','本地诊断仅在本机可信入口读取');
        const p=z.strictObject({projectId:z.string().min(1).optional()}).parse(env.params);
        const {isDispatchGateHeld}=await import('../persistence/daemonState.ts');
        if(p.projectId&&!deps.db.prepare('SELECT 1 FROM projects WHERE id=?').get(p.projectId))throw new DaemonCommandError('RESOURCE_NOT_FOUND','项目不存在');
        const rows=p.projectId?deps.db.prepare('SELECT id FROM project_members WHERE project_id=? ORDER BY rowid LIMIT 21').all(p.projectId) as Array<{id:string}>:[];
        const context:ImageCapabilityReadContext=new Map();
        const runtime=rows.slice(0,20).map(row=>{const c=memberImageCapability(deps.db,row.id,context);let channel:string|null=null;try{channel=new URL(c.channel).host;}catch{/* uncertain channel */}return{memberId:createHash('sha256').update(row.id).digest('hex').slice(0,16),channel,kind:c.kind,model:c.model&&/^[a-zA-Z0-9._/-]{1,80}$/.test(c.model)&&!c.model.startsWith('sk-')?c.model:null,status:c.status,configuration:c.configuration,source:c.endpointSource?.includes('环境')?'进程环境':c.endpointSource?.includes('项目')?'项目配置':c.endpointSource?.includes('用户')?'用户配置':c.endpointSource?.includes('托管')?'托管配置':c.endpointSource==='官方默认'?'官方默认':'未提供',protocol:c.protocol,certification:c.evidence?'historical-match':'unverified',reason:c.evidence?'历史工程识图证据与当前组合匹配':c.status==='supported'?'自动图片输入；当前组合未提供匹配的历史识图证据，实际结果由本次请求判定':c.reason.includes('不匹配')?'有效配置与认证不匹配':c.reason.includes('超时')?'此前真实认证等待上游超时':c.reason.includes('不可读')||c.reason.includes('无法')?'有效配置不可确定':'此组合未认证',identityKey:c.identityKey};});
        const count=(sql:string)=>(deps.db.prepare(sql).get() as {n:number}).n;
        return withCommandId({ok:true,data:{at:Date.now(),service:'ready',runtime,truncated:rows.length>20,protection:{dispatchGateHeld:isDispatchGateHeld(deps.db),unknownTurns:count("SELECT count(*) n FROM agent_turns WHERE status='UNKNOWN'"),pendingDispatches:count("SELECT count(*) n FROM outbox WHERE status='pending'")}}});
      }
      case 'app.identity': {
        // r61（review-r60 §6）：稳定身份——renderer 草稿/未知信封持久化的命名空间用。
        // R67 P1-B：**dataRootId**（稳定逻辑数据根身份）={appData}/root-identity.json 首次懒建
        // （随目录复制原样带走）。R68 §3B：标记**已存在但无效**（JSON 损坏/id 字段不合法）时
        // **不覆写、不生成新随机 ID**——同一数据根静默换 ID 会让旧 v2 键永久失联。此时返回
        // rootIdentityHealth='invalid-marker'（原件逐字保全；renderer 退回绝对路径键并给出显式
        // 恢复指引），只有标记确实不存在才创建（temp+rename 原子落盘——崩溃中断不产生半个标记）。
        // appDataDir 不可用（内存库测试/浏览器宿主）→ dataRootId=null（renderer 回退旧形态）。
        let dataRootId: string | null = null;
        let rootIdentityHealth: 'ok' | 'invalid-marker' | 'unavailable' = 'ok';
        let rootIdentityProblem: string | null = null;
        const appData = deps.appDataDir;
        if (appData != null && appData.length > 0) {
          const marker = join(appData, 'root-identity.json');
          try {
            if (existsSync(marker)) {
              let parsed: unknown = null;
              try {
                parsed = JSON.parse(readFileSync(marker, 'utf8'));
              } catch (e) {
                rootIdentityProblem = `root-identity.json 不是合法 JSON（${e instanceof Error ? e.message : String(e)}）`;
              }
              const id = parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
                && typeof (parsed as { id?: unknown }).id === 'string' && ((parsed as { id: string }).id.length >= 8)
                ? (parsed as { id: string }).id : null;
              if (id != null) dataRootId = id;
              else {
                // 无效/未知格式标记：原件保全 + 如实健康状态（不覆写、不换 ID）。
                rootIdentityHealth = 'invalid-marker';
                rootIdentityProblem ??= 'root-identity.json 缺少合法 id 字段（期望 {"id":"dri_…"} 形状）';
              }
            } else {
              try {
                dataRootId = `dri_${randomUUID()}`;
                mkdirSync(appData, { recursive: true });
                const tmp = `${marker}.tmp-${process.pid}-${Date.now()}`;
                writeFileSync(tmp, JSON.stringify({ id: dataRootId, createdAt: Date.now() }, null, 2), 'utf8');
                renameSync(tmp, marker); // 原子落盘：崩溃中断不产生半个标记（tmp 残留不参与读取）
              } catch {
                dataRootId = null;
                rootIdentityHealth = 'unavailable';
                rootIdentityProblem = '数据根身份标记写入失败（目录拒写/权限）——本会话无稳定逻辑根身份；重启后会重试创建';
              }
            }
          } catch (e) {
            dataRootId = null;
            rootIdentityHealth = 'unavailable';
            rootIdentityProblem = `数据根身份标记不可读（${e instanceof Error ? e.message : String(e)}）`;
          }
        }
        return withCommandId({ ok: true, data: { localUserId: deps.localUserId, appDataDir: deps.appDataDir ?? '', dataRootId, rootIdentityHealth, rootIdentityProblem } });
      }
      case 'app.rootIdentityOf': {
        // R67 P1-B（继承身份校验，只读）：renderer 持久化命名空间迁移时，把候选旧目录清单
        // 交来核对——daemon 只读各目录 root-identity.json 的 id（无写入；目录缺失/无标记/
        // 损坏= null）。renderer 仅当旧键所属目录的逻辑 id == **当前**数据根 id 时才继承其
        // 快照：无关数据根/别的用户/任意目录不因发现旧键而混入（不盲扫合并）。
        // R68 §2：旧 v3/v4 目录**没有**标记（id=null）——这些候选不自动继承，转交用户在
        // 「设置 → 草稿存储」显式确认导入；hasStateDb（目录里是否有 state.sqlite）帮助用户
        // 核对这确实是自己的旧数据根（辅助信息，不构成信任证明——导入决定权在用户）。
        const params = z.strictObject({ appDataDirs: z.array(z.string().min(1).max(400)).min(1).max(16) }).parse(env.params);
        const ids: Record<string, string | null> = {};
        const hasStateDb: Record<string, boolean> = {};
        for (const dir of params.appDataDirs) {
          try {
            const rdir = resolve(dir);
            hasStateDb[dir] = existsSync(join(rdir, 'state.sqlite'));
            const marker = join(rdir, 'root-identity.json');
            if (!existsSync(marker)) { ids[dir] = null; continue; }
            const parsed = JSON.parse(readFileSync(marker, 'utf8')) as { id?: unknown };
            ids[dir] = typeof parsed.id === 'string' && parsed.id.length >= 8 ? parsed.id : null;
          } catch { ids[dir] = null; hasStateDb[dir] = false; }
        }
        return withCommandId({ ok: true, data: { ids, hasStateDb } });
      }
      case 'app.settings.get': {
        // 应用设置（第九轮）：daemon_state kv 白名单——持久化并跨重开生效；未知键拒绝。
        const params = z.strictObject({ keys: z.array(z.enum(['repoStatus.visible', 'ui.autoOpenProjectPath'])).min(1) }).parse(env.params);
        const values: Record<string, string | null> = {};
        for (const key of params.keys) {
          const row = deps.db.prepare('SELECT value FROM daemon_state WHERE key = ?').get(`app:setting:${key}`) as { value: string } | undefined;
          values[key] = row?.value ?? null;
        }
        return withCommandId({ ok: true, data: { values } });
      }
      case 'app.settings.set': {
        const params = z.strictObject({
          key: z.enum(['repoStatus.visible', 'ui.autoOpenProjectPath']),
          value: z.string().min(1).max(600),
        }).parse(env.params);
        const result = run(() => {
          const allowed: Record<string, string[]> = { 'repoStatus.visible': ['true', 'false'] };
          if (allowed[params.key] != null && !allowed[params.key]!.includes(params.value)) {
            throw new DaemonCommandError('VALIDATION_INVALID', `设置 ${params.key} 不接受值 ${params.value}（允许：${allowed[params.key]!.join('/')}）`);
          }
          deps.db.prepare('INSERT INTO daemon_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
            .run(`app:setting:${params.key}`, params.value, Date.now());
          return { key: params.key, value: params.value };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'task.review': {
        // RT-25 可选任务验收（第八轮）：按任务创建时的策略快照（review_policy=user_review
        // 才有 pending 交付）处理唯一待验收交付。accept→任务 DONE；changes_requested→任务
        // 回 ACTIVE（返工经 redispatch 正式链）。**Git 提交不等同验收**——本命令只写
        // review 账本与任务状态，不触碰 git/changeset。
        // 第九轮（验收绑定具体交付版本，防错稿）：提交须带 UI 展示时的 deliveryId+revision；
        // 事务内条件更新并核对影响行数——已被新版本替代/已处理/状态变化各返回明确冲突，
        // 不自动套用到新交付。同 commandId 重放=网关幂等原回执；不同 commandId 对已处理
        // 版本不再次生效（条件更新 0 行=冲突）。
        const params = z.strictObject({
          taskId: z.string().min(1),
          deliveryId: z.string().min(1),
          deliveryRevision: z.number().int().positive(),
          manifestHash: z.string().min(8), // 三重绑定（第二十三轮三）：id+revision+内容 hash——错稿防线最后一级
          decision: z.enum(['accept', 'changes_requested']),
          note: z.string().min(1).max(500).optional(),
        }).refine((p) => p.decision !== 'changes_requested' || (p.note != null && p.note.trim().length > 0), {
          message: '要求修改必须填写意见（§10.5-4：意见进入正式任务记录并注入返工输入）',
          path: ['note'],
        }).parse(env.params);
        const result = run(() => {
          const task = deps.db.prepare('SELECT id, status, review_policy, conversation_id FROM tasks WHERE id = ?').get(params.taskId) as { id: string; status: string; review_policy: string; conversation_id: string } | undefined;
          if (task == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `任务不存在：${params.taskId}`);
          // audience（第二十三轮三）：房间/DM/待办共用本命令——按任务实际会话核双成员
          //（与 deepLink 同一校验处，不因命令形态绕过私信限制）。
          assertConversationAudience(deps.db, deps.localUserId, task.conversation_id);
          if (task.review_policy !== 'user_review') {
            throw new DaemonCommandError('STALE_REVISION', `任务策略为 ${task.review_policy}（非 user_review）：无待验收交付——验收状态与创建时策略快照一致`);
          }
          const delivery = deps.db.prepare(
            'SELECT id, revision, manifest_hash, run_id, review_status FROM task_deliveries WHERE task_id = ? AND id = ?',
          ).get(params.taskId, params.deliveryId) as { id: string; revision: number; manifest_hash: string; run_id: string | null; review_status: string } | undefined;
          if (delivery == null) {
            throw new DaemonCommandError('RESOURCE_NOT_FOUND', `交付不存在或不属于该任务：${params.deliveryId}（验收不跨任务套用）`);
          }
          if (delivery.revision !== params.deliveryRevision) {
            throw new DaemonCommandError('STALE_REVISION', `交付版本不符：提交第 ${params.deliveryRevision} 版，记录为第 ${delivery.revision} 版——版本绑定校验失败`);
          }
          if (delivery.manifest_hash !== params.manifestHash) {
            throw new DaemonCommandError('STALE_REVISION', `交付内容不符：manifestHash 不匹配（提交 ${params.manifestHash.slice(0, 12)}，记录 ${delivery.manifest_hash.slice(0, 12)}）——同版本号不同内容不可验收`);
          }
          if (delivery.review_status === 'superseded') {
            const current = deps.db.prepare(`SELECT revision FROM task_deliveries WHERE task_id = ? AND review_status = 'pending' LIMIT 1`).get(params.taskId) as { revision: number } | undefined;
            throw new DaemonCommandError('STALE_REVISION', `第 ${delivery.revision} 版交付已被新交付替代（当前待验收为第 ${current?.revision ?? '?'} 版）——验收不自动套用到新交付`);
          }
          if (delivery.review_status !== 'pending') {
            throw new DaemonCommandError('STALE_REVISION', `第 ${delivery.revision} 版交付已处理（${delivery.review_status}）——不同命令号不重复生效`);
          }
          if (task.status !== 'REVIEW') {
            throw new DaemonCommandError('STALE_REVISION', `任务状态 ${task.status} 非 REVIEW：验收不适用于当前状态`);
          }
          const now = Date.now();
          const projectId = (deps.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(task.id) as { project_id: string }).project_id;
          const nextStatus = params.decision === 'accept' ? 'accepted' : 'changes_requested';
          const taskNext = params.decision === 'accept' ? 'DONE' : 'ACTIVE';
          const tx = deps.db.transaction(() => {
            const updated = deps.db.prepare(
              `UPDATE task_deliveries SET review_status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?
               WHERE id = ? AND task_id = ? AND revision = ? AND review_status = 'pending'`,
            ).run(nextStatus, deps.localUserId, now, params.note ?? null, delivery.id, params.taskId, delivery.revision);
            if (updated.changes !== 1) {
              throw new DaemonCommandError('STALE_REVISION', '条件更新未命中（交付状态在事务内已变化）——验收不生效，请刷新后重试');
            }
            const taskUpdated = deps.db.prepare(`UPDATE tasks SET status = ?, revision = revision + 1 WHERE id = ? AND status = 'REVIEW'`).run(taskNext, task.id);
            if (taskUpdated.changes !== 1) {
              throw new DaemonCommandError('STALE_REVISION', '任务状态在事务内已变化——验收不生效，请刷新后重试');
            }
            appendDomainEvent(deps.db, {
              schemaVersion: 1, eventId: `evt_${randomUUID()}`,
              projectId, taskId: task.id, runId: delivery.run_id ?? undefined,
              kind: 'task.reviewRecorded', createdAt: now,
              payload: {
                decision: params.decision, deliveryId: delivery.id, deliveryRevision: delivery.revision,
                reviewedBy: deps.localUserId, note: params.note ?? null,
                taskStatusAfter: taskNext,
                gitCommitIsNotReview: 'Git 提交不等同验收（RT-25）：本记录只承载人工验收事实',
                reworkNote: params.decision === 'changes_requested'
                  ? '返工反馈将注入后续派发输入（明确关联被退回的交付版本）'
                  : null,
              },
            });
          });
          tx();
          return { taskId: task.id, decision: params.decision, deliveryId: delivery.id, deliveryRevision: delivery.revision, reviewStatus: nextStatus, taskStatusAfter: params.decision === 'accept' ? 'DONE' : 'ACTIVE' };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'runtime.status': {
        // DEV-14（第八轮）：运行能力真实状态（只读、不 spawn 子进程）——成员绑定、静态
        // 能力矩阵关键项、本 daemon 的恢复取证/迟到回放能力与真实性标注。
        const installations = deps.db.prepare(
          'SELECT id, kind, executable FROM runtime_installations ORDER BY kind',
        ).all() as Array<{ id: string; kind: string; executable: string | null }>;
        const bindings = deps.db.prepare(
          `SELECT pm.id AS memberId, pm.display_name AS displayName, ri.kind AS kind, ap.settings_json AS settingsJson
           FROM project_members pm
           LEFT JOIN agent_profiles ap ON ap.id = pm.profile_id
           LEFT JOIN runtime_installations ri ON ri.id = ap.runtime_installation_id
           ORDER BY pm.id`,
        ).all() as Array<{ memberId: string; displayName: string; kind: string | null; settingsJson: string | null }>;
        const memberBindings = bindings.map((b) => {
          let model: string | null = null;
          try { model = b.settingsJson != null ? (JSON.parse(b.settingsJson) as { model?: string }).model ?? null : null; } catch { /* settings 解析失败=无模型 */ }
          return { memberId: b.memberId, displayName: b.displayName, kind: b.kind ?? '(默认 runtime)', model };
        });
        return withCommandId({ ok: true, data: {
          installations,
          memberBindings,
          dispatchGuard: {
            // r56（review-r55 §5）：演练/正式包的派发防护状态自述（只读）——自绘标题栏的
            // 「模拟/真实派发」标识取这里，不用系统原生标题文字替代可见标识。
            fakeAllowed: process.env.ZS_ALLOW_FAKE === '1',
            realDispatchGuard: process.env.ZS_REAL_DISPATCH_GUARD === '1',
            note: 'fakeAllowed=允许 fake adapter（演练/测试）；realDispatchGuard=真实派发防护开启（fake 环境下真实 startTurn 会被拒）',
          },
          capabilities: {
            claude: { keyAbilities: { structuredFinal: 'supported', restrictWrites: 'unverified', interactiveApprovals: 'unverified' }, adapterVersion: CLAUDE_ADAPTER_VERSION },
          },
          daemonRecovery: {
            processTreeEvidence: process.platform === 'win32' ? 'supported（全表 CIM+活跃期快照历史归属核对）' : 'unsupported（仅 win32——保护保留语义）',
            lateEventPump: 'fake 已验证（同 daemon+重启演练）；真实 CLI 会话文件回放待补证（adapter.lateEvents 未实现=如实 unsupported）',
            probeServerSideOnly: true,
          },
          note: '真实性口径：能力结论只适用于实测组合；未认证/未验证项如实标注（runtime-capability-matrix）',
        } });
      }
      case 'room.pool': {
        // 房间主池（修复轮 6）：room 限定的根消息+线程摘要——不用事件拼接、不混其他房间。
        const params = z.strictObject({ roomId: z.string().min(1), limit: z.number().int().min(1).max(100).optional() }).parse(env.params);
        const limit = params.limit ?? 50;
        const roomScope = deps.db.prepare("SELECT c.id AS conversation_id FROM rooms r JOIN conversations c ON c.room_id = r.id AND c.kind = 'room' WHERE r.id = ?").get(params.roomId) as { conversation_id: string } | undefined;
        if (roomScope == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', '房间不存在');
        assertConversationAudience(deps.db, deps.localUserId, roomScope.conversation_id);
        const threads = deps.db.prepare(
          `SELECT t.id, t.anchor_message_id, tk.id AS root_task_id, t.last_message_seq, t.revision,
                  m.body_json, m.created_at, m.author_type, m.author_id,
                  tk.status AS task_status, tk.response_kind AS task_response_kind, tk.room_task_number, tk.title AS task_title,
                  tk.objective AS task_objective, tk.review_policy AS task_review_policy, tk.revision AS task_revision,
                  tk.owner_member_id AS task_owner, tk.route_json AS task_route
                  ,(SELECT r.id FROM workflow_runs r WHERE r.task_id = tk.id ORDER BY r.rowid DESC LIMIT 1) AS latest_run_id
                  ,(SELECT r.status FROM workflow_runs r WHERE r.task_id = tk.id ORDER BY r.rowid DESC LIMIT 1) AS latest_run_status
           FROM conversation_threads t
           JOIN messages m ON m.id = t.anchor_message_id
           LEFT JOIN tasks tk ON tk.id = t.root_task_id AND tk.room_id = t.room_id AND tk.kind = 'room_task'
           WHERE t.room_id = ? AND t.conversation_id = ?
           ORDER BY m.created_at DESC LIMIT ?`,
        ).all(params.roomId, roomScope.conversation_id, limit) as Array<{
          id: string; anchor_message_id: string; root_task_id: string | null; last_message_seq: number; revision: number;
          body_json: string; created_at: number; author_type: string; author_id: string; task_status: string | null; task_response_kind:'conversation'|'work'|null; room_task_number: number | null; task_title: string | null;
          task_objective: string | null; task_review_policy: 'auto_deliver' | 'user_review' | null; task_revision: number | null; task_owner: string | null; task_route: string | null;
          latest_run_id: string | null; latest_run_status: string | null;
        }>;
        const attachments = messageAttachmentSummaries(deps.db, threads.map((t) => t.anchor_message_id));
        const items = [];
        for (const t of threads) {
          const replyCount = (deps.db.prepare('SELECT count(*) c FROM messages WHERE thread_id = ?').get(t.id) as { c: number }).c;
          // 静音尊重（第二十五轮四）：muted 线程未读恒 0（不进未读/通知聚合——卡片仍可见）。
          const muted = (deps.db.prepare('SELECT muted FROM thread_subscriptions WHERE thread_id = ? AND viewer_id = ?').get(t.id, deps.localUserId) as { muted: number } | undefined)?.muted === 1;
          // 线程未读（第二十三轮一：主池聚合）——agent 回复 thread_message_seq > 水位的条数。
          const unread = muted ? 0 : (deps.db.prepare(
            `SELECT count(*) c FROM messages m WHERE m.thread_id = ? AND m.author_type = 'agent' AND m.thread_message_seq > COALESCE((SELECT s.last_read_message_seq FROM thread_read_states s WHERE s.thread_id = ? AND s.viewer_id = ?), 0)`,
          ).get(t.id, t.id, deps.localUserId) as { c: number }).c;
          const followed = (deps.db.prepare('SELECT followed FROM thread_subscriptions WHERE thread_id = ? AND viewer_id = ?').get(t.id, deps.localUserId) as { followed: number } | undefined)?.followed === 1;
          const lastReply = deps.db.prepare('SELECT created_at FROM messages WHERE thread_id = ? ORDER BY thread_message_seq DESC LIMIT 1').get(t.id) as { created_at: number } | undefined;
          items.push({
            threadId: t.id, unread, muted, followed,
            anchorMessageId: t.anchor_message_id,
            body: JSON.parse(t.body_json) as { text: string },
            createdAt: t.created_at,
            authorType: t.author_type, authorId: t.author_id,
            attachments: attachments.get(t.anchor_message_id) ?? [],
            replyCount,
            lastReplyAt: lastReply?.created_at ?? null,
            taskId: t.root_task_id,
            taskStatus: t.task_status, taskResponseKind:t.task_response_kind,
            roomTaskNumber: t.room_task_number,
            taskTitle: t.task_title,
            taskObjective: t.task_objective, taskReviewPolicy: t.task_review_policy, taskRevision: t.task_revision,
            ownerMemberId: t.task_owner, taskMode: taskModeFromRoute(t.task_route),
            latestRun: t.latest_run_id != null && t.latest_run_status != null ? { id: t.latest_run_id, status: t.latest_run_status } : null,
          });
        }
        return withCommandId({ ok: true, data: { items } });
      }
      case 'run.progress': {
        // 研讨进度（只读）：阶段/轮次/成员状态/预算——「模型说一致」不作为程序共识。
        const params = z.strictObject({ taskId: z.string().min(1) }).parse(env.params);
        assertTaskAudience(deps.db, deps.localUserId, params.taskId);
        const run = deps.db.prepare("SELECT * FROM workflow_runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1").get(params.taskId) as
          | { id: string; mode: string; stage: string | null; round_no: number | null; status: string; budget_json: string | null }
          | undefined;
        if (run == null || run.mode !== 'DELIBERATE') {
          const direct = deps.db.prepare('SELECT stage, status FROM workflow_runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1').get(params.taskId) as { stage: string | null; status: string } | undefined;
          return withCommandId({ ok: true, data: { mode: run?.mode ?? null, stage: direct?.stage ?? null, runStatus: direct?.status ?? null, participants: [], budget: null, issues: [] } });
        }
        const participants = (deps.db.prepare(
          'SELECT rp.member_id, rp.role, rp.status, pm.display_name FROM run_participants rp JOIN project_members pm ON pm.id = rp.member_id WHERE rp.run_id = ? ORDER BY rp.role, rp.member_id',
        ).all(run.id) as Array<{ member_id: string; role: string; status: string; display_name: string }>).map((r) => ({ memberId: r.member_id, displayName: r.display_name, role: r.role, status: r.status }));
        const budget = run.budget_json != null ? JSON.parse(run.budget_json) as { runMaxTurns: number; usedTurns: number } : null;
        const issues = (deps.db.prepare('SELECT id, statement, status FROM issues WHERE run_id = ? ORDER BY id').all(run.id) as Array<{ id: string; statement: string; status: string }>);
        return withCommandId({ ok: true, data: { mode: 'DELIBERATE', stage: run.stage, roundNo: run.round_no, runStatus: run.status, participants, budget, issues } });
      }
      case 'report.get': {
        // 最终报告（只读）：整合稿引用 + 逐结论确认状态（反对/条件/未确认/缺席可见）。
        const params = z.strictObject({ taskId: z.string().min(1) }).parse(env.params);
        const report = deps.db.prepare("SELECT id, blob_path FROM artifacts WHERE task_id = ? AND kind = 'final_report' ORDER BY revision DESC LIMIT 1").get(params.taskId) as { id: string; blob_path: string } | undefined;
        if (report == null) return withCommandId({ ok: true, data: { report: null } });
        const payload = JSON.parse(readFileSync(report.blob_path, 'utf8')) as Record<string, unknown>;
        return withCommandId({ ok: true, data: { report: { artifactId: report.id, ...payload } } });
      }
      case 'dispatch.resume': {
        // 恢复门禁的用户确认（修复轮 5：须显式 confirm:true，不接受空参数直开）。
        z.strictObject({ confirm: z.literal(true) }).parse(env.params);
        const result = run(() => {
          openDispatchGate(deps.db);
          return { gate: 'open' as const };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'task.stop': {
        const params = z.strictObject({ taskId: z.string().min(1), targetRunId: z.string().min(1), expectedStopGeneration: z.number().int().nonnegative() }).parse(env.params);
        assertTaskAudience(deps.db, deps.localUserId, params.taskId); // 操作面同样不绕过（第三十二轮一）
        // requestStop 内部自包 runCommand（含中断回调在外层执行）——此处不重复包裹；
        // commitGate=提交事务前远程门禁重查（第三十四轮四：异步等待窗口内吊销→提交拒绝）。
        const data = await requestStop(deps.db, {
          taskId: params.taskId,
          targetRunId: params.targetRunId,
          expectedStopGeneration: params.expectedStopGeneration,
          commandId: env.commandId,
          idempotencyScope: scope,
          payloadHash,
          now: Date.now(),
          interruptTurn: deps.interruptTurn,
          commitGate: (): void => { if (deps.remoteGate != null) { const g = deps.remoteGate(); if (!g.ok) throw new DaemonCommandError(g.code, g.message); } },
        });
        return withCommandId({ ok: true, data });
      }
      case 'daemon.shutdown': {
        // DEV-15（第十四轮三）：正式关闭动作——IPC 命令驱动（打包产物验证/宿主停机同路径）。
        // 响应=「关闭已调度」；**确认结果=进程退出码与 daemon:stop:last 记录**（关闭本身会断
        // IPC，不在响应里声称完成）。内嵌实例未注入=拒绝（不经命令面伪造进程管理）。
        z.strictObject({}).parse(env.params);
        if (deps.scheduleShutdown == null) {
          throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', '该 daemon 未注入关闭入口（内嵌实例）——由宿主进程管理停止');
        }
        deps.scheduleShutdown();
        return withCommandId({ ok: true, data: { accepted: true, note: '优雅关闭已调度（拒新命令→收拢→关库→退出 0；未收敛→强制→退出 3）——确认以进程退出码与 daemon:stop:last 为准' } });
      }
      case 'task.redispatch': {
        // DIRECT 追加 turn（跟进/格式修复/中断恢复）：经 outbox 正式编排（worker 领取→准入→
        // 成员绑定 adapter），不绕过产品链路直调 CLI。前置：任务存在、非终态、stop_generation=0、
        // 无在途 turn（防止并发双派）；同 (taskId, 在途) 语义下重复调用幂等拒绝。
        // formatRepair:true=**合同内一次格式修复**（第六轮）：仅当上一 turn FAILED 且存在
        // turn.outputInvalid；每任务至多一次；修复上下文（原输出全文+校验错误）注入下一 turn
        // 输入（组装侧），审计绑定原 turn——不是无反馈的"重跑"。
        //
        // 第三十九轮 §2（复核确认的入口放行缺口）：
        // - **在途检查按真实归属**（workflow_runs.task_id）——旧查询按 dispatch_key 前缀 'task:'
        //   匹配，漏掉 DM 初始键 dmtask:（旧 DM turn 仍 RUNNING 也放行）；现在覆盖 DM/房间/提醒/
        //   修复/重派全部键形态，run 级在途一并核对。
        // - **UNKNOWN 未对账拒绝**：显式点击不构成旧执行已退出的证明——预算未结算
        //   （budget_mark IS NULL）或存在未释放 workspace_leases 的 UNKNOWN turn = 结果不确定，
        //   先走恢复中心取证/对账/保护解除（RECONCILE_REQUIRED），不得新建派发或借新 run 绕预算。
        // - **恢复意图绑定源执行**：非修复派发键=task:<id>:redispatch:<sourceRunId>（缺省取任务
        //   最新 run；无 run 保持旧键）。同源重试在途=幂等冲突；同源已完成=STALE（该次恢复已
        //   派发过——新一次合法中断产生新源 run=新意图）；不再撞固定唯一键。
        const params = z.strictObject({
          taskId: z.string().min(1), reason: z.string().min(1).max(200).optional(), formatRepair: z.boolean().optional(),
          sourceRunId: z.string().min(1).optional(), expectedTaskRevision: z.number().int().nonnegative().optional(),
          expectedStopGeneration: z.number().int().nonnegative().optional(), expectedRunStatus: z.enum(['FAILED','SUCCEEDED']).optional(),
        }).parse(env.params);
        assertTaskAudience(deps.db, deps.localUserId, params.taskId); // 回执重放也不能绕过 DM audience
        assertTaskDispatchScope(deps.db, params.taskId);
        const result = run(() => {
          const task = deps.db
            .prepare('SELECT id, status, revision, stop_generation, conversation_id FROM tasks WHERE id = ?')
            .get(params.taskId) as { id: string; status: string; revision: number; stop_generation: number; conversation_id: string } | undefined;
          if (task == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `任务不存在：${params.taskId}`);
          assertConversationAudience(deps.db, deps.localUserId, task.conversation_id);
          assertTaskDispatchScope(deps.db, params.taskId);
          if (params.expectedTaskRevision != null && task.revision !== params.expectedTaskRevision) throw new DaemonCommandError('STALE_REVISION', '任务版本已变化——请刷新后按当前任务事实重试');
          if (params.expectedStopGeneration != null && task.stop_generation !== params.expectedStopGeneration) throw new DaemonCommandError('STALE_REVISION', '停止代次已变化——旧运行的继续请求已作废');
          if (['DONE', 'CANCELLED'].includes(task.status)) throw new DaemonCommandError('STALE_REVISION', `任务已终态（${task.status}）：不再追加 turn`);
          if (task.stop_generation > 0) throw new DaemonCommandError('STALE_REVISION', '任务停止已生效：不再追加 turn');
          if (params.expectedRunStatus != null) {
            if (params.sourceRunId == null) throw new DaemonCommandError('VALIDATION_INVALID', '绑定失败运行必须携带来源 run');
            const expected = deps.db.prepare('SELECT status FROM workflow_runs WHERE id = ? AND task_id = ? AND conversation_id = ?').get(params.sourceRunId, params.taskId, task.conversation_id) as { status: string } | undefined;
            if (expected == null || expected.status !== params.expectedRunStatus || (params.expectedRunStatus==='FAILED'?task.status!=='ACTIVE':task.status!=='WAITING_USER'||params.expectedTaskRevision==null||params.expectedStopGeneration==null||deps.db.prepare("SELECT 1 FROM domain_events WHERE task_id=? AND run_id=? AND kind='turn.workClarification'").get(params.taskId,params.sourceRunId)==null)) {
              throw new DaemonCommandError('STALE_REVISION', '失败运行或任务状态已变化——请刷新后重新决定');
            }
          }
          // 恢复就绪=共享判定（第四十轮 §2 四分离：在途/保护未解除/UNKNOWN 未闭环——
          // 与 dm.ts 可恢复性呈现同源；FAILED+未释放租约、settled 但无正式保护解除事件均拦）。
          const blockedEarly = assessTaskRedispatchReadiness(deps.db, params.taskId);
          if (blockedEarly != null) throw new DaemonCommandError(blockedEarly.code, blockedEarly.message);
          // sourceRunId 归属校验（第四十轮 §3）：客户端来源只是引用，不替代服务端事实——
          // 必须存在、属于本任务、且是任务当前最新执行（过时来源拒绝；新一次合法中断产生新源）。
          if (params.formatRepair !== true && params.sourceRunId != null) {
            const src = deps.db.prepare('SELECT id, task_id FROM workflow_runs WHERE id = ?').get(params.sourceRunId) as { id: string; task_id: string } | undefined;
            if (src == null || src.task_id !== params.taskId) {
              throw new DaemonCommandError('RESOURCE_NOT_FOUND', `恢复来源 run 不存在或不属于该任务：${params.sourceRunId}——来源以服务端事实为准，不得以任意号生成恢复意图`);
            }
            const latest = deps.db.prepare('SELECT id FROM workflow_runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1').get(params.taskId) as { id: string } | undefined;
            if (latest == null || latest.id !== src.id) {
              throw new DaemonCommandError('STALE_REVISION', `恢复来源 run（${params.sourceRunId.slice(0, 14)}…）不是该任务当前最新执行（过时来源）：若任务此后再次中断，以新中断执行发起恢复（新意图）`);
            }
          }
          // formatRepair 守卫（第七轮：按**根逻辑输出**限制一次——禁止修复套修复）：
          // - 源 turn=任务最后一个 turn 且 FAILED，且**其自身**存在 turn.outputInvalid 事件
          //   （turn_id 绑定——旧轮校验失败不给新轮提供修复资格）；
          // - 根逻辑输出身份：源 turn 是修复轮（consumed_turn_id 指向它的工作项存在）则继承
          //   该工作项的 logical_output_id；否则=源 turn 自身。初始输出与其修复尝试共享
          //   逻辑输出身份——修复失败后不得把修复 turn 当作新的独立输出再修；
          // - 每份逻辑输出最多一次：UNIQUE(task_id, logical_output_id)（迁移 010）——用户
          //   后续正式发起的独立输出有自己的身份与修复资格（不靠生成新 turn ID 获得）；
          // - 被拒的第二次修复不创建工作项/outbox/模型调用（守卫在 INSERT 前抛错回滚）；
          // - 源输出=该 turn 的实际完成输出（thread.replyAdded(turn_id=源) 最后一条消息），
          //   不用任务最后一条消息顶替；输出须为可解析 JSON（resultKey 可绑定）；
          // - 三者一致性在工作项内固化（hash/事件 id/原文），worker 侧复核损坏+授权链。
          if (params.formatRepair === true) {
            // 源 turn=任务最后一个**有效** turn（豁免 refunded——确认未启动退款无逻辑输出，
            // 不挡住更早有效输出的修复资格）且 FAILED，且**其自身**存在 turn.outputInvalid 事件。
            const sourceTurn = deps.db
              .prepare(`SELECT id, status FROM agent_turns WHERE dispatch_key LIKE 'task:' || ? || ':%' AND (budget_mark IS NULL OR budget_mark != 'refunded') ORDER BY rowid DESC LIMIT 1`)
              .get(params.taskId) as { id: string; status: string } | undefined;
            if (sourceTurn == null || sourceTurn.status !== 'FAILED') {
              throw new DaemonCommandError('STALE_REVISION', `格式修复仅适用于最后一个 turn FAILED（实际：${sourceTurn?.status ?? '无 turn'}）`);
            }
            const inherited = deps.db
              .prepare(`SELECT logical_output_id FROM format_repair_workitems WHERE consumed_turn_id = ?`)
              .get(sourceTurn.id) as { logical_output_id: string } | undefined;
            const logicalOutputId = inherited?.logical_output_id ?? sourceTurn.id;
            const existing = deps.db
              .prepare(`SELECT id, status FROM format_repair_workitems WHERE task_id = ? AND logical_output_id = ?`)
              .get(params.taskId, logicalOutputId) as { id: string; status: string } | undefined;
            if (existing != null) {
              throw new DaemonCommandError('STALE_REVISION', `该逻辑输出（${logicalOutputId}）已用过修复资格（工作项 ${existing.id}，${existing.status}）——修复尝试与初始输出共享身份，不得修复套修复`);
            }
            const invalid = deps.db
              .prepare(`SELECT event_id, payload_json FROM domain_events WHERE kind = 'turn.outputInvalid' AND turn_id = ? ORDER BY seq DESC LIMIT 1`)
              .get(sourceTurn.id) as { event_id: string; payload_json: string } | undefined;
            if (invalid == null) throw new DaemonCommandError('STALE_REVISION', '源 turn 无自身 outputInvalid 事件：不构成格式修复条件（provider 失败等不适用）');
            const replyEvt = deps.db
              .prepare(`SELECT payload_json FROM domain_events WHERE kind = 'thread.replyAdded' AND turn_id = ? ORDER BY seq DESC LIMIT 1`)
              .get(sourceTurn.id) as { payload_json: string } | undefined;
            if (replyEvt == null) throw new DaemonCommandError('STALE_REVISION', '源 turn 无完成输出消息（不能以任务级最后消息顶替）');
            const messageId = (JSON.parse(replyEvt.payload_json) as { messageId: string }).messageId;
            const msg = deps.db.prepare('SELECT body_json FROM messages WHERE id = ?').get(messageId) as { body_json: string } | undefined;
            if (msg == null) throw new DaemonCommandError('STALE_REVISION', `源输出消息缺失：${messageId}`);
            const body=JSON.parse(msg.body_json) as {text?:string;runtimeControlResult?:string};
            const outputText=body.runtimeControlResult??body.text??'';
            // 源逻辑输出 resultKey=确定性约定 result_<turnId>（与该 turn 的 run.created 审计
            // payload.resultKey 核对一致）——散文类失败同样可修复（原文全文入上下文）。
            const sourceResultKey = `result_${sourceTurn.id}`;
            const runCreated = deps.db
              .prepare(`SELECT count(*) c FROM domain_events WHERE kind = 'run.created' AND turn_id = ? AND payload_json LIKE ?`)
              .get(sourceTurn.id, `%${sourceResultKey}%`) as { c: number };
            if (runCreated.c < 1) throw new DaemonCommandError('STALE_REVISION', `源 turn 的 run.created 审计与 ${sourceResultKey} 不一致：绑定失败`);
            const lastRun = deps.db.prepare('SELECT id FROM workflow_runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1').get(params.taskId) as { id: string } | undefined;
            const now2 = Date.now();
            deps.db.prepare(
              `INSERT INTO format_repair_workitems
                 (id, task_id, source_turn_id, source_result_key, logical_output_id, invalid_event_id,
                  source_output_hash, source_output_text, invalid_issues_json, target_dispatch_key,
                  budget_run_id, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            ).run(
              `frw_${randomUUID()}`, params.taskId, sourceTurn.id, sourceResultKey, logicalOutputId, invalid.event_id,
              createHash('sha256').update(outputText, 'utf8').digest('hex'), outputText,
              JSON.stringify((JSON.parse(invalid.payload_json) as { issues: string[] }).issues),
              `task:${params.taskId}:repair:${sourceTurn.id}`, lastRun?.id ?? 'none', now2, now2,
            );
          }
          // 派发键（第三十九轮 §2.2：恢复意图绑定源执行+版本——非修复重派键=源 run 派生；
          // 同源在途=幂等冲突，同源已完成=STALE（新中断=新源 run=新意图），不再撞固定唯一键）。
          const sourceRunId = params.formatRepair === true
            ? null
            : params.sourceRunId ?? ((deps.db.prepare('SELECT id FROM workflow_runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1').get(params.taskId) as { id: string } | undefined)?.id ?? null);
          const dispatchKey = params.formatRepair === true
            ? `task:${params.taskId}:repair:${(deps.db.prepare(`SELECT source_turn_id FROM format_repair_workitems WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`).get(params.taskId) as { source_turn_id: string }).source_turn_id}` // 按逻辑输出版本化——同任务多轮修复不撞唯一键
            : sourceRunId != null ? `task:${params.taskId}:redispatch:${sourceRunId}` : `task:${params.taskId}:redispatch`;
          // 同任务在途恢复意图（第四十轮 §3：任务级核对——不只查客户端指定的键；双端同源
          // 双击/异源并发=恰一个意图）。GLOB 而非 LIKE：任务号含 '_'（LIKE 通配符会误匹配）。
          const pendingIntent = deps.db
            .prepare(`SELECT dispatch_key FROM outbox WHERE dispatch_key GLOB ? AND status != 'done' LIMIT 1`)
            .get(`task:${params.taskId}:redispatch*`) as { dispatch_key: string } | undefined;
          if (pendingIntent != null) {
            throw new DaemonCommandError('IDEMPOTENCY_CONFLICT', `该任务已有在途恢复派发（${pendingIntent.dispatch_key}）：不重复入队——同源重试等待队列消化，新中断以新源执行发起新意图`);
          }
          if (sourceRunId != null) {
            const priorDone = deps.db
              .prepare(`SELECT count(*) c FROM outbox WHERE dispatch_key = ? AND status = 'done'`)
              .get(dispatchKey) as { c: number };
            if (priorDone.c > 0) {
              throw new DaemonCommandError('STALE_REVISION', `源执行（run ${sourceRunId.slice(0, 14)}…）的恢复派发已完成：不重复派发——若任务在此后再次中断，以新中断执行发起恢复（新意图）`);
            }
          }
          // 提交前重查（review-r39 §2：可恢复性判定与提交同事务重查——formatRepair 长流程后
          // 事实可能已变化，以 INSERT 前最终权威判定为准）。
          const blockedFinal = assessTaskRedispatchReadiness(deps.db, params.taskId);
          if (blockedFinal != null) throw new DaemonCommandError(blockedFinal.code, blockedFinal.message);
          deps.db.prepare('INSERT INTO outbox (dispatch_key, stop_generation_at_enqueue) VALUES (?, ?)').run(dispatchKey, (deps.db.prepare('SELECT stop_generation FROM tasks WHERE id = ?').get(params.taskId) as { stop_generation: number } | undefined)?.stop_generation ?? 0); // 意图入队代次（迁移 034）
          appendDomainEvent(deps.db, {
            schemaVersion: 1,
            eventId: `evt_${randomUUID()}`,
            projectId: (deps.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(params.taskId) as { project_id: string }).project_id,
            taskId: params.taskId,
            kind: 'task.redispatchEnqueued',
            createdAt: Date.now(),
            payload: { reason: params.reason ?? 'manual-redispatch', formatRepair: params.formatRepair === true, sourceRunId, dispatchKey },
          });
          return { enqueued: true as const, dispatchKey, formatRepair: params.formatRepair === true, sourceRunId };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'task.executeRework': {
        // r58（review-r57 §3）：返工**执行**闭环——验收与执行分离合同的另一半。task.review
        //（changes_requested）只写验收事实（意见入账、任务回 ACTIVE、零派发）；本命令=明确
        // 的「执行返工」入口：以**库内**最近一次 changes_requested 验收事实为源（意见/版本以
        // 服务端记录为准——客户端只传任务号与审计 reason，不重传意见文本），绑定原任务/会话/
        // 来源 run，沿 task.redispatch 同一守卫栈（就绪/在途/停止代次/幂等）与同键命名空间
        // task:<id>:redispatch:<sourceRunId> 入队正式派发。不自动执行、不借普通 DM 新消息
        // 另建新任务冒充同任务返工；新交付由 worker 完成路径自然产生（revision 递增、旧
        // pending 置 superseded、user_review 回 REVIEW——无任何人工 INSERT/UPDATE）。
        // r59（review-r58 §2 独立反例 stale-rework-result.json）：执行授权必须绑定**用户所见
        // 的具体返工事实**——请求带 deliveryId/revision/manifestHash/sourceRunId 完整快照，
        // 事务内核核对归属与「当前最高版本=该 changes_requested」；旧引用（页面未刷新、
        // 另一路已把返工推进到 v2）一律 STALE_REVISION、零 outbox/零 run/零新审计副作用，
        // **不默默改绑新返工**。意见正文仍取服务端记录（客户端不重传）。
        const params = z.strictObject({
          taskId: z.string().min(1),
          deliveryId: z.string().min(1),
          deliveryRevision: z.number().int().positive(),
          manifestHash: z.string().min(8),
          sourceRunId: z.string().min(1),
          reason: z.string().min(1).max(200).optional(),
        }).parse(env.params);
        const result = run(() => {
          const task = deps.db
            .prepare('SELECT id, status, stop_generation, conversation_id FROM tasks WHERE id = ?')
            .get(params.taskId) as { id: string; status: string; stop_generation: number; conversation_id: string } | undefined;
          if (task == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `任务不存在：${params.taskId}`);
          assertConversationAudience(deps.db, deps.localUserId, task.conversation_id);
          if (['DONE', 'CANCELLED'].includes(task.status)) throw new DaemonCommandError('STALE_REVISION', `任务已终态（${task.status}）：无返工可执行`);
          if (task.stop_generation > 0) throw new DaemonCommandError('STALE_REVISION', '任务停止已生效：不再追加执行');
          if (task.status !== 'ACTIVE') throw new DaemonCommandError('STALE_REVISION', `任务状态 ${task.status} 非 ACTIVE：返工执行要求「意见已记录、任务回到执行」状态（先经 task.review 提交返工意见）`);
          // 完整身份核对（与 task.review 同款三重绑定+来源 run 归属）：
          const ref = deps.db
            .prepare('SELECT id, revision, manifest_hash, review_status, review_note, run_id FROM task_deliveries WHERE task_id = ? AND id = ?')
            .get(params.taskId, params.deliveryId) as { id: string; revision: number; manifest_hash: string; review_status: string; review_note: string | null; run_id: string | null } | undefined;
          if (ref == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `交付不存在或不属于该任务：${params.deliveryId}（执行授权不跨任务套用）`);
          if (ref.revision !== params.deliveryRevision) {
            throw new DaemonCommandError('STALE_REVISION', `交付版本不符：提交第 ${params.deliveryRevision} 版，记录为第 ${ref.revision} 版——执行授权绑定失败`);
          }
          if (ref.manifest_hash !== params.manifestHash) {
            throw new DaemonCommandError('STALE_REVISION', `交付内容不符：manifestHash 不匹配（提交 ${params.manifestHash.slice(0, 12)}，记录 ${ref.manifest_hash.slice(0, 12)}）——同版本号不同内容不可执行返工`);
          }
          if (ref.run_id !== params.sourceRunId) {
            throw new DaemonCommandError('STALE_REVISION', `返工来源 run 不符：提交 ${params.sourceRunId.slice(0, 14)}…，该交付实际执行为 ${ref.run_id?.slice(0, 14) ?? '无'}——来源以服务端事实为准`);
          }
          // 当前事实核对：引用必须是**当前最高版本**的 changes_requested——页面陈旧时
          //（另一路已执行旧返工并对新交付提交新意见）明确 STALE，不自动改绑新返工。
          const last = deps.db
            .prepare('SELECT id, revision, review_status, review_note, run_id FROM task_deliveries WHERE task_id = ? ORDER BY revision DESC LIMIT 1')
            .get(params.taskId) as { id: string; revision: number; review_status: string; review_note: string | null; run_id: string | null } | undefined;
          if (last == null || last.id !== ref.id) {
            throw new DaemonCommandError('STALE_REVISION', `第 ${params.deliveryRevision} 版已不是当前返工事实（当前为第 ${last?.revision ?? '?'} 版${last?.review_status ? '·' + last.review_status : ''}）——请刷新后对新返工执行，不自动改绑`);
          }
          if (last.review_status === 'pending') throw new DaemonCommandError('STALE_REVISION', `第 ${last.revision} 版交付待验收：请先对新交付验收（不自动执行旧返工）`);
          if (last.review_status !== 'changes_requested') throw new DaemonCommandError('STALE_REVISION', `最近交付验收结果为 ${last.review_status}：无「要求修改」返工可执行`);
          const sourceRunId = ref.run_id; // 已与提交快照核对一致
          // 恢复就绪（与 task.redispatch 共用服务端判定：在途/保护未解除/UNKNOWN 未闭环）。
          const blockedEarly = assessTaskRedispatchReadiness(deps.db, params.taskId);
          if (blockedEarly != null) throw new DaemonCommandError(blockedEarly.code, blockedEarly.message);
          const dispatchKey = `task:${params.taskId}:redispatch:${sourceRunId}`;
          // 幂等与在途（同 redispatch 键命名空间——双入口一意图）。
          const pendingIntent = deps.db
            .prepare(`SELECT dispatch_key FROM outbox WHERE dispatch_key GLOB ? AND status != 'done' LIMIT 1`)
            .get(`task:${params.taskId}:redispatch*`) as { dispatch_key: string } | undefined;
          if (pendingIntent != null) {
            throw new DaemonCommandError('IDEMPOTENCY_CONFLICT', `该任务已有在途恢复/返工派发（${pendingIntent.dispatch_key}）：不重复入队`);
          }
          const priorDone = deps.db
            .prepare(`SELECT count(*) c FROM outbox WHERE dispatch_key = ? AND status = 'done'`)
            .get(dispatchKey) as { c: number };
          if (priorDone.c > 0) {
            throw new DaemonCommandError('STALE_REVISION', `该返工（第 ${ref.revision} 版·run ${sourceRunId.slice(0, 14)}…）已执行过：其交付应已生成——请刷新后对新交付验收`);
          }
          const blockedFinal = assessTaskRedispatchReadiness(deps.db, params.taskId);
          if (blockedFinal != null) throw new DaemonCommandError(blockedFinal.code, blockedFinal.message);
          deps.db.prepare('INSERT INTO outbox (dispatch_key, stop_generation_at_enqueue) VALUES (?, ?)').run(dispatchKey, (deps.db.prepare('SELECT stop_generation FROM tasks WHERE id = ?').get(params.taskId) as { stop_generation: number } | undefined)?.stop_generation ?? 0);
          appendDomainEvent(deps.db, {
            schemaVersion: 1,
            eventId: `evt_${randomUUID()}`,
            projectId: (deps.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(params.taskId) as { project_id: string }).project_id,
            taskId: params.taskId,
            runId: sourceRunId,
            kind: 'task.reworkEnqueued',
            createdAt: Date.now(),
            payload: {
              deliveryId: ref.id, deliveryRevision: ref.revision, reviewNote: ref.review_note,
              sourceRunId, dispatchKey, reason: params.reason ?? 'user-execute-rework',
              note: '返工执行入队：验收与执行分离——意见已记录（task.review），本次为用户明确执行的续跑（绑定用户所见交付完整身份）',
            },
          });
          return { enqueued: true as const, dispatchKey, deliveryRevision: ref.revision, sourceRunId };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      default:
        return withCommandId({ ok: false, error: { code: 'VALIDATION_INVALID', message: `未知命令：${env.method}`, retryable: false } });
    }
  } catch (error) {
    if (error instanceof DaemonCommandError) {
      return withCommandId({ ok: false, error: { code: error.code, message: error.message, retryable: false } });
    }
    if (error instanceof z.ZodError) {
      return withCommandId({ ok: false, error: { code: 'VALIDATION_INVALID', message: error.issues[0]?.message ?? '参数无效', retryable: false } });
    }
    // 不吞异常假装成功（§16.5）。
    return withCommandId({ ok: false, error: { code: 'STORAGE_UNAVAILABLE', message: error instanceof Error ? error.message : String(error), retryable: false } });
  }
}

/**
 * R68 §6：项目文本文件**轻量 stat**（工作区脏检测——路径安全链与 readFull 同源：resolve
 * 边界 + realpath 实身份 + 文本白名单；只 statSync 不读内容不做 UTF-8 校验）。预览面板
 * 据此提示「磁盘已更新」（用户显式重载才换快照——不自动重读、不静默另存新字节）。
 */
function resolveProjectTextStat(
  deps: { db: ZhongshuoDatabase; appDataDir?: string },
  projectId: string,
  path: string,
): { mtimeMs: number; bytes: number } {
  const proj = deps.db.prepare('SELECT id, canonical_path FROM projects WHERE id = ?').get(projectId) as { id: string; canonical_path: string } | undefined;
  if (proj == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目不存在：${projectId}`);
  const root = resolve(proj.canonical_path);
  const target = resolve(root, path.replace(/^[/\\]+/, ''));
  const rootSep = root.includes('/') ? '/' : '\\';
  if (target !== root && !target.startsWith(root + rootSep)) {
    throw new DaemonCommandError('FORBIDDEN', `项目文件路径越界：${path}——拒绝读取`);
  }
  let realTarget: string;
  let realRoot: string;
  try {
    realTarget = realpathSync(target);
    realRoot = realpathSync(root);
  } catch {
    throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目文件不存在或不可读：${path}`);
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + rootSep)) {
    throw new DaemonCommandError('FORBIDDEN', '项目文件路径含链接越界（realpath 实身份拒绝）');
  }
  const dot = realTarget.lastIndexOf('.');
  const ext = dot >= 0 ? realTarget.slice(dot).toLowerCase() : '';
  // R69：脏检测（stat）白名单与 readFull 同面（文本+阅读二进制）——二进制工作区文件同样
  // 能提示「磁盘已更新」。
  if (!isProjectPreviewableExt(ext)) {
    throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', `该项目文件类型（${ext || '无扩展名'}）不在只读阅读白名单`);
  }
  try {
    const st = statSync(realTarget);
    return { mtimeMs: st.mtimeMs, bytes: st.size };
  } catch {
    throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目文件不可读：${path}`);
  }
}

/**
 * R67 P1-A（R69 扩展）：项目文件**共享路径安全读取**（project.file.readFull / originalFile
 * 同链）：resolve 边界 + realpath 实身份（链接越界拒）+ 白名单扩展（文本类 TEXT_PREVIEW_
 * EXTENSIONS ≤256KB；R69 增阅读二进制类 PREVIEW_BINARY_EXTENSIONS 按类上限——与上传同
 * 类型面，文件树/上传/预览三入口支持类型一致）+ 实际字节 sha256（读取快照身份）。
 */
/**
 * R72：容量**从共享合同取值**（parseContracts 常量），不再散落副本——R71 只调了
 * OFFICE_MAX_BYTES（上传/视觉字节），此处仍留 20MiB 导致文件树点击真实 22.54MiB PPT
 * 被 readFull/originalFile 拒绝（review-r71 §P1：上传通道通过不能替代原始路径）。
 * 分道不变：Office=OFFICE_MAX_BYTES；PDF/图片保持各自通道限额。
 */
const PREVIEW_BINARY_EXTENSIONS: Record<string, { cap: number; kind: 'image_file' | 'pdf_file' | 'docx_file' | 'sheet_file' | 'slides_file' }> = {
  '.png': { cap: 8 * 1024 * 1024, kind: 'image_file' },
  '.jpg': { cap: 8 * 1024 * 1024, kind: 'image_file' },
  '.jpeg': { cap: 8 * 1024 * 1024, kind: 'image_file' },
  '.gif': { cap: 8 * 1024 * 1024, kind: 'image_file' },
  '.webp': { cap: 8 * 1024 * 1024, kind: 'image_file' },
  '.bmp': { cap: 8 * 1024 * 1024, kind: 'image_file' },
  // Local SVG remains an <img> byte source, never a document/script or model input.
  '.svg': { cap: 8 * 1024 * 1024, kind: 'image_file' },
  '.pdf': { cap: PDF_MAX_BYTES, kind: 'pdf_file' },
  '.docx': { cap: OFFICE_MAX_BYTES, kind: 'docx_file' },
  '.xlsx': { cap: OFFICE_MAX_BYTES, kind: 'sheet_file' },
  '.pptx': { cap: OFFICE_MAX_BYTES, kind: 'slides_file' },
};
function isProjectPreviewableExt(ext: string): boolean {
  return TEXT_PREVIEW_EXTENSIONS.has(ext) || PREVIEW_BINARY_EXTENSIONS[ext] != null;
}
function resolveProjectPreviewFile(
  deps: { db: ZhongshuoDatabase; appDataDir?: string },
  projectId: string,
  path: string,
): { projectId: string; baseName: string; raw: Buffer; sha256: string; mtimeMs: number; ext: string; isBinary: boolean; binaryKind?: string } {
  const proj = deps.db.prepare('SELECT id, canonical_path FROM projects WHERE id = ?').get(projectId) as { id: string; canonical_path: string } | undefined;
  if (proj == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目不存在：${projectId}`);
  const root = resolve(proj.canonical_path);
  const target = resolve(root, path.replace(/^[/\\]+/, ''));
  const rootSep = root.includes('/') ? '/' : '\\';
  if (target !== root && !target.startsWith(root + rootSep)) {
    throw new DaemonCommandError('FORBIDDEN', `项目文件路径越界：${path}——拒绝读取`);
  }
  let realTarget: string;
  let realRoot: string;
  try {
    realTarget = realpathSync(target);
    realRoot = realpathSync(root);
  } catch {
    throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目文件不存在或不可读：${path}`);
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + rootSep)) {
    throw new DaemonCommandError('FORBIDDEN', '项目文件路径含链接越界（realpath 实身份拒绝）');
  }
  const dot = realTarget.lastIndexOf('.');
  const ext = dot >= 0 ? realTarget.slice(dot).toLowerCase() : '';
  const binary = PREVIEW_BINARY_EXTENSIONS[ext];
  const cap = binary?.cap ?? ATT_MAX_BYTES;
  if (!TEXT_PREVIEW_EXTENSIONS.has(ext) && binary == null) {
    throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', `该项目文件类型（${ext || '无扩展名'}）不在只读阅读白名单——与上传同类型面（文本/图片/PDF/Office/CSV）；未知格式不执行不转码`);
  }
  let raw: Buffer;
  let mtimeMs: number;
  try {
    const st = statSync(realTarget);
    if (st.size > cap) throw new DaemonCommandError('VALIDATION_INVALID', `项目文件 ${st.size.toLocaleString('en-US')}B（约 ${(st.size / 1048576).toFixed(1)}MiB）超只读上限 ${(cap / 1048576).toFixed(0)}MiB（完整阅读/原件保存拒绝——不静默截断）`);
    raw = readFileSync(realTarget);
    mtimeMs = st.mtimeMs;
  } catch (error) {
    if (error instanceof DaemonCommandError) throw error;
    throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目文件读取失败：${path}`);
  }
  return { projectId: proj.id, baseName: basename(realTarget), raw, sha256: createHash('sha256').update(raw).digest('hex'), mtimeMs, ext, isBinary: binary != null, ...(binary != null ? { binaryKind: binary.kind } : {}) };
}
