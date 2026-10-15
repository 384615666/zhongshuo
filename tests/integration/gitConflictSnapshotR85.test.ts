import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { beginPendingOperationForTest } from '../../src/daemon/gitWrite.ts';
import { computeCommandPayloadHash } from '../../src/domain/idempotency.ts';

const owned: Array<{ dir: string; close: () => void }> = [];
afterEach(() => { for (const f of owned.splice(0)) { f.close(); if (!resolve(f.dir).startsWith(resolve(tmpdir(), 'zs-r85-conflict-'))) throw Error('unsafe fixture path'); rmSync(f.dir, { recursive: true, force: true }); } });
function git(root: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  if (r.status !== 0) throw Error(r.stderr || args.join(' '));
  return r.stdout.trim();
}
type Snapshot = { path: string; head: string | null; branch: string | null; stages: Array<{ mode: string; oid: string; stage: number }>; worktree: { hash: string | null; bytes: number | null } };
type Tri = { base: string | null; ours: string | null; theirs: string | null; snapshotHash: string; snapshot: Snapshot };
async function fixture(ours: string | Buffer = 'ours\n') {
  const dir = mkdtempSync(join(tmpdir(), 'zs-r85-conflict-')), root = join(dir, 'project'); mkdirSync(root);
  const db = openDatabase(join(dir, 'state.sqlite')); owned.push({ dir, close: () => db.close() });
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'R85'); git(root, 'config', 'user.email', 'r85@example.invalid'); git(root, 'config', 'core.autocrlf', 'false');
  const file = join(root, '中文 conflict.txt'); writeFileSync(file, 'base\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
  for (const side of ['one', 'two']) { git(root, 'checkout', '-qb', side, 'main'); writeFileSync(file, `theirs-${side}\n`); git(root, 'commit', '-qam', side); }
  git(root, 'checkout', '-q', 'main'); writeFileSync(file, ours); git(root, 'commit', '-qam', 'ours');
  const merge = (side: string) => { expect(spawnSync('git', ['-C', root, 'merge', side], { windowsHide: true }).status).toBe(1); };
  merge('one');
  const deps = { db, localUserId: 'u_r85', appDataDir: dir, interruptTurn: async () => {} };
  const raw = async <T,>(method: string, params: unknown, commandId: string = randomUUID()) => await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId, method, params }) as { ok: boolean; data: T; error?: { code: string; message: string; operationPending?: boolean } };
  const cmd = async <T,>(method: string, params: unknown, commandId?: string) => { const r = await raw<T>(method, params, commandId); expect(r.ok, JSON.stringify(r.error)).toBe(true); return r.data; };
  const projectId = (await cmd<{ project: { id: string } }>('project.open', { path: root })).project.id;
  const read = () => cmd<Tri>('git.conflict.content', { projectId, path: '中文 conflict.txt' });
  const params = (tri?: Tri) => ({ projectId, path: '中文 conflict.txt', content: 'approved proposal\n', ...(tri ? { expectedSnapshotHash: tri.snapshotHash } : {}) });
  // Labelled fault injection only: preserve the formal identity, synthesize an interruption window in its journal.
  const pending = (p: ReturnType<typeof params>, tri?: Tri) => {
    const commandId = randomUUID();
    beginPendingOperationForTest(db, { commandId, scope: 'user:u_r85', payloadHash: computeCommandPayloadHash({ method: 'git.conflict.resolve', target: null, params: p, expectedRevision: null }), now: Date.now() }, { projectId, action: 'conflict_resolve', request: { path: p.path, contentHash: createHash('sha256').update(p.content).digest('hex'), ...(tri ? { version: 2, approvedSnapshot: tri.snapshot, expectedSnapshotHash: tri.snapshotHash } : {}) } });
    return commandId;
  };
  return { dir, root, file, db, projectId, raw, cmd, read, params, pending, merge };
}

