import {afterEach, describe, expect, it} from 'vitest';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../../src/persistence/db.ts';
import {captureBaseline, finalizeChangeset} from '../../src/daemon/changeset.ts';
import {snapshotGeneratedFiles} from '../../src/daemon/generatedFileSnapshots.ts';
import {capturedFileChanges, changedLineCounts, messageFileChanges, recordMessageFileChanges} from '../../src/daemon/messageFileChanges.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {for (const cleanup of cleanups.splice(0).reverse()) cleanup();});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'zs-r98-file-facts-'));
  cleanups.push(() => rmSync(root, {recursive: true, force: true}));
  const projectRoot = join(root, 'project'), appDataDir = join(root, 'data');
  mkdirSync(projectRoot); mkdirSync(appDataDir);
  const db = openDatabase(join(appDataDir, 'state.sqlite'));
  cleanups.push(() => db.close());
  db.prepare('INSERT INTO projects(id,display_name,root_path,canonical_path,directory_identity,created_at) VALUES(?,?,?,?,?,0)').run('p', '合成项目', projectRoot, projectRoot, '{}');
  db.exec(`INSERT INTO project_members(id,project_id,display_name,principal_type,enabled) VALUES('m','p','合成成员','agent',1);
    INSERT INTO conversations(id,project_id,kind) VALUES('c','p','dm');`);
  let seq = 0;
  const turn = (suffix: string) => {
    const taskId = `task_${suffix}`, runId = `run_${suffix}`, turnId = `turn_${suffix}`, messageId = `msg_turn_${suffix}_final`;
    db.prepare("INSERT INTO tasks(id,project_id,conversation_id,kind,title,status,review_policy) VALUES(?,'p','c','dm_turn','合成文件修订','DONE','auto_deliver')").run(taskId);
    db.prepare("INSERT INTO workflow_runs(id,task_id,conversation_id,mode,status) VALUES(?,?,'c','DIRECT','SUCCEEDED')").run(runId, taskId);
    db.prepare("INSERT INTO agent_turns(id,run_id,conversation_id,member_id,stage_key,status) VALUES(?,?,'c','m','direct.work','SUCCEEDED')").run(turnId, runId);
    db.prepare("INSERT INTO messages(id,project_id,conversation_id,conversation_seq,task_id,author_type,author_id,body_json,created_at) VALUES(?,'p','c',?,?,'agent','m','{\"text\":\"已修订合成方案\"}',?)").run(messageId, ++seq, taskId, seq);
    return {db, appDataDir, projectRoot, projectId: 'p', conversationId: 'c', taskId, runId, turnId, messageId, memberId: 'm'};
  };
  return {db, projectRoot, appDataDir, turn};
}

