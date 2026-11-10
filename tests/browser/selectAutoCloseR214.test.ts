import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * R214 回归：自绘下拉在 `<label>` 包裹的设置行里选择后必须自动关闭。
 *
 * 根因（真实浏览器行为，不是 React 状态问题）：设置行通常写成
 * `<label class="field"><span>渠道</span><Select/></label>`。选项是普通 `div`，
 * 点击它冒泡到 label 时，label 的激活行为会向内部 labelable 控件（combobox 按钮）
 * 补发一次 click，于是 `pick()` 刚做的 `setOpen(false)` 又被按钮 onClick 打开，
 * 用户看到「选了渠道，下拉还在」。修复在 `Select` 的捕获阶段取消这次 click 的默认
 * 动作（见 `src/ui/hifi/components/ui.tsx`）。本测试用真实 Electron 渲染：
 *  - label 内下拉、独立下拉都要在选中后关闭且值正确；
 *  - 选中已有选项不重复回调，下拉同样关闭；
 *  - 键盘（↑↓ + Enter）选中后关闭；
 *  - 关闭后再次点击按钮仍能重新打开（防止修复把点击一起吃掉）。
 */
const root = resolve('.');
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});

describe('R214 select closes after picking an option', () => {
  it('closes label-wrapped and plain selects after mouse and keyboard selection', async () => {
    const fixture = mkdtempSync(join(root, '.r214-select-autoclose-'));
    temporaryDirectories.push(fixture);
    const harness = String.raw`
import {createElement,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Select} from '__ROOT__/src/ui/hifi/components/ui.tsx';

const checks=[],events=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test,label){for(let n=0;n<300;n++){if(test())return;await sleep(10);}throw Error('UI wait timed out: '+(label||'')+' | '+document.body.innerHTML.slice(0,2000));}
function check(name,ok,detail){checks.push({name,ok:!!ok,...(detail===undefined?{}:{detail})});if(!ok)throw Error('Failed check: '+name+' '+JSON.stringify(detail));}
const combo=label=>document.querySelector('[role="combobox"][aria-label="'+label+'"]');
const popup=()=>document.querySelector('.select-pop');
const shot=(label)=>({expanded:combo(label)?.getAttribute('aria-expanded'),pop:popup()!=null,value:(combo(label)?.textContent||'').trim(),events:events.slice()});
/** 模拟真实鼠标点击：click 冒泡到 label 时浏览器还会向内部按钮补发点击。 */
function userClick(el){
  el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,detail:1,view:window}));
  el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,detail:1,view:window}));
  el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1,view:window}));
}
async function open(label){
  if(combo(label).getAttribute('aria-expanded')!=='true')combo(label).click();
  await until(()=>popup()!=null,label+' 展开');
}
async function pick(label,value){
  await open(label);
  const rows=[...document.querySelectorAll('.select-pop [role="option"]')];
  const row=rows.find(el=>el.dataset.zsOption===value);
  if(!row)throw Error('Missing option '+label+':'+value+' from '+rows.map(el=>el.dataset.zsOption).join(','));
  userClick(row);
  await sleep(120);
}

function Demo(){
  const [kind,setKind]=useState('claude');
  const [plain,setPlain]=useState('p1');
  const [again,setAgain]=useState('a');
  return createElement('div',null,
    createElement('label',{className:'field'},
      createElement('span',{className:'field-label'},'渠道'),
      createElement(Select,{ariaLabel:'label 内下拉',value:kind,onChange:v=>{events.push(['label',v]);setKind(v);},options:[{value:'claude',label:'Claude'},{value:'codex',label:'Codex'},{value:'pi',label:'Pi'}]})),
    createElement('div',{className:'field'},
      createElement('span',{className:'field-label'},'独立下拉'),
      createElement(Select,{ariaLabel:'普通下拉',value:plain,onChange:v=>{events.push(['plain',v]);setPlain(v);},options:[{value:'p1',label:'P1'},{value:'p2',label:'P2'}]})),
    createElement('label',{className:'field'},
      createElement('span',{field:'field-label'},'再选一次'),
      createElement(Select,{ariaLabel:'空操作下拉',value:again,onChange:v=>{events.push(['again',v]);setAgain(v);},options:[{value:'a',label:'A'},{value:'b',label:'B'}]})),
  );
}

async function run(){
  createRoot(document.getElementById('root')).render(createElement(Demo));
  await until(()=>combo('label 内下拉')!=null,'下拉渲染');
  check('label 内下拉已渲染',combo('label 内下拉')!=null);

  // ① label 包裹：选中后关闭（修复前这里 aria-expanded=true 且 .select-pop 仍在）。
  await pick('label 内下拉','codex');
  const afterLabel=shot('label 内下拉');
  check('label 内下拉：选择后关闭',afterLabel.expanded==='false'&&afterLabel.pop===false,afterLabel);
  check('label 内下拉：值已更新',afterLabel.value==='Codex',afterLabel);
  check('label 内下拉：只回调一次',JSON.stringify(events)===JSON.stringify([['label','codex']]),afterLabel.events);

  // ② 关闭后按钮仍可再次打开并再次选择（防止把按下拉点击一起阻止）。
  await open('label 内下拉');
  check('label 内下拉：关闭后可再次打开',combo('label 内下拉').getAttribute('aria-expanded')==='true'&&popup()!=null,shot('label 内下拉'));
  await pick('label 内下拉','pi');
  const afterSecond=shot('label 内下拉');
  check('label 内下拉：第二次选择后仍关闭',afterSecond.expanded==='false'&&afterSecond.pop===false&&afterSecond.value==='Pi',afterSecond);

  // ③ 点击当前已选中的选项：关闭且不重复回调。
  const beforeNoop=events.length;
  await pick('label 内下拉','pi');
  const afterNoop=shot('label 内下拉');
  check('label 内下拉：选中当前值后关闭且不重复回调',afterNoop.expanded==='false'&&afterNoop.pop===false&&events.length===beforeNoop,afterNoop);

  // ④ 键盘：↓ 打开、↓ 移动到下一项、Enter 选中后关闭。
  combo('label 内下拉').focus();
  combo('label 内下拉').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
  await until(()=>popup()!=null,'键盘展开');
  combo('label 内下拉').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
  combo('label 内下拉').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  await sleep(120);
  const afterKeyboard=shot('label 内下拉');
  check('label 内下拉：键盘选中后关闭',afterKeyboard.expanded==='false'&&afterKeyboard.pop===false,afterKeyboard);

  // ⑤ 不带 label 的普通下拉保持原有行为。
  await pick('普通下拉','p2');
  const afterPlain=shot('普通下拉');
  check('普通下拉：选择后关闭并更新值',afterPlain.expanded==='false'&&afterPlain.pop===false&&afterPlain.value==='P2',afterPlain);

  return{ok:checks.every(c=>c.ok),checks,events};
}
window.run=run;
`;
    writeFileSync(join(fixture, 'harness.tsx'), harness.replaceAll('__ROOT__', root.replaceAll('\\', '/')));
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
    console.log('R214_RESULT '+JSON.stringify(result));app.exit(result.ok?0:1);
  }catch(error){console.log('R214_RESULT '+JSON.stringify({ok:false,error:String(error)}));app.exit(2);}
});
setTimeout(()=>app.exit(3),40000);
`);
    await build({entryPoints:[join(fixture,'harness.tsx')],bundle:true,platform:'browser',format:'iife',jsx:'automatic',loader:{'.png':'dataurl'},outfile:join(fixture,'harness.js'),define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(resolve('node_modules/electron/dist/electron.exe'), [join(fixture,'main.cjs')], {cwd:root,env,windowsHide:true,encoding:'utf8',timeout:45000});
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const line = output.split(/\r?\n/).find(line=>line.startsWith('R214_RESULT '));
    const report = line == null ? {ok:false,error:output.slice(-5000)} : JSON.parse(line.slice('R214_RESULT '.length)) as {ok:boolean;checks?:Array<{name:string;ok:boolean}>;error?:string};
    expect(report,JSON.stringify(report)).toMatchObject({ok:true});
    expect(report.checks).toHaveLength(9);
  }, 55000);
});
