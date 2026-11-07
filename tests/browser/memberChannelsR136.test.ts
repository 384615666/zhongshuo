import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePermissionLabel, runtimePermissionOptions } from '../../src/ui/hifi/lib/runtimePermissions';

const root = resolve('.');
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});

describe('R136 member channel UI', () => {
  it.each(['deepseek-harness', 'pi'])('offers only supported %s permission choices and describes retained restricted grants honestly', kind => {
    expect(runtimePermissionOptions('', kind).map(o => o.value)).toEqual(['', 'bypassPermissions']);
    expect(runtimePermissionOptions('plan', kind)).toContainEqual({value:'plan',label:expect.stringContaining('尚未认证')});
    expect(runtimePermissionLabel('acceptEdits', kind)).toContain('尚未认证');
    expect(runtimePermissionOptions('', 'claude').map(o => o.value)).toContain('plan');
    expect(runtimePermissionOptions('', 'codex').map(o => o.value)).toContain('acceptEdits');
  });

  it.each([
    {kind:'deepseek-harness',label:'DeepSeek Harness',executable:'dsh',model:'harness-model',help:['安装官方 DeepSeek Harness','随包连接组件','DeepSeek Harness 的众说配置中设置模型','在浏览器中打开的版本使用另一份配置','不会自动同步','密钥由 DeepSeek Harness 管理']},
    {kind:'pi',label:'Pi',executable:'pi',model:'pi-model',help:['安装官方 Pi 命令行工具','在 Pi 中配置服务商和模型','众说沿用本机 Pi 配置','密钥由 Pi 管理']},
  ])('creates, binds, reloads and templates $label through rendered forms without model calls', async channel => {
    const fixture = mkdtempSync(join(root, '.r136-member-channels-'));
    temporaryDirectories.push(fixture);
    const harness = String.raw`
import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {MembersPage,BindRuntimeModal} from '__ROOT__/src/ui/hifi/MembersPage.tsx';
import {MemberDetailPage} from '__ROOT__/src/ui/hifi/pages/MemberDetailPage.tsx';
import {EditTemplateModal,SaveMemberTemplateModal} from '__ROOT__/src/ui/hifi/components/MemberManagementForms.tsx';
import * as store from '__ROOT__/src/ui/hifi/data/store.ts';
import {RUNTIME_CHANNELS} from '__ROOT__/src/contracts/runtimeKinds.ts';

const channel=__CHANNEL__;
const checks=[],calls=[];
const avatars={};
const root=createRoot(document.getElementById('root'));
const member={id:'m1',displayName:'审查者',principalType:'agent',enabled:true,revision:4};
let revision=0,saved=0,memberRevision=4;
let templates=[];
let info={binding:{installationId:'install',model:channel.model,permissionMode:'bypassPermissions',effort:'high'},installation:{id:'install',kind:channel.kind,executable:'C:/test/'+channel.executable+'.exe',capabilities_json:null},effective:{source:'binding',kind:channel.kind,model:channel.model},environment:{allowFake:false,realDispatchGuard:false}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test){for(let n=0;n<300;n++){if(test())return;await sleep(10);}throw Error('UI wait timed out: '+document.body.innerText);}
function check(name,ok){checks.push({name,ok:!!ok});if(!ok)throw Error('Failed '+name+': '+document.body.innerText);}
function text(){return document.body.textContent;}
function input(selector,value){const el=document.querySelector(selector);if(!el)throw Error('Missing input '+selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));}
function button(label){const el=[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===label);if(!el)throw Error('Missing button '+label);return el;}
function combo(label){const el=document.querySelector('[role="combobox"][aria-label="'+label+'"]');if(!el)throw Error('Missing combo '+label);return el;}
async function options(label){if(combo(label).getAttribute('aria-expanded')!=='true')combo(label).click();await until(()=>document.querySelector('[role="listbox"][aria-label="'+label+'"] [role="option"]'));return [...document.querySelectorAll('[role="listbox"][aria-label="'+label+'"] [role="option"]')];}
async function choose(label,value){const rows=await options(label);const row=rows.find(el=>el.dataset.zsOption===value);if(!row)throw Error('Missing option '+label+':'+value+' from '+rows.map(el=>el.dataset.zsOption).join(','));row.click();await sleep(20);}
function executionInput(){return [...document.querySelectorAll('label.field')].find(el=>el.textContent.includes('执行程序'))?.querySelector('input');}
function last(method){return calls.filter(c=>c.method===method).at(-1)?.params;}
function countOf(method){return calls.filter(c=>c.method===method).length;}
async function mount(Component,props={}){root.render(createElement(Component,{...props,key:String(++revision)}));await sleep(40);}

window.zs={command:async envelope=>{
  const {method,params}=envelope;calls.push({method,params});
  let data;
  switch(method){
    case 'app.appearance.set':if(params.avatar){const {subject,dataUrl}=params.avatar;if(dataUrl==null)delete avatars[subject];else avatars[subject]=dataUrl;}data={saved:true};break;
    case 'app.appearance.get':data={showAvatars:true,avatars:{...avatars}};break;
    case 'member.list': data={items:[{...member,revision:memberRevision}]};break;
    case 'member.update':data={projectId:'p',memberId:params.memberId,displayName:params.displayName,description:params.description,revision:++memberRevision};break;
    case 'member.discoverDefaults':data={created:[],existing:[{displayName:channel.label}],skipped:[],notes:['fixture: 未找到其他 CLI']};break;
    case 'member.runtime':data=info;break;
    case 'member.runtimes':data={projectId:'p',items:[{memberId:'m1',info}]};break;
    case 'runtime.status':data={memberBindings:[{memberId:'m1',kind:channel.kind,model:channel.model}],dispatchGuard:{fakeAllowed:false,realDispatchGuard:false}};break;
    case 'project.memberWorkload':data={projectId:'p',items:[],truncated:false};break;
    case 'memberTemplate.list':data={items:templates,nextCursor:null};break;
    case 'room.list':case 'dm.list':case 'conversation.list':data={items:[]};break;
    case 'member.runtimeCatalog':data={models:params.kind===channel.kind?[{id:channel.model,label:'Harness Model'}]:[{id:'old-model',label:'Old Model'}],defaultModel:null,source:'fixture CLI metadata',warning:null,truncated:false,program:{status:'found',reason:'fixture reference'}};break;
    case 'member.runtimeOptions':data={efforts:params.kind===channel.kind?['high']:['low','medium'],source:'fixture CLI options',reason:'metadata only'};break;
    case 'member.create':data={memberId:'new-member',roomsJoined:0};break;
    case 'member.setRuntime':case 'memberTemplate.update':case 'memberTemplate.saveFromMember':case 'memberTemplate.createMember':data={memberId:'template-member',roomsJoined:0};break;
    default:throw Error('Unexpected command (no model execution allowed): '+method);
  }
  return{ok:true,data};
},onDisconnect:()=>{},onReconnected:()=>{}};

window.run=async()=>{
  store.setState(s=>({...s,activeProjectId:'p',boot:'ready',projects:[{id:'p',displayName:'隔离项目',revision:0}],rooms:[],members:[],dispatchGuard:{fakeAllowed:false,realDispatchGuard:false},readErrors:{}}));
  store.initDraftPersistence('r136-isolated-ui');
  await mount(MembersPage,{projectId:'p'});
  await until(()=>document.querySelector('[data-zs-member-bind="m1"]'));
  // R183 第 4 项：「扫描本机 AI」独立按钮已删除；点「添加 AI」先 discoverDefaults、刷新投影，再打开添加弹窗。
  check('no separate 扫描本机 AI button',![...document.querySelectorAll('button')].some(el=>el.textContent.trim()==='扫描本机 AI'));
  document.querySelector('[data-zs-members-add]').click();
  await until(()=>document.querySelector('[data-zs-members-scan-result]'));
  await until(()=>document.querySelector('[aria-label="运行渠道"]'));
  check('scan reports missing CLI without a model call',text().includes('扫描完成：新增 0 位 AI，已有 1 位。')&&last('member.discoverDefaults').projectId==='p');
  check('add entry scans before opening the add dialog',countOf('member.discoverDefaults')===1&&document.querySelector('[aria-label="运行渠道"]')!=null);
  check('scan result stays visible on the page',text().includes('fixture: 未找到其他 CLI'));
  button('取消').click();await sleep(30);

  await until(()=>document.querySelector('[data-zs-member-bind="m1"]'));
  document.querySelector('[data-zs-member-bind="m1"]').click();
  await until(()=>document.querySelector('[aria-label="运行渠道"]'));
  check('member list preserves Harness kind',combo('运行渠道').textContent.includes(channel.label));
  check('member list preserves custom executable',executionInput().value==='C:/test/'+channel.executable+'.exe');
  button('取消').click();await sleep(20);
  document.querySelector('[data-zs-members-add]').click();
  await until(()=>document.querySelector('[aria-label="运行渠道"]'));
  input('input[placeholder="例如 审查者、实现者"]','Harness 新成员');
  const addOptions=await options('运行渠道');
  check('new member uses shared real channel catalog',JSON.stringify(addOptions.map(o=>o.dataset.zsOption))===JSON.stringify(RUNTIME_CHANNELS.map(c=>c.value)));
  addOptions.find(el=>el.dataset.zsOption==='codex').click();await sleep(20);
  input('input[aria-label="手动模型标识"]','old-model');await sleep(550);await choose('思考等级','medium');
  input('details input[placeholder="留空则自动查找本机程序"]','old-custom.exe');await sleep(20);
  await choose('运行渠道',channel.kind);
  check('new member clears old model',document.querySelector('[aria-label="手动模型标识"]').value==='');
  check('new member clears old effort',combo('思考等级').textContent.includes('渠道默认'));
  check('new member resets executable to dsh',executionInput().value===channel.executable);
  check('selected channel provides connection instructions',channel.help.every(copy=>text().includes(copy)));
  check('no permanent Harness warning banner',!document.querySelector('.warning[data-zs-runtime-channel-help]'));
  const permissionOptions=await options('新成员执行权限');
  check('Harness has no Claude permission choices',permissionOptions.every(el=>!['plan','acceptEdits','dontAsk'].includes(el.dataset.zsOption)));
  permissionOptions[0].click();await sleep(20);
  check('Harness does not inherit plan hint',!text().includes('选择 plan')&&text().includes('只读模式尚未认证'));
  await sleep(600);
  check('Harness catalog uses dsh',last('member.runtimeCatalog').kind===channel.kind&&last('member.runtimeCatalog').executable===channel.executable);
  const models=await options('模型');check('Harness model comes from catalog',models.some(el=>el.dataset.zsOption===channel.model));models.find(el=>el.dataset.zsOption===channel.model).click();
  await sleep(550);await choose('思考等级','high');
  check('Harness efforts queried for chosen model',last('member.runtimeOptions').model===channel.model&&last('member.runtimeOptions').kind===channel.kind);
  input('details input[placeholder="留空则自动查找本机程序"]','');await sleep(20);
  document.querySelector('[data-zs-member-addsave]').click();await until(()=>last('member.create'));
  check('create persists Harness and default executable',last('member.create').runtime.kind===channel.kind&&last('member.create').runtime.executable===channel.executable);
  check('create persists catalog model and effort',last('member.create').runtime.model===channel.model&&last('member.create').runtime.effort==='high');

  await mount(BindRuntimeModal,{projectId:'p',member,initial:{kind:'claude',model:'old-model',effort:'medium',executable:'old-cli.exe',permissionMode:'plan'},guard:{fakeAllowed:false,realDispatchGuard:false},onClose:()=>{},onSaved:()=>{saved++;}});
  await choose('运行渠道',channel.kind);
  check('bind clears old model and effort',document.querySelector('[aria-label="手动模型标识"]').value===''&&combo('思考等级').textContent.includes('渠道默认'));
  check('bind defaults to dsh',executionInput().value===channel.executable);
  check('bind preserves grant with unverified label',combo('权限模式').textContent.includes('只读分析')&&combo('权限模式').textContent.includes('尚未认证'));
  check('bind does not claim Claude read-only semantics',!text().includes('选择 plan 可保持只读'));
  await choose('权限模式','bypassPermissions');
  document.querySelector('[data-zs-member-bindsave]').click();await until(()=>saved===1);
  check('bind saves dsh without stale provider values',last('member.setRuntime').kind===channel.kind&&last('member.setRuntime').executable===channel.executable&&!('model' in last('member.setRuntime'))&&!('effort' in last('member.setRuntime')));

  // R183 第 6 项：AI 设置弹窗内改名称/说明；同一保存里改资料 + 改配置时必须
  // 「先 member.update 拿新 revision，再 member.setRuntime（用新 revision）」。
  const updateCallsBefore=countOf('member.update');
  const runtimeCallsBefore=countOf('member.setRuntime');
  await mount(BindRuntimeModal,{projectId:'p',member:{...member,revision:memberRevision},initial:{kind:channel.kind,model:channel.model,effort:'high',executable:channel.executable,permissionMode:'bypassPermissions'},guard:{fakeAllowed:false,realDispatchGuard:false},allowProfileEdit:true,onClose:()=>{},onSaved:()=>{saved++;}});
  await until(()=>document.querySelector('[data-zs-member-name]'));
  const revisionBeforeTwoStep=memberRevision;
  input('[data-zs-member-name]','两步改名');
  await choose('运行渠道','codex');await sleep(30);
  document.querySelector('[data-zs-member-bindsave]').click();
  await until(()=>countOf('member.update')>updateCallsBefore&&countOf('member.setRuntime')>runtimeCallsBefore);
  const twoStepWrites=calls.filter(c=>c.method==='member.update'||c.method==='member.setRuntime').slice(-2);
  check('two-step save updates profile before runtime',twoStepWrites.length===2&&twoStepWrites[0].method==='member.update'&&twoStepWrites[1].method==='member.setRuntime');
  check('two-step save writes profile with the opened revision',twoStepWrites[0].params.expectedRevision===revisionBeforeTwoStep&&twoStepWrites[0].params.displayName==='两步改名');
  check('two-step save writes runtime with the revision returned by update',twoStepWrites[1].params.expectedRevision===revisionBeforeTwoStep+1&&twoStepWrites[1].params.kind==='codex');

  await mount(MemberDetailPage,{projectId:'p',memberId:'m1'});
  await until(()=>document.querySelector('[data-zs-member-detail-bind]'));
  document.querySelector('[data-zs-member-detail-bind]').click();await until(()=>document.querySelector('[aria-label="运行渠道"]'));
  check('detail reopens Harness without coercion to Claude',combo('运行渠道').textContent.includes(channel.label));
  check('detail preserves model effort and program',document.querySelector('[aria-label="手动模型标识"]').value===channel.model&&combo('思考等级').textContent.includes('高')&&executionInput().value==='C:/test/'+channel.executable+'.exe');
  await choose('运行渠道','codex');
  check('switch away restores codex executable and clears state',executionInput().value==='codex'&&document.querySelector('[aria-label="手动模型标识"]').value===''&&combo('思考等级').textContent.includes('渠道默认'));
  check('Harness instructions disappear on another channel',!document.querySelector('[data-zs-runtime-channel-help]'));

  const template={id:'t1',name:'角色模板',description:'模板说明',enabled:true,revision:7,config:{kind:'claude',model:'old-model',effort:'medium',executable:'old-cli.exe',permissionMode:'plan'}};
  await mount(EditTemplateModal,{template,onClose:()=>{},onSaved:()=>{saved++;}});
  const templateOptions=await options('模板渠道');
  check('template uses shared real channel catalog',JSON.stringify(templateOptions.map(o=>o.dataset.zsOption))===JSON.stringify(RUNTIME_CHANNELS.map(c=>c.value)));
  templateOptions.find(el=>el.dataset.zsOption===channel.kind).click();await sleep(20);
  check('template clears provider-specific fields',document.querySelector('[aria-label="手动模型标识"]').value===''&&combo('思考等级').textContent.includes('渠道默认'));
  check('template defaults dsh and retains grant',executionInput().value===channel.executable&&combo('模板权限').textContent.includes('尚未认证'));
  await choose('模板权限','bypassPermissions');
  input('label.field input[maxlength="1024"]','');await sleep(20);
  document.querySelector('[data-zs-template-edit-save]').click();await until(()=>saved===3);
  const edited=last('memberTemplate.update');
  check('template save uses expected revision and default program',edited.expectedRevision===7&&edited.config.kind===channel.kind&&edited.config.executable===channel.executable);
  check('template save removes old model effort',edited.config.model===null&&edited.config.effort===null);
  check('template save does not copy credentials or certification',Object.keys(edited.config).sort().join(',')==='effort,executable,kind,model,permissionMode');

  await mount(SaveMemberTemplateModal,{projectId:'p',member:{...member,revision:memberRevision},onClose:()=>{},onSaved:()=>{saved++;}});
  document.querySelector('[data-zs-template-save]').click();await until(()=>last('memberTemplate.saveFromMember'));
  check('save member template reads authoritative binding',last('memberTemplate.saveFromMember').memberId==='m1'&&last('memberTemplate.saveFromMember').expectedRevision===memberRevision);

  // R183 第 7、8 项：模板卡简化；「在本项目创建…」打开同一个添加 AI 弹窗并预填，提交走 member.create。
  templates=[{id:'t1',name:'角色模板',description:'模板说明',enabled:true,revision:7,config:{kind:channel.kind,model:channel.model,effort:'high',executable:channel.executable,permissionMode:'bypassPermissions'}}];
  await mount(MembersPage,{projectId:'p'});
  await until(()=>document.querySelector('[data-zs-template="t1"]'));
  const templateCard=document.querySelector('[data-zs-template="t1"]');
  check('template card keeps name and hides program details',templateCard.textContent.includes('角色模板')&&!templateCard.textContent.includes('执行程序')&&templateCard.querySelectorAll('details').length===0);
  check('template card hides permission and enabled state',!templateCard.textContent.includes('权限')&&!templateCard.textContent.includes('启用'));
  document.querySelector('[data-zs-template-create="t1"]').click();
  await until(()=>document.querySelector('[aria-label="运行渠道"]'));
  const nameField=document.querySelector('input[placeholder="例如 审查者、实现者"]');
  const descField=document.querySelector('input[placeholder="例如 实现与重构，偏好直接给结论"]');
  check('template create opens the shared add-AI dialog with a template note',text().includes('已按模板'));
  check('template prefill carries name and description',nameField.value==='角色模板'&&descField.value==='模板说明');
  check('template prefill carries channel model and executable',combo('运行渠道').textContent.includes(channel.label)&&document.querySelector('[aria-label="手动模型标识"]').value===channel.model&&executionInput().value===channel.executable);
  const createCallsBefore=countOf('member.create');
  document.querySelector('[data-zs-member-addsave]').click();
  await until(()=>countOf('member.create')>createCallsBefore);
  const created=last('member.create');
  check('template creation submits member.create with prefilled values',created.displayName==='角色模板'&&created.runtime.kind===channel.kind&&created.runtime.model===channel.model&&created.runtime.executable===channel.executable);
  check('template creation never calls memberTemplate.createMember',!calls.some(c=>c.method==='memberTemplate.createMember'));
  const allowed=/^(member\.(list|runtime|runtimes|runtimeCatalog|runtimeOptions|create|update|setRuntime|discoverDefaults)|memberTemplate\.(list|update|saveFromMember|createMember)|app\.appearance\.(get|set)|project\.memberWorkload|runtime\.status|room\.list|dm\.list|conversation\.list)$/;
  check('only metadata reads and member configuration writes: '+calls.filter(c=>!allowed.test(c.method)).map(c=>c.method).join(','),calls.every(c=>allowed.test(c.method)));
  return{ok:checks.every(c=>c.ok),checks};
};
`.replaceAll('__ROOT__', root.replaceAll('\\', '/')).replaceAll('__CHANNEL__', JSON.stringify(channel));
    writeFileSync(join(fixture, 'harness.tsx'), harness);
    writeFileSync(join(fixture, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="harness.js"></script>');
    writeFileSync(join(fixture, 'main.cjs'), String.raw`
const {app,BrowserWindow}=require('electron');
const path=require('node:path');
app.disableHardwareAcceleration();
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:false}});
  try{
    await win.loadFile(path.join(__dirname,'index.html'));
    const result=await win.webContents.executeJavaScript('window.run()');
    console.log('R136_RESULT '+JSON.stringify(result));app.exit(result.ok?0:1);
  }catch(error){console.log('R136_RESULT '+JSON.stringify({ok:false,error:String(error)}));app.exit(2);}
});
setTimeout(()=>app.exit(3),40000);
`);
    await build({entryPoints:[join(fixture,'harness.tsx')],bundle:true,platform:'browser',format:'iife',jsx:'automatic',loader:{'.png':'dataurl'},outfile:join(fixture,'harness.js'),define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(resolve('node_modules/electron/dist/electron.exe'), [join(fixture,'main.cjs')], {cwd:root,env,windowsHide:true,encoding:'utf8',timeout:45000});
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const line = output.split(/\r?\n/).find(line=>line.startsWith('R136_RESULT '));
    const report = line == null ? {ok:false,error:output.slice(-5000)} : JSON.parse(line.slice('R136_RESULT '.length)) as {ok:boolean;checks?:Array<{name:string;ok:boolean}>;error?:string};
    expect(report,JSON.stringify(report)).toMatchObject({ok:true});
    expect(report.checks).toHaveLength(46);
  }, 55000);
});
