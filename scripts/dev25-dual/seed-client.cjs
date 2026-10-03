'use strict';
/**
 * DEV-25 双机验收——服务端种子客户端（第三十二轮六建；第三十三轮一收口幂等+演练）。
 * 经命名管道+本机凭据（server-data/local.token）走**正式命令面**创建合成数据：
 * 项目（内置 fake、真实派发硬防护）→ 两 Agent → 验收策略开 → 房间+第二房间 → 两条私信
 * （DM A 给停止演练、DM B 给验收演练）→ 附件样本+仅记录消息。零真实模型调用。
 * 第三十三轮一：
 * - **幂等**（同一包第二次启动不重复造数据）：project.open 命中已建项目；验收策略按
 *   project.open 返回的当前 revision+taskReviewEnabled 决定是否 SET（不再固定
 *   expectedRevision=0）；房间/私信按名称/标题查重后才建；附件样本与种子消息仅首次落。
 * - **停止演练（--drill）**：DM A 发起默认意图任务（进 fake 停滞窗）→轮询执行态→
 *   task.stop（绑 targetRunId+expectedStopGeneration）→等收口→事实写 seed.json。
 * - 连接/握手/命令全部有截止；**认证前 close 立即失败**（旧实现挂起等重试耗尽）。
 * 输出 RESULTS/seed.json（无任何凭据字段——脱敏）。纯 Node（打包内 runtime/node.exe 运行）。
 */
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const appDataDir = argOf('--appdata');
const pipeName = argOf('--pipe');
const demoRoot = argOf('--demo');
const drill = args.includes('--drill');
const regression = args.includes('--regression');
if (appDataDir == null || pipeName == null || demoRoot == null) {
  console.error('usage: node seed-client.cjs --appdata <dir> --pipe <name> --demo <dir> [--drill]');
  process.exit(2);
}

// ---------- 第三十九轮 §5：短回归前置状态（--regression） ----------
const path0 = require('node:path');
const crypto0 = require('node:crypto');
function openDb(appDataDir) {
  // 包内 better-sqlite3（self-check 同法）；WAL 多进程写与 daemon 并存（短事务）。
  const candidates = [
    path0.join(path0.dirname(path0.dirname(process.argv[1] ?? '')), 'ZhongshuoDual', 'resources', 'app', 'daemon', 'node_modules', 'better-sqlite3'),
  ];
  for (const c of candidates) { try { return require(require('node:path').join(c)); } catch { /* 下一个 */ } }
  return null;
}
/**
 * 构造「停机中断待恢复」形态（与 applyRecovery 同型；dev25FieldFixes 集成测试同构造）：
 * ACTIVE 任务+唯一 INTERRUPTED run+UNKNOWN turn（budget 已结算+无未释放租约=可恢复）+
 * 初始 outbox 已完结。幂等：按任务标题查重。
 */
