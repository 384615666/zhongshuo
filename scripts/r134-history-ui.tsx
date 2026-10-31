/* Standalone synthetic bridge; renders the production RoomPage and Composer. */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { RoomPage } from '../src/ui/hifi/pages/Room';
import * as store from '../src/ui/hifi/data/store';
import { loadThread } from '../src/ui/hifi/loader';

const root = createRoot(document.getElementById('root')!);
const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
const checks: Array<Record<string, unknown>> = [];
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(test: () => boolean, timeout = 6000) {
  const start = performance.now();
  while (!test()) { if (performance.now() - start > timeout) throw new Error('timeout: ' + document.body.innerText.slice(-800)); await sleep(15); }
}
const member = { id: 'm1', projectId: 'p', profileId: '', displayName: '演示助手', principalType: 'agent', ordinal: 1, enabled: true, workState: 'idle' as const, model: 'fixture', effort: 'low', internalSubagents: false, isCoordinatorDefault: true };
const room = { id: 'r', projectId: 'p', conversationId: 'c', name: 'R134 独立历史验证', coordinatorMemberId: 'm1', memberIds: ['m1'], revision: 1, unread: 0 };
let count = 105, delayOlder = 0, delayRecent = 0, failOlder = 0, failRecent = 0, denyOlder = false, badCursor = false;
const rows = (id: string) => Array.from({ length: id === 'other' ? 3 : count }, (_, n) => ({ id: `${id}-history-${n + 1}`, authorType: 'human', authorId: 'you', seq: n + 1, body: { text: `合成历史 ${n + 1}，仅用于独立界面验证。` }, createdAt: n + 2 }));
Object.assign(window, { zs: {
  command: async (env: { method: string; params: Record<string, unknown> }) => {
    calls.push({ method: env.method, params: env.params });
    const id = String(env.params.threadId ?? 't');
    let data: unknown = {};
    if (env.method === 'app.settings.get') data = { values: { 'callBudget.enabled': 'false' } };
    if (env.method === 'thread.get') data = { thread: { id, projectId: 'p', conversationId: 'c', roomId: 'r', anchorMessageId: `${id}-anchor`, rootTaskId: null, status: 'open', lastMessageSeq: id === 'other' ? 3 : count, revision: 1 }, anchor: { id: `${id}-anchor`, authorType: 'human', authorId: 'you', body: { text: '合成记录根消息' }, createdAt: 1, attachments: [] }, lastReadSeq: 0 };
    if (env.method === 'thread.history') {
      const older = env.params.beforeSeq != null;
      // Snapshot before delay, as a genuine delayed RPC would do.
      const snapshot = rows(id).filter(x => !older || x.seq < Number(env.params.beforeSeq)).slice(-100);
      await sleep(older ? delayOlder : delayRecent);
      if (older && (denyOlder || failOlder-- > 0) || !older && failRecent-- > 0) return { ok: false, error: { code: 'FORBIDDEN', message: '合成历史读取失败' } };
      data = { items: older && badCursor ? [{ ...snapshot[0], seq: Number(env.params.beforeSeq) }] : snapshot, rootAttachments: [] };
    }
    if (env.method === 'member.list') data = { items: [member] };
    if (env.method === 'room.pool') data = { items: ['t', 'other'].map(threadId => ({ threadId, projectId: 'p', roomId: 'r', conversationId: 'c', anchorMessageId: `${threadId}-anchor`, authorType: 'human', authorId: 'you', body: { text: '合成记录根消息' }, createdAt: 1, replyCount: threadId === 'other' ? 3 : count, lastReplyAt: count + 1, unread: 0, followed: false, muted: false, taskId: null })) };
    return { ok: true, data };
  }, onDisconnect: () => {}, onReconnected: () => {}, pickFolder: async () => null,
} });
async function reset(total: number) {
  root.render(null); await sleep(45);
  count = total; delayOlder = 0; delayRecent = 0; failOlder = 0; failRecent = 0; denyOlder = false; badCursor = false; calls.length = 0;
  store.setState(s => ({ ...s, activeProjectId: 'p', boot: 'ready', projects: [{ id: 'p', displayName: 'Synthetic', rootPath: 'D:/nonexistent-r134-fixture', revision: 1 }], rooms: [room], members: [member], memberRuntimes: { m1: { status: 'bound', kind: 'codex', model: 'fixture' } }, profiles: [], runtimeInstallations: [], dms: [], threads: [], messages: [], tasks: [], threadEntities: {}, threadMessages: {}, threadAnchors: {}, threadTasks: {}, threadMemberships: {}, threadReadSeq: {}, readStates: {}, readErrors: {}, drafts: {}, uploadItems: {}, pendingSends: {}, outboundLedger: {}, roomPool: {}, loadGen: s.loadGen + 1, ui: { ...s.ui, activeThreadId: undefined }, dispatchGuard: { fakeAllowed: true, realDispatchGuard: true } }));
}
function render(highlightMessageId?: string, threadId = 't') {
  window.location.hash = `#/project/p/room/r?thread=${threadId}${highlightMessageId ? '&message=' + highlightMessageId : ''}`;
  root.render(createElement(RoomPage, { roomId: 'r', threadId, highlightMessageId }));
}
const historyBox = () => document.querySelector<HTMLElement>('[data-zs-thread-history]')!;
const listBox = () => document.querySelector<HTMLElement>('.msg-list.is-replies')!;
const olderCalls = () => calls.filter(c => c.method === 'thread.history' && c.params.beforeSeq != null);
const clickHistory = () => { const button = historyBox().querySelector('button'); assert(button, 'history action missing'); button.click(); };
const isLocated = (id: string) => document.getElementById(`thread-msg-${id}`)?.classList.contains('msg-highlight') === true;
function check(name: string, extra: Record<string, unknown> = {}) { checks.push({ case: name, passed: true, ...extra }); }

