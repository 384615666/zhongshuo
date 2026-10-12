/** Read-only capability timing after isolated formal configuration. No adapter/model process. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../src/daemon/commands.ts';
import { resolveClaudeExecutable } from '../src/adapter/claude/cliAdapter.ts';

const root = mkdtempSync(join(tmpdir(), 'zs-r78-refresh-'));
const config = join(root, 'config'); mkdirSync(config);
writeFileSync(join(config, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/r78-fixture' } }));
process.env.CLAUDE_CONFIG_DIR = config; delete process.env.ZS_REAL_DISPATCH_GUARD;
const db = openDatabase(':memory:');
const deps = { db, localUserId: 'u_local', appDataDir: join(root, 'data'), interruptTurn: async () => {} };
async function cmd(method: string, params: unknown) {
  const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: 'r78-perf-' + randomUUID(), method, params }) as { ok: boolean; data: Record<string, unknown>; error?: {message:string} };
  if (!r.ok) throw new Error(r.error?.message); return r.data;
}
async function main() {
  const opened = await cmd('project.open', { path: root });
  const projectId = (opened.project as {id:string}).id;
  const members: string[] = [];
  const executable = resolveClaudeExecutable();
  for (let n = 0; n < 20; n++) {
    const member = await cmd('member.create', { projectId, displayName: `工程成员${n+1}` });
    members.push(member.memberId as string);
    await cmd('member.setRuntime', { memberId: member.memberId, kind: 'claude', executable: executable.prefixArgs[0] ?? executable.command, model: 'deepseek-flash', permissionMode: 'plan' });
  }
  process.env.ZS_REAL_DISPATCH_GUARD = '1'; // Read-only timing phase; no worker is ever constructed.
  const runs = [];
  const useBatch = process.argv.includes('--batch');
  for (let n = 0; n < 4; n++) {
    const start = performance.now(); let timerAt = 0;
    const timer = new Promise<void>(r => setTimeout(() => { timerAt = performance.now(); r(); }, 0));
    const rows = useBatch ? ((await cmd('member.runtimes', { projectId, memberIds: members })).items as Array<{info:Record<string,unknown>}>).map(r => r.info)
      : await Promise.all(members.map(memberId => cmd('member.runtime', { memberId })));
    const durationMs = performance.now() - start; await timer;
    runs.push({ durationMs, eventLoopDelayMs: timerAt - start, returned: rows.length, allIdentityRead: rows.every(r => (r.imageInput as {identityKey?:string}).identityKey != null) });
  }
  const result = { kind: useBatch ? 'one member.runtimes request for 20 members' : '20 independent member.runtime requests', at: new Date().toISOString(), cold: runs[0], warm: runs.slice(1), realCalls: (db.prepare('SELECT count(*) c FROM real_calls').get() as {c:number}).c, projectMemberCount: members.length };
  const out = resolve(process.argv[2] ?? 'dist/r78-member-refresh-before.json');
  writeFileSync(out, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); db.close();
}
void main();
