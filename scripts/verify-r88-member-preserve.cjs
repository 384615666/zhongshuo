/* R88 final-package check: discovery must not orphan a legacy member with DM history. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Cdp, until } = require('./verify-r81-members-launcher.cjs');

const port = Number(process.argv[2]);
const fixtureRoot = path.resolve(process.argv[3] ?? '');
const out = path.resolve(process.argv[4] ?? path.join(fixtureRoot, 'member-preserve-evidence'));
const projectPath = path.join(fixtureRoot, 'dm-preserve-project');

async function connect() {
  return until(async () => {
    try {
      const rows = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }).then((response) => response.json());
      const target = rows.find((row) => row.type === 'page' && row.url.includes('index.html'));
      if (target == null) return null;
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
      });
      const client = new Cdp(ws);
      await client.send('Runtime.enable');
      await until(() => client.eval('document.body?.classList.contains("hifi-on")'), Boolean, 'hifi', 30000);
      return client;
    } catch {
      return null;
    }
  }, Boolean, 'owned member-preserve window', 30000);
}

async function command(cdp, method, params = {}) {
  const envelope = { protocolVersion: 1, commandId: `r88-preserve-${randomUUID()}`, method, params };
  const response = await cdp.eval(`window.zs.command(${JSON.stringify(envelope)})`);
  if (!response?.ok) throw Error(`${method}: ${JSON.stringify(response?.error)}`);
  return response.data;
}

(async () => {
  if (fs.existsSync(projectPath)) throw Error(`project path already exists: ${projectPath}`);
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'README.md'), '# Synthetic DM preservation fixture\n', 'utf8');
  fs.mkdirSync(out, { recursive: true });
  const cdp = await connect();
  const report = { format: 'r88-member-preserve-v1', ok: false, port, fixtureRoot, checkedAt: new Date().toISOString() };
  try {
    const opened = await command(cdp, 'project.open', { path: projectPath, displayName: '私信保留样例', agentNames: ['执行成员'] });
    const projectId = opened.project.id;
    const beforeMembers = await command(cdp, 'member.list', { projectId });
    const legacy = beforeMembers.items.find((member) => member.displayName === '执行成员');
    if (legacy == null) throw Error('legacy bootstrap member missing');
    const dm = await command(cdp, 'conversation.create', { projectId, peerMemberId: legacy.id, title: '仅记录私信' });
    await command(cdp, 'message.submit', {
      target: { kind: 'dm', projectId, conversationId: dm.conversationId },
      body: '这条仅记录私信必须在默认 AI 发现后仍可打开',
      intent: 'record_only',
      mentions: [],
    });
    const beforeConversations = await command(cdp, 'conversation.list', { projectId });
    const discovered = await command(cdp, 'member.discoverDefaults', { projectId });
    const afterMembers = await command(cdp, 'member.list', { projectId });
    const afterConversations = await command(cdp, 'conversation.list', { projectId });

    const describedPath = path.join(fixtureRoot, 'dm-preserve-description-project');
    fs.mkdirSync(describedPath, { recursive: true });
    const describedOpened = await command(cdp, 'project.open', { path: describedPath, displayName: '说明保留样例', agentNames: ['执行成员'] });
    const describedProjectId = describedOpened.project.id;
    const describedBefore = await command(cdp, 'member.list', { projectId: describedProjectId });
    const describedLegacy = describedBefore.items.find((member) => member.displayName === '执行成员');
    if (describedLegacy == null) throw Error('description bootstrap member missing');
    await command(cdp, 'member.update', {
      projectId: describedProjectId,
      memberId: describedLegacy.id,
      expectedRevision: describedLegacy.revision,
      displayName: '执行成员',
      description: '我自己改过的说明',
    });
    const describedDiscovery = await command(cdp, 'member.discoverDefaults', { projectId: describedProjectId });
    const describedAfter = await command(cdp, 'member.list', { projectId: describedProjectId });
    const describedKept = describedAfter.items.find((member) => member.id === describedLegacy.id);

    const avatarPath = path.join(fixtureRoot, 'dm-preserve-avatar-project');
    fs.mkdirSync(avatarPath, { recursive: true });
    const avatarOpened = await command(cdp, 'project.open', { path: avatarPath, displayName: '头像保留样例', agentNames: ['执行成员'] });
    const avatarProjectId = avatarOpened.project.id;
    const avatarBefore = await command(cdp, 'member.list', { projectId: avatarProjectId });
    const avatarLegacy = avatarBefore.items.find((member) => member.displayName === '执行成员');
    if (avatarLegacy == null) throw Error('avatar bootstrap member missing');
    const avatarDataUrl = await cdp.eval(`(()=>{
      const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#b45309';ctx.fillRect(0,0,32,32);
      return canvas.toDataURL('image/png');
    })()`);
    await command(cdp, 'app.appearance.set', { avatar: { subject: `member:${avatarLegacy.id}`, dataUrl: avatarDataUrl } });
    const avatarDiscovery = await command(cdp, 'member.discoverDefaults', { projectId: avatarProjectId });
    const avatarAfter = await command(cdp, 'member.list', { projectId: avatarProjectId });
    const avatarAppearance = await command(cdp, 'app.appearance.get');
    report.projectId = projectId;
    report.legacyMemberId = legacy.id;
    report.dmConversationId = dm.conversationId;
    report.createdKinds = discovered.created.map((item) => item.kind).sort();
    report.removedLegacyPlaceholder = discovered.removedLegacyPlaceholder;
    report.legacyStillPresent = afterMembers.items.some((member) => member.id === legacy.id);
    report.dmPresentBefore = beforeConversations.conversations.some((conversation) => conversation.conversationId === dm.conversationId);
    report.dmPresentAfter = afterConversations.conversations.some((conversation) => conversation.conversationId === dm.conversationId);
    report.customCases = {
      description: {
        removedLegacyPlaceholder: describedDiscovery.removedLegacyPlaceholder,
        legacyStillPresent: describedAfter.items.some((member) => member.id === describedLegacy.id),
        description: describedKept?.description,
      },
      avatar: {
        removedLegacyPlaceholder: avatarDiscovery.removedLegacyPlaceholder,
        legacyStillPresent: avatarAfter.items.some((member) => member.id === avatarLegacy.id),
        avatarStillStored: avatarAppearance.avatars[`member:${avatarLegacy.id}`] === avatarDataUrl,
      },
    };
    report.ok = report.createdKinds.includes('claude')
      && report.createdKinds.includes('codex')
      && report.removedLegacyPlaceholder === false
      && report.legacyStillPresent
      && report.dmPresentBefore
      && report.dmPresentAfter
      && report.customCases.description.removedLegacyPlaceholder === false
      && report.customCases.description.legacyStillPresent
      && report.customCases.description.description === '我自己改过的说明'
      && report.customCases.avatar.removedLegacyPlaceholder === false
      && report.customCases.avatar.legacyStillPresent
      && report.customCases.avatar.avatarStillStored;
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2), 'utf8');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    cdp.ws.close();
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    report.error = String(error?.stack ?? error);
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2), 'utf8');
    cdp.ws.close();
    throw error;
  }
})().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
