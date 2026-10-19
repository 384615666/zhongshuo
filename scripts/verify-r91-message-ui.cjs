/*
 * R91 模块3：协作阶段消息 + 生成文件卡 UI 证据脚本。
 *
 * 方式：隐藏 Electron BrowserWindow（show:false）+ 实际 React MessageView + 实际 loader
 * （thread.history / conversation.history 由本脚本的合成 fixture 经 window.zs 注入）。
 * 不打开可见窗口、不碰鼠标键盘剪贴板、不读取真实用户数据。
 *
 * 用法：node scripts/verify-r91-message-ui.cjs [--out <dir>]
 * 产物：<out>/result.json、<out>/rendered.html、<out>/screenshot.png（若能截取）
 *
 * 期望结果：所有 check 通过时退出码 0；任何 UI 断言失败退出码 1。
 */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { build } = require('esbuild');

const repoRoot = path.resolve(__dirname, '..');
const outArgIndex = process.argv.indexOf('--out');
const outDir = path.resolve(outArgIndex > 0 && process.argv[outArgIndex + 1] != null
  ? process.argv[outArgIndex + 1]
  : path.join(repoRoot, 'dist', 'review-r91-message-ui-20261019'));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-r91-message-ui-'));

const slash = (p) => p.replace(/\\/g, '/');
const fileUrl = (relative) => slash(path.resolve(repoRoot, relative));

function electronExecutable() {
  try {
    const resolved = require('electron');
    if (typeof resolved === 'string' && resolved.length > 0) return resolved;
  } catch { /* fall through to path.txt */ }
  const pathFile = path.join(repoRoot, 'node_modules', 'electron', 'path.txt');
  if (fs.existsSync(pathFile)) {
    const name = fs.readFileSync(pathFile, 'utf8').trim();
    return path.join(repoRoot, 'node_modules', 'electron', 'dist', name);
  }
  throw new Error('Electron 不可用：node_modules/electron 未安装或 path.txt 缺失');
}

