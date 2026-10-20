/**
 * R91 生成文件快照（后端 helper，独立于 dispatch worker 事务）。
 *
 * 目标：把**正式已验证完成结果**（TaskComplete.files 明确列出的路径，或本 turn 已验证的
 * 新增产物）落成不可变 artifacts + message_attachments，供现有附件预览/导出通道打开/另存。
 *
 * 硬边界（与既有附件/项目文件通道同源规则，R91 审核①~⑥修订）：
 * - 只接受**正式结果显式路径**或本 turn changeset 的 added 清单；不扫描全盘、不从正文/正则
 *   抓路径、不把任意路径变成可执行链接。
 * - **绑定消息先于任何文件读取核对**：messageId 必须属于本轮命名空间 `msg_<turnId>_…`，
 *   且行内 project_id/conversation_id/task_id/author_type='agent'/author_id=本 turn 成员全部
 *   一致；不一致=失败，绝不把文件挂到别的回复/别的项目上。artifact 复用同样核对行内归属。
 * - 必须真实读取字节并计算 sha256；未读取/hash/复制的文件绝不登记为附件。
 * - **用户路径读取走受控 fd**：lstat（拒绝链接/非普通文件）→ 打开前 lstat 的 dev/ino 与
 *   `openSync` 后 `fstatSync` 对比 → 按 fstat 大小**先限幅再读**（绝不越界读）→ 读后再次
 *   fstat 对比 dev/ino/size/mtimeNs（bigint）——读取期间被替换/改写一律 CHANGED_DURING_READ，
 *   不用旧大小/旧 hash 冒充新内容。只有复制到托管 blobstore 之后才用普通读做副本核对。
 * - 权限：helper **不重新解释权限**，只信 worker 传入的 access（本 turn 执行时事实）：
 *   fullAccess=可本轮显式列出的项目外文件；modificationAuthorized&&!fullAccess=只接受项目
 *   根内且 turnDiff（added 或 modified）含该相对路径的产出；readonly/null=不登记任何产出。
 * - Office/PDF/CSV 只按扩展名存 blob 不会“能打开”：artifact 行保留 source_name/kind/
 *   revision/hash，不伪造 extracted_text_json；预览/注入统一走 commands.ts 既有
 *   ensureDocumentCache/previewOffice 解析并回写缓存（sheet_file 的 .csv/.tsv 由 source_name
 *   选择 csv parser），因此坏文件在预览时如实 extraction:'failed'，不冒充可解析。
 * - 不可变/幂等：artifact ID 由 (project, task, 路径身份, hash) 决定；同 turn 重放复用同一
 *   行与同一 message_attachment；同路径新内容=新 ID/新 revision，旧消息仍指向旧版本。
 * - 复制到内容寻址 blobstore（文本类 {hash}.txt、其余 {hash}.bin），与现有 preview/export
 *   读取链一致（readVerifiedCopy/readVerifiedStoreRaw）。
 * - 失败只产生可读 failures：显式声明路径失败才汇总给用户（worker 只发一条 system 提示）；
 *   无声明文件且 diff 无候选=no-candidates，绝不产生用户可见失败提示；非声明 diff 候选
 *   失败只进 skipped/audit。
 */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import type { BigIntStats } from 'node:fs';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { atomicWriteFile } from '../contracts/atomicFile.ts';
import { kindForFilename, validateImageBuffer } from './attachments.ts';
import { OFFICE_MAX_BYTES, PDF_MAX_BYTES, CSV_MAX_BYTES } from './parseContracts.ts';
import { TEXT_PREVIEW_EXTENSIONS } from './exportWriter.ts';

/** 单 turn 快照上限（防长阻塞/批量误挂）。 */
export const SNAPSHOT_MAX_FILES = 12;
/** 单 turn 总字节上限。 */
export const SNAPSHOT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** 文本/代码类生成文件上限（读取链本身无 256KB 上传限制；给生成物一个明确边界）。 */
const SNAPSHOT_TEXT_MAX_BYTES = 5 * 1024 * 1024;
const SNAPSHOT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

