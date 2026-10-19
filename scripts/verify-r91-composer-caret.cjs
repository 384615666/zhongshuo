/* R91 module-1 real-Chromium proof: Composer caret / selection / IME / polling refresh.
 *
 * Vitest in this repo runs in the `node` environment (no jsdom/happy-dom).  To prove the
 * actual React Composer's DOM selection behaviour we bundle the real component with
 * esbuild and mount it in a hidden Electron BrowserWindow (show:false, no visible GUI,
 * no mouse/keyboard/clipboard use), then drive real DOM events inside that renderer.
 *
 * usage: node scripts/verify-r91-composer-caret.cjs
 * output: dist/r91-composer-caret/result.json + JSON summary on stdout
 * exit:   0 all checks pass, 1 check failure, 2 harness/host error
 */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const fixtureDir = path.join(root, 'dist', 'r91-composer-caret', 'fixture');
// R91_SOURCE_ROOT lets the same harness run against a baseline snapshot (pre-fix evidence).
const sourceRoot = process.env.R91_SOURCE_ROOT != null && process.env.R91_SOURCE_ROOT.length > 0
  ? path.resolve(process.env.R91_SOURCE_ROOT)
  : path.join(root, 'src');
const resultPath = process.env.R91_RESULT_PATH != null && process.env.R91_RESULT_PATH.length > 0
  ? path.resolve(process.env.R91_RESULT_PATH)
  : path.join(root, 'dist', 'r91-composer-caret', 'result.json');

