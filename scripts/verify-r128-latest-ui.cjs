#!/usr/bin/env node
/**
 * R128 isolated UI regression for sidebar task marks, latest-message reading,
 * and quote-chip deletion. It uses a hidden Electron window, a unique CDP port,
 * a temporary profile, and synthetic in-memory data. It starts no dev server,
 * calls no business model, and reads/writes no user runtime data.
 */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { build } = require('esbuild');

const repo = path.resolve(__dirname, '..');
const cdpPort = Number(process.env.ZS_R128_CDP_PORT || 9488);
const outArg = process.argv.indexOf('--out');
const outDir = path.resolve(outArg > 0 && process.argv[outArg + 1]
  ? process.argv[outArg + 1]
  : path.join(repo, 'dist', 'r128-feedback', `ui-check-${cdpPort}`));
fs.mkdirSync(outDir, { recursive: true });

function electronExecutable() {
  try {
    const resolved = require('electron');
    if (typeof resolved === 'string' && fs.existsSync(resolved)) return resolved;
  } catch { /* fall through */ }
  const pathFile = path.join(repo, 'node_modules', 'electron', 'path.txt');
  const name = fs.readFileSync(pathFile, 'utf8').trim();
  return path.join(repo, 'node_modules', 'electron', 'dist', name);
}

const slash = (value) => value.replace(/\\/g, '/');
const stylePaths = ['tokens.css', 'base.css', 'components.css', 'preview.css', 'titlebar.css']
  .map((name) => slash(path.join(repo, 'src', 'ui', 'hifi', 'styles', name)));
const composerPath = slash(path.join(repo, 'src', 'ui', 'hifi', 'components', 'Composer.tsx'));
const messagePath = slash(path.join(repo, 'src', 'ui', 'hifi', 'components', 'MessageView.tsx'));
const navMarksPath = slash(path.join(repo, 'src', 'ui', 'hifi', 'components', 'NavMarks.tsx'));
const storePath = slash(path.join(repo, 'src', 'ui', 'hifi', 'data', 'store.ts'));

