'use strict';
/** 只读复现 d87f699 基线 Git 部分读取失败：esbuild onLoad 注入基线源码，不改当前源码。 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const repo = path.resolve(__dirname, '..');
const out = path.join(repo, 'dist', 'r78-git-read-before');
fs.mkdirSync(out, { recursive: true });
const old = execFileSync('git', ['show', 'd87f699:src/ui/hifi/data/actions-git.ts'], { cwd: repo, encoding: 'utf8' });
const actionPath = path.join(repo, 'src', 'ui', 'hifi', 'data', 'actions-git.ts');
const storePath = path.join(repo, 'src', 'ui', 'hifi', 'data', 'store.ts');
const entry = path.join(out, 'entry.ts');
fs.writeFileSync(entry, `export * as actions from ${JSON.stringify(actionPath.replaceAll('\\', '/'))}; export * as store from ${JSON.stringify(storePath.replaceAll('\\', '/'))};`);
const ok = (data) => ({ ok: true, data });
const fail = (message) => ({ ok: false, error: { code: 'READ_FAIL', message } });
const status = (name) => ({ branch: 'main', worktreeRoot: 'D:/r78-fixture', staged: [], unstaged: [{ xy: ' M', path: name }], untracked: [], truncated: false });
const branches = { current: 'main', branches: [{ name: 'main', oid: 'a'.repeat(40), lastCommitTs: 1, upstream: null, ahead: null, behind: null }], dirtyCount: 1 };
const history = { head: 'a'.repeat(40), hasMore: false, items: [{ oid: 'a'.repeat(40), parent: '', parents: [], authorName: 'Fixture', authorEmail: 'fixture@example.invalid', timestamp: 1, subject: 'baseline', taskIds: [], changeSetIds: [] }] };
const remotes = { remotes: [{ name: 'origin', url: 'https://example.invalid/repo.git' }] };
let phase = 'initial';
global.window = { zs: { command: async (env) => {
  if (env.method === 'git.status') return ok(status(phase === 'initial' ? 'before.md' : 'after.md'));
  if (phase === 'partial') return fail(`${env.method} 故障`);
  if (env.method === 'git.branch.list') return ok(branches);
  if (env.method === 'git.history') return ok(history);
  if (env.method === 'git.remote.list') return ok(remotes);
  throw new Error(env.method);
} } };
const facts = { baselineRef: 'd87f699', injection: 'esbuild onLoad actions-git.ts only', actualSourceUnchanged: true, stage: {} };
(async () => {
  await esbuild.build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(out, 'baseline.cjs'),
    plugins: [{ name: 'baseline-actions', setup(build) { build.onLoad({ filter: /actions-git\.ts$/ }, () => ({ contents: old, loader: 'ts', resolveDir: path.dirname(actionPath) })); } }],
  });
  const { actions, store } = require(path.join(out, 'baseline.cjs'));
  store.setState((s) => ({ ...s, projects: [{ id: 'p1', isGit: false }], git: {} }));
  await actions.refreshGitState('p1');
  const one = store.getState().git.p1;
  facts.stage.initial = { status: one.status.map((e) => e.path), branches: one.branches.length, history: one.commits.length, remotes: one.remotes.length };
  phase = 'partial';
  await actions.refreshGitState('p1');
  const two = store.getState().git.p1;
  facts.stage.partialFailure = { status: two.status.map((e) => e.path), branches: two.branches.length, history: two.commits.length, remotes: two.remotes.length, lastOp: two.lastOp ?? null };
  facts.reproduced = facts.stage.initial.branches === 1 && facts.stage.initial.history === 1 && facts.stage.initial.remotes === 1 && facts.stage.partialFailure.status[0] === 'after.md' && facts.stage.partialFailure.branches === 0 && facts.stage.partialFailure.history === 0 && facts.stage.partialFailure.remotes === 0;
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify({ reproduced: facts.reproduced, result: path.join(out, 'result.json') }));
  if (!facts.reproduced) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