Object.assign(window, { historyScreenshot: async () => {
  await reset(105); render();
  await until(() => store.getState().threadMessages.t?.length === 100 && historyBox()?.querySelector('button') != null);
  listBox().scrollTop = 0; listBox().dispatchEvent(new Event('scroll', { bubbles: true }));
  await sleep(180);
  assert(historyBox().textContent?.includes('加载更早消息'), 'screenshot entry absent');
  return { syntheticOnly: true, total: 105, loaded: 100, firstLoadedSeq: 6, entry: historyBox().textContent?.trim() };
} });

Object.assign(window, { run: async () => {
  store.initDraftPersistence('r134-history-synthetic-only');
  await reset(105); render();
  await until(() => store.getState().threadMessages.t?.length === 100);
  await until(() => historyBox()?.querySelector('button') != null);
  assert(historyBox().textContent?.includes('加载更早消息'), 'formal older entry missing');
  const box = listBox();
  box.scrollTop = 200; box.dispatchEvent(new Event('scroll', { bubbles: true })); await sleep(35);
  const visible = [...box.querySelectorAll<HTMLElement>('[data-history-message]')].find(el => el.getBoundingClientRect().bottom > box.getBoundingClientRect().top)!;
  const anchorId = visible.dataset.historyMessage;
  const offset = visible.getBoundingClientRect().top - box.getBoundingClientRect().top;
  const editor = document.querySelector<HTMLElement>('.col-thread .composer-editor')!;
  assert(editor, 'production composer absent'); editor.focus(); editor.textContent = '补读时正在输入的草稿'; editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: editor.textContent }));
  await sleep(80);
  delayOlder = 220;
  const readMarks = calls.filter(c => c.method === 'thread.markRead').length;
  clickHistory(); clickHistory();
  await until(() => historyBox().textContent?.includes('正在加载') === true);
  await loadThread('t');
  await until(() => store.getState().threadMessages.t?.length === 105 && historyBox().textContent?.includes('已到历史起点') === true);
  await sleep(70);
  const same = [...box.querySelectorAll<HTMLElement>('[data-history-message]')].find(el => el.dataset.historyMessage === anchorId)!;
  const anchorDrift = Math.abs(same.getBoundingClientRect().top - box.getBoundingClientRect().top - offset);
  assert(anchorDrift <= 2, `scroll anchor drift ${anchorDrift} ${JSON.stringify({anchorId,offset,top:box.scrollTop,height:box.scrollHeight,connected:box.isConnected,history:historyBox().textContent,seqs:store.getState().messages.map(m=>[m.id,m.threadId]).slice(0,10),gen:store.getState().loadGen,active:store.getState().activeProjectId})}`);
  assert(olderCalls().length === 1, 'double click produced duplicate page');
  assert(editor === document.querySelector('.col-thread .composer-editor') && editor.textContent === '补读时正在输入的草稿', 'editor content or identity lost');
  assert(store.getDraftFull('thread:t').body === '补读时正在输入的草稿', 'draft lost');
  await sleep(5300);
  assert(store.getState().threadMessages.t?.length === 105, '5s refresh erased history');
  assert(calls.filter(c => c.method === 'thread.markRead').length === readMarks, 'history marked all read');
  assert(!document.querySelector('.new-msg-pill'), 'prepended history counted as new replies');
  check('formal 105 / double click / concurrent refresh / scroll anchor / active input / 5s poll / no bulk read', { anchorDrift, olderCalls: olderCalls().length });

  await reset(1205); delayOlder = 20; render('t-history-1');
  await until(() => isLocated('t-history-1'), 20000);
  assert(olderCalls().length === 12, 'deep link stopped before true target');
  assert(calls.every(c => c.method !== 'thread.markRead'), 'deep link marked unread tail');
  check('cold 1205 deep link, 12 pages, no arbitrary cap', { pages: olderCalls().length });
  render('t-history-27'); await until(() => isLocated('t-history-27'));
  assert(olderCalls().length === 12, 'hot cached target caused extra pages');
  check('hot cached deep link');

  await reset(605); render(); await until(() => store.getState().threadMessages.t?.length === 100);
  render('t-history-1'); await until(() => isLocated('t-history-1'), 12000);
  check('hot uncached 605 deep link', { pages: olderCalls().length });

  await reset(105); failOlder = 1; render('t-history-1');
  await until(() => historyBox()?.textContent?.includes('加载历史失败') === true);
  assert(store.getState().threadMessages.t?.length === 100, 'failure cleared history'); clickHistory();
  await until(() => isLocated('t-history-1'));
  check('deep-link page failure with explicit retry', { attempts: olderCalls().length });

  await reset(105); render(); await until(() => store.getState().threadMessages.t?.length === 100);
  failOlder = 1; clickHistory(); await until(() => historyBox().textContent?.includes('加载历史失败') === true); clickHistory();
  await until(() => store.getState().threadMessages.t?.length === 105);
  check('manual page failure and retry');

  await reset(105); render('missing-target');
  await until(() => historyBox()?.textContent?.includes('未找到目标消息') === true);
  assert(olderCalls().length === 1, 'missing target did not stop at server boundary');
  check('absent target reports true start');

  await reset(105); delayOlder = 600; render('t-history-1'); await until(() => olderCalls().length === 1);
  render(undefined, 'other'); await until(() => document.getElementById('thread-msg-other-history-3') != null); await sleep(750);
  assert(store.getState().threadMessages.t?.length === 100, 'late thread page merged');
  assert(!document.getElementById('thread-msg-t-history-1'), 'old thread response rendered');
  render('t-history-1'); await until(() => isLocated('t-history-1'));
  check('delayed page, thread switch, then return');

  await reset(105); delayOlder = 600; render('t-history-1'); await until(() => olderCalls().length === 1);
  render(undefined, 'other'); await until(() => document.getElementById('thread-msg-other-history-3') != null);
  render('t-history-1'); await until(() => isLocated('t-history-1'));
  assert(olderCalls().length === 1, 'rapid return did not share the in-flight server page');
  check('rapid A/B/A switch shares read, isolates former consumer');

  await reset(205); delayOlder = 600; render('t-history-1'); await until(() => olderCalls().length === 1);
  render(); await until(() => historyBox().querySelector('button') != null); await sleep(750);
  assert(store.getState().threadMessages.t?.length === 100, 'cancelled locator merged its delayed page');
  clickHistory(); await until(() => store.getState().threadMessages.t?.length === 200 && historyBox().querySelector('button') != null);
  check('cancel hot locator, discard response, then manual paging remains usable');

  await reset(105); delayOlder = 600; render('t-history-1'); await until(() => olderCalls().length === 1);
  root.render(null); await sleep(40);
  store.setState(s => ({ ...s, activeProjectId: 'other-project', loadGen: s.loadGen + 1 })); await sleep(750);
  assert(store.getState().threadMessages.t?.length === 100, 'late project page merged');
  check('delayed page, project switch');

  await reset(105); render(); await until(() => store.getState().threadMessages.t?.length === 100);
  badCursor = true; clickHistory(); await until(() => historyBox().textContent?.includes('未向前推进') === true);
  badCursor = false; clickHistory(); await until(() => store.getState().threadMessages.t?.length === 105);
  check('nonadvancing server cursor reports retryable failure');

  await reset(105); failRecent = 1; render('t-history-1');
  await until(() => historyBox()?.textContent?.includes('加载历史失败') === true); clickHistory();
  await until(() => isLocated('t-history-1'));
  check('initial history failure retries into deep-link traversal');

  await reset(105); delayRecent = 19000; const started = performance.now(); render('t-history-1');
  await until(() => isLocated('t-history-1'), 26000);
  check('cold initial history delayed beyond old 18s DOM retry window', { elapsedMs: Math.round(performance.now() - started) });

  await reset(0); render('t-anchor'); await until(() => isLocated('t-anchor'));
  assert(historyBox().textContent?.includes('已到历史起点'), 'root-only boundary missing');
  assert(!calls.some(c => c.method === 'task.get'), 'record-only root fetched task');
  check('record-only root deep link, empty history, no task get');
  return { realBusinessCalls: 0, syntheticOnly: true, productionComponent: 'RoomPage', checks };
} });