const harness = String.raw`
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
${stylePaths.map((stylePath) => `import '${stylePath}';`).join('\n')}
import { Composer } from '${composerPath}';
import { latestReadableAgentMessageId, MessageView } from '${messagePath}';
import { NavTaskMark } from '${navMarksPath}';
import {
  addConversationQuoteToDraft, getDraftFull, getState, setDraftFull, setState,
} from '${storePath}';

declare global {
  interface Window {
    __r128: {
      snapshot: () => unknown;
      point: (selector: string) => { x: number; y: number } | null;
    };
    __r128Submits: number;
  }
}

const draftKey = 'thread:r128';
const member = {
  id: 'm1', projectId: 'p1', profileId: 'profile_m1', displayName: '成员甲', ordinal: 1,
  enabled: true, principalType: 'agent', workState: 'idle', workStateReason: '',
  model: 'fixture', effort: 'medium', internalSubagents: false, isCoordinatorDefault: true,
};
const room = {
  id: 'r1', projectId: 'p1', name: '最新问句房间', conversationId: 'c1',
  coordinatorMemberId: 'm1', memberIds: ['m1'], revision: 1, unread: 0,
};
const historyMessage = {
  id: 'history-ai', projectId: 'p1', roomId: 'r1', threadId: 't1',
  threadMessageSeq: 1, authorType: 'agent', authorId: 'm1', kind: 'text',
  body: Array.from({ length: 18 }, (_, index) => '历史 ' + (index + 1) + '／18：这条较早的长回复应保持可折叠。').join('\n'),
  createdAt: 1760000000000,
};
const latestMessage = {
  id: 'latest-ai', projectId: 'p1', roomId: 'r1', threadId: 't1',
  threadMessageSeq: 2, authorType: 'agent', authorId: 'm1', kind: 'text',
  body: [
    '请先确认下面这个待处理问题，再继续执行：',
    'R128_LATEST_QUESTION_VISIBLE',
    ...Array.from({ length: 16 }, (_, index) => '确认项 ' + (index + 1) + '：采用方案甲，或补充新的核验依据。'),
  ].join('\n'),
  delivery: {
    status: 'needs_user',
    question: '请确认采用方案甲，还是提供新的核验依据。',
  },
  createdAt: 1760000001000,
};
const laterSystem = {
  id: 'later-system', projectId: 'p1', roomId: 'r1', threadId: 't1',
  threadMessageSeq: 3, authorType: 'system', authorId: 'system', kind: 'system',
  body: '后台运行状态通知', createdAt: 1760000002000,
  payload: { system: { tone: 'info', title: '系统通知', body: '这条后续通知不应抢走最新 AI 问句的展开状态。' } },
};
const renderedMessages = [historyMessage, latestMessage, laterSystem];
const latestReadableId = latestReadableAgentMessageId(renderedMessages);
if (latestReadableId !== 'latest-ai') throw new Error('latest readable AI selection mismatch');

window.__r128Submits = 0;
window.zs = {
  command: async (envelope) => envelope.method === 'app.settings.get'
    ? { ok: true, data: { values: {} } }
    : { ok: false, error: { code: 'FIXTURE_ONLY', message: 'synthetic R128 fixture' } },
};
setState((state) => ({
  ...state,
  activeProjectId: 'p1',
  boot: 'ready',
  members: [member],
  rooms: [room],
  threads: [{
    id: 't1', projectId: 'p1', roomId: 'r1', conversationId: 'c1',
    anchorMessageId: 'root', rootTaskId: null, status: 'open', lastMessageSeq: 3, revision: 1,
  }],
  threadMemberships: {
    t1: {
      projectId: 'p1', threadId: 't1', roomId: 'r1', version: 'v1',
      memberIds: ['m1'], eligibleMemberIds: ['m1'], runningMemberIds: [],
    },
  },
  memberRuntimes: { m1: { status: 'bound', kind: 'fake', model: 'fixture' } },
  profiles: [], runtimeInstallations: [],
  drafts: {}, pendingSends: {}, outboundLedger: {}, lastSendReferences: {},
  uploadItems: {}, dispatchGuard: { fakeAllowed: true, realDispatchGuard: true },
}));
setDraftFull(draftKey, {
  body: '保留这段正文', mentions: [], attachments: [], access: 'default', sendAs: 'ai',
});
const firstQuote = addConversationQuoteToDraft(draftKey, {
  messageId: 'q1', authorLabel: '成员甲', threadMessageSeq: 7, text: '第一条待删除引用',
});
const secondQuote = addConversationQuoteToDraft(draftKey, {
  messageId: 'q2', authorLabel: '成员乙', threadMessageSeq: 8, text: '第二条待删除引用',
});
if (!firstQuote.ok || !secondQuote.ok) throw new Error('quote fixture setup failed');

function App() {
  return createElement('div', { className: 'r128-shell' },
    createElement('aside', { className: 'sidebar r128-sidebar' },
      createElement('div', { className: 'side-heading' }, '项目'),
      createElement('div', { className: 'side-project' },
        createElement('div', { className: 'r128-room-label' }, '示例项目'),
        createElement('button', { id: 'blocked-room', className: 'side-item sub' },
          createElement(NavTaskMark, {
            summary: { state: 'BLOCKED', counts: [{ state: 'BLOCKED', count: 1 }], total: 1 },
            where: '受阻房间', size: 12,
          }),
          createElement('span', { className: 'side-item-label' }, '受阻房间'),
        ),
        createElement('button', { id: 'active-room', className: 'side-item sub active' },
          createElement(NavTaskMark, {
            summary: { state: 'ACTIVE', counts: [{ state: 'ACTIVE', count: 1 }], total: 1 },
            where: '运行房间', size: 12,
          }),
          createElement('span', { className: 'side-item-label' }, '运行房间'),
        ),
        createElement('button', { id: 'review-room', className: 'side-item sub' },
          createElement(NavTaskMark, {
            summary: { state: 'REVIEW', counts: [{ state: 'REVIEW', count: 1 }], total: 1 },
            where: '待验收房间', size: 12,
          }),
          createElement('span', { className: 'side-item-label' }, '待验收房间'),
        ),
        createElement('button', { id: 'idle-room', className: 'side-item sub' },
          createElement('span', {
            id: 'idle-slot',
            className: 'side-icon-slot',
            'aria-hidden': true,
          }, createElement(NavTaskMark, {
            summary: { state: undefined, counts: [], total: 0 }, where: '空闲房间', size: 12,
          })),
          createElement('span', { className: 'side-item-label' }, '空闲房间'),
        ),
      ),
    ),
    createElement('main', { className: 'r128-main' },
      createElement('div', { className: 'r128-page-title' }, '最新消息与引用操作'),
      createElement('div', { className: 'msg-list is-replies r128-messages' },
        createElement('div', { id: 'history-row', className: 'msg-item' },
          createElement(MessageView, {
            message: historyMessage, author: member, readingAids: true, forceExpanded: false,
          }),
        ),
        createElement('div', { id: 'latest-row', className: 'msg-item' },
          createElement(MessageView, {
            message: latestMessage, author: member, readingAids: true,
            forceExpanded: latestMessage.id === latestReadableId,
          }),
        ),
        createElement('div', { id: 'system-row', className: 'msg-item' },
          createElement(MessageView, {
            message: laterSystem, readingAids: true, forceExpanded: false,
          }),
        ),
      ),
      createElement('form', {
        id: 'r128-form',
        onSubmit: (event) => {
          event.preventDefault();
          window.__r128Submits += 1;
        },
      }, createElement(Composer, {
        target: { kind: 'thread', roomId: 'r1', threadId: 't1' },
        draftKey,
        onSend: async () => ({ status: 'failed', error: 'synthetic fixture does not send' }),
      })),
    ),
  );
}

function center(selector: string) {
  const element = document.querySelector(selector);
  if (element == null) return null;
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

window.__r128 = {
  point: center,
  snapshot: () => {
    const history = document.querySelector('#history-row .msg');
    const latest = document.querySelector('#latest-row .msg');
    const blocked = document.querySelector('#blocked-room .side-state');
    const active = document.querySelector('#active-room .side-state');
    const review = document.querySelector('#review-room .side-state');
    const idleSlot = document.querySelector('#idle-slot');
    const remove = document.querySelector('[data-zs-conversation-quote-remove-all]');
    const draft = getDraftFull(draftKey);
    return {
      historyFolded: history?.querySelector('.msg-fold.is-folded') != null,
      historyHasExpand: history?.textContent?.includes('展开全文') === true,
      latestMode: latest?.getAttribute('data-zs-reading-mode') || '',
      latestFolded: latest?.querySelector('.msg-fold.is-folded') != null,
      latestHasExpand: latest?.textContent?.includes('展开全文') === true,
      latestQuestionVisible: latest?.textContent?.includes('R128_LATEST_QUESTION_VISIBLE') === true,
      deliveryQuestionVisible: latest?.textContent?.includes('请确认采用方案甲，还是提供新的核验依据。') === true,
      latestId: latestReadableId,
      blockedState: blocked?.getAttribute('data-zs-nav-task-state') || '',
      blockedColor: blocked == null ? '' : getComputedStyle(blocked).color,
      blockedIcon: blocked?.querySelector('svg')?.getAttribute('data-icon') || '',
      activeState: active?.getAttribute('data-zs-nav-task-state') || '',
      activeColor: active == null ? '' : getComputedStyle(active).color,
      activeIcon: active?.querySelector('svg')?.getAttribute('data-icon') || '',
      activeAnimation: active == null ? '' : getComputedStyle(active).animationName,
      reviewState: review?.getAttribute('data-zs-nav-task-state') || '',
      reviewColor: review == null ? '' : getComputedStyle(review).color,
      reviewIcon: review?.querySelector('svg')?.getAttribute('data-icon') || '',
      idleHasMarker: idleSlot?.querySelector('.side-state') != null,
      idleSlotWidth: idleSlot?.getBoundingClientRect().width || 0,
      quoteCount: Number(document.querySelector('[data-zs-conversation-quote-count]')
        ?.getAttribute('data-zs-conversation-quote-count') || 0),
      draftQuoteCount: draft.conversationQuotes?.length || 0,
      draftBody: draft.body,
      removeLabel: remove?.getAttribute('aria-label') || '',
      removeType: remove?.getAttribute('type') || '',
      popoverOpen: document.querySelector('[data-zs-conversation-quote-popover]') != null,
      submits: window.__r128Submits,
      hash: window.location.hash,
    };
  },
};

createRoot(document.getElementById('root')).render(createElement(App));
`;

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolve(message.result);
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }
}

