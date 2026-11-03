import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCodexHistoryCleanup } from '../../src/daemon/codexHistoryCleanup.ts';
import { startDaemon } from '../../src/daemon/entry.ts';
import { CodexAppServerAdapter } from '../../src/adapter/codex/appServerAdapter.ts';
import { collisionFixture } from '../helpers/collisionHarnessR122.ts';

afterEach(() => vi.unstubAllEnvs());

async function fixture(count = 1) {
  vi.stubEnv('ZS_ALLOW_FAKE', '1'); vi.stubEnv('ZS_RUNTIME', 'fake');
  const f = await collisionFixture('codex-history-r175', { projects: 1, members: 1, rooms: 1 });
  for (let n = 0; n < count; n++) {
    const request = await f.send(0, 0, [0], `TOKEN_HISTORY_${n}`);
    await f.pumpUntil(() => f.taskStatus(request.taskId) === 'DONE');
  }
  const rows = f.db.prepare('SELECT id FROM runtime_sessions ORDER BY rowid').all() as Array<{ id: string }>;
  rows.forEach((row, n) => {
    f.db.prepare('UPDATE agent_turns SET session_id=? WHERE session_id=?').run(`codex-session-${n}`, row.id);
    f.db.prepare('UPDATE runtime_sessions SET id=?,provider_session_id=? WHERE id=?').run(`codex-session-${n}`, `owned-provider-${n}`, row.id);
  });
  return f;
}

it('cleans only exact recorded Codex IDs once per pass, without changing task or execution facts', async () => {
  const f = await fixture();
  try {
    const before = JSON.stringify(f.db.prepare('SELECT * FROM agent_turns').all());
    const archive = vi.fn(async (_member: string, _id: string, eligible: () => boolean) => { expect(eligible()).toBe(true); });
    const cleanup = createCodexHistoryCleanup(f.db, archive);
    await cleanup.runOnce(); await cleanup.runOnce();
    expect(archive).toHaveBeenCalledTimes(1);
    expect(archive.mock.calls[0]?.[1]).toBe('owned-provider-0');
    expect(JSON.stringify(f.db.prepare('SELECT * FROM agent_turns').all())).toBe(before);
    expect(f.db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({ n: 0 });
  } finally { await f.close(); }
});

it.each(['UNKNOWN', 'RUNNING', 'DISPATCHING', 'STOPPING'])('leaves %s execution records visible', async status => {
  const f = await fixture();
  try {
    f.db.prepare('UPDATE agent_turns SET status=?').run(status);
    const archive = vi.fn(async () => {}), cleanup = createCodexHistoryCleanup(f.db, archive);
    await cleanup.runOnce(); expect(archive).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('excludes other channels and sessions without confirmed execution evidence', async () => {
  const f = await fixture(2);
  try {
    f.db.prepare("UPDATE runtime_sessions SET id='claude-other' WHERE id='codex-session-0'").run();
    f.db.prepare("UPDATE agent_turns SET session_id=NULL WHERE session_id='codex-session-1'").run();
    const archive = vi.fn(async () => {}), cleanup = createCodexHistoryCleanup(f.db, archive);
    await cleanup.runOnce(); await cleanup.runOnce(); expect(archive).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('rechecks the ledger before archiving, and continues after a maintenance failure', async () => {
  const f = await fixture(2);
  try {
    const archive = vi.fn(async (_member: string, id: string, eligible: () => boolean) => {
      expect(eligible()).toBe(true);
      if (id === 'owned-provider-1') throw Error('synthetic maintenance failure');
      f.db.prepare("UPDATE agent_turns SET status='UNKNOWN' WHERE session_id='codex-session-0'").run();
      expect(eligible()).toBe(false);
    });
    const cleanup = createCodexHistoryCleanup(f.db, archive);
    await cleanup.runOnce(); await cleanup.runOnce(); expect(archive).toHaveBeenCalledTimes(2);
  } finally { await f.close(); }
});

it('archives historical records through the actual daemon tick and shuts down with no model dispatch', async () => {
  const f = await fixture(), log = join(f.dir, 'history-rpc.jsonl'), scenario = join(f.dir, 'history-scenario.json');
  writeFileSync(scenario, JSON.stringify({ turns: [] }));
  await f.cmd('member.setRuntime', { memberId: f.projects[0]!.members[0], kind: 'codex', model: 'fixture-model' });
  await f.close();
  vi.stubEnv('CODEX_HOME', f.dir); vi.stubEnv('ZS_REAL_DISPATCH_GUARD', '0');
  const daemon = await startDaemon({
    appDataDir: f.dir, runtime: 'fake', pipeName: `zs-history-${randomUUID()}`, tickMs: 20,
    testAdapterFactories: { codex: () => new CodexAppServerAdapter({ requestTimeoutMs: 2_000,
      mockEntry: { executable: resolve('tests/fixtures/mockAppServer.mjs'), args: [scenario, log] } }) },
  });
  const rpcs = (): Array<{ method?: string }> => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(row => JSON.parse(row)) : [];
  try {
    await expect.poll(() => rpcs().some(rpc => rpc.method === 'thread/archive')).toBe(true);
    expect(rpcs().some(rpc => rpc.method === 'turn/start' || rpc.method === 'thread/start')).toBe(false);
    expect(daemon.db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({ n: 0 });
    expect(daemon.db.prepare('SELECT DISTINCT status FROM agent_turns').all()).toEqual([{ status: 'SUCCEEDED' }]);
  } finally { await daemon.stop(); }
});
