/**
 * R98 生成文件候选器：正式声明与真实 added/modified 差异取并集。
 *
 * 全部使用临时合成目录与合成文件，不读取用户项目或业务材料。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { SNAPSHOT_MAX_FILES, snapshotGeneratedFiles } from '../../src/daemon/generatedFileSnapshots.ts';
import type { GeneratedFileSnapshotInput } from '../../src/daemon/generatedFileSnapshots.ts';

const roots: string[] = [];
const dbs: ZhongshuoDatabase[] = [];

afterAll(() => {
  for (const db of dbs.splice(0)) {
    try { db.close(); } catch { /* 已在用例中关闭 */ }
  }
  for (const root of roots.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        // Windows 上 SQLite/WAL 句柄可能延迟释放，重试清理临时目录。
      }
    }
  }
});

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

interface CandidateEnv {
  root: string;
  projectRoot: string;
  outsideDir: string;
  appDataDir: string;
  db: ZhongshuoDatabase;
  projectId: string;
  conversationId: string;
  taskId: string;
  runId: string;
  turnId: string;
  memberId: string;
  addMessage: (id: string) => void;
  input: (overrides?: Partial<GeneratedFileSnapshotInput>) => GeneratedFileSnapshotInput;
  close: () => void;
}

function makeEnv(): CandidateEnv {
  const root = mkdtempSync(join(tmpdir(), 'zs-r98-generated-'));
  roots.push(root);
  const projectRoot = join(root, 'project');
  const outsideDir = join(root, 'outside');
  const appDataDir = join(root, 'app-data');
  for (const dir of [projectRoot, outsideDir, appDataDir]) mkdirSync(dir, { recursive: true });
  const canonicalRoot = realpathSync.native(projectRoot);
  const db = openDatabase(join(appDataDir, 'state.sqlite'));
  dbs.push(db);

  const projectId = 'p_r98';
  const conversationId = 'conv_r98';
  const taskId = 'task_r98';
  const runId = 'run_r98';
  const turnId = 'turn_r98';
  const memberId = 'm_r98';
  db.prepare(
    'INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(projectId, 'R98 合成项目', canonicalRoot, canonicalRoot, '{}', 0);
  db.prepare(
    "INSERT INTO conversations (id, project_id, kind, room_id, last_message_seq) VALUES (?, ?, 'dm', NULL, 0)",
  ).run(conversationId, projectId);

  let sequence = 0;
  const addMessage = (id: string): void => {
    sequence += 1;
    db.prepare(
      `INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, task_id,
          thread_message_seq, author_type, author_id, body_json, status, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, 'agent', ?, ?, 'final', ?)`,
    ).run(
      id,
      projectId,
      conversationId,
      sequence,
      taskId,
      memberId,
      JSON.stringify({ text: 'R98 合成最终回复' }),
      Date.now(),
    );
  };

  const input = (overrides: Partial<GeneratedFileSnapshotInput> = {}): GeneratedFileSnapshotInput => ({
    db,
    appDataDir,
    projectId,
    projectRoot: canonicalRoot,
    taskId,
    runId,
    turnId,
    memberId,
    conversationId,
    messageId: null,
    declaredFiles: [],
    turnDiff: null,
    access: { fullAccess: true, modificationAuthorized: true, root: canonicalRoot },
    ...overrides,
  });

  return {
    root,
    projectRoot: canonicalRoot,
    outsideDir,
    appDataDir,
    db,
    projectId,
    conversationId,
    taskId,
    runId,
    turnId,
    memberId,
    addMessage,
    input,
    close: () => {
      try { db.close(); } catch { /* 重复关闭无副作用 */ }
    },
  };
}

interface AttachmentRow {
  id: string;
  artifact_id: string;
  display_name: string;
  source_hash: string;
  blob_path: string;
}

const attachmentsOf = (env: CandidateEnv, messageId: string): AttachmentRow[] => env.db.prepare(
  `SELECT ma.id, ma.artifact_id, ma.display_name, ma.source_hash, a.blob_path
   FROM message_attachments ma JOIN artifacts a ON a.id = ma.artifact_id
   WHERE ma.message_id = ? ORDER BY ma.rowid`,
).all(messageId) as never;

describe('R98 generated file candidate union', () => {
  it('仅声明文件也登记，并保留 declared 来源事实', () => {
    const env = makeEnv();
    try {
      const messageId = 'msg_turn_r98_declared_only';
      env.addMessage(messageId);
      writeFileSync(join(env.projectRoot, '需求说明.md'), '# 声明产出\n', 'utf8');

      const outcome = snapshotGeneratedFiles(env.input({
        messageId,
        declaredFiles: ['需求说明.md'],
        turnDiff: null,
      }));

      expect(outcome.status).toBe('registered');
      expect(outcome.failures).toEqual([]);
      expect(outcome.registered).toHaveLength(1);
      expect(outcome.registered[0]).toMatchObject({
        filename: '需求说明.md',
        source: 'declared',
        declared: true,
        evidence: ['declared'],
      });
      expect(attachmentsOf(env, messageId)).toHaveLength(1);
    } finally {
      env.close();
    }
  });

  it('有声明时仍合并多个实际 modified，声明文件不会被差异候选压掉', () => {
    const env = makeEnv();
    try {
      const messageId = 'msg_turn_r98_declared_plus_modified';
      env.addMessage(messageId);
      for (const name of ['主交付.md', '修改甲.md', '修改乙.txt']) {
        writeFileSync(join(env.projectRoot, name), `CONTENT-${name}\n`, 'utf8');
      }

      const outcome = snapshotGeneratedFiles(env.input({
        messageId,
        declaredFiles: ['主交付.md'],
        turnDiff: { added: [], modified: ['修改甲.md', '修改乙.txt'] },
      }));

      expect(outcome.status).toBe('registered');
      expect(outcome.registered.map((item) => item.filename).sort()).toEqual(['主交付.md', '修改甲.md', '修改乙.txt'].sort());
      const byName = new Map(outcome.registered.map((item) => [item.filename, item]));
      expect(byName.get('主交付.md')).toMatchObject({ source: 'declared', declared: true, evidence: ['declared'] });
      expect(byName.get('修改甲.md')).toMatchObject({ source: 'diff', declared: false, evidence: ['modified'] });
      expect(byName.get('修改乙.txt')).toMatchObject({ source: 'diff', declared: false, evidence: ['modified'] });
      expect(attachmentsOf(env, messageId)).toHaveLength(3);
    } finally {
      env.close();
    }
  });

  it('无声明时多个 modified 全部登记，不再只取 added', () => {
    const env = makeEnv();
    try {
      const messageId = 'msg_turn_r98_modified_only';
      env.addMessage(messageId);
      for (const name of ['修改一.txt', '修改二.md']) {
        writeFileSync(join(env.projectRoot, name), `MODIFIED-${name}\n`, 'utf8');
      }

      const outcome = snapshotGeneratedFiles(env.input({
        messageId,
        declaredFiles: [],
        turnDiff: { added: [], modified: ['修改一.txt', '修改二.md'] },
        access: { fullAccess: false, modificationAuthorized: true, root: env.projectRoot },
      }));

      expect(outcome.status).toBe('registered');
      expect(outcome.accessMode).toBe('project-write');
      expect(outcome.registered).toHaveLength(2);
      expect(outcome.registered.every((item) => item.source === 'diff'
        && item.declared === false
        && item.evidence.length === 1
        && item.evidence[0] === 'modified')).toBe(true);
      expect(attachmentsOf(env, messageId)).toHaveLength(2);
    } finally {
      env.close();
    }
  });

  it('无声明的新增与修改混合时全部纳入候选', () => {
    const env = makeEnv();
    try {
      const messageId = 'msg_turn_r98_added_modified';
      env.addMessage(messageId);
      const added = ['新增甲.md', '新增乙.txt'];
      const modified = ['修改丙.txt', '修改丁.md'];
      for (const name of [...added, ...modified]) {
        writeFileSync(join(env.projectRoot, name), `MIXED-${name}\n`, 'utf8');
      }

      const outcome = snapshotGeneratedFiles(env.input({
        messageId,
        declaredFiles: [],
        turnDiff: { added, modified },
      }));

      expect(outcome.status).toBe('registered');
      expect(outcome.registered).toHaveLength(4);
      const byName = new Map(outcome.registered.map((item) => [item.filename, item]));
      for (const name of added) expect(byName.get(name)?.evidence).toEqual(['added']);
      for (const name of modified) expect(byName.get(name)?.evidence).toEqual(['modified']);
      expect(attachmentsOf(env, messageId)).toHaveLength(4);
    } finally {
      env.close();
    }
  });

  it('文件数上限前优先可读文档，源码不能挤掉方案和已变更的说明', () => {
    const env = makeEnv();
    try {
      const messageId = 'msg_turn_r98_priority_limit';
      env.addMessage(messageId);
      const sourceNames = Array.from(
        { length: 13 },
        (_, index) => `src/新增-${String(index).padStart(2, '0')}.ts`,
      );
      mkdirSync(join(env.projectRoot, 'src'), { recursive: true });
      for (const name of sourceNames) {
        writeFileSync(join(env.projectRoot, name), `export const value = ${JSON.stringify(name)};\n`, 'utf8');
      }
      writeFileSync(join(env.projectRoot, 'README.md'), '# diff-only 说明\n', 'utf8');
      writeFileSync(join(env.projectRoot, '方案.md'), '# 人类交付方案\n\n完整方案。\n', 'utf8');

      const outcome = snapshotGeneratedFiles(env.input({
        messageId,
        // 模拟变更上下文中源码候选先出现、交付文档后出现；两者均保留声明事实。
        declaredFiles: [...sourceNames, '方案.md'],
        turnDiff: {
          added: [...sourceNames, 'README.md'],
          modified: ['方案.md'],
        },
      }));

      expect(outcome.status).toBe('partial');
      expect(outcome.registered).toHaveLength(SNAPSHOT_MAX_FILES);
      expect(outcome.registered[0]).toMatchObject({
        filename: '方案.md',
        declared: true,
        evidence: ['declared', 'modified'],
      });
      // 文档在前，其余源码仍保持原始顺序。
      expect(outcome.registered.slice(1).map((item) => item.filename))
        .toEqual(['README.md', ...sourceNames.slice(0, SNAPSHOT_MAX_FILES - 2).map((name) => basename(name))]);
      expect(outcome.registered.some((item) => item.filename === 'README.md')).toBe(true);
      expect(attachmentsOf(env, messageId)).toHaveLength(SNAPSHOT_MAX_FILES);

      const skipped = outcome.skipped.join('\n');
      expect(outcome.skipped).toHaveLength(3);
      expect(skipped).toContain('LIMIT_EXCEEDED');
      for (const name of sourceNames.slice(SNAPSHOT_MAX_FILES - 2)) {
        expect(skipped).toContain(name);
      }
      expect(skipped).not.toContain('README.md');
      expect(skipped).not.toContain('方案.md');
      expect(outcome.failures.filter((item) => item.code === 'LIMIT_EXCEEDED')).toHaveLength(3);
      expect(outcome.failures.every((item) => item.declared)).toBe(true);
    } finally {
      env.close();
    }
  });

  it('同路径跨声明/added/modified及重复写法只登记一次，并保留全部证据与幂等', () => {
    const env = makeEnv();
    try {
      const messageId = 'msg_turn_r98_duplicate_path';
      env.addMessage(messageId);
      const file = join(env.projectRoot, '重复路径.md');
      writeFileSync(file, '# 同路径\n', 'utf8');
      const input = env.input({
        messageId,
        declaredFiles: [file, '重复路径.md', '重复路径.md'],
        turnDiff: { added: ['./重复路径.md'], modified: ['重复路径.md'] },
      });

      const first = snapshotGeneratedFiles(input);
      expect(first.status).toBe('registered');
      expect(first.registered).toHaveLength(1);
      expect(first.registered[0]).toMatchObject({
        filename: '重复路径.md',
        source: 'declared',
        declared: true,
        evidence: ['declared', 'added', 'modified'],
      });
      expect(attachmentsOf(env, messageId)).toHaveLength(1);

      const replay = snapshotGeneratedFiles(input);
      expect(replay.registered).toHaveLength(1);
      expect(replay.registered[0]!.artifactId).toBe(first.registered[0]!.artifactId);
      expect(env.db.prepare('SELECT count(*) AS n FROM artifacts').get()).toEqual({ n: 1 });
      expect(attachmentsOf(env, messageId)).toHaveLength(1);
    } finally {
      env.close();
    }
  });

  it('同一路径的新旧内容绑定各自消息版本，旧消息仍打开旧字节', () => {
    const env = makeEnv();
    try {
      const file = join(env.projectRoot, '版本化交付.md');
      writeFileSync(file, '# 第一版\n', 'utf8');
      const messageV1 = 'msg_turn_r98_version_v1';
      env.addMessage(messageV1);

      const v1 = snapshotGeneratedFiles(env.input({
        messageId: messageV1,
        declaredFiles: ['版本化交付.md'],
        turnDiff: null,
      }));
      expect(v1.registered).toHaveLength(1);
      expect(v1.registered[0]!.revision).toBe(1);

      writeFileSync(file, '# 第二版\n真实新增一行\n', 'utf8');
      const messageV2 = 'msg_turn_r98b_version_v2';
      env.addMessage(messageV2);
      const v2 = snapshotGeneratedFiles(env.input({
        turnId: 'turn_r98b',
        runId: 'run_r98b',
        messageId: messageV2,
        declaredFiles: [],
        turnDiff: { added: [], modified: ['版本化交付.md'] },
      }));

      expect(v2.registered).toHaveLength(1);
      expect(v2.registered[0]).toMatchObject({
        filename: '版本化交付.md',
        revision: 2,
        declared: false,
        evidence: ['modified'],
      });
      expect(v2.registered[0]!.artifactId).not.toBe(v1.registered[0]!.artifactId);
      const oldAttachment = attachmentsOf(env, messageV1)[0]!;
      const newAttachment = attachmentsOf(env, messageV2)[0]!;
      expect(oldAttachment.artifact_id).toBe(v1.registered[0]!.artifactId);
      expect(oldAttachment.source_hash).toBe(sha256('# 第一版\n'));
      expect(readFileSync(oldAttachment.blob_path, 'utf8')).toBe('# 第一版\n');
      expect(newAttachment.artifact_id).toBe(v2.registered[0]!.artifactId);
      expect(newAttachment.source_hash).toBe(sha256('# 第二版\n真实新增一行\n'));
      expect(readFileSync(newAttachment.blob_path, 'utf8')).toBe('# 第二版\n真实新增一行\n');
    } finally {
      env.close();
    }
  });

  it('越权与不存在文件不登记，声明失败带可诊断代码和 evidence', () => {
    const env = makeEnv();
    try {
      const messageId = 'msg_turn_r98_invalid_declared';
      env.addMessage(messageId);
      const outside = join(env.outsideDir, '越权文件.md');
      writeFileSync(outside, '# 不应读取\n', 'utf8');

      const outcome = snapshotGeneratedFiles(env.input({
        messageId,
        declaredFiles: [outside, '不存在.md'],
        turnDiff: { added: [], modified: [] },
        access: { fullAccess: false, modificationAuthorized: true, root: env.projectRoot },
      }));

      expect(outcome.status).toBe('blocked');
      expect(outcome.registered).toEqual([]);
      expect(outcome.failures).toHaveLength(2);
      expect(outcome.failures.map((item) => item.code).sort()).toEqual(['NOT_FOUND', 'OUTSIDE_SCOPE']);
      for (const failure of outcome.failures) {
        expect(failure.declared).toBe(true);
        expect(failure.evidence).toEqual(['declared']);
        expect(failure.message.length).toBeGreaterThan(0);
      }
      expect(attachmentsOf(env, messageId)).toEqual([]);
      expect(env.db.prepare('SELECT count(*) AS n FROM artifacts').get()).toEqual({ n: 0 });
    } finally {
      env.close();
    }
  });
});