interface KindSpec {
  kind: 'text_file' | 'code_file' | 'image_file' | 'pdf_file' | 'docx_file' | 'sheet_file' | 'slides_file';
  storage: 'txt' | 'bin';
  cap: number;
  /** 文档类空文件不可作为可打开附件；文本允许 0 字节。 */
  rejectEmpty: boolean;
  image?: boolean;
}

const KIND_BY_EXT: Record<string, KindSpec> = {
  '.pdf': { kind: 'pdf_file', storage: 'bin', cap: PDF_MAX_BYTES, rejectEmpty: true },
  '.docx': { kind: 'docx_file', storage: 'bin', cap: OFFICE_MAX_BYTES, rejectEmpty: true },
  '.xlsx': { kind: 'sheet_file', storage: 'bin', cap: OFFICE_MAX_BYTES, rejectEmpty: true },
  '.pptx': { kind: 'slides_file', storage: 'bin', cap: OFFICE_MAX_BYTES, rejectEmpty: true },
  '.csv': { kind: 'sheet_file', storage: 'bin', cap: CSV_MAX_BYTES, rejectEmpty: true },
  '.tsv': { kind: 'sheet_file', storage: 'bin', cap: CSV_MAX_BYTES, rejectEmpty: true },
  '.png': { kind: 'image_file', storage: 'bin', cap: SNAPSHOT_IMAGE_MAX_BYTES, rejectEmpty: true, image: true },
  '.jpg': { kind: 'image_file', storage: 'bin', cap: SNAPSHOT_IMAGE_MAX_BYTES, rejectEmpty: true, image: true },
  '.jpeg': { kind: 'image_file', storage: 'bin', cap: SNAPSHOT_IMAGE_MAX_BYTES, rejectEmpty: true, image: true },
  '.gif': { kind: 'image_file', storage: 'bin', cap: SNAPSHOT_IMAGE_MAX_BYTES, rejectEmpty: true, image: true },
  '.webp': { kind: 'image_file', storage: 'bin', cap: SNAPSHOT_IMAGE_MAX_BYTES, rejectEmpty: true, image: true },
};

export type SnapshotFailureCode =
  | 'INVALID_PATH'
  | 'NOT_FOUND'
  | 'NOT_A_FILE'
  | 'SYMLINK_OR_LINK'
  | 'OUTSIDE_SCOPE'
  | 'NO_WRITE_EVIDENCE'
  | 'PERMISSION_READONLY'
  | 'PERMISSION_UNAVAILABLE'
  | 'PROJECT_ROOT_UNAVAILABLE'
  | 'UNSUPPORTED_TYPE'
  | 'EMPTY_FILE'
  | 'TOO_LARGE'
  | 'LIMIT_EXCEEDED'
  | 'UNREADABLE'
  | 'CHANGED_DURING_READ'
  | 'BLOB_CONFLICT'
  | 'NO_BOUND_MESSAGE'
  | 'MESSAGE_BINDING_MISMATCH'
  | 'IDENTITY_MISMATCH'
  | 'INTERNAL';

export interface SnapshotFailure {
  path: string;
  code: SnapshotFailureCode;
  /** 面向用户的中文可读原因。 */
  message: string;
  /** 是否来自正式结果显式声明（false=本 turn 变更证据的候选，失败只在审计里，不打扰用户）。 */
  declared: boolean;
}

export interface SnapshotRegistered {
  artifactId: string;
  filename: string;
  kind: KindSpec['kind'];
  hash: string;
  revision: number;
  sizeBytes: number;
  source: 'declared' | 'diff';
}

export interface SnapshotOutcome {
  status: 'registered' | 'partial' | 'no-candidates' | 'blocked';
  accessMode: 'full' | 'project-write' | 'readonly' | 'unavailable';
  registered: SnapshotRegistered[];
  failures: SnapshotFailure[];
  /** 本 turn 变更清单里因不支持/超限等被跳过的非声明候选（审计用）。 */
  skipped: string[];
}

