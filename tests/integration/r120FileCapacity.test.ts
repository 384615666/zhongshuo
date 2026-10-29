import { afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { captureFilePreimage, readStoredContent, scanDirectoryFiles } from '../../src/daemon/preimage.ts';
import { projectScopedFileListing } from '../../src/daemon/fileDiscovery.ts';
import { writeExport, type ExportAttachment } from '../../src/daemon/exportWriter.ts';
import { readChangeSnapshot } from '../../src/daemon/changeSnapshot.ts';
import { openDatabase } from '../../src/persistence/db.ts';
import { gitRepoStatus, captureGit } from '../../src/daemon/gitStatus.ts';
import { gitStage, gitUnstage, gitCommitDiff } from '../../src/daemon/gitWrite.ts';
const root = mkdtempSync(join(tmpdir(), 'zs-r120-files-'));
afterAll(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
const dir = (name: string) => { const p = join(root, name); mkdirSync(p, { recursive: true }); return p; };
it('default preimages preserve >8MiB; legacy environment limits cannot truncate scans or storage', () => {
  vi.stubEnv('ZS_PREIMAGE_MAX_FILES', '1'); vi.stubEnv('ZS_PREIMAGE_MAX_BYTES', '1');
  const project = dir('preimage'), store = dir('pre-store');
  const bytes = Buffer.from('a'.repeat(9 * 1024 * 1024) + 'TAIL');
  writeFileSync(join(project, 'large.txt'), bytes); writeFileSync(join(project, 'other.txt'), 'other');
  const result = captureFilePreimage(project, ['large.txt'], { storeDir: store });
  expect(result.entries[0]).toMatchObject({ size: bytes.length, sha256: hash(bytes), contentRef: hash(bytes) });
  const saved = readStoredContent(store, hash(bytes)); expect(saved.ok).toBe(true);
  if (saved.ok) { expect(saved.content.length).toBe(bytes.length); expect(hash(saved.content)).toBe(hash(bytes)); }
  expect(scanDirectoryFiles(project)).toMatchObject({ truncated: false, files: expect.any(Array) });
  expect(scanDirectoryFiles(project).files).toHaveLength(2);
  vi.unstubAllEnvs();
});
it('default authorized discovery includes all 501 paths past 200', () => {
  const project = dir('discovery');
  for (let i = 0; i < 501; i++) writeFileSync(join(project, `${i}.ts`), 'export {};');
  const listing = projectScopedFileListing(project)!;
  expect(listing.files).toHaveLength(501); expect(listing.truncated).toBe(false);
});
it('export copies 201 real assets totaling >256MiB and verifies every manifest hash', async () => {
  const blobRoot = dir('blobstore'), exportDir = dir('export');
  const attachments: ExportAttachment[] = [];
  for (let i = 0; i < 201; i++) {
    const bytes = Buffer.alloc(1340000, 120); bytes.writeUInt32LE(i, bytes.length - 4);
    const sha = hash(bytes), file = join(blobRoot, `${sha}.txt`); writeFileSync(file, bytes);
    attachments.push({ message_id: 'm', artifact_id: `a${i}`, display_name: `${i}.txt`, kind: 'text_file', hash: sha, revision: 1, blob_path: file, source_name: `${i}.txt`, conversation_id: 'c' });
  }
  const outcome = await writeExport({ conv: { id: 'c', kind: 'dm', room_id: null, archived_at: null }, target: { kind: 'conversation' }, messages: [{ id: 'm', conversation_id: 'c', thread_id: null, thread_message_seq: null, author_type: 'human', author_id: 'u', body_json: '{"text":"synthetic"}', created_at: 0 }], attachments, format: 'md', exportDir, blobRoot });
  expect(outcome.manifest.files).toHaveLength(201);
  expect(outcome.manifest.files.reduce((sum, f) => sum + f.bytes, 0)).toBeGreaterThan(256 * 1024 * 1024);
  for (const file of outcome.manifest.files) expect(hash(readFileSync(join(exportDir, file.file)))).toBe(file.sha256);
}, 120_000);
it('Git status reads >256KiB of real porcelain paths without a byte or entry window', async () => {
  const project = dir('large-status'); git(project, 'init', '-q');
  for (let i = 0; i < 2200; i++) writeFileSync(join(project, `${String(i).padStart(4, '0')}-${'x'.repeat(120)}.txt`), 'synthetic');
  const raw = await captureGit(['-C', project, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {});
  expect(raw.exitCode).toBe(0); expect(raw.stdout.length).toBeGreaterThan(256 * 1024); expect(raw.truncated).toBe(false);
  const result = await gitRepoStatus(project); expect(result.ok).toBe(true);
  if (result.ok) { expect(result.untracked).toHaveLength(2200); expect(result.truncated).toBe(false); expect(result.untracked.at(-1)?.path).toMatch(/^2199-/); }
}, 60_000);
it('change snapshot returns 101 changed paths and >256KiB full immutable text, still rejects corruption', () => {
  const db = openDatabase(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=OFF');
    db.prepare("INSERT INTO change_sets(id, project_id, task_id, before_ref, after_ref) VALUES ('cs','p','t','','')").run();
    const store = dir('snapshot/preimages/p'), appData = join(root, 'snapshot');
    const bytes = Buffer.from('a'.repeat(300 * 1024) + 'TAIL'), sha = hash(bytes); writeFileSync(join(store, sha), bytes);
    const insert = db.prepare("INSERT INTO change_set_files(change_set_id,role,path,state,sha256,size,content_ref) VALUES('cs','after',?,'present',?,?,?)");
    for (let i = 0; i < 101; i++) insert.run(`${i}.txt`, sha, bytes.length, sha);
    const result = readChangeSnapshot(db, appData, 'p', 't', 'cs', '100.txt');
    expect(result.files).toHaveLength(101); expect(result.truncated).toBe(false); expect(result.content?.after.text).toBe(bytes.toString());
    writeFileSync(join(store, sha), 'corrupt'); expect(readChangeSnapshot(db, appData, 'p', 't', 'cs', '100.txt').content?.after.text).toBeNull();
  } finally { db.close(); }
});
it('Git file requests stage/unstage >100 paths and commit diffs preserve >50 files/>512KiB', async () => {
  const project = dir('git'), db = openDatabase(':memory:');
  try {
    db.prepare("INSERT INTO projects(id,display_name,root_path,canonical_path,directory_identity,created_at) VALUES('p','synthetic',?,?,'{}',0)").run(project, project);
    git(project, 'init', '-q'); git(project, 'config', 'user.name', 'Synthetic'); git(project, 'config', 'user.email', 'synthetic@example.invalid');
    writeFileSync(join(project, 'seed'), 'seed'); git(project, 'add', '.'); git(project, 'commit', '-qm', 'seed');
    const paths = Array.from({ length: 101 }, (_, i) => `${i}.txt`);
    for (const path of paths) writeFileSync(join(project, path), 'x'.repeat(80 * 1024) + 'TAIL');
    const journal = () => ({ commandId: randomUUID(), scope: 'r120', payloadHash: randomUUID(), now: Date.now() });
    expect((await gitStage(db, { projectId: 'p', projectRoot: project, paths, journal: journal() })).staged).toHaveLength(101);
    expect((await gitUnstage(db, { projectId: 'p', projectRoot: project, paths, journal: journal() })).staged).toHaveLength(101);
    git(project, 'add', '.'); git(project, 'commit', '-qm', 'large');
    const oid = git(project, 'rev-parse', 'HEAD').trim();
    const result = await gitCommitDiff(db, { projectId: 'p', projectRoot: project, oid });
    expect(result.patches).toHaveLength(101);
    for (const p of result.patches) { expect(p.truncated).toBe(false); expect(p.text).toContain('TAIL'); expect(p.text.length).toBeGreaterThan(80 * 1024); }
  } finally { db.close(); }
}, 120_000);
