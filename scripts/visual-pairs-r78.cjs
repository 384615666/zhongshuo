'use strict';
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, __dirname, process, setTimeout, fetch, AbortSignal, WebSocket, Buffer, console */
/**
 * R78 常用界面视觉门。只启动本脚本创建的进程；独立数据根、独立端口；零模型调用。
 * 先运行 pnpm build:ui，再运行 node scripts/visual-pairs-r78.cjs。
 * 输出原型/正式同视口、同主题、同缩放的成对截图与几何/数据密度元信息。
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');

const repo = path.resolve(__dirname, '..');
const out = path.join(repo, 'dist', `r78-visual-pairs-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`);
const protoPort = 9783, protoCdp = 9784, formalCdp = 9785;
const pipe = `\\\\.\\pipe\\zs-r78-visual-${randomBytes(4).toString('hex')}`;
const electron = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const valueOfArg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] ?? null; };
const packageSource = valueOfArg('--src');
const expectedBuildId = valueOfArg('--expect-build-id');
function formalSource() {
  if (packageSource == null) {
    if (expectedBuildId != null) throw new Error('--expect-build-id 只能与 --src 正式包一起使用');
    return {
      executable: electron,
      args: [`--remote-debugging-port=${formalCdp}`, path.join(repo, 'dist', 'ui', 'main.cjs')],
      cwd: repo,
      identity: { kind: 'dist/ui development build', mainSha256: sha(path.join(repo, 'dist', 'ui', 'main.cjs')), rendererSha256: sha(path.join(repo, 'dist', 'ui', 'renderer', 'hifi', 'app.mjs')) },
    };
  }
  if (expectedBuildId == null) throw new Error('--src 必须同时提供 --expect-build-id，避免把旧包截图误记为当前构建');
  const root = path.resolve(packageSource);
  const build = JSON.parse(fs.readFileSync(path.join(root, 'BUILD.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'MANIFEST-SHA256.json'), 'utf8'));
  if (build.buildId !== expectedBuildId || manifest.buildId !== expectedBuildId) throw new Error('BUILD/MANIFEST 与指定 buildId 不一致');
  let checked = 0;
  for (const entry of manifest.files) {
    const file = path.resolve(root, entry.path);
    if (!file.toLowerCase().startsWith((root + path.sep).toLowerCase()) || !fs.existsSync(file) || sha(file) !== entry.sha256) throw new Error(`正式包清单校验失败：${entry.path}`);
    checked += 1;
  }
  const executable = path.join(root, 'electron.exe');
  if (!fs.existsSync(executable)) throw new Error('正式包缺 electron.exe');
  return { executable, args: [`--remote-debugging-port=${formalCdp}`], cwd: root, identity: { kind: 'packaged BUILD', root, buildId: build.buildId, commit: build.commit, dirty: build.dirty, manifestChecked: checked, executableSha256: sha(executable), rendererSha256: sha(path.join(root, 'resources', 'app', 'dist', 'ui', 'renderer', 'hifi', 'app.mjs')) } };
}
const owned = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;
const until = async (fn, timeout, label) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`超时：${label}`);
    await sleep(250);
  }
};

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      const item = this.pending.get(msg.id);
      if (!item) return;
      this.pending.delete(msg.id);
      if (msg.error) item.reject(new Error(msg.error.message)); else item.resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`CDP 超时：${method}`)); }, 60000).unref();
    });
  }
  async eval(expr) {
    const result = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(String(result.exceptionDetails.text));
    return result.result.value;
  }
}

async function connect(port) {
  const target = await until(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1200) }).then((r) => r.json());
    return targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  }, 60000, `CDP ${port}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  return cdp;
}

function start(exe, args, cwd, env = {}) {
  const child = spawn(exe, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'ignore'] });
  owned.add(child); child.once('exit', () => owned.delete(child));
  return child;
}
function cleanup() {
  for (const child of [...owned]) {
    if (child.exitCode != null) continue;
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* owned process already exited */ }
  }
}
const sceneList = [
  { name: 'project-menu', proto: '/project/proj_zs_01', formal: (id) => `/project/${id}`, ready: '.page-head' },
  { name: 'project-home', proto: '/project/proj_zs_01', formal: (id) => `/project/${id}`, ready: '.page-head' },
  { name: 'room-create', proto: '/project/proj_zs_01', formal: (id) => `/project/${id}`, ready: '.page-head' },
  { name: 'project-settings', proto: '/project/proj_zs_01/settings', formal: (id) => `/project/${id}/settings`, ready: '.pset-section' },
  { name: 'project-settings-advanced', proto: '/project/proj_zs_01/settings', formal: (id) => `/project/${id}/settings`, ready: '.pset-section' },
  { name: 'members', proto: '/project/proj_zs_01/members', formal: (id) => `/project/${id}/members`, ready: '.grid .card' },
  { name: 'member-config', proto: '/member/member_codex', formal: (id, ctx) => `/project/${id}/member/${ctx.memberId}`, ready: '[data-zs-member-detail]' },
  { name: 'board', proto: '/tasks?scope=project&projectId=proj_zs_01', formal: (id) => `/board?scope=project&projectId=${id}`, ready: '.page-filters' },
  { name: 'room-pool', proto: '/project/proj_zs_01/room/room_dev_hall', formal: (id, ctx) => `/project/${id}/room/${ctx.defaultRoomId}`, ready: '.pool-title' },
  { name: 'room-thread', proto: '/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&tab=task', formal: (id, ctx) => `/project/${id}/room/${ctx.defaultRoomId}?thread=${ctx.threadId}&tab=task`, ready: '.pool-title' },
  { name: 'files', proto: '/project/proj_zs_01/files?tab=files', formal: (id) => `/project/${id}/files?tab=files`, ready: '.fg-body' },
  { name: 'git', proto: '/project/proj_zs_01/files?tab=git', formal: (id) => `/project/${id}/files?tab=git`, ready: '.fg-body' },
  { name: 'settings', proto: '/settings?section=general', formal: () => '/settings?section=general', ready: '.settings-layout' },
  { name: 'settings-connections', proto: '/settings?section=connections', formal: () => '/settings?section=connections', ready: '.settings-layout' },
];
const viewports = [
  { name: 'wide', width: 1280, height: 800, dpr: 1 },
  { name: 'narrow', width: 900, height: 700, dpr: 1 },
  { name: 'hidpi', width: 2560, height: 1380, dpr: 2 },
];

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const formalBuild = formalSource();
  const source = formalBuild.identity;
  const fixture = path.join(out, 'fixture-project');
  const dataRoot = path.join(out, 'app-data');
  fs.mkdirSync(fixture, { recursive: true });
  for (let i = 1; i <= 60; i++) fs.writeFileSync(path.join(fixture, `note-${String(i).padStart(2, '0')}.md`), `# R78 文件 ${i}\n\n同视口阅读密度夹具。\n`);
  if (!fs.existsSync(path.join(fixture, '.git'))) {
    execFileSync('git', ['init'], { cwd: fixture, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=R78 Fixture', '-c', 'user.email=r78@example.invalid', 'add', '.'], { cwd: fixture, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=R78 Fixture', '-c', 'user.email=r78@example.invalid', 'commit', '-m', 'fixture baseline'], { cwd: fixture, stdio: 'ignore' });
  }
  for (let i = 1; i <= 23; i++) fs.writeFileSync(path.join(fixture, `note-${String(i).padStart(2, '0')}.md`), `# R78 文件 ${i}\n\n未暂存差异供 Git 页面显示：${i}。\n`);
  const protoHost = path.join(out, 'proto-host');
  fs.mkdirSync(protoHost, { recursive: true });
  fs.mkdirSync(path.join(protoHost, 'user-data'), { recursive: true });
  fs.writeFileSync(path.join(protoHost, 'main.cjs'), `const { app, BrowserWindow } = require('electron'); const path = require('node:path'); app.setPath('userData', path.join(__dirname, 'user-data')); app.whenReady().then(() => { const w = new BrowserWindow({width:1280,height:800,useContentSize:true,webPreferences:{contextIsolation:true}}); w.loadURL(process.env.ZS_PROTO_URL); });`);
  start(process.execPath, [path.join(repo, 'hifi-prototype', 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(protoPort), '--strictPort', '--host', '127.0.0.1'], path.join(repo, 'hifi-prototype'));
  await until(() => fetch(`http://127.0.0.1:${protoPort}/`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok), 60000, '原型 Vite');
  start(electron, [`--remote-debugging-port=${protoCdp}`, path.join(protoHost, 'main.cjs')], repo, { ZS_PROTO_URL: `http://127.0.0.1:${protoPort}/` });
  start(formalBuild.executable, formalBuild.args, formalBuild.cwd, { ZS_APP_DATA: dataRoot, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_PIPE_NAME: pipe });
  let proto = await connect(protoCdp), formal = await connect(formalCdp);
  await until(() => proto.eval(probe(`document.querySelector('.sidebar') != null`)), 60000, '原型挂载');
  await until(() => formal.eval(probe(`document.body.classList.contains('hifi-on')`)), 60000, '正式挂载');
  await proto.eval(probe(`(() => { [...document.querySelectorAll('button')].find((b) => b.textContent.includes('暂不处理'))?.click(); return true; })()`));
  await sleep(500);
  await proto.eval(probe(`(() => { [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '关闭' || b.textContent.includes('知道了'))?.click(); return true; })()`));
  const cmd = async (method, params) => {
    const raw = await formal.eval(`window.zs.command({protocolVersion:1,commandId:'r78-vis-'+Math.random().toString(36).slice(2),method:${JSON.stringify(method)},params:${JSON.stringify(params)}}).then(r=>JSON.stringify(r))`);
    const reply = JSON.parse(raw);
    if (!reply.ok) throw new Error(`${method}: ${reply.error?.message}`);
    return reply.data;
  };
  const opened = await cmd('project.open', { path: fixture });
  const projectId = opened.project.id;
  await cmd('member.create', { projectId, displayName: '审查者', description: '复核交付与风险' });
  await cmd('member.create', { projectId, displayName: '审查者', description: '复核文件与证据' });
  await cmd('room.create', { projectId, name: '方案讨论' });
  await cmd('room.create', { projectId, name: '文档整理' });
  const roomRows = (await cmd('room.list', { projectId })).items;
  const defaultRoom = roomRows.find((r) => r.name === '默认房间');
  const planRoom = roomRows.find((r) => r.name === '方案讨论');
  const docsRoom = roomRows.find((r) => r.name === '文档整理');
  const agent = (await cmd('member.list', { projectId })).items.find((m) => m.principalType === 'agent');
  if (!defaultRoom || !planRoom || !docsRoom || !agent) throw new Error('视觉夹具成员/房间未就绪');
  await cmd('room.update', { roomId: defaultRoom.id, expectedRevision: defaultRoom.revision, description: '核心实现讨论与代码改动，写入串行' });
  await cmd('room.update', { roomId: planRoom.id, expectedRevision: planRoom.revision, description: '只分析不改动：研讨结论沉淀为项目约定' });
  await cmd('room.update', { roomId: docsRoom.id, expectedRevision: docsRoom.revision, description: '已归档：保留只读历史' });
  await cmd('room.archive', { roomId: docsRoom.id, expectedRevision: docsRoom.revision + 1, action: 'archive' });
  const submitTask = (room, body) => cmd('message.submit', { target: { kind: 'room_root', projectId, roomId: room.id, conversationId: room.conversationId }, body, intent: 'default', mentions: [{ kind: 'member', memberId: agent.id }] });
  for (const body of ['布局草图我也贴一下，方便对齐。', '请把文件改动和验证依据分别列出。', '验收截图放在成果里，便于直接复核。', '这里先记录约束，不派发新的任务。']) {
    await cmd('message.submit', { target: { kind: 'room_root', projectId, roomId: defaultRoom.id, conversationId: defaultRoom.conversationId }, body, intent: 'record_only', mentions: [] });
  }
  await submitTask(defaultRoom, '评审表结构目录并列出依据');
  await cmd('project.reviewPolicy.set', { projectId, taskReviewEnabled: true, expectedRevision: 0 });
  const fakeTasks = [
    { room: defaultRoom, body: '分析模块划分并给出重构建议' },
    { room: defaultRoom, body: '修复构建脚本中的路径下失败' },
    { room: planRoom, body: '整理本周演示与周报' },
  ];
  for (const t of fakeTasks) await submitTask(t.room, t.body);
  const boardForDensity = await until(async () => {
    const b = await cmd('board.view', { scope: 'project', projectId });
    const cards = b.groups.flatMap((g) => g.rooms.flatMap((r) => r.cards));
    return cards.length === 4 && cards.filter((c) => c.taskStatus === 'REVIEW').length === 3 && cards.some((c) => c.taskStatus === 'DONE') ? cards : null;
  }, 45000, 'fake worker 自然完成一项并交付三项待验收任务');
  const threadId = boardForDensity.find((c) => c.roomId === defaultRoom.id && c.threadId != null)?.threadId;
  if (!threadId) throw new Error('默认房间任务缺少线程定位');
  const fixtureDensity = { projectFiles: 60, gitModifiedFiles: 23, rooms: roomRows.length, taskRequests: 4, recordOnlyMessages: 4, memberInstances: 3, taskOrigin: 'message.submit → formal worker/FakeRuntimeAdapter；无 SQL 改状态' };
  await formal.eval('location.reload(), true');
  formal = await connect(formalCdp);
  await until(() => formal.eval(probe(`document.querySelector('#hifi-root .side-project') != null`)), 60000, '正式侧栏');
  const shots = [];
  for (const viewport of viewports) {
    const metrics = { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.dpr, mobile: false };
    await proto.send('Emulation.setDeviceMetricsOverride', metrics);
    await formal.send('Emulation.setDeviceMetricsOverride', metrics);
    await proto.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    await formal.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    for (const scene of sceneList) {
      const pair = { viewport: viewport.name, scene: scene.name, approvedDiffs: '原型种子与正式独立工程夹具数据不同；交互/视觉需人工分门评判。', ...(scene.name === 'member-config' ? { unresolvedDiff: '改名、思考强度、成员级重启/重置/清理缺正式命令，控件显禁用原因。' } : {}), sides: {} };
      for (const [name, cdp, route] of [['proto', proto, scene.proto], ['formal', formal, scene.formal(projectId, { defaultRoomId: defaultRoom.id, threadId, memberId: agent.id })]]) {
        await cdp.eval(`location.hash = ${JSON.stringify('#' + route)}; true`);
        const selector = scene.name === 'member-config' && name === 'proto' ? '.page-head' : name === 'formal' && scene.name === 'members' ? '#hifi-root [data-zs-member-card]' : name === 'formal' ? '#hifi-root ' + scene.ready : scene.ready;
        await until(() => cdp.eval(probe(`document.querySelector(${JSON.stringify(selector)}) != null`)), 20000, `${scene.name}/${name}`);
        if (scene.name === 'member-config' && name === 'formal') {
          await until(() => cdp.eval(probe(`document.querySelector('[data-zs-member-detail]')?.textContent.includes('模型与能力') && !document.querySelector('[data-zs-member-detail]')?.textContent.includes('读取中…')`)), 15000, '成员详情事实已读取');
        }
        if (scene.name === 'project-settings-advanced') {
          await cdp.eval(probe(`(() => { const target = document.querySelector('#pset-write'); target?.scrollIntoView({block:'start'}); return target != null; })()`));
          await sleep(300);
        }
        if (scene.name === 'project-menu') {
          const menuButton = name === 'formal' ? '#zs-titlebar [data-zs-project-menu-btn]' : '.titlebar-project-btn';
          await cdp.eval(probe(`document.querySelector(${JSON.stringify(menuButton)})?.click(), true`));
          await until(() => cdp.eval(probe(`document.querySelector('.menu') != null`)), 5000, `项目菜单/${name}`);
        }
        if (scene.name === 'room-create') {
          await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('.page-head-actions button')].find(x => x.textContent.includes('新建房间')); b?.click(); return b != null; })()`));
          await until(() => cdp.eval(probe(`document.querySelector('.modal') != null`)), 5000, `建房弹窗/${name}`);
        }
        await sleep(650);
        if (scene.name === 'project-settings-advanced') {
          const visible = await cdp.eval(probe(`(() => {const el=document.querySelector('#pset-write');if(!el)return false;const r=el.getBoundingClientRect();return r.top<innerHeight && r.bottom>38;})()`));
          if (!visible) throw new Error(`项目写入限制不在实际视口：${name}/${viewport.name}`);
          pair.sidesAdvancedVisible = { ...(pair.sidesAdvancedVisible ?? {}), [name]: true };
        }
        const meta = await cdp.eval(probe(`(() => { const root = document.querySelector(${JSON.stringify(name === 'formal' ? '#hifi-root' : '.app')}) || document.body; const main = root.querySelector('.main') || root; const r = main.getBoundingClientRect(); return {route:location.hash, viewport:{w:innerWidth,h:innerHeight,dpr:devicePixelRatio,scale:visualViewport?.scale}, theme:document.documentElement.getAttribute('data-theme') || document.body.getAttribute('data-theme'), mainRect:{x:r.x,y:r.y,w:r.width,h:r.height}, overflowX:main.scrollWidth>main.clientWidth+1, density:{cards:root.querySelectorAll('.card').length, rootCards:root.querySelectorAll('.root-card').length, rows:root.querySelectorAll('.pset-row,.member-row,.file-row,.git-list-row').length, panels:root.querySelectorAll('.panel').length}}; })()`));
        const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const imagePath = path.join(out, `${viewport.name}-${scene.name}-${name}.png`);
        fs.writeFileSync(imagePath, Buffer.from(image.data, 'base64'));
        pair.sides[name] = { image: imagePath, meta };
        if (scene.name === 'project-menu') {
          const menuButton = name === 'formal' ? '#zs-titlebar [data-zs-project-menu-btn]' : '.titlebar-project-btn';
          await cdp.eval(probe(`document.querySelector(${JSON.stringify(menuButton)})?.click(), true`));
          await until(() => cdp.eval(probe(`document.querySelector('.menu') == null`)), 5000, `项目菜单关闭/${name}`);
          pair.sides[name].closePath = '点击同一项目按钮关闭';
        }
        if (scene.name === 'room-create') {
          await cdp.eval(probe(`(() => { const modal = document.querySelector('.modal'); const cancel = [...(modal?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === '取消'); cancel?.click(); return cancel != null; })()`));
          await until(() => cdp.eval(probe(`document.querySelector('.modal') == null`)), 5000, `建房弹窗取消/${name}`);
          pair.sides[name].closePath = '取消按钮关闭且零 room.create';
        }
        if (scene.name === 'member-config' && name === 'formal') {
          await cdp.eval(probe(`document.querySelector('#hifi-root [data-zs-member-detail-bind]')?.click(), true`));
          await until(() => cdp.eval(probe(`document.querySelector('.modal') != null`)), 5000, '成员详情 runtime 配置弹窗');
          await cdp.eval(probe(`(() => { const modal = document.querySelector('.modal'); const cancel = [...(modal?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === '取消'); cancel?.click(); return cancel != null; })()`));
          await until(() => cdp.eval(probe(`document.querySelector('.modal') == null`)), 5000, '成员配置取消');
          pair.sides[name].closePath = '取消按钮关闭，未提交 member.setRuntime';
        }
      }
      shots.push(pair);
    }
  }
  // 单成员入口/写入/错误门：仅独立工程成员，真实 formal commands，零 startTurn。
  const memberRows = (await cmd('member.list', { projectId })).items;
  const coordinatorIds = new Set(roomRows.map(r=>r.coordinatorMemberId).filter(Boolean));
  const reviewer = memberRows.find(m => m.principalType === 'agent' && !coordinatorIds.has(m.id));
  if (!reviewer) throw new Error('成员测试缺独立审查者');
  const clickFormal = async (label, scope = '#hifi-root') => {
    const hit = await formal.eval(`(() => { const b = [...(document.querySelector(${JSON.stringify(scope)})?.querySelectorAll('button') ?? [])].find(b=>b.textContent.trim()===${JSON.stringify(label)} && !b.disabled); if(!b)return false;b.click();return true; })()`);
    if (!hit) throw new Error(`成员操作按钮不可用：${label}`);
  };
  await formal.eval(`location.hash=${JSON.stringify('#/project/'+projectId+'/members')};true`);
  await until(()=>formal.eval(probe(`document.querySelector('[data-zs-member-card="${reviewer.id}"]') != null`)),15000,'成员卡入口');
  await formal.eval(`document.querySelector('[data-zs-member-card="${reviewer.id}"]').click();true`);
  await until(()=>formal.eval(probe(`document.querySelector('[data-zs-member-detail="${reviewer.id}"]')?.textContent.includes('模型与能力')`)),15000,'正确成员详情');
  await clickFormal('停用成员');
  await until(async()=> (await cmd('member.list',{projectId})).items.find(m=>m.id===reviewer.id)?.enabled===false,15000,'正式停用保存');
  await until(()=>formal.eval(probe(`[...document.querySelectorAll('#hifi-root button')].some(b=>b.textContent.trim()==='启用成员' && !b.disabled)`)),10000,'启用入口');
  await clickFormal('启用成员');
  await until(async()=> (await cmd('member.list',{projectId})).items.find(m=>m.id===reviewer.id)?.enabled===true,15000,'正式恢复');
  await clickFormal('配置 runtime 与模型…');
  await until(()=>formal.eval(probe(`document.querySelector('.modal input[placeholder*="deepseek"]') != null`)),10000,'绑定输入');
  await formal.eval(`(() => {const i=document.querySelector('.modal input[placeholder*="deepseek"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'r78-engineering-config');i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await clickFormal('保存绑定','.modal');
  await until(()=>formal.eval(probe(`document.querySelector('.modal .panel.warning')?.textContent.includes('绑定失败')`)),15000,'真实绑定防护失败就地提示');
  const retained = await formal.eval(`document.querySelector('.modal input[placeholder*="deepseek"]').value === 'r78-engineering-config'`);
  if(!retained) throw new Error('绑定失败丢失输入');
  const failurePng=await formal.send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(out,'member-binding-failure-retained.png'),Buffer.from(failurePng.data,'base64'));
  await formal.eval(`document.querySelector('.modal [aria-label="runtime 渠道"]').click();true`);
  await until(()=>formal.eval(probe(`document.querySelector('[data-zs-option="fake"]') != null`)),5000,'工程fake选项');
  await formal.eval(`document.querySelector('[data-zs-option="fake"]').click();true`);
  await clickFormal('保存绑定','.modal');
  await until(async()=> (await cmd('member.runtime',{memberId:reviewer.id})).installation?.kind==='fake',15000,'正式绑定fake回读');
  await formal.eval('location.reload();true');formal=await connect(formalCdp);
  await until(()=>formal.eval(probe(`document.querySelector('[data-zs-member-detail="${reviewer.id}"]')?.textContent.includes('fake · 已绑定')`)),15000,'成员配置重开');
  await clickFormal('返回成员管理');
  await until(()=>formal.eval(probe(`document.querySelector('[data-zs-member-card="${reviewer.id}"]') != null`)),10000,'返回成员');
  const memberInteraction = { cardOpensExactIdentity:true, formalDisableAndEnable:true, bindingFailureVisibleAndDraftRetained:retained, engineeringBindingSavedAndReopened:true, returnToMembers:true };
  // 设置交互门：只在独立根启用回环监听，UI 发正式命令；一次性配对码只核出现/重开消失，
  // 不截图、不写码进报告。最后从 UI 停用并核真实监听关闭。
  await formal.eval(`location.hash='#/settings?section=connections'; true`);
  await until(() => formal.eval(probe(`[...document.querySelectorAll('#hifi-root button')].some(b => b.textContent.trim() === '启用/应用' && !b.disabled)`)), 15000, '远程设置可操作');
  await formal.eval(probe(`[...document.querySelectorAll('#hifi-root button')].find(b => b.textContent.trim() === '启用/应用')?.click(), true`));
  await until(async () => (await cmd('remote.config.get', {})).running === true, 15000, '回环监听已启用');
  await until(() => formal.eval(probe(`[...document.querySelectorAll('#hifi-root button')].some(b => b.textContent.trim() === '生成配对码' && !b.disabled)`)), 15000, '配对按钮可操作');
  await formal.eval(probe(`[...document.querySelectorAll('#hifi-root button')].find(b => b.textContent.trim() === '生成配对码')?.click(), true`));
  await until(() => formal.eval(probe(`document.querySelector('#hifi-root .settings-body')?.textContent.includes('配对 ID：')`)), 10000, '一次性码页面反馈');
  await formal.eval('location.reload(), true');
  formal = await connect(formalCdp);
  await formal.eval(`location.hash='#/settings?section=connections'; true`);
  await until(() => formal.eval(probe(`document.querySelector('#hifi-root .settings-body') != null`)), 15000, '重开设置页');
  const codeGoneOnReopen = await formal.eval(probe(`!document.querySelector('#hifi-root .settings-body')?.textContent.includes('配对 ID：')`));
  if (!codeGoneOnReopen) throw new Error('配对码在重开后仍在页面，违反一次性展示');
  await until(() => formal.eval(probe(`[...document.querySelectorAll('#hifi-root button')].some(b => b.textContent.trim() === '停用' && !b.disabled)`)), 15000, '停用可操作');
  await formal.eval(probe(`[...document.querySelectorAll('#hifi-root button')].find(b => b.textContent.trim() === '停用')?.click(), true`));
  await until(async () => (await cmd('remote.config.get', {})).running === false, 15000, '回环监听已停用');
  const fixtureB = path.join(out, 'fixture-project-B');
  fs.mkdirSync(fixtureB, { recursive: true });
  fs.writeFileSync(path.join(fixtureB, 'README.md'), '# 第二项目（路由复用验证）\n');
  const projectB = (await cmd('project.open', { path: fixtureB })).project.id;
  await formal.eval('location.reload();true'); formal = await connect(formalCdp);
  await until(()=>formal.eval(probe(`document.querySelector('#hifi-root .side-project') != null`)),15000,'注册表重开');
  await formal.eval(`location.hash=${JSON.stringify('#/project/'+projectB+'/member/'+reviewer.id)};true`);
  await until(()=>formal.eval(probe(`document.querySelector('[data-zs-member-detail]')?.textContent.includes('此成员不属于地址中的项目')`)),15000,'外项目成员拒绝');
  if (await formal.eval(`document.querySelector('[data-zs-member-detail-bind]') != null`)) throw new Error('错配成员仍可写');
  memberInteraction.foreignProjectMemberDenied = true;
  await formal.eval('location.reload(), true');
  formal = await connect(formalCdp);
  await until(() => formal.eval(probe(`document.body.classList.contains('hifi-on')`)), 15000, '双项目重开');
  await formal.eval(`location.hash=${JSON.stringify('#/project/' + projectId + '/settings')}; true`);
  await until(() => formal.eval(probe(`document.querySelector('#hifi-root .page-title')?.textContent.includes('fixture-project ·')`)), 15000, 'A 项目设置');
  await formal.eval(`location.hash=${JSON.stringify('#/project/' + projectB + '/settings')}; true`);
  let routeSwitchOk;
  try {
    routeSwitchOk = await until(() => formal.eval(probe(`document.querySelector('#hifi-root .page-title')?.textContent.includes('fixture-project-B ·') && !document.querySelector('#hifi-root')?.textContent.includes('本页编辑绑定原项目')`)), 15000, 'A→B 项目设置');
  } catch (e) {
    const diagnostic = await formal.eval(probe(`({route:location.hash, text:document.querySelector('#hifi-root')?.textContent.slice(0,450)})`));
    throw new Error(`${e.message}：${JSON.stringify(diagnostic)}`, { cause: e });
  }
  await formal.eval(probe(`(() => { const input = document.querySelector('#hifi-root input[placeholder="项目显示名"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, 'R78 project B'); input.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`));
  await until(() => formal.eval(probe(`[...document.querySelectorAll('#hifi-root button')].some(b => b.textContent.trim() === '保存' && !b.disabled)`)), 5000, 'B 属性可保存');
  await formal.eval(probe(`[...document.querySelectorAll('#hifi-root button')].find(b => b.textContent.trim() === '保存' && !b.disabled)?.click(), true`));
  await until(async () => (await cmd('project.list', {})).items.some((p) => p.id === projectB && p.displayName === 'R78 project B'), 10000, 'B 属性正式回读');
  const projectAUnchanged = (await cmd('project.list', {})).items.some((p) => p.id === projectId && p.displayName === 'fixture-project');
  if (!projectAUnchanged) throw new Error('B 属性编辑误写 A 项目');
  await formal.eval('location.reload(), true');
  formal = await connect(formalCdp);
  await until(() => formal.eval(probe(`document.querySelector('#hifi-root .page-title')?.textContent.includes('R78 project B ·')`)), 15000, 'B 设置重开');
  const Database = require(path.join(repo, 'node_modules', 'better-sqlite3'));
  const db = new Database(path.join(dataRoot, 'state.sqlite'), { readonly: true });
  const realCalls = db.prepare('SELECT count(*) AS n FROM real_calls').get().n;
  db.close();
  const manifest = { projectId, projectB, dataRoot, protoPort, protoCdp, formalCdp, source, theme: 'light', zoom: 1, realCalls, fixtureDensity, shots, memberInteraction, settingsInteraction: { loopbackEnabledViaUi: true, pairingCodeVisibleOnce: true, pairingCodeGoneOnReopen: codeGoneOnReopen, loopbackDisabledViaUi: true, projectSettingsAToBRouteAndReopen: routeSwitchOk, projectBAttributeSavedAndReopened: true, projectAUnchanged }, interactionGate: '其它场景仍以正式命令、反馈、刷新重开另测', visualGate: '人工对照布局与数据密度；加载中或仅色相不算通过' };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ pairs: shots.length, out, dataRoot, realCalls }));
}
main().then(() => { cleanup(); }).catch((e) => { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'failure.txt'), String(e.stack || e)); console.error(e); cleanup(); process.exitCode = 1; });
