import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { appendDomainEvent } from '../../src/persistence/events.ts';
import { readTaskExecutionStatus } from '../../src/daemon/executionStatus.ts';
import type { TaskExecutionStatus } from '../../src/contracts/executionStatus.ts';
import { taskExecutionStatusSummary } from '../../src/ui/hifi/components/ExecutionStatus.tsx';

interface CommandResponse {
  ok: boolean;
  data?: unknown;
  error?: unknown;
}

interface BaseFixture {
  dir: string;
  projectDir: string;
  db: ReturnType<typeof openDatabase>;
  projectId: string;
  roomId: string;
  conversationId: string;
  memberA: string;
  memberB: string;
  memberC: string;
  command<T>(method: string, params: unknown): Promise<T>;
  dispose(): void;
}

interface SeededStatuses {
  preDispatch: TaskExecutionStatus;
  queued: TaskExecutionStatus;
  dmQueued: TaskExecutionStatus;
  peerBefore: TaskExecutionStatus;
  peerAfter: TaskExecutionStatus;
  waitingUser: TaskExecutionStatus;
  stopping: TaskExecutionStatus;
  unknown: TaskExecutionStatus;
  completed: TaskExecutionStatus;
}

function assertTemporaryTarget(path: string): void {
  const target = resolve(path);
  const root = resolve(tmpdir());
  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error(`Refusing to remove non-temporary test path: ${target}`);
  }
}

