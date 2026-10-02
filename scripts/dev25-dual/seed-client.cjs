'use strict';
/**
 * DEV-25 双机验收——服务端种子客户端（第三十二轮六）。
 * 经命名管道+本机凭据（server-data/local.token）走**正式命令面**创建合成数据：
 * 项目（内置 fake、真实派发硬防护）→ 两 Agent → 验收策略开 → 房间+第二房间 → 两条私信
 * （DM A 给停止演练、DM B 给验收演练）→ 附件样本+仅记录消息。零真实模型调用。
 * 输出 RESULTS/seed.json（无任何凭据字段——脱敏）。
 * 纯 Node（打包内 runtime/node.exe 运行）；重试等 daemon 就绪（UI 先启动）。
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
if (appDataDir == null || pipeName == null || demoRoot == null) {
  console.error('usage: node seed-client.cjs --appdata <dir> --pipe <name> --demo <dir>');
  process.exit(2);
}

function connectOnce(token, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipeName);
    let buffer = '';
    let authed = false;
    const pending = new Map();
    const failAll = (err) => { for (const p of pending.values()) p.reject(err); pending.clear(); socket.destroy(); };
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ type: 'auth', token }) + '\n'));
    socket.on('error', (e) => { if (!authed) reject(e); else failAll(e); });
    socket.on('close', () => failAll(new Error('pipe closed')));
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
          if (msg.type === 'auth.ok') { authed = true; resolve(client); }
          else reject(new Error('auth failed: ' + line.slice(0, 120)));
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

(async () => {
  // local.token 由 UI 启动 daemon 时生成（时序不保证先于本进程）——有界等待文件出现。
  const tokenPath = path.join(appDataDir, 'local.token');
  let token = null;
  for (let i = 0; i < 60; i += 1) {
    try { token = fs.readFileSync(tokenPath, 'utf8').trim(); break; } catch (e) { await new Promise((r) => setTimeout(r, 1000)); }
  }
  if (token == null || token.length === 0) throw new Error('local.token not created after 60s (UI/daemon not ready)');
  const pipe = await connectWithRetry(token);
  const facts = { seededAt: new Date().toISOString(), commands: {}, ids: {} };
  try {
    fs.mkdirSync(demoRoot, { recursive: true });
    fs.writeFileSync(path.join(demoRoot, 'welcome.md'), '# DEV25 demo project\n\nseed marker SEED-WELCOME-101\n', 'utf8');
    const proj = await cmd(pipe, 'project.open', { path: demoRoot, displayName: 'DEV25 双机验收' });
    const projectId = proj.project.id;
    facts.ids.projectId = projectId;
    const members = await cmd(pipe, 'member.list', { projectId });
    const agents = (members.items ?? []).filter((m) => m.principalType === 'agent');
    facts.ids.agents = agents.map((a) => ({ id: a.id, name: a.displayName }));
    // 验收策略开（D5 前置——任务完成进 REVIEW 待验收）。
    await cmd(pipe, 'project.reviewPolicy.set', { projectId, taskReviewEnabled: true, expectedRevision: 0 });
    // 第二房间（房间面）。
    const room2 = await cmd(pipe, 'room.create', { projectId, name: 'Lab Room' });
    facts.ids.room2 = room2.roomId ?? room2.room?.id ?? null;
    // 两条私信：A=停止演练（首任务将停在 fake 停滞窗口内），B=验收演练。
    const dmA = await cmd(pipe, 'conversation.create', { projectId, peerMemberId: agents[0].id, title: 'DM A - stop drill' });
    const dmB = await cmd(pipe, 'conversation.create', { projectId, peerMemberId: agents[agents.length - 1].id, title: 'DM B - accept drill' });
    facts.ids.dmConversationA = (dmA && (dmA.conversationId ?? (dmA.conversation && dmA.conversation.conversationId))) ?? null;
    facts.ids.dmConversationB = (dmB && (dmB.conversationId ?? (dmB.conversation && dmB.conversation.conversationId))) ?? null;
    // 附件样本+仅记录消息（DM A——零运行）。
    const att = await cmd(pipe, 'attachment.uploadText', { conversationId: facts.ids.dmConversationA, filename: 'seed-sample.md', content: '# seed sample\n\nSEED-ATTACH-202\n' });
    facts.ids.seedAttachment = att.attachmentId;
    await cmd(pipe, 'message.submit', { target: { kind: 'dm', projectId, conversationId: facts.ids.dmConversationA }, body: '种子仅记录消息（附件随包导出核对用）SEED-MSG-301', intent: 'record_only', mentions: [], attachmentRefs: [att.attachmentId] });
    facts.commands = cmdCounters;
    const resultsDir = path.join(path.dirname(appDataDir), 'RESULTS');
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(path.join(resultsDir, 'seed.json'), JSON.stringify(facts, null, 2), 'utf8');
    console.log('[seed] OK ' + JSON.stringify(facts.ids));
  } finally {
    pipe.close();
  }
  process.exit(0);
})().catch((e) => {
  console.error('[seed] FAILED: ' + (e && e.message));
  process.exit(1);
});
