/**
 * R91 生成文件快照（后端 helper + 真实派发链）——Codex 审核①~⑥回归。
 *
 * 全部使用**临时合成目录/合成文件**（临时项目根、临时 appData、临时 xlsx/csv/txt 字节），
 * 不读用户真实数据、不开 GUI、不调用真模型（fake runtime + ZS_ALLOW_FAKE）。
 *
 * 覆盖：
 * ① 消息绑定先于任何文件读取：本轮命名空间/项目/会话/任务/author=本 turn 成员；artifact
 *    复用无跨项目/跨会话附件；
 * ② Office/PDF/CSV 走既有 parser 缓存路径：真实 xlsx/csv/txt 经生产链登记后，previewText /
 *    previewOffice（sourceFormat/sheets）可读，首次预览把解析缓存回写 artifacts.extracted_text_json，
 *    originalFile 字节 sha256 与原文件一致；坏 xlsx 预览如实 extraction:'failed'（不冒充可打开）；
 * ③ 用户路径受控 fd 读取（helper 级 CHANGED 检测路径不伪造成功——见 helper 实现；生产链
 *    断言真实字节/hash 一致）；
 * ④ 结构化终态仅 turn.completed（无 message.completed）时用已验证 TaskComplete 生成最终可见
 *    回复，附件只挂该回复；声明文件不存在/越界/不支持类型=原回复仍成功、零伪造附件、失败
 *    汇总成一条可读 system 消息；
 * ⑤ helper 级权限矩阵（fullAccess 项目外 / 受限根内+diff / readonly/null 不登记）+
 *    生产链 fullAccess 项目外文件成功快照（audit accessMode='full'）；
 * ⑥ no-candidates 不产生用户可见失败；非声明 diff 候选失败只进 skipped（生产链 system
 *    提示只在 failures.length>0 时出现）。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { snapshotGeneratedFiles } from '../../src/daemon/generatedFileSnapshots.ts';
import type { GeneratedFileSnapshotInput } from '../../src/daemon/generatedFileSnapshots.ts';
import { validateExtractCache } from '../../src/daemon/parseContracts.ts';
import { disposeParsePool } from '../../src/daemon/parsePool.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';
import type { NormalizedRuntimeEvent, SessionRef } from '../../src/contracts/runtime.ts';

// 隔离环境：只允许 fake runtime；显式临时 appData（不回落环境/工程 cwd）；不启用真实派发防护。
process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_REAL_BATCH_ID;
delete process.env.ZS_APP_DATA;

const tmpRoots: string[] = [];
const openDbs: ZhongshuoDatabase[] = [];
const trackRoot = (root: string): string => { tmpRoots.push(root); return root; };
const trackDb = (db: ZhongshuoDatabase): ZhongshuoDatabase => { openDbs.push(db); return db; };

afterAll(async () => {
  await disposeParsePool();
  for (const db of openDbs.splice(0)) { try { db.close(); } catch { /* 已关闭 */ } }
  for (const root of tmpRoots.splice(0)) {
    for (let i = 0; i < 5; i += 1) {
      try { rmSync(root, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ }
    }
  }
});

const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');

const taskCompleteJson = (input: {
  files: string[];
  changeSummary?: string;
  answer?: string;
  responseKind?: 'work' | 'conversation';
}): string => JSON.stringify({
  schemaVersion: TASK_COMPLETE_SCHEMA_VERSION,
  resultKey: 'result_placeholder_overridden_by_fake',
  responseKind: input.responseKind ?? 'work',
  answer: input.answer ?? '已生成本轮产出',
  changeSummary: input.changeSummary ?? '完成合成工程交付',
  files: input.files,
  executedVerifications: [],
  unexecutedVerifications: [],
  remainingIssues: [],
});

interface CommandRawResult { ok: boolean; data?: unknown; error?: { code: string; message: string } }

function expectOkData<T>(raw: CommandRawResult, context: string): T {
  if (raw.ok !== true) throw new Error(`${context} 失败：${JSON.stringify(raw.error)}`);
  return raw.data as T;
}

/* ============================================================
   helper 级：合成 DB/目录（不经 worker——权限矩阵/绑定/幂等/版本）
   ============================================================ */

interface HelperEnv {
  root: string;
  projectRoot: string;
  outsideDir: string;
  appData: string;
  db: ZhongshuoDatabase;
  projectId: string;
  conversationId: string;
  taskId: string;
  runId: string;
  turnId: string;
  memberId: string;
  addMessage: (id: string, opts?: {
    authorType?: string; authorId?: string; projectId?: string; conversationId?: string; taskId?: string | null;
  }) => void;
  input: (overrides?: Partial<GeneratedFileSnapshotInput>) => GeneratedFileSnapshotInput;
  close: () => void;
}