async function until(read, accepted, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accepted(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} timeout: ${JSON.stringify(last)}`);
}

async function connect() {
  const page = await until(async () => {
    try {
      const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
        signal: AbortSignal.timeout(1000),
      }).then((response) => response.json());
      return targets.find((target) => target.type === 'page' && target.url.includes('index.html'));
    } catch {
      return null;
    }
  }, Boolean, 'CDP');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return new Cdp(ws);
}

async function main() {
  await build({
    stdin: { contents: harness, loader: 'tsx', resolveDir: repo, sourcefile: 'r128-harness.tsx' },
    outfile: path.join(outDir, 'bundle.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
  });
  fs.writeFileSync(path.join(outDir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><style>'
    + 'html,body,#root{margin:0;min-height:100%;background:var(--bg-app);color:var(--text)}'
    + '.r128-shell{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:100vh}'
    + '.r128-sidebar{padding:12px 8px;border-right:1px solid var(--border);background:var(--bg-app)}'
    + '.r128-room-label{padding:7px 8px;color:var(--text-2);font-weight:600}'
    + '.r128-main{min-width:0;padding:18px 24px 28px}.r128-page-title{font-size:18px;font-weight:700;margin:0 0 12px}'
    + '.r128-messages{max-width:790px;overflow:visible}.r128-messages .msg{max-width:790px}'
    + '.r128-main form{margin-top:14px;max-width:790px}.composer{margin:0}'
    + '.composer-box{max-width:790px}'
    + '</style></head><body><div id="root"></div><script src="bundle.js"></script></body></html>');
  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ name: 'zs-r128-latest-ui', version: '0.0.0', main: 'main.cjs' }));
  const overviewPath = path.join(outDir, 'r128-feedback-overview.png');
  const quoteHoverPath = path.join(outDir, 'r128-quote-hover.png');
  const afterDeletePath = path.join(outDir, 'r128-after-delete.png');
  fs.writeFileSync(path.join(outDir, 'main.cjs'), String.raw`
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.disableHardwareAcceleration();
app.setPath('userData', path.join(__dirname, 'profile'));
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1000, height: 760, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
  });
  window.loadFile(path.join(__dirname, 'index.html'));
  window.on('closed', () => app.quit());
  let capturing = false;
  const captured = { overview: false, hover: false, afterDelete: false };
  window.webContents.on('did-finish-load', () => {
    const timer = setInterval(async () => {
      if (capturing) return;
      capturing = true;
      try {
        const state = await window.webContents.executeJavaScript('window.__r128?.snapshot?.()');
        if (state == null) return;
        let target = null;
        if (!captured.overview && state.quoteCount === 2 && state.latestMode === 'latest-expanded') {
          target = ['overview', ${JSON.stringify(overviewPath)}];
        } else if (!captured.hover && state.popoverOpen === true) {
          target = ['hover', ${JSON.stringify(quoteHoverPath)}];
        } else if (!captured.afterDelete && state.quoteCount === 0) {
          target = ['afterDelete', ${JSON.stringify(afterDeletePath)}];
        }
        if (target == null) return;
        const [phase, file] = target;
        await new Promise((resolve) => setTimeout(resolve, phase === 'overview' ? 80 : 140));
        const image = await window.webContents.capturePage({ x: 0, y: 0, width: 1000, height: 760 });
        fs.writeFileSync(file, image.toPNG());
        captured[phase] = true;
        if (captured.overview && captured.hover && captured.afterDelete) clearInterval(timer);
      } catch (error) {
        fs.writeFileSync(path.join(__dirname, 'capture-error.json'), JSON.stringify({
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : null,
        }, null, 2));
      } finally {
        capturing = false;
      }
    }, 80);
  });
});
app.on('window-all-closed', () => app.quit());
`);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronExecutable(), [`--remote-debugging-port=${cdpPort}`, outDir], {
    cwd: outDir,
    env,
    windowsHide: true,
    stdio: 'ignore',
  });
  let cdp = null;
  const checks = [];
  try {
    cdp = await connect();
    await until(() => cdp.eval('typeof window.__r128 === "object"'), Boolean, 'harness');
    await cdp.send('Page.enable');
    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    const initial = await until(
      () => cdp.eval('window.__r128.snapshot()'),
      (value) => value.quoteCount === 2 && value.latestMode === 'latest-expanded',
      'initial R128 UI',
    );
    checks.push({
      name: 'blocked_octagon_and_static_active_play_use_project_accent',
      ok: initial.blockedState === 'BLOCKED'
        && initial.blockedIcon === 'octagon'
        && initial.blockedColor === 'rgb(37, 99, 235)'
        && initial.activeState === 'ACTIVE'
        && initial.activeIcon === 'play'
        && initial.activeColor === 'rgb(37, 99, 235)'
        && initial.activeAnimation === 'none'
        && initial.idleHasMarker === false
        && initial.idleSlotWidth === 13,
      detail: initial,
    });
    checks.push({
      name: 'review_eye_keeps_original_alert_semantics',
      ok: initial.reviewState === 'REVIEW'
        && initial.reviewIcon === 'eye'
        && initial.reviewColor === 'rgb(181, 71, 8)',
      detail: initial,
    });
    checks.push({
      name: 'only_latest_readable_ai_message_is_forced_open',
      ok: initial.historyFolded === true
        && initial.historyHasExpand === true
        && initial.latestMode === 'latest-expanded'
        && initial.latestFolded === false
        && initial.latestHasExpand === false
        && initial.latestQuestionVisible === true
        && initial.deliveryQuestionVisible === true
        && initial.latestId === 'latest-ai',
      detail: initial,
    });
    checks.push({
      name: 'quote_group_has_persistent_clear_accessible_label',
      ok: initial.quoteCount === 2
        && initial.draftQuoteCount === 2
        && initial.removeLabel === '删除全部 2 条对话引用'
        && initial.removeType === 'button'
        && initial.popoverOpen === false
        && initial.submits === 0,
      detail: initial,
    });
    await until(() => fs.existsSync(overviewPath), Boolean, 'native overview capture');

    await cdp.eval(`document.querySelector('.composer-quote-summary')?.scrollIntoView({ block: 'center' });true`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const summaryPoint = await cdp.eval(`window.__r128.point('.composer-quote-summary')`);
    if (summaryPoint == null) throw new Error('quote summary point missing');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: summaryPoint.x, y: summaryPoint.y });
    const hovered = await until(
      () => cdp.eval('window.__r128.snapshot()'),
      (value) => value.popoverOpen === true,
      'quote hover popover',
    );
    checks.push({
      name: 'chip_hover_still_opens_quote_details',
      ok: hovered.popoverOpen === true
        && hovered.quoteCount === 2
        && hovered.submits === 0,
      detail: hovered,
    });
    await until(() => fs.existsSync(quoteHoverPath), Boolean, 'native quote hover capture');

    const removePoint = await cdp.eval(`window.__r128.point('[data-zs-conversation-quote-remove-all]')`);
    if (removePoint == null) throw new Error('quote remove point missing');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: removePoint.x, y: removePoint.y });
    await until(
      () => cdp.eval('window.__r128.snapshot()'),
      (value) => value.popoverOpen === false,
      'moving to remove closes details',
    );
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: removePoint.x, y: removePoint.y, button: 'left', clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: removePoint.x, y: removePoint.y, button: 'left', clickCount: 1,
    });
    const deleted = await until(
      () => cdp.eval('window.__r128.snapshot()'),
      (value) => value.quoteCount === 0,
      'direct quote group deletion',
    );
    checks.push({
      name: 'direct_clear_removes_all_quotes_without_popover_or_submit',
      ok: deleted.quoteCount === 0
        && deleted.draftQuoteCount === 0
        && deleted.draftBody === '保留这段正文'
        && deleted.popoverOpen === false
        && deleted.submits === 0,
      detail: deleted,
    });
    await until(() => fs.existsSync(afterDeletePath), Boolean, 'native after-delete capture');

    await cdp.eval('window.close();true');
  } finally {
    if (cdp) cdp.ws.close();
    child.kill();
  }

  const result = {
    ok: checks.every((check) => check.ok),
    checks,
    cdpPort,
    output: outDir,
    screenshots: {
      overview: overviewPath,
      quoteHover: quoteHoverPath,
      afterDelete: afterDeletePath,
    },
    syntheticData: true,
    hiddenElectron: true,
    realModelCalls: 0,
  };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  const result = {
    ok: false,
    error: error instanceof Error ? error.stack : String(error),
    cdpPort,
    output: outDir,
    syntheticData: true,
    realModelCalls: 0,
  };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
});