function seedInterruptedShape(appDataDir, dbFile, conversationId) {
  const Database = openDb(appDataDir);
  if (Database == null) return { ok: false, reason: 'better-sqlite3 不可达' };
  const db = new Database(dbFile);
  try {
    const existing = db.prepare("SELECT id FROM tasks WHERE title = ? AND status = 'ACTIVE'").get('R39 短回归·中断恢复任务');
    if (existing != null) return { ok: true, reused: true, taskId: existing.id };
    const conv = db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(conversationId);
    const owner = db.prepare("SELECT dp.principal_id AS m FROM dm_participants dp WHERE dp.conversation_id = ? AND dp.principal_type = 'agent'").get(conversationId);
    if (conv == null || owner == null) return { ok: false, reason: '会话/成员缺失' };
    const taskId = 'task_r39seed_' + crypto0.randomUUID().slice(0, 8);
    const runId = 'run_r39seed_' + crypto0.randomUUID().slice(0, 8);
    const turnId = 'turn_r39seed_' + crypto0.randomUUID().slice(0, 8);
    const now = Date.now();
    db.transaction(() => {
      db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, root_message_id, owner_member_id, title, status, revision, route_json, input_through_seq, created_at)
        VALUES (?, ?, ?, 'dm_turn', NULL, ?, 'R39 短回归·中断恢复任务', 'ACTIVE', 0, '{"kind":"dispatch","mode":"DIRECT"}', 0, ?)`)
        .run(taskId, conv.project_id, conversationId, owner.m, now);
      db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, task_revision, status) VALUES (?, ?, ?, 'DIRECT', 0, 'INTERRUPTED')`).run(runId, taskId, conversationId);
      db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status, dispatch_key, attempt, epoch, budget_mark)
        VALUES (?, ?, ?, ?, 'direct.work', 'UNKNOWN', ?, 1, 1, 'settled')`).run(turnId, runId, conversationId, owner.m, 'dmtask:' + taskId + ':initial');
      db.prepare(`INSERT INTO outbox (dispatch_key, status, stop_generation_at_enqueue) VALUES (?, 'done', 0)`).run('dmtask:' + taskId + ':initial');
      db.prepare(`INSERT INTO domain_events (event_id, project_id, task_id, run_id, turn_id, kind, created_at, payload_json)
        VALUES (?, ?, ?, ?, ?, 'task.r39SeedInterrupted', ?, ?)`).run('evt_' + crypto0.randomUUID(), conv.project_id, taskId, runId, turnId, now, JSON.stringify({ note: '短回归前置：合成停机中断形态（种子构造——非真实执行）' }));
    })();
    return { ok: true, reused: false, taskId };
  } finally { db.close(); }
}

function connectOnce(token, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipeName);
    let buffer = '';
    let authed = false;
    let settled = false;
    const pending = new Map();
    const failAll = (err) => { for (const p of pending.values()) p.reject(err); pending.clear(); socket.destroy(); };
    socket.setEncoding('utf8');
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('handshake deadline'));
      failAll(new Error('handshake deadline'));
    }, timeoutMs ?? 8000);
    socket.on('connect', () => socket.write(JSON.stringify({ type: 'auth', token }) + '\n'));
    socket.on('error', (e) => { if (!authed && !settled) { settled = true; clearTimeout(deadline); reject(e); } else failAll(e); });
    socket.on('close', () => {
      // 认证前 close：立即失败（第三十三轮一——旧实现无 reject 挂到重试耗尽）。
      if (!authed && !settled) { settled = true; clearTimeout(deadline); reject(new Error('pipe closed before auth')); return; }
      failAll(new Error('pipe closed'));
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const idx = buffer.indexOf('\n');
        if (idx < 0) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        if (!authed) {
          if (msg.type === 'auth.ok') { authed = true; settled = true; clearTimeout(deadline); resolve(client); }
          else if (!settled) { settled = true; clearTimeout(deadline); reject(new Error('auth failed: ' + line.slice(0, 120))); }
          continue;
        }
        const p = pending.get(msg.commandId);
        if (p != null) { pending.delete(msg.commandId); clearTimeout(p.timer); p.resolve(msg); }
      }
    });
    const client = {
      send: (envelope) => new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(envelope.commandId); reject(new Error('cmd timeout: ' + envelope.method)); }, timeoutMs ?? 30_000);
        pending.set(envelope.commandId, { resolve, reject, timer: t });
        socket.write(JSON.stringify(envelope) + '\n');
      }),
      close: () => socket.destroy(),
    };
  });
}

async function connectWithRetry(token, attempts = 40) {
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const c = await connectOnce(token, 8000);
      return c;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error('daemon pipe connect failed: ' + String(lastErr && lastErr.message));
}

const cmdCounters = {};
async function cmd(pipe, method, params) {
  const commandId = 'seed-' + crypto.randomUUID().slice(0, 12);
  const out = await pipe.send({ protocolVersion: 1, commandId, method, params });
  cmdCounters[method] = (cmdCounters[method] ?? 0) + 1;
  if (out.ok === false) throw new Error(method + ' -> ' + JSON.stringify(out.error).slice(0, 200));
  return out.data;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // local.token 由 UI 启动 daemon 时生成（时序不保证先于本进程）——有界等待文件出现。
  const tokenPath = path.join(appDataDir, 'local.token');
  let token = null;
  for (let i = 0; i < 60; i += 1) {
    try { token = fs.readFileSync(tokenPath, 'utf8').trim(); break; } catch (e) { await sleep(1000); }
  }
  if (token == null || token.length === 0) throw new Error('local.token not created after 60s (UI/daemon not ready)');
  const pipe = await connectWithRetry(token);
  const facts = { seededAt: new Date().toISOString(), commands: {}, ids: {}, reused: false, drill: null };
  try {
    fs.mkdirSync(demoRoot, { recursive: true });
    fs.writeFileSync(path.join(demoRoot, 'welcome.md'), '# DEV25 demo project\n\nseed marker SEED-WELCOME-101\n', 'utf8');
    const proj = await cmd(pipe, 'project.open', { path: demoRoot, displayName: 'DEV25 双机验收' });
    const projectId = proj.project.id;
    facts.ids.projectId = projectId;
    if (proj.created === false) facts.reused = true;
    const members = await cmd(pipe, 'member.list', { projectId });
    const agents = (members.items ?? []).filter((m) => m.principalType === 'agent');
    facts.ids.agents = agents.map((a) => ({ id: a.id, name: a.displayName }));
    // 验收策略（D5 前置——任务完成进 REVIEW 待验收）。幂等：已开则跳过；revision 取当前项目行
    // （project.open 返回——不再固定 expectedRevision=0，第二次启动不再 STALE）。
    const projRevision = proj.project.revision ?? 0;
    const reviewOn = proj.project.taskReviewEnabled === true;
    if (!reviewOn) {
      await cmd(pipe, 'project.reviewPolicy.set', { projectId, taskReviewEnabled: true, expectedRevision: projRevision });
    } else {
      facts.reused = true;
    }
    // 第二房间（房间面）——按名称查重。
    const rooms = await cmd(pipe, 'room.list', { projectId });
    const room2Existing = (rooms.items ?? []).some((r) => r.name === 'Lab Room');
    if (!room2Existing) {
      const room2 = await cmd(pipe, 'room.create', { projectId, name: 'Lab Room' });
      facts.ids.room2 = room2.roomId ?? room2.room?.id ?? null;
    } else {
      const hit = (rooms.items ?? []).find((r) => r.name === 'Lab Room');
      facts.ids.room2 = hit ? hit.id : null;
      facts.reused = true;
    }
    // 两条私信按标题查重：A=停止演练（首任务将停在 fake 停滞窗口内），B=验收演练。
    const convs = await cmd(pipe, 'conversation.list', { projectId });
    const list = convs.conversations ?? [];
    const findDm = (title) => list.find((c) => (c.title === title || (c.peerDisplayName ?? '') === title));
    let dmA = findDm('DM A - stop drill');
    if (dmA == null) {
      const r = await cmd(pipe, 'conversation.create', { projectId, peerMemberId: agents[0].id, title: 'DM A - stop drill' });
      dmA = { conversationId: r.conversationId ?? (r.conversation && r.conversation.conversationId) };
    } else facts.reused = true;
    let dmB = findDm('DM B - accept drill');
    if (dmB == null) {
      const peer = agents[agents.length - 1];
      const r = await cmd(pipe, 'conversation.create', { projectId, peerMemberId: peer.id, title: 'DM B - accept drill' });
      dmB = { conversationId: r.conversationId ?? (r.conversation && r.conversation.conversationId) };
    } else facts.reused = true;
    facts.ids.dmConversationA = dmA.conversationId ?? null;
    facts.ids.dmConversationB = dmB.conversationId ?? null;
    // 附件样本+仅记录消息（DM A——零运行）——仅首次（幂等：重复启动不重复落消息）。
    const hist = await cmd(pipe, 'conversation.history', { conversationId: facts.ids.dmConversationA, limit: 5 });
    if ((hist.messages ?? []).length === 0) {
      const att = await cmd(pipe, 'attachment.uploadText', { conversationId: facts.ids.dmConversationA, filename: 'seed-sample.md', content: '# seed sample\n\nSEED-ATTACH-202\n' });
      facts.ids.seedAttachment = att.attachmentId;
      await cmd(pipe, 'message.submit', { target: { kind: 'dm', projectId, conversationId: facts.ids.dmConversationA }, body: '种子仅记录消息（附件随包导出核对用）SEED-MSG-301', intent: 'record_only', mentions: [], attachmentRefs: [att.attachmentId] });
    } else {
      facts.reused = true;
    }
    facts.commands = cmdCounters;
    // UI 自动打开记忆（正式命令——与「清缓存/换机回退」同链路）：种子后重开/二次启动自动
    // 进入合成项目（首启已开的窗口不受影响——README 指引或重启后生效）。
    await cmd(pipe, 'app.settings.set', { key: 'ui.autoOpenProjectPath', value: demoRoot });
    // ---------- 停止演练（--drill）：DM A 发任务→停滞窗内 task.stop→收口 ----------
    if (drill) {
      const drillStarted = Date.now();
      await cmd(pipe, 'message.submit', { target: { kind: 'dm', projectId, conversationId: facts.ids.dmConversationA }, body: '自测停止演练任务 SEED-DRILL-STOP-1', intent: 'default', mentions: [] });
      let state = null;
      for (let i = 0; i < 30; i += 1) {
        await sleep(1000);
        const cl = await cmd(pipe, 'conversation.list', { projectId });
        const a = (cl.conversations ?? []).find((c) => (c.conversationId ?? c.id) === facts.ids.dmConversationA);
        if (a != null && (a.execState === 'running' || a.execState === 'queued') && a.activeRunId != null) { state = a; break; }
      }
      if (state == null) throw new Error('drill: task did not reach running within 30s');
      const stop = await cmd(pipe, 'task.stop', { taskId: state.activeTaskId, targetRunId: state.activeRunId, expectedStopGeneration: state.activeStopGeneration ?? 0 });
      // 收口口径=run 离开在途（DM 停止后队列可 paused——属正式停止合同事实，不算未收口）。
      let settled = false;
      for (let i = 0; i < 30; i += 1) {
        await sleep(1000);
        const tg = await cmd(pipe, 'task.get', { taskId: state.activeTaskId });
        const ar = tg.task && tg.activeRun;
        if (ar == null || !['RUNNING', 'WAITING', 'STOPPING'].includes(String(ar.status))) { settled = true; break; }
      }
      facts.drill = { taskId: state.activeTaskId, runId: state.activeRunId, stoppedAtExecState: settled ? 'terminal' : 'still-active', stopAccepted: stop != null, elapsedMs: Date.now() - drillStarted };
      if (!settled) throw new Error('drill: task did not settle after stop within 30s');
    }
    // ---------- 短回归前置（--regression）：恢复演练（中断任务）/队列演练（暂停）/PPT 附件 ----------
    if (regression) {
      const rg = { interrupted: null, pausedConv: null, pptAttachment: null };
      // 恢复演练会话 + 合成中断任务（幂等按标题）。
      const convs2 = await cmd(pipe, 'conversation.list', { projectId });
      const l2 = convs2.conversations ?? [];
      let dmR = l2.find((c) => c.title === '恢复演练');
      if (dmR == null) {
        const r = await cmd(pipe, 'conversation.create', { projectId, peerMemberId: agents[0].id, title: '恢复演练' });
        dmR = { conversationId: r.conversationId ?? (r.conversation && r.conversation.conversationId) };
      }
      rg.interrupted = seedInterruptedShape(appDataDir, path.join(appDataDir, 'state.sqlite'), dmR.conversationId);
      if (rg.interrupted.ok !== true) throw new Error('regression: 中断形态构造失败 ' + JSON.stringify(rg.interrupted));
      // 队列演练会话：发任务→停滞窗内停止→队列暂停（正式命令链；幂等按标题+paused 态）。
      let dmQ = l2.find((c) => c.title === '队列演练');
      if (dmQ == null) {
        const r = await cmd(pipe, 'conversation.create', { projectId, peerMemberId: agents[agents.length - 1].id, title: '队列演练' });
        dmQ = { conversationId: r.conversationId ?? (r.conversation && r.conversation.conversationId) };
      }
      const cl2 = await cmd(pipe, 'conversation.list', { projectId });
      const qNow = (cl2.conversations ?? []).find((c) => (c.conversationId ?? c.id) === dmQ.conversationId);
      if (qNow != null && qNow.execState === 'paused') {
        rg.pausedConv = { conversationId: dmQ.conversationId, reused: true };
      } else {
        await cmd(pipe, 'message.submit', { target: { kind: 'dm', projectId, conversationId: dmQ.conversationId }, body: 'R39 短回归·队列暂停演练', intent: 'default', mentions: [] });
        let st2 = null;
        for (let i = 0; i < 30; i += 1) {
          await sleep(1000);
          const cl3 = await cmd(pipe, 'conversation.list', { projectId });
          const a = (cl3.conversations ?? []).find((c) => (c.conversationId ?? c.id) === dmQ.conversationId);
          if (a != null && (a.execState === 'running' || a.execState === 'queued') && a.activeRunId != null) { st2 = a; break; }
        }
        if (st2 == null) throw new Error('regression: 队列演练任务未在 30s 内进入执行');
        await cmd(pipe, 'task.stop', { taskId: st2.activeTaskId, targetRunId: st2.activeRunId, expectedStopGeneration: st2.activeStopGeneration ?? 0 });
        for (let i = 0; i < 30; i += 1) {
          await sleep(1000);
          const cl4 = await cmd(pipe, 'conversation.list', { projectId });
          const a = (cl4.conversations ?? []).find((c) => (c.conversationId ?? c.id) === dmQ.conversationId);
          if (a != null && a.execState === 'paused') break;
        }
        rg.pausedConv = { conversationId: dmQ.conversationId, reused: false };
      }
      // PPT 附件：包内 seed/回归幻灯.pptx → 房间仅记录消息（芯片可点开预览——R6 用）。
      const pptPath = path.join(path.dirname(process.argv[1] ?? ''), '回归幻灯.pptx');
      if (fs.existsSync(pptPath)) {
        const rooms0 = await cmd(pipe, 'room.list', { projectId });
        const room0 = (rooms0.items ?? [])[0];
        const pool = await cmd(pipe, 'room.pool', { projectId, roomId: room0 != null ? room0.id : undefined }).catch(() => null);
        const alreadyPpt = pool != null && JSON.stringify(pool).includes('回归幻灯.pptx');
        if (!alreadyPpt) {
          const b64 = fs.readFileSync(pptPath).toString('base64');
          const att0 = await cmd(pipe, 'attachment.uploadOffice', { conversationId: room0 != null ? room0.conversationId : undefined, filename: '回归幻灯.pptx', contentBase64: b64 });
          await cmd(pipe, 'message.submit', { target: { kind: 'room_root', projectId, conversationId: room0.conversationId, roomId: room0.id }, body: 'R39 短回归·PPT 预览样本（点击附件芯片预览）', intent: 'record_only', mentions: [], attachmentRefs: [att0.attachmentId] });
          rg.pptAttachment = att0.attachmentId;
        } else rg.pptAttachment = 'reused';
      }
      facts.regression = rg;
    }
    const resultsDir = path.join(path.dirname(appDataDir), 'RESULTS');
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(path.join(resultsDir, 'seed.json'), JSON.stringify(facts, null, 2), 'utf8');
    console.log('[seed] OK reused=' + facts.reused + ' ' + JSON.stringify(facts.ids) + (facts.drill != null ? ' drill=' + JSON.stringify(facts.drill) : ''));
  } finally {
    pipe.close();
  }
  process.exit(0);
})().catch((e) => {
  console.error('[seed] FAILED: ' + (e && e.message));
  process.exit(1);
});
