import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/persistence/db.ts';
import {
  readTaskDetails,
  readTaskHistory,
  taskRunBelongsToDetails,
} from '../../src/daemon/taskDetails.ts';

function fixture() {
  const db = openDatabase(':memory:');
  db.exec(`
    INSERT INTO projects(id,display_name,root_path,canonical_path,directory_identity,created_at)
      VALUES('p','R98 合成项目','D:/r98-own','D:/r98-own','{}',0);
    INSERT INTO project_members(id,project_id,display_name,principal_type,enabled) VALUES
      ('m_owner','p','协调者','agent',1),
      ('m_a','p','成员甲','agent',1),
      ('m_b','p','成员乙','agent',1),
      ('m_c','p','成员丙','agent',1);
    INSERT INTO rooms(id,project_id,name,coordinator_member_id) VALUES('room','p','房间','m_owner');
    INSERT INTO room_members(room_id,member_id) VALUES
      ('room','m_owner'),('room','m_a'),('room','m_b'),('room','m_c');
    INSERT INTO conversations(id,project_id,kind,room_id) VALUES('conv','p','room','room');
    INSERT INTO messages(id,project_id,conversation_id,conversation_seq,room_id,author_type,author_id,body_json,created_at)
      VALUES('msg_root','p','conv',1,'room','human','local','{}',0),
            ('msg_ordinary','p','conv',2,'room','human','local','{}',0);
    INSERT INTO conversation_threads(id,project_id,conversation_id,room_id,anchor_message_id)
      VALUES('thread','p','conv','room','msg_root');
    INSERT INTO tasks(id,project_id,conversation_id,kind,room_id,conversation_thread_id,root_message_id,owner_member_id,
      parent_task_id,title,objective,status,review_policy)
      VALUES('parent','p','conv','room_task','room','thread','msg_root','m_owner',NULL,'父协调任务','合成父目标','BLOCKED','auto_deliver');
    INSERT INTO tasks(id,project_id,conversation_id,kind,room_id,conversation_thread_id,root_message_id,owner_member_id,
      parent_task_id,title,objective,status,review_policy)
      VALUES('child_a','p','conv','room_task','room','thread','msg_root','m_a','parent','成员甲实施','合成子目标','DONE','auto_deliver'),
            ('child_b','p','conv','room_task','room','thread','msg_root','m_b','parent','成员乙复核','合成子目标','BLOCKED','auto_deliver'),
            ('child_c','p','conv','room_task','room','thread','msg_root','m_c','parent','成员丙等待','合成子目标','ACTIVE','auto_deliver');
    INSERT INTO tasks(id,project_id,conversation_id,kind,title,status,review_policy)
      VALUES('ordinary','p','conv','dm_turn','普通单运行','DONE','auto_deliver');
    INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status,stage,budget_json)
      VALUES('run_parent','parent','conv','thread','AUTO','WAITING','分工执行','{"maxTurns":24}'),
            ('run_a','child_a','conv','thread','DIRECT','SUCCEEDED','coordination.child',NULL),
            ('run_b','child_b','conv','thread','DIRECT','FAILED','coordination.child',NULL),
            ('run_c','child_c','conv','thread','DIRECT','QUEUED','排队等待',NULL),
            ('run_ordinary','ordinary','conv',NULL,'DIRECT','SUCCEEDED','direct.work',NULL);
    INSERT INTO coordination_runs(run_id,task_id,stop_generation,state,plan_json,error_message,created_at)
      VALUES('run_parent','parent',0,'blocked',NULL,'步骤 r2 未完成；失败原因见成员运行','1000');
    INSERT INTO coordination_steps(run_id,step_key,child_task_id,role,handoff_json) VALUES
      ('run_parent','r1','child_a','implementation',NULL),
      ('run_parent','r2','child_b','review',NULL),
      ('run_parent','r3','child_c','analysis',NULL);
    INSERT INTO agent_turns(id,run_id,conversation_id,thread_id,member_id,stage_key,status) VALUES
      ('turn_a','run_a','conv','thread','m_a','coordination.child','SUCCEEDED'),
      ('turn_b','run_b','conv','thread','m_b','coordination.child','FAILED'),
      ('turn_ordinary','run_ordinary','conv',NULL,'m_a','direct.work','SUCCEEDED');
    INSERT INTO run_participants(run_id,member_id,role,expected,status) VALUES
      ('run_a','m_a','worker',1,'SUCCEEDED'),
      ('run_b','m_b','worker',1,'FAILED');
    INSERT INTO domain_events(event_id,schema_version,kind,project_id,conversation_id,thread_id,task_id,run_id,turn_id,payload_json,created_at) VALUES
      ('evt_a_start',1,'tool.started','p','conv','thread','child_a','run_a','turn_a','{"toolName":"Read","toolCallId":"a1"}',1000),
      ('evt_a_done',1,'tool.completed','p','conv','thread','child_a','run_a','turn_a','{"toolName":"Read","toolCallId":"a1","outcome":"success"}',1002),
      ('evt_b_start',1,'tool.started','p','conv','thread','child_b','run_b','turn_b','{"toolName":"Read","toolCallId":"b1"}',2000),
      ('evt_b_failed',1,'turn.failed','p','conv','thread','child_b','run_b','turn_b','{"code":"PERMISSION_DENIED","message":"无法读取受保护文件","retryable":false}',2001),
      ('evt_b_status',1,'turn.statusChanged','p','conv','thread','child_b','run_b','turn_b','{"status":"FAILED"}',2002);
  `);
  return db;
}

