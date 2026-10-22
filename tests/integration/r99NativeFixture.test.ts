import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDatabase } from '../../src/persistence/db.ts';
import { isDispatchGateHeld } from '../../src/persistence/daemonState.ts';
import { readExecutionBlocker } from '../../src/daemon/taskDetails.ts';

const root = mkdtempSync(join(tmpdir(), 'zs-r99-native-fixture-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('R99 reusable native fixture', () => {
  it('creates a self-contained appData with unknown holder, blocked pending tasks and a readable non-final file', () => {
    const out = join(root, 'fixture');
    const run = spawnSync(process.execPath, [join(process.cwd(), 'scripts', 'create-r99-native-fixture.mjs'), out], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    const metadata = JSON.parse(readFileSync(join(out, 'fixture-metadata.json'), 'utf8')) as {
      appDataDir: string; database: string; projectId: string; projectRoot: string;
      pendingTasks: Array<{ taskId: string; taskNumber: number; blocker: { reason: string; blockingTurnStatus: string; blockingRootTaskNumber: number } }>;
      unknownHolder: { taskId: string; turnId: string; protectionState: string };
      observedFile: {
        messageId: string; artifactId: string; revision: number; sizeBytes: number; hash: string; filename: string;
        expectedUi: { recoveryButtonDataAttr: string; recoveryEvent: string; remainsOnTaskRoute: boolean };
      };
    };
    expect(metadata.pendingTasks).toHaveLength(2);
    expect(metadata.pendingTasks.every((item) =>
      Number.isInteger(item.taskNumber)
      && item.blocker.reason === 'unknown-turn'
      && item.blocker.blockingTurnStatus === 'UNKNOWN'
      && Number.isInteger(item.blocker.blockingRootTaskNumber)
      && item.blocker.blockingRootTaskNumber !== item.taskNumber)).toBe(true);
    expect(metadata.observedFile).toMatchObject({ revision: 1, filename: 'r99-observed-draft.md' });
    expect(metadata.observedFile.expectedUi).toMatchObject({
      recoveryButtonDataAttr: 'data-zs-open-recovery="1"',
      recoveryEvent: 'zs:open-recovery',
      remainsOnTaskRoute: true,
    });
    expect(metadata.observedFile.sizeBytes).toBeGreaterThan(10_000);

    const db = openDatabase(metadata.database);
    try {
      expect(isDispatchGateHeld(db)).toBe(true);
      expect(db.prepare('SELECT count(*) AS c FROM task_deliveries').get()).toMatchObject({ c: 0 });
      expect(db.prepare('SELECT status,protection_state FROM agent_turns WHERE id=?').get(metadata.unknownHolder.turnId))
        .toMatchObject({ status: 'UNKNOWN', protection_state: 'retained' });
      for (const item of metadata.pendingTasks) {
        expect(readExecutionBlocker(db, item.taskId)).toMatchObject({ reason: 'unknown-turn', blockingTaskId: metadata.unknownHolder.taskId });
      }
      const attachment = db.prepare(`SELECT ma.display_name,a.id AS artifact_id,a.revision,a.blob_path
        FROM message_attachments ma JOIN artifacts a ON a.id=ma.artifact_id WHERE ma.message_id=?`).get(metadata.observedFile.messageId) as {
          display_name: string; artifact_id: string; revision: number; blob_path: string;
        };
      expect(attachment).toMatchObject({ display_name: 'r99-observed-draft.md', artifact_id: metadata.observedFile.artifactId, revision: 1 });
      expect(readFileSync(attachment.blob_path).length).toBe(metadata.observedFile.sizeBytes);
      const body = JSON.parse((db.prepare('SELECT body_json FROM messages WHERE id=?').get(metadata.observedFile.messageId) as { body_json: string }).body_json) as { text: string };
      expect(body.text).toContain('结果尚未确认');
      expect(body.text).toContain('不是最终交付');
    } finally {
      db.close();
    }
  }, 30_000);
});
