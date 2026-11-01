import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { verifyPreviousManagedOwnerExit } from '../../src/daemon/managed/previousOwnerExit.ts';
import type { ProcessRegistryRow, QueryFn } from '../../src/daemon/processRegistry.ts';
import type { TreeScan } from '../../src/daemon/processCheck.ts';

const root = mkdtempSync(join(tmpdir(), 'zs-boot-r155-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixture() {
  const now = Date.now();
  const dir = mkdtempSync(join(root, 'case-'));
  const current = { pid: process.pid, startedAt: now - 30 * 60_000 };
  const lock = join(dir, 'locks', 'daemon.lock.d');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify(current));
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE daemon_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
    CREATE TABLE process_tree_identities(id INTEGER,turn_id TEXT,pid INTEGER,started_at_ms INTEGER,first_seen_at INTEGER,last_seen_alive_at INTEGER,exit_confirmed_at INTEGER,is_root INTEGER);`);
  const boot = now - 60 * 60_000;
  const registered = now - 120 * 60_000;
  const job = `job-${(registered - 1000).toString(36)}-777002`;
  const reg: ProcessRegistryRow = { id: 1, turn_id: 'turn-legacy', run_id: 'run-legacy', member_id: 'member',
    adapter_kind: 'pi', process_model: 'per-turn', pid: 777002, started_at_ms: registered - 2000,
    identity_source: 'managed-job', registered_at: registered, closed_at: null, managed_job_id: job, note: `job=${job}` };
  db.prepare('INSERT INTO process_tree_identities VALUES(1,?,777003,?,?,?,NULL,0)').run(reg.turn_id, registered, registered, registered + 1000);
  const readBoot = vi.fn(() => boot);
  const query = vi.fn<QueryFn>(pid => ({ state: 'exited', pid }));
  const tree = vi.fn<() => TreeScan>(() => ({ state: 'checked', survivors: [], verifiedHistoricalPids: [777003] }));
  const verify = () => verifyPreviousManagedOwnerExit(db, reg, { appDataDir: dir, instance: current, now, bootStartedAt: readBoot, query, treeScan: tree });
  const stop = (pid = 777001, at = registered + 10_000) => {
    db.prepare("INSERT INTO daemon_state VALUES('daemon:stop:last',?,?)").run(JSON.stringify({ pid, at, phase: 'closed', stopRequestsSentTo: [reg.turn_id] }), at + 1);
  };
  return { db, now, dir, lock, current, reg, boot, registered, readBoot, query, tree, verify, stop };
}

describe.skipIf(process.platform !== 'win32')('R155 prior Windows boot is a distinct, explicit legacy exit proof', () => {
  it('real Windows boot/monotonic API query refuses a registration from this live boot without querying or killing any old process', () => {
    const h = fixture();
    try {
      const registered = h.now - 5000;
      h.current.startedAt = h.now - 1000;
      writeFileSync(join(h.lock, 'owner.json'), JSON.stringify(h.current));
      h.reg.registered_at = registered; h.reg.started_at_ms = registered - 2000;
      h.reg.managed_job_id = `job-${(registered - 1000).toString(36)}-777002`;
      h.reg.note = `job=${h.reg.managed_job_id}`;
      h.db.prepare('DELETE FROM process_tree_identities').run();
      expect(() => verifyPreviousManagedOwnerExit(h.db, h.reg, { appDataDir: h.dir, instance: h.current, query: h.query, treeScan: h.tree }))
        .toThrow('尚未确认较新的 Windows 启动代次');
      expect(h.query).not.toHaveBeenCalled();
    } finally { h.db.close(); }
  });

  it('requires a later boot plus root/historical exits and tree/lock recheck, without inventing an owner PID', () => {
    const h = fixture();
    try {
      const before = h.db.prepare('SELECT * FROM process_tree_identities').all();
      expect(h.verify()).toMatchObject({ source: 'windows-system-reboot', managedJobId: h.reg.managed_job_id,
        owner: { basis: 'windows-system-reboot', pid: null, startedAt: null, archivedAt: null, bootStartedAt: h.boot, clockMarginMs: 10_000 },
        currentOwner: h.current, rootPid: h.reg.pid, checkedHistoricalProcesses: 1, releasable: true });
      expect(h.readBoot).toHaveBeenCalledTimes(2);
      expect(h.query.mock.calls.map(c => c[0])).toEqual([777002, 777003]);
      expect(h.tree).toHaveBeenCalledOnce();
      expect(h.db.prepare('SELECT * FROM process_tree_identities').all()).toEqual(before);
      expect(h.db.prepare('SELECT * FROM daemon_state').all()).toEqual([]);
    } finally { h.db.close(); }
  });

  for (const fault of ['same-boot', 'margin-equal', 'margin-inside', 'future-boot', 'after-current-lock', 'zero', 'nan', 'fraction', 'ancient', 'query-error', 'second-query-error', 'boot-changed', 'historical-after-boot',
    'root-live', 'root-at-boot', 'root-future', 'root-start-missing', 'root-wrong-pid', 'root-unknown', 'child-live', 'child-unknown', 'child-start-missing', 'tree-live', 'tree-failed', 'tree-unsupported', 'lock-changed', 'stop-added', 'missing-job', 'wrong-note', 'unmanaged', 'missing-root-start', 'current-not-newer'] as const) {
    it(`rejects ${fault} instead of interpreting absent PIDs as proof`, () => {
      const h = fixture();
      try {
        if (fault === 'same-boot') h.readBoot.mockReturnValue(h.registered - 60_000);
        if (fault === 'margin-equal') h.readBoot.mockReturnValue(h.registered + 11_000);
        if (fault === 'margin-inside') h.readBoot.mockReturnValue(h.registered + 10_999);
        if (fault === 'future-boot') h.readBoot.mockReturnValue(h.now + 1);
        if (fault === 'after-current-lock') h.readBoot.mockReturnValue(h.current.startedAt + 1);
        if (fault === 'zero') h.readBoot.mockReturnValue(0);
        if (fault === 'nan') h.readBoot.mockReturnValue(NaN);
        if (fault === 'fraction') h.readBoot.mockReturnValue(h.boot + 0.1);
        if (fault === 'ancient') h.readBoot.mockReturnValue(1);
        if (fault === 'query-error') h.readBoot.mockImplementation(() => { throw Error('WMI unavailable'); });
        if (fault === 'second-query-error') h.readBoot.mockImplementationOnce(() => h.boot).mockImplementationOnce(() => { throw Error('WMI unavailable'); });
        if (fault === 'boot-changed') h.readBoot.mockReturnValueOnce(h.boot).mockReturnValueOnce(h.boot + 1);
        if (fault === 'historical-after-boot') h.db.prepare('UPDATE process_tree_identities SET last_seen_alive_at=?').run(h.boot + 1);
        if (fault === 'root-live' || fault === 'child-live') h.query.mockImplementation(pid => pid === (fault === 'child-live' ? 777003 : 777002)
          ? { state: 'alive', identity: { pid, startedAt: h.registered } } : { state: 'exited', pid });
        if (fault === 'root-at-boot' || fault === 'root-future' || fault === 'root-start-missing' || fault === 'root-wrong-pid') h.query.mockImplementation(pid => pid === 777002
          ? { state: 'alive', identity: { pid: fault === 'root-wrong-pid' ? 777999 : pid, startedAt: fault === 'root-at-boot' ? h.boot : fault === 'root-future' ? h.now + 1 : fault === 'root-start-missing' ? null : h.boot + 1000 } } : { state: 'exited', pid });
        if (fault === 'child-start-missing') h.query.mockImplementation(pid => pid === 777003 ? { state: 'alive', identity: { pid, startedAt: null } } : { state: 'exited', pid });
        if (fault === 'root-unknown' || fault === 'child-unknown') h.query.mockImplementation(pid => pid === (fault === 'child-unknown' ? 777003 : 777002)
          ? { state: 'unknown', pid, error: 'permission denied' } : { state: 'exited', pid });
        if (fault === 'tree-live') h.tree.mockReturnValue({ state: 'live', survivors: [{ pid: 777004, ppid: 777002, startedAt: null }], via: 'live-tree' });
        if (fault === 'tree-failed' || fault === 'tree-unsupported') h.tree.mockReturnValue({ state: fault === 'tree-failed' ? 'failed' : 'unsupported', error: 'unavailable' });
        if (fault === 'lock-changed') h.tree.mockImplementation(() => { writeFileSync(join(h.lock, 'owner.json'), JSON.stringify({ ...h.current, startedAt: h.current.startedAt + 1 })); return { state: 'checked', survivors: [], verifiedHistoricalPids: [] }; });
        if (fault === 'stop-added') h.tree.mockImplementation(() => { h.stop(); return { state: 'checked', survivors: [], verifiedHistoricalPids: [] }; });
        if (fault === 'missing-job') h.reg.managed_job_id = null;
        if (fault === 'wrong-note') h.reg.note = 'unverified';
        if (fault === 'unmanaged') h.reg.identity_source = 'os-starttime';
        if (fault === 'missing-root-start') h.reg.started_at_ms = null;
        if (fault === 'current-not-newer') h.reg.registered_at = h.current.startedAt;
        if (fault === 'same-boot') expect(h.verify).toThrow(/重启 Windows 后再检查；不会重发/);
        else if (fault.startsWith('margin')) expect(h.verify).toThrow(/仅等待后重新检查或重新打开应用不会改变/);
        else expect(h.verify).toThrow();
      } finally { h.db.close(); }
    });
  }

  it('a fixed too-close boot never becomes valid merely by waiting, but a later boot beyond10 seconds does', () => {
    const h = fixture();
    try {
      h.readBoot.mockReturnValue(h.registered + 11_000);
      expect(h.verify).toThrow('至少等待10秒再重启 Windows');
      expect(() => verifyPreviousManagedOwnerExit(h.db, h.reg, { appDataDir: h.dir, instance: h.current,
        now: h.now + 60 * 60_000, bootStartedAt: h.readBoot, query: h.query, treeScan: h.tree })).toThrow('至少等待10秒再重启 Windows');
      h.readBoot.mockReturnValue(h.registered + 11_001);
      expect(h.verify().source).toBe('windows-system-reboot');
    } finally { h.db.close(); }
  });

  for (const reused of ['root', 'child', 'both'] as const) {
    it(`accepts verified post-boot ${reused} PID reuse without killing or traversing the new root tree`, () => {
      const h = fixture();
      try {
        h.query.mockImplementation(pid => ((pid === 777002 && reused !== 'child') || (pid === 777003 && reused !== 'root'))
          ? { state: 'alive', identity: { pid, startedAt: h.boot + 10_000 } } : { state: 'exited', pid });
        if (reused !== 'child') h.tree.mockImplementation(() => { throw Error('must not inspect the unrelated new execution'); });
        const evidence = h.verify();
        expect(evidence.source).toBe('windows-system-reboot');
        expect(evidence.reusedProcesses).toEqual((reused === 'both' ? [777002, 777003] : [reused === 'root' ? 777002 : 777003]).map(pid => ({ pid, startedAt: h.boot + 10_000 })));
        expect(evidence.treeCheck).toBe(reused === 'child' ? 'checked' : 'superseded-by-reboot-root-reuse');
        if (reused === 'child') expect(h.tree).toHaveBeenCalledWith(777002, []);
        else expect(h.tree).not.toHaveBeenCalled();
        expect(h.readBoot).toHaveBeenCalledTimes(2);
      } finally { h.db.close(); }
    });
  }

  for (const fault of ['boot-changed', 'lock-changed', 'stop-added', 'unknown-child'] as const) {
    it(`reused root still rejects ${fault} and cannot bypass the final proof checks`, () => {
      const h = fixture();
      try {
        h.query.mockImplementation(pid => {
          if (pid === 777002) return { state: 'alive', identity: { pid, startedAt: h.boot + 1000 } };
          if (fault === 'unknown-child') return { state: 'unknown', pid, error: 'unavailable' };
          return { state: 'exited', pid };
        });
        h.readBoot.mockImplementationOnce(() => h.boot).mockImplementationOnce(() => {
          if (fault === 'lock-changed') writeFileSync(join(h.lock, 'owner.json'), JSON.stringify({ ...h.current, startedAt: h.current.startedAt + 1 }));
          if (fault === 'stop-added') h.stop();
          return fault === 'boot-changed' ? h.boot + 1 : h.boot;
        });
        expect(h.verify).toThrow();
        expect(h.tree).not.toHaveBeenCalled();
      } finally { h.db.close(); }
    });
  }

  it('completed stop and archived-lock proof retain priority and never query boot', () => {
    const h = fixture();
    try {
      h.readBoot.mockImplementation(() => { throw Error('must not query boot'); });
      h.stop();
      expect(h.verify().owner.basis).toBe('completed-stop-record');
      const archive = join(h.dir, 'locks', `daemon.lock.d.stale-${h.current.startedAt}-${h.current.pid}`);
      mkdirSync(archive); writeFileSync(join(archive, 'owner.json'), JSON.stringify({ pid: 777001, startedAt: h.registered - 10_000 }));
      expect(h.verify().owner.basis).toBe('archived-lock');
      expect(h.readBoot).not.toHaveBeenCalled();
    } finally { h.db.close(); }
  });

  it('conflicting completed stop evidence cannot be bypassed by reboot fallback', () => {
    const h = fixture();
    try {
      h.stop();
      const stop = { pid: 777009, at: h.registered + 20_000, phase: 'closed', stopRequestsSentTo: [h.reg.turn_id] };
      h.db.prepare('INSERT INTO daemon_state VALUES(?,?,?)').run(`daemon:stop:history:${stop.pid}:${stop.at}`, JSON.stringify(stop), stop.at + 1);
      expect(h.verify).toThrow('冲突');
      expect(h.readBoot).not.toHaveBeenCalled();
    } finally { h.db.close(); }
  });
});
