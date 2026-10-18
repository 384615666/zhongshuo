/* R88 visible evidence. Attach only to the explicitly supplied isolated app. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Cdp, until } = require('./verify-r81-members-launcher.cjs');

const port = Number(process.argv[2]);
const fixtureRoot = path.resolve(process.argv[3] ?? '');
const out = path.resolve(process.argv[4] ?? path.join(fixtureRoot, 'capture'));
const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'fixture.json'), 'utf8'));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const q = JSON.stringify;
let cdp = null;

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
  }, Boolean, 'R88 owned window', 30000);
}

async function route(hash, selector) {
  await cdp.eval(`location.hash=${q(hash)};true`);
  await until(() => cdp.eval(`document.querySelector(${q(selector)})!=null`), Boolean, hash, 30000);
  await sleep(350);
}

async function shot(name) {
  await cdp.send('Page.bringToFront');
  await cdp.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(image.data, 'base64'));
}

async function command(method, params = {}) {
  const envelope = { protocolVersion: 1, commandId: `r88-visible-${randomUUID()}`, method, params };
  const response = await cdp.eval(`window.zs.command(${q(envelope)})`);
  if (!response?.ok) throw Error(`${method}: ${JSON.stringify(response?.error)}`);
  return response.data;
}

async function reload() {
  await cdp.send('Page.reload', { ignoreCache: true });
  await until(() => cdp.eval('document.body?.classList.contains("hifi-on")'), Boolean, 'hifi reload', 30000);
  await sleep(1200);
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  cdp = await connect();
  await reload();
  await command('app.appearance.set', { showAvatars: false });
  await reload();
  const report = { format: 'r88-visible-evidence-v1', ok: false, port, fixtureRoot, at: new Date().toISOString(), checks: {}, errors: [] };
  try {
    await route(`/project/${fixture.projectId}/room/${fixture.roomId}?thread=${fixture.threadId}`, '.col-thread .msg');
    await cdp.eval(`(()=>{const box=document.querySelector('.col-thread .msg-list');if(box)box.scrollTop=0;return true})()`);
    await sleep(250);
    const layout = await cdp.eval(`(()=>{
      const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
      const human=[...document.querySelectorAll('.col-thread .msg.msg-human')].at(-1);
      const agent=[...document.querySelectorAll('.col-thread .msg.msg-agent')].at(0);
      const actionText=[...document.querySelectorAll('.col-thread .msg-actions')].map(x=>x.textContent.replace(/\\s+/g,' ').trim());
      const visible=document.querySelector('.col-thread')?.textContent??'';
      return {
        human:human?rect(human):null,agent:agent?rect(agent):null,
        actionText,tableWrap:document.querySelectorAll('.col-thread .md-table-wrap').length,
        codeCards:document.querySelectorAll('.col-thread .md-code-card').length,
        flowcharts:document.querySelectorAll('.col-thread [data-md-diagram=flowchart]').length,
        charts:document.querySelectorAll('.col-thread [data-md-diagram=chart]').length,
        avatarCount:document.querySelectorAll('.col-thread .msg-avatar .avatar').length,
        visibleText:visible.slice(0,20000),
      };
    })()`);
    report.checks.reading = {
      humanRightOfAgent: layout.human != null && layout.agent != null && layout.human.left > layout.agent.left && layout.human.width < layout.agent.width && Math.abs(layout.human.right - layout.agent.right) < 20,
      directlyVisibleActions: layout.actionText.some((text) => text.includes('复制') && text.includes('引用') && text.includes('收藏')),
      wideTable: layout.tableWrap > 0,
      codeCards: layout.codeCards,
      flowcharts: layout.flowcharts,
      charts: layout.charts,
      avatarsHiddenByDefault: layout.avatarCount === 0,
      technicalIdVisible: /m_[A-Za-z0-9_-]{12,}|#[0-9a-f]{4}\b/i.test(layout.visibleText),
      human: layout.human,
      agent: layout.agent,
    };
    await shot('01-chat-reading');
    await cdp.eval(`(()=>{const chart=document.querySelector('.col-thread [data-md-diagram=chart]');chart?.scrollIntoView({block:'center'});return Boolean(chart)})()`);
    await sleep(300);
    await shot('02-chart');

    await route(`/project/${fixture.projectId}/members`, '[data-zs-members]');
    const memberSurface = await cdp.eval(`(()=>({
      cards:document.querySelectorAll('[data-zs-member-card]').length,
      shortMarkers:document.querySelectorAll('[data-zs-member-short]').length,
      text:document.querySelector('[data-zs-members]')?.textContent??'',
      normalText:(()=>{
        const surface=document.querySelector('[data-zs-members]');
        if(!surface)return '';
        const clone=surface.cloneNode(true);
        clone.querySelectorAll('details:not([open])').forEach(node=>node.remove());
        return clone.textContent??'';
      })(),
    }))()`);
    report.checks.members = {
      cards: memberSurface.cards,
      shortMarkers: memberSurface.shortMarkers,
      technicalIdVisible: /m_[A-Za-z0-9_-]{12,}|#[0-9a-f]{4}\b/i.test(memberSurface.text),
      engineeringJargonVisible: /\b(?:fake|工程 Fake|AI 配置)\b|项目编辑档证据|配置依据/i.test(memberSurface.normalText),
    };
    await shot('03-members');

    const bindClicked = await cdp.eval(`(()=>{const b=document.querySelector('[data-zs-member-bind]');if(!b)return false;b.click();return true})()`);
    if (bindClicked) {
      await until(() => cdp.eval('document.querySelector(".modal")!=null'), Boolean, 'member modal', 10000);
      await sleep(750);
      const modalOpacity = await cdp.eval(`(()=>{
        const overlay=document.querySelector('.overlay');
        const modal=document.querySelector('.modal');
        const opacity=Math.min(
          Number.parseFloat(getComputedStyle(overlay??modal).opacity),
          Number.parseFloat(getComputedStyle(modal).opacity)
        );
        return Number.isFinite(opacity)?opacity:0;
      })()`);
      const closeMetrics = await cdp.eval(`(()=>{const h=document.querySelector('.overlay-head').getBoundingClientRect();const b=document.querySelector('.overlay-head > .icon-btn').getBoundingClientRect();const i=document.querySelector('.overlay-head > .icon-btn svg').getBoundingClientRect();return {dx:Math.abs((b.left+b.right)/2-(i.left+i.right)/2),dy:Math.abs((b.top+b.bottom)/2-(i.top+i.bottom)/2),headerDy:Math.abs((h.top+h.bottom)/2-(b.top+b.bottom)/2),rightInset:h.right-b.right,header:{left:h.left,right:h.right,top:h.top,bottom:h.bottom},button:{left:b.left,right:b.right,top:b.top,bottom:b.bottom},icon:{left:i.left,right:i.right,top:i.top,bottom:i.bottom}}})()`);
      closeMetrics.opacity = modalOpacity;
      report.checks.modal = closeMetrics;
      await shot('04-modal-close');
      await cdp.eval(`(()=>{document.querySelector('.overlay-head > .icon-btn')?.click();return true})()`);
    }

    await route('/settings?section=appearance', '[data-zs-avatar-settings]');
    await shot('05-settings-avatars-hidden');
    await command('app.appearance.set', { showAvatars: true });
    await reload();
    await route('/settings?section=appearance', '[data-zs-avatar-settings]');
    const settings = await cdp.eval(`(()=>({
      previewAvatars:document.querySelectorAll('[data-zs-avatar-settings] .avatar').length,
      uploadButtons:[...document.querySelectorAll('[data-zs-avatar-settings] button')].filter(b=>b.textContent.includes('选择图片')).length,
      subjectRows:document.querySelectorAll('[data-zs-avatar-subject]').length,
      toggleOn:document.querySelectorAll('.settings-body .switch-track.on').length>0,
    }))()`);
    report.checks.avatarSettings = settings;
    await shot('06-settings-avatars-shown');

    await route(`/project/${fixture.projectId}/room/${fixture.roomId}?thread=${fixture.threadId}`, '.col-thread .msg');
    await cdp.eval(`(()=>{const box=document.querySelector('.col-thread .msg-list');if(box)box.scrollTop=0;return true})()`);
    await sleep(250);
    report.checks.avatarChat = await cdp.eval(`(()=>({avatars:document.querySelectorAll('.col-thread .msg-avatar .avatar').length,names:[...document.querySelectorAll('.col-thread .msg-author')].map(e=>e.textContent)}))()`);
    await shot('07-chat-avatars-shown');

    const native = await cdp.eval('window.zsWindow.getState()');
    report.nativeWindow = native;
    report.placement = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'placement.json'), 'utf8'));
    report.ok = report.checks.reading.humanRightOfAgent
      && report.checks.reading.directlyVisibleActions
      && report.checks.reading.wideTable
      && report.checks.reading.codeCards > 0
      && report.checks.reading.flowcharts > 0
      && report.checks.reading.charts > 0
      && report.checks.reading.avatarsHiddenByDefault
      && report.checks.reading.technicalIdVisible === false
      && report.checks.members.shortMarkers === 0
      && report.checks.members.technicalIdVisible === false
      && report.checks.members.engineeringJargonVisible === false
      && report.checks.avatarSettings.previewAvatars >= 3
      && report.checks.avatarSettings.uploadButtons >= 3
      && report.checks.avatarChat.avatars > 0
      && (!report.checks.modal || (report.checks.modal.dx < 1.5 && report.checks.modal.dy < 1.5 && report.checks.modal.headerDy < 2 && report.checks.modal.opacity >= 0.99));
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2), 'utf8');
    process.stdout.write(`${JSON.stringify({ ok: report.ok, checks: report.checks, nativeWindow: report.nativeWindow, placement: report.placement }, null, 2)}\n`);
    cdp.ws.close();
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    report.errors.push(String(error?.stack ?? error));
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2), 'utf8');
    throw error;
  }
})().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
