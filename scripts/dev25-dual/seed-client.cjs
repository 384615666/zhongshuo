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

// ---------- 短回归前置状态（--regression；第四十轮重建：全部走正式命令链） ----------
// 恢复演练=可恢复正例（fake 完成 → REVIEW 待验收 → 种子以 changes_requested 驳回 →
// 任务回 ACTIVE+FAILED turn=正式「待返工」形态，**零 SQL 注入**——review-r39 §4.3 合同）。
// 队列演练/远程继续演练=两个独立 paused 会话（R2 桌面与远程不同前置，互不消耗）。

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
    // ---------- 短回归前置（--regression，第四十轮正式链）：恢复演练/队列演练/远程继续演练/PPT ----------
    if (regression) {
      const rg = { interrupted: null, pausedConv: null, pausedRemoteConv: null, pptAttachment: null };
      const convs2 = await cmd(pipe, 'conversation.list', { projectId });
      const l2 = convs2.conversations ?? [];
      // ①恢复演练（可恢复正例——正式链：fake 完成→REVIEW→changes_requested 驳回→ACTIVE+FAILED）。
      // 项目验收策略已开（上方 D5 前置），pendingReview 三重绑定从 conversation.list 读出。
      let dmR = l2.find((c) => c.title === '恢复演练');
      if (dmR == null) {
        const r = await cmd(pipe, 'conversation.create', { projectId, peerMemberId: agents[0].id, title: '恢复演练' });
        dmR = { conversationId: r.conversationId ?? (r.conversation && r.conversation.conversationId) };
      }
      const convOf = async (cid) => {
        const cl = await cmd(pipe, 'conversation.list', { projectId });
        return (cl.conversations ?? []).find((c) => (c.conversationId ?? c.id) === cid);
      };
      {
        const rNow = await convOf(dmR.conversationId);
        const already = rNow != null && rNow.execState === 'interrupted'
          && (rNow.interruptedTasks ?? []).some((t) => t.recoverable === true);
        if (already) {
          rg.interrupted = { conversationId: dmR.conversationId, reused: true };
        } else {
          await cmd(pipe, 'message.submit', { target: { kind: 'dm', projectId, conversationId: dmR.conversationId }, body: 'R40 短回归·恢复演练（完成后由种子驳回进入待返工——恢复入口正例）', intent: 'default', mentions: [] });
          let pending = null;
          for (let i = 0; i < 60 && pending == null; i += 1) {
            await sleep(1000);
            const a = await convOf(dmR.conversationId);
            if (a != null && a.pendingReview != null) pending = a.pendingReview;
          }
          if (pending == null) throw new Error('regression: 恢复演练任务未在 60s 内进入待验收（fake 完成链未达 REVIEW）');
          await cmd(pipe, 'task.review', {
            taskId: pending.taskId, deliveryId: pending.deliveryId, deliveryRevision: pending.revision,
            manifestHash: pending.manifestHash, decision: 'changes_requested',
            note: 'R40 短回归种子：驳回进入待返工（正式恢复入口演练形态，非故障注入）',
          });
          let okTask = null;
          for (let i = 0; i < 10 && okTask == null; i += 1) {
            const a = await convOf(dmR.conversationId);
            const t = (a?.interruptedTasks ?? []).find((x) => x.taskId === pending.taskId);
            if (a != null && a.execState === 'interrupted' && t != null && t.recoverable === true) okTask = t;
            else await sleep(500);
          }
          if (okTask == null) throw new Error('regression: 驳回后未呈现 interrupted+recoverable=true（正式待返工形态异常）');
          rg.interrupted = { conversationId: dmR.conversationId, taskId: pending.taskId, lastRunId: okTask.lastRunId, reused: false };
        }
      }
      // ②队列演练会话：发任务→停滞窗内停止→队列暂停（正式命令链；幂等按标题+paused 态）。
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
        await cmd(pipe, 'message.submit', { target: { kind: 'dm', projectId, conversationId: dmQ.conversationId }, body: 'R40 短回归·队列暂停演练', intent: 'default', mentions: [] });
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
      // ③远程继续演练（独立 paused 会话——R2 桌面继续队列后本会话仍 paused，远程可点；
      // 与队列演练互不消耗，review-r39 §4.5「两独立演练状态」）。
      let dmRC = l2.find((c) => c.title === '远程继续演练');
      if (dmRC == null) {
        const r = await cmd(pipe, 'conversation.create', { projectId, peerMemberId: agents[0].id, title: '远程继续演练' });
        dmRC = { conversationId: r.conversationId ?? (r.conversation && r.conversation.conversationId) };
      }
      {
        const rcNow = await convOf(dmRC.conversationId);
        if (rcNow != null && rcNow.execState === 'paused') {
          rg.pausedRemoteConv = { conversationId: dmRC.conversationId, reused: true };
        } else {
          await cmd(pipe, 'message.submit', { target: { kind: 'dm', projectId, conversationId: dmRC.conversationId }, body: 'R40 短回归·远程继续队列演练', intent: 'default', mentions: [] });
          let st3 = null;
          for (let i = 0; i < 30; i += 1) {
            await sleep(1000);
            const a = await convOf(dmRC.conversationId);
            if (a != null && (a.execState === 'running' || a.execState === 'queued') && a.activeRunId != null) { st3 = a; break; }
          }
          if (st3 == null) throw new Error('regression: 远程继续演练任务未在 30s 内进入执行');
          await cmd(pipe, 'task.stop', { taskId: st3.activeTaskId, targetRunId: st3.activeRunId, expectedStopGeneration: st3.activeStopGeneration ?? 0 });
          let paused3 = false;
          for (let i = 0; i < 30; i += 1) {
            await sleep(1000);
            const a = await convOf(dmRC.conversationId);
            if (a != null && a.execState === 'paused') { paused3 = true; break; }
          }
          if (!paused3) throw new Error('regression: 远程继续演练停止后未进入 paused');
          rg.pausedRemoteConv = { conversationId: dmRC.conversationId, reused: false };
        }
      }
      // 房间任务卡样本（r55，review-r54 §6：干净种子的房间看板没有可点击任务卡——其它任务
      // 都在 DM。H3 短测 H2 需要一张真实房间任务卡）。走正式链（@ 启用成员 DIRECT——M0 只
      // 开放 DIRECT，未指派会受阻，不种 BLOCKED 样本）。**成员选择与等待边界（r55 二修）**：
      //  ① bat 的 ZS_FAKE_STALL_MS=60000 让每个 fake turn 先停 60s——种子任务必须给
      //    **非 agents[0]** 的成员（agents[0]=恢复/远程演练 owner，也是 UI 短测/@Guide A 派发
      //    的对象）：同成员在途 turn 会被成员级互斥挂起后续派发（首轮跑挂根因——种子任务占
      //    住 m_0，验证器自己的派发 OPEN 永不领取；停机落在停滞窗内还留下 UNKNOWN turn，
      //    run2 被恢复守卫按成员持有）。选房间名单里非 agents[0] 的启用 agent（演示项目=
      //    Guide B）；没有则如实跳过。
      //  ② 不等终态（60s 停滞必然超窗）——只等线程/任务出现在 room.pool（≤20s）；任务会在
      //    种子退出后 ~60s 自行完成（REVIEW），远早于任何停机点——终态留证由 UI 阶段核。
      if (regression) {
        try {
          const rooms0b = await cmd(pipe, 'room.list', { projectId });
          const room0b = (rooms0b.items ?? []).find((r) => r.name === '默认房间');
          if (room0b == null) throw new Error('regression: 房间任务样本目标房间「默认房间」不存在');
          const markerTask = 'R55 短回归·看板房间任务样本';
          const pool0 = await cmd(pipe, 'room.pool', { roomId: room0b.id }).catch(() => null);
          const hit0 = pool0 != null ? (pool0.threads ?? pool0.items ?? []).find((t) => (t.title ?? '').includes(markerTask) || (t.body?.text ?? '').includes(markerTask)) : null;
          if (hit0 != null) {
            rg.roomTask = 'reused';
            rg.roomTaskThread = { threadId: hit0.threadId ?? hit0.id, taskId: hit0.taskId ?? null };
          } else {
            const roster = await cmd(pipe, 'member.list', { projectId, roomId: room0b.id });
            const pick = (roster.items ?? []).find((m) => m.principalType === 'agent' && m.enabled !== false && m.id !== agents[0].id);
            if (pick == null) {
              rg.roomTask = 'skipped-no-non-first-agent-member'; // 房间只有 agents[0]——占用会阻塞演练/短测派发，如实跳过
            } else {
              await cmd(pipe, 'message.submit', {
                target: { kind: 'room_root', projectId, conversationId: room0b.conversationId, roomId: room0b.id },
                body: `${markerTask}（@成员 DIRECT——看板可点击任务卡）`, intent: 'default', mentions: [{ kind: 'member', memberId: pick.id }],
              });
              // 只等线程出现（任务创建同步于 submit；60s 停滞窗口内状态=进行中，终态自然到达）。
              let info = null;
              for (let i = 0; i < 20; i += 1) {
                await sleep(1000);
                const poolX = await cmd(pipe, 'room.pool', { roomId: room0b.id }).catch(() => null);
                const hitX = poolX != null ? (poolX.threads ?? poolX.items ?? []).find((t) => (t.title ?? '').includes(markerTask) || (t.body?.text ?? '').includes(markerTask)) : null;
                if (hitX != null) { info = { taskId: hitX.taskId ?? null, threadId: hitX.threadId ?? hitX.id }; break; }
              }
              rg.roomTask = info != null ? 'dispatched' : 'submitted-thread-not-visible';
              rg.roomTaskThread = info;
              rg.roomTaskMember = pick.id;
            }
          }
        } catch (e) {
          rg.roomTask = `failed: ${(e && e.message) || String(e)}`; // 种子失败不阻断其余自测——如实记录
        }
      }
      // PPT 附件：包内 seed/回归幻灯.pptx → 房间仅记录消息（芯片可点开预览——R6 用）。
      // 第四十三轮（review-r42 §5 / v5 现场）：**显式绑定「默认房间」身份**——旧实现取
      // room.list.items[0]，v5 实际落到了 Lab Room（顺序漂移→指南入口与数据不符）。找不到
      // 目标房间=失败退出（不静默 fallback 到任意房间）；最终房间/线程/附件身份写入 seed
      // 事实（指南与自测按事实核对入口）。
      const pptPath = path.join(path.dirname(process.argv[1] ?? ''), '回归幻灯.pptx');
      if (fs.existsSync(pptPath)) {
        const rooms0 = await cmd(pipe, 'room.list', { projectId });
        const room0 = (rooms0.items ?? []).find((r) => r.name === '默认房间');
        if (room0 == null) throw new Error('regression: 种子目标房间「默认房间」不存在（不回退任意房间——房间/线程身份须明确）');
        rg.pptRoom = { roomId: room0.id, roomName: room0.name, conversationId: room0.conversationId };
        // 幂等查重：room.pool 只收 roomId（strictObject——多传 projectId 会被拒），且池=线程
        // 摘要不含附件文件名——改查锚消息正文唯一标记（第四十轮自测暴露：旧文件名检查恒
        // false→每启重传+重发）。
        const pool = await cmd(pipe, 'room.pool', { roomId: room0.id }).catch(() => null);
        const marker = 'R40 短回归·PPT 预览样本';
        const hit = pool != null ? (pool.threads ?? pool.items ?? []).find((t) => (t.title ?? '').includes(marker) || (t.body?.text ?? '').includes(marker)) : null;
        if (hit != null) {
          rg.pptAttachment = 'reused';
          rg.pptThread = { threadId: hit.threadId ?? hit.id, anchorText: hit.body?.text ?? hit.title };
        } else {
          const b64 = fs.readFileSync(pptPath).toString('base64');
          const att0 = await cmd(pipe, 'attachment.uploadOffice', { conversationId: room0.conversationId, filename: '回归幻灯.pptx', contentBase64: b64 });
          const sent = await cmd(pipe, 'message.submit', { target: { kind: 'room_root', projectId, conversationId: room0.conversationId, roomId: room0.id }, body: 'R40 短回归·PPT 预览样本（点击附件芯片预览）', intent: 'record_only', mentions: [], attachmentRefs: [att0.attachmentId] });
          rg.pptAttachment = att0.attachmentId;
          rg.pptMessageId = sent.messageId ?? null;
          // 回读线程身份（指南「打开回复串→根消息芯片」的真实入口核对用）。
          const pool2 = await cmd(pipe, 'room.pool', { roomId: room0.id }).catch(() => null);
          const hit2 = pool2 != null ? (pool2.threads ?? pool2.items ?? []).find((t) => (t.title ?? '').includes(marker) || (t.body?.text ?? '').includes(marker)) : null;
          if (hit2 != null) rg.pptThread = { threadId: hit2.threadId ?? hit2.id, anchorText: hit2.body?.text ?? hit2.title };
        }
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
