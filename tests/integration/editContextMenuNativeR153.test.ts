import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

// Explicit opt-in: real Electron windows on a secondary display. No daemon,
// models, clipboard reads/writes, user profile, or installed application.
const native = process.platform === 'win32' && process.env.ZS_R153_NATIVE_CONTEXT === '1';
const fixture = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {app, BrowserWindow, Menu, screen} = require('electron');
const config = __CONFIG__;
const {registerEditContextMenu} = require(config.module);
app.setPath('userData', path.join(config.run, 'electron-profile'));
const report = {ok:false, checks:[], contexts:[], nativeMenuShows:0, clipboardReadOrWritten:false, realModelCalls:0};
function save() { fs.writeFileSync(path.join(config.run,'report.json'),JSON.stringify(report,null,2)); }
function fail(error) { report.error=error.stack??String(error);save();app.exit(1); }
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
  const display=screen.getAllDisplays().find(d=>d.id!==screen.getPrimaryDisplay().id && (!config.display||d.id===config.display));
  if(!display)throw Error('A secondary display is required; refusing primary screen');
  const area=display.workArea;
  const win=new BrowserWindow({x:area.x+80,y:area.y+80,width:900,height:740,show:false,title:'R153 isolated native edit-menu QA',webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.setMenu(null);
  let current=null, entry=null;
  win.webContents.on('context-menu',(_event,p)=>{
    entry={formControlType:p.formControlType,isEditable:p.isEditable,selectionText:p.formControlType==='input-password'?'[redacted]':p.selectionText,editFlags:p.editFlags};
  });
  registerEditContextMenu(win, items=>{
    const menu=Menu.buildFromTemplate(items);current=menu;
    entry.menu=menu.items.map(i=>({label:i.label,role:i.role,enabled:i.enabled,type:i.type}));
    menu.on('menu-will-show',()=>{report.nativeMenuShows++;entry.nativeMenuShown=true;});
    setTimeout(()=>menu.closePopup(win),100);
    return menu;
  });
  const html='<!doctype html><html><head><style>body{font:18px sans-serif;padding:30px}label{display:block;margin:14px}input,textarea,[contenteditable],#plain{display:block;width:600px;font:18px sans-serif;padding:8px;border:1px solid #888}textarea{height:55px}</style></head><body><label>Input<input id="text" value="input alpha beta"></label><label>Textarea<textarea id="textarea">textarea alpha beta</textarea></label><label>Contenteditable<div id="editable" contenteditable="true">editable alpha beta</div></label><label>Readonly<input id="readonly" readonly value="readonly alpha beta"></label><label>Disabled<input id="disabled" disabled value="disabled alpha beta"></label><label>Password<input id="password" type="password" value="synthetic-secret"></label><div id="plain">ordinary selected alpha beta</div></body></html>';
  await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
  win.show();win.focus();await wait(200);
  for(const id of ['text','textarea','editable','readonly','disabled','password','plain']){
    entry=null;current=null;
    const point=await win.webContents.executeJavaScript('(()=>{const el=document.getElementById('+JSON.stringify(id)+');window.getSelection().removeAllRanges();document.activeElement?.blur();el.focus();if(el.setSelectionRange&&!el.disabled)el.setSelectionRange(0,5);else if(el.isContentEditable||el.id==="plain"){const r=document.createRange();r.setStart(el.firstChild,0);r.setEnd(el.firstChild,5);window.getSelection().addRange(r);}const b=el.getBoundingClientRect();return{x:Math.round(b.x+30),y:Math.round(b.y+b.height/2)};})()');
    win.webContents.sendInputEvent({type:'mouseDown',button:'right',clickCount:1,...point});
    win.webContents.sendInputEvent({type:'mouseUp',button:'right',clickCount:1,...point});
    for(let i=0;i<30&&!entry;i++)await wait(20);
    assert.ok(entry,'No real Chromium context-menu event for '+id);
    await wait(160);
    report.contexts.push({id,...entry});
    if(id==='disabled'){
      assert.equal(entry.isEditable,false);
      assert.ok(!entry.menu||entry.menu.filter(i=>['cut','copy','paste'].includes(i.role)).every(i=>!i.enabled));
      // Chromium may allow page-level Select All over a disabled control; do
      // not invent a control capability or override its native edit flags.
      if(entry.menu)assert.equal(entry.menu.find(i=>i.role==='selectall').enabled,entry.editFlags.canSelectAll);
    }else{
      assert.ok(entry.nativeMenuShown,'Real menu did not open for '+id);
      const byRole=Object.fromEntries(entry.menu.filter(i=>i.role).map(i=>[i.role,i]));
      assert.equal(byRole.copy.enabled,id!=='password'&&entry.selectionText.length>0&&entry.editFlags.canCopy);
      if(id==='plain')assert.equal(byRole.paste,undefined);
      else {
        assert.equal(byRole.cut.enabled,entry.isEditable&&id!=='password'&&entry.selectionText.length>0&&entry.editFlags.canCut);
        assert.equal(byRole.paste.enabled,entry.isEditable&&entry.editFlags.canPaste);
      }
      assert.equal(byRole.selectall.enabled,entry.editFlags.canSelectAll);
    }
    report.checks.push({id:'native-context-'+id,passed:true});
    if(['text','textarea','editable','readonly','plain'].includes(id)){
      const select=current?.items.find(i=>i.role==='selectall');
      assert.ok(select?.enabled);
      // Invoke the actual Electron MenuItem role, without clipboard access or a
      // product callback. This is a native role check, not physical menu input.
      // Electron's constructed click dispatcher takes (event, window, contents).
      // The user-supplied click callback has a different signature; none is set.
      select.click({},win,win.webContents);await wait(80);
      const selected=await win.webContents.executeJavaScript('(()=>{const el=document.getElementById('+JSON.stringify(id)+');return el.setSelectionRange?el.value.slice(el.selectionStart,el.selectionEnd):window.getSelection().toString()})()');
      const expected=await win.webContents.executeJavaScript('(()=>{const el=document.getElementById('+JSON.stringify(id)+');return el.value??el.textContent})()');
      if(id!=='plain')assert.equal(selected,expected);
      else assert.ok(selected.includes(expected));
      report.checks.push({id:'real-selectAll-role-'+id,passed:true});
      if(id==='editable'){
        entry=null;
        win.webContents.sendInputEvent({type:'mouseDown',button:'right',clickCount:1,...point});
        win.webContents.sendInputEvent({type:'mouseUp',button:'right',clickCount:1,...point});
        for(let i=0;i<30&&!entry;i++)await wait(20);
        await wait(160);
        assert.ok(entry?.selectionText.length>0);
        assert.equal(entry.menu.find(i=>i.role==='copy').enabled,true);
        assert.equal(entry.menu.find(i=>i.role==='cut').enabled,true);
        report.contexts.push({id:'editable-selected',...entry});
        report.checks.push({id:'contenteditable-selected-copy-cut-enabled',passed:true});
      }
    }
  }
  report.ok=true;report.display=display.id;save();win.destroy();app.quit();
}).catch(fail);
`;

describe.runIf(native)('R153 isolated real Electron editing context menu', () => {
  it('uses actual Chromium edit flags, native menus and selection roles', async () => {
    const repo = resolve(import.meta.dirname, '../..');
    const run = join(repo, 'dist', 'r153-edit-menu', randomUUID());
    mkdirSync(run, { recursive: true });
    const module = join(run, 'editContextMenu.cjs');
    const source = join(repo, 'src/ui/editContextMenu.ts');
    const bundled = await build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false });
    writeFileSync(module, bundled.outputFiles[0]!.contents);
    const config = { run, module, display: Number(process.env.ZS_TEST_DISPLAY ?? 973946365) };
    const host = join(run, 'host.cjs');
    writeFileSync(host, fixture.replace('__CONFIG__', JSON.stringify(config)));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^ZS_/i.test(key) || /^ELECTRON_RUN_AS_NODE$/i.test(key)) delete env[key];
    const child = spawn(join(repo, 'node_modules/electron/dist/electron.exe'), [host], {
      cwd: repo, env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', bytes => { log += bytes.toString(); });
    child.stderr.on('data', bytes => { log += bytes.toString(); });
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error(`Owned native QA timed out: ${run}`)); }, 45_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolveExit(code); });
    });
    writeFileSync(join(run, 'process.log'), log);
    expect(existsSync(join(run, 'report.json')), `${run}\n${log}`).toBe(true);
    const report = JSON.parse(readFileSync(join(run, 'report.json'), 'utf8'));
    report.hostExitCode = exitCode;
    report.sourceSha256 = createHash('sha256').update(readFileSync(source)).digest('hex');
    writeFileSync(join(run, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`R153_NATIVE_EDIT_MENU ${run}`);
    expect(exitCode, JSON.stringify(report)).toBe(0);
    expect(report.ok, JSON.stringify(report)).toBe(true);
    expect(report.nativeMenuShows).toBeGreaterThanOrEqual(6);
    expect(report.checks).toHaveLength(13);
  }, 60_000);
});
