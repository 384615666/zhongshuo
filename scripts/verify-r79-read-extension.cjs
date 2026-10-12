/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, module, Buffer */
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const {createHash,randomUUID}=require('node:crypto');
module.exports=async function readRegression({cdp,projectId,project,copy,out,until,sleep}){
  const command=async(method,params,id=`r79-read-${randomUUID()}`)=>{const r=await cdp.eval(`window.zs.command(${JSON.stringify({protocolVersion:1,commandId:id,method,params})})`);if(!r.ok)throw new Error(`${method}: ${JSON.stringify(r.error)}`);return r.data;};
  const click=async(selector,label)=>{const ok=await cdp.eval(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>x.textContent.trim()===${JSON.stringify(label)}&&!x.disabled);if(!b)return false;b.scrollIntoView({block:'center'});b.click();return true})()`);if(!ok)throw new Error(`missing visible action ${label}`);};
  const chunk=(type,data)=>{const t=Buffer.from(type),len=Buffer.alloc(4),crc=Buffer.alloc(4);len.writeUInt32BE(data.length);crc.writeUInt32BE(zlib.crc32(Buffer.concat([t,data]))>>>0);return Buffer.concat([len,t,data,crc]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(64);header.writeUInt32BE(48,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc(48*(1+64*3));for(let y=0;y<48;y++)for(let x=0;x<64;x++){const n=y*193+1+x*3;pixels[n]=x<32?240:30;pixels[n+1]=y<24?160:50;pixels[n+2]=x<32?60:230;}
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
  const filename='R79工程原件.png';fs.writeFileSync(path.join(project,filename),png);const sha=createHash('sha256').update(png).digest('hex');
  const rooms=await command('room.list',{projectId});const room=rooms.items.find(r=>r.name==='默认房间')??rooms.items[0];
  const up=await command('attachment.uploadImage',{conversationId:room.conversationId,filename,contentBase64:png.toString('base64')});if(up.hash!==sha)throw new Error('upload changed original');
  const record=await command('message.submit',{target:{kind:'room_root',projectId,conversationId:room.conversationId,roomId:room.id},body:'',intent:'record_only',mentions:[],attachmentRefs:[up.attachmentId]});
  if(record.taskId!=null)throw new Error('record-only unexpectedly created task');
  await cdp.eval(`location.hash=${JSON.stringify(`/project/${projectId}/room/${room.id}`)};true`);
  const selector=`[data-zs-artifact-id="${up.attachmentId}"]`;
  await until(()=>cdp.tryEval(`document.querySelectorAll(${JSON.stringify(selector)}).length`),n=>n===1,20_000,'cold pool attachment');
  const samples=[];for(let i=0;i<4;i++){if(i)await sleep(5200);samples.push({at:Date.now(),chips:await cdp.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`)});}if(samples.some(x=>x.chips!==1))throw new Error('attachment identity/count changed across polls');
  await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).click();true`);
  const image=await until(()=>cdp.tryEval("(()=>{const i=document.querySelector('[data-zs-image-preview=hifi]'),r=i?.getBoundingClientRect();return{width:i?.naturalWidth,height:i?.naturalHeight,displayWidth:r?.width,displayHeight:r?.height}})()"),v=>v?.width===64&&v.height===48&&v.displayWidth>0&&v.displayHeight>0,20_000,'actual browser decode');
  await click('.zs-image-tools button','＋');const zoom=await cdp.eval("document.querySelector('.zs-image-tools').textContent");if(!zoom.includes('125%'))throw new Error('zoom did not apply');
  const box=await cdp.eval("(()=>{const r=document.querySelector('.zs-image-viewport').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...box,button:'left',clickCount:1});await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:box.x+30,y:box.y+20,buttons:1});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:box.x+30,y:box.y+20,button:'left',clickCount:1});await sleep(150);
  const transform=await cdp.eval("document.querySelector('[data-zs-image-preview=hifi]').style.transform");if(!transform.includes('30px')||!transform.includes('20px'))throw new Error('drag did not preserve offset');
  await cdp.eval("document.querySelector('button[title^=放大预览]').click();true");await until(()=>cdp.tryEval("document.querySelector('.preview-pane.maximized')!=null"),Boolean,5000,'preview enlarged');await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await until(()=>cdp.tryEval("document.querySelector('.preview-pane.maximized')==null"),Boolean,5000,'Esc restore');
  await click('.zs-image-tools button','另存原件');const saved=path.join(out,'saved-originals',filename);await until(()=>fs.existsSync(saved),Boolean,10_000,'saved original');if(createHash('sha256').update(fs.readFileSync(saved)).digest('hex')!==sha)throw new Error('saved image bytes changed');
  await cdp.shot(path.join(out,'r79-image-reading.png'));
  await cdp.eval(`location.hash=${JSON.stringify(`/project/${projectId}/files`)};true`);
  await until(()=>cdp.tryEval(`document.querySelector('.file-tree')?.textContent.includes(${JSON.stringify(filename)})`),Boolean,20_000,'image file tree');
  await cdp.eval(`(()=>{const hit=[...document.querySelectorAll('.file-tree button,.file-tree [role=button]')].find(x=>x.textContent.includes(${JSON.stringify(filename)}));if(!hit)throw new Error('file node missing');hit.click();return true})()`);
  await until(()=>cdp.tryEval("document.querySelector('[data-zs-image-preview=hifi]')?.naturalWidth"),v=>v===64,20_000,'file tree actual image decode');
  const Database=require('../node_modules/better-sqlite3'),db=new Database(path.join(copy,'server-data/state.sqlite'),{readonly:true});let realCalls;try{realCalls=db.prepare('SELECT count(*) c FROM real_calls').get().c;}finally{db.close();}if(realCalls!==0)throw new Error('unexpected model call');
  return{pass:true,scope:'own generated 64x48 PNG only; normal final BAT, no engineering runtime; record-only formal submit',attachmentId:up.attachmentId,messageId:record.messageId,sha256:sha,image,samples,zoom,transform,saveHashMatched:true,fileTreeDecoded:true,realCalls};
};
