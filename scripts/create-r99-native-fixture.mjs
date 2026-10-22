import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase } from '../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../src/daemon/commands.ts';
import { holdDispatchGate } from '../src/persistence/daemonState.ts';
import { appendDomainEvent } from '../src/persistence/events.ts';
import { readExecutionBlocker } from '../src/daemon/taskDetails.ts';
import { snapshotGeneratedFiles } from '../src/daemon/generatedFileSnapshots.ts';

const out = resolve(process.argv[2] ?? process.env.ZS_R99_FIXTURE_OUT ?? '');
if (out === '' || out === resolve('.')) throw new Error('用法：node scripts/create-r99-native-fixture.mjs <独立输出目录>');
if (existsSync(join(out, 'appdata', 'state.sqlite'))) throw new Error(`输出目录已有 fixture 数据库，拒绝覆盖：${out}`);

const projectRoot = join(out, 'project');
const appDataDir = join(out, 'appdata');
mkdirSync(projectRoot, { recursive: true });
mkdirSync(appDataDir, { recursive: true });
const db = openDatabase(join(appDataDir, 'state.sqlite'));

const command = async (method, params) => {
  const result = await dispatchDaemonCommand(
    { db, localUserId: 'r99-local', interruptTurn: async () => {}, appDataDir },
    { protocolVersion: 1, commandId: `r99-fixture-${randomUUID()}`, method, params },
  );
  if (!result.ok) throw new Error(`${method}: ${result.error?.message ?? 'unknown error'}`);
  return result.data;
};

