#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
'use strict';

/*
 * R92 candidate package acceptance (daemon-only, synthetic).
 *
 * Usage:
 *   node scripts/verify-r92-package.cjs --package <candidate-dir> [--out <evidence-dir>] [--keep-copy]
 *
 * Safety:
 *   - The candidate is read only. All daemon/database work happens in a fresh temp copy.
 *   - No real runtime is created. A synthetic in-process adapter is injected into the
 *     packaged daemon's startDaemon(), and ZS_REAL_DISPATCH_GUARD=1 remains active.
 *   - Business commands are sent through the packaged daemon's real named-pipe command
 *     surface. message.submit is used for both scenarios.
 *   - No GUI, Electron, model CLI, commit, push, build, or package write occurs.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const schemaVersion = 'r92-package-verification-v1';
const requiredGates = [
  'sourceLayout',
  'sourceNotTouched',
  'buildIdentity',
  'manifest',
  'noForbiddenTestData',
  'sameBuildIsolatedDaemon',
  'handoffScenario',
  'noHandoffScenario',
  'repeatDrain',
  'reopenPersistence',
  'realCallsZero',
  'commandSurface',
];
const protectedPaths = [
  path.join(repoRoot, 'design-shootout', 'thread-message-redesign'),
  path.join(repoRoot, 'dbg-out.txt'),
  path.join(repoRoot, 'dbg-out2.txt'),
  path.join(repoRoot, 'dbg.err'),
  path.join(repoRoot, 'dbg.out'),
  path.join(repoRoot, '.codex-bridge-test'),
  path.join(repoRoot, '.codex-deepseek'),
  path.join(repoRoot, '.tmp-design'),
  path.join(repoRoot, '{console.error(e)'),
];

const HANDOFF_BODY = 'R92 合成短消息：请两位成员分别核对短样例，B 向协调者 A 回复复核结果。';
const NO_HANDOFF_BODY = 'R92 合成短消息：请两位成员分别回答，不需要互相转交。';
const A_ANSWER = 'R92-A 合成结果：短样例已核对。';
const B_ANSWER = 'R92-B 合成结果：短样例已核对。';
const B_REPLY = 'R92-B 向协调者 A 的 deferred reply：短样例复核完成。';
const INTEGRATION_ANSWER = 'R92-A 整合答复：两位成员的结果均已收齐，可读答复已完成。';

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count <= 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isSameOrInside(child, parent) {
  const from = path.resolve(parent);
  const to = path.resolve(child);
  const relative = path.relative(from, to);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function json(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorFacts(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? error.message,
      cause: error.cause == null ? null : String(error.cause),
    };
  }
  return { name: typeof error, message: String(error), stack: String(error), cause: null };
}

function compact(value, max = 16_000) {
  const text = typeof value === 'string' ? value : json(value);
  return text.length > max ? text.slice(0, max) + `…<truncated ${text.length - max} chars>` : text;
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unknown argument: ${token}`);
    const key = token.slice(2);
    if (key === 'keep-copy') {
      flags.add(key);
      continue;
    }
    if (key !== 'package' && key !== 'out') throw new Error(`unknown option: --${key}`);
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) throw new Error(`option --${key} requires a value`);
    values.set(key, value);
    index += 1;
  }
  if (!values.has('package')) throw new Error('--package <candidate-dir> is required');
  return {
    help: false,
    packageArg: values.get('package'),
    outArg: values.get('out') ?? 'dist/review-r92-package-20261019',
    keepCopy: flags.has('keep-copy'),
  };
}

function assertSafeInputs(sourceRoot, outDir) {
  for (const protectedPath of protectedPaths) {
    if (isSameOrInside(protectedPath, sourceRoot) || isSameOrInside(sourceRoot, protectedPath)) {
      throw new Error(`candidate path overlaps protected path: ${sourceRoot} <-> ${protectedPath}`);
    }
    if (isSameOrInside(outDir, protectedPath)) {
      throw new Error(`evidence path is inside protected path: ${outDir} <-> ${protectedPath}`);
    }
  }
  if (isSameOrInside(outDir, sourceRoot)) {
    throw new Error(`evidence path must not be inside the candidate package: ${outDir}`);
  }
}

function isPackageRoot(directory) {
  return fs.existsSync(path.join(directory, 'BUILD.json'))
    && fs.existsSync(path.join(directory, 'MANIFEST-SHA256.json'))
    && fs.existsSync(path.join(directory, 'resources', 'app', 'daemon', 'daemon.cjs'));
}

function locatePackageRoot(candidateRoot) {
  if (!fs.existsSync(candidateRoot) || !fs.statSync(candidateRoot).isDirectory()) {
    throw new Error(`candidate directory does not exist: ${candidateRoot}`);
  }
  if (isPackageRoot(candidateRoot)) {
    return { sourceRoot: candidateRoot, packageRoot: candidateRoot, packageRelative: '' };
  }
  const knownNames = ['ZhongshuoDual', 'ZhongshuoDuo', '众说-便携-win-x64'];
  const found = [];
  for (const name of knownNames) {
    const directory = path.join(candidateRoot, name);
    if (isPackageRoot(directory)) found.push(directory);
  }
  for (const entry of fs.readdirSync(candidateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || knownNames.includes(entry.name)) continue;
    const directory = path.join(candidateRoot, entry.name);
    if (isPackageRoot(directory)) found.push(directory);
  }
  const unique = [...new Map(found.map((item) => [path.resolve(item), item])).values()];
  if (unique.length === 0) {
    throw new Error('candidate does not contain a package root with BUILD.json, MANIFEST-SHA256.json and resources/app/daemon/daemon.cjs');
  }
  if (unique.length > 1) {
    throw new Error(`candidate contains multiple package roots; specify one directly: ${unique.join(', ')}`);
  }
  return {
    sourceRoot: candidateRoot,
    packageRoot: unique[0],
    packageRelative: path.relative(candidateRoot, unique[0]),
  };
}

function forbiddenReason(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'server-data') return 'server-data directory';
    if (lower === 'fixtures') return 'fixtures directory';
  }
  const name = parts.at(-1)?.toLowerCase() ?? '';
  if (/\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/.test(name)
    || /\.(?:db|sqlite|sqlite3)-(?:wal|shm|journal)$/.test(name)) {
    return 'database/test data file';
  }
  return null;
}

function scanTree(root, { stopAtForbidden = false } = {}) {
  let fileCount = 0;
  let directoryCount = 0;
  const forbidden = [];
  const stack = [''];
  while (stack.length > 0) {
    const relativeDirectory = stack.pop();
    const absoluteDirectory = path.join(root, relativeDirectory);
    const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory === '' ? entry.name : path.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        forbidden.push({ path: relativePath.replaceAll('\\', '/'), reason: 'symbolic link' });
        if (stopAtForbidden) continue;
      }
      const reason = forbiddenReason(relativePath);
      if (reason != null) {
        forbidden.push({ path: relativePath.replaceAll('\\', '/'), reason });
        if (stopAtForbidden) continue;
      }
      if (entry.isDirectory()) {
        directoryCount += 1;
        stack.push(relativePath);
      } else {
        fileCount += 1;
      }
    }
  }
  return { fileCount, directoryCount, forbidden };
}
function sourceFingerprint(packageRoot) {
  const buildPath = path.join(packageRoot, 'BUILD.json');
  const manifestPath = path.join(packageRoot, 'MANIFEST-SHA256.json');
  return {
    buildSha256: sha256File(buildPath),
    manifestSha256: sha256File(manifestPath),
    buildBytes: fs.statSync(buildPath).size,
    manifestBytes: fs.statSync(manifestPath).size,
  };
}

function copyIsolatedTree(sourceRoot) {
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-r92-package-'));
  const copyRoot = path.join(tempParent, 'candidate');
  fs.cpSync(sourceRoot, copyRoot, {
    recursive: true,
    dereference: true,
    force: true,
    errorOnExist: false,
  });
  return { tempParent, copyRoot };
}

function walkPackageFiles(packageRoot) {
  const result = [];
  const stack = [''];
  while (stack.length > 0) {
    const relativeDirectory = stack.pop();
    const absoluteDirectory = path.join(packageRoot, relativeDirectory);
    const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory === '' ? entry.name : path.join(relativeDirectory, entry.name);
      const absolutePath = path.join(packageRoot, relativePath);
      if (entry.isDirectory()) {
        stack.push(relativePath);
      } else {
        result.push({
          path: relativePath.replaceAll('\\', '/'),
          absolutePath,
          bytes: fs.statSync(absolutePath).size,
        });
      }
    }
  }
  return result;
}

function verifyManifestAndBuild(packageRoot) {
  const buildPath = path.join(packageRoot, 'BUILD.json');
  const manifestPath = path.join(packageRoot, 'MANIFEST-SHA256.json');
  const buildRaw = fs.readFileSync(buildPath, 'utf8');
  const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
  const build = JSON.parse(buildRaw);
  const manifest = JSON.parse(manifestRaw);
  const failures = [];
  const manifestFiles = Array.isArray(manifest) ? manifest : manifest.files;
  if (!Array.isArray(manifestFiles) || manifestFiles.length === 0) {
    failures.push({ kind: 'manifest', detail: 'manifest.files is empty or missing' });
    return {
      ok: false,
      build,
      manifest,
      failures,
      files: [],
      facts: {
        buildFileSha256: sha256(buildRaw),
        manifestFileSha256: sha256(manifestRaw),
      },
    };
  }

  const actualFiles = walkPackageFiles(packageRoot)
    .filter((entry) => entry.path !== 'BUILD.json' && entry.path !== 'MANIFEST-SHA256.json');
  const actualByPath = new Map(actualFiles.map((entry) => [entry.path, entry]));
  const seen = new Set();
  const checkedFiles = [];
  let missingCount = 0;
  let mismatchCount = 0;
  let invalidCount = 0;

  for (const entry of manifestFiles) {
    if (entry == null || typeof entry.path !== 'string' || typeof entry.bytes !== 'number'
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256)) {
      invalidCount += 1;
      failures.push({ kind: 'manifest-entry-invalid', detail: compact(entry) });
      continue;
    }
    if (entry.path.includes('\\') || path.posix.isAbsolute(entry.path) || entry.path.split('/').includes('..')) {
      invalidCount += 1;
      failures.push({ kind: 'manifest-path-unsafe', detail: entry.path });
      continue;
    }
    if (seen.has(entry.path)) {
      invalidCount += 1;
      failures.push({ kind: 'manifest-duplicate', detail: entry.path });
      continue;
    }
    seen.add(entry.path);
    const actual = actualByPath.get(entry.path);
    if (actual == null) {
      missingCount += 1;
      failures.push({ kind: 'missing', detail: entry.path });
      continue;
    }
    const actualSha = sha256File(actual.absolutePath);
    if (actual.bytes !== entry.bytes || actualSha !== entry.sha256.toLowerCase()) {
      mismatchCount += 1;
      failures.push({
        kind: 'mismatch',
        detail: entry.path,
        expectedBytes: entry.bytes,
        actualBytes: actual.bytes,
        expectedSha256: entry.sha256,
        actualSha256: actualSha,
      });
      continue;
    }
    checkedFiles.push({ path: entry.path, bytes: entry.bytes, sha256: actualSha });
  }

  const extraFiles = actualFiles.filter((entry) => !seen.has(entry.path));
  for (const entry of extraFiles) failures.push({ kind: 'extra', detail: entry.path });
  if (extraFiles.length > 0) invalidCount += extraFiles.length;

  const daemonRelative = 'resources/app/daemon/daemon.cjs';
  if (!seen.has(daemonRelative)) failures.push({ kind: 'packaged-daemon-not-manifested', detail: daemonRelative });

  const manifestFilesSha256 = sha256(Buffer.from(JSON.stringify(manifestFiles)));
  const actualFilesSha256 = sha256(Buffer.from(JSON.stringify(actualFiles.map((entry) => ({
    path: entry.path,
    bytes: entry.bytes,
    sha256: sha256File(entry.absolutePath),
  })))));

  if (typeof manifest.buildId !== 'string' || manifest.buildId !== build.buildId) {
    failures.push({ kind: 'manifest-buildId', detail: `${manifest.buildId} != ${build.buildId}` });
  }
  if (typeof build.commit !== 'string' || !/^[0-9a-f]{40,64}$/i.test(build.commit)) {
    failures.push({ kind: 'commit-format', detail: build.commit });
  }
  if (typeof build.dirty !== 'boolean') failures.push({ kind: 'dirty-format', detail: build.dirty });
  if (build.dirty === true) {
    if (typeof build.dirtyDiffHash !== 'string' || !/^[0-9a-f]{64}$/i.test(build.dirtyDiffHash)) {
      failures.push({ kind: 'dirtyDiffHash-format', detail: build.dirtyDiffHash });
    }
  } else if (build.dirty === false && build.dirtyDiffHash != null) {
    failures.push({ kind: 'dirtyDiffHash-unexpected', detail: build.dirtyDiffHash });
  }
  if (typeof build.builtAt !== 'string' || Number.isNaN(Date.parse(build.builtAt))) {
    failures.push({ kind: 'builtAt-format', detail: build.builtAt });
  }
  if (build.manifest != null && build.manifest !== 'MANIFEST-SHA256.json') {
    failures.push({ kind: 'manifest-name', detail: build.manifest });
  }
  let recomputedBuildId = null;
  if (typeof build.commit === 'string' && typeof build.dirty === 'boolean') {
    recomputedBuildId = `bld_${sha256(JSON.stringify({
      commit: build.commit,
      dirty: build.dirty,
      dirtyDiffHash: build.dirtyDiffHash ?? null,
      files: manifestFiles,
    })).slice(0, 16)}`;
    if (recomputedBuildId !== build.buildId) {
      failures.push({ kind: 'buildId-recompute', detail: `${recomputedBuildId} != ${build.buildId}` });
    }
  }

  return {
    ok: failures.length === 0,
    build,
    manifest,
    failures,
    files: manifestFiles,
    facts: {
      buildFileSha256: sha256(buildRaw),
      manifestFileSha256: sha256(manifestRaw),
      manifestFilesSha256,
      actualFilesSha256,
      manifestCount: manifestFiles.length,
      actualCount: actualFiles.length,
      checkedCount: checkedFiles.length,
      missingCount,
      mismatchCount,
      extraCount: extraFiles.length,
      invalidCount,
      recomputedBuildId,
      daemonRelative,
      daemonSha256: actualByPath.has(daemonRelative) ? sha256File(actualByPath.get(daemonRelative).absolutePath) : null,
    },
  };
}
function gitFacts(build) {
  const facts = {
    repoRoot,
    commitResolves: false,
    commit: build?.commit ?? null,
    head: null,
    headMatchesBuild: false,
    error: null,
  };
  if (typeof build?.commit !== 'string' || !/^[0-9a-f]{40,64}$/i.test(build.commit)) return facts;
  const verify = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--verify', `${build.commit}^{commit}`], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  facts.commitResolves = verify.status === 0;
  if (!facts.commitResolves) facts.error = (verify.stderr || verify.stdout || `git exit ${verify.status}`).trim().slice(0, 2000);
  const head = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  if (head.status === 0) {
    facts.head = head.stdout.trim();
    facts.headMatchesBuild = facts.head.toLowerCase() === build.commit.toLowerCase();
  }
  return facts;
}

class EventStream {
  constructor() {
    this.backlog = [];
    this.waiters = [];
    this.closed = false;
  }

  push(event) {
    if (this.closed) return;
    this.backlog.push(event);
    for (const wake of this.waiters.splice(0)) wake();
  }

  close() {
    this.closed = true;
    for (const wake of this.waiters.splice(0)) wake();
  }

  async *iterate() {
    let index = 0;
    for (;;) {
      while (index < this.backlog.length) {
        yield this.backlog[index];
        index += 1;
      }
      if (this.closed) return;
      await new Promise((resolve) => this.waiters.push(resolve));
      if (this.closed) return;
    }
  }
}

class SyntheticRuntimeAdapter {
  constructor(label) {
    this.label = label;
    this.scenario = 'handoff';
    this.db = null;
    this.sessionSeq = 0;
    this.eventSeq = 0;
    this.sessions = new Map();
    this.startTurnLog = [];
    this.openSessionLog = [];
    this.realCallsAttempted = 0;
  }

  async probe() {
    return {
      executable: 'synthetic://r92-qa',
      version: 'r92-qa-fake-1',
      capabilities: {
        structuredEvents: 'supported',
        taskContextIsolation: 'supported',
        resumeSession: 'supported',
        steerActiveTurn: 'supported',
        interrupt: 'supported',
        interactiveApprovals: 'supported',
        structuredFinal: 'supported',
        restrictWrites: 'supported',
        restrictShell: 'supported',
        disableDelegation: 'supported',
        usageTokens: 'supported',
        usageCost: 'unsupported',
      },
    };
  }

  async openSession(input) {
    this.sessionSeq += 1;
    const ref = {
      id: `r92-qa-session-${this.label}-${this.sessionSeq}`,
      providerSessionId: input.resume?.providerSessionId ?? `r92-qa-provider-${this.label}-${this.sessionSeq}`,
      runtimeInstallationId: input.resume?.runtimeInstallationId ?? `r92-qa-installation-${this.label}`,
      adapterVersion: 'r92-qa-fake-1',
      threadId: input.threadId,
      sessionGeneration: input.resume?.sessionGeneration ?? input.sessionGeneration,
      cwd: input.cwd,
    };
    const state = { ref, stream: new EventStream() };
    this.sessions.set(ref.id, state);
    this.openSessionLog.push({
      resumedFrom: input.resume?.providerSessionId ?? null,
      returned: ref.providerSessionId,
      generation: input.sessionGeneration,
      memberId: input.memberId,
      taskId: input.taskId,
    });
    this.emit(state, { kind: 'session.ready', providerSessionId: ref.providerSessionId });
    return ref;
  }

  identityFromTurnText(text) {
    const match = /\bturn=([^\s]+)/.exec(text ?? '');
    if (match == null) throw new Error('synthetic adapter could not find turn=<id> in bundle text');
    if (this.db == null) throw new Error('synthetic adapter has no database handle');
    const row = this.db.prepare(`SELECT r.task_id, t.owner_member_id, c.integration_run_id
      FROM agent_turns a
      JOIN workflow_runs r ON r.id=a.run_id
      JOIN tasks t ON t.id=r.task_id
      LEFT JOIN coordination_runs c ON c.integration_run_id=r.id
      WHERE a.id=?`).get(match[1]);
    if (row == null) throw new Error(`synthetic adapter did not find turn identity: ${match[1]}`);
    return { turnId: match[1], ...row };
  }

  async startTurn(session, input) {
    this.startTurnLog.push({
      at: nowIso(),
      scenario: this.scenario,
      turnId: input.turnId,
      inputBundleId: input.inputBundleId,
      text: input.text,
    });
    const state = this.sessions.get(session.id);
    if (state == null) throw new Error(`synthetic adapter session missing: ${session.id}`);
    const identity = this.identityFromTurnText(input.text);
    if (this.scenario === 'reopen') {
      throw new Error(`reopen unexpectedly started turn ${input.turnId}; no automatic rerun is allowed`);
    }
    let answer;
    let handoffs = null;
    if (this.scenario === 'handoff') {
      if (identity.integration_run_id != null) {
        answer = INTEGRATION_ANSWER;
      } else if (identity.owner_member_id === this.memberIds?.b) {
        answer = B_ANSWER;
        handoffs = [{ toMemberId: this.memberIds.a, purpose: 'reply', message: B_REPLY }];
      } else if (identity.owner_member_id === this.memberIds?.a) {
        answer = A_ANSWER;
      } else {
        throw new Error(`synthetic adapter received unexpected owner: ${identity.owner_member_id}`);
      }
    } else if (this.scenario === 'no_handoff') {
      if (identity.integration_run_id != null) throw new Error('no-handoff scenario unexpectedly produced an integration turn');
      if (identity.owner_member_id === this.memberIds?.a) answer = A_ANSWER;
      else if (identity.owner_member_id === this.memberIds?.b) answer = B_ANSWER;
      else throw new Error(`synthetic adapter received unexpected owner: ${identity.owner_member_id}`);
    } else {
      throw new Error(`unknown synthetic adapter scenario: ${this.scenario}`);
    }

    this.emit(state, { kind: 'turn.started', providerTurnId: `${input.turnId}:synthetic` }, input.turnId);
    const finalText = JSON.stringify({
      schemaVersion: 'task-complete-v1',
      resultKey: input.resultKey ?? `result_${input.turnId}`,
      responseKind: 'work',
      answer,
      changeSummary: answer,
      files: [],
      executedVerifications: [],
      unexecutedVerifications: [],
      remainingIssues: [],
      ...(handoffs == null ? {} : { handoffs }),
    });
    this.emit(state, { kind: 'message.completed', messageId: 'final_result', text: finalText }, input.turnId);
    this.emit(state, { kind: 'turn.completed', finalText }, input.turnId);
    this.emit(state, { kind: 'process.exited', exitCode: 0, expected: true });
  }

  emit(state, spec, turnId) {
    this.eventSeq += 1;
    state.stream.push({
      ...spec,
      eventKey: `${state.ref.id}:synthetic:${this.eventSeq}`,
      sessionId: state.ref.id,
      ...(turnId == null ? {} : { turnId }),
      receivedAt: Date.now(),
    });
  }

  events(session) {
    const state = this.sessions.get(session.id);
    if (state == null) throw new Error(`synthetic adapter events session missing: ${session.id}`);
    return state.stream.iterate();
  }

  async steer() {
    throw new Error('synthetic adapter does not use steer');
  }

  async interrupt() {
    return undefined;
  }

  async respondApproval() {
    throw new Error('synthetic adapter has no pending approval');
  }

  async close(session) {
    const state = this.sessions.get(session.id);
    if (state != null) state.stream.close();
    this.sessions.delete(session.id);
  }

  async closeAllSessions() {
    for (const state of this.sessions.values()) state.stream.close();
    this.sessions.clear();
  }

  processIdentity() {
    return { model: 'none', pid: null };
  }
}
class PipeClient {
  constructor(socket) {
    this.socket = socket;
    this.closed = false;
    this.buffer = '';
    this.nextSeq = 0;
    this.pending = new Map();
    this.protocolErrors = [];
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.failAll(new Error('daemon pipe closed')));
    socket.on('error', (error) => this.failAll(error));
  }

  static connect(pipeName, token, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(pipeName);
      let settled = false;
      let authenticated = false;
      const timer = setTimeout(() => {
        socket.destroy();
        if (!settled) {
          settled = true;
          reject(new Error(`daemon pipe connect/auth timeout: ${pipeName}`));
        }
      }, timeoutMs);
      let client = null;
      const fail = (error) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(error);
        }
        client?.failAll(error);
        if (!socket.destroyed) socket.destroy();
      };
      socket.setEncoding('utf8');
      socket.once('connect', () => socket.write(`${JSON.stringify({ type: 'auth', token })}\n`));
      socket.once('error', fail);
      let buffer = '';
      const onAuthData = (chunk) => {
        if (authenticated) return;
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          fail(new Error(`daemon auth response is not JSON: ${line.slice(0, 120)}`));
          return;
        }
        if (parsed?.type !== 'auth.ok') {
          fail(new Error(`daemon auth rejected: ${parsed?.error?.message ?? line.slice(0, 120)}`));
          return;
        }
        authenticated = true;
        clearTimeout(timer);
        settled = true;
        socket.removeListener('data', onAuthData);
        socket.removeListener('error', fail);
        client = new PipeClient(socket);
        if (buffer.length > 0) client.onData(buffer);
        resolve(client);
      };
      socket.on('data', onAuthData);
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line === '') continue;
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        this.protocolErrors.push(`bad response frame: ${line.slice(0, 200)}`);
        continue;
      }
      const pending = response?.commandId == null ? null : this.pending.get(response.commandId);
      if (pending == null) {
        this.protocolErrors.push(`response without waiter: ${line.slice(0, 200)}`);
        continue;
      }
      this.pending.delete(response.commandId);
      clearTimeout(pending.timer);
      pending.resolve(response);
    }
  }

  send(method, params, timeoutMs = 60_000) {
    if (this.closed) return Promise.reject(new Error('daemon pipe is closed'));
    this.nextSeq += 1;
    const commandId = `r92-qa-${this.nextSeq}-${crypto.randomUUID()}`;
    const envelope = { protocolVersion: 1, commandId, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        reject(new Error(`command timeout: ${method} (${commandId})`));
      }, timeoutMs);
      this.pending.set(commandId, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify(envelope)}\n`);
    }).then((response) => ({ ...response, requestEnvelope: envelope }));
  }

  failAll(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.failAll(new Error('verification closed daemon pipe'));
    this.socket.destroy();
  }
}

async function startDaemonSession({ packedDaemonPath, startDaemon, appDataDir, pipeName, adapter, label }) {
  fs.mkdirSync(appDataDir, { recursive: true });
  delete process.env.ZS_PACKED_ENTRY;
  delete process.env.ZS_DAEMON_ENTRY;
  delete process.env.ZS_ALLOW_FAKE;
  delete process.env.ZS_FAKE_DELIB;
  delete process.env.ZS_FAKE_STALL_MS;
  process.env.ZS_RUNTIME = 'fake';
  process.env.ZS_APP_MODE = 'fake-sim';
  process.env.ZS_REAL_DISPATCH_GUARD = '1';
  process.env.ZS_REMINDER_DISABLED = '1';
  const startedAt = nowIso();
  let daemon = null;
  try {
    daemon = await startDaemon({
      appDataDir,
      runtime: 'fake',
      localUserId: 'r92-qa-local',
      pipeName,
      tickMs: 60_000,
      drainSettleTimeoutMs: 10_000,
      testAdapter: adapter,
      testAdapterFactories: { fake: () => adapter },
    });
    adapter.db = daemon.db;
    // startDaemon has already captured the injected factories. Only now enable the
    // fake member-command gate used by member.setRuntime; doing this earlier lets
    // entry.ts replace factories.fake with its default FakeRuntimeAdapter.
    process.env.ZS_ALLOW_FAKE = '1';
    const tokenPath = path.join(appDataDir, 'local.token');
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    if (token.length < 32) throw new Error(`local credential is too short: ${tokenPath}`);
    const pipe = await PipeClient.connect(daemon.pipeName, token);
    return {
      label,
      startedAt,
      packedDaemonPath,
      appDataDir,
      pipeName: daemon.pipeName,
      daemon,
      pipe,
      adapter,
      allowFakeDuringFactoryConstruction: false,
      allowFakeAfterInjection: true,
      injectedAdapterKind: 'r92-synthetic-runtime-adapter',
    };
  } catch (error) {
    if (daemon != null) {
      try {
        await daemon.stop({ force: true });
      } catch { /* startup cleanup is best effort */ }
    }
    throw error;
  }
}

