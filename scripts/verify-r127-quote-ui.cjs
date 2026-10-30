#!/usr/bin/env node
/**
 * R127 isolated UI regression: selected-text context menu, compact quote chip
 * with hover/focus popover, exact model body, and independent native polling.
 *
 * Uses a hidden Electron window, a unique CDP port, a temporary profile, and
 * synthetic in-memory data. It neither starts a shared dev server nor touches
 * the user's runtime data or models.
 */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { build } = require('esbuild');

const repo = path.resolve(__dirname, '..');
const cdpPort = Number(process.env.ZS_R127_CDP_PORT || 9477);
const expectedQuoteText = '选定文字必须完整进入引用卡';
const outArg = process.argv.indexOf('--out');
const outDir = path.resolve(outArg > 0 && process.argv[outArg + 1]
  ? process.argv[outArg + 1]
  : path.join(os.tmpdir(), `zs-r127-quote-ui-${cdpPort}`));
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
const composerPath = slash(path.join(repo, 'src', 'ui', 'hifi', 'components', 'Composer.tsx'));
const messagePath = slash(path.join(repo, 'src', 'ui', 'hifi', 'components', 'MessageView.tsx'));
const storePath = slash(path.join(repo, 'src', 'ui', 'hifi', 'data', 'store.ts'));
const stylePaths = ['tokens.css', 'base.css', 'components.css', 'preview.css', 'titlebar.css']
  .map((name) => slash(path.join(repo, 'src', 'ui', 'hifi', 'styles', name)));