describe('R85 real Git conflict approval identity and interrupted original envelopes', () => {
  it('same path replaced by another conflict rejects the old approval without touching bytes/index', async () => {
    const f = await fixture(), tri = await f.read(); git(f.root, 'merge', '--abort'); f.merge('two');
    const before = readFileSync(f.file), index = git(f.root, 'ls-files', '-u');
    const r = await f.raw('git.conflict.resolve', f.params(tri));
    expect(r.ok).toBe(false); expect(r.error?.code).toBe('STALE_REVISION'); expect(readFileSync(f.file)).toEqual(before); expect(git(f.root, 'ls-files', '-u')).toBe(index);
  });
  it('fresh writes require the snapshot; external edits and externally resolved paths are not claimed', async () => {
    const f = await fixture(), tri = await f.read();
    expect((await f.raw('git.conflict.resolve', f.params())).ok).toBe(false);
    expect(f.db.prepare('SELECT count(*) n FROM git_operations').get()).toEqual({ n: 0 });
    writeFileSync(f.file, 'external edit\n'); expect((await f.raw('git.conflict.resolve', f.params(tri))).error?.code).toBe('STALE_REVISION');
    git(f.root, 'add', '--', '中文 conflict.txt'); expect((await f.raw('git.conflict.resolve', f.params(tri))).ok).toBe(false); expect(readFileSync(f.file, 'utf8')).toBe('external edit\n');
  });
  it('64KiB overflow and binary stages fail explicitly rather than returning a missing side', async () => {
    for (const ours of ['ours\n' + 'x'.repeat(90000), Buffer.from([0, 1, 2, 3])]) {
      const f = await fixture(ours), before = readFileSync(f.file), r = await f.raw('git.conflict.content', { projectId: f.projectId, path: '中文 conflict.txt' });
      expect(r.ok).toBe(false); expect(r.error?.message).toMatch(/超限|二进制/); expect(readFileSync(f.file)).toEqual(before);
    }
  });
  it('a genuinely missing delete side stays null while the existing text remains complete', async () => {
    const f = await fixture(); git(f.root, 'merge', '--abort'); git(f.root, 'checkout', '-qb', 'deleted', 'main^'); git(f.root, 'rm', '--', '中文 conflict.txt'); git(f.root, 'commit', '-qm', 'deleted'); git(f.root, 'checkout', '-q', 'main'); f.merge('deleted');
    const tri = await f.read(); expect(tri.base).toBe('base\n'); expect(tri.ours).toBe('ours\n'); expect(tri.theirs).toBeNull(); expect(tri.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('empty text is readable while invalid UTF-8 fails without a fake missing side', async () => {
    const empty = await fixture(''); expect((await empty.read()).ours).toBe('');
    const invalid = await fixture(Buffer.from([0xff, 0xfe, 0x61]));
    const r = await invalid.raw('git.conflict.content', { projectId: invalid.projectId, path: '中文 conflict.txt' });
    expect(r.ok).toBe(false); expect(r.error?.message).toMatch(/UTF-8|二进制/);
  });
  it('pending after file write resumes only its own proposal on the approved index; original number is idempotent', async () => {
    const f = await fixture(), tri = await f.read(), p = f.params(tri), id = f.pending(p, tri); writeFileSync(f.file, p.content);
    expect((await f.raw('git.conflict.resolve', { ...p, content: 'different' }, id)).error?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await f.raw('git.conflict.resolve', p, id)).ok).toBe(true); expect(git(f.root, 'ls-files', '-u')).toBe('');
    const before = readFileSync(f.file); expect((await f.raw('git.conflict.resolve', p, id)).ok).toBe(true); expect(readFileSync(f.file)).toEqual(before);
  });
  it('pending edited by someone else is retained; not rewritten or falsely settled', async () => {
    const f = await fixture(), tri = await f.read(), p = f.params(tri), id = f.pending(p, tri); writeFileSync(f.file, 'different editor\n');
    const r = await f.raw('git.conflict.resolve', p, id);
    expect(r.error).toMatchObject({ code: 'STALE_REVISION', operationPending: true }); expect(readFileSync(f.file, 'utf8')).toBe('different editor\n'); expect(f.db.prepare('SELECT status FROM git_operations WHERE id=?').get(id)).toEqual({ status: 'pending' });
  });
  it('pending after add proves both proposal bytes and index, and refuses later index changes', async () => {
    const f = await fixture(), tri = await f.read(), p = f.params(tri), id = f.pending(p, tri); writeFileSync(f.file, p.content); git(f.root, 'add', '--', p.path);
    expect((await f.raw('git.conflict.resolve', p, id)).ok).toBe(true);
    f.db.prepare('DELETE FROM command_receipts WHERE command_id=?').run(id); f.db.prepare("UPDATE git_operations SET status='pending' WHERE id=?").run(id);
    writeFileSync(f.file, 'someone else\n'); git(f.root, 'add', '--', p.path); writeFileSync(f.file, p.content);
    expect((await f.raw('git.conflict.resolve', p, id)).error?.code).toBe('STALE_REVISION'); expect(git(f.root, 'show', ':0:' + p.path)).toBe('someone else');
  });
  it('legacy pending can settle matching bytes/index without writes; legacy unresolved pending cannot overwrite', async () => {
    const f = await fixture(), p = f.params(), id = f.pending(p);
    expect((await f.raw('git.conflict.resolve', p, id)).error?.code).toBe('STALE_REVISION');
    writeFileSync(f.file, p.content); git(f.root, 'add', '--', p.path); const index = git(f.root, 'ls-files', '-s');
    expect((await f.raw('git.conflict.resolve', p, id)).ok).toBe(true); expect(git(f.root, 'ls-files', '-s')).toBe(index); expect(readFileSync(f.file, 'utf8')).toBe(p.content);
    expect((await f.raw('git.conflict.resolve', p, id)).ok).toBe(true);
    git(f.root, 'merge', '--abort'); f.merge('two'); const newConflict = readFileSync(f.file), newIndex = git(f.root, 'ls-files', '-u');
    expect((await f.raw('git.conflict.resolve', p, id)).ok).toBe(true); // Original historical receipt, not current-conflict success.
    f.db.prepare('DELETE FROM command_receipts WHERE command_id=?').run(id);
    expect((await f.raw('git.conflict.resolve', p, id)).ok).toBe(true); // Legacy done journal recovery also performs no write.
    expect(readFileSync(f.file)).toEqual(newConflict); expect(git(f.root, 'ls-files', '-u')).toBe(newIndex);
  });
  it('filtered add without its recorded actual index cannot claim completion; an actual index checkpoint can', async () => {
    const f = await fixture(); git(f.root, 'config', 'core.autocrlf', 'true');
    const tri = await f.read(), p = { ...f.params(tri), content: 'approved\r\n' }, id = f.pending(p, tri);
    writeFileSync(f.file, p.content); git(f.root, 'add', '--', p.path);
    const r = await f.raw('git.conflict.resolve', p, id); expect(r.error?.code).toBe('STALE_REVISION'); expect(readFileSync(f.file, 'utf8')).toBe(p.content);
    const stage = /^(\d+) ([a-f0-9]{40}) 0\t/.exec(git(f.root, 'ls-files', '-s'))!;
    const row = f.db.prepare('SELECT request_json FROM git_operations WHERE id=?').get(id) as { request_json: string };
    const metadata = JSON.parse(row.request_json) as Record<string, unknown>;
    f.db.prepare('UPDATE git_operations SET request_json=? WHERE id=?').run(JSON.stringify({ ...metadata, resolvedIndex: { mode: stage[1], oid: stage[2] } }), id);
    expect((await f.raw('git.conflict.resolve', p, id)).ok).toBe(true);
  });
});
