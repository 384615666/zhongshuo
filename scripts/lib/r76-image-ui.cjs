/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, module, Buffer, setTimeout */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const pause = (ms) => new Promise(r => setTimeout(r, ms));
module.exports = async function verifyImages({ cdp, facts, errs, outDir, project, cmd, until, restart, seedDelivery, pid, threadId, roomId }) {
  const checks = facts.extended = {};
  const step = async (name, fn) => {
    try { checks[name] = await fn(); if (checks[name]?.pass !== true) errs.push(`${name}: failed`); }
    catch (e) { checks[name] = { pass: false, error: e.message, dom: await cdp.tryEval("({hash:location.hash,text:document.querySelector('#hifi-root')?.innerText.slice(-1500)})") };await cdp.shot(path.join(outDir,name+'-failed.png')); errs.push(`${name}: ${e.message}`); }
  };
  const click = async (selector, text) => {
    const ok = await cdp.eval(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>x.textContent.includes(${JSON.stringify(text)}));b?.click();return !!b})()`);
    if (!ok) throw new Error(`missing control ${selector} ${text}`);
    await pause(120);
  };
  const decoded = async name => {
    await until(() => cdp.tryEval(`(()=>{const i=document.querySelector('#hifi-root [data-zs-image-preview]');return i?.alt===${JSON.stringify(name)}&&i.naturalWidth>0&&i.naturalHeight>0})()`), v=>v, 15000, `decode ${name}`);
    return cdp.eval(`(()=>{const i=document.querySelector('#hifi-root [data-zs-image-preview]');const r=i.getBoundingClientRect();const v=i.parentElement.getBoundingClientRect();return {width:i.naturalWidth,height:i.naturalHeight,drawWidth:r.width,drawHeight:r.height,visible:r.width>0&&r.height>0&&Math.min(r.right,v.right)>Math.max(r.left,v.left)&&Math.min(r.bottom,v.bottom)>Math.max(r.top,v.top),transform:i.style.transform}})()`);
  };
  const choose = async files => {
    const dom = await cdp.send('DOM.getDocument');
    const isThread=await cdp.eval("document.querySelector('#hifi-root .col-thread input[type=file]')!=null");
    const nodes = await cdp.send('DOM.querySelectorAll', { nodeId: dom.root.nodeId, selector: isThread ? '#hifi-root .col-thread input[type=file]' : '#hifi-root input[type=file]' });
    if (!nodes.nodeIds.length) throw new Error('missing file picker');
    await cdp.send('DOM.setFileInputFiles', { nodeId: nodes.nodeIds.at(-1), files });
    await until(() => cdp.tryEval(`(()=>{const c=[...document.querySelectorAll('#hifi-root .composer')].at(-1);return c&&!c.querySelector('[data-zs-att=uploading]')&&${JSON.stringify(files.map(f=>path.basename(f)))}.every(n=>c.textContent.includes(n))})()`), v=>v, 15000, 'upload receipt');
  };
  const previewDraft = async name => {
    await cdp.eval(`(()=>{const c=[...document.querySelectorAll('#hifi-root .composer')].at(-1);const a=[...c.querySelectorAll('[data-zs-att=ready]')].find(x=>x.textContent.includes(${JSON.stringify(name)}));[...a?.querySelectorAll('button')??[]].find(b=>b.textContent==='预览')?.click()})();true`);
    return decoded(name);
  };
  const recordAndSend = async (body='') => {
    await cdp.eval(`(()=>{const c=[...document.querySelectorAll('#hifi-root .composer')].at(-1);const t=c.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(body)});t.dispatchEvent(new Event('input',{bubbles:true}));c.querySelector('[aria-label="本次运行设置"]')?.click()})();true`);
    await pause(150);
    await cdp.eval(`(()=>{const b=[...document.querySelectorAll('#hifi-root button')].find(b=>b.title.startsWith('仅记录：这次只保存内容'));b?.click()})();true`);
    await pause(150);
    await cdp.eval(`(()=>{const c=[...document.querySelectorAll('#hifi-root .composer')].at(-1);c.querySelector('button[title^="Enter 发送"]')?.click()})();true`);
    await until(()=>cdp.tryEval(`(()=>{const c=[...document.querySelectorAll('#hifi-root .composer')].at(-1);return c&&!c.querySelector('[data-zs-att=ready]')})()`),v=>v,15000,'record send clears refs');
  };
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  await step('sentMessagePreview', async()=>{
    await click('#hifi-root .root-card .msg-attach','中文图片.png');
    const image = await decoded('中文图片.png');
    return {pass:image.visible,image};
  });
  await step('zoomDragMaximizeEsc', async()=>{
    await click('.zs-image-tools button','原尺寸'); const original = await decoded('中文图片.png');
    await click('.zs-image-tools button','＋'); const enlarged = await decoded('中文图片.png');
    const r = await cdp.eval(`(()=>{const r=document.querySelector('.zs-image-viewport').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...r,button:'left',clickCount:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:r.x+65,y:r.y+35,button:'left',buttons:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:r.x+65,y:r.y+35,button:'left',clickCount:1});
    await pause(150); const dragged=await decoded('中文图片.png');
    await cdp.eval(`document.querySelector('#hifi-root button[title^="放大预览"]')?.click();true`);await pause(100);
    const max=await cdp.eval(`document.querySelector('#hifi-root .preview-pane.maximized')!=null`);
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await pause(150);
    const restored=await cdp.eval(`document.querySelector('#hifi-root .preview-pane.maximized')==null`);
    await cdp.shot(path.join(outDir,'zoom-drag.png'));
    return {pass:Math.abs(original.drawWidth-original.width)<2&&enlarged.drawWidth>original.drawWidth&&dragged.transform!==enlarged.transform&&max&&restored,original,enlarged,dragged,max,restored};
  });
  await step('saveOriginalBytes',async()=>{
    await click('.zs-image-tools button','另存原件');
    const save=path.join(outDir,'saved','中文图片.png');
    await until(()=>Promise.resolve(fs.existsSync(save)),v=>v,10000,'native saveAs write');
    return {pass:hash(save)===hash(path.join(project,'中文图片.png')),sourceHash:hash(path.join(project,'中文图片.png')),savedHash:hash(save)};
  });
  const files=[];
  for(const mime of ['image/jpeg','image/webp']){
    const b64=await cdp.eval(`(()=>{const c=document.createElement('canvas');c.width=96;c.height=64;const x=c.getContext('2d');x.fillStyle='orange';x.fillRect(0,0,96,64);x.fillStyle='blue';x.fillRect(12,12,30,30);return c.toDataURL(${JSON.stringify(mime)}).split(',')[1]})()`);
    const name=mime==='image/jpeg'?'中文照片.jpg':'中文网页.webp';const f=path.join(project,name);fs.writeFileSync(f,Buffer.from(b64,'base64'));files.push(f);
  }
  const gif=path.join(project,'中文动图.gif');fs.writeFileSync(gif,Buffer.from('R0lGODdhYABAAIEAAP+lAAAA/wAAAAAAACwAAAAAYABAAEAIzgABCBxIsKDBgwgTKlzIsKHDhxAjSpzoMIDFixgzatx4kaLHjwI5ihyJEaRJiSRTcjzJsqLKlx1bypxJs6bNmzhz6twJs+dOmT1h/mwZ9OVQlkVVHl3KtKnTp1CjSp1KtarVpklTXmWYleTWhV1HflUYVuTYhGVXnj2YduNatm0zvjUYV+7cu3jz6t3Lt6/fv4ADCx5MuPDRuiX1Io6Zd7HFvY4DQHY8eXFlxJfrZo67uW3ntJ/Lhg47umvprIZTq17NurXr17Bjy55Nu2lAADs=','base64'));files.push(gif);
  await step('formatsAndTabState',async()=>{
    await cdp.eval("document.querySelector('#hifi-root .root-replies-btn')?.click();true");
    await until(()=>cdp.tryEval(`location.hash.includes(${JSON.stringify(threadId)})&&document.querySelector('#hifi-root .col-thread textarea.composer-input')!=null`),v=>v,20000,'thread composer');
    await choose(files);const images=[];
    for(const f of files){images.push({name:path.basename(f),image:await previewDraft(path.basename(f))});await cdp.shot(path.join(outDir,path.basename(f)+'.png'));await click('.zs-image-tools button','另存原件');await until(()=>Promise.resolve(fs.existsSync(path.join(outDir,'saved',path.basename(f)))),v=>v,10000,'format saved');if(hash(f)!==hash(path.join(outDir,'saved',path.basename(f))))throw new Error('format save hash mismatch');}
    await click('#hifi-root .preview-tab-label','中文图片.png');const restored=await decoded('中文图片.png');
    const old=checks.zoomDragMaximizeEsc.dragged;
    return {pass:images.every(x=>x.image.visible)&&Math.abs(restored.drawWidth-old.drawWidth)<2&&restored.transform===old.transform,images,restored};
  });
  await step('threadBodyAndMultiAttachments',async()=>{
    await recordAndSend('正文与三张图片');
    const h=await cmd('thread.history',{threadId,limit:100});
    const reply=h.data?.items.find(x=>x.body.text==='正文与三张图片');
    await click('#hifi-root .msg-attach','中文照片.jpg');const image=await decoded('中文照片.jpg');
    return {pass:reply?.attachments?.length===3&&image.visible,attachmentNames:reply?.attachments?.map(a=>a.filename),image};
  });
  await step('threadArtifactsPicture',async()=>{
    await click('#hifi-root .col-thread .thread-tab','附件');await pause(500);
    await click('#hifi-root .col-thread button','中文照片.jpg');const image=await decoded('中文照片.jpg');
    await click('#hifi-root .col-thread .thread-tab','回复');return {pass:image.visible,image};
  });
  await step('corruptDecodeAndCapacity',async()=>{
    const broken=path.join(project,'损坏图片.png');fs.writeFileSync(broken,fs.readFileSync(path.join(project,'中文图片.png')).subarray(0,33));
    await choose([broken]);
    await cdp.eval(`(()=>{const c=[...document.querySelectorAll('#hifi-root .composer')].at(-1);[...c.querySelectorAll('[data-zs-att=ready] button')].find(b=>b.textContent==='预览')?.click()})();true`);
    await until(()=>cdp.tryEval(`document.querySelector('[data-zs-preview-error]')?.textContent.includes('无法解码')`),v=>v,10000,'decode failure nearby');
    const error=await cdp.eval(`document.querySelector('[data-zs-preview-error]').textContent`);
    const warning=await cdp.eval(`document.querySelector('[data-zs-att-warn="损坏图片.png"]')?.textContent??''`);
    const original=await cmd('attachment.listByConversation',{conversationId:(await cmd('thread.get',{threadId})).data.thread.conversationId});
    await cdp.shot(path.join(outDir,'corrupt-preview.png'));
    const limit=path.join(project,'超容量.jpg');fs.writeFileSync(limit,Buffer.alloc(8*1024*1024+1));await choose([limit]);
    const tooLarge=await cdp.eval(`document.querySelector('[data-zs-att-error="超容量.jpg"]')?.textContent??''`);
    const exact=Buffer.alloc(8*1024*1024);fs.readFileSync(files[0]).copy(exact);
    const conv=(await cmd('thread.get',{threadId})).data.thread.conversationId;
    const atLimit=await cmd('attachment.uploadImage',{conversationId:conv,filename:'容量边界.jpg',contentBase64:exact.toString('base64')});
    return {pass:error.includes('重试预览')&&warning.includes('无法解码')&&tooLarge.includes('上限')&&atLimit.ok&&atLimit.data.bytes===exact.length&&original.ok,error,warning,tooLarge,acceptedBytes:atLimit.data?.bytes};
  });
  await step('roomFilesResource',async()=>{
    await cdp.eval(`location.hash=${JSON.stringify('/project/'+pid+'/room/'+roomId+'?tab=files')};true`);await pause(900);await click('#hifi-root .thread-tab','文件');
    await click('#hifi-root button','中文图片.png');const image=await decoded('中文图片.png');return {pass:image.visible,image};
  });
  const bmp=Buffer.alloc(54+96*64*3);bmp.write('BM');bmp.writeUInt32LE(bmp.length,2);bmp.writeUInt32LE(54,10);bmp.writeUInt32LE(40,14);bmp.writeInt32LE(96,18);bmp.writeInt32LE(64,22);bmp.writeUInt16LE(1,26);bmp.writeUInt16LE(24,28);
  for(let i=54;i<bmp.length;i+=3){bmp[i]=255;bmp[i+1]=100;bmp[i+2]=30;}fs.writeFileSync(path.join(project,'中文位图.bmp'),bmp);
  fs.writeFileSync(path.join(project,'中文矢量.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64"><rect width="96" height="64" fill="orange"/><circle cx="35" cy="30" r="15" fill="green"/><script>window.__zsSvgExecuted=true</script></svg>');
  await step('worktreePicture',async()=>{
    await cdp.eval(`location.hash=${JSON.stringify('/project/'+pid+'/files')};true`);
    await until(()=>cdp.tryEval(`document.querySelector('#hifi-root .file-tree')!=null`),v=>v,20000,'file tree');
    await click('#hifi-root .file-tree button','中文图片.png');const image=await decoded('中文图片.png');
    await click('.zs-image-tools button','适应窗口');const fit=await decoded('中文图片.png');
    await cdp.shot(path.join(outDir,'worktree-image.png'));return {pass:image.visible&&fit.visible,image,fit};
  });
  await step('worktreeBmpSvg',async()=>{
    const images=[];for(const name of ['中文位图.bmp','中文矢量.svg']){await click('#hifi-root .file-tree button',name);images.push({name,image:await decoded(name)});await cdp.shot(path.join(outDir,name+'.png'));}
    return {pass:images.every(x=>x.image.visible&&x.image.width===96&&x.image.height===64)&&!await cdp.eval('window.__zsSvgExecuted===true'),images};
  });
  await step('dmImageOnlyRecord',async()=>{
    const members=await cmd('member.list',{projectId:pid});const peer=members.data.items.find(m=>m.principalType==='agent');
    const created=await cmd('conversation.create',{projectId:pid,peerMemberId:peer.id,title:'图片私信'});const conv=created.data.conversationId;
    const binding=await cmd('member.setRuntime',{memberId:peer.id,kind:'codex',model:'gpt-6-luna'});if(!binding.ok)throw new Error('fixture binding failed');
    await cdp.eval(`location.hash=${JSON.stringify('/dm/'+conv)};true`);
    await until(()=>cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input')!=null`),v=>v,20000,'DM composer');
    await choose([files[0]]);const draft=await previewDraft('中文照片.jpg');
    await cdp.eval("document.querySelector('#hifi-root .composer button[title^=\"Enter 发送\"]')?.click();true");
    await until(()=>cdp.tryEval("[...document.querySelectorAll('#hifi-root button')].some(b=>b.textContent==='改为仅记录')"),v=>v,10000,'unverified image gate');
    const gate=await cdp.eval("(()=>{const b=[...document.querySelectorAll('#hifi-root button')].find(b=>b.textContent.includes('仅发送文字（'));return {text:b?.parentElement.textContent,emptyTextDisabled:b?.disabled}})()");
    const before=await cmd('conversation.history',{conversationId:conv});
    if(!gate.emptyTextDisabled||before.data.messages.length!==0)throw new Error('image-only omission must not send empty model input');
    await click('#hifi-root button','改为仅记录');
    await cdp.eval("document.querySelector('#hifi-root .composer button[title^=\"Enter 发送\"]')?.click();true");
    await until(()=>cdp.tryEval("!document.querySelector('#hifi-root [data-zs-att=ready]')"),v=>v,15000,'DM record stored');await pause(400);
    checks.unverifiedImageActions={pass:true,gate};
    await cmd('member.setRuntime',{memberId:peer.id,kind:'claude',model:'deepseek-flash',permissionMode:'plan'});
    const capable=await cmd('message.imageCapability',{target:{kind:'dm',projectId:pid,conversationId:conv},mentions:[]});
    checks.certifiedMemberPreflight={pass:capable.ok&&capable.data.supported,members:capable.data?.members};if(!checks.certifiedMemberPreflight.pass)errs.push('certifiedMemberPreflight failed');
    if (facts.source.includes('v16')) {
      await choose([path.join(project,'中文照片.jpg')]);
      await until(()=>cdp.tryEval("document.querySelector('[data-zs-image-status]')?.textContent.includes('真实识图已认证')"),v=>v,12000,'R77 certified composer status');
      const matching=await cdp.eval("document.querySelector('[data-zs-image-status]').textContent");
      const localSettings=path.join(project,'.claude','settings.local.json');fs.mkdirSync(path.dirname(localSettings),{recursive:true});
      fs.writeFileSync(localSettings,JSON.stringify({env:{ANTHROPIC_BASE_URL:'http://127.0.0.1:1/r77-own-fixture'}}));
      await until(()=>cdp.tryEval("document.querySelector('[data-zs-image-status]')?.textContent.includes('渠道覆盖')"),v=>v,12000,'R77 project mismatch composer status');
      const mismatch=await cmd('message.imageCapability',{target:{kind:'dm',projectId:pid,conversationId:conv},mentions:[]});
      const mismatchText=await cdp.eval("document.querySelector('[data-zs-image-status]').textContent");
      await cdp.shot(path.join(outDir,'r77-config-mismatch.png'));
      const preview=await previewDraft('中文照片.jpg');
      fs.unlinkSync(localSettings);
      await until(()=>cdp.tryEval("document.querySelector('[data-zs-image-status]')?.textContent.includes('真实识图已认证')"),v=>v,12000,'R77 restored composer status');
      await cdp.eval(`location.hash='/project/${pid}/members';true`);
      await until(()=>cdp.tryEval(`document.querySelector('[data-zs-image-capability="${peer.id}"]')?.textContent.includes('已认证')`),v=>v,12000,'R77 member certification status');
      const member=await cdp.eval(`document.querySelector('[data-zs-image-capability="${peer.id}"]').textContent`);
      await cdp.shot(path.join(outDir,'r77-member-status.png'));
      await cdp.eval(`location.hash='/project/${pid}/dm/${conv}';true`);await pause(600);
      checks.r77ConfigurationStatus={pass:mismatch.ok&&!mismatch.data.supported&&preview.visible&&member.includes('deepseek-flash')&&member.includes('协议')&&matching.includes('模型ID')&&mismatchText.includes('无法确定'),matching,mismatch: mismatch.data.members, mismatchText,member,preview};
      if(!checks.r77ConfigurationStatus.pass)errs.push('R77 configuration status failed');
    }

    const h=await cmd('conversation.history',{conversationId:conv});
    await click('#hifi-root .msg-attach','中文照片.jpg');const sent=await decoded('中文照片.jpg');
    return {pass:draft.visible&&sent.visible&&h.data.messages.some(m=>m.attachments?.length===1),draft,sent,conversationId:conv};
  });
  await step('deliveryDocumentPicture',async()=>{
    const seeded=await seedDelivery();cdp=seeded.cdp;
    // Close the read-only recovery dialog; never continue dispatch or release protection.
    await cdp.eval("(()=>{const m=[...document.querySelectorAll('#hifi-root .modal')].find(x=>x.textContent.includes('恢复检查'));[...m?.querySelectorAll('button')??[]].find(b=>b.textContent.trim()==='关闭')?.click()})();true");
    await until(()=>cdp.tryEval("document.querySelector('#hifi-root .scrim, #hifi-root .modal')==null"),v=>v,10000,'close read-only recovery overlay');
    await cdp.eval(`location.hash=${JSON.stringify('/thread/'+seeded.delivery.threadId+'?tab=artifacts')};true`);
    await until(()=>cdp.tryEval(`document.querySelector('[data-zs-delivery-row] button')!=null`),v=>v,20000,'fixture delivery list');
    await click('[data-zs-delivery-row] button','打开文档');
    await until(()=>cdp.tryEval(`document.querySelector('[data-zs-delivery-file="中文图片.png"]')!=null`),v=>v,15000,'delivery file link');
    await cdp.eval(`document.querySelector('[data-zs-delivery-file="中文图片.png"]').click();true`);const image=await decoded('中文图片.png');
    await cdp.shot(path.join(outDir,'delivery-image.png'));return {pass:image.visible,image,fixture:'formal FakeRuntimeAdapter/worker generated; not a real model delivery'};
  });
  await step('reopenRecordPreview',async()=>{
    cdp=await restart();
    await cdp.eval(`location.hash=${JSON.stringify('/project/'+pid+'/room/'+roomId)};true`);
    await until(()=>cdp.tryEval(`document.querySelector('#hifi-root .root-card .msg-attach')!=null`),v=>v,30000,'cold reopen pool chip');
    await click('#hifi-root .root-card .msg-attach','中文图片.png');const image=await decoded('中文图片.png');
    await cdp.shot(path.join(outDir,'reopen-preview.png'));return {pass:image.visible,image};
  });
  return cdp;
};