const harness = String.raw`
import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
${stylePaths.map((stylePath) => `import '${stylePath}';`).join('\n')}
import { Composer } from '${composerPath}';
import { MessageView } from '${messagePath}';
import { NavUnreadDot } from '${slash(path.join(repo, 'src', 'ui', 'hifi', 'components', 'NavMarks.tsx'))}';
import { RootCard } from '${slash(path.join(repo, 'src', 'ui', 'hifi', 'pages', 'Room.tsx'))}';
import { hasUnread, roomUnread, unreadCount } from '${slash(path.join(repo, 'src', 'ui', 'hifi', 'data', 'selectors.ts'))}';
import { loadThread } from '${slash(path.join(repo, 'src', 'ui', 'hifi', 'loader.ts'))}';
import { TaskNotificationController } from '${slash(path.join(repo, 'src', 'ui', 'hifi', 'components', 'TaskNotificationController.tsx'))}';
import {
  addConversationQuoteToDraft, getDraftFull, getState, setDraftFull, setState, useStore,
} from '${storePath}';

const draftKey = 'thread:r127';
const quoteText = '选定文字必须完整进入引用卡';
const message = {
  id: 'msg_r127', projectId: 'p1', roomId: 'r1', threadId: 'r127',
  authorType: 'agent', authorId: 'm1', kind: 'text',
  body: quoteText + '，但绝不能进入可编辑正文。补充说明仍在同一条消息内。',
  createdAt: 1760000000000, threadMessageSeq: 9,
};
const rootMessage = {
  id: 'root_r127', projectId: 'p1', roomId: 'r1',
  authorType: 'human', authorId: 'you', kind: 'text',
  body: '未读水位主池根消息', createdAt: 1760000000000 - 1000,
};
const member = {
  id: 'm1', projectId: 'p1', profileId: 'profile_1', displayName: '成员甲', ordinal: 1,
  enabled: true, principalType: 'agent', workState: 'idle', workStateReason: '',
  model: 'fixture', effort: 'medium', internalSubagents: false, isCoordinatorDefault: false,
};

declare global {
  interface Window {
    __r127Copied: string;
    __r127PollCalls: number;
    __r127Shown: number;
    __r127ThreadGetResolved: boolean;
    __r127HistoryPending: boolean;
    __r127MarkPending: boolean;
    __r127Payload: { body: string; quoteIds: string[] } | null;
    zsTaskNotifications: {
      show: (notificationId: string) => Promise<{ ok: true; notificationId: string; state: string }>;
      onClick: () => () => void;
    };
    __r127: {
      openSelection: () => void;
      clickText: (text: string) => void;
      snapshot: () => unknown;
      copied: () => string;
      pollCalls: () => number;
      shown: () => number;
      unreadSnapshot: () => unknown;
      startHangingRead: () => boolean;
    };
  }
}

window.__r127Copied = '';
window.__r127PollCalls = 0;
window.__r127Shown = 0;
window.__r127ThreadGetResolved = false;
window.__r127HistoryPending = false;
window.__r127MarkPending = false;
window.__r127Payload = null;
window.location.hash = '#/project/p1/room/r1?thread=r127';
(window as unknown as { zs: { command: (envelope: { method: string }) => Promise<unknown> } }).zs = {
  command: async (envelope: { method: string }) => {
    if (envelope.method === 'taskNotification.poll') {
      window.__r127PollCalls += 1;
      const notificationId = 'ntf_' + 'b'.repeat(32);
      return {
        ok: true,
        data: {
          items: [{ notificationId }],
          scannedThroughSeq: 1,
          hasMore: false,
          health: { attempted: 0, showRequested: 0, shown: 0, unknown: 0, failed: 0, clicked: 0 },
          recentAttempts: [],
        },
      };
    }
    if (envelope.method === 'thread.get') {
      window.__r127ThreadGetResolved = true;
      return {
        ok: true,
        data: {
          thread: {
            id: 'r127', projectId: 'p1', conversationId: 'c1', roomId: 'r1',
            anchorMessageId: 'root_r127', rootTaskId: null, status: 'open',
            lastMessageSeq: 9, revision: 1,
          },
          anchor: { ...rootMessage, conversationSeq: 1, attachments: [] },
          lastReadSeq: 0,
        },
      };
    }
    if (envelope.method === 'thread.history') {
      window.__r127HistoryPending = true;
      return new Promise(() => {});
    }
    if (envelope.method === 'thread.markRead') {
      window.__r127MarkPending = true;
      return new Promise(() => {});
    }
    return envelope.method === 'app.settings.get'
      ? { ok: true, data: { values: {} } }
      : { ok: false, error: { code: 'FIXTURE_ONLY', message: 'fixture only' } };
  },
};
window.zsTaskNotifications = {
  show: async (notificationId: string) => {
    window.__r127Shown += 1;
    return { ok: true, notificationId, state: 'requested' };
  },
  onClick: () => () => {},
};
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      window.__r127Copied = text;
    },
  },
});
setState((state) => ({
  ...state,
  activeProjectId: 'p1',
  ui: { ...state.ui, activeThreadId: 'r127' },
  members: [member],
  messages: [rootMessage],
  threads: [{
    id: 'r127', projectId: 'p1', roomId: 'r1', conversationId: 'c1',
    anchorMessageId: 'root_r127', status: 'open', lastMessageSeq: 9, revision: 1,
  }],
  roomPool: {
    r1: [{
      threadId: 'r127', projectId: 'p1', roomId: 'r1', anchorMessageId: 'root_r127',
      lastMessageSeq: 9, taskId: null, taskStatus: null, roomTaskNumber: null,
      taskTitle: null, body: rootMessage.body, createdAt: rootMessage.createdAt,
      replyCount: 2, lastReplyAt: rootMessage.createdAt, unread: 2, muted: false, followed: false,
    }],
  },
  readStates: { r127: 0 },
  threadReadSeq: { r127: 0 },
  threadEntities: {},
  threadAnchors: {},
  threadMessages: {},
  threadTasks: {},
  rooms: [{
    id: 'r1', projectId: 'p1', name: 'R127', conversationId: 'c1',
    coordinatorMemberId: 'm1', memberIds: ['m1'], revision: 1, unread: 0,
  }],
  threadMemberships: {
    r127: {
      projectId: 'p1', threadId: 'r127', roomId: 'r1', version: 'v1',
      memberIds: ['m1'], eligibleMemberIds: ['m1'], runningMemberIds: [],
    },
  },
  uploadItems: {}, pendingSends: {}, readErrors: {}, threadProgress: {},
}));
setDraftFull(draftKey, {
  body: '请基于这段历史继续修改', mentions: [], attachments: [],
  access: 'default', sendAs: 'ai',
});

function UnreadProbe() {
  const state = useStore((current) => current);
  return createElement('div', {
    style: { position: 'absolute', left: '-10000px', top: 0 },
    'aria-hidden': true,
  },
    createElement('span', {
      className: 'side-marks',
      'data-zs-sidebar-unread-probe': '1',
    }, createElement(NavUnreadDot, {
      count: roomUnread(state, 'r1'),
      where: 'R127',
    })),
    createElement('div', {
      'data-zs-main-pool-unread-probe': '1',
    }, createElement(RootCard, {
      message: rootMessage,
      selected: false,
    })),
  );
}

function App() {
  const [insertQuote, setInsertQuote] = useState();
  const addQuote = (_message, selectedText) => {
    const added = addConversationQuoteToDraft(draftKey, {
      messageId: message.id,
      authorLabel: member.displayName,
      threadMessageSeq: message.threadMessageSeq,
      text: selectedText ?? message.body,
    });
    if (!added.ok) throw new Error(added.error);
    setInsertQuote({ id: Date.now(), quote: added.quote });
  };
  return createElement('div', null,
    createElement(TaskNotificationController, { intervalMs: 1000 }),
    createElement(UnreadProbe),
    createElement(MessageView, { message, author: member, onQuote: addQuote, onSave: () => {} }),
    createElement(Composer, {
      target: { kind: 'thread', roomId: 'r1', threadId: 'r127' },
      draftKey,
      insertQuote,
      onSend: async (payload) => {
        window.__r127Payload = payload;
        return { status: 'failed', error: 'fixture only' };
      },
    }),
  );
}

function textNodeContaining(needle) {
  const root = document.querySelector('.msg-text');
  if (!root) throw new Error('message text missing');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if ((node.textContent || '').includes(needle)) return node;
  }
  throw new Error('selection text missing');
}

window.__r127 = {
  openSelection: () => {
    const node = textNodeContaining(quoteText);
    const start = (node.textContent || '').indexOf(quoteText);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + quoteText.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.querySelector('.msg').dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 320, clientY: 240,
    }));
  },
  clickText: (label) => {
    const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.trim() === label);
    if (!button) throw new Error('button missing: ' + label);
    button.click();
  },
  snapshot: () => {
    const draft = getDraftFull(draftKey);
    const popover = document.querySelector('[data-zs-conversation-quote-popover]');
    const popoverRect = popover?.getBoundingClientRect();
    return {
      editorText: document.querySelector('.composer-editor')?.textContent || '',
      dockCount: Number(document.querySelector('[data-zs-conversation-quote-count]')?.getAttribute('data-zs-conversation-quote-count') || 0),
      cardText: document.querySelector('.composer-quote-text')?.textContent || '',
      source: document.querySelector('.composer-quote-source')?.textContent || '',
      expanded: document.querySelector('.composer-quote-summary')?.getAttribute('aria-expanded') || '',
      popoverOpen: popover != null,
      popoverRect: popoverRect == null ? null : {
        left: popoverRect.left, top: popoverRect.top, right: popoverRect.right, bottom: popoverRect.bottom,
      },
      quoteText: draft.conversationQuotes?.[0]?.text || '',
    };
  },
  copied: () => window.__r127Copied,
  pollCalls: () => window.__r127PollCalls,
  shown: () => window.__r127Shown,
  unreadSnapshot: () => ({
    threadCount: unreadCount(getState(), 'r127'),
    hasUnread: hasUnread(getState(), 'r127'),
    roomCount: roomUnread(getState(), 'r1'),
    readSeq: getState().readStates.r127 ?? 0,
    sidebarDot: document.querySelector('[data-zs-sidebar-unread-probe] .side-unread-dot') != null,
    sidebarLabel: document.querySelector('[data-zs-sidebar-unread-probe] .side-unread-dot')?.getAttribute('aria-label') || '',
    mainPoolUnread: (document.querySelector('[data-zs-main-pool-unread-probe]')?.textContent || '').includes('条未读'),
    threadGetResolved: window.__r127ThreadGetResolved,
    historyPending: window.__r127HistoryPending,
    markPending: window.__r127MarkPending,
  }),
  startHangingRead: () => {
    void loadThread('r127', {
      markRead: true,
      markReadOnOpen: true,
      readOpenGuard: () => true,
    });
    return true;
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
    stdin: { contents: harness, loader: 'tsx', resolveDir: repo, sourcefile: 'r127-harness.tsx' },
    outfile: path.join(outDir, 'bundle.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
  });
  fs.writeFileSync(path.join(outDir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><style>body{margin:24px}.composer{margin-top:24px;max-width:720px}</style></head><body><div id="root"></div><script src="bundle.js"></script></body></html>');
  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ name: 'zs-r127-quote-ui', version: '0.0.0', main: 'main.cjs' }));
  fs.writeFileSync(path.join(outDir, 'main.cjs'), String.raw`
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.setPath('userData', path.join(__dirname, 'profile'));
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1000, height: 760, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
  });
  window.loadFile(path.join(__dirname, 'index.html'));
  window.on('closed', () => app.quit());
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
  let compactScreenshotData;
  let hoverScreenshotData;
  const checks = [];
  try {
    cdp = await connect();
    await until(() => cdp.eval('typeof window.__r127 === "object"'), Boolean, 'harness');
    await cdp.send('Page.enable');
    const pollBefore = await cdp.eval('window.__r127.pollCalls()');
    const initialUnread = await until(
      () => cdp.eval('window.__r127.unreadSnapshot()'),
      (value) => value.threadCount === 2 && value.sidebarDot && value.mainPoolUnread,
      'initial pool unread DOM',
    );
    checks.push({
      name: 'pool_unread_is_visible_before_read',
      ok: initialUnread.roomCount === 2 && initialUnread.hasUnread === true,
      detail: initialUnread,
    });

    await cdp.eval('window.__r127.openSelection();true');
    await until(() => cdp.eval(`Array.from(document.querySelectorAll('.menu-item')).map((x)=>x.textContent.trim())`),
      (items) => items.includes('复制所选文字') && items.includes('引用到当前任务'), 'selection menu');
    checks.push({ name: 'context_menu_has_copy_quote', ok: true });

    await cdp.eval('window.__r127.clickText("复制所选文字");true');
    const copied = await until(() => cdp.eval('window.__r127.copied()'), (value) => value === expectedQuoteText, 'copy selection');
    checks.push({ name: 'copy_uses_exact_selection', ok: copied === expectedQuoteText, detail: copied });

    await cdp.eval('window.__r127.openSelection();true');
    await until(() => cdp.eval(`Array.from(document.querySelectorAll('.menu-item')).some((x)=>x.textContent.trim()==='引用到当前任务')`), Boolean, 'quote menu');
    await cdp.eval('window.__r127.clickText("引用到当前任务");true');
    await until(() => cdp.eval(`document.querySelector('[data-zs-conversation-quote-count]')?.getAttribute('data-zs-conversation-quote-count')`),
      (value) => value === '1', 'quote card');
    const snapshot = await cdp.eval('window.__r127.snapshot()');
    checks.push({ name: 'editor_keeps_user_text_only', ok: snapshot.editorText === '请基于这段历史继续修改', detail: snapshot.editorText });
    checks.push({
      name: 'default_shows_only_compact_chip',
      ok: snapshot.dockCount === 1 && snapshot.popoverOpen === false && snapshot.source === '' && snapshot.cardText === '',
      detail: snapshot,
    });
    checks.push({ name: 'draft_keeps_full_quote_for_model', ok: snapshot.quoteText === expectedQuoteText, detail: snapshot.quoteText });
    const compactShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    compactScreenshotData = compactShot.data;

    const chipPoint = await cdp.eval(`(()=>{const r=document.querySelector('.composer-quote-summary').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: chipPoint.x, y: chipPoint.y });
    await until(() => cdp.eval(`document.querySelector('[data-zs-conversation-quote-popover]') != null`), Boolean, 'hover quote popover');
    await new Promise((resolve) => setTimeout(resolve, 140));
    const hoverSnapshot = await cdp.eval('window.__r127.snapshot()');
    checks.push({
      name: 'hover_shows_source_and_quote_in_floating_popover',
      ok: hoverSnapshot.popoverOpen === true
        && hoverSnapshot.source === '成员甲 · #9'
        && hoverSnapshot.cardText === expectedQuoteText
        && hoverSnapshot.popoverRect.left >= 0
        && hoverSnapshot.popoverRect.top >= 0
        && hoverSnapshot.popoverRect.right <= 1000
        && hoverSnapshot.popoverRect.bottom <= 760,
      detail: hoverSnapshot,
    });
    checks.push({
      name: 'chip_exposes_expanded_state',
      ok: await cdp.eval(`document.querySelector('.composer-quote-summary')?.getAttribute('aria-expanded') === 'true'`),
    });
    checks.push({
      name: 'trigger_controls_the_instance_popover',
      ok: await cdp.eval(`document.querySelector('.composer-quote-summary')?.getAttribute('aria-controls') === document.querySelector('[data-zs-conversation-quote-popover]')?.id`),
    });
    const hoverShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    hoverScreenshotData = hoverShot.data;

    const popoverPoint = await cdp.eval(`(()=>{const r=document.querySelector('[data-zs-conversation-quote-popover]').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: popoverPoint.x, y: popoverPoint.y });
    await new Promise((resolve) => setTimeout(resolve, 180));
    checks.push({
      name: 'pointer_can_move_from_chip_into_popover',
      ok: await cdp.eval(`document.querySelector('[data-zs-conversation-quote-popover]') != null`),
    });

    await cdp.eval(`window.__r127Copied='';document.querySelector('[aria-label="复制引用 1"]').click();true`);
    const popoverCopied = await until(() => cdp.eval('window.__r127.copied()'), (value) => value === expectedQuoteText, 'popover copy');
    checks.push({ name: 'popover_copy_uses_exact_quote', ok: popoverCopied === expectedQuoteText, detail: popoverCopied });

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 520, height: 620, deviceScaleFactor: 1, mobile: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const resizedBounds = await cdp.eval(`(()=>{const r=document.querySelector('[data-zs-conversation-quote-popover]')?.getBoundingClientRect();return r?{left:r.left,top:r.top,right:r.right,bottom:r.bottom,innerWidth,innerHeight}:null})()`);
    checks.push({
      name: 'popover_stays_inside_resized_viewport',
      ok: resizedBounds != null
        && resizedBounds.left >= 7
        && resizedBounds.top >= 7
        && resizedBounds.right <= resizedBounds.innerWidth - 7
        && resizedBounds.bottom <= resizedBounds.innerHeight - 7,
      detail: resizedBounds,
    });
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await new Promise((resolve) => setTimeout(resolve, 120));

    await cdp.eval(`document.querySelector('[aria-label="移除引用 1"]').click();true`);
    const removed = await until(() => cdp.eval('window.__r127.snapshot()'), (value) => value.dockCount === 0, 'popover quote removal');
    checks.push({
      name: 'popover_removal_keeps_editor_text',
      ok: removed.editorText === '请基于这段历史继续修改' && removed.quoteText === '' && removed.popoverOpen === false,
      detail: removed,
    });

    await cdp.eval('window.__r127.openSelection();true');
    await until(() => cdp.eval(`Array.from(document.querySelectorAll('.menu-item')).some((x)=>x.textContent.trim()==='引用到当前任务')`), Boolean, 'second quote menu');
    await cdp.eval('window.__r127.clickText("引用到当前任务");true');
    await until(() => cdp.eval(`document.querySelector('[data-zs-conversation-quote-count]')?.getAttribute('data-zs-conversation-quote-count')`),
      (value) => value === '1', 'second compact quote chip');
    const readdedQuote = await cdp.eval('window.__r127.snapshot()');
    checks.push({
      name: 'readding_after_last_removal_starts_closed',
      ok: readdedQuote.dockCount === 1 && readdedQuote.popoverOpen === false && readdedQuote.expanded === 'false',
      detail: readdedQuote,
    });
    await cdp.eval(`document.querySelector('.composer-send').click();true`);
    const payload = await until(() => cdp.eval('window.__r127Payload'), Boolean, 'send payload');
    checks.push({
      name: 'model_body_contains_full_quote_and_user_text',
      ok: payload.body.includes(`> ${expectedQuoteText}`) && payload.body.endsWith('请基于这段历史继续修改') && payload.quoteIds.length === 1,
      detail: payload,
    });

    await cdp.eval(`document.querySelector('.composer-quote-summary').focus();true`);
    await until(() => cdp.eval(`document.querySelector('[data-zs-conversation-quote-popover]') != null`), Boolean, 'keyboard focus quote popover');
    await cdp.eval(`document.querySelector('[aria-label="复制引用 1"]').focus();true`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await until(() => cdp.eval(`document.querySelector('[data-zs-conversation-quote-popover]') == null`), Boolean, 'Escape closes quote popover');
    checks.push({
      name: 'keyboard_focus_opens_and_escape_closes',
      ok: await cdp.eval(`document.activeElement === document.querySelector('.composer-quote-summary')`),
    });

    await new Promise((resolve) => setTimeout(resolve, 1150));
    const pollAfter = await cdp.eval('window.__r127.pollCalls()');
    const shown = await cdp.eval('window.__r127.shown()');
    checks.push({
      name: 'reading_thread_keeps_independent_notification_polling',
      ok: pollAfter > pollBefore && shown > 0 && (await cdp.eval('window.location.hash')).includes('thread=r127'),
      detail: { route: await cdp.eval('window.location.hash'), pollBefore, pollAfter, shown },
    });

    await cdp.eval('window.__r127.startHangingRead();true');
    const clearedUnread = await until(
      () => cdp.eval('window.__r127.unreadSnapshot()'),
      (value) => value.threadCount === 0
        && value.roomCount === 0
        && value.hasUnread === false
        && value.sidebarDot === false
        && value.mainPoolUnread === false
        && value.threadGetResolved === true
        && value.historyPending === true
        && value.markPending === true,
      'unread DOM clears while history and ACK are pending',
    );
    checks.push({
      name: 'sidebar_and_main_pool_clear_before_history_and_ack',
      ok: clearedUnread.readSeq === 9
        && clearedUnread.historyPending === true
        && clearedUnread.markPending === true,
      detail: clearedUnread,
    });

    await cdp.eval('window.close();true');
  } finally {
    if (cdp) cdp.ws.close();
    clearTimeout(child.__r127KillTimer);
    child.kill();
  }

  const result = {
    ok: checks.every((check) => check.ok),
    checks,
    cdpPort,
    output: outDir,
    screenshots: {
      compact: path.join(outDir, 'quote-chip-default.png'),
      hover: path.join(outDir, 'quote-chip-hover.png'),
    },
    realModelCalls: 0,
  };
  fs.writeFileSync(result.screenshots.compact, Buffer.from(compactScreenshotData, 'base64'));
  fs.writeFileSync(result.screenshots.hover, Buffer.from(hoverScreenshotData, 'base64'));
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  const result = { ok: false, error: error instanceof Error ? error.stack : String(error), cdpPort, output: outDir };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
});