const HARNESS_SOURCE = String.raw`
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Composer } from '__R91_COMPOSER__';
import {
  getState, setState, getDraftFull, setDraftFull, removeUploadItem, addFileRefToDraft,
  stripInlineAttachmentTokens, parseInlineBody,
} from '__R91_STORE__';

/* Independent copy of the editor serializer (do not import test-only helpers from the component;
 * the same harness must also run against the pre-fix baseline where they are not exported). */
function serializeEditorNode(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
  if (node.nodeType === Node.ELEMENT_NODE && node.dataset && node.dataset.zsInlineToken === '1') return node.dataset.zsRawToken || '';
  if (node.nodeName === 'BR') return '\n';
  let text = '';
  node.childNodes.forEach(function (child) { text += serializeEditorNode(child); });
  if (node.nodeType === Node.ELEMENT_NODE && (node.tagName === 'DIV' || node.tagName === 'P') && text.length > 0 && !text.endsWith('\n')) text += '\n';
  return text;
}
function serializeEditor(editor) {
  if (editor === null) return '';
  let text = '';
  editor.childNodes.forEach(function (child) { text += serializeEditorNode(child); });
  return text;
}

const checks = [];
const facts = {};
function check(name, ok, detail) {
  checks.push({ name: name, ok: !!ok, detail: ok ? undefined : detail });
  if (!ok) console.log('R91_CHECK_FAIL ' + name + ' ' + JSON.stringify(detail === undefined ? null : detail));
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, { actual: actual, expected: expected });
}
const sleep = function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };
async function settle(times) {
  // Hidden BrowserWindows can throttle requestAnimationFrame; React effects need only macrotasks.
  const n = times === undefined ? 2 : times;
  for (let i = 0; i < n; i += 1) { await sleep(1); await sleep(0); }
}
async function waitFor(predicate, timeout) {
  const limit = timeout === undefined ? 3000 : timeout;
  const start = Date.now();
  while (Date.now() - start < limit) { if (predicate()) return true; await sleep(10); }
  return predicate();
}

/* ---------- deterministic synthetic store fixture (no real project data) ---------- */
function member(id, displayName, enabled) {
  return {
    id: id, projectId: 'p1', profileId: '', displayName: displayName, description: '', revision: 1,
    enabled: enabled !== false, principalType: 'agent', workState: 'unknown', workStateReason: '',
    model: '', effort: 'medium', internalSubagents: false, isCoordinatorDefault: false,
  };
}
function membership(threadId, eligible) {
  return {
    projectId: 'p1', threadId: threadId, roomId: 'r1', version: 'v1',
    memberIds: eligible.slice(), eligibleMemberIds: eligible.slice(), runningMemberIds: [],
  };
}
const ALL_THREADS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11'];
function installBaseStore() {
  const memberships = {};
  for (let i = 0; i < ALL_THREADS.length; i += 1) memberships[ALL_THREADS[i]] = membership(ALL_THREADS[i], ['m1', 'm2']);
  setState(function (prev) {
    return Object.assign({}, prev, {
      activeProjectId: 'p1', loadGen: 1, boot: 'ready',
      members: [member('m1', '甲'), member('m2', '乙'), member('m3', '丙')],
      rooms: [{ id: 'r1', projectId: 'p1', name: 'R91测试房间', conversationId: 'conv1', coordinatorMemberId: 'm1', memberIds: ['m1', 'm2'], revision: 1, unread: 0 }],
      memberRuntimes: {
        m1: { kind: 'codex', model: 'gpt-5', status: 'bound' },
        m2: { kind: 'claude', model: 'sonnet', status: 'bound' },
        m3: { kind: 'codex', model: 'gpt-5', status: 'bound' },
      },
      runtimes: [], profiles: [], dms: [], threadMemberships: memberships,
      threadProgress: {}, threadTasks: {}, threadEntities: {}, uploadItems: {},
      pendingSends: {}, readErrors: {}, dispatchGuard: { fakeAllowed: true, realDispatchGuard: false },
    });
  });
}
/** Simulates the app's 5s thread poll: fresh object identities for roster/progress/tasks/runtimes. */
function pollRefresh(threadId, eligible, extraMembers) {
  setState(function (s) {
    const membersNow = extraMembers && extraMembers.length > 0
      ? s.members.concat(extraMembers)
      : s.members.map(function (m) { return Object.assign({}, m); });
    const memberships = Object.assign({}, s.threadMemberships);
    memberships[threadId] = membership(threadId, eligible === undefined ? ['m1', 'm2'] : eligible);
    const progress = Object.assign({}, s.threadProgress);
    progress[threadId] = { items: [{ kind: 'run', text: 'R91 进度刷新' }], readAt: Date.now() };
    const tasks = Object.assign({}, s.threadTasks);
    tasks[threadId] = { id: 'task_' + threadId, revision: 2 };
    return Object.assign({}, s, {
      loadGen: s.loadGen + 1, members: membersNow,
      memberRuntimes: Object.assign({}, s.memberRuntimes),
      threadMemberships: memberships, threadProgress: progress, threadTasks: tasks,
    });
  });
}
function setDraft(key, body, extra) {
  setDraftFull(key, Object.assign({ body: body, mentions: [], attachments: [], access: 'plan', sendAs: 'ai' }, extra === undefined ? {} : extra));
}

/* ---------- bridge stub: attachment.uploadTextRaw with controllable delay ---------- */
let uploadDelayMs = 0;
let uploadCounter = 0;
window.zs = {
  command: async function (envelope) {
    const method = envelope.method;
    if (method === 'attachment.uploadTextRaw') {
      const delay = uploadDelayMs;
      uploadDelayMs = 0;
      if (delay > 0) await sleep(delay);
      uploadCounter += 1;
      return { ok: true, data: { attachmentId: 'att_r91_' + uploadCounter, hash: 'hash_r91_' + uploadCounter, revision: 1 } };
    }
    if (method === 'attachment.listByConversation') return { ok: true, data: { items: [] } };
    if (method === 'project.files.list') return { ok: true, data: { entries: [] } };
    return { ok: true, data: {} };
  },
  pickFolder: async function () { return null; },
  openPath: async function () { return ''; },
  onDisconnect: function () { return undefined; },
  onReconnected: function () { return undefined; },
};

/* ---------- actual React Composer mounting ---------- */
let reactRoot = null;
let currentProps = {};
function threadTarget(threadId) { return { kind: 'thread', roomId: 'r1', threadId: threadId }; }
function editorEl() { return document.querySelector('.composer-editor'); }
async function mount(draftKey, threadId, extra) {
  if (reactRoot !== null) { reactRoot.unmount(); reactRoot = null; }
  const host = document.getElementById('root');
  host.innerHTML = '';
  reactRoot = createRoot(host);
  currentProps = Object.assign({
    target: threadTarget(threadId), draftKey: draftKey,
    onSend: function () { return { status: 'ok' }; },
    attachmentUpload: { conversationId: 'conv1' },
  }, extra === undefined ? {} : extra);
  reactRoot.render(createElement(Composer, currentProps));
  await settle(3);
  return editorEl();
}
function rerender(patch) {
  currentProps = Object.assign({}, currentProps, patch);
  reactRoot.render(createElement(Composer, currentProps));
}

/* ---------- selection helpers (independent unit walk: text chars; token/BR = 1 unit) ---------- */
function walkUnits(node, visit) {
  const children = Array.from(node.childNodes);
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child.nodeType === 3) {
      const len = (child.textContent || '').length;
      const stop = visit(child, i, len, false);
      if (stop) return true;
      continue;
    }
    if (child.nodeType === 1) {
      const el = child;
      if (el.dataset && el.dataset.zsInlineToken === '1') {
        if (visit(child, i, 1, true)) return true;
        continue;
      }
      if (el.tagName === 'BR') {
        if (visit(child, i, 1, true)) return true;
        continue;
      }
    }
    if (walkUnits(child, visit)) return true;
  }
  return false;
}
function totalUnits(ed) {
  let total = 0;
  walkUnits(ed, function (_child, _i, len) { total += len; return false; });
  return total;
}
function unitOfPoint(ed, node, offset) {
  if (!ed.contains(node)) return -1;
  const prefix = document.createRange();
  prefix.selectNodeContents(ed);
  prefix.setEnd(node, offset);
  const holder = document.createElement('div');
  holder.appendChild(prefix.cloneContents());
  return totalUnits(holder);
}
function unitSelection(ed) {
  const sel = window.getSelection();
  if (sel === null || sel.rangeCount === 0 || sel.anchorNode === null || sel.focusNode === null) return null;
  const anchor = unitOfPoint(ed, sel.anchorNode, sel.anchorOffset);
  const focus = unitOfPoint(ed, sel.focusNode, sel.focusOffset);
  return {
    collapsed: sel.isCollapsed, anchorUnit: anchor, focusUnit: focus, backward: anchor > focus,
    anchorIsText: sel.anchorNode.nodeType === 3,
    anchorText: sel.anchorNode.nodeType === 3 ? sel.anchorNode.textContent : null,
    anchorRawOffset: sel.anchorNode.nodeType === 3 ? sel.anchorOffset : null,
    focusRawOffset: sel.focusNode.nodeType === 3 ? sel.focusOffset : null,
  };
}
function unitPoint(ed, target) {
  let remaining = Math.max(0, target);
  let result = null;
  walkUnits(ed, function (child, index, len, atomic) {
    if (!atomic) {
      if (remaining <= len) { result = { node: child, offset: remaining }; return true; }
      remaining -= len;
      return false;
    }
    if (remaining === 0) {
      result = { node: child.parentNode, offset: index };
      return true;
    }
    remaining -= 1;
    if (remaining === 0) {
      result = { node: child.parentNode, offset: index + 1 };
      return true;
    }
    return false;
  });
  return result;
}
function setUnitSelection(ed, anchorUnit, focusUnit) {
  const a = unitPoint(ed, anchorUnit);
  const f = unitPoint(ed, focusUnit);
  ed.focus();
  const sel = window.getSelection();
  sel.removeAllRanges();
  if (a !== null && f !== null) sel.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
}
function insertTextAtCaret(text, composing) {
  const ed = editorEl();
  const sel = window.getSelection();
  if (ed === null || sel === null || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: composing ? 'insertCompositionText' : 'insertText', data: text, isComposing: !!composing }));
  return true;
}
function fireComposition(type, data) {
  const ed = editorEl();
  if (ed !== null) ed.dispatchEvent(new CompositionEvent(type, { bubbles: true, data: data === undefined ? '' : data }));
}
function pickFile(name, delayMs) {
  uploadDelayMs = delayMs === undefined ? 0 : delayMs;
  const input = document.querySelector('[data-zs-file-input="1"]');
  if (input === null) return false;
  const file = new File(['R91 synthesized attachment content'], name, { type: 'text/plain', lastModified: 1700000000000 });
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}
function visibleText() {
  const ed = editorEl();
  return ed === null ? '' : stripInlineAttachmentTokens(serializeEditor(ed));
}
function domTokenCount() {
  const ed = editorEl();
  return ed === null ? 0 : parseInlineBody(serializeEditor(ed)).filter(function (s) { return s.kind === 'attachment'; }).length;
}
function domChip() { return document.querySelector('.composer-file-token'); }
function domMentionOpen() { return document.querySelector('[data-zs-mention-pop="1"]') !== null; }
function domMentionOptions() {
  return Array.from(document.querySelectorAll('[data-zs-mention-option]')).map(function (el) { return el.getAttribute('data-zs-mention-option'); });
}

/* ---------- editor mutation observer (only counts DOM rewrites of the editor subtree) ---------- */
let observer = null;
let mutationRecords = [];
function watchMutations() {
  const ed = editorEl();
  mutationRecords = [];
  observer = new MutationObserver(function (records) { mutationRecords.push.apply(mutationRecords, records); });
  observer.observe(ed, { childList: true, subtree: true, characterData: true });
}
function stopMutations() {
  if (observer !== null) { observer.disconnect(); observer = null; }
  const childList = mutationRecords.filter(function (r) { return r.type === 'childList'; }).length;
  const characterData = mutationRecords.filter(function (r) { return r.type === 'characterData'; }).length;
  return { childList: childList, characterData: characterData, total: mutationRecords.length };
}

/* ===================================================================== */
/* scenario 1: same-target polling refresh must not reload the editor     */
/* ===================================================================== */
async function scenarioPollRefresh() {
  installBaseStore();
  const longBody = Array.from({ length: 40 }, function (_v, i) {
    return '第' + (i + 1) + '行：同一目标的成员、进度、权限刷新期间正文与光标必须稳定';
  }).join('\n');
  setDraft('T1', longBody);
  await mount('T1', 'T1');
  const ed = editorEl();
  check('poll_editor_mounted', ed !== null);
  if (ed === null) return;
  ed.focus();
  setUnitSelection(ed, 5, 5);
  ed.scrollTop = 40;
  await settle(2);
  facts.poll = { scrollTopBefore: ed.scrollTop, scrollHeight: ed.scrollHeight, clientHeight: ed.clientHeight };
  check('poll_editor_scrollable_fixture', ed.scrollHeight > ed.clientHeight);
  const nodeBefore = ed.firstChild;
  const revBefore = getDraftFull('T1').rev;
  const textBefore = serializeEditor(ed);
  const selBefore = unitSelection(ed);
  watchMutations();
  pollRefresh('T1', ['m1', 'm2', 'm3']);
  await settle(3);
  const mutation = stopMutations();
  check('poll_text_node_identity_kept', ed.firstChild === nodeBefore, { beforeNodeType: nodeBefore === null ? null : nodeBefore.nodeType, afterNodeType: ed.firstChild === null ? null : ed.firstChild.nodeType });
  eq('poll_no_editor_dom_mutation', mutation, { childList: 0, characterData: 0, total: 0 });
  eq('poll_text_unchanged', serializeEditor(ed), textBefore);
  eq('poll_caret_and_direction_unchanged', unitSelection(ed), selBefore);
  eq('poll_scroll_top_unchanged', ed.scrollTop, 40);
  const draftAfterPoll = getDraftFull('T1');
  eq('poll_draft_not_rewritten', { rev: draftAfterPoll.rev, body: draftAfterPoll.body }, { rev: revBefore, body: textBefore });

  // @ candidates stay open across the poll and follow the refreshed roster.
  setUnitSelection(ed, totalUnits(ed), totalUnits(ed));
  await settle(1);
  insertTextAtCaret(' @', false);
  await settle(2);
  const optionsBefore = domMentionOptions();
  check('poll_mention_popup_open', domMentionOpen());
  check('poll_mention_options_initial', optionsBefore.indexOf('m1') >= 0 && optionsBefore.indexOf('m2') >= 0, { options: optionsBefore });
  const atText = serializeEditor(ed);
  const atCaret = unitSelection(ed);
  const atNode = ed.firstChild;
  watchMutations();
  pollRefresh('T1', ['m1', 'm2', 'm4'], [member('m4', '丁')]);
  await settle(3);
  const mentionMutation = stopMutations();
  const optionsAfter = domMentionOptions();
  check('poll_mention_popup_still_open', domMentionOpen());
  check('poll_mention_candidates_follow_roster', optionsAfter.indexOf('m4') >= 0, { before: optionsBefore, after: optionsAfter });
  eq('poll_mention_no_editor_mutation', mentionMutation, { childList: 0, characterData: 0, total: 0 });
  eq('poll_mention_text_unchanged', serializeEditor(ed), atText);
  eq('poll_mention_caret_unchanged', unitSelection(ed), atCaret);
  check('poll_mention_dom_node_identity', ed.firstChild === atNode);
  ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(1);

  // end + middle editing still reach the draft
  setUnitSelection(ed, 3, 3);
  await settle(1);
  insertTextAtCaret('中', false);
  await settle(2);
  const textMid = serializeEditor(ed);
  check('middle_edit_inserted', textMid.slice(0, 4) === textBefore.slice(0, 3) + '中');
  eq('middle_edit_draft_synced', getDraftFull('T1').body, textMid);
  eq('middle_edit_caret_after_insert', (unitSelection(ed) || {}).anchorUnit, 4);
  const endUnit = totalUnits(ed);
  setUnitSelection(ed, endUnit, endUnit);
  await settle(1);
  insertTextAtCaret('尾', false);
  await settle(2);
  check('end_edit_inserted', serializeEditor(ed).endsWith('尾'));
  eq('end_edit_draft_synced', getDraftFull('T1').body, serializeEditor(ed));
  eq('end_edit_caret_at_end', (unitSelection(ed) || {}).anchorUnit, totalUnits(ed));

  // non-collapsed backward selection survives the same-target poll
  setDraft('T2', '零一二三四五六七八九');
  await mount('T2', 'T2');
  const ed2 = editorEl();
  ed2.focus();
  setUnitSelection(ed2, 8, 3);
  await settle(2);
  const selBefore2 = unitSelection(ed2);
  check('backward_selection_established', selBefore2 !== null && selBefore2.backward && selBefore2.collapsed === false, selBefore2);
  const textBefore2 = serializeEditor(ed2);
  watchMutations();
  pollRefresh('T2', ['m1', 'm2']);
  await settle(3);
  const selectionMutation = stopMutations();
  eq('poll_backward_selection_preserved', unitSelection(ed2), selBefore2);
  eq('poll_backward_selection_text_unchanged', serializeEditor(ed2), textBefore2);
  eq('poll_backward_selection_no_mutation', selectionMutation, { childList: 0, characterData: 0, total: 0 });
  ed2.scrollTop = 0;
}

/* ===================================================================== */
/* scenario 2: IME composition survives same-target poll                 */
/* ===================================================================== */
async function scenarioCompositionPoll() {
  installBaseStore();
  setDraft('T3', '拼音测试');
  await mount('T3', 'T3');
  const ed = editorEl();
  check('composition_editor_mounted', ed !== null);
  if (ed === null) return;
  ed.focus();
  setUnitSelection(ed, totalUnits(ed), totalUnits(ed));
  await settle(1);
  fireComposition('compositionstart', '');
  await settle(1);
  insertTextAtCaret('拼', true);
  fireComposition('compositionupdate', '拼');
  await settle(2);
  const nodeDuring = ed.firstChild;
  const textDuring = serializeEditor(ed);
  watchMutations();
  pollRefresh('T3', ['m1', 'm2']);
  await settle(3);
  const mutation = stopMutations();
  eq('composition_poll_no_dom_rebuild', { childList: mutation.childList, total: mutation.total }, { childList: 0, total: 0 });
  check('composition_poll_text_node_identity', ed.firstChild === nodeDuring);
  check('composition_poll_composition_text_kept', serializeEditor(ed) === textDuring && textDuring.endsWith('拼'), { textDuring: textDuring, now: serializeEditor(ed) });
  eq('composition_poll_caret_kept', (unitSelection(ed) || {}).anchorUnit, totalUnits(ed));
  insertTextAtCaret('音', true);
  fireComposition('compositionupdate', '拼音');
  await settle(2);
  check('composition_second_ime_commit', serializeEditor(ed).endsWith('拼音'));
  fireComposition('compositionend', '拼音');
  await settle(3);
  check('composition_end_text_kept', serializeEditor(ed).endsWith('拼音'));
  eq('composition_end_draft_synced', getDraftFull('T3').body, serializeEditor(ed));
  eq('composition_end_caret_at_end', (unitSelection(ed) || {}).anchorUnit, totalUnits(ed));
}

/* ===================================================================== */
/* scenario 3: store token add/remove during composition has explicit    */
/* authoritative merge (DOM text + draft token set)                      */
/* ===================================================================== */
async function scenarioCompositionTokenAuthority() {
  installBaseStore();
  setDraft('T4', '内容');
  addFileRefToDraft('T4', 'conv1', { attachmentId: 'att_existing', name: '既有引用.txt', kind: 'text_file', revision: 1, hash: 'h_existing' });
  await mount('T4', 'T4');
  const ed = editorEl();
  check('token_authority_editor_mounted', ed !== null);
  if (ed === null) return;
  await waitFor(function () { return domChip() !== null; }, 2000);
  check('token_authority_existing_chip', domChip() !== null);
  ed.focus();
  setUnitSelection(ed, totalUnits(ed), totalUnits(ed));
  await settle(1);
  fireComposition('compositionstart', '');
  await settle(1);
  insertTextAtCaret('拼', true);
  fireComposition('compositionupdate', '拼');
  await settle(2);
  const domTokensBefore = domTokenCount();
  const textBefore = serializeEditor(ed);
  // During composition: store removes the old token and appends a brand-new reference token.
  const existing = (getState().uploadItems['T4'] || [])[0];
  if (existing !== undefined) removeUploadItem('T4', existing.uploadId);
  addFileRefToDraft('T4', 'conv1', { attachmentId: 'att_during', name: '组合中引用.txt', kind: 'text_file', revision: 1, hash: 'h_during' });
  // Trigger the component's receipt sync path (late conversation channel) while composing.
  watchMutations();
  rerender({ attachmentUpload: { conversationId: 'conv2' } });
  await settle(3);
  const mutationDuring = stopMutations();
  eq('token_authority_no_dom_rebuild_during_composition', { childList: mutationDuring.childList, total: mutationDuring.total }, { childList: 0, total: 0 });
  eq('token_authority_dom_chip_count_unchanged_during_composition', domTokenCount(), domTokensBefore);
  check('token_authority_composition_text_kept', serializeEditor(ed) === textBefore, { before: textBefore, now: serializeEditor(ed) });
  const draftDuring = getDraftFull('T4');
  const storeTokensDuring = parseInlineBody(draftDuring.body).filter(function (s) { return s.kind === 'attachment'; });
  check('token_authority_store_has_only_new_token', storeTokensDuring.length === 1 && storeTokensDuring[0].token.attachmentId === 'att_during');
  fireComposition('compositionend', '拼');
  await settle(4);
  const draftAfter = getDraftFull('T4');
  const storeTokensAfter = parseInlineBody(draftAfter.body).filter(function (s) { return s.kind === 'attachment'; });
  check('token_authority_flush_keeps_composition_text', visibleText().indexOf('内容') >= 0 && visibleText().indexOf('拼') >= 0, { visible: visibleText() });
  check('token_authority_flush_drops_removed_token', storeTokensAfter.length === 1 && storeTokensAfter[0].token.attachmentId === 'att_during', { tokens: storeTokensAfter.map(function (s) { return s.token.attachmentId; }) });
  check('token_authority_flush_renders_new_token', domTokenCount() === 1 && (domChip() || {}).getAttribute && (domChip().getAttribute('data-zs-attachment-id') === 'att_during'), { chips: Array.from(document.querySelectorAll('.composer-file-token')).map(function (c) { return c.getAttribute('data-zs-attachment-id'); }) });
  check('token_authority_flush_text_synced', stripInlineAttachmentTokens(serializeEditor(ed)).indexOf('内容') >= 0 && stripInlineAttachmentTokens(serializeEditor(ed)).indexOf('拼') >= 0);
}

/* ===================================================================== */
/* scenario 4: upload token -> file token (raw length grows) keeps       */
/* caret before/after token and backward selection via segment mapping   */
/* ===================================================================== */
async function scenarioTokenLengthChange() {
  installBaseStore();
  setDraft('T5', '前文后文');
  await mount('T5', 'T5');
  const ed = editorEl();
  check('token_length_editor_mounted', ed !== null);
  if (ed === null) return;
  ed.focus();
  setUnitSelection(ed, 2, 2);
  await settle(1);
  // file #1 inserted between 前文 and 后文, then settles to ready while caret sits inside 后文
  pickFile('r91-长度-1.txt', 1200);
  const uploading1 = await waitFor(function () { return (getState().uploadItems['T5'] || []).some(function (u) { return u.status === 'uploading'; }); }, 3000);
  check('token_length_uploading_seen', uploading1);
  await settle(1);
  const bodyBefore = serializeEditor(ed);
  const tokenBefore = parseInlineBody(bodyBefore).filter(function (s) { return s.kind === 'attachment'; })[0];
  setUnitSelection(ed, 6, 6);
  await settle(1);
  const selBefore = unitSelection(ed);
  const rawBefore = tokenBefore === undefined ? 0 : tokenBefore.raw.length;
  const ready1 = await waitFor(function () { return (getState().uploadItems['T5'] || []).some(function (u) { return u.status === 'ready'; }); }, 4000);
  await settle(3);
  const bodyAfter = serializeEditor(ed);
  const tokenAfter = parseInlineBody(bodyAfter).filter(function (s) { return s.kind === 'attachment'; })[0];
  const selAfter = unitSelection(ed);
  facts.tokenLengthCaret = { rawBefore: rawBefore, rawAfter: tokenAfter === undefined ? 0 : tokenAfter.raw.length, selBefore: selBefore, selAfter: selAfter, visibleBefore: stripInlineAttachmentTokens(bodyBefore), visibleAfter: stripInlineAttachmentTokens(bodyAfter) };
  check('token_length_receipt_ready', ready1 && tokenAfter !== undefined && tokenAfter.token.kind === 'file');
  check('token_length_raw_grew', tokenAfter !== undefined && tokenAfter.raw.length > rawBefore, { rawBefore: rawBefore, rawAfter: tokenAfter === undefined ? 0 : tokenAfter.raw.length });
  eq('token_length_visible_text_unchanged', stripInlineAttachmentTokens(bodyAfter), stripInlineAttachmentTokens(bodyBefore));
  eq('token_length_caret_inside_text_after_token_stable', selAfter, selBefore);

  // file #2 at the end, then a backward selection across the new token settles to ready
  setUnitSelection(ed, totalUnits(ed), totalUnits(ed));
  await settle(1);
  pickFile('r91-长度-2.txt', 1200);
  await waitFor(function () { return (getState().uploadItems['T5'] || []).length >= 2 && (getState().uploadItems['T5'] || []).some(function (u) { return u.status === 'uploading'; }); }, 3000);
  await settle(2);
  const total2 = totalUnits(ed);
  setUnitSelection(ed, total2, total2 - 1);
  await settle(1);
  const selBackBefore = unitSelection(ed);
  check('token_length_backward_selection_established', selBackBefore !== null && selBackBefore.backward === true && selBackBefore.collapsed === false, selBackBefore);
  const visibleBefore2 = visibleText();
  const ready2 = await waitFor(function () { return (getState().uploadItems['T5'] || []).filter(function (u) { return u.status === 'ready'; }).length >= 2; }, 4000);
  await settle(3);
  const selBackAfter = unitSelection(ed);
  facts.tokenLengthBackward = { selBackBefore: selBackBefore, selBackAfter: selBackAfter, visibleBefore: visibleBefore2, visibleAfter: visibleText() };
  check('token_length_backward_receipt_ready', ready2);
  eq('token_length_backward_selection_stable', selBackAfter, selBackBefore);
  eq('token_length_backward_visible_text_unchanged', visibleText(), visibleBefore2);

  // file #3: caret before the last token survives its upload->file transition
  pickFile('r91-长度-3.txt', 1200);
  await waitFor(function () { return (getState().uploadItems['T5'] || []).some(function (u) { return u.status === 'uploading'; }); }, 3000);
  await settle(2);
  const beforeLastToken = totalUnits(ed) - 1;
  setUnitSelection(ed, beforeLastToken, beforeLastToken);
  await settle(1);
  const selBeforeToken = unitSelection(ed);
  const visibleBefore3 = visibleText();
  const ready3 = await waitFor(function () { return (getState().uploadItems['T5'] || []).filter(function (u) { return u.status === 'ready'; }).length >= 3; }, 4000);
  await settle(3);
  facts.tokenLengthBeforeToken = { selBefore: selBeforeToken, selAfter: unitSelection(ed), visibleBefore: visibleBefore3, visibleAfter: visibleText() };
  check('token_length_before_token_receipt_ready', ready3);
  eq('token_length_before_token_caret_stable', unitSelection(ed), selBeforeToken);
  eq('token_length_before_token_visible_text_unchanged', visibleText(), visibleBefore3);
}

/* ===================================================================== */
/* scenario 5: upload receipt arriving during composition is deferred     */
/* ===================================================================== */
async function scenarioCompositionUploadReceipt() {
  installBaseStore();
  setDraft('T11', '组合上传');
  await mount('T11', 'T11');
  const ed = editorEl();
  check('composition_upload_editor_mounted', ed !== null);
  if (ed === null) return;
  ed.focus();
  setUnitSelection(ed, totalUnits(ed), totalUnits(ed));
  await settle(1);
  pickFile('r91-组合上传.txt', 1500);
  const uploading = await waitFor(function () { return (getState().uploadItems['T11'] || []).some(function (u) { return u.status === 'uploading'; }); }, 3000);
  check('composition_upload_uploading_seen', uploading);
  await settle(1);
  fireComposition('compositionstart', '');
  await settle(1);
  insertTextAtCaret('拼', true);
  fireComposition('compositionupdate', '拼');
  await settle(1);
  const textDuring = serializeEditor(ed);
  watchMutations();
  const ready = await waitFor(function () { return (getState().uploadItems['T11'] || []).some(function (u) { return u.status === 'ready'; }); }, 4000);
  await settle(3);
  const mutation = stopMutations();
  facts.compositionUpload = { ready: ready, textDuring: textDuring, now: serializeEditor(ed), chipClass: (domChip() || {}).className, tokens: parseInlineBody(getDraftFull('T11').body).filter(function (s) { return s.kind === 'attachment'; }).map(function (s) { return s.token.kind; }) };
  eq('composition_upload_no_dom_rebuild_during_ime', { childList: mutation.childList, total: mutation.total }, { childList: 0, total: 0 });
  check('composition_upload_text_kept_during_ime', serializeEditor(ed) === textDuring && textDuring.endsWith('拼'));
  check('composition_upload_receipt_settled_in_store', ready);
  fireComposition('compositionend', '拼');
  await settle(4);
  const draft = getDraftFull('T11');
  const tokens = parseInlineBody(draft.body).filter(function (s) { return s.kind === 'attachment'; });
  check('composition_upload_flush_renders_ready_chip', domChip() !== null && (domChip().className || '').indexOf('is-ready') >= 0, { className: domChip() === null ? null : domChip().className });
  check('composition_upload_flush_keeps_text', visibleText().indexOf('组合上传') >= 0 && visibleText().indexOf('拼') >= 0, { visible: visibleText() });
  check('composition_upload_flush_token_is_file', tokens.length === 1 && tokens[0].token.kind === 'file' && draft.attachments.length === 1, { tokens: tokens.map(function (s) { return s.token.kind; }), attachments: draft.attachments.length });
  check('composition_upload_flush_text_synced', stripInlineAttachmentTokens(draft.body).indexOf('拼') >= 0);
}

/* ===================================================================== */
/* scenario 6: draft switch independence + late receipt isolation        */
/* ===================================================================== */
async function scenarioDraftSwitchAndLateReceipt() {
  installBaseStore();
  setDraft('T6', '甲的草稿');
  setDraft('T7', '乙的草稿');
  await mount('T6', 'T6');
  const ed6 = editorEl();
  ed6.focus();
  setUnitSelection(ed6, totalUnits(ed6), totalUnits(ed6));
  await settle(1);
  insertTextAtCaret('!', false);
  await settle(2);
  eq('switch_first_edit_saved', getDraftFull('T6').body, '甲的草稿!');
  rerender({ draftKey: 'T7', target: threadTarget('T7') });
  await settle(3);
  eq('switch_restores_target_draft', serializeEditor(editorEl()), '乙的草稿');
  eq('switch_keeps_previous_draft', getDraftFull('T6').body, '甲的草稿!');
  rerender({ draftKey: 'T6', target: threadTarget('T6') });
  await settle(3);
  eq('switch_back_restores_edited_draft', serializeEditor(editorEl()), '甲的草稿!');
  eq('switch_back_other_draft_intact', getDraftFull('T7').body, '乙的草稿');

  // late receipt for T8 must not touch T9 while T9 is mounted
  setDraft('T8', '甲串');
  setDraft('T9', '乙串');
  await mount('T8', 'T8');
  const ed8 = editorEl();
  ed8.focus();
  setUnitSelection(ed8, totalUnits(ed8), totalUnits(ed8));
  await settle(1);
  pickFile('r91-迟到.txt', 600);
  await waitFor(function () { return (getState().uploadItems['T8'] || []).length === 1; }, 2000);
  rerender({ draftKey: 'T9', target: threadTarget('T9') });
  await settle(2);
  const lateReady = await waitFor(function () { return (getState().uploadItems['T8'] || []).some(function (u) { return u.status === 'ready'; }); }, 5000);
  await settle(3);
  facts.lateReceipt = { ready: lateReady, t9Dom: serializeEditor(editorEl()), t8Draft: getDraftFull('T8').body, t9Draft: getDraftFull('T9').body };
  check('late_receipt_other_draft_dom_clean', lateReady && serializeEditor(editorEl()) === '乙串' && domChip() === null);
  check('late_receipt_origin_draft_settled', getDraftFull('T8').attachments.length === 1 && parseInlineBody(getDraftFull('T8').body).some(function (s) { return s.kind === 'attachment' && s.token.kind === 'file'; }));
  check('late_receipt_other_draft_store_clean', getDraftFull('T9').body === '乙串' && getDraftFull('T9').attachments.length === 0);
  rerender({ draftKey: 'T8', target: threadTarget('T8') });
  await settle(3);
  check('late_receipt_visible_on_return', domChip() !== null && (domChip().className || '').indexOf('is-ready') >= 0);
}

/* ===================================================================== */
/* scenario 7: late conversationId hydrate during IME uses same guard    */
/* ===================================================================== */
async function scenarioLateHydrateDuringComposition() {
  installBaseStore();
  setDraft('T10', '内容', {
    attachments: [{ name: '迟到.md', size: 2, attachmentId: 'att_late', hash: 'h_late', revision: 1, kind: 'text_file' }],
  });
  await mount('T10', 'T10', { attachmentUpload: undefined });
  const ed = editorEl();
  check('late_hydrate_editor_mounted', ed !== null);
  if (ed === null) return;
  check('late_hydrate_no_chip_before_channel', domChip() === null);
  ed.focus();
  setUnitSelection(ed, totalUnits(ed), totalUnits(ed));
  await settle(1);
  fireComposition('compositionstart', '');
  await settle(1);
  insertTextAtCaret('拼', true);
  fireComposition('compositionupdate', '拼');
  await settle(2);
  const nodeDuring = ed.firstChild;
  watchMutations();
  rerender({ attachmentUpload: { conversationId: 'conv1' } });
  await settle(3);
  const mutationDuring = stopMutations();
  facts.lateHydrate = { text: serializeEditor(ed), chip: domChip() === null ? null : domChip().className, storeTokens: parseInlineBody(getDraftFull('T10').body).filter(function (s) { return s.kind === 'attachment'; }).length };
  eq('late_hydrate_no_dom_rebuild_during_composition', { childList: mutationDuring.childList, total: mutationDuring.total }, { childList: 0, total: 0 });
  check('late_hydrate_chip_not_rendered_during_composition', domChip() === null && ed.firstChild === nodeDuring);
  check('late_hydrate_store_token_added', parseInlineBody(getDraftFull('T10').body).filter(function (s) { return s.kind === 'attachment'; }).length === 1);
  fireComposition('compositionend', '拼');
  await settle(4);
  check('late_hydrate_flushes_ready_chip_after_composition', domChip() !== null && (domChip().className || '').indexOf('is-ready') >= 0);
  check('late_hydrate_keeps_composition_text', visibleText().indexOf('内容') >= 0 && visibleText().indexOf('拼') >= 0, { visible: visibleText() });
  check('late_hydrate_draft_token_once', parseInlineBody(getDraftFull('T10').body).filter(function (s) { return s.kind === 'attachment'; }).length === 1);
}

/* ===================================================================== */
window.__r91Run = async function () {
  const scenarios = [
    ['pollRefresh', scenarioPollRefresh],
    ['compositionPoll', scenarioCompositionPoll],
    ['compositionTokenAuthority', scenarioCompositionTokenAuthority],
    ['tokenLengthChange', scenarioTokenLengthChange],
    ['compositionUploadReceipt', scenarioCompositionUploadReceipt],
    ['draftSwitchAndLateReceipt', scenarioDraftSwitchAndLateReceipt],
    ['lateHydrateDuringComposition', scenarioLateHydrateDuringComposition],
  ];
  for (let i = 0; i < scenarios.length; i += 1) {
    const name = scenarios[i][0];
    const fn = scenarios[i][1];
    try {
      await fn();
      check('scenario:' + name, true);
    } catch (error) {
      check('scenario:' + name, false, { error: String(error && error.stack ? error.stack : error) });
    }
  }
  return { ok: checks.every(function (c) { return c.ok; }), format: 'r91-composer-caret-chromium-v1', checks: checks, facts: facts };
};
`;