/** 合成 fixture：只使用自建材料，不含真实用户文件/截图/业务文字。 */
function fixture() {
  const now = 1760000000000;
  const members = [
    { id: 'member_a', displayName: '成员甲', ordinal: 1 },
    { id: 'member_b', displayName: '成员乙', ordinal: 2 },
    { id: 'member_host', displayName: '主持人', ordinal: 3 },
  ];
  const stage = (stageName, roundNo) => ({ stage: stageName, roundNo, turnId: 'turn_fixture_' + stageName.toLowerCase(), runId: 'run_fixture_r91' });
  const attachments = [
    { artifactId: 'art_xlsx', filename: '季度分析总表-华东大区-2026年第三季度-最终版.xlsx', kind: 'sheet_file', sizeBytes: 24576 },
    { artifactId: 'art_csv', filename: '逐条明细.csv', kind: 'sheet_file' },
    { artifactId: 'art_docx', filename: '评审纪要.docx', kind: 'docx_file' },
    { artifactId: 'art_pdf', filename: '对账单.pdf', kind: 'pdf_file' },
    { artifactId: 'art_txt', filename: '验收说明.txt', kind: 'text_file' },
    { artifactId: 'art_xlsx', filename: '重复登记的同一文件.xlsx', kind: 'sheet_file' },
    { artifactId: 'art_bin', filename: '历史导出.bin', kind: 'unsupported_file' },
  ];
  const threadHistory = {
    rootAttachments: [],
    items: [
      { id: 'msg_stage_ind', authorType: 'agent', authorId: 'member_a', seq: 2, createdAt: now + 1000, attachments: [], body: { text: '【独立分析】\n独立分析正文：先核对数据口径，再给出两条结论。', collaborationStage: stage('INDEPENDENT', 0) } },
      { id: 'msg_old', authorType: 'agent', authorId: 'member_a', seq: 3, createdAt: now + 2000, attachments: [], body: { text: '早期普通回复（没有阶段标记，也没有附件）。' } },
      { id: 'msg_stage_review', authorType: 'agent', authorId: 'member_b', seq: 4, createdAt: now + 3000, attachments: [], body: { text: '【互评】\n复核意见：同意结论一，结论二需要补充证据。', collaborationStage: stage('CROSS_REVIEW', 0) } },
      { id: 'msg_stage_issue', authorType: 'agent', authorId: 'member_b', seq: 5, createdAt: now + 3500, attachments: [], body: { text: '【争议讨论 · 第2轮】\n争议「数据口径」：需要补充证据 — 建议先复核来源。', collaborationStage: stage('ISSUE_DISCUSSION', 2) } },
      { id: 'msg_stage_synth', authorType: 'agent', authorId: 'member_host', seq: 6, createdAt: now + 4000, attachments, body: { text: '【整合】\n汇总如下。\n\n参考路径 D:\\zhongshuo\\secret\\report.xlsx 只是正文文字，不是文件。', collaborationStage: stage('SYNTHESIS', 0) } },
    ],
  };
  const dmHistory = {
    messages: [
      { id: 'dm_msg_human', conversation_seq: 1, author_type: 'human', author_id: 'u_local', created_at: now, attachments: [], body_json: JSON.stringify({ text: '请给出独立分析和互评。' }) },
      { id: 'dm_msg_ind', conversation_seq: 2, author_type: 'agent', author_id: 'member_a', created_at: now + 1000, attachments: [], body_json: JSON.stringify({ text: '【独立分析】\n私信独立分析正文。', collaborationStage: stage('INDEPENDENT', 0) }) },
      { id: 'dm_msg_synth', conversation_seq: 3, author_type: 'agent', author_id: 'member_host', created_at: now + 2000, attachments: [{ artifactId: 'art_dm_pdf', filename: '私信附件-对账单.pdf', kind: 'pdf_file' }], body_json: JSON.stringify({ text: '【整合】\n私信汇总正文。', collaborationStage: stage('SYNTHESIS', 0) }) },
    ],
  };
  return {
    members,
    threadGet: {
      thread: { id: 'th_r91', projectId: 'proj_r91', conversationId: 'conv_r91', roomId: 'room_r91', anchorMessageId: 'msg_root', rootTaskId: null, status: 'open', lastMessageSeq: 6, revision: 1 },
      anchor: { id: 'msg_root', authorType: 'human', authorId: 'u_local', body: { text: '请完成本轮研讨与汇总。' }, createdAt: now, conversationSeq: 1, attachments: [] },
      lastReadSeq: 0,
      progress: [],
      members: { projectId: 'proj_r91', threadId: 'th_r91', roomId: 'room_r91', version: 'v1', memberIds: ['member_a', 'member_b', 'member_host'], eligibleMemberIds: ['member_a', 'member_b', 'member_host'], runningMemberIds: [] },
    },
    threadHistory,
    dmHistory,
    responses: {
      'thread.get': null,
      'thread.history': threadHistory,
      'conversation.history': dmHistory,
    },
  };
}

