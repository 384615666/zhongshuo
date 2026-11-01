import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { RunningDaemon } from '../../src/daemon/entry.ts';
import { persistDaemonStopRecord, selectCompletedDaemonStop } from '../../src/daemon/stopHistory.ts';

const root = mkdtempSync(join(tmpdir(), 'zs-stop-history-r154-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const old = { pid: 777001, at: 1000, phase: 'closed', stopRequestsSentTo: ['turn-old'] };
const key = `daemon:stop:history:${old.pid}:${old.at}`;

describe('R154 durable daemon stop history, synthetic data and zero inference', () => {
  it('preserves an inherited pre-history last record through empty stops and actual daemon shutdown/reopen', async () => {
    const dir = join(root, randomUUID());
    const path = join(dir, 'state.sqlite');
    const initial = openDatabase(path);
    const raw = JSON.stringify({ ...old, note: 'daemon-owned fixture' });
    initial.prepare("INSERT INTO daemon_state(key,value,updated_at) VALUES('daemon:stop:last',?,1001)").run(raw);
    initial.close();
    vi.stubEnv('ZS_ALLOW_FAKE', '1');
    let daemon: RunningDaemon | undefined;
    try {
      const { startDaemon } = await import('../../src/daemon/entry.ts');
      daemon = await startDaemon({ appDataDir: dir, runtime: 'fake', tickMs: 60_000, pipeName: `\\\\.\\pipe\\zs-stop-history-${randomUUID()}` });
      expect(await daemon.stop()).toMatchObject({ complete: true, phase: 'closed', stopRequestsSentTo: [] });
      const reopened = openDatabase(path);
      try {
        expect(reopened.prepare('SELECT value,updated_at FROM daemon_state WHERE key=?').get(key)).toEqual({ value: raw, updated_at: 1001 });
        expect(JSON.parse((reopened.prepare("SELECT value FROM daemon_state WHERE key='daemon:stop:last'").get() as { value: string }).value)).toMatchObject({ pid: process.pid, phase: 'closed', stopRequestsSentTo: [] });
        persistDaemonStopRecord(reopened, { pid: 777009, at: Date.now(), phase: 'closed', stopRequestsSentTo: [] });
        expect(selectCompletedDaemonStop(reopened, 'turn-old')).toEqual({ record: old, persistedAt: 1001 });
        expect(reopened.prepare('SELECT count(*) n FROM tasks').get()).toEqual({ n: 0 });
        expect(reopened.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({ n: 0 });
      } finally { reopened.close(); }
    } finally {
      if (daemon != null) await daemon.stop();
      vi.unstubAllEnvs();
    }
  });

  it('archives new completed bindings immediately and deduplicates semantic last/history repeats', () => {
    const db = openDatabase(':memory:');
    try {
      persistDaemonStopRecord(db, { ...old, stopRequestsSentTo: ['turn-old', 'turn-other', 'turn-old'] }, 1001);
      persistDaemonStopRecord(db, { ...old, stopRequestsSentTo: ['turn-other', 'turn-old'] }, 1002);
      expect(selectCompletedDaemonStop(db, 'turn-old')).toEqual({ record: { ...old, stopRequestsSentTo: ['turn-old', 'turn-other'] }, persistedAt: 1001 });
      expect(db.prepare("SELECT count(*) n FROM daemon_state WHERE key GLOB 'daemon:stop:history:*'").get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });

  for (const record of [
    { ...old, phase: 'incomplete' }, { ...old, phase: 'forced-incomplete' },
    { ...old, phase: 'accepted' }, { ...old, stopRequestsSentTo: [] },
    { ...old, stopRequestsSentTo: 'turn-old' }, { ...old, pid: null },
  ]) {
    it(`does not archive non-evidence ${JSON.stringify(record)}`, () => {
      const db = openDatabase(':memory:');
      try {
        persistDaemonStopRecord(db, record, 1001);
        expect(selectCompletedDaemonStop(db, 'turn-old')).toBeUndefined();
        expect(db.prepare("SELECT count(*) n FROM daemon_state WHERE key GLOB 'daemon:stop:history:*'").get()).toEqual({ n: 0 });
      } finally { db.close(); }
    });
  }

  it('history collision rolls back the entire write, preserving both last and old historical bytes', () => {
    const db = openDatabase(':memory:');
    try {
      persistDaemonStopRecord(db, old, 1001);
      const before = db.prepare('SELECT * FROM daemon_state ORDER BY key').all();
      expect(() => persistDaemonStopRecord(db, { ...old, stopRequestsSentTo: ['other-turn'] }, 1002)).toThrow('冲突');
      expect(db.prepare('SELECT * FROM daemon_state ORDER BY key').all()).toEqual(before);
    } finally { db.close(); }
  });

  it('history insert failure cannot overwrite last', () => {
    const db = openDatabase(':memory:');
    try {
      db.prepare("INSERT INTO daemon_state(key,value,updated_at) VALUES('daemon:stop:last',?,1001)").run(JSON.stringify(old));
      db.exec("CREATE TRIGGER history_failure BEFORE INSERT ON daemon_state WHEN NEW.key GLOB 'daemon:stop:history:*' BEGIN SELECT RAISE(ABORT,'history write failed'); END");
      expect(() => persistDaemonStopRecord(db, { ...old, pid: 777009, at: 2000, stopRequestsSentTo: [] }, 2001)).toThrow('history write failed');
      expect(db.prepare('SELECT key,value,updated_at FROM daemon_state').all()).toEqual([{ key: 'daemon:stop:last', value: JSON.stringify(old), updated_at: 1001 }]);
    } finally { db.close(); }
  });

  it('different owner bindings conflict; completed history does not manufacture an overwritten old-beta record', () => {
    const db = openDatabase(':memory:');
    try {
      persistDaemonStopRecord(db, { pid: 777009, at: 2000, phase: 'closed', stopRequestsSentTo: [] }, 2001);
      expect(selectCompletedDaemonStop(db, 'turn-old')).toBeUndefined();
      persistDaemonStopRecord(db, old, 2002);
      persistDaemonStopRecord(db, { ...old, pid: 777010, at: 3000 }, 3001);
      expect(() => selectCompletedDaemonStop(db, 'turn-old')).toThrow('冲突');
    } finally { db.close(); }
  });
});