function removeTemporary(path: string): void {
  assertTemporaryTarget(path);
  rmSync(path, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

async function command<T>(
  fixture: Omit<BaseFixture, 'command' | 'dispose'>,
  method: string,
  params: unknown,
): Promise<T> {
  const response = await dispatchDaemonCommand(
    {
      db: fixture.db,
      appDataDir: fixture.dir,
      localUserId: 'u_local',
      interruptTurn: async () => {},
    },
    { protocolVersion: 1, commandId: randomUUID(), method, params },
  ) as CommandResponse;
  expect(response.ok, JSON.stringify(response)).toBe(true);
  return response.data as T;
}

async function createBase(prefix: string): Promise<BaseFixture> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const projectDir = join(dir, 'project');
  mkdirSync(projectDir, { recursive: true });
  const db = openDatabase(join(dir, 'state.sqlite'));
  const partial = {
    dir,
    projectDir,
    db,
    projectId: '',
    roomId: '',
    conversationId: '',
    memberA: '',
    memberB: '',
    memberC: '',
  };
  const cmd = <T,>(method: string, params: unknown) => command<T>(partial, method, params);
  const project = await cmd<{ project: { id: string } }>('project.open', { path: projectDir });
  const room = (await cmd<{ items: Array<{ id: string; conversationId: string }> }>('room.list', {
    projectId: project.project.id,
  })).items[0]!;
  const memberA = (await cmd<{ memberId: string }>('member.create', {
    projectId: project.project.id,
    displayName: '执行甲',
  })).memberId;
  const memberB = (await cmd<{ memberId: string }>('member.create', {
    projectId: project.project.id,
    displayName: '执行乙',
  })).memberId;
  const memberC = (await cmd<{ memberId: string }>('member.create', {
    projectId: project.project.id,
    displayName: '执行丙',
  })).memberId;
  Object.assign(partial, {
    projectId: project.project.id,
    roomId: room.id,
    conversationId: room.conversationId,
    memberA,
    memberB,
    memberC,
  });
  return {
    ...partial,
    command: cmd,
    dispose() {
      db.close();
      removeTemporary(dir);
    },
  };
}

function insertRoomTask(
  fixture: BaseFixture,
  input: {
    id: string;
    number: number;
    ownerMemberId: string;
    status: string;
    parentTaskId?: string;
    threadId?: string;
    title?: string;
  },
): string {
  const threadId = input.threadId ?? `thr_${input.id}`;
  if (input.threadId == null) {
    fixture.db.prepare(
      `INSERT INTO conversation_threads
        (id,project_id,conversation_id,room_id,anchor_message_id,root_task_id,status,last_message_seq,revision)
       VALUES(?,?,?,?,?,NULL,'open',0,0)`,
    ).run(threadId, fixture.projectId, fixture.conversationId, fixture.roomId, `anchor_${input.id}`);
  }
  fixture.db.prepare(
    `INSERT INTO tasks
      (id,project_id,conversation_id,kind,room_id,conversation_thread_id,root_message_id,
       room_task_number,owner_member_id,parent_task_id,title,status,review_policy)
     VALUES(? ,? ,? ,'room_task',? ,?,NULL,? ,?,?,? ,?,'auto_deliver')`,
  ).run(
    input.id,
    fixture.projectId,
    fixture.conversationId,
    fixture.roomId,
    threadId,
    input.parentTaskId == null ? input.number : null,
    input.ownerMemberId,
    input.parentTaskId ?? null,
    input.title ?? input.id,
    input.status,
  );
  if (input.threadId == null) {
    fixture.db.prepare('UPDATE conversation_threads SET root_task_id=? WHERE id=?').run(input.id, threadId);
  }
  return threadId;
}

function insertRun(
  fixture: BaseFixture,
  input: {
    id: string;
    taskId: string;
    threadId: string | null;
    status: string;
    mode?: string;
    stage?: string | null;
  },
): void {
  fixture.db.prepare(
    `INSERT INTO workflow_runs
      (id,task_id,conversation_id,thread_id,mode,status,stage)
     VALUES(?,?,?,?,?,?,?)`,
  ).run(
    input.id,
    input.taskId,
    fixture.conversationId,
    input.threadId,
    input.mode ?? 'AUTO',
    input.status,
    input.stage ?? null,
  );
}

function insertTurn(
  fixture: BaseFixture,
  input: {
    id: string;
    runId: string;
    taskId: string;
    threadId: string | null;
    memberId: string;
    status: string;
    stage?: string;
  },
): void {
  fixture.db.prepare(
    `INSERT INTO agent_turns
      (id,run_id,conversation_id,thread_id,member_id,stage_key,status,dispatch_key)
     VALUES(?,?,?,?,?,?,?,?)`,
  ).run(
    input.id,
    input.runId,
    fixture.conversationId,
    input.threadId,
    input.memberId,
    input.stage ?? 'direct.work',
    input.status,
    `dispatch:${input.id}`,
  );
  void input.taskId;
}

function seedStates(fixture: BaseFixture): SeededStatuses {
  const now = Date.now() - 60_000;

  const preThread = insertRoomTask(fixture, {
    id: 'task_r108_pre',
    number: 801,
    ownerMemberId: fixture.memberA,
    status: 'BLOCKED',
    title: '启动前失败',
  });
  fixture.db.prepare(
    `INSERT INTO outbox(id,dispatch_key,turn_id,status) VALUES(81,'task:task_r108_pre:initial',NULL,'done')`,
  ).run();
  appendDomainEvent(fixture.db, {
    schemaVersion: 1,
    eventId: 'evt_r108_pre',
    projectId: fixture.projectId,
    conversationId: fixture.conversationId,
    threadId: preThread,
    taskId: 'task_r108_pre',
    kind: 'task.contextAssemblyFailed',
    createdAt: now,
    payload: {
      reason: 'write-baseline-incomplete',
      message: '写入基线不完整，模型尚未被调用',
      memberId: fixture.memberA,
    },
  });

  const queuedThread = insertRoomTask(fixture, {
    id: 'task_r108_queued',
    number: 802,
    ownerMemberId: fixture.memberC,
    status: 'ACTIVE',
    title: '排队任务',
  });
  fixture.db.prepare(
    `INSERT INTO outbox(id,dispatch_key,turn_id,status) VALUES(82,'task:task_r108_queued:initial',NULL,'pending')`,
  ).run();
  void queuedThread;

  fixture.db.prepare(
    `INSERT INTO conversations(id,project_id,kind,room_id,title,revision,last_message_seq)
     VALUES('dm_r108',?,'dm',NULL,'R108 DM',0,0)`,
  ).run(fixture.projectId);
  fixture.db.prepare(
    `INSERT INTO dm_participants(project_id,conversation_id,principal_type,principal_id)
     VALUES(?,'dm_r108','human','u_local'),(?,'dm_r108','agent',?)`,
  ).run(fixture.projectId, fixture.projectId, fixture.memberC);
  fixture.db.prepare(
    `INSERT INTO tasks
      (id,project_id,conversation_id,kind,room_id,conversation_thread_id,root_message_id,
       room_task_number,owner_member_id,title,status,review_policy)
     VALUES('task_r108_dm',?,'dm_r108','dm_turn',NULL,NULL,NULL,NULL,?,'DM 排队','ACTIVE','auto_deliver')`,
  ).run(fixture.projectId, fixture.memberC);
  fixture.db.prepare(
    `INSERT INTO outbox(id,dispatch_key,turn_id,status) VALUES(83,'dmtask:task_r108_dm:initial',NULL,'pending')`,
  ).run();

  const peerThread = insertRoomTask(fixture, {
    id: 'task_r108_peer',
    number: 803,
    ownerMemberId: fixture.memberA,
    status: 'ACTIVE',
    title: '同伴协作',
  });
  const childA = 'task_r108_peer_child_a';
  const childB = 'task_r108_peer_child_b';
  insertRoomTask(fixture, {
    id: childA,
    number: 804,
    ownerMemberId: fixture.memberA,
    status: 'ACTIVE',
    parentTaskId: 'task_r108_peer',
    threadId: peerThread,
    title: '甲步骤',
  });
  insertRoomTask(fixture, {
    id: childB,
    number: 805,
    ownerMemberId: fixture.memberB,
    status: 'ACTIVE',
    parentTaskId: 'task_r108_peer',
    threadId: peerThread,
    title: '乙步骤',
  });
  insertRun(fixture, {
    id: 'run_r108_peer_parent',
    taskId: 'task_r108_peer',
    threadId: peerThread,
    status: 'WAITING',
    stage: '分工执行',
  });
  fixture.db.prepare(
    `INSERT INTO coordination_runs(run_id,task_id,stop_generation,state,plan_json,created_at)
     VALUES('run_r108_peer_parent','task_r108_peer',0,'running','{}',?)`,
  ).run(now);
  fixture.db.prepare(
    `INSERT INTO coordination_steps(run_id,step_key,child_task_id,role)
     VALUES('run_r108_peer_parent','a',?,'analysis'),('run_r108_peer_parent','b',?,'analysis')`,
  ).run(childA, childB);
  fixture.db.prepare(
    `INSERT INTO run_participants(run_id,member_id,role,expected,status)
     VALUES('run_r108_peer_parent',?,'worker',1,'pending')`,
  ).run(fixture.memberA);
  insertRun(fixture, {
    id: 'run_r108_peer_child_b',
    taskId: childB,
    threadId: peerThread,
    status: 'RUNNING',
  });
  insertTurn(fixture, {
    id: 'turn_r108_peer_child_b',
    runId: 'run_r108_peer_child_b',
    taskId: childB,
    threadId: peerThread,
    memberId: fixture.memberB,
    status: 'RUNNING',
  });
  appendDomainEvent(fixture.db, {
    schemaVersion: 1,
    eventId: 'evt_r108_peer_tool',
    projectId: fixture.projectId,
    conversationId: fixture.conversationId,
    threadId: peerThread,
    taskId: childB,
    runId: 'run_r108_peer_child_b',
    turnId: 'turn_r108_peer_child_b',
    kind: 'tool.started',
    createdAt: now + 20,
    payload: {
      toolCallId: 'tool_r108_peer',
      toolName: 'Read',
      action: 'read',
      target: 'src/peer-input.md',
      argumentsSummary: 'src/peer-input.md',
      memberId: fixture.memberB,
    },
  });
  fixture.db.prepare(
    `INSERT INTO coordination_messages
      (id,coordination_run_id,project_id,conversation_id,thread_id,source_turn_id,source_index,
       source_member_id,target_member_id,purpose,body,body_hash,child_task_id,target_turn_id,
       status,created_at,updated_at)
     VALUES('msg_r108_peer','run_r108_peer_parent',?,?,?,'turn_r108_peer_child_b',1,?,?,
       'ask','等待甲处理','hash_r108',NULL,NULL,'accepted',?,?)`,
  ).run(
    fixture.projectId,
    fixture.conversationId,
    peerThread,
    fixture.memberB,
    fixture.memberA,
    now + 21,
    now + 21,
  );

  const userThread = insertRoomTask(fixture, {
    id: 'task_r108_user',
    number: 806,
    ownerMemberId: fixture.memberA,
    status: 'ACTIVE',
    title: '等待用户',
  });
  insertRun(fixture, {
    id: 'run_r108_user',
    taskId: 'task_r108_user',
    threadId: userThread,
    status: 'WAITING',
    stage: '等待补充',
  });
  insertTurn(fixture, {
    id: 'turn_r108_user',
    runId: 'run_r108_user',
    taskId: 'task_r108_user',
    threadId: userThread,
    memberId: fixture.memberA,
    status: 'WAITING_INPUT',
  });
  appendDomainEvent(fixture.db, {
    schemaVersion: 1,
    eventId: 'evt_r108_input',
    projectId: fixture.projectId,
    conversationId: fixture.conversationId,
    threadId: userThread,
    taskId: 'task_r108_user',
    runId: 'run_r108_user',
    turnId: 'turn_r108_user',
    kind: 'input.requested',
    createdAt: now + 30,
    payload: { message: '请确认采用哪个版本的输入文件', memberId: fixture.memberA },
  });

  const stoppingThread = insertRoomTask(fixture, {
    id: 'task_r108_stopping',
    number: 807,
    ownerMemberId: fixture.memberA,
    status: 'ACTIVE',
    title: '停止中',
  });
  insertRun(fixture, {
    id: 'run_r108_stopping',
    taskId: 'task_r108_stopping',
    threadId: stoppingThread,
    status: 'STOPPING',
  });
  insertTurn(fixture, {
    id: 'turn_r108_stopping',
    runId: 'run_r108_stopping',
    taskId: 'task_r108_stopping',
    threadId: stoppingThread,
    memberId: fixture.memberA,
    status: 'STOPPING',
  });

  const unknownThread = insertRoomTask(fixture, {
    id: 'task_r108_unknown',
    number: 808,
    ownerMemberId: fixture.memberA,
    status: 'ACTIVE',
    title: '结果未知',
  });
  insertRun(fixture, {
    id: 'run_r108_unknown',
    taskId: 'task_r108_unknown',
    threadId: unknownThread,
    status: 'INTERRUPTED',
  });
  insertTurn(fixture, {
    id: 'turn_r108_unknown',
    runId: 'run_r108_unknown',
    taskId: 'task_r108_unknown',
    threadId: unknownThread,
    memberId: fixture.memberA,
    status: 'UNKNOWN',
  });

  const completedThread = insertRoomTask(fixture, {
    id: 'task_r108_completed',
    number: 809,
    ownerMemberId: fixture.memberA,
    status: 'REVIEW',
    title: '已有成果',
  });
  insertRun(fixture, {
    id: 'run_r108_completed',
    taskId: 'task_r108_completed',
    threadId: completedThread,
    status: 'SUCCEEDED',
    stage: 'PUBLISH',
  });
  insertTurn(fixture, {
    id: 'turn_r108_completed',
    runId: 'run_r108_completed',
    taskId: 'task_r108_completed',
    threadId: completedThread,
    memberId: fixture.memberA,
    status: 'SUCCEEDED',
  });
  fixture.db.prepare(
    `INSERT INTO task_deliveries
      (id,task_id,run_id,revision,manifest_hash,artifact_refs_json,change_set_refs_json,
       verification_refs_json,review_status)
     VALUES('dlv_r108','task_r108_completed','run_r108_completed',1,?,'["artifact:art_r108"]','["cs_r108"]','[]','pending')`,
  ).run('a'.repeat(64));
  fixture.db.prepare(
    `UPDATE tasks SET current_delivery_id='dlv_r108' WHERE id='task_r108_completed'`,
  ).run();
  fixture.db.prepare(
    `INSERT INTO artifacts
      (id,project_id,conversation_id,thread_id,task_id,run_id,author_id,kind,revision,hash,blob_path)
     VALUES('art_r108',?,?,?,'task_r108_completed','run_r108_completed',?,'final_report',1,?,'r108-report.json')`,
  ).run(
    fixture.projectId,
    fixture.conversationId,
    completedThread,
    fixture.memberA,
    'b'.repeat(64),
  );
  fixture.db.prepare(
    `INSERT INTO change_sets(id,project_id,task_id,workspace_id,before_ref,after_ref,application_status)
     VALUES('cs_r108',?,'task_r108_completed',NULL,'before:r108','after:r108','applied')`,
  ).run(fixture.projectId);
  appendDomainEvent(fixture.db, {
    schemaVersion: 1,
    eventId: 'evt_r108_reply',
    projectId: fixture.projectId,
    conversationId: fixture.conversationId,
    threadId: completedThread,
    taskId: 'task_r108_completed',
    runId: 'run_r108_completed',
    turnId: 'turn_r108_completed',
    kind: 'thread.replyAdded',
    createdAt: now + 40,
    payload: { messageId: 'msg_r108_missing_body' },
  });

  const preDispatch = readTaskExecutionStatus(fixture.db, 'task_r108_pre')!;
  const queued = readTaskExecutionStatus(fixture.db, 'task_r108_queued')!;
  const dmQueued = readTaskExecutionStatus(fixture.db, 'task_r108_dm')!;
  const peerBefore = readTaskExecutionStatus(fixture.db, 'task_r108_peer')!;

  fixture.db.prepare(`UPDATE agent_turns SET status='SUCCEEDED' WHERE id='turn_r108_peer_child_b'`).run();
  fixture.db.prepare(`UPDATE workflow_runs SET status='SUCCEEDED' WHERE id='run_r108_peer_child_b'`).run();
  const peerAfter = readTaskExecutionStatus(fixture.db, 'task_r108_peer')!;

  return {
    preDispatch,
    queued,
    dmQueued,
    peerBefore,
    peerAfter,
    waitingUser: readTaskExecutionStatus(fixture.db, 'task_r108_user')!,
    stopping: readTaskExecutionStatus(fixture.db, 'task_r108_stopping')!,
    unknown: readTaskExecutionStatus(fixture.db, 'task_r108_unknown')!,
    completed: readTaskExecutionStatus(fixture.db, 'task_r108_completed')!,
  };
}

async function waitUntil(probe: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Timed out: ${label}`);
}

async function verifyExecutionStatusInChromium(
  status: TaskExecutionStatus,
  completed: TaskExecutionStatus,
): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'zs-r108-execution-browser-'));
  try {
    const componentPath = resolve('src/ui/hifi/components/ExecutionStatus.tsx').replaceAll('\\', '/');
    const harnessPath = join(dir, 'harness.tsx');
    const bundlePath = join(dir, 'bundle.mjs');
    const htmlPath = join(dir, 'index.html');
    const mainPath = join(dir, 'main.cjs');
    const resultPath = join(dir, 'result.json');
    writeFileSync(
      harnessPath,
      `import { createRoot } from 'react-dom/client';
import { ExecutionStatus, taskExecutionStatusSummary } from ${JSON.stringify(componentPath)};
import type { TaskExecutionAction, TaskExecutionStatus } from ${JSON.stringify(resolve('src/contracts/executionStatus.ts').replaceAll('\\', '/'))};
const status = ${JSON.stringify(status)} as TaskExecutionStatus;
const completed = ${JSON.stringify(completed)} as TaskExecutionStatus;
const compactSummary = taskExecutionStatusSummary(status);
const actions: TaskExecutionAction[] = [];
createRoot(document.getElementById('root')!).render(
  <div style={{ display: 'grid', gap: 16 }}>
    <div id="compact">
      <ExecutionStatus status={status} onAction={(action) => { actions.push(action); document.body.dataset.clicked = action.kind; }} />
    </div>
    <div id="detail">
      <ExecutionStatus density="detail" status={status} onAction={(action) => { actions.push(action); document.body.dataset.clicked = action.kind; }} />
    </div>
    <div id="completed">
      <ExecutionStatus status={completed} onAction={(action) => { actions.push(action); document.body.dataset.clicked = action.kind; }} />
    </div>
  </div>,
);
requestAnimationFrame(() => requestAnimationFrame(() => {
  const card = document.querySelector<HTMLElement>('#compact [data-zs-execution-status]');
  const detailCard = document.querySelector<HTMLElement>('#detail [data-zs-execution-status]');
  const completedCard = document.querySelector<HTMLElement>('#completed [data-zs-execution-status]');
  const button = card?.querySelector<HTMLButtonElement>('[data-zs-execution-action]');
  button?.click();
  const rect = card?.getBoundingClientRect();
  const completedRect = completedCard?.getBoundingClientRect();
  const compactText = card?.textContent ?? '';
  const detailText = detailCard?.textContent ?? '';
  (window as any).__R108 = {
    mounted: card != null,
    phase: card?.dataset.zsExecutionPhase ?? null,
    performing: card?.dataset.zsPerformingMembers ?? null,
    waiting: card?.dataset.zsWaitingMembers ?? null,
    summary: card?.querySelector('[data-zs-execution-summary]')?.textContent ?? null,
    lastActivity: detailCard?.querySelector('[data-zs-last-business-activity]')?.getAttribute('data-zs-last-business-activity') ?? null,
    actionKinds: [...document.querySelectorAll('[data-zs-execution-action]')].map((item) => item.getAttribute('data-zs-execution-action')),
    clickedKind: document.body.dataset.clicked ?? null,
    callbacks: actions.length,
    reasonVisible: compactText.includes(compactSummary.main) && (compactSummary.detail == null || compactText.includes(compactSummary.detail)),
    noFakePercent: !compactText.includes('%'),
    noEngineeringTerms: !/实际在途|等待准入|变更集|事件 #/.test(compactText),
    compactOneLine: (rect?.height ?? 999) < 64,
    completedOneLine: (completedRect?.height ?? 999) < 64,
    completedSummary: completedCard?.querySelector('[data-zs-execution-summary]')?.textContent ?? null,
    detailHasDiagnostics: /事件 #|diagnostic|诊断/.test(detailText),
    width: rect?.width ?? 0,
    height: rect?.height ?? 0,
    panelStyled: card == null ? false : getComputedStyle(card).borderRadius !== '0px',
  };
}));\n`,
      'utf8',
    );
    await build({
      entryPoints: [harnessPath],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      jsx: 'automatic',
      outfile: bundlePath,
      absWorkingDir: process.cwd(),
      nodePaths: [resolve('node_modules')],
      logLevel: 'silent',
    });
    const css = ['tokens.css', 'base.css', 'components.css']
      .map(file => readFileSync(resolve('src/ui/hifi/styles', file), 'utf8'))
      .join('\n');
    const bundle = readFileSync(bundlePath, 'utf8').replace(/<\/script/gi, '<\\/script');
    writeFileSync(
      htmlPath,
      `<!doctype html><html><head><meta charset="utf-8"><style>${css.replace(/<\/style/gi, '<\\/style>')}body{padding:32px;background:var(--bg)}#root{max-width:760px;margin:auto}</style></head><body><div id="root"></div><script type="module">${bundle}</script></body></html>`,
      'utf8',
    );
    writeFileSync(
      mainPath,
      `const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
app.setPath('userData', join(__dirname, 'user-data'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 760,
    webPreferences: { offscreen: true, contextIsolation: true, sandbox: true },
  });
  await win.loadFile(${JSON.stringify(htmlPath)});
  const result = await win.webContents.executeJavaScript(
    'new Promise((resolve, reject) => { const deadline=Date.now()+15000; const tick=()=>{ if(window.__R108) resolve(window.__R108); else if(Date.now()>deadline) reject(new Error("R108 browser result timeout")); else setTimeout(tick,16); }; tick(); })',
  );
  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
  win.destroy();
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });\n`,
      'utf8',
    );
    const electron = resolve('node_modules/electron/dist/electron.exe');
    let stderr = '';
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(electron, [mainPath], {
        env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr.on('data', data => { stderr += data.toString(); });
      const timer = setTimeout(() => {
        child.kill();
        rejectPromise(new Error(`Electron verification timeout\n${stderr.slice(-1200)}`));
      }, 45_000);
      child.on('error', rejectPromise);
      child.on('exit', code => {
        clearTimeout(timer);
        if (code === 0 && existsSync(resultPath)) resolvePromise();
        else rejectPromise(new Error(`Electron verification failed (${code})\n${stderr.slice(-1200)}`));
      });
    });
    return JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
  } finally {
    removeTemporary(dir);
  }
}