/** 渲染进程入口（esbuild 打包）。只用 createElement，避免模板字符串与主脚本转义冲突。 */
function rendererEntry() {
  const messageView = fileUrl('src/ui/hifi/components/MessageView.tsx');
  const loader = fileUrl('src/ui/hifi/loader.ts');
  const store = fileUrl('src/ui/hifi/data/store.ts');
  return [
    "import { createElement } from 'react';",
    "import { createRoot } from 'react-dom/client';",
    'import { MessageView } from "' + messageView + '";',
    'import { loadThread, loadDmHistory } from "' + loader + '";',
    'import { getState, setState } from "' + store + '";',
    '',
    'const F = window.__R91_FIXTURES;',
    'const memberById = new Map(F.members.map(function (m) { return [m.id, m]; }));',
    '',
    'function Harness(props) {',
    '  return createElement("div", { className: "msg-list", "data-zs-harness": props.harness, style: { width: "340px", padding: "8px", boxSizing: "border-box" } },',
    '    props.messages.map(function (m) {',
    '      return createElement(MessageView, { key: m.id, message: m, author: memberById.get(m.authorId), onOpenAttachment: props.onOpen, onSave: function () {}, onQuote: function () {} });',
    '    }));',
    '}',
    'function mount(container, messages, onOpen, harness) {',
    '  const root = createRoot(container);',
    '  root.render(createElement(Harness, { messages: messages, onOpen: onOpen, harness: harness }));',
    '  return root;',
    '}',
    'function nextFrames() {',
    '  return new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(function () { setTimeout(resolve, 30); }); }); });',
    '}',
    'function text(el) { return el == null ? "" : String(el.textContent || ""); }',
    'function before(a, b) { return !!(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)); }',
    '',
    'window.__r91 = async function () {',
    '  const checks = [];',
    '  const errors = [];',
    '  function check(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: detail == null ? "" : String(detail) }); }',
    '  window.addEventListener("error", function (e) { errors.push(String(e.message || e.error)); });',
    '  window.addEventListener("unhandledrejection", function (e) { errors.push("unhandled: " + String(e.reason)); });',
    '  const hashBefore = window.location.hash;',
    '  const fixtures = F.responses;',
    '  window.zs = {',
    '    command: async function (env) {',
    '      const data = fixtures[env.method];',
    '      if (data === undefined || data === null) return { ok: false, error: { code: "RESOURCE_NOT_FOUND", message: "synthetic fixture missing: " + env.method } };',
    '      return { ok: true, data: JSON.parse(JSON.stringify(data)) };',
    '    },',
    '    pickFolder: async function () { return null; },',
    '    openPath: async function () { return ""; },',
    '    onDisconnect: function () {},',
    '    onReconnected: function () {},',
    '  };',
    '  const human = { id: "u_local", displayName: "我", ordinal: 0 };',
    '  setState(function (s) { return Object.assign({}, s, {',
    '    activeProjectId: "proj_r91", loadGen: 0, members: F.members, rooms: [{ id: "room_r91", projectId: "proj_r91", name: "合成研讨房", coordinatorMemberId: "member_host", memberIds: ["member_a", "member_b", "member_host"], revision: 1, unread: 0 }],',
    '    dms: [{ id: "conv_dm_r91", projectId: "proj_r91", peerDisplayName: "成员甲", title: "", unread: 0, memberIds: [], threadId: "", createdAt: 0, lastMessageAt: 0, execState: "idle" }],',
    '    threadEntities: {}, threadAnchors: {}, threadMessages: {}, threadTasks: {}, threadReadSeq: {}, readErrors: {}, dmHistory: {}, resources: [], messageAttachments: [], savedMessageRefs: {}',
    '  }); });',
    '  await loadThread("th_r91");',
    '  const threadMessages = getState().threadMessages["th_r91"] || [];',
    '  await loadDmHistory("conv_dm_r91");',
    '  const dmMessages = getState().dmHistory["conv_dm_r91"] || [];',
    '',
    '  const threadRoot = document.getElementById("thread-root");',
    '  const dmRoot = document.getElementById("dm-root");',
    '  const openCalls = [];',
    '  const onOpen = function (att) { openCalls.push({ artifactId: att.artifactId, filename: att.filename, kind: att.kind, phase: openCalls.length }); };',
    '  mount(threadRoot, threadMessages, onOpen, "thread");',
    '  mount(dmRoot, dmMessages, onOpen, "dm");',
    '  await nextFrames();',
    '',
    '  check("loader thread: stage markers mapped", threadMessages.filter(function (m) { return m.collaborationStage != null; }).length === 4, JSON.stringify(threadMessages.map(function (m) { return [m.id, m.collaborationStage || null]; })));',
    '  check("loader thread: natural body only (no metadata JSON)", threadMessages.every(function (m) { return m.body.indexOf("collaborationStage") < 0 && m.body.indexOf("{") < 0; }));',
    '  check("loader thread: backend 【阶段】 heading removed (label shown once)", threadMessages.every(function (m) { return m.body.indexOf("【") < 0; }), JSON.stringify(threadMessages.map(function (m) { return m.body.slice(0, 18); })));',
    '  check("loader thread: order by real seq", threadMessages.map(function (m) { return m.threadMessageSeq; }).join(",") === "2,3,4,5,6", threadMessages.map(function (m) { return m.threadMessageSeq; }).join(","));',
    '  check("loader dm: body_json metadata mapped", dmMessages.filter(function (m) { return m.collaborationStage != null; }).length === 2, JSON.stringify(dmMessages.map(function (m) { return [m.id, m.collaborationStage || null]; })));',
    '  check("loader dm: body text is parsed text, not raw JSON", dmMessages.every(function (m) { return m.body.indexOf("body_json") < 0 && m.body.indexOf("collaborationStage") < 0 && m.body.indexOf("【") < 0; }));',
    '',
    '  const threadText = text(threadRoot);',
    '  check("stage label: 独立分析", threadText.indexOf("独立分析") >= 0);',
    '  check("stage label: 互评", threadText.indexOf("互评") >= 0);',
    '  check("stage label: 分歧讨论 · 第2轮 (existing stageLabel mapping)", threadText.indexOf("分歧讨论") >= 0 && threadText.indexOf("第2轮") >= 0);',
    '  check("stage label: 整合", threadText.indexOf("整合") >= 0);',
    '  check("no 第0轮 for stage-level products", threadText.indexOf("第0轮") < 0);',
    '  check("stage tags rendered once per stage message", threadRoot.querySelectorAll(".msg-stage-tag").length === 4, String(threadRoot.querySelectorAll(".msg-stage-tag").length));',
    '  check("each stage label appears once (tag only, no backend heading duplicate)", threadText.split("互评").length - 1 === 1 && threadText.split("整合").length - 1 === 1, "互评=" + (threadText.split("互评").length - 1) + ", 整合=" + (threadText.split("整合").length - 1));',
    '  check("no raw stage enum / turnId / runId in visible UI", ["INDEPENDENT", "CROSS_REVIEW", "ISSUE_DISCUSSION", "SYNTHESIS", "collaborationStage", "turn_fixture", "run_fixture"].every(function (needle) { return threadText.indexOf(needle) < 0; }));',
    '',
    '  const stageInd = Array.from(threadRoot.querySelectorAll(".msg")).find(function (el) { return text(el).indexOf("独立分析正文") >= 0; });',
    '  const stageReview = Array.from(threadRoot.querySelectorAll(".msg")).find(function (el) { return text(el).indexOf("复核意见") >= 0; });',
    '  const stageSynth = Array.from(threadRoot.querySelectorAll(".msg")).find(function (el) { return text(el).indexOf("汇总如下") >= 0; });',
    '  check("real author on 独立分析", stageInd != null && text(stageInd).indexOf("成员甲") >= 0 && text(stageInd).indexOf("未知成员") < 0);',
    '  check("real author on 互评", stageReview != null && text(stageReview).indexOf("成员乙") >= 0 && text(stageReview).indexOf("未知成员") < 0);',
    '  check("real author on 整合", stageSynth != null && text(stageSynth).indexOf("主持人") >= 0);',
    '  check("no nested message bubbles", threadRoot.querySelectorAll(".msg .msg").length === 0, String(threadRoot.querySelectorAll(".msg .msg").length));',
    '',
    '  const body = stageSynth && stageSynth.querySelector(".msg-text");',
    '  const attachmentsBox = stageSynth && stageSynth.querySelector(".msg-inline-attachments");',
    '  const actions = stageSynth && stageSynth.querySelector(".msg-actions");',
    '  check("attachment cards exist under AI reply", attachmentsBox != null);',
    '  check("attachment cards after body text", before(body, attachmentsBox));',
    '  check("attachment cards before copy/quote/favorite", before(attachmentsBox, actions));',
    '  check("attachment cards are not the first block of the body", stageSynth != null && attachmentsBox != null && body != null && attachmentsBox.previousElementSibling === body);',
    '  const chips = attachmentsBox == null ? [] : Array.from(attachmentsBox.querySelectorAll("[data-zs-artifact-id]"));',
    '  check("multi-file: 6 unique formal attachments rendered", chips.length === 6, String(chips.length));',
    '  check("duplicate artifactId is not rendered twice", chips.filter(function (c) { return c.getAttribute("data-zs-artifact-id") === "art_xlsx"; }).length === 1);',
    '  check("long Chinese filename present once", (threadText.match(/季度分析总表-华东大区-2026年第三季度-最终版\\.xlsx/g) || []).length === 1);',
    '  check("attachment kind labels visible (表格/Word/PDF/文本)", ["表格", "Word", "PDF", "文本"].every(function (label) { return text(attachmentsBox).indexOf(label) >= 0; }));',
    '  check("unsupported kind uses 文件 fallback, not raw enum", text(attachmentsBox).indexOf("文件") >= 0 && text(attachmentsBox).indexOf("unsupported_file") < 0);',
    '  check("optional size shown only when provided", text(attachmentsBox).indexOf("24 KB") >= 0);',
    '  check("absolute path in body stays plain text, not a file card", threadText.indexOf("D:\\\\zhongshuo\\\\secret\\\\report.xlsx") >= 0 && chips.every(function (c) { return text(c).indexOf("report.xlsx") < 0; }));',
    '  const longChip = chips.find(function (c) { return text(c).indexOf("季度分析总表") >= 0; });',
    '  const trunc = longChip && longChip.querySelector(".truncate");',
    '  check("long Chinese filename truncates inside the chip", trunc != null && getComputedStyle(trunc).textOverflow === "ellipsis" && longChip.getBoundingClientRect().width <= 340);',
    '  check("narrow container has no horizontal overflow", threadRoot.scrollWidth <= threadRoot.clientWidth + 1, threadRoot.scrollWidth + "/" + threadRoot.clientWidth);',
    '',
    '  let clickOk = true;',
    '  const clickDetail = [];',
    '  for (const chip of chips) {',
    '    const artifactId = chip.getAttribute("data-zs-artifact-id");',
    '    const beforeCount = openCalls.length;',
    '    chip.click();',
    '    const last = openCalls[openCalls.length - 1];',
    '    const ok = openCalls.length === beforeCount + 1 && last != null && last.artifactId === artifactId && String(last.filename || "").length > 0;',
    '    if (!ok) { clickOk = false; clickDetail.push(artifactId + " -> " + JSON.stringify(last || null)); }',
    '  }',
    '  check("every attachment card click calls the open channel once", clickOk, clickDetail.join("; "));',
    '  check("unsupported preview file still opens through same channel", openCalls.some(function (c) { return c.artifactId === "art_bin" && c.kind === "unsupported_file"; }));',
    '',
    '  const oldMessage = Array.from(threadRoot.querySelectorAll(".msg")).find(function (el) { return text(el).indexOf("早期普通回复") >= 0; });',
    '  check("old message without attachments shows no file card", oldMessage != null && oldMessage.querySelectorAll(".msg-inline-attachments").length === 0);',
    '',
    '  const dmText = text(dmRoot);',
    '  check("DM stage labels (no 第0轮)", dmText.indexOf("独立分析") >= 0 && dmText.indexOf("整合") >= 0 && dmText.indexOf("第0轮") < 0);',
    '  check("DM real author", dmText.indexOf("成员甲") >= 0 && dmText.indexOf("主持人") >= 0);',
    '  const dmChips = Array.from(dmRoot.querySelectorAll("[data-zs-artifact-id]"));',
    '  check("DM attachment card rendered/clickable", dmChips.length === 1 && text(dmChips[0]).indexOf("私信附件-对账单.pdf") >= 0);',
    '  dmChips[0].click();',
    '  check("DM attachment click calls open channel", openCalls[openCalls.length - 1] != null && openCalls[openCalls.length - 1].artifactId === "art_dm_pdf");',
    '',
    '  const beforeReopen = threadMessages.length;',
    '  await loadThread("th_r91");',
    '  const afterReopen = (getState().threadMessages["th_r91"] || []).length;',
    '  await loadDmHistory("conv_dm_r91");',
    '  const dmAfterReopen = (getState().dmHistory["conv_dm_r91"] || []).length;',
    '  check("thread reopen: same messages, no duplicates", afterReopen === beforeReopen, beforeReopen + " -> " + afterReopen);',
    '  check("DM reopen: same messages, no duplicates", dmAfterReopen === dmMessages.length, dmMessages.length + " -> " + dmAfterReopen);',
    '  check("reopen keeps stage marker", (getState().threadMessages["th_r91"] || []).some(function (m) { return m.collaborationStage != null && m.collaborationStage.stage === "CROSS_REVIEW"; }));',
    '  check("no forced page switch", window.location.hash === hashBefore, hashBefore + " -> " + window.location.hash);',
    '  check("no renderer errors", errors.length === 0, errors.join(" | "));',
    '',
    '  return {',
    '    ok: checks.every(function (c) { return c.ok; }),',
    '    checks: checks,',
    '    openCalls: openCalls,',
    '    stats: { threadMessages: threadMessages.length, dmMessages: dmMessages.length, chips: chips.length, stageTags: threadRoot.querySelectorAll(".msg-stage-tag").length },',
    '    threadHtml: threadRoot.innerHTML,',
    '    dmHtml: dmRoot.innerHTML,',
    '    generatedAt: new Date().toISOString(),',
    '  };',
    '};',
  ].join('\n');
}

