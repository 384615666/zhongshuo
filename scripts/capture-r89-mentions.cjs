/* R89 visible inline-mention and document-reference evidence. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const path = require('node:path');
const { Cdp, until } = require('./verify-r81-members-launcher.cjs');

const port = Number(process.argv[2]);
const fixtureRoot = path.resolve(process.argv[3] ?? '');
const out = path.resolve(process.argv[4] ?? path.join(fixtureRoot, 'evidence'));
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
  }, Boolean, 'owned R89 window', 30000);
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

async function setComposer(value, cursor = value.length) {
  await cdp.eval(`(()=>{
    const ta=document.querySelector('textarea.composer-input');
    if(!ta)throw Error('composer missing');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,${q(value)});
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    ta.focus();ta.setSelectionRange(${cursor},${cursor});
    return true;
  })()`);
  await sleep(120);
}

async function composerValue() {
  return await cdp.eval(`document.querySelector('textarea.composer-input')?.value??''`);
}

async function composerMentions() {
  return await cdp.eval(`document.querySelector('.composer')?.getAttribute('data-zs-composer-mentions')??''`);
}

async function clickMentionToolbar() {
  await cdp.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.title.includes('提及成员'));if(!b)throw Error('mention toolbar missing');b.click();return true})()`);
}

async function chooseToolbarMember(memberId) {
  await clickMentionToolbar();
  await until(() => cdp.eval(`document.querySelector('[data-zs-mention-option=${q(memberId)}]')!=null`), Boolean, 'toolbar candidate', 10000);
  await cdp.eval(`document.querySelector('[data-zs-mention-option=${q(memberId)}]').click();true`);
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  cdp = await connect();
  const report = { format: 'r89-visible-mentions-v1', ok: false, port, fixtureRoot, at: new Date().toISOString(), checks: {}, errors: [] };
  try {
    await route(`/project/${fixture.projectId}/room/${fixture.roomId}`, 'textarea.composer-input');

    await setComposer('');
    await clickMentionToolbar();
    await until(() => cdp.eval(`document.querySelector('textarea.composer-input')?.value.startsWith('@')`), Boolean, 'toolbar @ at start');
    const toolbarInsertedAtStart = (await composerValue()).startsWith('@');
    await chooseToolbarMember(fixture.members[0].id);
    await until(async () => (await composerValue()).includes(`@${fixture.members[0].display_name}`), Boolean, 'first toolbar member');
    await chooseToolbarMember(fixture.members[1].id);
    await until(async () => {
      const value=await composerValue();
      const mentions=await composerMentions();
      return value.includes(`@${fixture.members[0].display_name}`)
        && value.includes(`@${fixture.members[1].display_name}`)
        && mentions.includes(fixture.members[0].id)
        && mentions.includes(fixture.members[1].id);
    }, Boolean, 'consecutive toolbar members');
    const toolbarConsecutive = {
      body: await composerValue(),
      mentions: await composerMentions(),
      bothVisible: (await composerValue()).includes(`@${fixture.members[0].display_name}`)
        && (await composerValue()).includes(`@${fixture.members[1].display_name}`),
    };
    await setComposer('');

    await setComposer('@Cl');
    await until(() => cdp.eval(`document.querySelector('[data-zs-mention-option=${q(fixture.members[0].id)}]')!=null`), Boolean, 'Claude candidate');
    await shot('01-mention-candidates');
    await cdp.eval(`document.querySelector('[data-zs-mention-option=${q(fixture.members[0].id)}]').click();true`);
    await until(async () => (await composerValue()).includes('@Claude'), Boolean, 'Claude token');

    let value = await composerValue();
    await setComposer(`${value}@Co`);
    await until(() => cdp.eval(`document.querySelector('[data-zs-mention-option=${q(fixture.members[1].id)}]')!=null`), Boolean, 'Codex candidate');
    await cdp.eval(`document.querySelector('[data-zs-mention-option=${q(fixture.members[1].id)}]').click();true`);
    await until(async () => (await composerValue()).includes('@Codex'), Boolean, 'Codex token');

    value = await composerValue();
    await setComposer(`${value}@合成`);
    await until(() => cdp.eval(`document.querySelector('[data-zs-mention-document="workspace:合成资料.md"]')!=null`), Boolean, 'workspace document candidate');
    await shot('02-document-candidates');
    await cdp.eval(`document.querySelector('[data-zs-mention-document="workspace:合成资料.md"]').click();true`);
    await until(async () => (await composerValue()).includes('@文档：合成资料.md'), Boolean, 'document token');
    await until(() => cdp.eval(`document.querySelectorAll('[data-zs-att="ready"]').length>0`), Boolean, 'document attachment ready', 20000);

    const twoMembers = await composerMentions();
    const bodyWithAll = await composerValue();
    report.checks.inline = {
      toolbarInsertedAtStart,
      toolbarConsecutive,
      bothMembers: twoMembers.includes(fixture.members[0].id) && twoMembers.includes(fixture.members[1].id),
      documentNotRecipient: !twoMembers.includes(fixture.members[2].id),
      bodyContainsMembers: bodyWithAll.includes('@Claude') && bodyWithAll.includes('@Codex'),
      bodyContainsDocument: bodyWithAll.includes('@文档：合成资料.md'),
      readyAttachments: await cdp.eval(`document.querySelectorAll('[data-zs-att="ready"]').length`),
    };
    await shot('03-inline-body-references');

    await setComposer(bodyWithAll.replace(/\s*@Codex/g, ''));
    const afterDelete = await composerMentions();
    await until(async () => !(await composerMentions()).includes(fixture.members[1].id), Boolean, 'delete one keeps others');
    report.checks.deleteOne = {
      otherMemberKept: afterDelete.includes(fixture.members[0].id),
      removedMemberGone: !afterDelete.includes(fixture.members[1].id),
      documentKept: (await composerValue()).includes('@文档：合成资料.md'),
    };

    value = await composerValue();
    await setComposer(`${value}@Co`);
    await until(() => cdp.eval(`document.querySelector('[data-zs-mention-option=${q(fixture.members[1].id)}]')!=null`), Boolean, 'Codex candidate again');
    await cdp.eval(`document.querySelector('[data-zs-mention-option=${q(fixture.members[1].id)}]').click();true`);
    await until(async () => (await composerMentions()).includes(fixture.members[1].id), Boolean, 'Codex restored');

    await cdp.send('Page.reload', { ignoreCache: true });
    await until(() => cdp.eval('document.body?.classList.contains("hifi-on")'), Boolean, 'hifi reload', 30000);
    await sleep(1200);
    await route(`/project/${fixture.projectId}/room/${fixture.roomId}`, 'textarea.composer-input');
    await until(async () => (await composerValue()).includes('@Claude') && (await composerValue()).includes('@Codex') && (await composerValue()).includes('@文档：合成资料.md'), Boolean, 'draft tokens restored');
    const reopenedMentions = await composerMentions();
    report.checks.reopen = {
      bodyTokensRestored: true,
      membersRestored: reopenedMentions.includes(fixture.members[0].id) && reopenedMentions.includes(fixture.members[1].id),
      documentRefsRestored: (await cdp.eval(`document.querySelector('.composer')?.getAttribute('data-zs-composer-documents')??''`)).length > 0,
    };
    await shot('04-mentions-reopened');

    await setComposer(`${await composerValue()} 请分别回答。`);
    await cdp.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.title.includes('本次运行设置'));b?.click();return !!b})()`);
    await until(() => cdp.eval(`[...document.querySelectorAll('.menu-item')].some(x=>x.textContent.includes('仅记录'))`), Boolean, 'record-only menu');
    await cdp.eval(`(()=>{const b=[...document.querySelectorAll('.menu-item')].find(x=>x.textContent.includes('仅记录'));b?.click();return true})()`);
    await until(() => cdp.eval(`document.querySelector('.composer-send')?.textContent.includes('保存记录')`), Boolean, 'record-only send');
    await cdp.eval(`document.querySelector('.composer-send').click();true`);
    await until(() => cdp.eval(`document.body.textContent.includes('@Claude')&&document.body.textContent.includes('@Codex')&&document.body.textContent.includes('@文档：合成资料.md')`), Boolean, 'sent body visible', 20000);
    await until(async () => (await composerValue()).trim() === '', Boolean, 'composer settled', 10000);
    report.checks.sentBody = {
      membersVisible: await cdp.eval(`document.body.textContent.includes('@Claude')&&document.body.textContent.includes('@Codex')`),
      documentVisible: await cdp.eval(`document.body.textContent.includes('@文档：合成资料.md')`),
      composerCleared: (await composerValue()).trim() === '',
    };
    await shot('05-sent-body-mentions');

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 820, deviceScaleFactor: 1, mobile: false });
    await sleep(250);
    await cdp.eval(`(()=>{const ta=document.querySelector('textarea.composer-input');ta.focus();ta.setSelectionRange(0,ta.value.length);return true})()`);
    await setComposer('@', 1);
    await until(() => cdp.eval(`document.querySelector('[data-zs-mention-pop]')!=null`), Boolean, 'narrow mention pop');
    const narrow = await cdp.eval(`(()=>{const pop=document.querySelector('[data-zs-mention-pop]').getBoundingClientRect();return {left:pop.left,right:pop.right,width:innerWidth,overflow:pop.left<0||pop.right>innerWidth}})()`);
    report.checks.narrow = narrow;
    await shot('06-narrow-mentions');

    await setComposer('@合成');
    await until(() => cdp.eval(`document.querySelector('[data-zs-mention-document="workspace:合成资料.md"]')!=null`), Boolean, 'async document candidate', 10000);
    const delayPatch = await cdp.eval(`(()=>{
      const target=window.zs;
      const original=target.command.bind(target);
      const command=async envelope=>{
        if(envelope?.method==='project.file.originalFile')await new Promise(resolve=>setTimeout(resolve,1200));
        return original(envelope);
      };
      try{Object.defineProperty(target,'command',{configurable:true,value:command});return {patched:true,scope:'zs'};}
      catch(firstError){
        try{
          const proxy=new Proxy(target,{get(value,key){if(key==='command')return command;const item=Reflect.get(value,key,value);return typeof item==='function'?item.bind(value):item;}});
          Object.defineProperty(window,'zs',{configurable:true,value:proxy});
          return {patched:true,scope:'window'};
        }catch(secondError){return {patched:false,error:String(secondError),first:String(firstError)};}
      }
    })()`);
    if (!delayPatch.patched) throw Error(`async document delay hook unavailable: ${JSON.stringify(delayPatch)}`);
    await cdp.eval(`document.querySelector('[data-zs-mention-document="workspace:合成资料.md"]').click();true`);
    await sleep(120);
    await route(`/project/${fixture.otherProjectId}/room/${fixture.otherRoomId}`, 'textarea.composer-input');
    await setComposer('切换后的新草稿');
    await sleep(1500);
    const asyncAfter = await composerValue();
    const asyncDocuments = await cdp.eval(`document.querySelector('.composer')?.getAttribute('data-zs-composer-documents')??''`);
    report.checks.asyncDocumentGuard = {
      patched: delayPatch.scope,
      valueUnchanged: asyncAfter === '切换后的新草稿',
      noOldDocumentToken: !asyncAfter.includes('@文档：合成资料.md'),
      noOldDocumentRef: !asyncDocuments.includes('合成资料.md'),
      value: asyncAfter,
    };
    await shot('07-async-project-switch');

    report.ok = report.checks.inline.toolbarInsertedAtStart
      && report.checks.inline.toolbarConsecutive.bothVisible
      && report.checks.inline.toolbarConsecutive.mentions.includes(fixture.members[0].id)
      && report.checks.inline.toolbarConsecutive.mentions.includes(fixture.members[1].id)
      && report.checks.inline.bothMembers
      && report.checks.inline.documentNotRecipient
      && report.checks.inline.bodyContainsMembers
      && report.checks.inline.bodyContainsDocument
      && report.checks.inline.readyAttachments > 0
      && report.checks.deleteOne.otherMemberKept
      && report.checks.deleteOne.removedMemberGone
      && report.checks.deleteOne.documentKept
      && report.checks.reopen.bodyTokensRestored
      && report.checks.reopen.membersRestored
      && report.checks.reopen.documentRefsRestored
      && report.checks.sentBody.membersVisible
      && report.checks.sentBody.documentVisible
      && report.checks.sentBody.composerCleared
      && report.checks.narrow.overflow === false
      && report.checks.asyncDocumentGuard.valueUnchanged
      && report.checks.asyncDocumentGuard.noOldDocumentToken
      && report.checks.asyncDocumentGuard.noOldDocumentRef;
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2), 'utf8');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    cdp.ws.close();
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    report.errors.push(String(error?.stack ?? error));
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2), 'utf8');
    cdp.ws.close();
    throw error;
  }
})().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
