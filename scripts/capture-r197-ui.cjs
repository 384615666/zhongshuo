/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/**
 * R197 图片/通知反馈的隔离验收（隔离数据 + 假运行时 + 真实 daemon；零真实模型、不安装）。
 *
 * 覆盖（用户 2026-11-08 第 5 轮反馈）：
 *  1) 图片-only 本人消息气泡贴合图片（顶部内边距 ≤6px，不再空一大截）
 *  2) 引用含图片的消息 → 引用文本带图片**绝对路径**（且该路径真实存在）
 *  3) 复制含图片的消息 → 剪贴板文本带图片绝对路径（不再只有文件名）
 *  4) Windows 通知图标：品牌 ICO 改为传统 DIB 帧（不再 PNG-in-ICO），系统身份图标可读
 *  5) 消息内图片右键 → 复制图片 / 复制图片路径；共享预览图片右键 → 复制图片
 *
 * 用法：node scripts/capture-r197-ui.cjs [--run=name]
 * 产物：dist/r197-ui/<run>/（截图 + result.json + summary.json + 日志）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const runArg = process.argv.find((a) => a.startsWith('--run='));
const runName = runArg == null
  ? 'run-' + new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  : runArg.slice(6).replace(/[^A-Za-z0-9._-]/g, '');
const run = path.join(root, 'dist', 'r197-ui', runName);
const data = path.join(run, 'data');
const workspace = path.join(os.tmpdir(), 'zs-r197-workspace', runName);
const project = path.join(workspace, '读书会筹备');
fs.rmSync(run, { recursive: true, force: true });
fs.rmSync(data, { recursive: true, force: true });
fs.rmSync(workspace, { recursive: true, force: true });
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });

const mainCjs = path.join(root, 'dist', 'ui', 'main.cjs');
if (!fs.existsSync(mainCjs)) { console.error('缺少 dist/ui/main.cjs：请先运行 node scripts/build-ui.mjs'); process.exit(2); }

const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('ZS_')) delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  ZS_APP_DATA: data,
  ZS_RUNTIME: 'fake',
  ZS_ALLOW_FAKE: '1',
  ZS_REAL_DISPATCH_GUARD: '1',
  ZS_PIPE_NAME: '\\\\.\\pipe\\zs-r197-' + randomUUID(),
  ZS_DAEMON_ENTRY: path.join(root, 'dist', 'pack', 'daemon.cjs'),
  ZS_PACKAGED_UI: '1',
  ZS_NODE_BIN: process.execPath,
});

const scenesSource = String.raw`(() => {
  const m = window.r197Meta;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (check, label, timeout) => {
    const end = Date.now() + (timeout || 30000);
    while (Date.now() < end) { let ok = false; try { ok = !!check(); } catch { ok = false; } if (ok) return; await wait(80); }
    throw Error('等待超时：' + (label || ''));
  };
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => Array.from(document.querySelectorAll(sel));
  const textOf = (el) => (el == null ? '' : (el.textContent || '').replace(/\s+/g, ' ').trim());
  const go = async (route) => { window.location.hash = '#' + route; await wait(1100); };
  const rect = (el) => { if (el == null) return null; const r = el.getBoundingClientRect(); return { top: +r.top.toFixed(1), left: +r.left.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  const near = (a, b, t = 1.5) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= t;
  const toastText = () => textOf(q('[data-zs-toast], .toast, .toast-stack'));
  const threadRoute = '/thread/' + m.chat.threadId;
  const roomRoute = '/project/' + m.projectId + '/room/' + m.roomId;

  /** 在图片-only 消息里找到本人气泡（data-zs-image-only）。 */
  const imageOnlyBubble = () => q('.msg-list.is-replies .msg.msg-human [data-zs-image-only="1"], .msg-list.is-replies .msg.msg-human .msg-human-bubble[data-zs-image-only="1"]');

  async function waitThread() {    await go(threadRoute);
    await until(() => q('.msg-list.is-replies'), '回复串', 30000);
    await wait(1500);
    await until(() => q('[data-zs-message-image="ready"]'), '图片缩略图', 25000);
  }

  /** 1) 图片-only 气泡贴合 + 私信同类检查。 */
  window.stepGap = async () => {
    checks.length = 0;
    const extra = {};
    await waitThread();
    const bubble = imageOnlyBubble();
    const tile = bubble?.querySelector('[data-zs-message-image="ready"]');
    const img = tile?.querySelector('img') ?? tile;
    const style = bubble == null ? null : getComputedStyle(bubble);
    const grid = bubble?.querySelector('.msg-image-grid');
    const gridStyle = grid == null ? null : getComputedStyle(grid);
    extra.threadBubble = { box: rect(bubble), img: rect(img), padding: style == null ? null : [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft], gridMarginTop: gridStyle == null ? null : gridStyle.marginTop, imageOnly: bubble != null };
    check('对话串图片-only 本人气泡存在且标记 data-zs-image-only', bubble != null, extra.threadBubble);
    check('气泡顶部内边距 ≤6px（不再空出一大截）', style != null && parseFloat(style.paddingTop) <= 6, style?.paddingTop);
    check('图片网格不再额外留上边距', gridStyle != null && (parseFloat(gridStyle.marginTop) === 0 || gridStyle.marginTop === '0px'), gridStyle?.marginTop);
    check('图片紧贴气泡（图片顶 - 气泡顶 ≤8px）', rect(bubble) != null && rect(img) != null && rect(img).top - rect(bubble).top <= 8,
      rect(bubble) == null || rect(img) == null ? null : +(rect(img).top - rect(bubble).top).toFixed(1));
    check('图片仍真实渲染（<img> 已解码且宽 ≥96px）', img != null && img.tagName === 'IMG' && img.naturalWidth > 0 && rect(img).w >= 96, rect(img));

    await go('/dm/' + m.dm);
    await until(() => q('.msg-list.is-replies'), '私信', 30000);
    await wait(1400);
    const dmBubble = q('.msg-list.is-replies .msg.msg-human [data-zs-image-only="1"]');
    const dmStyle = dmBubble == null ? null : getComputedStyle(dmBubble);
    extra.dmBubble = { box: rect(dmBubble), paddingTop: dmStyle?.paddingTop ?? null };
    check('私信图片-only 气泡同样贴合（内边距 ≤6px）', dmStyle != null && parseFloat(dmStyle.paddingTop) <= 6, dmStyle?.paddingTop);
    await waitThread();
    return { ok: checks.every((c) => c.ok), checks, extra };
  };

  /** 3) 复制含图片消息 → 剪贴板带绝对路径。 */
  window.stepCopyMessage = async () => {
    checks.length = 0;
    await waitThread();
    const bubble = imageOnlyBubble();
    const message = bubble?.closest('.msg');
    const copyButton = Array.from(message?.querySelectorAll('.msg-actions button') ?? []).find((b) => textOf(b).includes('复制'));
    if (copyButton == null) throw Error('找不到复制按钮');
    copyButton.click();
    await wait(600);
    return { ok: true, checks, extra: { clicked: true, clipboardExpect: 'text' } };
  };

  /** 5) 消息图片右键菜单：先只打开（供截图），再由下一步点击复制。 */
  window.stepOpenImageMenu = async () => {
    checks.length = 0;
    await waitThread();
    const tile = q('.msg-list.is-replies [data-zs-message-image="ready"]:not(.msg-image-tile)') ?? q('.msg-list.is-replies .msg-image-tile [data-zs-message-image="ready"]');
    const button = tile?.closest('.msg-image-tile') ?? tile?.closest('[data-zs-message-image-open]');
    if (button == null) throw Error('找不到图片缩略图按钮');
    const box = rect(button);
    button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.right - 8, clientY: box.top + 12 }));
    await until(() => q('[data-zs-copy-image]'), '图片右键菜单', 8000);
    check('消息图片右键出现菜单', q('[data-zs-image-menu]') != null, textOf(q('[data-zs-image-menu]')).slice(0, 80));
    return { ok: true, checks, extra: { clipboardExpect: 'none' } };
  };

  window.stepClickImageCopy = async () => {
    const copyItem = q('[data-zs-copy-image]');
    const copyButton = copyItem?.querySelector('button') ?? copyItem;
    copyButton.click();
    await wait(700);
    return { ok: true, checks, extra: { clipboardExpect: 'image' } };
  };

  window.stepCopyPathMenu = async () => {
    checks.length = 0;
    await waitThread();
    const tile = q('.msg-list.is-replies .msg-image-tile [data-zs-message-image="ready"]');
    const button = tile?.closest('.msg-image-tile');
    if (button == null) throw Error('找不到图片缩略图按钮');
    const box = rect(button);
    button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.right - 8, clientY: box.top + 12 }));
    await until(() => q('[data-zs-copy-image-path]'), '图片右键菜单（路径）', 8000);
    const pathItem = q('[data-zs-copy-image-path]');
    const pathButton = pathItem?.querySelector('button') ?? pathItem;
    pathButton.click();
    await wait(700);
    return { ok: true, checks, extra: { clipboardExpect: 'text' } };
  };

  /** 2) 引用含图片消息 → 引用文本带绝对路径。 */
  window.stepQuote = async () => {
    checks.length = 0;
    await waitThread();
    const bubble = imageOnlyBubble();
    const message = bubble?.closest('.msg');
    const quoteButton = Array.from(message?.querySelectorAll('.msg-actions button') ?? []).find((b) => textOf(b).includes('引用'));
    if (quoteButton == null) throw Error('找不到引用按钮');
    quoteButton.click();
    await until(() => q('.composer-quote-dock') != null || q('[data-zs-conversation-quote-count]') != null, '结构化引用卡', 12000);
    await wait(300);
    const summary = q('.composer-quote-summary');
    if (summary != null) { summary.click(); await until(() => qa('[data-zs-conversation-quote]').length > 0, '引用卡详情', 8000); }
    const quoteText = textOf(q('[data-zs-conversation-quote]') ?? q('.composer-quote-dock'));
    const match = quoteText.match(/[A-Za-z]:\\[^\s"'<>|]+/);
    const composer = q('.composer') ?? q('.composer-shell');
    return { ok: true, checks, extra: {
      quoteText: quoteText.slice(0, 400),
      imagePath: match == null ? null : match[0],
      composerBox: rect(composer),
      dockBox: rect(q('.composer-quote-dock')),
      popoverBox: rect(q('.composer-quote-popover')),
      clipboardExpect: 'none',
    } };
  };

  /** 5) 共享预览图片右键菜单：先只打开（供截图），再由下一步点击复制。 */
  window.stepOpenPreviewMenu = async () => {
    checks.length = 0;
    await waitThread();
    const tile = q('.msg-list.is-replies .msg-image-tile');
    if (tile == null) throw Error('找不到图片缩略图');
    tile.click();
    await until(() => q('[data-zs-image-preview]') != null, '共享预览图片', 25000);
    await wait(600);
    const stage = q('[data-zs-image-stage], .zs-image-viewport');
    const box = rect(stage);
    stage.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.left + box.w / 2, clientY: box.top + box.h / 2 }));
    await until(() => q('[data-zs-preview-image-menu]') != null, '预览图片右键菜单', 8000);
    check('预览图片右键出现菜单', q('[data-zs-preview-image-menu]') != null, textOf(q('[data-zs-preview-image-menu]')).slice(0, 80));
    await wait(200);
    const menu = q('.menu');
    const menuStyle = menu == null ? null : getComputedStyle(menu);
    const menuBox = rect(menu);
    const hit = menuBox == null ? null : document.elementFromPoint(menuBox.left + 12, menuBox.top + 12);
    const hitInMenu = hit != null && hit.closest('.menu') != null;
    check('预览图片右键菜单在可视层最上方（点击不被遮挡）', hitInMenu === true, { menuBox, menuStyle: menuStyle == null ? null : { display: menuStyle.display, visibility: menuStyle.visibility, opacity: menuStyle.opacity, zIndex: menuStyle.zIndex }, hit: hit == null ? null : hit.className });
    return { ok: true, checks, extra: { clipboardExpect: 'none', menuBox, hitInMenu } };
  };

  window.stepClickPreviewCopy = async () => {
    q('[data-zs-copy-image]').click();
    await wait(700);
    return { ok: true, checks, extra: { clipboardExpect: 'image' } };
  };

  /** 3) 房间主池图片消息复制也带绝对路径。 */
  window.stepRoomCopy = async () => {
    checks.length = 0;
    await go(roomRoute);
    await until(() => qa('.root-card').length > 0, '房间主池', 30000);
    await wait(1200);
    const card = qa('.root-card').find((c) => c.querySelector('[data-zs-room-card-image], [data-zs-message-image="ready"]'));
    if (card == null) throw Error('找不到带图片的房间卡片');
    const copyButton = Array.from(card.querySelectorAll('.root-card-actions-row button, .root-card-actions button')).find((b) => textOf(b).includes('复制'));
    if (copyButton == null) throw Error('找不到房间卡片复制按钮');
    copyButton.click();
    await wait(700);
    return { ok: true, checks, extra: { clipboardExpect: 'text' } };
  };

})();`;

const metaPath = path.join(data, 'guide-fixture.json');
const extraPath = path.join(data, 'r197-extra.json');

const wrapperSource = String.raw`const { app, BrowserWindow, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const MAIN = __MAIN__;
const SCENES = __SCENES__;
const OUT = __OUT__;
const META_PATH = __META__;
const EXTRA_PATH = __EXTRA__;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('browser-window-created', (_e, win) => {
  win.show = () => {};
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const shot = async (name) => {
      try { fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); } catch (e) { console.error('shot fail ' + name + ' ' + e); }
    };
    const ready = async () => {
      for (let i = 0; i < 200; i++) { if (await js('document.readyState === "complete" && document.body.innerText.length > 20')) break; await sleep(250); }
      await sleep(800);
      for (let i = 0; i < 200; i++) { if (await js('document.body.classList.contains("hifi-on")')) break; await sleep(250); }
      try { await js('document.head.insertAdjacentHTML("beforeend", "<style>*,*::before,*::after{animation:none !important;transition:none !important}</style>")'); } catch {}
    };
    const checks = [];
    const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
    /* Electron 44 起 main 侧 clipboard 走 W3C 异步 API：readText() 返回 Promise、无 readImage；
       图片用 read() 取 ClipboardItem 的 image/png Blob。 */
    const readClipText = async () => { try { return String((await clipboard.readText()) ?? ''); } catch { return ''; } };
    const readClipImageBytes = async () => {
      try {
        const items = await clipboard.read();
        for (const item of items ?? []) {
          if (Array.isArray(item.types) && item.types.includes('image/png')) {
            const blob = await item.getType('image/png');
            return blob != null && typeof blob.size === 'number' ? blob.size : 0;
          }
        }
      } catch { /* 读不到按 0 处理，由断言如实失败 */ }
      return 0;
    };
    const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
    const extra = JSON.parse(fs.readFileSync(EXTRA_PATH, 'utf8'));
    const basePath = (text) => { const hit = String(text || '').match(/[A-Za-z]:\\[^\s"'<>|]+/); return hit == null ? null : hit[0]; };
    try {
      win.setContentSize(1360, 900);
      await ready();
      await js('window.r197Meta = ' + JSON.stringify(meta));
      await js('window.r197Extra = ' + JSON.stringify(extra));
      await js(fs.readFileSync(SCENES, 'utf8'));

      // ── 1) 图片气泡贴合 ──
      const gap = await js('window.stepGap()');
      checks.push(...gap.checks);
      await js('window.location.hash = ' + JSON.stringify('#/thread/' + meta.chat.threadId));
      await sleep(1200);
      await shot('01-thread-image-only');

      // ── 3) 复制消息带路径 ──
      clipboard.clear();
      const copy = await js('window.stepCopyMessage()');
      await sleep(500);
      const copyText = await readClipText();
      check('复制含图片消息：剪贴板含图片绝对路径', /[A-Za-z]:\\[^\s]+\.(?:png|jpe?g|gif|webp|bmp)/i.test(copyText), copyText.slice(0, 300));
      const copyPath = basePath(copyText);
      check('复制出的图片路径真实存在', copyPath != null && fs.existsSync(copyPath), copyPath);
      await shot('02-copy-message-toast');

      // ── 5) 消息图片右键复制图片：先截菜单，再点复制并读剪贴板 ──
      clipboard.clear();
      const openImageMenu = await js('window.stepOpenImageMenu()');
      checks.push(...openImageMenu.checks);
      await sleep(400);
      await shot('03-image-context-menu');
      await js('window.stepClickImageCopy()');
      await sleep(500);
      const clipImageBytes = await readClipImageBytes();
      check('消息图片右键「复制图片」写入剪贴板图片', clipImageBytes > 0, clipImageBytes);

      // ── 5b) 右键复制图片路径 ──
      clipboard.clear();
      await js('window.stepCopyPathMenu()');
      await sleep(500);
      const pathText = await readClipText();
      const menuPath = basePath(pathText);
      check('消息图片右键「复制图片路径」剪贴板含绝对路径', /[A-Za-z]:\\/.test(pathText), pathText.slice(0, 260));
      check('右键复制出的图片路径真实存在', menuPath != null && fs.existsSync(menuPath), menuPath);

      // ── 2) 引用带图片绝对路径 ──
      const quote = await js('window.stepQuote()');
      checks.push(...quote.checks);
      check('引用文本含图片标记', String(quote.extra.quoteText || '').includes('[图片]'), quote.extra.quoteText);
      check('引用文本含图片绝对路径', quote.extra.imagePath != null && /^[A-Za-z]:\\/.test(quote.extra.imagePath), quote.extra.imagePath);
      check('引用里的图片路径真实存在', quote.extra.imagePath != null && fs.existsSync(quote.extra.imagePath), quote.extra.imagePath);
      await shot('04-quote-with-image-path');
      // 再把引用卡/气泡区域单独裁一张，便于核对路径文字与卡片布局。
      try {
        const boxes = [quote.extra.popoverBox, quote.extra.dockBox, quote.extra.composerBox].filter(Boolean);
        if (boxes.length > 0) {
          const left = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.left)) - 16));
          const top = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.top)) - 16));
          const right = Math.min(1360, Math.ceil(Math.max(...boxes.map((b) => b.right)) + 16));
          const bottom = Math.min(900, Math.ceil(Math.max(...boxes.map((b) => b.bottom)) + 16));
          fs.writeFileSync(path.join(OUT, '04b-quote-dock.png'), (await win.webContents.capturePage({ x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) })).toPNG());
        }
      } catch (e) { console.error('quote crop fail ' + e); }

      // ── 5c) 共享预览图片右键复制：先截菜单，再点复制 ──
      clipboard.clear();
      const openPreviewMenu = await js('window.stepOpenPreviewMenu()');
      checks.push(...openPreviewMenu.checks);
      await sleep(400);
      fs.writeFileSync(path.join(OUT, 'preview-menu-diag.json'), JSON.stringify(openPreviewMenu.extra, null, 2));
      await shot('05-preview-image-menu');
      await js('window.stepClickPreviewCopy()');
      await sleep(500);
      const previewImageBytes = await readClipImageBytes();
      check('预览图片右键「复制图片」写入剪贴板图片', previewImageBytes > 0, previewImageBytes);

      // ── 3b) 房间主池图片消息复制带路径 ──
      clipboard.clear();
      await js('window.stepRoomCopy()');
      await sleep(500);
      const roomText = await readClipText();
      const roomPath = basePath(roomText);
      check('房间主池图片消息复制：剪贴板含绝对路径', /[A-Za-z]:\\/.test(roomText), roomText.slice(0, 260));
      check('房间主池复制出的图片路径真实存在', roomPath != null && fs.existsSync(roomPath), roomPath);
      await shot('06-room-card-copy');

      const failed = checks.filter((c) => !c.ok).map((c) => c.name);
      fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ ok: failed.length === 0, checks, failed }, null, 2));
      console.log('R197_RESULT ' + JSON.stringify({ ok: failed.length === 0, checks: checks.length, failed }));
    } catch (e) {
      console.error('R197_FAIL ' + String((e && e.stack) || e));
      fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ ok: false, error: String((e && e.stack) || e), checks }, null, 2));
    }
    app.quit();
  });
});
require(MAIN);
setTimeout(() => { app.quit(); }, 600000).unref();`;

const scenesPath = path.join(run, 'r197-scenes.js');
fs.writeFileSync(scenesPath, scenesSource);
const wrapperPath = path.join(run, 'main.cjs');
fs.writeFileSync(wrapperPath, wrapperSource
  .replace('__MAIN__', JSON.stringify(mainCjs))
  .replace('__SCENES__', JSON.stringify(scenesPath))
  .replace('__META__', JSON.stringify(metaPath))
  .replace('__EXTRA__', JSON.stringify(extraPath))
  .replace('__OUT__', JSON.stringify(run)));

/** 通知图标格式检查（品牌 ICO 必须全部是传统 DIB 帧，不能再是 PNG-in-ICO）。 */
async function iconChecks() {
  const out = path.join(run, 'icon-checks.json');
  try {
    const { pathToFileURL } = require('node:url');
    const { brandIco } = await import(pathToFileURL(path.join(root, 'scripts', 'lib', 'brand-icon.mjs')).href);
    const bytes = brandIco();
    const count = bytes.readUInt16LE(4);
    const frames = [];
    for (let i = 0; i < count; i++) {
      const entry = 6 + 16 * i;
      const bytesInRes = bytes.readUInt32LE(entry + 8);
      const offset = bytes.readUInt32LE(entry + 12);
      const head = bytes.subarray(offset, offset + 4);
      const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
      const isDib = head.readUInt32LE(0) === 40;
      const bitCount = isDib ? bytes.readUInt16LE(offset + 14) : 0;
      const height = isDib ? bytes.readInt32LE(offset + 8) : 0;
      const width = isDib ? bytes.readInt32LE(offset + 4) : 0;
      frames.push({ bytesInRes, offset, isPng, isDib, bitCount, width, height });
    }
    const ok = count === 7 && frames.every((f) => f.isDib && !f.isPng && f.bitCount === 32 && f.height === f.width * 2);
    const result = { ok, count, bytes: bytes.length, frames };
    fs.writeFileSync(out, JSON.stringify(result, null, 2));
    return [
      { name: '品牌 ICO 含 7 帧', ok: count === 7, detail: count },
      { name: 'ICO 帧全部为传统 DIB（不是 PNG-in-ICO）', ok: frames.every((f) => f.isDib && !f.isPng), detail: frames.map((f) => ({ isPng: f.isPng, isDib: f.isDib })) },
      { name: 'ICO 帧 32bpp 且高度=2×宽（含 AND 掩码）', ok: frames.every((f) => f.bitCount === 32 && f.height === f.width * 2), detail: frames.map((f) => [f.width, f.height, f.bitCount]) },
    ];
  } catch (error) {
    fs.writeFileSync(out, JSON.stringify({ ok: false, error: String(error) }, null, 2));
    return [{ name: '通知品牌 ICO 可生成并校验', ok: false, detail: String(error) }];
  }
}

(async () => {
  try {
    await require('esbuild').build({
      entryPoints: [path.join(root, 'scripts', 'lib', 'r170-fixture.ts')],
      bundle: true, platform: 'node', format: 'cjs', packages: 'external',
      outfile: path.join(run, 'seed.cjs'), logLevel: 'silent',
    });
    const seeded = spawnSync(process.execPath, [path.join(run, 'seed.cjs'), data, project, '--r192'], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 240000 });
    fs.writeFileSync(path.join(run, 'seed.log'), (seeded.stdout || '') + '\n' + (seeded.stderr || ''));
    if (seeded.status !== 0) throw Error('隔离夹具装载失败：' + (seeded.stderr || seeded.stdout));

    await require('esbuild').build({
      entryPoints: [path.join(root, 'scripts', 'lib', 'r197-extra-images.ts')],
      bundle: true, platform: 'node', format: 'cjs', packages: 'external',
      outfile: path.join(run, 'seed-extra.cjs'), logLevel: 'silent',
    });
    const extraSeed = spawnSync(process.execPath, [path.join(run, 'seed-extra.cjs'), data], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 240000 });
    fs.writeFileSync(path.join(run, 'seed-extra.log'), (extraSeed.stdout || '') + '\n' + (extraSeed.stderr || ''));
    if (extraSeed.status !== 0) throw Error('图片-only 夹具装载失败：' + (extraSeed.stderr || extraSeed.stdout));
  } catch (error) {
    console.error(String(error));
    fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ ok: false, error: String(error) }, null, 2));
    process.exitCode = 1;
    return;
  }

  const electron = spawnSync(require('electron'), [wrapperPath], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 900000 });
  fs.writeFileSync(path.join(run, 'process.log'), (electron.stdout || '') + '\n' + (electron.stderr || ''));
  let result;
  try { result = JSON.parse(fs.readFileSync(path.join(run, 'result.json'), 'utf8')); } catch { result = { ok: false, error: '未产出 result.json（见 process.log）', checks: [] }; }
  const icon = await iconChecks();
  const allChecks = [...(result.checks || []), ...icon];
  const failed = allChecks.filter((c) => !c.ok).map((c) => c.name);
  const summary = {
    ok: electron.status === 0 && result.ok === true && failed.length === 0 && (result.error == null),
    processExit: electron.status,
    run: path.relative(root, run),
    checks: allChecks.length,
    failedChecks: Array.from(new Set([...(result.failed || []), ...failed])),
    error: result.error || null,
  };
  fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify({ ...summary, details: { ...result, iconChecks: icon } }, null, 2));
  console.log(JSON.stringify({ ok: summary.ok, processExit: summary.processExit, checks: summary.checks, failed: summary.failedChecks, error: summary.error }, null, 2));
  if (!summary.ok) process.exitCode = 1;
})();