function mainScript() {
  return [
    "'use strict';",
    "const { app, BrowserWindow } = require('electron');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    // QA 隔离：本脚本可能与其它隐藏 Electron 验证同时运行；必须使用自己 temp 内的
    // 唯一 userData/sessionData，绝不碰用户默认 Electron profile，避免跨实例
    // cache move/access denied。必须在 whenReady 之前设置。
    "const profileRoot = process.env.ZS_R91_PROFILE_DIR;",
    "if (profileRoot) {",
    "  const userData = path.join(profileRoot, 'user-data');",
    "  const sessionData = path.join(profileRoot, 'session-data');",
    "  fs.mkdirSync(userData, { recursive: true });",
    "  fs.mkdirSync(sessionData, { recursive: true });",
    "  app.setPath('userData', userData);",
    "  app.setPath('sessionData', sessionData);",
    "  app.commandLine.appendSwitch('disk-cache-dir', path.join(profileRoot, 'disk-cache'));",
    "}",
    'app.disableHardwareAcceleration();',
    "app.commandLine.appendSwitch('no-sandbox');",
    "app.commandLine.appendSwitch('disable-gpu');",
    "app.commandLine.appendSwitch('disable-software-rasterizer');",
    "process.on('uncaughtException', function (e) {",
    '  try { fs.writeFileSync(process.env.ZS_R91_RESULT, JSON.stringify({ ok: false, error: String(e && e.stack || e) })); } catch {}',
    '  app.exit(1);',
    '});',
    'app.whenReady().then(async function () {',
    '  const win = new BrowserWindow({',
    '    show: false, width: 1100, height: 900,',
    '    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, sandbox: false },',
    '  });',
    '  win.webContents.on("render-process-gone", function (_e, details) {',
    '    try { fs.writeFileSync(process.env.ZS_R91_RESULT, JSON.stringify({ ok: false, error: "render-process-gone: " + JSON.stringify(details) })); } catch {}',
    '    app.exit(1);',
    '  });',
    '  try {',
    '    await win.loadFile(process.env.ZS_R91_HTML);',
    '    const value = await win.webContents.executeJavaScript("window.__r91()");',
    '    fs.writeFileSync(process.env.ZS_R91_RESULT, JSON.stringify(value, null, 2), "utf8");',
    '    try {',
    '      const image = await win.webContents.capturePage();',
    '      fs.writeFileSync(process.env.ZS_R91_PNG, image.toPNG());',
    '    } catch (e) { fs.writeFileSync(process.env.ZS_R91_PNG_ERROR, String(e)); }',
    '    app.exit(value && value.ok ? 0 : 1);',
    '  } catch (e) {',
    '    try { fs.writeFileSync(process.env.ZS_R91_RESULT, JSON.stringify({ ok: false, error: String(e && e.stack || e) })); } catch {}',
    '    app.exit(1);',
    '  }',
    '});',
  ].join('\n');
}