function makeHelperEnv(): HelperEnv {
  const root = trackRoot(mkdtempSync(join(tmpdir(), 'zs-r91-helper-')));
  const projectRoot = join(root, 'proj');
  const outsideDir = join(root, 'outside');
  const appData = join(root, 'app-data');
  for (const dir of [projectRoot, outsideDir, appData]) mkdirSync(dir, { recursive: true });
  const projectRootCanonical = realpathSync.native(projectRoot);
  const db = trackDb(openDatabase(join(appData, 'state.sqlite')));
  const projectId = 'p_h';
  const conversationId = 'conv_h';
  const taskId = 'task_h';
  const runId = 'run_h';
  const turnId = 'turn_h';
  const memberId = 'm_h';
  db.prepare('INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(projectId, 'helper-project', projectRootCanonical, projectRootCanonical, '{}', 0);
  db.prepare("INSERT INTO conversations (id, project_id, kind, room_id, last_message_seq) VALUES (?, ?, 'dm', NULL, 0)").run(conversationId, projectId);
  let seq = 0;
  const addMessage: HelperEnv['addMessage'] = (id, opts = {}) => {
    seq += 1;
    db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, task_id,
        thread_message_seq, author_type, author_id, body_json, status, created_at)
      VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?, 'final', ?)`).run(
      id,
      opts.projectId ?? projectId,
      opts.conversationId ?? conversationId,
      seq,
      opts.taskId === undefined ? taskId : opts.taskId,
      opts.authorType ?? 'agent',
      opts.authorId ?? memberId,
      JSON.stringify({ text: '合成最终回复' }),
      Date.now(),
    );
  };
  const input: HelperEnv['input'] = (overrides = {}) => ({
    db,
    appDataDir: appData,
    projectId,
    projectRoot: projectRootCanonical,
    taskId,
    runId,
    turnId,
    memberId,
    conversationId,
    messageId: null,
    declaredFiles: [],
    turnDiff: null,
    access: { fullAccess: true, modificationAuthorized: true, root: projectRootCanonical },
    ...overrides,
  });
  return {
    root, projectRoot: projectRootCanonical, outsideDir, appData, db, projectId, conversationId, taskId, runId, turnId, memberId,
    addMessage, input, close: () => { try { db.close(); } catch { /* 已关闭 */ } },
  };
}

const artifactRowsFor = (env: HelperEnv): Array<{
  id: string; project_id: string; conversation_id: string | null; task_id: string | null;
  run_id: string | null; author_id: string; kind: string; revision: number; hash: string; blob_path: string; source_name: string | null;
}> => env.db.prepare('SELECT id, project_id, conversation_id, task_id, run_id, author_id, kind, revision, hash, blob_path, source_name FROM artifacts ORDER BY rowid').all() as never;

const attachmentsOf = (env: HelperEnv, messageId: string): Array<{ id: string; artifact_id: string; display_name: string; source_hash: string }> =>
  env.db.prepare('SELECT id, artifact_id, display_name, source_hash FROM message_attachments WHERE message_id = ? ORDER BY rowid').all(messageId) as never;

describe('R91 helper：权限矩阵 / 消息绑定 / 幂等版本（合成目录）', () => {
  it('权限矩阵：fullAccess 可项目外；受限只收根内+本 turn diff；readonly/null 不登记产出', () => {
    const env = makeHelperEnv();
    try {
      env.addMessage('msg_turn_h_full');
      env.addMessage('msg_turn_h_pw');
      env.addMessage('msg_turn_h_ro');
      env.addMessage('msg_turn_h_na');
      const outsideFile = join(env.outsideDir, '外部交付.txt');
      writeFileSync(outsideFile, 'FULL-ACCESS-OUTSIDE-第1行\n', 'utf8');
      const insideFile = join(env.projectRoot, '根内新增.txt');
      writeFileSync(insideFile, 'PROJECT-WRITE-产品\n', 'utf8');
      writeFileSync(join(env.projectRoot, '根内未变更.txt'), 'NO-DIFF-EVIDENCE\n', 'utf8');

      // ① fullAccess：显式项目外路径成功登记（不需要 diff 证据）。
      const full = snapshotGeneratedFiles(env.input({
        messageId: 'msg_turn_h_full',
        declaredFiles: [outsideFile],
        access: { fullAccess: true, modificationAuthorized: true, root: env.projectRoot },
      }));
      expect(full.failures).toEqual([]);
      expect(full.status).toBe('registered');
      expect(full.accessMode).toBe('full');
      expect(full.registered).toHaveLength(1);
      expect(full.registered[0]!.filename).toBe('外部交付.txt');
      expect(full.registered[0]!.source).toBe('declared');
      expect(full.registered[0]!.hash).toBe(sha256(readFileSync(outsideFile)));
      expect(full.registered[0]!.sizeBytes).toBe(readFileSync(outsideFile).length);
      const fullArtifact = artifactRowsFor(env).find((row) => row.id === full.registered[0]!.artifactId);
      expect(fullArtifact).toBeDefined();
      expect(fullArtifact!.project_id).toBe(env.projectId);
      expect(fullArtifact!.task_id).toBe(env.taskId);
      expect(fullArtifact!.conversation_id).toBe(env.conversationId);
      expect(fullArtifact!.author_id).toBe(env.memberId);
      expect(fullArtifact!.run_id).toBe(env.runId);
      expect(readFileSync(fullArtifact!.blob_path)).toEqual(readFileSync(outsideFile));
      expect(attachmentsOf(env, 'msg_turn_h_full')).toHaveLength(1);

      // ② project-write（modificationAuthorized && !fullAccess）：只收项目根内且 turnDiff 含该相对路径。
      const pw = snapshotGeneratedFiles(env.input({
        messageId: 'msg_turn_h_pw',
        declaredFiles: [insideFile, join(env.projectRoot, '根内未变更.txt'), outsideFile],
        turnDiff: { added: ['根内新增.txt'], modified: [] },
        access: { fullAccess: false, modificationAuthorized: true, root: env.projectRoot },
      }));
      expect(pw.accessMode).toBe('project-write');
      expect(pw.registered).toHaveLength(1);
      expect(pw.registered[0]!.filename).toBe('根内新增.txt');
      const codes = pw.failures.map((f) => f.code);
      expect(codes).toContain('NO_WRITE_EVIDENCE'); // 根内但本 turn 无变更证据
      expect(codes).toContain('OUTSIDE_SCOPE'); // 项目外（受限权限不读）
      expect(pw.failures.every((f) => f.declared)).toBe(true);
      expect(pw.failures.find((f) => f.code === 'NO_WRITE_EVIDENCE')!.message).toContain('变更');
      expect(attachmentsOf(env, 'msg_turn_h_pw')).toHaveLength(1);

      // ③ readonly：不登记任何产出（显式声明失败给用户可读原因）。
      const ro = snapshotGeneratedFiles(env.input({
        messageId: 'msg_turn_h_ro',
        declaredFiles: [insideFile],
        access: { fullAccess: false, modificationAuthorized: false, root: env.projectRoot },
      }));
      expect(ro.registered).toEqual([]);
      expect(ro.status).toBe('blocked');
      expect(ro.failures.map((f) => f.code)).toContain('PERMISSION_READONLY');
      expect(ro.failures.every((f) => f.declared)).toBe(true);
      expect(attachmentsOf(env, 'msg_turn_h_ro')).toHaveLength(0);

      // ④ 权限不可核实（null）：同样不登记，但原因分列。
      const na = snapshotGeneratedFiles(env.input({
        messageId: 'msg_turn_h_na',
        declaredFiles: [insideFile],
        access: null,
      }));
      expect(na.registered).toEqual([]);
      expect(na.status).toBe('blocked');
      expect(na.failures.map((f) => f.code)).toContain('PERMISSION_UNAVAILABLE');
      expect(attachmentsOf(env, 'msg_turn_h_na')).toHaveLength(0);
      // 全程只有 full/pw 两件被登记，没有跨消息/跨范围附件。
      expect(artifactRowsFor(env)).toHaveLength(2);
      expect(env.db.prepare('SELECT count(*) AS c FROM message_attachments').get()).toMatchObject({ c: 2 });
    } finally { env.close(); }
  });

  it('消息绑定先于读取：跨项目/跨任务/非 agent/非本轮命名空间一律不登记（不产生 artifact）', () => {
    const env = makeHelperEnv();
    try {
      // 另一项目 + 其会话（用于跨项目消息）。
      env.db.prepare('INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('p_other', 'other', env.projectRoot, env.projectRoot, '{}', 0);
      env.db.prepare("INSERT INTO conversations (id, project_id, kind, room_id, last_message_seq) VALUES ('conv_other', 'p_other', 'dm', NULL, 0)").run();
      env.addMessage('msg_turn_h_otherproj', { projectId: 'p_other', conversationId: 'conv_other' });
      env.addMessage('msg_turn_h_othertask', { taskId: 'task_other' });
      env.addMessage('msg_turn_h_system', { authorType: 'system', authorId: 'system:x' });
      env.addMessage('msg_turn_h_othermember', { authorId: 'm_other' });
      const file = join(env.projectRoot, '可登记文件.txt');
      writeFileSync(file, 'BINDING-MUST-BLOCK\n', 'utf8');
      const cases: Array<{ messageId: string; expected: string }> = [
        { messageId: 'msg_turn_h_otherproj', expected: '其他项目' },
        { messageId: 'msg_turn_h_othertask', expected: '其他任务' },
        { messageId: 'msg_turn_h_system', expected: '不是 agent' },
        { messageId: 'msg_turn_h_othermember', expected: '作者不是本 turn 成员' },
        { messageId: 'msg_other_turn_namespace', expected: '命名空间' },
      ];
      for (const testCase of cases) {
        const outcome = snapshotGeneratedFiles(env.input({ messageId: testCase.messageId, declaredFiles: [file] }));
        expect(outcome.status).toBe('blocked');
        expect(outcome.registered).toEqual([]);
        expect(outcome.failures).toHaveLength(1);
        expect(outcome.failures[0]!.declared).toBe(true);
        expect(outcome.failures[0]!.message).toContain(testCase.expected);
        expect(attachmentsOf(env, testCase.messageId)).toHaveLength(0);
      }
      // 无绑定消息且只有 diff 候选：不产生用户可见失败（本轮消息缺失属于内部状态）。
      const noBound = snapshotGeneratedFiles(env.input({ messageId: null, declaredFiles: [], turnDiff: { added: ['可登记文件.txt'], modified: [] } }));
      expect(noBound.failures).toEqual([]);
      expect(noBound.skipped).toHaveLength(1);
      // 任何失败路径都没有读取/复制文件、没有 artifact/附件行。
      expect(artifactRowsFor(env)).toHaveLength(0);
      expect(env.db.prepare('SELECT count(*) AS c FROM message_attachments').get()).toMatchObject({ c: 0 });
    } finally { env.close(); }
  });

  it('幂等与版本：同 turn 重放复用同一行/关联；同路径新内容=新 id/新 revision，旧消息仍指旧版本', () => {
    const env = makeHelperEnv();
    try {
      const file = join(env.projectRoot, '版本文件.txt');
      writeFileSync(file, 'VERSION-A-第一版\n', 'utf8');
      env.addMessage('msg_turn_h_v1');
      env.addMessage('msg_turn_h_v2');
      const first = snapshotGeneratedFiles(env.input({ messageId: 'msg_turn_h_v1', declaredFiles: ['版本文件.txt'] }));
      expect(first.status).toBe('registered');
      expect(first.registered).toHaveLength(1);
      const artA = first.registered[0]!;
      expect(artA.revision).toBe(1);
      const hashA = sha256('VERSION-A-第一版\n');
      expect(artA.hash).toBe(hashA);

      // 同 turn 重放：同一 artifact 行 + 同一 message_attachment（不重复）。
      const replay = snapshotGeneratedFiles(env.input({ messageId: 'msg_turn_h_v1', declaredFiles: ['版本文件.txt'] }));
      expect(replay.status).toBe('registered');
      expect(replay.registered[0]!.artifactId).toBe(artA.artifactId);
      expect(replay.registered[0]!.revision).toBe(artA.revision);
      expect(artifactRowsFor(env)).toHaveLength(1);
      expect(attachmentsOf(env, 'msg_turn_h_v1')).toHaveLength(1);

      // 同路径新内容（下一轮/另一条最终回复）：新 id、revision+1；旧消息仍指旧版本。
      writeFileSync(file, 'VERSION-B-第二版内容更长\n', 'utf8');
      const second = snapshotGeneratedFiles(env.input({ messageId: 'msg_turn_h_v2', declaredFiles: ['版本文件.txt'] }));
      expect(second.status).toBe('registered');
      const artB = second.registered[0]!;
      expect(artB.artifactId).not.toBe(artA.artifactId);
      expect(artB.hash).toBe(sha256('VERSION-B-第二版内容更长\n'));
      expect(artB.revision).toBe(2);
      const attachmentsV1 = attachmentsOf(env, 'msg_turn_h_v1');
      const attachmentsV2 = attachmentsOf(env, 'msg_turn_h_v2');
      expect(attachmentsV1).toHaveLength(1);
      expect(attachmentsV2).toHaveLength(1);
      expect(attachmentsV1[0]!.artifact_id).toBe(artA.artifactId);
      expect(attachmentsV1[0]!.source_hash).toBe(hashA); // 旧消息仍指旧版本
      expect(attachmentsV2[0]!.artifact_id).toBe(artB.artifactId);
      const rows = artifactRowsFor(env);
      expect(rows).toHaveLength(2);
      const rowA = rows.find((r) => r.id === artA.artifactId)!;
      const rowB = rows.find((r) => r.id === artB.artifactId)!;
      expect(readFileSync(rowA.blob_path)).toEqual(Buffer.from('VERSION-A-第一版\n'));
      expect(readFileSync(rowB.blob_path)).toEqual(Buffer.from('VERSION-B-第二版内容更长\n'));
    } finally { env.close(); }
  });

  it('artifact 复用归属校验：行内 project/task/conversation/author 与本轮 scope 不一致=失败，不挂附件', () => {
    const env = makeHelperEnv();
    try {
      env.db.prepare('INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('p_other', 'other', env.projectRoot, env.projectRoot, '{}', 0);
      env.addMessage('msg_turn_h_reuse');
      writeFileSync(join(env.projectRoot, '复用文件.txt'), 'REUSE-OWNERSHIP\n', 'utf8');
      const first = snapshotGeneratedFiles(env.input({ messageId: 'msg_turn_h_reuse', declaredFiles: ['复用文件.txt'] }));
      expect(first.status).toBe('registered');
      const artifactId = first.registered[0]!.artifactId;
      // 人为把既有 artifact 行的归属改到别的项目/任务/成员（模拟错误复用/越权行）。
      env.db.prepare("UPDATE artifacts SET project_id = 'p_other', task_id = 'task_other', conversation_id = 'conv_other', author_id = 'm_other' WHERE id = ?").run(artifactId);
      const replay = snapshotGeneratedFiles(env.input({ messageId: 'msg_turn_h_reuse', declaredFiles: ['复用文件.txt'] }));
      expect(replay.registered).toEqual([]);
      expect(replay.status).toBe('blocked');
      expect(replay.failures).toHaveLength(1);
      expect(replay.failures[0]!.code).toBe('IDENTITY_MISMATCH');
      expect(replay.failures[0]!.declared).toBe(true);
      // 没有新增附件行（旧行保持原样，不把越权 artifact 挂到本轮消息）。
      expect(attachmentsOf(env, 'msg_turn_h_reuse')).toHaveLength(1);
      expect(env.db.prepare('SELECT count(*) AS c FROM message_attachments').get()).toMatchObject({ c: 1 });
    } finally { env.close(); }
  });

  it('no-candidates 与 diff-only 失败：不产生用户可见失败，非声明候选只进 skipped', () => {
    const env = makeHelperEnv();
    try {
      env.addMessage('msg_turn_h_nc');
      env.addMessage('msg_turn_h_diff');
      // 无声明文件且 diff 无候选：静默（worker 不应发 system 提示）。
      const none = snapshotGeneratedFiles(env.input({ messageId: 'msg_turn_h_nc', declaredFiles: [], turnDiff: null }));
      expect(none.status).toBe('no-candidates');
      expect(none.failures).toEqual([]);
      expect(none.skipped).toEqual([]);
      // diff 候选失败：失败只进 skipped（审计），failures 为空（用户不会被提示）。
      const diffFail = snapshotGeneratedFiles(env.input({
        messageId: 'msg_turn_h_diff',
        declaredFiles: [],
        turnDiff: { added: ['不存在的差异文件.txt'], modified: [] },
      }));
      expect(diffFail.failures).toEqual([]);
      expect(diffFail.skipped).toHaveLength(1);
      expect(diffFail.skipped[0]).toContain('不存在的差异文件.txt');
      expect(diffFail.registered).toEqual([]);
      expect(diffFail.status).not.toBe('blocked');
      // 非声明的「坏内容」也不登记（png magic 校验失败），同样只进 skipped。
      writeFileSync(join(env.projectRoot, '坏图.png'), 'THIS-IS-NOT-A-PNG', 'utf8');
      const badImage = snapshotGeneratedFiles(env.input({
        messageId: 'msg_turn_h_diff',
        declaredFiles: [],
        turnDiff: { added: ['坏图.png'], modified: [] },
      }));
      expect(badImage.registered).toEqual([]);
      expect(badImage.failures).toEqual([]);
      expect(badImage.skipped.join('\n')).toContain('坏图.png');
      expect(attachmentsOf(env, 'msg_turn_h_diff')).toHaveLength(0);
      expect(artifactRowsFor(env)).toHaveLength(0);
    } finally { env.close(); }
  });
});

/* ============================================================
   生产链：commands + DispatchWorker + FakeRuntimeAdapter（临时项目/appData）
   ============================================================ */

interface ProdEnv {
  root: string;
  data: string;
  projectRoot: string;
  db: ZhongshuoDatabase;
  projectId: string;
  memberId: string;
  roomId: string;
  roomConversationId: string;
  raw: (method: string, params: unknown) => Promise<CommandRawResult>;
  cmd: <T>(method: string, params: unknown) => Promise<T>;
  setMemberPermission: (permissionMode: string) => Promise<void>;
  grantWriteAccess: (authorized: boolean) => Promise<void>;
  submit: (body?: string) => Promise<{ taskId: string; threadId: string; messageId: string }>;
  drain: (adapter: FakeRuntimeAdapter) => Promise<void>;
  turnOf: (taskId: string) => { turnId: string; runId: string; memberId: string; status: string } | undefined;
  threadOf: (taskId: string) => string;
  finalAgentMessages: (taskId: string) => Array<{ id: string; author_type: string; author_id: string; body_json: string; status: string }>;
  close: () => void;
}

async function makeProdEnv(permissionMode: string): Promise<ProdEnv> {
  const root = trackRoot(mkdtempSync(join(tmpdir(), 'zs-r91-prod-')));
  const data = join(root, 'data');
  const projectRoot = join(root, '项目');
  mkdirSync(data, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const db = trackDb(openDatabase(join(data, 'state.sqlite')));
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: data };
  const raw = async (method: string, params: unknown): Promise<CommandRawResult> =>
    await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `r91-${randomUUID()}`, method, params }) as CommandRawResult;
  const cmd = async <T>(method: string, params: unknown): Promise<T> => expectOkData<T>(await raw(method, params), method);
  const opened = await cmd<{ project: { id: string } }>('project.open', { path: projectRoot });
  const projectId = opened.project.id;
  const memberId = (await cmd<{ memberId: string }>('member.create', { projectId, displayName: '工程成员' })).memberId;
  const setMemberPermission = async (mode: string): Promise<void> => {
    await cmd('member.setRuntime', { memberId, kind: 'fake', permissionMode: mode });
  };
  await setMemberPermission(permissionMode);
  const room = (await cmd<{ items: Array<{ id: string; conversationId: string }> }>('room.list', { projectId })).items[0]!;
  const grantWriteAccess = async (authorized: boolean): Promise<void> => {
    const current = await cmd<{ revision: number; authorized: boolean }>('project.writeAccess.get', { projectId });
    await cmd('project.writeAccess.set', { projectId, authorized, expectedRevision: current.revision });
  };
  const submit = async (body = '合成工程任务'): Promise<{ taskId: string; threadId: string; messageId: string }> =>
    await cmd<{ taskId: string; threadId: string; messageId: string }>('message.submit', {
      target: { kind: 'room_root', projectId, roomId: room.id, conversationId: room.conversationId },
      body,
      intent: 'default',
      mentions: [{ kind: 'member', memberId }],
    });
  const drain = async (adapter: FakeRuntimeAdapter): Promise<void> => {
    const worker = new DispatchWorker({ db, adapter, leaseOwner: `r91-${randomUUID().slice(0, 8)}`, appDataDir: data });
    for (let i = 0; i < 10; i += 1) {
      if (!(await worker.runOnce())) break;
    }
  };
  const turnOf: ProdEnv['turnOf'] = (taskId) => db.prepare(
    `SELECT a.id AS turnId, a.run_id AS runId, a.member_id AS memberId, a.status AS status
     FROM agent_turns a JOIN workflow_runs r ON r.id = a.run_id WHERE r.task_id = ? ORDER BY a.rowid DESC LIMIT 1`,
  ).get(taskId) as { turnId: string; runId: string; memberId: string; status: string } | undefined;
  const threadOf: ProdEnv['threadOf'] = (taskId) => (db.prepare('SELECT conversation_thread_id AS t FROM tasks WHERE id = ?').get(taskId) as { t: string }).t;
  const finalAgentMessages: ProdEnv['finalAgentMessages'] = (taskId) => db.prepare(
    "SELECT id, author_type, author_id, body_json, status FROM messages WHERE task_id = ? AND author_type = 'agent' ORDER BY rowid",
  ).all(taskId) as never;
  return {
    root, data, projectRoot, db, projectId, memberId, roomId: room.id, roomConversationId: room.conversationId,
    raw, cmd, setMemberPermission, grantWriteAccess, submit, drain, turnOf, threadOf, finalAgentMessages,
    close: () => { try { db.close(); } catch { /* 已关闭 */ } },
  };
}

const attachmentRowsOf = (env: ProdEnv, messageId: string): Array<{
  id: string; message_id: string; artifact_id: string; display_name: string; source_hash: string;
  kind: string; revision: number; hash: string; blob_path: string; source_name: string | null; extracted_text_json: string | null;
}> => env.db.prepare(
  `SELECT ma.id, ma.message_id, ma.artifact_id, ma.display_name, ma.source_hash,
          a.kind, a.revision, a.hash, a.blob_path, a.source_name, a.extracted_text_json
   FROM message_attachments ma JOIN artifacts a ON a.id = ma.artifact_id
   WHERE ma.message_id = ? ORDER BY ma.rowid`,
).all(messageId) as never;

const auditSnapshotOf = (env: ProdEnv, turnId: string): {
  status: string; accessMode: string;
  registered: Array<{ artifactId: string; filename: string; kind: string; hash: string; bytes: number; source: string }>;
  failures: Array<{ path: string; code: string; message: string; declared: boolean }>;
  skipped: string[];
} | undefined => {
  const row = env.db.prepare(
    "SELECT payload_json FROM domain_events WHERE kind = 'turn.generatedFileSnapshot' AND turn_id = ? ORDER BY seq DESC LIMIT 1",
  ).get(turnId) as { payload_json: string } | undefined;
  return row == null ? undefined : JSON.parse(row.payload_json) as never;
};

describe('R91 生产链：真实 xlsx/csv/txt 快照与既有预览/原件通道', () => {
  it('真实 xlsx+csv+txt：只挂本轮最终回复；previewText/previewOffice 可读并回写解析缓存；originalFile 字节 sha256 一致', async () => {
    const env = await makeProdEnv('acceptEdits');
    try {
      await env.grantWriteAccess(true); // project-write：本 turn 显式文件=项目内且 diff 有新增证据
      const XLSX = await import('xlsx');
      const workbook = XLSX.utils.book_new();
      const sheet = XLSX.utils.aoa_to_sheet([['名称', '数量', '备注'], ['甲', 1, '第一行'], ['乙', 2, '第二行']]);
      XLSX.utils.book_append_sheet(workbook, sheet, '数据');
      const xlsxBytes = Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Uint8Array);
      const csvText = '名称,数量,备注\n甲,1,第一行\n乙,2,第二行\n';
      const txtText = 'R91 生成文本\n第二行暗号 TXT-9090\n';
      const script: FakeTurnScript = [
        { kind: 'writeFile', path: '数据表.xlsx', contentBase64: xlsxBytes.toString('base64') },
        { kind: 'writeFile', path: '清单.csv', content: csvText },
        { kind: 'writeFile', path: '说明.txt', content: txtText },
        { kind: 'event', event: { kind: 'turn.completed', finalText: taskCompleteJson({ files: ['数据表.xlsx', '清单.csv', '说明.txt'] }) } },
      ];
      const submitted = await env.submit('生成三份真实文件');
      await env.drain(new FakeRuntimeAdapter({ turnScripts: [script] }));

      const turn = env.turnOf(submitted.taskId)!;
      expect(turn.status).toBe('SUCCEEDED');
      const finalMessages = env.finalAgentMessages(submitted.taskId);
      expect(finalMessages).toHaveLength(1);
      const finalId = finalMessages[0]!.id;
      expect(finalId).toBe(`msg_${turn.turnId}_final_result`); // 本轮 message.completed 绑定消息
      expect(finalMessages[0]!.author_id).toBe(env.memberId);
      expect(finalMessages[0]!.status).toBe('final');

      // 快照阶段不解析、不伪造 extracted_text_json；只登记真实字节。
      const artifacts = attachmentRowsOf(env, finalId);
      expect(artifacts).toHaveLength(3);
      const byName = new Map(artifacts.map((a) => [a.display_name, a]));
      const expected: Array<{ name: string; bytes: Buffer; kind: string; storage: 'txt' | 'bin' }> = [
        { name: '数据表.xlsx', bytes: xlsxBytes, kind: 'sheet_file', storage: 'bin' },
        { name: '清单.csv', bytes: Buffer.from(csvText, 'utf8'), kind: 'sheet_file', storage: 'bin' },
        { name: '说明.txt', bytes: Buffer.from(txtText, 'utf8'), kind: 'text_file', storage: 'txt' },
      ];
      for (const item of expected) {
        const row = byName.get(item.name);
        expect(row, `附件 ${item.name} 应存在`).toBeDefined();
        expect(row!.kind).toBe(item.kind);
        expect(row!.hash).toBe(sha256(item.bytes));
        expect(row!.source_hash).toBe(sha256(item.bytes));
        expect(row!.source_name).toBe(item.name);
        expect(row!.extracted_text_json).toBeNull(); // 未预填缓存：由预览走既有 parser 路径
        const expectedBlob = join(env.data, 'blobstore', `${sha256(item.bytes)}.${item.storage}`);
        expect(row!.blob_path).toBe(expectedBlob);
        expect(existsSync(expectedBlob)).toBe(true);
        expect(readFileSync(expectedBlob)).toEqual(item.bytes);
      }
      // 附件只挂本轮最终回复，不挂别的消息（根消息/其他回复零附件）。
      expect(env.db.prepare('SELECT count(*) AS c FROM message_attachments WHERE message_id != ?').get(finalId)).toMatchObject({ c: 0 });
      const history = await env.cmd<{ items: Array<{ id: string; attachments: Array<{ artifactId: string; filename: string; kind: string; sizeBytes?: number }> }>; rootAttachments: unknown[] }>(
        'thread.history', { threadId: env.threadOf(submitted.taskId) },
      );
      expect(history.rootAttachments).toEqual([]);
      const finalHistory = history.items.find((item) => item.id === finalId)!;
      expect(finalHistory.attachments).toHaveLength(3);
      for (const item of expected) {
        const summary = finalHistory.attachments.find((a) => a.filename === item.name)!;
        expect(summary.kind).toBe(item.kind);
        expect(summary.sizeBytes).toBe(item.bytes.length);
      }

      // 文本附件：previewText 走既有完整性读取链。
      const txtArtifact = byName.get('说明.txt')!;
      const previewText = expectOkData<{ text: string; hash: string; originalBytes: number }>(
        await env.raw('attachment.previewText', { attachmentId: txtArtifact.artifact_id }), 'attachment.previewText',
      );
      expect(previewText.text).toBe(txtText);
      expect(previewText.hash).toBe(txtArtifact.hash);
      expect(previewText.originalBytes).toBe(Buffer.byteLength(txtText));

      // XLSX：previewOffice 首次解析并回写 extracted_text_json（既有 ensureDocumentCache 路径）。
      const xlsxArtifact = byName.get('数据表.xlsx')!;
      const xlsxPreview = expectOkData<{ sourceFormat: string; sheets: Array<{ name: string; cells: string[][] }>; hash: string }>(
        await env.raw('attachment.previewOffice', { attachmentId: xlsxArtifact.artifact_id }), 'attachment.previewOffice(xlsx)',
      );
      expect(xlsxPreview.sourceFormat).toBe('xlsx');
      expect(xlsxPreview.sheets.length).toBeGreaterThanOrEqual(1);
      expect(xlsxPreview.sheets[0]!.name).toBe('数据');
      expect(xlsxPreview.sheets[0]!.cells.flat()).toContain('甲');
      const xlsxCacheRow = env.db.prepare('SELECT extracted_text_json FROM artifacts WHERE id = ?').get(xlsxArtifact.artifact_id) as { extracted_text_json: string | null };
      expect(xlsxCacheRow.extracted_text_json).not.toBeNull();
      expect(validateExtractCache(xlsxCacheRow.extracted_text_json, xlsxArtifact.hash, 'sheet')).not.toBeNull();

      // CSV：sheet_file 按 source_name 选择既有 csv parser，同样回写缓存。
      const csvArtifact = byName.get('清单.csv')!;
      const csvPreview = expectOkData<{ sourceFormat: string; sheets: Array<{ name: string; cells: string[][] }>; encoding: string }>(
        await env.raw('attachment.previewOffice', { attachmentId: csvArtifact.artifact_id }), 'attachment.previewOffice(csv)',
      );
      expect(csvPreview.sourceFormat).toBe('csv');
      expect(csvPreview.sheets).toHaveLength(1);
      expect(csvPreview.sheets[0]!.name).toBe('CSV');
      expect(csvPreview.sheets[0]!.cells.flat()).toContain('甲');
      const csvCacheRow = env.db.prepare('SELECT extracted_text_json FROM artifacts WHERE id = ?').get(csvArtifact.artifact_id) as { extracted_text_json: string | null };
      expect(csvCacheRow.extracted_text_json).not.toBeNull();
      expect(validateExtractCache(csvCacheRow.extracted_text_json, csvArtifact.hash, 'sheet')).not.toBeNull();

      // originalFile：附件原件字节 sha256 == 原文件 sha256（逐字节）。
      for (const item of expected) {
        const row = byName.get(item.name)!;
        const original = expectOkData<{ bytes: number; bytesBase64: string; hash: string; filename: string }>(
          await env.raw('attachment.originalFile', { attachmentId: row.artifact_id }), `attachment.originalFile(${item.name})`,
        );
        const bytes = Buffer.from(original.bytesBase64, 'base64');
        expect(original.filename).toBe(item.name);
        expect(original.hash).toBe(sha256(item.bytes));
        expect(bytes.length).toBe(item.bytes.length);
        expect(sha256(bytes)).toBe(sha256(item.bytes));
        expect(bytes).toEqual(item.bytes);
      }

      const audit = auditSnapshotOf(env, turn.turnId)!;
      expect(audit).toBeDefined();
      expect(audit.status).toBe('registered');
      expect(audit.registered).toHaveLength(3);
      expect(audit.failures).toEqual([]);
    } finally { env.close(); }
  }, 120_000);

  it('坏 xlsx：登记原件但不冒充可打开——previewOffice 如实 extraction:failed、零 sheets 缓存', async () => {
    const env = await makeProdEnv('acceptEdits');
    try {
      await env.grantWriteAccess(true); // project-write：本 turn 显式文件=项目内且 diff 有新增证据
      const corrupt = Buffer.from('PK\u0003\u0004这不是一个真实工作簿的 zip 结构', 'utf8');
      const script: FakeTurnScript = [
        { kind: 'writeFile', path: '损坏.xlsx', contentBase64: corrupt.toString('base64') },
        { kind: 'event', event: { kind: 'turn.completed', finalText: taskCompleteJson({ files: ['损坏.xlsx'] }) } },
      ];
      const submitted = await env.submit('生成一个坏工作簿');
      await env.drain(new FakeRuntimeAdapter({ turnScripts: [script] }));
      const turn = env.turnOf(submitted.taskId)!;
      expect(turn.status).toBe('SUCCEEDED');
      const finalId = env.finalAgentMessages(submitted.taskId)[0]!.id;
      const artifacts = attachmentRowsOf(env, finalId);
      expect(artifacts).toHaveLength(1);
      const corruptArtifact = artifacts[0]!;
      expect(corruptArtifact.hash).toBe(sha256(corrupt));
      expect(readFileSync(corruptArtifact.blob_path)).toEqual(corrupt);
      const preview = expectOkData<{ extraction?: string; sheets?: unknown; hash: string; modelInput?: string }>(
        await env.raw('attachment.previewOffice', { attachmentId: corruptArtifact.artifact_id }), 'attachment.previewOffice(坏 xlsx)',
      );
      expect(preview.hash).toBe(corruptArtifact.hash);
      expect(preview.extraction).toBe('failed'); // 分列态：原件保留、提取不可用
      expect(preview.sheets).toBeUndefined(); // 不冒充“能打开”
      const cacheRow = env.db.prepare('SELECT extracted_text_json FROM artifacts WHERE id = ?').get(corruptArtifact.artifact_id) as { extracted_text_json: string | null };
      expect(cacheRow.extracted_text_json).toBeNull(); // 失败不伪造缓存
    } finally { env.close(); }
  }, 120_000);
});

/* ============================================================
   生产链：结构化终态无 message.completed / 负例 / fullAccess
   ============================================================ */

/** 只发 turn.completed（合法内嵌 TaskComplete JSON）、过滤掉 fake 自动补的 message.completed。 */
class NoMessageCompletedAdapter extends FakeRuntimeAdapter {
  override events(session: SessionRef): AsyncIterable<NormalizedRuntimeEvent> {
    const inner = super.events(session);
    return (async function* filtered(): AsyncGenerator<NormalizedRuntimeEvent> {
      for await (const event of inner) {
        if (event.kind === 'message.completed') continue;
        yield event;
      }
    })();
  }
}

describe('R91 生产链：结构化终态/负例/fullAccess', () => {
  it('仅 turn.completed（无 message.completed）：用已验证 TaskComplete 生成最终可见回复，附件只挂该回复', async () => {
    const env = await makeProdEnv('acceptEdits');
    try {
      await env.grantWriteAccess(true); // project-write：本 turn 显式文件=项目内且 diff 有新增证据
      const script: FakeTurnScript = [
        { kind: 'writeFile', path: '结构化结果.txt', content: 'STRUCTURED-ONLY 3232\n' },
        {
          kind: 'event',
          event: {
            kind: 'turn.completed',
            finalText: taskCompleteJson({ files: ['结构化结果.txt'], answer: '结构化交付可见回答', changeSummary: '结构化交付摘要' }),
          },
        },
      ];
      const submitted = await env.submit('只要结构化终态');
      await env.drain(new NoMessageCompletedAdapter({ turnScripts: [script] }));
      const turn = env.turnOf(submitted.taskId)!;
      expect(turn.status).toBe('SUCCEEDED');
      // 没有 message.completed → 没有 final_result 消息；由已验证 TaskComplete 生成本轮最终可见回复。
      expect(env.db.prepare('SELECT 1 AS ok FROM messages WHERE id = ?').get(`msg_${turn.turnId}_final_result`)).toBeUndefined();
      const agentMessages = env.finalAgentMessages(submitted.taskId);
      expect(agentMessages).toHaveLength(1);
      const finalId = agentMessages[0]!.id;
      expect(finalId).toBe(`msg_${turn.turnId}_structured_final`);
      expect(agentMessages[0]!.author_id).toBe(env.memberId);
      expect(agentMessages[0]!.status).toBe('final');
      const body = JSON.parse(agentMessages[0]!.body_json) as { text: string };
      expect(body.text).toBe('结构化交付可见回答');
      expect(body.text).not.toContain('task-complete-v1'); // 用户可见回复不是协议 JSON/状态前缀

      const artifacts = attachmentRowsOf(env, finalId);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]!.display_name).toBe('结构化结果.txt');
      expect(artifacts[0]!.hash).toBe(sha256('STRUCTURED-ONLY 3232\n'));
      expect(readFileSync(artifacts[0]!.blob_path)).toEqual(Buffer.from('STRUCTURED-ONLY 3232\n'));
      // 附件只挂最终可见回复，不挂任何别的消息。
      expect(env.db.prepare('SELECT count(*) AS c FROM message_attachments WHERE message_id != ?').get(finalId)).toMatchObject({ c: 0 });
      const audit = auditSnapshotOf(env, turn.turnId)!;
      expect(audit.status).toBe('registered');
      expect(audit.accessMode).toBe('project-write');
    } finally { env.close(); }
  }, 60_000);

  it('无候选（files 为空且无 diff）：成功回复不产生任何文件卡/失败提示', async () => {
    const env = await makeProdEnv('acceptEdits');
    try {
      const script: FakeTurnScript = [
        { kind: 'event', event: { kind: 'turn.completed', finalText: taskCompleteJson({ files: [] }) } },
      ];
      const submitted = await env.submit('纯回答，无文件产出');
      await env.drain(new FakeRuntimeAdapter({ turnScripts: [script] }));
      const turn = env.turnOf(submitted.taskId)!;
      expect(turn.status).toBe('SUCCEEDED');
      expect(env.finalAgentMessages(submitted.taskId)).toHaveLength(1);
      expect(env.db.prepare('SELECT count(*) AS c FROM artifacts').get()).toMatchObject({ c: 0 });
      expect(env.db.prepare('SELECT count(*) AS c FROM message_attachments').get()).toMatchObject({ c: 0 });
      // 无声明文件=no-candidates：worker 只在 failures.length>0 时发 system 提示——这里必须零提示。
      expect(env.db.prepare("SELECT count(*) AS c FROM messages WHERE author_id = 'system:file-snapshot'").get()).toMatchObject({ c: 0 });
      expect(env.db.prepare("SELECT count(*) AS c FROM messages WHERE id = ?").get(`msg_filesnap_${turn.turnId}`)).toMatchObject({ c: 0 });
      // 也没有 turn.generatedFileSnapshot 审计（no-candidates 不写审计，避免噪声）。
      expect(auditSnapshotOf(env, turn.turnId)).toBeUndefined();
    } finally { env.close(); }
  }, 60_000);

  it('声明文件不存在/越界/不支持类型：原回复成功、零伪造附件、失败汇总为一条可读 system 提示', async () => {
    const env = await makeProdEnv('acceptEdits');
    try {
      await env.grantWriteAccess(true); // project-write：项目外声明=OUTSIDE_SCOPE
      const outsideFile = join(env.root, '项目外', '外部文件.txt');
      mkdirSync(join(env.root, '项目外'), { recursive: true });
      writeFileSync(outsideFile, 'OUTSIDE-MUST-NOT-BE-ATTACHED\n', 'utf8');
      const script: FakeTurnScript = [
        { kind: 'writeFile', path: '正常产出.txt', content: 'VALID-PRODUCT-1\n' },
        { kind: 'writeFile', path: '坏类型.xyz', content: 'UNSUPPORTED-TYPE\n' },
        {
          kind: 'event',
          event: {
            kind: 'turn.completed',
            finalText: taskCompleteJson({
              files: ['正常产出.txt', '坏类型.xyz', '不存在.txt', '../项目外/外部文件.txt'],
              changeSummary: '含不合格声明的交付',
            }),
          },
        },
      ];
      const submitted = await env.submit('生成并声明几个不合格文件');
      await env.drain(new FakeRuntimeAdapter({ turnScripts: [script] }));
      const turn = env.turnOf(submitted.taskId)!;
      expect(turn.status).toBe('SUCCEEDED'); // 原回复/交付不受快照失败影响
      const finalId = env.finalAgentMessages(submitted.taskId)[0]!.id;
      const artifacts = attachmentRowsOf(env, finalId);
      expect(artifacts).toHaveLength(1); // 只有真实合法的那个，不伪造其它附件
      expect(artifacts[0]!.display_name).toBe('正常产出.txt');
      expect(artifacts[0]!.hash).toBe(sha256('VALID-PRODUCT-1\n'));
      expect(env.db.prepare('SELECT count(*) AS c FROM message_attachments WHERE message_id != ?').get(finalId)).toMatchObject({ c: 0 });

      // 可读状态：一条 system 消息，列出本 turn 未登记的可读原因（不阻塞原回复）。
      const noticeId = `msg_filesnap_${turn.turnId}`;
      const notice = env.db.prepare("SELECT author_type, body_json FROM messages WHERE id = ?").get(noticeId) as { author_type: string; body_json: string } | undefined;
      expect(notice).toBeDefined();
      expect(notice!.author_type).toBe('system');
      // 多条失败汇总成**一条**可读 system 提示（不是每项一条）。
      expect(env.db.prepare("SELECT count(*) AS c FROM messages WHERE author_id = 'system:file-snapshot'").get()).toMatchObject({ c: 1 });
      const noticeText = (JSON.parse(notice!.body_json) as { text: string }).text;
      expect(noticeText).toContain('文件卡未登记');
      expect(noticeText).toContain('不存在.txt');
      expect(noticeText).toContain('外部文件.txt');
      expect(noticeText).toContain('坏类型.xyz');

      // 审计留证：失败代码与 declared 标记正确（只在明确声明时汇总给用户）。
      const audit = auditSnapshotOf(env, turn.turnId)!;
      expect(audit.status).toBe('partial');
      expect(audit.accessMode).toBe('project-write');
      expect(audit.registered.map((r) => r.filename)).toEqual(['正常产出.txt']);
      const codes = audit.failures.map((f) => f.code);
      expect(codes).toContain('NOT_FOUND');
      expect(codes).toContain('OUTSIDE_SCOPE');
      expect(codes).toContain('UNSUPPORTED_TYPE');
      expect(audit.failures.every((f) => f.declared === true)).toBe(true);
      // 项目外文件未被读取/复制（原样保留）。
      expect(readFileSync(outsideFile)).toEqual(Buffer.from('OUTSIDE-MUST-NOT-BE-ATTACHED\n'));
    } finally { env.close(); }
  }, 60_000);

  it('fullAccess：项目外显式文件成功快照（audit accessMode=full），并可通过既有预览通道打开', async () => {
    const env = await makeProdEnv('bypassPermissions');
    try {
      const outsideDir = join(env.root, '项目外');
      mkdirSync(outsideDir, { recursive: true });
      const outsideFile = join(outsideDir, '完整权限外部.txt');
      const outsideText = 'FULL-ACCESS-OUTSIDE 第1行 暗号 FULL-7788\n';
      writeFileSync(outsideFile, outsideText, 'utf8');
      const script: FakeTurnScript = [
        { kind: 'writeFile', path: '项目内说明.txt', content: 'INSIDE-PROJECT\n' },
        { kind: 'event', event: { kind: 'turn.completed', finalText: taskCompleteJson({ files: [outsideFile] }) } },
      ];
      const submitted = await env.submit('生成一个项目外文件');
      await env.drain(new FakeRuntimeAdapter({ turnScripts: [script] }));
      const turn = env.turnOf(submitted.taskId)!;
      expect(turn.status).toBe('SUCCEEDED');
      const finalId = env.finalAgentMessages(submitted.taskId)[0]!.id;
      const artifacts = attachmentRowsOf(env, finalId);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]!.display_name).toBe('完整权限外部.txt');
      expect(artifacts[0]!.hash).toBe(sha256(outsideText));
      expect(readFileSync(artifacts[0]!.blob_path)).toEqual(Buffer.from(outsideText, 'utf8'));
      const preview = expectOkData<{ text: string; hash: string }>(
        await env.raw('attachment.previewText', { attachmentId: artifacts[0]!.artifact_id }), 'attachment.previewText(full access)',
      );
      expect(preview.text).toBe(outsideText);
      const original = expectOkData<{ bytesBase64: string; hash: string }>(
        await env.raw('attachment.originalFile', { attachmentId: artifacts[0]!.artifact_id }), 'attachment.originalFile(full access)',
      );
      expect(original.hash).toBe(sha256(outsideText));
      expect(Buffer.from(original.bytesBase64, 'base64')).toEqual(Buffer.from(outsideText, 'utf8'));
      const audit = auditSnapshotOf(env, turn.turnId)!;
      expect(audit.status).toBe('registered');
      expect(audit.accessMode).toBe('full'); // worker 按本 turn 执行时记录的写权限（fullAccess）判定
      expect(audit.failures).toEqual([]);
      expect(audit.registered[0]!.source).toBe('declared');
    } finally { env.close(); }
  }, 60_000);
});