export interface GeneratedFileSnapshotInput {
  db: ZhongshuoDatabase;
  appDataDir: string;
  projectId: string;
  projectRoot: string;
  taskId: string;
  runId: string;
  turnId: string;
  memberId: string;
  conversationId: string;
  /** 绑定的最终回复消息；为空则一律不登记（不能把文件挂到别的回复上）。 */
  messageId: string | null;
  /** TaskComplete.files 的显式路径（已通过 TaskComplete schema/resultKey 校验）。 */
  declaredFiles: readonly string[];
  /** 本 turn 已验证的 changeset 差异（相对项目根，`\` 已归一为 `/`）；无写入证据时 null。 */
  turnDiff: { added: readonly string[]; modified: readonly string[] } | null;
  /** 本次有效写权限事实（null=任务/配置不可核实——不登记，给可读状态）。 */
  access: { fullAccess: boolean; modificationAuthorized: boolean; root: string } | null;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Windows 下 realpath 大小写/短路径差异用大小写不敏感比较；其他平台精确比较。 */
function samePath(a: string, b: string): boolean {
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function within(root: string, target: string): boolean {
  const probe = process.platform === 'win32' ? target.toLowerCase() : target;
  const base = process.platform === 'win32' ? root.toLowerCase() : root;
  return probe === base || probe.startsWith(base.endsWith(sep) ? base : base + sep);
}

function normalizeRelative(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

/** 差异路径比较键：Windows 大小写不敏感，统一 `/` 分隔。 */
function diffKey(path: string): string {
  const normalized = normalizeRelative(path.trim());
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function failure(path: string, code: SnapshotFailureCode, message: string, declared: boolean): SnapshotFailure {
  return { path, code, message, declared };
}

interface Candidate {
  raw: string;
  declared: boolean;
}

function dedupeCandidates(raw: readonly string[], declared: boolean): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const value of raw) {
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    const key = process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw: trimmed, declared });
  }
  return out;
}

function kindSpecOf(filename: string): KindSpec | null {
  const name = basename(filename);
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  const known = KIND_BY_EXT[ext];
  if (known != null) return known;
  if (TEXT_PREVIEW_EXTENSIONS.has(ext)) {
    return { kind: kindForFilename(name), storage: 'txt', cap: SNAPSHOT_TEXT_MAX_BYTES, rejectEmpty: false };
  }
  return null;
}

interface BoundMessage {
  id: string;
  thread_id: string | null;
}

/**
 * 审核①：绑定消息必须属于本轮命名空间且行内归属=本 turn/project/conversation/member。
 * 在**任何文件读取之前**调用；任何不一致=不登记（不挂跨项目/跨轮附件）。
 */
