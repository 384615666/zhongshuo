import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { openDatabase } from '../../src/persistence/db.ts';
import { readTaskDetails } from '../../src/daemon/taskDetails.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import type { TaskDetailsResult, TaskHistoryPage } from '../../src/contracts/taskDetails.ts';

describe('R79 isolated history scale (not normal business lifecycle)', () => {
  it('measures bounded detail reading and pages real scoped histories without dispatch or external calls', async () => {
    const db = openDatabase(':memory:');
    try {
      db.exec(`INSERT INTO projects(id,display_name,root_path,canonical_path,directory_identity,created_at) VALUES('p','规模夹具','D:/own','D:/own','{}',0);
        INSERT INTO project_members(id,project_id,display_name,principal_type,enabled) VALUES('m','p','夹具成员','agent',1);
        INSERT INTO conversations(id,project_id,kind) VALUES('c','p','dm');
        INSERT INTO dm_participants(project_id,conversation_id,principal_type,principal_id) VALUES('p','c','human','u');
        INSERT INTO tasks(id,project_id,conversation_id,kind,title,status) VALUES('t','p','c','dm_turn','历史规模夹具','ACTIVE');`);
      for (let i = 0; i < 25; i++) {
        db.prepare(`INSERT INTO workflow_runs(id,task_id,conversation_id,mode,status) VALUES(?,'t','c','DIRECT','SUCCEEDED')`).run(`r${i}`);
        db.prepare(`INSERT INTO agent_turns(id,run_id,conversation_id,member_id,stage_key,status) VALUES(?,?,'c','m','direct.work','SUCCEEDED')`).run(`a${i}`, `r${i}`);
        for (let n = 0; n < 130; n++) db.prepare(`INSERT INTO domain_events(event_id,schema_version,kind,project_id,conversation_id,task_id,run_id,turn_id,payload_json,created_at) VALUES(lower(hex(randomblob(16))),1,'tool.completed','p','c','t',?,?,?,?)`).run(`r${i}`, `a${i}`, JSON.stringify({ toolCallId: `tool${n}`, message: '历史工具活动'.repeat(20) }), n);
      }
      let queries = 0;
      const measured = new Proxy(db, { get(target, key) { if (key === 'prepare') return (...args: Parameters<typeof db.prepare>) => { queries++; return target.prepare(...args); }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
      const timings: number[] = []; let bytes = 0;
      for (let i = 0; i < 20; i++) { const start = performance.now(); const value = readTaskDetails(measured, 't'); timings.push(performance.now() - start); bytes = Buffer.byteLength(JSON.stringify(value)); expect(value.runs.length).toBe(20); }
      const result = { scope: 'isolated synthetic history, 25 runs x 130 events; 20 reads, no worker completion claims', queriesPerRead: queries / 20, payloadBytes: bytes, durationMs: timings, realCalls: 0 };
      if (process.env.ZS_R79_COST_OUTPUT) { mkdirSync('dist', { recursive: true }); writeFileSync(process.env.ZS_R79_COST_OUTPUT, JSON.stringify(result, null, 2)); }
      expect(bytes).toBeGreaterThan(0);
      expect(queries / 20).toBeLessThan(20);
      expect(bytes).toBeLessThan(150_000);
      for(let i=1;i<=60;i++) db.prepare(`INSERT INTO task_deliveries(id,task_id,revision,manifest_hash,artifact_refs_json,change_set_refs_json,verification_refs_json,review_status) VALUES(?,'t',?,'scale-hash','[]','[]','[]','superseded')`).run(`d${i}`,i);
      let commandId=0;
      const raw=(method:string,params:unknown)=>dispatchDaemonCommand({db,localUserId:'u',interruptTurn:async()=>{},appDataDir:'dist/r79-own-scale'}, {protocolVersion:1,commandId:`r79-scale-${++commandId}`,method,params}) as Promise<{ok:boolean;data:unknown;error?:unknown}>;
      const head = (await raw('task.details',{projectId:'p',taskId:'t'})) as {ok:boolean;data:TaskDetailsResult};
      expect(head.ok,JSON.stringify(head)).toBe(true);
      expect(head.data.runs.filter(r=>r.detailLoaded)).toHaveLength(1);
      const rpage=(await raw('task.history',{projectId:'p',taskId:'t',kind:'runs',cursor:head.data.nextCursors!.runs})) as {ok:boolean;data:TaskHistoryPage};
      expect(rpage.ok).toBe(true);expect(rpage.data.items).toHaveLength(5);expect(rpage.data.nextCursor).toBeNull();
      const ids=[...head.data.runs.map(r=>r.id),...rpage.data.items.map(x=>('id' in x?x.id:''))];expect(new Set(ids).size).toBe(25);
      const dpage=(await raw('task.history',{projectId:'p',taskId:'t',kind:'deliveries',cursor:head.data.nextCursors!.deliveries})) as {ok:boolean;data:TaskHistoryPage};
      expect(dpage.data.items).toHaveLength(10);expect(dpage.data.nextCursor).toBeNull();
      // R86 delivery-link boundary: explicitly pinned old version is outside both normal windows.
      db.prepare("UPDATE task_deliveries SET run_id='r0',manifest_hash='old-version-content' WHERE id='d1'").run();
      const pinned=(await raw('task.details',{projectId:'p',taskId:'t',conversationId:'c',deliveryId:'d1'})) as {ok:boolean;data:TaskDetailsResult};
      expect(pinned.ok).toBe(true);expect(pinned.data.selectedRunId).toBe('r0');expect(pinned.data.latestRunId).toBe('r24');
      expect(pinned.data.deliveries).toHaveLength(51);expect(pinned.data.deliveries.find(d=>d.id==='d1')).toMatchObject({revision:1,manifestHash:'old-version-content',runId:'r0'});
      expect(pinned.data.runs.find(r=>r.id==='r0')?.detailLoaded).toBe(true);expect(pinned.data.truncated.deliveries).toBe(true);
      expect((await raw('task.details',{projectId:'p',taskId:'t',deliveryId:'missing-old-version'})).ok).toBe(false);
      db.prepare("INSERT INTO tasks(id,project_id,conversation_id,kind,title,status) VALUES('other-task','p','c','dm_turn','另一个历史目标','DONE')").run();
      expect((await raw('task.details',{projectId:'p',taskId:'other-task',deliveryId:'d1'})).ok).toBe(false);
      let cursor=head.data.nextCursors!.activity;const seqs=head.data.events.map(e=>e.seq);
      // A new head event while paging must neither duplicate nor displace older rows.
      db.prepare(`INSERT INTO domain_events(event_id,schema_version,kind,project_id,conversation_id,task_id,payload_json,created_at) VALUES('new-head',1,'tool.started','p','c','t','{}',999)`).run();
      while(cursor){const page=(await raw('task.history',{projectId:'p',taskId:'t',kind:'activity',cursor})) as {ok:boolean;data:TaskHistoryPage};expect(page.ok).toBe(true);seqs.push(...page.data.items.map(e=>'seq' in e?e.seq:0));cursor=page.data.nextCursor;}
      expect(seqs).toHaveLength(3250);expect(new Set(seqs).size).toBe(3250);expect(seqs.at(-1)).toBe(1);
      const selected=(await raw('task.details',{projectId:'p',taskId:'t',runId:'r0'})) as {data:TaskDetailsResult};expect(selected.data.selectedRunId).toBe('r0');expect(selected.data.runs.find(r=>r.id==='r0')?.events).toHaveLength(120);
      const oldActivity=(await raw('task.history',{projectId:'p',taskId:'t',kind:'activity',runId:'r0',cursor:selected.data.nextCursors!.runActivity})) as {data:TaskHistoryPage};expect(oldActivity.data.items).toHaveLength(10);
      expect((await raw('task.history',{projectId:'wrong',taskId:'t',kind:'activity',cursor:head.data.nextCursors!.activity})).ok).toBe(false);
      expect((await raw('task.history',{projectId:'p',taskId:'t',kind:'runs',cursor:head.data.nextCursors!.activity})).ok).toBe(false);
      expect((await raw('task.history',{projectId:'p',taskId:'t',kind:'activity',runId:'foreign'})).ok).toBe(false);
      db.prepare(`UPDATE dm_participants SET principal_id='other' WHERE conversation_id='c'`).run();
      expect((await raw('task.history',{projectId:'p',taskId:'t',kind:'runs',cursor:head.data.nextCursors!.runs})).ok).toBe(false);
      db.prepare("UPDATE tasks SET owner_member_id='m' WHERE id='t'").run();
      db.prepare("UPDATE agent_turns SET status='UNKNOWN' WHERE id='a0'").run();
      const privateCounts=(await raw('project.memberWorkload',{projectId:'p'})).data as {items:unknown[]};
      expect(privateCounts.items).toContainEqual({memberId:'m',unfinishedTasks:0,activeTurns:0,unknownTurns:0});
      db.prepare("UPDATE dm_participants SET principal_id='u' WHERE conversation_id='c'").run();
      expect(((await raw('project.memberWorkload',{projectId:'p'})).data as {items:unknown[]}).items).toContainEqual({memberId:'m',unfinishedTasks:1,activeTurns:0,unknownTurns:1});
      db.prepare(`INSERT INTO domain_events(event_id,schema_version,kind,project_id,conversation_id,task_id,run_id,payload_json,created_at) VALUES('waiting-question',1,'input.requested','p','c','t','r0',?,999)`).run(JSON.stringify({question:'请确认输出目录；这是只读历史规模夹具'}));
      expect(readTaskDetails(db,'t','r0').runs.find(r=>r.id==='r0')?.events[0]?.summary).toContain('请确认输出目录');
    } finally { db.close(); }
  });
});



