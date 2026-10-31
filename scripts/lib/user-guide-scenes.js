/* eslint-disable no-undef */
// Runs only inside the isolated screenshot window. Numbers mark existing controls.
(() => {
  const m=window.guideMeta;
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async check=>{for(let i=0;i<160;i++){if(check())return;await wait(50);}throw Error('Screenshot control was not ready');};
  const text=(label,scope=document)=>Array.from(scope.querySelectorAll('button,a,summary')).find(el=>el.textContent.trim()===label);
  const q=selector=>document.querySelector(selector);
  const go=async route=>{window.location.hash=route;await wait(650);};
  const room=()=>`/project/${m.projectId}/room/${m.roomId}`;
  const input=(el,value)=>{Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));};
  const editor=(el,value)=>{el.focus();el.innerText=value;el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));};
  const modalClose=()=>q('[role="dialog"] [aria-label="关闭"]')?.click();
  const rectOf=el=>{const r=el.getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x)-12),y:Math.max(0,Math.floor(r.y)-12),width:Math.min(window.innerWidth-Math.max(0,Math.floor(r.x)-12),Math.ceil(r.width)+24),height:Math.min(window.innerHeight-Math.max(0,Math.floor(r.y)-12),Math.ceil(r.height)+24)};};
  const scenes=[
    {name:'01-open-project',run:async()=>{await until(()=>q('.side-project-name')||document.body.innerText.includes('读书会筹备'));await go('/welcome');return {targets:[text('打开文件夹',q('.page'))],rect:{x:450,y:70,width:700,height:230}};}},
    {name:'02-workspace',run:async()=>{await go(room());await until(()=>q('.root-card')&&q('.composer-editor'));return {targets:[q('.side-project'),q('.root-card'),q('.composer-editor')]};}},
    {name:'03-new-room',run:async()=>{q('button[title*="中新建房间"]').click();await until(()=>q('[role="dialog"]'));input(q('[role="dialog"] input'),'活动讨论');return {targets:[q('[role="dialog"] input'),text('创建',q('[role="dialog"]'))],crop:q('[role="dialog"]')};}},
    {name:'04-add-ai',run:async()=>{modalClose();await go(`/project/${m.projectId}/members`);await until(()=>text('添加 AI'));text('添加 AI').click();await until(()=>q('[role="dialog"]'));input(q('[role="dialog"] input'),'读书会助手');await wait(1800);return {targets:[q('[role="dialog"] input'),q('[role="dialog"] .select'),q('[role="dialog"] [aria-label="模型"]'),text('添加成员',q('[role="dialog"]'))],crop:q('[role="dialog"]')};}},
    {name:'05-first-message',run:async()=>{modalClose();await go(room());await until(()=>q('.composer-editor'));editor(q('.composer-editor'),'请把读书会的准备工作整理成三步清单。');return {targets:[q('.composer-editor'),q('.composer button[type="submit"]')||text('发送')],crop:q('.composer-editor').closest('.composer')};}},
    {name:'06-reply-thread',run:async()=>{await go(room()+`?thread=${m.chat.threadId}`);await until(()=>q('[aria-label="回复串视图"] button')&&document.body.innerText.includes('确定内容'));Array.from(document.querySelectorAll('[aria-label="引用消息"]')).at(-1)?.click();await until(()=>q('[data-zs-conversation-quote-count]'));q('.composer-quote-summary').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));await until(()=>q('[data-zs-conversation-quote-popover]'));await wait(120);return {targets:[q('[aria-label="回复串视图"] button'),q('.composer-quote-summary'),Array.from(document.querySelectorAll('.composer-editor')).at(-1)],rect:{x:914,y:38,width:446,height:882}};}},
    {name:'07-dm',run:async()=>{await go(`/dm/${m.dm}`);await until(()=>document.body.innerText.includes('邀请文案'));return {targets:[q('button[aria-label="新建私信"]'),q('.composer-editor')],rect:{x:250,y:38,width:1110,height:882}};}},
    {name:'08-progress',run:async()=>{await go(room()+`?thread=${m.failed.threadId}&tab=run`);await until(()=>document.body.innerText.includes('运行详情')&&q('[data-zs-execution-action="close"]'));return {targets:[text('详情'),text('运行详情'),q('[data-zs-execution-action="close"]')],rect:{x:914,y:38,width:446,height:700}};}},
    {name:'09-results',run:async()=>{await go(room()+`?thread=${m.work.threadId}`);await until(()=>text('成果'));text('成果').click();await until(()=>Array.from(document.querySelectorAll('button')).some(el=>el.textContent.includes('读书会活动安排.md')));return {targets:[text('成果'),Array.from(document.querySelectorAll('button')).find(el=>el.textContent.includes('读书会活动安排.md'))],rect:{x:914,y:38,width:446,height:350}};}},
    {name:'10-file-preview',run:async()=>{const file=Array.from(document.querySelectorAll('button')).find(el=>el.textContent.includes('读书会活动安排.md'));if(!file)throw Error('Document card missing');file.click();await until(()=>q('[aria-label="文件预览"]'));await wait(400);const rect=rectOf(q('[aria-label="文件预览"]'));rect.height=Math.min(rect.height,520);return {targets:[q('[aria-label="下载原文件"]'),q('[aria-label="更多文件操作"]')],rect};}},
    {name:'11-search',run:async()=>{q('button[title^="收起预览区"]')?.click();await go('/library');await until(()=>q('.page input'));input(q('.page input'),'读书会');await wait(100);text('检索')?.click();await wait(500);return {targets:[q('.page input'),text('检索')]};}},
    {name:'12-board',run:async()=>{await go('/board');await wait(300);return {targets:[q('.board-card')||q('.task-card')||text('任务看板')]};}},
    {name:'13-appearance',run:async()=>{await go('/settings?section=appearance');return {targets:[q('[data-settings-row="appearance-theme"]'),q('[data-settings-row="appearance-avatars"]')],rect:{x:470,y:45,width:860,height:305}};}},
    {name:'14-data',run:async()=>{await go('/settings?section=data');await until(()=>q('[data-zs-data-guide]'));return {targets:[q('[data-zs-data-backup]'),q('[data-zs-data-import]')],crop:q('[data-zs-data-guide]')};}},
    {name:'15-help',run:async()=>{await go('/settings?section=guide');await until(()=>q('iframe')?.contentDocument?.querySelector('main h1'));return {targets:[text('操作手册')],rect:{x:255,y:45,width:240,height:550}};}},
    {name:'16-attachments',run:async()=>{await go(room());await until(()=>q('[data-zs-file-input]'));const transfer=new DataTransfer();transfer.items.add(new File(['周六下午2点，10人，每人分享一本书。'],'活动资料.md',{type:'text/markdown'}));const file=q('[data-zs-file-input]');file.files=transfer.files;file.dispatchEvent(new Event('change',{bubbles:true}));await wait(700);return {targets:[q('button[title^="添加附件"]'),q('.composer-editor')],crop:q('.composer-editor').closest('.composer')};}},
    {name:'17-project-files',run:async()=>{await go(`/project/${m.projectId}/files`);await wait(600);return {targets:[text('活动安排.md')||q('[title="活动安排.md"]')],rect:{x:260,y:190,width:1070,height:470}};}},
    {name:'18-call-budget',run:async()=>{await go('/settings?section=runtime');await until(()=>q('[data-zs-call-budget-setting] [role="switch"]')?.disabled===false);return {targets:[text('AI 设置'),q('[data-zs-call-budget-setting] [role="switch"]')],rect:{x:250,y:45,width:1100,height:260}};}},
    {name:'19-user-confirmation',run:async()=>{await go(room()+`?thread=${m.question.threadId}`);await until(()=>document.body.innerText.includes('是否准备茶点')&&q('[aria-label="回复串视图"]'));const edit=Array.from(document.querySelectorAll('.composer-editor')).at(-1);editor(edit,'只提供饮用水，请继续完成安排。');return {targets:[q('[aria-label="回复串视图"] button'),edit],rect:{x:914,y:38,width:446,height:882}};}},
    {name:'20-collaboration-settings',run:async()=>{await go(room());await until(()=>q('[aria-label="本次运行设置"]'));q('[aria-label="本次运行设置"]').click();await until(()=>text('独立研讨')||text('调整独立研讨成员'));if(text('独立研讨')){text('独立研讨').click();await wait(120);document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));q('[aria-label="本次运行设置"]').click();}await until(()=>text('回到自然协作'));await wait(180);const menu=text('回到自然协作').closest('.menu');return{targets:[Array.from(menu.querySelectorAll('button')).find(el=>el.textContent.includes('调整独立研讨成员')),text('回到自然协作')],rect:{x:1000,y:600,width:360,height:320}};}},
  ];
  window.guideScenes=scenes;
  let ready=false;
  window.guideStep=async index=>{
    if(!ready){await until(()=>document.body.innerText.includes('读书会筹备'));await go(room());await until(()=>q('.root-card'));ready=true;}
    q('[data-guide-marks]')?.remove();
    const scene=scenes[index];const result=await scene.run();
    if(/FORBIDDEN|目标属于他人私信|读取失败：/u.test(document.body.innerText))throw Error('Example contains a read error: '+scene.name);
    if(result.targets.some(el=>!el))throw Error('Missing numbered control in '+scene.name);
    const overlay=document.createElement('div');overlay.dataset.guideMarks='1';overlay.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    (result.targets||[]).forEach((el,i)=>{if(!el)return;const r=el.getBoundingClientRect();if(!r.width||!r.height)return;const ring=document.createElement('div');ring.style.cssText=`position:fixed;left:${Math.max(1,r.left-3)}px;top:${Math.max(1,r.top-3)}px;width:${r.width+6}px;height:${r.height+6}px;border:2px solid #2563eb;border-radius:5px;`;const badge=document.createElement('span');badge.textContent=String(i+1);badge.style.cssText='position:absolute;top:-11px;left:-10px;width:24px;height:24px;border-radius:50%;background:#2563eb;color:white;border:2px solid white;display:grid;place-items:center;font:bold 13px "Segoe UI",sans-serif;';ring.append(badge);overlay.append(ring);});
    document.body.append(overlay);
    return {name:scene.name,rect:result.rect||(result.crop?rectOf(result.crop):undefined),markers:(result.targets||[]).map((el,i)=>({number:i+1,found:!!el}))};
  };
})();