describe('R98 parent coordination details aggregate member child runs', () => {
  it('shows actual member runs, stages, members and persisted failures without inventing activity', () => {
    const db = fixture();
    try {
      const detail = readTaskDetails(db, 'parent');
      expect(detail.selectedRunId).toBe('run_parent');
      expect(detail.runs).toEqual([
        expect.objectContaining({ id: 'run_parent', status: 'WAITING', detailLoaded: true, turns: [] }),
      ]);
      expect(detail.memberRuns).toHaveLength(3);
      const [a, b, c] = detail.memberRuns!;
      expect(a).toMatchObject({
        scope: 'member', coordinationRunId: 'run_parent', coordinationStepKey: 'r1', coordinationRole: 'implementation',
        taskId: 'child_a', taskTitle: '成员甲实施', taskStatus: 'DONE', memberId: 'm_a', memberName: '成员甲',
        id: 'run_a', status: 'SUCCEEDED', stage: 'coordination.child', failure: null, lastActivityAt: 1002,
      });
      expect(a!.turns).toEqual([expect.objectContaining({ id: 'turn_a', memberId: 'm_a', status: 'SUCCEEDED' })]);
      expect(a!.events.map((event) => event.kind)).toEqual(['tool.completed', 'tool.started']);
      expect(b).toMatchObject({
        coordinationStepKey: 'r2', taskId: 'child_b', taskStatus: 'BLOCKED', memberName: '成员乙',
        id: 'run_b', status: 'FAILED', failure: {
          eventKind: 'turn.failed', at: 2001, message: '无法读取受保护文件', code: 'PERMISSION_DENIED',
        }, lastActivityAt: 2002,
      });
      expect(c).toMatchObject({
        coordinationStepKey: 'r3', taskId: 'child_c', taskStatus: 'ACTIVE', memberName: '成员丙',
        id: 'run_c', status: 'QUEUED', turns: [], events: [], failure: null, lastActivityAt: null,
      });
      expect(detail.memberRuns!.every((run) => !Object.hasOwn(run, 'working'))).toBe(true);
      expect(detail.coordination).toMatchObject({
        runId: 'run_parent', state: 'blocked', errorMessage: '步骤 r2 未完成；失败原因见成员运行',
      });
    } finally {
      db.close();
    }
  });

  it('accepts an explicitly queried member run and pages its persisted activity under the parent task', () => {
    const db = fixture();
    try {
      expect(taskRunBelongsToDetails(db, 'parent', 'run_parent', 'conv')).toBe(true);
      expect(taskRunBelongsToDetails(db, 'parent', 'run_b', 'conv')).toBe(true);
      expect(taskRunBelongsToDetails(db, 'parent', 'run_ordinary', 'conv')).toBe(false);

      db.prepare(`INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status,stage)
        VALUES('run_b_retry','child_b','conv','thread','DIRECT','QUEUED','等待重新派发')`).run();
      const selected = readTaskDetails(db, 'parent', 'run_b');
      expect(selected.selectedRunId).toBe('run_b');
      expect(selected.runs.filter((run) => run.detailLoaded)).toHaveLength(0);
      expect(selected.memberRuns?.find((run) => run.id === 'run_b')).toMatchObject({
        scope: 'member', taskId: 'child_b', memberId: 'm_b', status: 'FAILED', stage: 'coordination.child',
        failure: { message: '无法读取受保护文件', code: 'PERMISSION_DENIED' },
      });
      expect(selected.memberRuns?.filter((run) => run.taskId === 'child_b').map((run) => run.id))
        .toEqual(['run_b_retry', 'run_b']);
      expect(selected.nextCursors?.memberRunActivity).toBeNull();

      const history = readTaskHistory(db, { projectId: 'p', taskId: 'parent', kind: 'activity', runId: 'run_b' });
      expect(history.items).toHaveLength(3);
      expect(history.items).toEqual([
        expect.objectContaining({ kind: 'turn.statusChanged', runId: 'run_b', turnId: 'turn_b', status: 'FAILED' }),
        expect.objectContaining({ kind: 'turn.failed', runId: 'run_b', turnId: 'turn_b', code: 'PERMISSION_DENIED' }),
        expect.objectContaining({ kind: 'tool.started', runId: 'run_b', turnId: 'turn_b', toolCallId: 'b1' }),
      ]);
    } finally {
      db.close();
    }
  });

  it('maps an integration attempt back to the same coordination children and leaves ordinary runs unchanged', () => {
    const db = fixture();
    try {
      db.prepare(`INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status,stage)
        VALUES('run_integration','parent','conv','thread','AUTO','FAILED','整合交付')`).run();
      db.prepare(`INSERT INTO coordination_integration_attempts(coordination_run_id,execution_run_id)
        VALUES('run_parent','run_integration')`).run();

      const integration = readTaskDetails(db, 'parent', 'run_integration');
      expect(integration.selectedRunId).toBe('run_integration');
      expect(integration.coordination?.runId).toBe('run_parent');
      expect(integration.memberRuns?.map((run) => run.id)).toEqual(['run_a', 'run_b', 'run_c']);

      const ordinary = readTaskDetails(db, 'ordinary');
      expect(ordinary.selectedRunId).toBe('run_ordinary');
      expect(ordinary.runs[0]).toMatchObject({ id: 'run_ordinary', detailLoaded: true });
      expect(ordinary.runs[0]!.turns).toEqual([expect.objectContaining({ id: 'turn_ordinary', memberId: 'm_a' })]);
      expect(ordinary).not.toHaveProperty('memberRuns');
      expect(ordinary).not.toHaveProperty('memberRunsTruncated');
    } finally {
      db.close();
    }
  });

  it('keeps the persisted failure reason and a real activity cursor beyond the 120-event window', () => {
    const db = fixture();
    try {
      const insert = db.prepare(`INSERT INTO domain_events(event_id,schema_version,kind,project_id,conversation_id,thread_id,task_id,run_id,turn_id,payload_json,created_at)
        VALUES(?,1,'tool.completed','p','conv','thread','child_b','run_b','turn_b','{"toolName":"Read","outcome":"success"}',?)`);
      for (let i = 0; i < 130; i += 1) insert.run(`evt_b_burst_${i}`, 3000 + i);

      const detail = readTaskDetails(db, 'parent', 'run_b');
      const member = detail.memberRuns?.find((run) => run.id === 'run_b');
      expect(member).toMatchObject({
        status: 'FAILED', lastActivityAt: 3129,
        failure: { eventKind: 'turn.failed', at: 2001, message: '无法读取受保护文件', code: 'PERMISSION_DENIED' },
      });
      expect(member?.events).toHaveLength(120);
      expect(member?.eventsTruncated).toBe(true);
      expect(detail.nextCursors?.memberRunActivity).toEqual(expect.any(String));

      const first = readTaskHistory(db, { projectId: 'p', taskId: 'parent', kind: 'activity', runId: 'run_b' });
      expect(first.items).toHaveLength(120);
      expect(first.nextCursor).toBe(detail.nextCursors!.memberRunActivity);
      const older = readTaskHistory(db, {
        projectId: 'p', taskId: 'parent', kind: 'activity', runId: 'run_b', cursor: detail.nextCursors!.memberRunActivity!,
      });
      expect(older.items).toHaveLength(13);
      expect(older.nextCursor).toBeNull();
    } finally {
      db.close();
    }
  });
});