async function stopDaemonSession(session, record, { forceOnIncomplete = false } = {}) {
  if (session == null) return null;
  try {
    session.pipe.close();
  } catch (error) {
    (record.errors ??= []).push({ at: nowIso(), stage: 'pipe-close', error: errorFacts(error) });
  }
  let result;
  try {
    result = await session.daemon.stop();
  } catch (error) {
    (record.errors ??= []).push({ at: nowIso(), stage: 'daemon-stop', error: errorFacts(error) });
    if (!forceOnIncomplete) throw error;
  }
  if (forceOnIncomplete && result?.complete !== true) {
    try {
      const forced = await session.daemon.stop({ force: true });
      result = { graceful: result, forced };
    } catch (error) {
      (record.errors ??= []).push({ at: nowIso(), stage: 'daemon-force-stop', error: errorFacts(error) });
      throw error;
    }
  }
  record.at = nowIso();
  record.result = result;
  return result;
}

async function command(session, receipts, method, params) {
  const response = await session.pipe.send(method, params);
  const receipt = {
    at: nowIso(),
    session: session.label,
    method,
    commandId: response.requestEnvelope.commandId,
    request: response.requestEnvelope,
    ok: response.ok === true,
    response: {
      commandId: response.commandId ?? null,
      ok: response.ok === true,
      data: response.data ?? null,
      error: response.error ?? null,
    },
  };
  receipts.push(receipt);
  if (response.ok !== true) {
    throw new Error(`${method} failed: ${compact(response.error ?? response, 2000)}`);
  }
  return response.data;
}