try {
  const opened = await command('project.open', { path: projectRoot });
  const projectId = opened.project.id;
  const first = await command('member.create', { projectId, displayName: 'Codex 执行者' });
  const second = await command('member.create', { projectId, displayName: 'Claude 评审者' });
  await command('member.setRuntime', { memberId: first.memberId, kind: 'codex', model: 'gpt-6.1-sol', permissionMode: 'bypassPermissions' });
  await command('member.setRuntime', { memberId: second.memberId, kind: 'claude', model: 'claude-sonnet-4-5', permissionMode: 'plan' });
  const room = (await command('room.list', { projectId })).items[0];

  const submit = async (body, params = {}) => command('message.submit', {
    target: { kind: 'room_root', projectId, roomId: room.id, conversationId: room.conversationId },
    body, intent: 'default', mentions: [], ...params,
  });
  const deliberate1 = await submit('合成研讨甲：检查同一目录写入链', {
    collaboration: 'deliberate',
    mentions: [{ kind: 'member', memberId: first.memberId }, { kind: 'member', memberId: second.memberId }],
  });
  const deliberate2 = await submit('合成研讨乙：检查同一目录写入链', {
    collaboration: 'deliberate',
    mentions: [{ kind: 'member', memberId: first.memberId }, { kind: 'member', memberId: second.memberId }],
  });
  const auto = await submit('合成自动协作：写入一份约 20KB 观察稿');

  const taskRow = (taskId) => db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  const pending = [taskRow(deliberate1.taskId), taskRow(deliberate2.taskId)];
  const holder = taskRow(auto.taskId);
  const holderRunId = 'run_r99_unknown_holder';
  const holderTurnId = 'turn_r99_unknown_holder';

  const insertPendingRun = (task, runId, index) => {
    db.prepare(`INSERT INTO workflow_runs (id,task_id,conversation_id,thread_id,mode,task_revision,status,stage)
      VALUES(?,?,?,?, 'DELIBERATE',0,'RUNNING','CROSS_REVIEW')`).run(
      runId, task.id, task.conversation_id, task.conversation_thread_id,
    );
    db.prepare("DELETE FROM outbox WHERE dispatch_key LIKE 'task:' || ? || ':%'").run(task.id);
    db.prepare('INSERT INTO outbox (dispatch_key,stop_generation_at_enqueue) VALUES(?,?)').run(
      `task:${task.id}:delib:${runId}:CR:${first.memberId}:0:w`, index,
    );
  };
  insertPendingRun(pending[0], 'run_r99_pending_cr_a', 1);
  insertPendingRun(pending[1], 'run_r99_pending_cr_b', 2);

  db.prepare(`INSERT INTO workflow_runs (id,task_id,conversation_id,thread_id,mode,task_revision,status,stage)
    VALUES(?,?,?,?, 'AUTO',0,'INTERRUPTED','实施')`).run(
    holderRunId, holder.id, holder.conversation_id, holder.conversation_thread_id,
  );
  db.prepare(`INSERT INTO agent_turns
    (id,run_id,conversation_id,thread_id,member_id,stage_key,turn_purpose,status,dispatch_key,attempt,epoch,collab_absence_ms,collab_turn_deadline_ms,collab_config_revision,stop_generation_snapshot,protection_state,exec_started_at)
    VALUES(?,?,?,?,?, 'direct.work','stage_work','UNKNOWN',?,1,1,1200000,0,0,0,'retained',?)`).run(
    holderTurnId, holderRunId, holder.conversation_id, holder.conversation_thread_id, first.memberId,
    `task:${holder.id}:initial`, Date.now() - 90_000,
  );
  db.prepare("DELETE FROM outbox WHERE dispatch_key LIKE 'task:' || ? || ':%'").run(holder.id);
  db.prepare(`INSERT INTO workspace_leases (lock_domain,owner_turn_id,epoch,heartbeat_at,status)
    VALUES(?,?,1,?,'active')`).run(resolve(projectRoot), holderTurnId, Date.now());

  appendDomainEvent(db, {
    schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId, conversationId: holder.conversation_id,
    threadId: holder.conversation_thread_id, taskId: holder.id, runId: holderRunId, turnId: holderTurnId,
    kind: 'tool.started', createdAt: Date.now() - 95_000,
    payload: {
      toolCallId: 'fixture-file-change', toolName: 'fileChange', action: 'edit',
      target: 'r99-observed-draft.md', argumentsSummary: '{"files":["r99-observed-draft.md"]}',
      paths: ['r99-observed-draft.md'], memberId: first.memberId, stage: 'direct.work',
    },
  });
  appendDomainEvent(db, {
    schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId, conversationId: holder.conversation_id,
    threadId: holder.conversation_thread_id, taskId: holder.id, runId: holderRunId, turnId: holderTurnId,
    kind: 'tool.completed', createdAt: Date.now() - 94_000,
    payload: {
      toolCallId: 'fixture-file-change', toolName: 'fileChange', action: 'edit',
      target: 'r99-observed-draft.md', outcome: 'success', resultRef: 'tool-success', memberId: first.memberId,
    },
  });

  const observedText = `# R99 观察稿\n\n${'这份文件由 fixture 自造，只用于核对“可读但未完成交付”的原生界面。\n'.repeat(200)}`;
  writeFileSync(join(projectRoot, 'r99-observed-draft.md'), observedText, 'utf8');
  const observedAt = Date.now() - 60_000;
  const observedMessageId = `msg_observed_${holderTurnId}`;
  const conversationSeq = (db.prepare('UPDATE conversations SET last_message_seq=last_message_seq+1 WHERE id=? RETURNING last_message_seq')
    .get(holder.conversation_id)).last_message_seq;
  const threadSeq = (db.prepare('UPDATE conversation_threads SET last_message_seq=last_message_seq+1,revision=revision+1 WHERE id=? RETURNING last_message_seq')
    .get(holder.conversation_thread_id)).last_message_seq;
  const observedMetadata = {
    observedFileSnapshot: {
      runId: holderRunId, turnId: holderTurnId, taskId: holder.id, observedAt,
      outcomeStatus: 'UNKNOWN', reason: 'fixture-provider-terminal-missing',
    },
  };
  db.prepare(`INSERT INTO messages
    (id,project_id,conversation_id,conversation_seq,room_id,thread_id,task_id,thread_message_seq,author_type,author_id,body_json,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,'system','system:file-snapshot',?,'saved',?)`).run(
    observedMessageId, projectId, holder.conversation_id, conversationSeq, holder.room_id,
    holder.conversation_thread_id, holder.id, threadSeq,
    JSON.stringify({ text: '【执行结果未确认 · 文件观察快照】', ...observedMetadata }), observedAt,
  );
  const snapshot = snapshotGeneratedFiles({
    db, appDataDir, projectId, projectRoot, taskId: holder.id, runId: holderRunId, turnId: holderTurnId,
    memberId: first.memberId, conversationId: holder.conversation_id,
    versionScopeKey: holder.id, messageId: observedMessageId,
    mode: 'observed-unconfirmed', declaredFiles: [], observedFiles: ['r99-observed-draft.md'],
    turnDiff: null, access: { fullAccess: true, modificationAuthorized: true, root: projectRoot },
  });
  if (snapshot.registered.length !== 1) throw new Error(`观察快照未登记：${JSON.stringify(snapshot.failures)}`);
  const humanBody = [
    '【执行结果未确认 · 文件观察快照】',
    `本轮执行中断，结果尚未确认。观察时间：${new Date(observedAt).toLocaleString('zh-CN', { hour12: false })}。`,
    '当时可稳定读取的文件已保存为只读副本，可打开查看。',
    '这些副本不是最终交付，原文件保持原样；请以本轮正式结果为准。',
  ].join('\n');
  db.prepare('UPDATE messages SET body_json=? WHERE id=?').run(JSON.stringify({ text: humanBody, ...observedMetadata }), observedMessageId);

  holdDispatchGate(db);
  const blockers = [...pending].map((task) => ({
    taskId: task.id,
    taskNumber: task.room_task_number,
    blocker: readExecutionBlocker(db, task.id),
  }));
  const registered = snapshot.registered[0];
  const attachment = db.prepare('SELECT ma.id,ma.display_name,a.hash,a.revision,a.blob_path FROM message_attachments ma JOIN artifacts a ON a.id=ma.artifact_id WHERE ma.message_id=?').get(observedMessageId);
  const artifactBytes = readFileSync(attachment.blob_path);
  const metadata = {
    format: 'zhongshuo-r99-native-fixture-v1',
    generatedAt: Date.now(),
    appDataDir,
    database: join(appDataDir, 'state.sqlite'),
    projectRoot,
    projectId,
    roomId: room.id,
    conversationId: room.conversationId,
    pendingTasks: blockers,
    unknownHolder: {
      taskId: holder.id,
      threadId: holder.conversation_thread_id,
      runId: holderRunId,
      turnId: holderTurnId,
      protectionState: 'retained',
      writeRootKey: resolve(projectRoot),
    },
    observedFile: {
      messageId: observedMessageId,
      attachmentId: attachment.id,
      artifactId: registered.artifactId,
      filename: attachment.display_name,
      revision: attachment.revision,
      sizeBytes: artifactBytes.length,
      hash: createHash('sha256').update(artifactBytes).digest('hex'),
      sourcePath: registered.sourcePath,
      expectedUi: {
        openable: true, nonFinalMarker: true, status: '执行结果未确认',
        recoveryButtonDataAttr: 'data-zs-open-recovery="1"',
        recoveryEvent: 'zs:open-recovery',
        remainsOnTaskRoute: true,
      },
    },
    expectedFacts: {
      pendingTasksAreNotModelWorking: true,
      pendingTasksIdentifyUnknownHolder: true,
      observedFileIsReadableButNotFinal: true,
      noTaskDeliveryCreated: true,
      dispatchGateHeld: true,
    },
  };
  writeFileSync(join(out, 'fixture-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, out, metadata: join(out, 'fixture-metadata.json') }));
} finally {
  db.close();
}