describe('R108 authoritative task execution status', () => {
  it('consumes the formal room command and fake worker without inventing admission progress', async () => {
    vi.stubEnv('ZS_ALLOW_FAKE', '1');
    vi.stubEnv('ZS_RUNTIME', 'fake');
    const fixture = await createBase('zs-r108-worker-');
    await fixture.command('member.setRuntime', {
      memberId: fixture.memberA,
      kind: 'fake',
      permissionMode: 'bypassPermissions',
    });
    await fixture.command('room.update', {
      roomId: fixture.roomId,
      expectedRevision: 0,
      coordinatorMemberId: fixture.memberA,
    });
    const adapter = new FakeRuntimeAdapter({
      turnScriptSequencer: () => [
        {
          kind: 'event',
          event: {
            kind: 'tool.started',
            toolCallId: 'tool_r108_formal',
            toolName: 'Read',
            target: 'src/formal-input.md',
            argumentsSummary: 'src/formal-input.md',
          },
        },
        { kind: 'stall', ms: 60_000 },
      ],
    });
    const worker = new DispatchWorker({
      db: fixture.db,
      adapter,
      leaseOwner: 'r108-worker-test',
      appDataDir: fixture.dir,
      detachedTurnConsumption: true,
    });
    try {
      const sent = await fixture.command<{ taskId: string; threadId: string }>('message.submit', {
        target: {
          kind: 'room_root',
          projectId: fixture.projectId,
          roomId: fixture.roomId,
          conversationId: fixture.conversationId,
        },
        body: '请读取 formal-input.md 并给出结果。',
        intent: 'default',
        mentions: [{ kind: 'member', memberId: fixture.memberA }],
      });
      await worker.runOnce();
      await waitUntil(
        () => fixture.db.prepare(
          "SELECT 1 FROM domain_events WHERE task_id=? AND kind='tool.started' LIMIT 1",
        ).get(sent.taskId) != null,
        8_000,
        'formal fake worker tool activity',
      );
      const status = readTaskExecutionStatus(fixture.db, sent.taskId)!;
      expect(status.phase).toBe('RUNNING');
      expect(status.scope.surfaces).toEqual(['room', 'thread']);
      expect(status.actualPerformingMembers).toEqual([
        expect.objectContaining({
          memberId: fixture.memberA,
          displayName: '执行甲',
          state: 'performing',
          status: 'RUNNING',
        }),
      ]);
      expect(status.actualPerformingMembers[0]!.activity?.summary).toContain('src/formal-input.md');
      expect(status.lastBusinessActivity).toMatchObject({ kind: 'tool', source: 'tool-event' });
      expect(status.evidence.heartbeatUsedAsActivity).toBe(false);

      const turnId = (fixture.db.prepare(
        'SELECT id FROM agent_turns WHERE dispatch_key=?',
      ).get(`task:${sent.taskId}:initial`) as { id: string } | undefined)?.id
        ?? (fixture.db.prepare(
          `SELECT a.id FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id
           WHERE r.task_id=? ORDER BY a.rowid DESC LIMIT 1`,
        ).get(sent.taskId) as { id: string }).id;
      fixture.db.prepare(
        `INSERT INTO workspace_leases(lock_domain,owner_turn_id,epoch,heartbeat_at,status)
         VALUES(?,?,1,?,'active')`,
      ).run(fixture.projectDir, turnId, Date.now() + 60_000);
      const withHeartbeat = readTaskExecutionStatus(fixture.db, sent.taskId)!;
      expect(withHeartbeat.lastBusinessActivity).toEqual(status.lastBusinessActivity);
      expect(withHeartbeat.lastBusinessActivity!.summary).not.toContain('heartbeat');
    } finally {
      await adapter.closeAllSessions();
      await worker.awaitInFlightTurns(3_000);
      fixture.dispose();
      vi.unstubAllEnvs();
    }
  }, 30_000);

  describe('durable projection states', () => {
    let fixture: BaseFixture;
    let statuses: SeededStatuses;

    beforeAll(async () => {
      fixture = await createBase('zs-r108-states-');
      statuses = seedStates(fixture);
    }, 30_000);

    afterAll(() => {
      fixture.dispose();
    });

    it('covers pre-dispatch failure, queue/admission, waiting peer/user, stopping, UNKNOWN and completion', () => {
      expect(statuses.preDispatch).toMatchObject({
        phase: 'NOT_STARTED_FAILED',
        reason: { code: 'PRE_DISPATCH_FAILED' },
        existingResults: { hasResults: false },
      });
      expect(statuses.preDispatch.actions).toContainEqual(expect.objectContaining({
        kind: 'retry',
        binding: expect.objectContaining({ method: 'task.redispatch', taskId: 'task_r108_pre' }),
      }));

      expect(statuses.queued.phase).toBe('QUEUED');
      expect(statuses.queued.waitingMembers).toEqual([
        expect.objectContaining({ memberId: fixture.memberC, state: 'waiting-peer' }),
      ]);
      expect(statuses.dmQueued.scope.surfaces).toEqual(['dm']);
      expect(statuses.dmQueued.phase).toBe('QUEUED');
      expect(statuses.dmQueued.actions).toContainEqual(expect.objectContaining({
        kind: 'navigate',
        target: { kind: 'dm', id: 'dm_r108' },
      }));

      expect(statuses.peerBefore.phase).toBe('RUNNING');
      expect(statuses.peerBefore.actualPerformingMembers).toEqual([
        expect.objectContaining({ memberId: fixture.memberB, state: 'performing' }),
      ]);
      expect(statuses.peerBefore.waitingMembers).toEqual([
        expect.objectContaining({ memberId: fixture.memberA, state: 'waiting-peer' }),
      ]);
      expect(statuses.peerAfter.phase).toBe('WAITING_FOR_PEER');
      expect(statuses.peerAfter.actualPerformingMembers).toEqual([]);

      expect(statuses.waitingUser.phase).toBe('WAITING_FOR_USER');
      expect(statuses.waitingUser.waitingForUser).toMatchObject({
        kind: 'input',
        message: '请确认采用哪个版本的输入文件',
      });
      expect(statuses.waitingUser.waitingMembers).toEqual([
        expect.objectContaining({ memberId: fixture.memberA, state: 'waiting-user' }),
      ]);
      expect(statuses.stopping.phase).toBe('STOPPING');

      expect(statuses.unknown.phase).toBe('UNKNOWN');
      expect(statuses.unknown.evidence.unknownTurnIds).toEqual(['turn_r108_unknown']);
      expect(statuses.unknown.actions).toContainEqual(expect.objectContaining({
        kind: 'recover',
        target: { kind: 'recovery', id: 'turn_r108_unknown' },
      }));
      expect(taskExecutionStatusSummary(statuses.unknown).detail).not.toMatch(/protection|recovery|turn|保护/);

      expect(statuses.completed.phase).toBe('COMPLETED');
      expect(statuses.completed.waitingForUser).toMatchObject({ kind: 'review', deliveryId: 'dlv_r108' });
      expect(statuses.completed.existingResults).toMatchObject({
        hasResults: true,
        currentDelivery: { id: 'dlv_r108', revision: 1, reviewStatus: 'pending' },
        artifacts: [{ id: 'art_r108' }],
        changeSets: [{ id: 'cs_r108', applicationStatus: 'applied' }],
      });
      expect(statuses.completed.actions).toContainEqual(expect.objectContaining({
        kind: 'review',
        target: { kind: 'delivery', id: 'dlv_r108' },
      }));
      expect(taskExecutionStatusSummary(statuses.completed)).toMatchObject({label:'待你验收',main:'等待你验收 · 交付 v1'});
      expect(taskExecutionStatusSummary({...statuses.completed,waitingForUser:null})).toMatchObject({label:'已完成',main:'已完成 · 交付 v1'});
      for(const phase of ['RUNNING','STOPPING','UNKNOWN'] as const){expect(taskExecutionStatusSummary({...statuses.peerBefore,phase,waitingForUser:statuses.completed.waitingForUser,existingResults:statuses.completed.existingResults}).label).not.toBe('待你验收');}
      const member=statuses.peerBefore.actualPerformingMembers[0]!;
      const unknownTool={...member,activity:{kind:'tool' as const,status:'started' as const,summary:'没有修改，也没有运行检查命令',toolCallId:'unknown'}};
      expect(taskExecutionStatusSummary({...statuses.peerBefore,actualPerformingMembers:[unknownTool]}).main).toContain('正在使用工具');
      expect(taskExecutionStatusSummary({...statuses.peerBefore,actualPerformingMembers:[{...unknownTool,activity:{...unknownTool.activity,action:'command'}}]}).main).toContain('正在执行命令');
      expect(statuses.completed.evidence.heartbeatUsedAsActivity).toBe(false);
    });

    it('mounts the real component in hidden Chromium and exercises its bound action callback', async () => {
      const result = await verifyExecutionStatusInChromium(statuses.peerBefore, statuses.completed);
      expect(result).toMatchObject({
        mounted: true,
        phase: 'RUNNING',
        performing: '执行乙',
        waiting: '执行甲',
        summary: '执行乙正在查资料；执行甲等待结果',
        lastActivity: 'tool',
        callbacks: 1,
        reasonVisible: true,
        noFakePercent: true,
        noEngineeringTerms: true,
        compactOneLine: true,
        completedOneLine: true,
        completedSummary: '等待你验收 · 交付 v1',
        detailHasDiagnostics: true,
        panelStyled: true,
      });
      expect(Number(result.width)).toBeGreaterThan(300);
      expect(Number(result.height)).toBeGreaterThan(32);
      expect(Number(result.height)).toBeLessThan(64);
      expect(['navigate', 'recover', 'review', 'retry']).toContain(result.clickedKind);
    }, 60_000);
  });
});