function configureEvidence() {
  const checks = [];
  const gates = Object.fromEntries(requiredGates.map((name) => [name, false]));
  const record = (name, ok, detail = null) => {
    const item = { at: nowIso(), name, ok: Boolean(ok), detail };
    checks.push(item);
    if (!item.ok) console.error(`FAIL ${name}${detail == null ? '' : `: ${compact(detail, 1200)}`}`);
    return item.ok;
  };
  const expect = (name, ok, detail = null) => {
    const passed = record(name, ok, detail);
    if (!passed) throw new Error(`${name}${detail == null ? '' : `: ${compact(detail, 1200)}`}`);
    return passed;
  };
  return { checks, gates, record, expect };
}
function taskInspection(db, taskId, a, b) {
  const task = db.prepare('SELECT id,status,owner_member_id,current_delivery_id,conversation_thread_id FROM tasks WHERE id=?').get(taskId) ?? null;
  const run = db.prepare(`SELECT run_id,state,integration_run_id,error_message,plan_json
    FROM coordination_runs WHERE task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(taskId) ?? null;
  const turns = db.prepare(`SELECT a.id,t.owner_member_id,a.status,r.id AS run_id,r.task_id,
      EXISTS(SELECT 1 FROM coordination_integration_attempts i WHERE i.execution_run_id=r.id) AS is_integration
    FROM agent_turns a
    JOIN workflow_runs r ON r.id=a.run_id
    JOIN tasks t ON t.id=r.task_id
    WHERE t.id=? OR t.parent_task_id=?
    ORDER BY a.rowid`).all(taskId, taskId);
  const roster = run == null ? null : db.prepare('SELECT roster_json FROM coordination_run_rosters WHERE run_id=?').get(run.run_id) ?? null;
  let rosterMembers = [];
  if (roster != null) {
    try {
      rosterMembers = JSON.parse(roster.roster_json).map((member) => member.memberId);
    } catch {
      rosterMembers = [];
    }
  }
  const messages = run == null ? [] : db.prepare(`SELECT id,source_turn_id,source_member_id,target_member_id,purpose,body,
      child_task_id,target_turn_id,target_delivery_id,status,error_message
    FROM coordination_messages WHERE coordination_run_id=? ORDER BY created_at,id`).all(run.run_id);
  const integrationQueued = db.prepare(`SELECT count(*) AS count FROM domain_events
    WHERE task_id=? AND kind='coordination.integrationQueued'`).get(taskId).count;
  const explicitCompleted = db.prepare(`SELECT count(*) AS count FROM domain_events
    WHERE task_id=? AND kind='coordination.completed'
      AND json_extract(payload_json,'$.source')='explicit-recipients'`).get(taskId).count;
  return {
    task,
    run,
    turns: turns.map((turn) => ({ ...turn, is_integration: Boolean(turn.is_integration) })),
    rosterMembers,
    messages,
    integrationQueued,
    explicitCompleted,
    expectedMembers: [a, b],
  };
}

function realCallCount(db) {
  const row = db.prepare('SELECT count(*) AS count FROM real_calls').get();
  return Number(row.count);
}

async function driveTask(session, taskId, { expectIntegration, expectedTurns, a, b, label }) {
  const deadline = Date.now() + 60_000;
  let iterations = 0;
  let dispatched = 0;
  let last = null;
  while (Date.now() < deadline) {
    dispatched += await session.daemon.worker.drain();
    iterations += 1;
    await sleep(60);
    last = taskInspection(session.daemon.db, taskId, a, b);
    const turns = last.turns;
    if (turns.length > expectedTurns) {
      throw new Error(`${label}: expected ${expectedTurns} turns, observed ${turns.length}`);
    }
    const integrationCount = turns.filter((turn) => turn.is_integration).length;
    const ready = last.run != null
      && last.run.state === 'completed'
      && (expectIntegration ? last.run.integration_run_id != null && integrationCount === 1 : last.run.integration_run_id == null && integrationCount === 0)
      && turns.length === expectedTurns
      && turns.every((turn) => turn.status === 'SUCCEEDED');
    if (ready) {
      await sleep(120);
      const stable = taskInspection(session.daemon.db, taskId, a, b);
      if (stable.turns.length === expectedTurns && stable.run?.state === 'completed') {
        return { inspection: stable, iterations, dispatched };
      }
      last = stable;
    }
    if (last.run != null && ['blocked', 'cancelled'].includes(last.run.state)) {
      throw new Error(`${label}: coordination ended ${last.run.state}: ${last.run.error_message ?? 'no error_message'}`);
    }
    if (last.task != null && ['BLOCKED', 'CANCELLED'].includes(last.task.status)) {
      throw new Error(`${label}: task ended ${last.task.status}`);
    }
    await sleep(80);
  }
  throw new Error(`${label}: timeout; last=${compact(last, 3000)}`);
}
async function assertHandoffScenario(session, sent, a, b, receipts, qa) {
  const driven = await driveTask(session, sent.taskId, {
    expectIntegration: true,
    expectedTurns: 3,
    a,
    b,
    label: 'handoff',
  });
  const inspection = driven.inspection;
  const run = inspection.run;
  qa.expect('handoff: coordination reached completed', run?.state === 'completed', run);
  qa.expect('handoff: integration run identity exists', typeof run?.integration_run_id === 'string' && run.integration_run_id.length > 0, run);
  qa.expect('handoff: exactly 3 real daemon turns', inspection.turns.length === 3, inspection.turns);
  qa.expect('handoff: all turns succeeded', inspection.turns.every((turn) => turn.status === 'SUCCEEDED'), inspection.turns.map((turn) => ({ id: turn.id, status: turn.status })));
  qa.expect('handoff: injected synthetic adapter class is active', session.adapter.constructor.name === 'SyntheticRuntimeAdapter', session.adapter.constructor.name);
  const handoffTurnIds = new Set(inspection.turns.map((turn) => turn.id));
  const handoffAdapterCalls = session.adapter.startTurnLog.map((call) => call.turnId);
  qa.expect('handoff: synthetic adapter startTurnLog is exactly 3', session.adapter.startTurnLog.length === 3
    && new Set(handoffAdapterCalls).size === 3
    && handoffAdapterCalls.every((turnId) => handoffTurnIds.has(turnId)),
    { adapterCalls: handoffAdapterCalls, databaseTurns: [...handoffTurnIds] });
  const handoffOpenSessions = session.adapter.openSessionLog.slice();
  qa.expect('handoff: synthetic adapter openSessionLog is exactly 3', handoffOpenSessions.length === 3, handoffOpenSessions);
  qa.expect('handoff: roster is exactly A/B', new Set(inspection.rosterMembers).size === 2
    && inspection.rosterMembers.includes(a)
    && inspection.rosterMembers.includes(b), inspection.rosterMembers);
  const integrationTurns = inspection.turns.filter((turn) => turn.is_integration);
  qa.expect('handoff: exactly one integration turn', integrationTurns.length === 1, integrationTurns);
  qa.expect('handoff: integration turn belongs to coordinator A', integrationTurns[0]?.owner_member_id === a, integrationTurns[0]);
  const nonIntegrationOwners = inspection.turns.filter((turn) => !turn.is_integration).map((turn) => turn.owner_member_id).sort();
  qa.expect('handoff: explicit recipient turns are A/B only', nonIntegrationOwners.length === 2
    && nonIntegrationOwners.includes(a)
    && nonIntegrationOwners.includes(b), nonIntegrationOwners);

  const handoff = inspection.messages.find((message) => message.purpose === 'reply') ?? null;
  qa.expect('handoff: one deferred reply exists', handoff != null && inspection.messages.filter((message) => message.purpose === 'reply').length === 1, inspection.messages);
  qa.expect('handoff: deferred reply authored by B', handoff?.source_member_id === b, handoff);
  qa.expect('handoff: deferred reply targets coordinator A', handoff?.target_member_id === a, handoff);
  qa.expect('handoff: readable deferred body preserved', handoff?.body === B_REPLY, handoff?.body);
  qa.expect('handoff: handoff status completed', handoff?.status === 'completed', handoff);
  const targetTurn = inspection.turns.find((turn) => turn.id === handoff?.target_turn_id) ?? null;
  qa.expect('handoff: target turn is a real packaged-daemon turn', targetTurn != null, handoff?.target_turn_id);
  qa.expect('handoff: target turn is the integration execution', targetTurn?.run_id === run?.integration_run_id, {
    targetTurn,
    integrationRunId: run?.integration_run_id,
  });
  qa.expect('handoff: target turn succeeded', targetTurn?.status === 'SUCCEEDED', targetTurn);
  const delivery = handoff?.target_delivery_id == null
    ? null
    : session.daemon.db.prepare('SELECT id,task_id,run_id,revision,review_status FROM task_deliveries WHERE id=?').get(handoff.target_delivery_id) ?? null;
  qa.expect('handoff: target delivery is real', delivery != null, handoff?.target_delivery_id);
  qa.expect('handoff: delivery belongs to parent task', delivery?.task_id === sent.taskId, delivery);
  qa.expect('handoff: delivery belongs to integration run', delivery?.run_id === run?.integration_run_id, delivery);
  qa.expect('handoff: parent points at target delivery', inspection.task?.current_delivery_id === handoff?.target_delivery_id, {
    currentDeliveryId: inspection.task?.current_delivery_id,
    targetDeliveryId: handoff?.target_delivery_id,
  });

  const context = handoff?.target_turn_id == null
    ? null
    : session.daemon.db.prepare('SELECT turn_id,included_refs_json FROM context_bundles WHERE turn_id=?').get(handoff.target_turn_id) ?? null;
  const contextText = context?.included_refs_json ?? '';
  qa.expect('handoff: integration context bundle exists', context != null, handoff?.target_turn_id);
  qa.expect('handoff: context contains A complete result', contextText.includes(A_ANSWER), compact(contextText, 2000));
  qa.expect('handoff: context contains B complete result', contextText.includes(B_ANSWER), compact(contextText, 2000));
  qa.expect('handoff: context contains B deferred reply', contextText.includes(B_REPLY), compact(contextText, 2000));
  qa.expect('handoff: context carries A author', contextText.includes(`"author":"${a}"`), a);
  qa.expect('handoff: context carries B author', contextText.includes(`"author":"${b}"`), b);
  qa.expect('handoff: exactly one integration queue event', inspection.integrationQueued === 1, inspection.integrationQueued);
  qa.expect('handoff: did not close as explicit-recipients only', inspection.explicitCompleted === 0, inspection.explicitCompleted);

  const history = await command(session, receipts, 'thread.history', { threadId: sent.threadId, limit: 100 });
  const items = Array.isArray(history?.items) ? history.items : [];
  const last = items.at(-1) ?? null;
  qa.expect('handoff: thread.history has the integration reply', last?.authorType === 'agent'
    && last?.authorId === a
    && last?.body?.text === INTEGRATION_ANSWER, last);
  qa.expect('handoff: integration reply appears once', items.filter((item) => item?.body?.text === INTEGRATION_ANSWER).length === 1, items.map((item) => item?.body?.text));

  const drainBeforeTurns = inspection.turns.length;
  const drainBeforeCalls = session.adapter.startTurnLog.length;
  const drain1 = await session.daemon.worker.drain();
  const drain2 = await session.daemon.worker.drain();
  await sleep(120);
  const afterDrain = taskInspection(session.daemon.db, sent.taskId, a, b);
  qa.expect('repeat drain: no additional turns', afterDrain.turns.length === drainBeforeTurns, {
    before: drainBeforeTurns,
    after: afterDrain.turns.length,
  });
  qa.expect('repeat drain: no additional adapter calls', session.adapter.startTurnLog.length === drainBeforeCalls, {
    before: drainBeforeCalls,
    after: session.adapter.startTurnLog.length,
  });
  qa.gates.repeatDrain = true;

  return {
    sent,
    driven,
    inspection: afterDrain,
    handoff,
    targetTurn,
    delivery,
    context: context == null ? null : {
      turnId: context.turn_id,
      includedRefsJson: context.included_refs_json,
    },
    history,
    drains: { first: drain1, second: drain2 },
    adapterCalls: handoffAdapterCalls.length,
    startTurnLog: handoffAdapterCalls,
    openSessionLog: handoffOpenSessions,
    integrationQueuedEvents: inspection.integrationQueued,
    explicitRecipientCompletionEvents: inspection.explicitCompleted,
  };
}
async function assertNoHandoffScenario(session, sent, a, b, receipts, qa) {
  const beforeCalls = session.adapter.startTurnLog.length;
  const beforeOpenSessions = session.adapter.openSessionLog.length;
  const driven = await driveTask(session, sent.taskId, {
    expectIntegration: false,
    expectedTurns: 2,
    a,
    b,
    label: 'no-handoff',
  });
  const inspection = driven.inspection;
  const run = inspection.run;
  qa.expect('no-handoff: coordination completed without integration', run?.state === 'completed' && run?.integration_run_id == null, run);
  qa.expect('no-handoff: exactly 2 turns', inspection.turns.length === 2, inspection.turns);
  qa.expect('no-handoff: exactly A and B answered once', inspection.turns.length === 2
    && inspection.turns.every((turn) => !turn.is_integration)
    && new Set(inspection.turns.map((turn) => turn.owner_member_id)).size === 2
    && inspection.turns.some((turn) => turn.owner_member_id === a)
    && inspection.turns.some((turn) => turn.owner_member_id === b), inspection.turns);
  const noHandoffTurnIds = new Set(inspection.turns.map((turn) => turn.id));
  const noHandoffAdapterCalls = session.adapter.startTurnLog.slice(beforeCalls).map((call) => call.turnId);
  qa.expect('no-handoff: injected synthetic adapter startTurnLog is exactly 2 for this scenario', noHandoffAdapterCalls.length === 2
    && new Set(noHandoffAdapterCalls).size === 2
    && noHandoffAdapterCalls.every((turnId) => noHandoffTurnIds.has(turnId)),
    { adapterCalls: noHandoffAdapterCalls, databaseTurns: [...noHandoffTurnIds] });
  qa.expect('no-handoff: cumulative synthetic adapter startTurnLog is exactly 5', session.adapter.startTurnLog.length === 5,
    session.adapter.startTurnLog.map((call) => call.turnId));
  qa.expect('no-handoff: cumulative synthetic adapter openSessionLog is exactly 5', session.adapter.openSessionLog.length === 5,
    session.adapter.openSessionLog);
  const noHandoffOpenSessions = session.adapter.openSessionLog.slice(beforeOpenSessions);
  qa.expect('no-handoff: synthetic adapter openSessionLog is exactly 2 for this scenario', noHandoffOpenSessions.length === 2, noHandoffOpenSessions);
  qa.expect('no-handoff: adapter received exactly 2 calls for this task', session.adapter.startTurnLog.length - beforeCalls === 2, {
    before: beforeCalls,
    after: session.adapter.startTurnLog.length,
  });
  qa.expect('no-handoff: no coordination messages', inspection.messages.length === 0, inspection.messages);
  qa.expect('no-handoff: no integration queue event', inspection.integrationQueued === 0, inspection.integrationQueued);
  qa.expect('no-handoff: explicit-recipient completion event exists', inspection.explicitCompleted === 1, inspection.explicitCompleted);
  qa.expect('no-handoff: roster is exactly A/B', new Set(inspection.rosterMembers).size === 2
    && inspection.rosterMembers.includes(a)
    && inspection.rosterMembers.includes(b), inspection.rosterMembers);

  const history = await command(session, receipts, 'thread.history', { threadId: sent.threadId, limit: 100 });
  const items = Array.isArray(history?.items) ? history.items : [];
  const agentItems = items.filter((item) => item?.authorType === 'agent');
  qa.expect('no-handoff: history has exactly 2 agent replies', agentItems.length === 2, agentItems);
  qa.expect('no-handoff: history has A result once', agentItems.filter((item) => item?.authorId === a && item?.body?.text === A_ANSWER).length === 1, agentItems);
  qa.expect('no-handoff: history has B result once', agentItems.filter((item) => item?.authorId === b && item?.body?.text === B_ANSWER).length === 1, agentItems);
  qa.expect('no-handoff: no synthetic integration answer', agentItems.every((item) => item?.body?.text !== INTEGRATION_ANSWER), agentItems);

  const beforeRepeat = inspection.turns.length;
  const callsBeforeRepeat = session.adapter.startTurnLog.length;
  const drain1 = await session.daemon.worker.drain();
  const drain2 = await session.daemon.worker.drain();
  await sleep(120);
  const afterRepeat = taskInspection(session.daemon.db, sent.taskId, a, b);
  qa.expect('no-handoff repeat drain: no extra turns', afterRepeat.turns.length === beforeRepeat, {
    before: beforeRepeat,
    after: afterRepeat.turns.length,
  });
  qa.expect('no-handoff repeat drain: no extra calls', session.adapter.startTurnLog.length === callsBeforeRepeat, {
    before: callsBeforeRepeat,
    after: session.adapter.startTurnLog.length,
  });
  qa.gates.repeatDrain = true;

  return {
    sent,
    driven,
    inspection: afterRepeat,
    history,
    drains: { first: drain1, second: drain2 },
    adapterCalls: noHandoffAdapterCalls.length,
    adapterCallsCumulative: session.adapter.startTurnLog.length,
    startTurnLog: noHandoffAdapterCalls,
    openSessionLog: noHandoffOpenSessions,
  };
}
async function runVerification(args, priorAttempts) {
  const startedAt = nowIso();
  const sourceRoot = path.resolve(repoRoot, args.packageArg);
  const outDir = path.resolve(repoRoot, args.outArg);
  assertSafeInputs(sourceRoot, outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const resultPath = path.join(outDir, 'result.json');
  const receipts = [];
  const qa = configureEvidence();
  const result = {
    schemaVersion,
    ok: false,
    phase: 'init',
    startedAt,
    finishedAt: null,
    package: {
      requested: args.packageArg,
      sourceRoot,
      packageRoot: null,
      packageRelative: null,
      copyRoot: null,
      isolatedCopy: false,
      keepCopy: args.keepCopy,
      evidenceDir: outDir,
      resultPath,
    },
    build: null,
    manifest: null,
    git: null,
    daemon: null,
    commandReceipts: receipts,
    checks: qa.checks,
    gates: qa.gates,
    identities: {},
    scenarios: {},
    realCalls: {},
    sourceFingerprint: { before: null, after: null, unchanged: null },
    priorAttempts,
    error: null,
    limitations: [
      'daemon-only synthetic verification; no GUI/Electron',
      'no real model/runtime process is invoked; real_calls must remain 0',
      'candidate package bytes are checked in an isolated temp copy',
      'passing this script does not certify real multi-model interop',
    ],
  };
  let tempParent = null;
  let copyRoot = null;
  let currentSession = null;
  let sourcePackageRoot = null;
  const stopRecords = {};

  try {
    result.phase = 'source-preflight';
    assertSafeInputs(sourceRoot, outDir);
    const located = locatePackageRoot(sourceRoot);
    sourcePackageRoot = located.packageRoot;
    result.package.packageRoot = located.packageRoot;
    result.package.packageRelative = located.packageRelative;
    result.package.sourceRoot = located.sourceRoot;
    qa.gates.sourceLayout = true;
    qa.record('source layout: package root and packaged daemon located', true, {
      sourceRoot: located.sourceRoot,
      packageRoot: located.packageRoot,
      packageRelative: located.packageRelative,
    });

    const sourceScan = scanTree(located.sourceRoot, { stopAtForbidden: true });
    result.sourceFingerprint.before = sourceFingerprint(located.packageRoot);
    result.package.sourceFileCount = sourceScan.fileCount;
    qa.gates.sourceNotTouched = true;
    qa.record('source read-only fingerprint captured before copy', true, result.sourceFingerprint.before);
    qa.expect('candidate contains no server-data/fixtures/database test data', sourceScan.forbidden.length === 0, sourceScan.forbidden);
    qa.gates.noForbiddenTestData = true;

    result.phase = 'isolated-copy';
    const copied = copyIsolatedTree(located.sourceRoot);
    tempParent = copied.tempParent;
    copyRoot = copied.copyRoot;
    result.package.copyRoot = copyRoot;
    result.package.isolatedCopy = true;
    const copiedPackageRoot = path.join(copyRoot, located.packageRelative);
    qa.expect('isolated candidate copy exists', fs.existsSync(copiedPackageRoot), copiedPackageRoot);

    result.phase = 'manifest-and-build';
    const manifest = verifyManifestAndBuild(copiedPackageRoot);
    result.build = manifest.build;
    result.manifest = manifest.facts;
    result.manifest.failures = manifest.failures.slice(0, 100);
    result.manifest.failureCount = manifest.failures.length;
    qa.expect('MANIFEST-SHA256 covers and matches every packaged file', manifest.ok, {
      failureCount: manifest.failures.length,
      failures: manifest.failures.slice(0, 30),
      facts: manifest.facts,
    });
    qa.gates.manifest = true;
    const git = gitFacts(manifest.build);
    result.git = git;
    qa.expect('BUILD commit resolves in repository', git.commitResolves, git);
    qa.expect('BUILD buildId is reproducible from commit/dirty/files', manifest.facts.recomputedBuildId === manifest.build.buildId, {
      buildId: manifest.build.buildId,
      recomputedBuildId: manifest.facts.recomputedBuildId,
    });
    qa.gates.buildIdentity = true;

    const copiedForbidden = scanTree(copyRoot, { stopAtForbidden: true });
    qa.gates.noForbiddenTestData = copiedForbidden.forbidden.length === 0;
    qa.expect('isolated copy contains no server-data/fixtures/database test data', copiedForbidden.forbidden.length === 0, copiedForbidden.forbidden);

    const packedDaemonPath = path.join(copiedPackageRoot, 'resources', 'app', 'daemon', 'daemon.cjs');
    qa.expect('packaged daemon path is exact', fs.existsSync(packedDaemonPath), packedDaemonPath);
    qa.expect('packaged daemon bytes match manifest', manifest.facts.daemonSha256 === sha256File(packedDaemonPath), {
      manifest: manifest.facts.daemonSha256,
      actual: sha256File(packedDaemonPath),
    });
    const requirePacked = createRequire(packedDaemonPath);
    delete process.env.ZS_PACKED_ENTRY;
    delete process.env.ZS_DAEMON_ENTRY;
    const packed = requirePacked(packedDaemonPath);
    qa.expect('packaged daemon exports startDaemon', typeof packed.startDaemon === 'function', Object.keys(packed));
    const appDataDir = path.join(copyRoot, 'server-data');
    const projectDir = path.join(copyRoot, 'r92-project');
    fs.mkdirSync(projectDir, { recursive: true });
    const pipeBase = `zs-r92-qa-${sha256(copyRoot).slice(0, 16)}`;

    result.phase = 'first-daemon-start';
    const firstAdapter = new SyntheticRuntimeAdapter('first');
    const firstSession = currentSession = await startDaemonSession({
      packedDaemonPath,
      startDaemon: packed.startDaemon,
      appDataDir,
      pipeName: pipeBase,
      adapter: firstAdapter,
      label: 'first',
    });
    result.daemon = {
      packedDaemonPath,
      buildIdAtStart: manifest.build.buildId,
      first: { pipeName: firstSession.pipeName, appDataDir, startedAt: firstSession.startedAt },
      reopen: null,
    };
    qa.expect('first daemon uses copied BUILD', readJson(path.join(copiedPackageRoot, 'BUILD.json')).buildId === manifest.build.buildId);
    qa.expect('first daemon data root is isolated copy', isSameOrInside(firstSession.appDataDir, copyRoot), firstSession.appDataDir);

    result.phase = 'fixture-setup';
    const projectData = await command(firstSession, receipts, 'project.open', { path: projectDir });
    const projectId = projectData?.project?.id;
    qa.expect('project.open through command surface succeeded', typeof projectId === 'string', projectData);
    const roomList = await command(firstSession, receipts, 'room.list', { projectId });
    const room = Array.isArray(roomList?.items) ? roomList.items[0] : null;
    qa.expect('room.list returned a root room', room != null && typeof room.id === 'string' && typeof room.conversationId === 'string', roomList);
    const a = (await command(firstSession, receipts, 'member.create', {
      projectId,
      displayName: 'R92-A-协调者',
    }))?.memberId;
    const b = (await command(firstSession, receipts, 'member.create', {
      projectId,
      displayName: 'R92-B-回复者',
    }))?.memberId;
    qa.expect('member.create created A', typeof a === 'string', a);
    qa.expect('member.create created B', typeof b === 'string', b);
    for (const memberId of [a, b]) {
      await command(firstSession, receipts, 'member.setRuntime', {
        memberId,
        kind: 'fake',
        permissionMode: 'bypassPermissions',
      });
    }
    const bindingRows = firstSession.daemon.db.prepare("SELECT pm.id,ri.kind,ap.settings_json FROM project_members pm LEFT JOIN agent_profiles ap ON ap.id=pm.profile_id LEFT JOIN runtime_installations ri ON ri.id=ap.runtime_installation_id WHERE pm.id IN (?,?) ORDER BY pm.id").all(a, b);
    const bindingFacts = bindingRows.map((row) => {
      let permissionMode;
      try { permissionMode = JSON.parse(row.settings_json ?? '{}').permissionMode ?? null; } catch { permissionMode = 'invalid-json'; }
      return { memberId: row.id, kind: row.kind, permissionMode };
    });
    qa.expect('A/B bindings are fake + bypassPermissions', bindingFacts.length === 2
      && bindingFacts.every((binding) => binding.kind === 'fake' && binding.permissionMode === 'bypassPermissions'),
      bindingFacts);
    qa.expect('startDaemon constructed factories without ZS_ALLOW_FAKE and enabled it only after injection',
      firstSession.allowFakeDuringFactoryConstruction === false
      && firstSession.allowFakeAfterInjection === true
      && firstSession.injectedAdapterKind === 'r92-synthetic-runtime-adapter',
      {
        allowFakeDuringFactoryConstruction: firstSession.allowFakeDuringFactoryConstruction,
        allowFakeAfterInjection: firstSession.allowFakeAfterInjection,
        injectedAdapterKind: firstSession.injectedAdapterKind,
      });
    result.identities.bindings = bindingFacts;
    const currentRoomList = await command(firstSession, receipts, 'room.list', { projectId });
    const currentRoom = currentRoomList?.items?.find((item) => item.id === room.id);
    qa.expect('room revision is readable', currentRoom != null && Number.isSafeInteger(currentRoom.revision), currentRoom);
    await command(firstSession, receipts, 'room.update', {
      roomId: room.id,
      expectedRevision: currentRoom.revision,
      coordinatorMemberId: a,
    });
    const initialMembers = await command(firstSession, receipts, 'member.list', { projectId, roomId: room.id });
    for (const member of initialMembers?.items ?? []) {
      if (member.id !== a && member.id !== b) {
        await command(firstSession, receipts, 'room.members.set', { roomId: room.id, memberId: member.id, action: 'remove' });
      }
    }
    const finalMembers = await command(firstSession, receipts, 'member.list', { projectId, roomId: room.id });
    const finalMemberIds = (finalMembers?.items ?? []).map((member) => member.id).sort();
    qa.expect('room has exactly explicit A/B members', finalMemberIds.length === 2
      && finalMemberIds.includes(a)
      && finalMemberIds.includes(b), finalMemberIds);
    firstAdapter.memberIds = { a, b };
    result.identities.fixture = { projectId, roomId: room.id, conversationId: room.conversationId, a, b };
    result.phase = 'handoff-scenario';
    firstAdapter.scenario = 'handoff';
    const handoffSent = await command(firstSession, receipts, 'message.submit', {
      target: { kind: 'room_root', projectId, roomId: room.id, conversationId: room.conversationId },
      body: HANDOFF_BODY,
      intent: 'default',
      mentions: [{ kind: 'member', memberId: a }, { kind: 'member', memberId: b }],
    });
    qa.expect('message.submit returned task/thread identity', typeof handoffSent?.taskId === 'string' && typeof handoffSent?.threadId === 'string', handoffSent);
    const handoff = await assertHandoffScenario(firstSession, handoffSent, a, b, receipts, qa);
    result.scenarios.handoff = handoff;
    result.identities.handoff = {
      taskId: handoffSent.taskId,
      threadId: handoffSent.threadId,
      messageId: handoffSent.messageId ?? null,
      coordinationRunId: handoff.inspection.run?.run_id ?? null,
      integrationRunId: handoff.inspection.run?.integration_run_id ?? null,
      integrationTurnId: handoff.targetTurn?.id ?? null,
      targetDeliveryId: handoff.delivery?.id ?? null,
    };
    qa.gates.handoffScenario = qa.checks.filter((check) => check.name.startsWith('handoff:')).every((check) => check.ok);
    result.realCalls.afterHandoff = realCallCount(firstSession.daemon.db);
    qa.expect('real_calls=0 after handoff scenario', result.realCalls.afterHandoff === 0, result.realCalls.afterHandoff);

    result.phase = 'no-handoff-scenario';
    firstAdapter.scenario = 'no_handoff';
    const noHandoffSent = await command(firstSession, receipts, 'message.submit', {
      target: { kind: 'room_root', projectId, roomId: room.id, conversationId: room.conversationId },
      body: NO_HANDOFF_BODY,
      intent: 'default',
      mentions: [{ kind: 'member', memberId: a }, { kind: 'member', memberId: b }],
    });
    qa.expect('no-handoff message.submit returned task/thread identity', typeof noHandoffSent?.taskId === 'string' && typeof noHandoffSent?.threadId === 'string', noHandoffSent);
    const noHandoff = await assertNoHandoffScenario(firstSession, noHandoffSent, a, b, receipts, qa);
    result.scenarios.noHandoff = noHandoff;
    result.identities.noHandoff = {
      taskId: noHandoffSent.taskId,
      threadId: noHandoffSent.threadId,
      messageId: noHandoffSent.messageId ?? null,
      coordinationRunId: noHandoff.inspection.run?.run_id ?? null,
      integrationRunId: null,
    };
    qa.gates.noHandoffScenario = qa.checks.filter((check) => check.name.startsWith('no-handoff:')
      && !check.name.startsWith('no-handoff repeat drain:')).every((check) => check.ok);
    result.realCalls.afterNoHandoff = realCallCount(firstSession.daemon.db);
    qa.expect('real_calls=0 after no-handoff scenario', result.realCalls.afterNoHandoff === 0, result.realCalls.afterNoHandoff);

    const beforeReopenHandoff = taskInspection(firstSession.daemon.db, handoffSent.taskId, a, b);
    const beforeReopenNoHandoff = taskInspection(firstSession.daemon.db, noHandoffSent.taskId, a, b);
    const callsBeforeStop = firstAdapter.startTurnLog.length;

    result.phase = 'first-daemon-stop';
    firstSession.pipe.close();
    const stopFirst = await stopDaemonSession(firstSession, stopRecords.first = {}, { forceOnIncomplete: true });
    currentSession = null;
    qa.expect('first daemon closed cleanly', stopFirst?.complete === true, stopFirst);
    qa.expect('first daemon did not call adapter while stopping', firstAdapter.startTurnLog.length === callsBeforeStop, {
      before: callsBeforeStop,
      after: firstAdapter.startTurnLog.length,
    });

    result.phase = 'reopen-same-isolated-database';
    const reopenAdapter = new SyntheticRuntimeAdapter('reopen');
    reopenAdapter.scenario = 'reopen';
    const reopenSession = currentSession = await startDaemonSession({
      packedDaemonPath,
      startDaemon: packed.startDaemon,
      appDataDir,
      pipeName: pipeBase,
      adapter: reopenAdapter,
      label: 'reopen',
    });
    reopenAdapter.memberIds = { a, b };
    qa.expect('reopen uses same copied BUILD', readJson(path.join(copiedPackageRoot, 'BUILD.json')).buildId === manifest.build.buildId);
    qa.expect('reopen uses same isolated state.sqlite', samePath(path.join(reopenSession.appDataDir, 'state.sqlite'), path.join(appDataDir, 'state.sqlite')), reopenSession.appDataDir);
    const reopenDrain1 = await reopenSession.daemon.worker.drain();
    const reopenDrain2 = await reopenSession.daemon.worker.drain();
    await sleep(180);
    qa.expect('reopen drain did not start any adapter turn', reopenAdapter.startTurnLog.length === 0, reopenAdapter.startTurnLog);
    const afterReopenHandoff = taskInspection(reopenSession.daemon.db, handoffSent.taskId, a, b);
    const afterReopenNoHandoff = taskInspection(reopenSession.daemon.db, noHandoffSent.taskId, a, b);
    qa.expect('reopen preserved handoff turn identities', json(afterReopenHandoff.turns.map((turn) => turn.id)) === json(beforeReopenHandoff.turns.map((turn) => turn.id)), {
      before: beforeReopenHandoff.turns.map((turn) => turn.id),
      after: afterReopenHandoff.turns.map((turn) => turn.id),
    });
    qa.expect('reopen preserved no-handoff turn identities', json(afterReopenNoHandoff.turns.map((turn) => turn.id)) === json(beforeReopenNoHandoff.turns.map((turn) => turn.id)), {
      before: beforeReopenNoHandoff.turns.map((turn) => turn.id),
      after: afterReopenNoHandoff.turns.map((turn) => turn.id),
    });
    qa.expect('reopen preserved handoff run completion', afterReopenHandoff.run?.state === 'completed', afterReopenHandoff.run);
    qa.expect('reopen preserved no-handoff run completion', afterReopenNoHandoff.run?.state === 'completed' && afterReopenNoHandoff.run?.integration_run_id == null, afterReopenNoHandoff.run);
    const reopenedHandoffMessage = afterReopenHandoff.messages.find((message) => message.purpose === 'reply') ?? null;
    qa.expect('reopen preserved handoff target turn/delivery', reopenedHandoffMessage?.status === 'completed'
      && reopenedHandoffMessage?.target_turn_id === handoff.targetTurn?.id
      && reopenedHandoffMessage?.target_delivery_id === handoff.delivery?.id, reopenedHandoffMessage);
    const reopenedHistory = await command(reopenSession, receipts, 'thread.history', { threadId: handoffSent.threadId, limit: 100 });
    const reopenedItems = Array.isArray(reopenedHistory?.items) ? reopenedHistory.items : [];
    qa.expect('reopen preserved readable integration reply', reopenedItems.at(-1)?.authorId === a
      && reopenedItems.at(-1)?.body?.text === INTEGRATION_ANSWER, reopenedItems.at(-1));
    const reopenedNoHandoffHistory = await command(reopenSession, receipts, 'thread.history', { threadId: noHandoffSent.threadId, limit: 100 });
    const reopenedNoHandoffItems = Array.isArray(reopenedNoHandoffHistory?.items) ? reopenedNoHandoffHistory.items : [];
    const reopenedNoHandoffAgentItems = reopenedNoHandoffItems.filter((item) => item?.authorType === 'agent');
    qa.expect('reopen preserved no-handoff A/B replies', reopenedNoHandoffAgentItems.length === 2
      && reopenedNoHandoffAgentItems.filter((item) => item?.authorId === a && item?.body?.text === A_ANSWER).length === 1
      && reopenedNoHandoffAgentItems.filter((item) => item?.authorId === b && item?.body?.text === B_ANSWER).length === 1,
      reopenedNoHandoffAgentItems);
    result.realCalls.afterReopen = realCallCount(reopenSession.daemon.db);
    qa.expect('real_calls=0 after reopen', result.realCalls.afterReopen === 0, result.realCalls.afterReopen);
    result.daemon.reopen = {
      pipeName: reopenSession.pipeName,
      appDataDir: reopenSession.appDataDir,
      startedAt: reopenSession.startedAt,
      drains: [reopenDrain1, reopenDrain2],
      adapterCalls: reopenAdapter.startTurnLog.length,
    };
    qa.gates.reopenPersistence = qa.checks.filter((check) => check.name.includes('reopen') || check.name.includes('preserved no-handoff')).every((check) => check.ok);
    qa.gates.sameBuildIsolatedDaemon = manifest.build.buildId === readJson(path.join(copiedPackageRoot, 'BUILD.json')).buildId
      && isSameOrInside(appDataDir, copyRoot);
    qa.gates.commandSurface = receipts.some((receipt) => receipt.method === 'message.submit' && receipt.ok);
    qa.gates.realCallsZero = result.realCalls.afterHandoff === 0
      && result.realCalls.afterNoHandoff === 0
      && result.realCalls.afterReopen === 0;

    result.phase = 'reopen-stop';
    reopenSession.pipe.close();
    const stopReopen = await stopDaemonSession(reopenSession, stopRecords.reopen = {}, { forceOnIncomplete: true });
    currentSession = null;
    qa.expect('reopen daemon closed cleanly', stopReopen?.complete === true, stopReopen);
    qa.expect('reopen stop did not call adapter', reopenAdapter.startTurnLog.length === 0, reopenAdapter.startTurnLog);

    result.phase = 'source-unchanged';
    result.sourceFingerprint.after = sourceFingerprint(sourcePackageRoot);
    result.sourceFingerprint.unchanged = sourceFingerprintEquals(result.sourceFingerprint.before, result.sourceFingerprint.after);
    qa.expect('candidate source BUILD/MANIFEST unchanged', result.sourceFingerprint.unchanged === true, result.sourceFingerprint);
    qa.gates.sourceNotTouched = qa.gates.sourceNotTouched && result.sourceFingerprint.unchanged === true;

    result.phase = 'complete';
    result.stops = stopRecords;
  } catch (error) {
    result.error = errorFacts(error);
    result.failedPhase = result.phase;
    result.phase = 'failed';
    console.error(error?.stack ?? String(error));
  } finally {
    if (currentSession != null) {
      try {
        currentSession.pipe.close();
      } catch { /* best effort */ }
      try {
        const cleanupStop = await currentSession.daemon.stop({ force: true });
        stopRecords.cleanup = { at: nowIso(), result: cleanupStop };
      } catch (cleanupError) {
        stopRecords.cleanup = { at: nowIso(), error: errorFacts(cleanupError) };
      }
    }
    if (sourcePackageRoot != null && fs.existsSync(sourcePackageRoot)) {
      try {
        if (result.sourceFingerprint.after == null) result.sourceFingerprint.after = sourceFingerprint(sourcePackageRoot);
        result.sourceFingerprint.unchanged = result.sourceFingerprint.before == null
          ? null
          : sourceFingerprintEquals(result.sourceFingerprint.before, result.sourceFingerprint.after);
        if (result.sourceFingerprint.unchanged === false) {
          qa.record('candidate source BUILD/MANIFEST unchanged after run', false, result.sourceFingerprint);
        }
      } catch (fingerprintError) {
        qa.record('candidate source fingerprint after run', false, errorFacts(fingerprintError));
      }
    }
    result.stops = stopRecords;
    const allChecks = qa.checks.every((check) => check.ok);
    const allGates = requiredGates.every((gate) => qa.gates[gate] === true);
    result.ok = result.error == null && allChecks && allGates;
    result.failures = qa.checks.filter((check) => !check.ok);
    result.summary = {
      checks: qa.checks.length,
      failedChecks: result.failures.length,
      gates: { ...qa.gates },
      buildId: result.build?.buildId ?? null,
      commit: result.build?.commit ?? null,
      dirty: result.build?.dirty ?? null,
      manifestCount: result.manifest?.manifestCount ?? null,
      realCalls: result.realCalls,
      handoffTurns: result.scenarios.handoff?.inspection?.turns?.length ?? null,
      noHandoffTurns: result.scenarios.noHandoff?.inspection?.turns?.length ?? null,
    };
    result.finishedAt = nowIso();
    result.package.copyRootRetained = copyRoot != null && (args.keepCopy || !result.ok);
    if (copyRoot != null && tempParent != null && result.ok && !args.keepCopy) {
      try {
        fs.rmSync(tempParent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        result.package.copyRemoved = true;
      } catch (cleanupError) {
        result.package.copyRemoved = false;
        result.package.copyCleanupError = errorFacts(cleanupError);
      }
    }
    try {
      fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
    } catch (writeError) {
      console.error(`failed to write result: ${writeError?.stack ?? writeError}`);
    }
    console.log(JSON.stringify({
      ok: result.ok,
      phase: result.phase,
      resultPath,
      buildId: result.build?.buildId ?? null,
      failedChecks: result.failures?.map((check) => check.name) ?? [],
      error: result.error?.message ?? null,
      retainedCopy: result.package.copyRootRetained ? copyRoot : null,
    }, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  }
}
function sourceFingerprintEquals(left, right) {
  if (left == null || right == null) return null;
  return left.buildSha256 === right.buildSha256
    && left.manifestSha256 === right.manifestSha256
    && left.buildBytes === right.buildBytes
    && left.manifestBytes === right.manifestBytes;
}

function priorAttemptsFor(resultPath) {
  if (!fs.existsSync(resultPath)) return [];
  try {
    const previous = readJson(resultPath);
    const older = Array.isArray(previous.priorAttempts) ? previous.priorAttempts.slice(-2) : [];
    const snapshot = { ...previous };
    delete snapshot.priorAttempts;
    return [...older, snapshot].slice(-3);
  } catch (error) {
    return [{ schemaVersion: 'unreadable-prior-result', error: errorFacts(error), path: resultPath }];
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(errorFacts(error).message);
    console.error('usage: node scripts/verify-r92-package.cjs --package <candidate-dir> [--out <evidence-dir>] [--keep-copy]');
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log('usage: node scripts/verify-r92-package.cjs --package <candidate-dir> [--out <evidence-dir>] [--keep-copy]');
    console.log('  candidate is read only; all daemon/database writes are confined to a fresh temp copy.');
    return;
  }
  const sourceRoot = path.resolve(repoRoot, args.packageArg);
  const outDir = path.resolve(repoRoot, args.outArg);
  assertSafeInputs(sourceRoot, outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const resultPath = path.join(outDir, 'result.json');
  const priorAttempts = priorAttemptsFor(resultPath);
  await runVerification(args, priorAttempts);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 2;
  });
}

module.exports = {
  main,
  parseArgs,
  verifyManifestAndBuild,
  SyntheticRuntimeAdapter,
};