function validateBoundMessage(input: GeneratedFileSnapshotInput, messageId: string): { ok: true; message: BoundMessage } | { ok: false; reason: string } {
  const delibStageMessage = messageId.startsWith('msg_delib_');
  if (!delibStageMessage && !messageId.startsWith(`msg_${input.turnId}_`)) {
    return { ok: false, reason: `回复消息 id 不属于本轮命名空间（期望 msg_${input.turnId}_… 或 msg_delib_…，实际 ${messageId}）` };
  }
  const row = input.db.prepare(
    'SELECT id, project_id, conversation_id, task_id, author_type, author_id, thread_id, status, body_json FROM messages WHERE id = ?',
  ).get(messageId) as {
    id: string; project_id: string; conversation_id: string; task_id: string | null;
    author_type: string; author_id: string; thread_id: string | null; status: string; body_json: string;
  } | undefined;
  if (row == null) return { ok: false, reason: '本轮最终回复消息不存在（可能已回滚/被清理）' };
  if (row.project_id !== input.projectId) return { ok: false, reason: '回复消息属于其他项目' };
  if (row.conversation_id !== input.conversationId) return { ok: false, reason: '回复消息属于其他会话' };
  if (row.task_id !== input.taskId) return { ok: false, reason: '回复消息属于其他任务' };
  if (row.author_type !== 'agent') return { ok: false, reason: '目标消息不是 agent 回复（不把文件挂到人类/系统消息上）' };
  if (row.author_id !== input.memberId) return { ok: false, reason: '回复消息作者不是本 turn 成员' };
  if (delibStageMessage) {
    try {
      const body = JSON.parse(row.body_json) as { collaborationStage?: { runId?: unknown; turnId?: unknown } };
      if (body.collaborationStage?.runId !== input.runId || body.collaborationStage?.turnId !== input.turnId) {
        return { ok: false, reason: '研讨阶段消息不属于本轮 run/turn' };
      }
    } catch {
      return { ok: false, reason: '研讨阶段消息缺少可核验的阶段身份' };
    }
  }
  return { ok: true, message: { id: row.id, thread_id: row.thread_id } };
}

/**
 * 审核③：受控句柄读取用户路径（打开前 lstat dev/ino ↔ fstat ↔ 读后 fstat 全对比）。
 * 返回 ok=false 时 error 已是可读失败（调用方按 declared 决定 failures/skipped）。
 */
function readUserFileControlled(
  path: string,
  cap: number,
  rejectEmpty: boolean,
): { ok: true; bytes: Buffer } | { ok: false; code: SnapshotFailureCode; message: string } {
  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? { ok: false, code: 'NOT_FOUND', message: '文件不存在或已被移走（本轮未生成）' }
      : { ok: false, code: 'UNREADABLE', message: '文件不可访问（权限/占用）——如实不可读' };
  }
  if (before.isSymbolicLink()) return { ok: false, code: 'SYMLINK_OR_LINK', message: '路径是符号链接/junction——按实际文件身份拒绝读取' };
  if (!before.isFile()) return { ok: false, code: 'NOT_A_FILE', message: '路径不是普通文件' };

  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return { ok: false, code: 'UNREADABLE', message: '文件打开失败（权限/占用）——如实不可读' };
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) return { ok: false, code: 'NOT_A_FILE', message: '打开的对象不是普通文件' };
    // 打开前 lstat 与打开后 fstat 必须同一物理对象（路径替换窗口检测）。
    if (opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs) {
      return { ok: false, code: 'CHANGED_DURING_READ', message: '打开前后文件身份/大小/修改时间不一致——拒绝用旧信息冒充当前内容，请重试' };
    }
    if (opened.size > BigInt(cap)) {
      return { ok: false, code: 'TOO_LARGE', message: `文件 ${opened.size}B 超过该类型上限 ${cap}B——未读取/未登记（原文件保留）` };
    }
    if (rejectEmpty && opened.size === 0n) return { ok: false, code: 'EMPTY_FILE', message: '空文件不能作为可打开附件' };
    const size = Number(opened.size); // 已按 cap 限幅（cap ≤ 32MiB）→ 安全转 number
    const bytes = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, bytes, read, size - read, read);
      if (n <= 0) break;
      read += n;
    }
    if (read !== size) {
      return { ok: false, code: 'CHANGED_DURING_READ', message: '读取不完整（文件在读取期间被截断/改写）——拒绝登记' };
    }
    // 读后再次 fstat：同一句柄的 dev/ino/size/mtimeNs 必须与打开时一致（读取期间变更检测）。
    const after = fstatSync(fd, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino
      || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) {
      return { ok: false, code: 'CHANGED_DURING_READ', message: '读取期间文件发生变化——拒绝用旧大小/旧 hash 冒充新内容，请重试' };
    }
    return { ok: true, bytes };
  } catch {
    return { ok: false, code: 'UNREADABLE', message: '文件读取失败（权限/占用）——如实不可读' };
  } finally {
    try { closeSync(fd); } catch { /* 尽力关闭本进程 fd */ }
  }
}

