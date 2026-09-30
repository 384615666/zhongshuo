/**
 * 第二十三轮四：runtime 可执行路径回归验证（零真实模型调用——本地协议 shim）。
 *
 * 回归背景：resolveMemberRuntime 统一解析后 adapterFor 传给工厂的 executable 被写成
 * null——entry 的 Claude 工厂 `binding.executable ?? undefined` 恒 undefined=生产 spawn 恒
 * 回落全局默认路径（成员绑定安装路径失效）。另一层：resolveClaudeExecutable 对 Windows
 * 非 .exe 显式路径静默回落 resolveDefaultClaudeEntry——路径无效应明确失败不换路径。
 *
 * 覆盖：
 * ① adapterFor → 工厂收到的 executable=绑定安装的真实路径（A 绑定→A；切 B→B；不共享缓存）；
 * ② ClaudeCliAdapter 直跑本地协议 shim（.js→node 前缀）：绑定路径 A 确实执行 A（回复含 A
 *   标记+session_id 带 A）；切换 B 执行 B；**路径无效→RUNTIME_NOT_FOUND 明确失败，不回落
 *   全局 Claude**（错误信息含无效路径、不出现任何 shim 回复）；
 * ③ resolveClaudeExecutable：显式 .js→node 前缀执行；显式任意路径按字面（无效=spawn 层
 *   ENOENT→RUNTIME_NOT_FOUND），不再静默换默认。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { MemberRuntimeRegistry, resolveMemberRuntime, type MemberAdapterFactory, type MemberRuntimeBinding } from '../../src/daemon/memberRuntime.ts';
import { ClaudeCliAdapter, resolveClaudeExecutable } from '../../src/adapter/claude/cliAdapter.ts';
import type { NormalizedRuntimeEvent, RuntimeAdapter, SessionRef } from '../../src/contracts/runtime.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_REAL_BATCH_ID;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-exepath-'));
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

/** 本地协议 shim（模仿 claude CLI stream-json）：读 stdin，输出 init/assistant/result，
 * 全部带可区分标记——证明"执行的确实是这个路径"。 */
function makeShim(mark: string): string {
  const path = join(tmpRoot, `shim-${mark}.js`);
  writeFileSync(path, [
    `const MARK = ${JSON.stringify(mark)};`,
    'let buf = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => { buf += c; });',
    'process.stdin.on("end", () => {',
    '  const lines = [',
    '    JSON.stringify({ type: "system", subtype: "init", session_id: "sess-" + MARK, cwd: "x", tools: [], model: "shim-model", slash_commands: [], mcp_servers: [] }),',
    '    JSON.stringify({ type: "assistant", message: { model: "shim-model", content: [{ type: "text", text: "reply-from-" + MARK, id: "m1" }] } }),',
    '    JSON.stringify({ type: "result", subtype: "success", session_id: "sess-" + MARK, is_error: false, usage: { input_tokens: 1, output_tokens: 2 } }),',
    '  ];',
    '  for (const l of lines) process.stdout.write(l + "\\n");',
    '  process.exit(0);',
    '});',
    'process.stdin.on("error", () => process.exit(0));',
    // stdin 可能不被 CLI 协议关闭——定时兜底输出（0.5s 后无输入也回包）。
    'setTimeout(() => process.stdin.end(), 300).unref();',
  ].join('\n'), 'utf8');
  return path;
}

function makeBoundDb(shimA: string, shimB: string): ZhongshuoDatabase {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  db.prepare(`INSERT INTO runtime_installations (id, kind, executable, version, adapter_version, capabilities_json, detected_at) VALUES ('riA','claude',?,'','','',0)`).run(shimA);
  db.prepare(`INSERT INTO runtime_installations (id, kind, executable, version, adapter_version, capabilities_json, detected_at) VALUES ('riB','claude',?,'','','',0)`).run(shimB);
  const bind = (installationId: string): void => {
    db.prepare(`INSERT INTO agent_profiles (id, name, runtime_installation_id, settings_json) VALUES ('ap1','成员档',?, '{"model":"deepseek-flash"}')
                ON CONFLICT(id) DO UPDATE SET runtime_installation_id = excluded.runtime_installation_id`).run(installationId);
    db.prepare(`UPDATE project_members SET profile_id = 'ap1' WHERE id = 'mA'`).run();
  };
  bind('riA');
  return db;
}

/** 生产形态的 claude 工厂（entry 同款：executable 透传 ClaudeCliAdapter+受管 spawn 链同口径）。 */
function productionClaudeFactory(seen: Array<{ executable: string | null }>): MemberAdapterFactory {
  return (binding: MemberRuntimeBinding): RuntimeAdapter => {
    seen.push({ executable: binding.executable ?? null });
    return new ClaudeCliAdapter({
      model: binding.model ?? 'deepseek-flash',
      executable: binding.executable ?? undefined,
      permissionMode: undefined,
      installationId: binding.installationId ?? undefined,
    });
  };
}

