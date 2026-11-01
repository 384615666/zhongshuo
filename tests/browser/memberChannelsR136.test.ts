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
    {kind:'deepseek-harness',label:'DeepSeek Harness',executable:'dsh',model:'harness-model',help:['安装官方 DeepSeek Harness','随包连接组件','DSH 的 zhongshuo 配置中设置模型','dsh web 使用另一份配置','不会自动同步','密钥由 DSH 管理']},
    {kind:'pi',label:'Pi',executable:'pi',model:'pi-model',help:['安装官方 Pi CLI','在 Pi 中配置 provider 和模型','众说沿用本机 Pi 配置','密钥由 Pi 管理']},
  ])('creates, binds, reloads and templates $label through rendered forms without model calls', async channel => {
    const fixture = mkdtempSync(join(root, '.r136-member-channels-'));
    temporaryDirectories.push(fixture);
    const harness = String.raw`
import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {MembersPage,BindRuntimeModal} from '__ROOT__/src/ui/hifi/MembersPage.tsx';
import {MemberDetailPage} from '__ROOT__/src/ui/hifi/pages/MemberDetailPage.tsx';
import {EditTemplateModal,SaveMemberTemplateModal,CreateFromTemplateModal} from '__ROOT__/src/ui/hifi/components/MemberManagementForms.tsx';
import * as store from '__ROOT__/src/ui/hifi/data/store.ts';
import {RUNTIME_CHANNELS} from '__ROOT__/src/contracts/runtimeKinds.ts';

const channel=__CHANNEL__;
const checks=[],calls=[];
const root=createRoot(document.getElementById('root'));
const member={id:'m1',displayName:'审查者',principalType:'agent',enabled:true,revision:4};
let revision=0,saved=0;
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
async function mount(Component,props={}){root.render(createElement(Component,{...props,key:String(++revision)}));await sleep(40);}

window.zs={command:async envelope=>{
  const {method,params}=envelope;calls.push({method,params});
  let data;
  switch(method){
    case 'member.list': data={items:[member]};break;
    case 'member.discoverDefaults':data={created:[],existing:[{displayName:channel.label}],skipped:[],notes:['fixture: 未找到其他 CLI']};break;
    case 'member.runtime':data=info;break;
    case 'member.runtimes':data={projectId:'p',items:[{memberId:'m1',info}]};break;
    case 'runtime.status':data={memberBindings:[{memberId:'m1',kind:channel.kind,model:channel.model}],dispatchGuard:{fakeAllowed:false,realDispatchGuard:false}};break;
    case 'project.memberWorkload':data={projectId:'p',items:[],truncated:false};break;
    case 'memberTemplate.list':data={items:[],nextCursor:null};break;
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
  button('扫描本机 AI').click();
  await until(()=>text().includes('扫描完成：新增 0 位 AI，已有 1 位。'));
  check('scan reports missing CLI without a model call',text().includes('fixture: 未找到其他 CLI')&&last('member.discoverDefaults').projectId==='p');
  await until(()=>document.querySelector('[data-zs-member-bind="m1"]'));
  document.querySelector('[data-zs-member-bind="m1"]').click();
  await until(()=>document.querySelector('[aria-label="runtime 渠道"]'));
  check('member list preserves Harness kind',combo('runtime 渠道').textContent.includes(channel.label));
  check('member list preserves custom executable',executionInput().value==='C:/test/'+channel.executable+'.exe');
  button('取消').click();await sleep(20);
  button('添加 AI').click();await until(()=>document.querySelector('[aria-label="运行渠道"]'));
  input('input[placeholder="例如 审查者、实现者"]','Harness 新成员');
  const addOptions=await options('运行渠道');
  check('new member uses shared real channel catalog',JSON.stringify(addOptions.map(o=>o.dataset.zsOption))===JSON.stringify(RUNTIME_CHANNELS.map(c=>c.value)));
  addOptions.find(el=>el.dataset.zsOption==='codex').click();await sleep(20);
  input('input[aria-label="手动模型 ID"]','old-model');await sleep(550);await choose('思考等级','medium');
  input('details input[placeholder="留空使用本机 CLI"]','old-custom.exe');await sleep(20);
  await choose('运行渠道',channel.kind);
  check('new member clears old model',document.querySelector('[aria-label="手动模型 ID"]').value==='');
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
  input('details input[placeholder="留空使用本机 CLI"]','');await sleep(20);
  document.querySelector('[data-zs-member-addsave]').click();await until(()=>last('member.create'));
  check('create persists Harness and default executable',last('member.create').runtime.kind===channel.kind&&last('member.create').runtime.executable===channel.executable);
  check('create persists catalog model and effort',last('member.create').runtime.model===channel.model&&last('member.create').runtime.effort==='high');

  await mount(BindRuntimeModal,{projectId:'p',member,initial:{kind:'claude',model:'old-model',effort:'medium',executable:'old-cli.exe',permissionMode:'plan'},guard:{fakeAllowed:false,realDispatchGuard:false},onClose:()=>{},onSaved:()=>{saved++;}});
  await choose('runtime 渠道',channel.kind);
  check('bind clears old model and effort',document.querySelector('[aria-label="手动模型 ID"]').value===''&&combo('思考等级').textContent.includes('渠道默认'));
  check('bind defaults to dsh',executionInput().value===channel.executable);
  check('bind preserves grant with unverified label',combo('权限模式').textContent.includes('plan')&&combo('权限模式').textContent.includes('尚未认证'));
  check('bind does not claim Claude read-only semantics',!text().includes('选择 plan 可保持只读'));
  await choose('权限模式','bypassPermissions');
  document.querySelector('[data-zs-member-bindsave]').click();await until(()=>saved===1);
  check('bind saves dsh without stale provider values',last('member.setRuntime').kind===channel.kind&&last('member.setRuntime').executable===channel.executable&&!('model' in last('member.setRuntime'))&&!('effort' in last('member.setRuntime')));

  await mount(MemberDetailPage,{projectId:'p',memberId:'m1'});
  await until(()=>document.querySelector('[data-zs-member-detail-bind]'));
  document.querySelector('[data-zs-member-detail-bind]').click();await until(()=>document.querySelector('[aria-label="runtime 渠道"]'));
  check('detail reopens Harness without coercion to Claude',combo('runtime 渠道').textContent.includes(channel.label));
  check('detail preserves model effort and program',document.querySelector('[aria-label="手动模型 ID"]').value===channel.model&&combo('思考等级').textContent.includes('high')&&executionInput().value==='C:/test/'+channel.executable+'.exe');
  await choose('runtime 渠道','codex');
  check('switch away restores codex executable and clears state',executionInput().value==='codex'&&document.querySelector('[aria-label="手动模型 ID"]').value===''&&combo('思考等级').textContent.includes('渠道默认'));
  check('Harness instructions disappear on another channel',!document.querySelector('[data-zs-runtime-channel-help]'));

  const template={id:'t1',name:'角色模板',description:'模板说明',enabled:true,revision:7,config:{kind:'claude',model:'old-model',effort:'medium',executable:'old-cli.exe',permissionMode:'plan'}};
  await mount(EditTemplateModal,{template,onClose:()=>{},onSaved:()=>{saved++;}});
  const templateOptions=await options('模板渠道');
  check('template uses shared real channel catalog',JSON.stringify(templateOptions.map(o=>o.dataset.zsOption))===JSON.stringify(RUNTIME_CHANNELS.map(c=>c.value)));
  templateOptions.find(el=>el.dataset.zsOption===channel.kind).click();await sleep(20);
  check('template clears provider-specific fields',document.querySelector('[aria-label="手动模型 ID"]').value===''&&combo('思考等级').textContent.includes('渠道默认'));
  check('template defaults dsh and retains grant',executionInput().value===channel.executable&&combo('模板权限').textContent.includes('尚未认证'));
  await choose('模板权限','bypassPermissions');
  input('label.field input[maxlength="1024"]','');await sleep(20);
  document.querySelector('[data-zs-template-edit-save]').click();await until(()=>saved===2);
  const edited=last('memberTemplate.update');
  check('template save uses expected revision and default program',edited.expectedRevision===7&&edited.config.kind===channel.kind&&edited.config.executable===channel.executable);
  check('template save removes old model effort',edited.config.model===null&&edited.config.effort===null);
  check('template save does not copy credentials or certification',Object.keys(edited.config).sort().join(',')==='effort,executable,kind,model,permissionMode');

  await mount(SaveMemberTemplateModal,{projectId:'p',member,onClose:()=>{},onSaved:()=>{saved++;}});
  document.querySelector('[data-zs-template-save]').click();await until(()=>saved===3);
  check('save member template reads authoritative binding',last('memberTemplate.saveFromMember').memberId==='m1'&&last('memberTemplate.saveFromMember').expectedRevision===4);
  await mount(CreateFromTemplateModal,{projectId:'p',template:{...template,config:edited.config},onClose:()=>{},onSaved:()=>{saved++;}});
  check('template creation describes actual program and channel setup',text().includes('程序：'+channel.executable)&&channel.help.every(copy=>text().includes(copy)));
  document.querySelector('[data-zs-template-create-save]').click();await until(()=>saved===4);
  check('template creates independent member from authoritative snapshot',last('memberTemplate.createMember').templateId==='t1'&&last('memberTemplate.createMember').expectedRevision===7);
  const allowed=/^(member\.(list|runtime|runtimes|runtimeCatalog|runtimeOptions|create|setRuntime|discoverDefaults)|memberTemplate\.(list|update|saveFromMember|createMember)|project\.memberWorkload|runtime\.status|room\.list|dm\.list|conversation\.list)$/;
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
    await build({entryPoints:[join(fixture,'harness.tsx')],bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:join(fixture,'harness.js'),define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(resolve('node_modules/electron/dist/electron.exe'), [join(fixture,'main.cjs')], {cwd:root,env,windowsHide:true,encoding:'utf8',timeout:45000});
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const line = output.split(/\r?\n/).find(line=>line.startsWith('R136_RESULT '));
    const report = line == null ? {ok:false,error:output.slice(-5000)} : JSON.parse(line.slice('R136_RESULT '.length)) as {ok:boolean;checks?:Array<{name:string;ok:boolean}>;error?:string};
    expect(report,JSON.stringify(report)).toMatchObject({ok:true});
    expect(report.checks).toHaveLength(35);
  }, 55000);
});