function writeInputs(data) {
  fs.writeFileSync(path.join(tempDir, 'renderer-entry.ts'), rendererEntry(), 'utf8');
  fs.writeFileSync(path.join(tempDir, 'main.cjs'), mainScript(), 'utf8');
  // 与 scripts/build-ui.mjs 相同的样式拼接顺序——让隔离页面的卡片/标签排版与应用一致。
  const styleSource = ['tokens.css', 'base.css', 'components.css', 'preview.css', 'titlebar.css', 'h1-overrides.css']
    .map((name) => fs.readFileSync(path.join(repoRoot, 'src', 'ui', 'hifi', 'styles', name), 'utf8'))
    .join('\n')
    .replace(/<\/style/gi, '<\\/style');
  fs.writeFileSync(path.join(tempDir, 'index.html'), [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>R91 message UI fixture</title>',
    '<style>',
    styleSource,
    '.r91-wrap{display:flex;gap:16px;padding:12px;align-items:flex-start;}',
    '.r91-pane{border:1px solid #d1d5db;border-radius:8px;overflow:hidden;}',
    '.r91-pane h2{font-size:12px;margin:0;padding:4px 8px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;font-weight:600;}',
    '</style></head><body>',
    '<div class="r91-wrap"><section class="r91-pane"><h2>线程回复串</h2><div id="thread-root"></div></section>',
    '<section class="r91-pane"><h2>私信会话</h2><div id="dm-root"></div></section></div>',
    '<script>window.__R91_FIXTURES = ' + JSON.stringify(data).replace(/</g, '\\u003c') + ';</script>',
    '<script src="./renderer.js"></script>',
    '</body></html>',
  ].join('\n'), 'utf8');
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const data = fixture();
  data.responses['thread.get'] = data.threadGet;
  writeInputs(data);
  const built = build({
    entryPoints: [path.join(tempDir, 'renderer-entry.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    absWorkingDir: repoRoot,
    nodePaths: [path.join(repoRoot, 'node_modules')],
    outfile: path.join(tempDir, 'renderer.js'),
    jsx: 'automatic',
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    define: { 'process.env.NODE_ENV': '"production"' },
    sourcemap: false,
    logLevel: 'silent',
  });
  await built;

  const resultPath = path.join(tempDir, 'result.json');
  const screenshotPath = path.join(tempDir, 'screenshot.png');
  const screenshotErrorPath = path.join(tempDir, 'screenshot.error.txt');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {
    ZS_R91_RESULT: resultPath,
    ZS_R91_HTML: path.join(tempDir, 'index.html'),
    ZS_R91_PNG: screenshotPath,
    ZS_R91_PNG_ERROR: screenshotErrorPath,
    ZS_R91_PROFILE_DIR: path.join(tempDir, 'electron-profile'),
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
  });
  const child = spawnSync(electronExecutable(), [path.join(tempDir, 'main.cjs')], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    timeout: 180000,
  });

  let result;
  if (fs.existsSync(resultPath)) {
    try { result = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch (e) { result = { ok: false, error: 'result.json 解析失败：' + String(e) }; }
  } else {
    result = {
      ok: false,
      error: 'Electron 未产出结果（exit=' + child.status + (child.signal != null ? ' signal=' + child.signal : '') + '）',
    };
  }
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  if (fs.existsSync(screenshotPath)) {
    fs.copyFileSync(screenshotPath, path.join(outDir, 'screenshot.png'));
  }
  const htmlParts = [];
  if (typeof result.threadHtml === 'string') htmlParts.push('<section><h2>线程回复串</h2>' + result.threadHtml + '</section>');
  if (typeof result.dmHtml === 'string') htmlParts.push('<section><h2>私信会话</h2>' + result.dmHtml + '</section>');
  fs.writeFileSync(path.join(outDir, 'rendered.html'), [
    '<!doctype html><html><head><meta charset="utf-8"><title>R91 rendered evidence</title></head><body>',
    htmlParts.join('\n'),
    '</body></html>',
  ].join('\n'), 'utf8');

  const checks = Array.isArray(result.checks) ? result.checks : [];
  for (const check of checks) {
    console.log((check.ok ? 'PASS ' : 'FAIL ') + check.name + (check.ok || check.detail == null || check.detail === '' ? '' : ' — ' + check.detail));
  }
  if (result.error != null) console.error('ERROR: ' + result.error);
  console.log('evidence: ' + outDir);
  console.log('electron exit: ' + child.status + '；checks ' + checks.filter((c) => c.ok).length + '/' + checks.length);
  if (result.ok !== true) process.exitCode = 1;
}

main().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