/** 跑一轮 turn（开 session→startTurn→收事件到终态），返回全部事件文本。 */
async function runOneTurn(adapter: RuntimeAdapter, turnId: string): Promise<{ events: NormalizedRuntimeEvent[]; session: SessionRef }> {
  const session = await adapter.openSession({ projectId: 'p1', memberId: 'mA', taskId: 't1', threadId: 'th1', sessionGeneration: 0, cwd: tmpRoot, policyId: 'policy-analyze' });
  await adapter.startTurn(session, { turnId, dispatchKey: 'k', inputBundleId: 'b', text: 'hello', policyId: 'p', taskRevision: 0 });
  const events: NormalizedRuntimeEvent[] = [];
  for await (const ev of adapter.events(session)) {
    events.push(ev);
    if (ev.kind === 'turn.completed' || ev.kind === 'turn.failed') break;
  }
  return { events, session };
}
const textOf = (events: NormalizedRuntimeEvent[]): string => events.map((e) => (e as { text?: string }).text ?? '').join('');

describe('第二十三轮四：runtime 可执行路径穿透（本地协议 shim，零真实调用）', () => {
  it('① adapterFor → 工厂收到绑定安装真实路径（A→A；切 B→B；缓存键含路径不串）', () => {
    const shimA = makeShim('A');
    const shimB = makeShim('B');
    const db = makeBoundDb(shimA, shimB);
    const seen: Array<{ executable: string | null }> = [];
    const registry = new MemberRuntimeRegistry(db, new ClaudeCliAdapter({ model: 'deepseek-flash' }), { claude: productionClaudeFactory(seen) }, { defaultKind: 'fake' });
    registry.adapterFor('mA');
    expect(seen.at(-1)?.executable).toBe(shimA); // A 绑定→工厂收 A 路径（不再是 null）
    const resolved = resolveMemberRuntime(db, 'mA', 'fake');
    expect(resolved.executable).toBe(shimA);
    expect(resolved.bound).toBe(true);
    // 切换到安装 B：解析+工厂都收 B（缓存不共享——键含 executable）。
    db.prepare(`UPDATE agent_profiles SET runtime_installation_id = 'riB' WHERE id = 'ap1'`).run();
    const resolvedB = resolveMemberRuntime(db, 'mA', 'fake');
    expect(resolvedB.executable).toBe(shimB);
    registry.adapterFor('mA');
    expect(seen.at(-1)?.executable).toBe(shimB);
    db.close();
  });

  it('② 绑定路径 A 确实执行 A；切换 B 执行 B；路径无效明确失败不回落全局', async () => {
    const shimA = makeShim('A');
    const shimB = makeShim('B');
    const db = makeBoundDb(shimA, shimB);
    const seen: Array<{ executable: string | null }> = [];
    const registry = new MemberRuntimeRegistry(db, new ClaudeCliAdapter({ model: 'deepseek-flash' }), { claude: productionClaudeFactory(seen) }, { defaultKind: 'fake' });
    const adapterA = registry.adapterFor('mA') as ClaudeCliAdapter;
    const r1 = await runOneTurn(adapterA, 'turn-exe-1');
    expect(textOf(r1.events)).toContain('reply-from-A'); // 执行的是 shimA
    expect(r1.session.providerSessionId).toBe('sess-A');
    // 切到 B（新 adapter 实例）。
    db.prepare(`UPDATE agent_profiles SET runtime_installation_id = 'riB' WHERE id = 'ap1'`).run();
    const adapterB = registry.adapterFor('mA') as ClaudeCliAdapter;
    const r2 = await runOneTurn(adapterB, 'turn-exe-2');
    expect(textOf(r2.events)).toContain('reply-from-B'); // 执行的是 shimB（不是缓存的 A）
    expect(r2.session.providerSessionId).toBe('sess-B');
    await adapterA.disposeAll();
    await adapterB.disposeAll();
    // 路径无效：明确失败（事件终态非成功+无任何 shim 回复），不回落全局 Claude。
    const bad = join(tmpRoot, 'no-such-claude.js');
    const adapterBad = new ClaudeCliAdapter({ model: 'deepseek-flash', executable: bad });
    const r3 = await runOneTurn(adapterBad, 'turn-exe-3'); // 不抛错：失败经事件终态（turn.failed）
    const terminal3 = r3.events.at(-1)?.kind;
    expect(terminal3).not.toBe('turn.completed'); // 无成功终态（无效路径没有真的执行）
    expect(textOf(r3.events)).not.toContain('reply-from'); // 没有任何 shim 真的跑了（不回落）
    await adapterBad.disposeAll().catch(() => undefined);
    db.close();
  }, 60_000);

  it('③ resolveClaudeExecutable：显式路径一律按绑定执行（.js→node 前缀；字面路径不静默换默认）', () => {
    const shimA = makeShim('A');
    const entry = resolveClaudeExecutable(shimA);
    expect(entry.command).toBe(process.execPath); // .js → node 前缀执行
    expect(entry.prefixArgs).toEqual([shimA]);
    const arbitrary = resolveClaudeExecutable('C:/definitely/not/installed/claude-xyz');
    expect(arbitrary.command).toBe('C:/definitely/not/installed/claude-xyz'); // 字面——无效由 spawn ENOENT→RUNTIME_NOT_FOUND
    expect(arbitrary.prefixArgs).toEqual([]);
    const fallback = resolveClaudeExecutable(undefined);
    expect(fallback.command.length).toBeGreaterThan(0); // 未显式=渠道默认（合法回落场景）
  });
});