/**
 * 快照入口（同步实现：先核对绑定/权限，再受控读取并复制；调用方应在 turn 事务**之外**、
 * 后台步骤里调用，避免长阻塞关键事务）。不向外抛错——失败以可读 failures/skipped 返回，
 * 绝不影响已成功的聊天/交付。
 */
export function snapshotGeneratedFiles(input: GeneratedFileSnapshotInput): SnapshotOutcome {
  const failures: SnapshotFailure[] = [];
  const skipped: string[] = [];
  const registered: SnapshotRegistered[] = [];
  const accessMode: SnapshotOutcome['accessMode'] = input.access == null
    ? 'unavailable'
    : input.access.fullAccess ? 'full' : input.access.modificationAuthorized ? 'project-write' : 'readonly';
  const finish = (): SnapshotOutcome => {
    const status: SnapshotOutcome['status'] = registered.length > 0
      ? (failures.length === 0 ? 'registered' : 'partial')
      : failures.length > 0 ? 'blocked'
        : skipped.length > 0 ? 'partial' // 有非声明候选被跳过：只进审计，不产生用户可见失败提示
          : 'no-candidates';
    return { status, accessMode, registered, failures, skipped };
  };

  const declaredCandidates = dedupeCandidates(input.declaredFiles, true);
  const hasDeclared = declaredCandidates.length > 0;
  // 非声明候选：显式声明优先；未声明时才看本 turn 已验证的新增产物（不扫描）。
  const diffCandidates = hasDeclared || input.turnDiff == null ? [] : dedupeCandidates(input.turnDiff.added, false);

  /** 非声明候选的失败只进审计（skipped），不打扰用户。 */
  const report = (candidate: Candidate, code: SnapshotFailureCode, message: string): void => {
    if (candidate.declared) failures.push(failure(candidate.raw, code, message, true));
    else skipped.push(`${candidate.raw}：${message}`);
  };

  // 0) 没有任何候选（无声明文件且 diff 无可登记项）——绝不产生用户可见失败提示。
  if (declaredCandidates.length === 0 && diffCandidates.length === 0) return finish();

  // 1) 审核①：绑定消息在任何文件读取前核对（跨项目/跨轮/非 agent 一律拒绝）。
  const rawMessageId = input.messageId;
  if (rawMessageId == null) {
    const reason = '未找到本轮最终可见回复消息，文件不挂到其他回复上';
    if (hasDeclared) failures.push(failure('（本轮最终回复消息）', 'NO_BOUND_MESSAGE', reason, true));
    else skipped.push(`（本轮最终回复消息）：${reason}`);
    return finish();
  }
  const binding = validateBoundMessage(input, rawMessageId);
  if (!binding.ok) {
    if (hasDeclared) failures.push(failure('（本轮最终回复消息）', 'MESSAGE_BINDING_MISMATCH', binding.reason, true));
    else skipped.push(`（本轮最终回复消息）：${binding.reason}`);
    return finish();
  }
  const boundMessage = binding.message;

  // 2) 审核⑤：权限只信 worker 传入的执行时事实；不重新解释。
  if (input.access == null) {
    const reason = '本轮执行权限不可核实（任务/成员配置已变化）——不登记任何产出附件';
    if (hasDeclared) failures.push(failure('（执行权限）', 'PERMISSION_UNAVAILABLE', reason, true));
    else skipped.push(`（执行权限）：${reason}`);
    return finish();
  }
  if (accessMode === 'readonly') {
    const reason = '本轮执行权限为只读/受限——不会把只读文件当成产出附件';
    if (hasDeclared) failures.push(failure('（执行权限）', 'PERMISSION_READONLY', reason, true));
    else skipped.push(`（执行权限）：${reason}`);
    return finish();
  }
  // access.root=worker 传入的**本 turn 执行时**写入/项目根（权威 scope）；为空时才回退 projectRoot。
  const scopeRoot = input.access.root.trim().length > 0 ? input.access.root : input.projectRoot;
  if (scopeRoot.trim().length === 0) {
    const reason = '项目根路径不可用——无法核对产出范围，不登记附件';
    if (hasDeclared) failures.push(failure('（项目根）', 'PROJECT_ROOT_UNAVAILABLE', reason, true));
    else skipped.push(`（项目根）：${reason}`);
    return finish();
  }

  const candidates = hasDeclared ? declaredCandidates : diffCandidates;
  // 项目根按实际身份规范化（realpath），所有候选都用它做字符串解析基准：
  // 项目内相对路径 → 规范根内；声明绝对路径（fullAccess 项目外）→ 原样。
  const baseRoot = (() => {
    try { return realpathSync.native(resolve(scopeRoot)); } catch { return resolve(scopeRoot); }
  })();
  const diffPaths = new Set<string>();
  if (input.turnDiff != null) {
    for (const p of [...input.turnDiff.added, ...input.turnDiff.modified]) diffPaths.add(diffKey(p));
  }

  const pending: Array<SnapshotRegistered & { blobPath: string }> = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    if (pending.length >= SNAPSHOT_MAX_FILES) {
      report(candidate, 'LIMIT_EXCEEDED', `单轮最多登记 ${SNAPSHOT_MAX_FILES} 个文件；其余未登记`);
      continue;
    }
    if (candidate.raw.includes('\u0000')) {
      report(candidate, 'INVALID_PATH', '路径含非法字符');
      continue;
    }
    let target: string;
    try {
      target = resolve(baseRoot, candidate.raw);
    } catch {
      report(candidate, 'INVALID_PATH', '路径无法解析');
      continue;
    }
    // 实际文件身份：任何组件为符号链接/junction 时 realpath 与字符串解析不一致（大小写归一比较）。
    let realTarget: string;
    try {
      realTarget = realpathSync.native(target);
    } catch {
      // realpath 失败通常=不存在/不可达；lstat 的 ENOENT 分支会给更准确的可读原因。
      const pre = (() => { try { lstatSync(target); return true; } catch { return false; } })();
      report(candidate, pre ? 'UNREADABLE' : 'NOT_FOUND', pre ? '文件不可读（权限/占用）' : '文件不存在或已被移走（本轮未生成）');
      continue;
    }
    if (!samePath(realTarget, target)) {
      report(candidate, 'SYMLINK_OR_LINK', '路径含符号链接/junction——按实际文件身份拒绝读取');
      continue;
    }
    const insideRoot = within(baseRoot, realTarget);
    // 审核⑤：受限写权限只接受项目根内 + 本 turn 变更证据（added 或 modified）的路径。
    if (accessMode === 'project-write') {
      if (!insideRoot) {
        report(candidate, 'OUTSIDE_SCOPE', '超出本轮项目写入范围（受限权限下不读取项目外文件）');
        continue;
      }
      const rel = normalizeRelative(relative(baseRoot, realTarget));
      if (!diffPaths.has(diffKey(rel))) {
        report(candidate, 'NO_WRITE_EVIDENCE', '不在本 turn 实际变更范围（无写入证据，未登记为产出）');
        continue;
      }
    } else if (!candidate.declared && !insideRoot) {
      // fullAccess 下「本 turn 差异新增」候选仍必须是项目内文件（差异清单相对项目根）。
      report(candidate, 'OUTSIDE_SCOPE', '变更清单中的路径越出项目根——不登记');
      continue;
    }
    const kindSpec = kindSpecOf(realTarget);
    if (kindSpec == null) {
      report(candidate, 'UNSUPPORTED_TYPE', `不支持的文件类型（${basename(realTarget)}）——未生成附件卡，原文件不受影响`);
      continue;
    }
    // 先按 stat 预估总量上限（读取前限幅），再受控读取真实字节。
    let sizeProbe: bigint;
    try {
      sizeProbe = lstatSync(realTarget, { bigint: true }).size;
    } catch {
      report(candidate, 'UNREADABLE', '文件不可访问（权限/占用）——如实不可读');
      continue;
    }
    if (sizeProbe > BigInt(kindSpec.cap)) {
      report(candidate, 'TOO_LARGE', `文件 ${sizeProbe}B 超过该类型上限 ${kindSpec.cap}B——未读取/未登记（原文件保留）`);
      continue;
    }
    if (BigInt(totalBytes) + sizeProbe > BigInt(SNAPSHOT_MAX_TOTAL_BYTES)) {
      report(candidate, 'LIMIT_EXCEEDED', `本轮登记总量超过 ${Math.floor(SNAPSHOT_MAX_TOTAL_BYTES / 1048576)}MiB，未登记`);
      continue;
    }
    const read = readUserFileControlled(realTarget, kindSpec.cap, kindSpec.rejectEmpty);
    if (!read.ok) {
      report(candidate, read.code, read.message);
      continue;
    }
    const bytes = read.bytes;
    if (BigInt(totalBytes) + BigInt(bytes.length) > BigInt(SNAPSHOT_MAX_TOTAL_BYTES)) {
      report(candidate, 'LIMIT_EXCEEDED', `本轮登记总量超过 ${Math.floor(SNAPSHOT_MAX_TOTAL_BYTES / 1048576)}MiB，未登记`);
      continue;
    }
    if (kindSpec.image === true) {
      const meta = validateImageBuffer(bytes);
      if (!meta.ok) {
        report(candidate, 'UNSUPPORTED_TYPE', `图片内容校验失败：${meta.message}`);
        continue;
      }
    }
    const hash = sha256(bytes);
    const blobDir = join(input.appDataDir, 'blobstore');
    const blobPath = join(blobDir, `${hash}.${kindSpec.storage}`);
    // 内容寻址副本：存在则核对实际字节（副本被改写=不可覆盖冲突，如实失败）；不存在才写。
    // 这里是托管存储（非用户路径），普通读安全；用户路径必须已走上面的受控句柄读取。
    try {
      mkdirSync(blobDir, { recursive: true });
      const existingBlob = readFileSync(blobPath);
      if (sha256(existingBlob) !== hash) {
        report(candidate, 'BLOB_CONFLICT', '内容寻址副本与本次文件不一致——拒绝覆盖既有副本');
        continue;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        report(candidate, 'UNREADABLE', '既有内容寻址副本不可读——拒绝覆盖');
        continue;
      }
      try {
        atomicWriteFile(blobPath, bytes);
      } catch {
        report(candidate, 'UNREADABLE', '托管副本写入失败（磁盘/权限）——未登记');
        continue;
      }
    }
    // 路径身份：项目内=相对项目根（项目根搬移/改名后仍稳定）；项目外=实际绝对路径。
    const identityPath = insideRoot
      ? normalizeRelative(relative(baseRoot, realTarget))
      : (process.platform === 'win32' ? realTarget.toLowerCase() : realTarget);
    const pathKey = sha256(`${input.projectId}\u0000${input.taskId}\u0000${identityPath}`).slice(0, 16);
    const artifactId = `art_gf_${pathKey}_${hash.slice(0, 12)}`;
    const existing = input.db.prepare(
      'SELECT revision, hash, project_id, conversation_id, task_id, run_id, author_id FROM artifacts WHERE id = ?',
    ).get(artifactId) as {
      revision: number; hash: string; project_id: string; conversation_id: string | null;
      task_id: string | null; run_id: string | null; author_id: string;
    } | undefined;
    let revision: number;
    if (existing != null) {
      // 审核①：复用行内归属必须与本次 scope 一致（不挂跨项目/跨会话附件）。
      if (existing.hash !== hash) {
        report(candidate, 'BLOB_CONFLICT', '同路径同 hash 身份出现不同记录——拒绝以旧记录冒充');
        continue;
      }
      if (existing.project_id !== input.projectId || existing.task_id !== input.taskId
        || existing.conversation_id !== input.conversationId || existing.author_id !== input.memberId) {
        report(candidate, 'IDENTITY_MISMATCH', '既有附件记录的归属与本轮任务/会话/成员不一致——拒绝复用（不挂跨范围附件）');
        continue;
      }
      // run 归属校验：同 task 的上一轮可复用同内容 artifact（内容寻址幂等）；跨 task/未知 run 拒绝。
      if (existing.run_id != null && existing.run_id !== input.runId) {
        const owner = input.db.prepare('SELECT task_id FROM workflow_runs WHERE id = ?').get(existing.run_id) as { task_id: string } | undefined;
        if (owner?.task_id !== input.taskId) {
          report(candidate, 'IDENTITY_MISMATCH', '既有附件记录的 run 归属与本轮任务不一致——拒绝复用（不挂跨任务附件）');
          continue;
        }
      }
      revision = existing.revision;
    } else {
      const maxRow = input.db.prepare('SELECT COALESCE(MAX(revision), 0) AS n FROM artifacts WHERE id GLOB ?')
        .get(`art_gf_${pathKey}_*`) as { n: number };
      revision = maxRow.n + 1;
    }
    totalBytes += bytes.length;
    pending.push({
      artifactId,
      filename: basename(realTarget),
      kind: kindSpec.kind,
      hash,
      revision,
      sizeBytes: bytes.length,
      source: candidate.declared ? 'declared' : 'diff',
      blobPath,
    });
  }

  if (pending.length === 0) return finish();

  // 3) 小事务落库：artifacts + 绑定消息的 message_attachments（同 turn 重放幂等）。
  const now = Date.now();
  const tx = input.db.transaction(() => {
    for (const item of pending) {
      const row = input.db.prepare(
        'SELECT project_id, conversation_id, task_id, author_id FROM artifacts WHERE id = ?',
      ).get(item.artifactId) as { project_id: string; conversation_id: string | null; task_id: string | null; author_id: string } | undefined;
      if (row == null) {
        input.db.prepare(
          `INSERT INTO artifacts (id, project_id, conversation_id, thread_id, task_id, run_id, author_id, kind, revision, hash, blob_path, source_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          item.artifactId, input.projectId, input.conversationId, boundMessage.thread_id, input.taskId, input.runId,
          input.memberId, item.kind, item.revision, item.hash, item.blobPath, item.filename, now,
        );
      }
      const attachmentId = `matt_gf_${sha256(`${boundMessage.id}\u0000${item.artifactId}`).slice(0, 24)}`;
      const attached = input.db.prepare('SELECT message_id, artifact_id FROM message_attachments WHERE id = ?').get(attachmentId) as
        | { message_id: string; artifact_id: string } | undefined;
      if (attached == null) {
        input.db.prepare(
          'INSERT INTO message_attachments (id, message_id, thread_id, artifact_id, display_name, source_hash) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(attachmentId, boundMessage.id, boundMessage.thread_id, item.artifactId, item.filename, item.hash);
      } else if (attached.message_id !== boundMessage.id || attached.artifact_id !== item.artifactId) {
        throw new Error(`attachment identity mismatch: ${attachmentId}`);
      }
      registered.push({
        artifactId: item.artifactId, filename: item.filename, kind: item.kind, hash: item.hash,
        revision: item.revision, sizeBytes: item.sizeBytes, source: item.source,
      });
    }
  });
  try {
    tx();
  } catch {
    // 落库失败：不返回任何“已登记”假象；失败作为可读状态上报（已复制的 blob 为内容寻址孤儿，不构成业务附件）。
    registered.length = 0;
    failures.push(failure('（附件登记事务）', 'INTERNAL', '附件登记事务失败，未产生附件卡（原回复与交付不受影响）', true));
  }
  return finish();
}
