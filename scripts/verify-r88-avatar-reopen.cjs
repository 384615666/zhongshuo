/* R88 isolated avatar persistence check. Never points at a user data root. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Cdp, until } = require('./verify-r81-members-launcher.cjs');

const port = Number(process.argv[2]);
const fixtureRoot = path.resolve(process.argv[3] ?? '');
const mode = process.argv[4];
const out = path.resolve(process.argv[5] ?? path.join(fixtureRoot, 'avatar-evidence'));
if (!['set', 'check'].includes(mode)) throw Error('usage: verify-r88-avatar-reopen.cjs <port> <fixture-root> <set|check> <out>');
const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'fixture.json'), 'utf8'));
const expectedFile = path.join(fixtureRoot, 'avatar-expected.json');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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
      await client.send('Page.enable');
      await until(() => client.eval('document.body?.classList.contains("hifi-on")'), Boolean, 'hifi', 30000);
      return client;
    } catch {
      return null;
    }
  }, Boolean, 'owned avatar window', 30000);
}

async function command(cdp, method, params = {}) {
  const envelope = { protocolVersion: 1, commandId: `r88-avatar-${randomUUID()}`, method, params };
  const response = await cdp.eval(`window.zs.command(${JSON.stringify(envelope)})`);
  if (!response?.ok) throw Error(`${method}: ${JSON.stringify(response?.error)}`);
  return response.data;
}

async function route(cdp, hash, selector) {
  await cdp.eval(`location.hash=${JSON.stringify(hash)};true`);
  await until(() => cdp.eval(`document.querySelector(${JSON.stringify(selector)})!=null`), Boolean, hash, 30000);
  await sleep(350);
}

async function shot(cdp, name) {
  await cdp.send('Page.bringToFront');
  await cdp.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(image.data, 'base64'));
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const cdp = await connect();
  const report = { format: 'r88-avatar-reopen-v1', ok: false, mode, port, fixtureRoot, checkedAt: new Date().toISOString() };
  try {
    if (mode === 'set') {
      const image = async (label, color) => await cdp.eval(`(()=>{
        const canvas=document.createElement('canvas');canvas.width=96;canvas.height=96;
        const ctx=canvas.getContext('2d');ctx.fillStyle=${JSON.stringify(color)};ctx.fillRect(0,0,96,96);
        ctx.fillStyle='#fff';ctx.font='bold 50px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(${JSON.stringify(label)},48,51);
        return canvas.toDataURL('image/png');
      })()`);
      const specs = [
        { subject: 'user', label: '你', color: '#e36b2c' },
        ...fixture.members.map((member, index) => ({
          subject: `member:${member.id}`,
          label: index === 0 ? 'C' : 'X',
          color: index === 0 ? '#7c3aed' : '#0f766e',
        })),
      ];
      await command(cdp, 'app.appearance.set', { showAvatars: true });
      await cdp.send('Page.reload', { ignoreCache: true });
      await until(() => cdp.eval('document.body?.classList.contains("hifi-on")'), Boolean, 'hifi reload', 30000);
      await sleep(800);
      await route(cdp, '/settings?section=appearance', '[data-zs-avatar-settings]');
      await cdp.send('DOM.enable');
      const documentNode = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
      const avatars = {};
      for (const spec of specs) {
        const dataUrl = await image(spec.label, spec.color);
        const file = path.join(fixtureRoot, `avatar-${spec.subject.replace(/[^a-z0-9]+/gi, '-')}.png`);
        fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
        const { nodeId } = await cdp.send('DOM.querySelector', {
          nodeId: documentNode.root.nodeId,
          selector: `[data-zs-avatar-subject="${spec.subject}"] input[type=file]`,
        });
        if (!nodeId) throw Error(`avatar input missing: ${spec.subject}`);
        await cdp.send('DOM.setFileInputFiles', { files: [file], nodeId });
        await until(async () => {
          const state = await command(cdp, 'app.appearance.get');
          return state.avatars[spec.subject] === dataUrl;
        }, Boolean, `avatar upload ${spec.subject}`, 15000);
        avatars[spec.subject] = dataUrl;
      }
      const saved = await command(cdp, 'app.appearance.get');
      report.subjects = Object.keys(avatars);
      report.showAvatars = saved.showAvatars;
      report.avatarsPresent = Object.entries(avatars).every(([subject, dataUrl]) => saved.avatars[subject] === dataUrl);
      fs.writeFileSync(expectedFile, JSON.stringify({ showAvatars: true, avatars }, null, 2), 'utf8');
      report.previewImages = await cdp.eval(`document.querySelectorAll('[data-zs-avatar-settings] .avatar img').length`);
      await shot(cdp, '08-custom-avatar-settings');
      await route(cdp, `/project/${fixture.projectId}/room/${fixture.roomId}?thread=${fixture.threadId}`, '.col-thread .msg');
      report.chatImages = await cdp.eval(`document.querySelectorAll('.col-thread .msg-avatar img').length`);
      await shot(cdp, '09-custom-avatar-chat');
      report.ok = report.showAvatars && report.avatarsPresent && report.previewImages >= 3 && report.chatImages > 0;
    } else {
      const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
      const state = await command(cdp, 'app.appearance.get');
      report.subjects = Object.keys(expected.avatars);
      report.showAvatars = state.showAvatars;
      report.avatarsPresent = Object.entries(expected.avatars).every(([subject, dataUrl]) => state.avatars[subject] === dataUrl);
      await route(cdp, `/project/${fixture.projectId}/room/${fixture.roomId}?thread=${fixture.threadId}`, '.col-thread .msg');
      report.chatImages = await cdp.eval(`document.querySelectorAll('.col-thread .msg-avatar img').length`);
      await shot(cdp, '10-custom-avatar-reopened');
      report.ok = report.showAvatars && report.avatarsPresent && report.chatImages > 0;
    }
    fs.writeFileSync(path.join(out, mode === 'set' ? 'set-result.json' : 'reopen-result.json'), JSON.stringify(report, null, 2), 'utf8');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    cdp.ws.close();
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    report.error = String(error?.stack ?? error);
    fs.writeFileSync(path.join(out, mode === 'set' ? 'set-result.json' : 'reopen-result.json'), JSON.stringify(report, null, 2), 'utf8');
    cdp.ws.close();
    throw error;
  }
})().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