const MAIN_SOURCE = String.raw`
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async function () {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 900,
    webPreferences: {
      backgroundThrottling: false,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('console-message', function (_event, level, message) {
    console.log('[renderer:' + level + '] ' + message);
  });
  try {
    await win.loadFile(path.join(__dirname, 'index.html'));
    const result = await win.webContents.executeJavaScript('window.__r91Run()', true);
    console.log('R91_RESULT_BEGIN');
    console.log(JSON.stringify(result));
    console.log('R91_RESULT_END');
    app.exit(result && result.ok ? 0 : 1);
  } catch (error) {
    console.log('R91_RESULT_BEGIN');
    console.log(JSON.stringify({ ok: false, format: 'r91-composer-caret-chromium-v1', checks: [{ name: 'harnessError', ok: false, detail: String(error && error.stack ? error.stack : error) }], facts: {} }));
    console.log('R91_RESULT_END');
    app.exit(2);
  }
});
setTimeout(function () {
  console.log('R91_RESULT_BEGIN');
  console.log(JSON.stringify({ ok: false, format: 'r91-composer-caret-chromium-v1', checks: [{ name: 'harnessTimeout', ok: false }], facts: {} }));
  console.log('R91_RESULT_END');
  app.exit(3);
}, 150000);
`;

const INDEX_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>R91 composer caret verifier</title>
<style>
  html, body { margin: 0; padding: 0; font: 14px/1.5 "Microsoft YaHei", sans-serif; }
  #root { padding: 12px; width: 980px; }
  .composer { border: 1px solid #ddd; padding: 8px; }
  .composer-box { position: relative; }
  .composer-editor { height: 54px; max-height: 200px; overflow: auto; white-space: pre-wrap; outline: none;
    border: 1px solid #ccc; padding: 4px; box-sizing: border-box; }
  .composer-file-token { display: inline-flex; gap: 4px; align-items: center; background: #eef; border: 1px solid #99c;
    border-radius: 8px; padding: 0 4px; margin: 0 2px; }
  .composer-file-token.is-ready { background: #e8f7ec; }
  .composer-file-token button { cursor: pointer; }
  .mention-pop { border: 1px solid #ccc; background: #fff; padding: 4px; }
  .menu-item { display: block; width: 100%; text-align: left; }
</style>
</head>
<body>
<div id="root"></div>
<script src="./harness.js"></script>
</body>
</html>
`;

function writeFixtures() {
  fs.mkdirSync(fixtureDir, { recursive: true });
  const composerSpec = specifierFromFixture(path.join(sourceRoot, 'ui', 'hifi', 'components', 'Composer'));
  const storeSpec = specifierFromFixture(path.join(sourceRoot, 'ui', 'hifi', 'data', 'store'));
  const harness = HARNESS_SOURCE.replace('__R91_COMPOSER__', composerSpec).replace('__R91_STORE__', storeSpec);
  fs.writeFileSync(path.join(fixtureDir, 'harness.tsx'), harness, 'utf8');
  fs.writeFileSync(path.join(fixtureDir, 'index.html'), INDEX_HTML, 'utf8');
  fs.writeFileSync(path.join(fixtureDir, 'main.cjs'), MAIN_SOURCE, 'utf8');
}

function specifierFromFixture(target) {
  const relative = path.relative(fixtureDir, target).split(path.sep).join('/');
  return relative.startsWith('.') ? relative : './' + relative;
}

function parseResult(stdout) {
  const begin = stdout.indexOf('R91_RESULT_BEGIN');
  const end = stdout.indexOf('R91_RESULT_END');
  if (begin < 0 || end < 0 || end <= begin) return null;
  const raw = stdout.slice(begin + 'R91_RESULT_BEGIN'.length, end).trim();
  try { return JSON.parse(raw); } catch { return null; }
}

async function runVerifier() {
  writeFixtures();
  const esbuild = require('esbuild');
  await esbuild.build({
    entryPoints: [path.join(fixtureDir, 'harness.tsx')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    sourcemap: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    outfile: path.join(fixtureDir, 'harness.js'),
  });

  const electronPath = require('electron');
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
  const started = Date.now();
  const run = spawnSync(electronPath, [path.join(fixtureDir, 'main.cjs')], {
    cwd: root, env: env, encoding: 'utf8', timeout: 180000,
  });
  const elapsedMs = Date.now() - started;
  const stdout = run.stdout || '';
  const stderr = run.stderr || '';
  let result = parseResult(stdout);
  const report = result == null
    ? { ok: false, format: 'r91-composer-caret-chromium-v1', checks: [{ name: 'hostError', ok: false, detail: (stderr || stdout).slice(-4000) }], facts: { exitCode: run.status, error: run.error ? String(run.error) : null } }
    : Object.assign({}, result, { elapsedMs: elapsedMs, exitCode: run.status });
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, JSON.stringify(report, null, 2), 'utf8');
  const failures = (report.checks || []).filter(function (c) { return !c.ok; });
  console.log(JSON.stringify({ ok: report.ok, totalChecks: (report.checks || []).length, failures: failures, resultPath: resultPath, elapsedMs: elapsedMs, exitCode: run.status }, null, 2));
  if (!report.ok) {
    const rendererLog = stdout.split('\n').filter(function (line) { return line.indexOf('[renderer:') === 0 || line.indexOf('R91_CHECK_FAIL') === 0; }).slice(-80).join('\n');
    if (rendererLog.length > 0) console.log(rendererLog);
    if (stderr.length > 0) console.log('[electron stderr tail]\n' + stderr.slice(-4000));
  }
  return report;
}

async function cli() {
  const report = await runVerifier();
  process.exitCode = report.ok ? 0 : 1;
}

if (require.main === module) {
  cli().catch(function (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = { runVerifier: runVerifier };