describe('R98 message-bound file changes', () => {
  it('preserves old bytes, records complete changes and numbers a revised file across two DM tasks', () => {
    const f = fixture();
    writeFileSync(join(f.projectRoot, '方案.md'), '# 方案\n周三：东馆\n周五：待定\n');
    const first = f.turn('first');
    const before = captureBaseline(f.db, {...first});
    expect(before.ok).toBe(true); if (!before.ok) throw Error(before.error.message);
    writeFileSync(join(f.projectRoot, '方案.md'), '# 方案\n周三：西馆\n周五：待定\n');
    writeFileSync(join(f.projectRoot, '辅助.blob'), Buffer.from([0, 1, 2, 3]));
    const frozen = finalizeChangeset(f.db, {changeSetId: before.value.changeSetId, appDataDir: f.appDataDir});
    expect(frozen.ok).toBe(true); if (!frozen.ok) throw Error(frozen.error.message);
    const output = snapshotGeneratedFiles({...first, declaredFiles: [], turnDiff: frozen.value.diff, access: {fullAccess: true, modificationAuthorized: true, root: f.projectRoot}});
    recordMessageFileChanges({...first, changeSetId: before.value.changeSetId, declaredFiles: [], registered: output.registered});
    const facts = messageFileChanges(f.db, [first.messageId]).get(first.messageId)!;
    expect(facts).toHaveLength(2);
    expect(facts.find(file => file.path === '方案.md')).toMatchObject({state: 'modified', humanFacing: true, addedLines: 1, removedLines: 1, revision: 1});
    expect(facts.find(file => file.path === '辅助.blob')).toMatchObject({state: 'added', humanFacing: false, artifactId: null, addedLines: null});
    const artifact1 = f.db.prepare('SELECT blob_path FROM artifacts WHERE id=?').get(output.registered[0]!.artifactId) as {blob_path: string};
    const firstBytes = readFileSync(artifact1.blob_path, 'utf8');
    const second = f.turn('second');
    const baseline2 = captureBaseline(f.db, {...second});
    expect(baseline2.ok).toBe(true); if (!baseline2.ok) throw Error(baseline2.error.message);
    writeFileSync(join(f.projectRoot, '方案.md'), '# 方案\n周三：西馆\n周五：东馆\n');
    const frozen2 = finalizeChangeset(f.db, {changeSetId: baseline2.value.changeSetId, appDataDir: f.appDataDir});
    expect(frozen2.ok).toBe(true); if (!frozen2.ok) throw Error(frozen2.error.message);
    const output2 = snapshotGeneratedFiles({...second, declaredFiles: ['方案.md'], turnDiff: frozen2.value.diff, access: {fullAccess: true, modificationAuthorized: true, root: f.projectRoot}});
    expect(output2.registered[0]?.revision).toBe(2);
    recordMessageFileChanges({...second, changeSetId: baseline2.value.changeSetId, declaredFiles: ['方案.md'], registered: output2.registered});
    expect(messageFileChanges(f.db, [second.messageId]).get(second.messageId)?.[0]).toMatchObject({state: 'modified', revision: 2, conversationId: 'c'});
    expect(readFileSync(artifact1.blob_path, 'utf8')).toBe(firstBytes);
    expect(firstBytes).toContain('周五：待定');
  });

  it('keeps a modified document ahead of thirteen source files even without an explicit declaration', () => {
    const f = fixture(), turn = f.turn('many');
    writeFileSync(join(f.projectRoot, '方案.md'), '# 原稿\n');
    const before = captureBaseline(f.db, {...turn}); if (!before.ok) throw Error(before.error.message);
    const added = Array.from({length: 13}, (_, i) => `source${i}.ts`);
    for (const name of added) writeFileSync(join(f.projectRoot, name), 'export const value = 1;\n');
    writeFileSync(join(f.projectRoot, '方案.md'), '# 修订稿\n');
    const after = finalizeChangeset(f.db, {changeSetId: before.value.changeSetId, appDataDir: f.appDataDir}); if (!after.ok) throw Error(after.error.message);
    const output = snapshotGeneratedFiles({...turn, declaredFiles: [], turnDiff: {added, modified: ['方案.md']}, access: {fullAccess: true, modificationAuthorized: true, root: f.projectRoot}});
    expect(output.registered).toHaveLength(12);
    expect(output.registered[0]?.sourcePath).toBe('方案.md');
    recordMessageFileChanges({...turn, changeSetId: before.value.changeSetId, declaredFiles: [], registered: output.registered});
    expect(messageFileChanges(f.db, [turn.messageId]).get(turn.messageId)).toHaveLength(14);
    expect(capturedFileChanges(f.db, before.value.changeSetId)).toHaveLength(14);
  });

  it('does not attach bytes from a later file edit to an already frozen turn', () => {
    const f = fixture(), turn = f.turn('late');
    writeFileSync(join(f.projectRoot, '方案.md'), '# 本轮版本\n');
    const hash = '0'.repeat(64);
    const output = snapshotGeneratedFiles({...turn, declaredFiles: ['方案.md'], turnDiff: {added: ['方案.md'], modified: []}, capturedHashes: {'方案.md': hash}, access: {fullAccess: true, modificationAuthorized: true, root: f.projectRoot}});
    expect(output.registered).toHaveLength(0);
    expect(output.failures[0]?.code).toBe('CHANGED_DURING_READ');
    expect(f.db.prepare('SELECT COUNT(*) n FROM message_attachments').get()).toEqual({n: 0});
  });

  it('counts real changed lines and leaves unavailable or expensive comparisons unknown', () => {
    expect(changedLineCounts('a\nb\nc\n', 'a\nx\nc\ny\n')).toEqual({added: 2, removed: 1});
    expect(changedLineCounts(null, 'text')).toBeNull();
    expect(changedLineCounts('a\n'.repeat(600), 'b\n'.repeat(600))).toBeNull();
  });
});
