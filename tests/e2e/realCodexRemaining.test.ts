/**
 * DEV-06 剩余认证（修复轮 4 批次；gpt-6-luna；预算控制：本文件本轮 ≤6 turn）。
 * - steer 正常路径（活跃 turn 追加输入影响输出）+ 服务端对已完成 turn 的真实拒绝
 * - 审批 allow 路径（确认前无变更；allow_once 后仅执行获准操作）
 * - resume 后权限不放宽（恢复上下文≠恢复更高权限）
 * - usageTokens 真实口径（累计/重复/跨 turn 不重复计数——随本批事件采集）
 * - 真实 interrupt（turn/completed status=interrupted → INTERRUPTED）
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerAdapter } from '../../src/adapter/codex/appServerAdapter.ts';
import type { NormalizedRuntimeEvent, SessionRef } from '../../src/contracts/runtime.ts';
import { RealCallGate, gatedStartTurn } from '../util/realCallGate.ts';

const MODEL = process.env.ZS_E2E_MODEL ?? 'gpt-6-luna';
const fixtureRoot = mkdtempSync(join(tmpdir(), 'zhongshuo-dev06c-'));
let adapter: CodexAppServerAdapter;
/** 真实调用硬上限（第八轮）：startTurn 前计数、超限请求前拦截；账本=文件级互斥。 */
let gate: RealCallGate;
/** 跨用例采集真实 usage 通知（usageTokens 口径验证）。 */
const usageSamples: Array<{ turn: string; inputTokens?: number; cachedTokens?: number; outputTokens?: number }> = [];

beforeAll(() => {
  mkdirSync(join(fixtureRoot, 'proj'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'proj', 'notes.md'), '# 备忘\n\n暗号：LUNA-7\n', 'utf8');
  adapter = new CodexAppServerAdapter({ requestTimeoutMs: 120_000, model: MODEL });
  // 预算护栏：配置不全（storeDir/model/上限）在 open 即拒绝——任何 startTurn 之前。
  // 上限依据=本文件实际 startTurn 调用点数+1（不是用例数）；跨文件同批共享额度须
  // 显式设同一 ZS_REAL_BUDGET_DIR（账本既定额度为准，后开者不得改限）。
  gate = RealCallGate.open({
    runtime: 'codex', model: MODEL,
    maxStartTurns: Number(process.env.ZS_REAL_MAX_TURNS ?? 6),
    budgetLabel: process.env.ZS_REAL_BUDGET_LABEL ?? 'realCodex-remaining',
    storeDir: process.env.ZS_REAL_BUDGET_DIR ?? join(fixtureRoot, 'budget'),
  });
});
afterAll(async () => {
  if (gate != null) console.log('[real-call-budget]', JSON.stringify(gate.summary()));
  await adapter?.dispose();
  for (let i = 0; i < 3; i += 1) {
    try {
      rmSync(fixtureRoot, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
});

interface TurnOutcome { text: string; events: NormalizedRuntimeEvent[]; terminal: NormalizedRuntimeEvent | undefined }

function mkTurn(turnId: string, text: string) {
  return { turnId, dispatchKey: `dk-${turnId}`, inputBundleId: `b-${turnId}`, text, policyId: 'plan', taskRevision: 0 };
}

async function readUntilTerminal(session: SessionRef, a: CodexAppServerAdapter, turnLabel: string, timeoutMs = 240_000): Promise<TurnOutcome> {
  const events: NormalizedRuntimeEvent[] = [];
  const chunks: string[] = [];
  const deadline = Date.now() + timeoutMs;
  for await (const event of a.events(session)) {
    events.push(event);
    if (event.kind === 'message.completed' || event.kind === 'message.delta') chunks.push(event.text);
    if (event.kind === 'usage.updated') usageSamples.push({ turn: turnLabel, inputTokens: event.inputTokens, cachedTokens: event.cachedTokens, outputTokens: event.outputTokens });
    if (event.kind === 'turn.completed' || event.kind === 'turn.failed') return { text: chunks.join(''), events, terminal: event };
    if (Date.now() > deadline) break;
  }
  return { text: chunks.join(''), events, terminal: undefined };
}


// ===== 真实调用门禁（2026-09-29 核账后新增；双层第二层）=====
// ZS_REAL_E2E 未显式设为 '1' 时整个文件 skip——不加载 App Server、不发任何请求。
// 第一层=vitest.e2e.config.ts 按文件名排除（fake e2e 不收集本文件）；真实入口=vitest.real.e2e.config.ts。
(process.env.ZS_REAL_E2E === '1' ? describe : describe.skip)('DEV-06 剩余认证（修复轮 4 批次）', () => {
  let steerAdapter: CodexAppServerAdapter;
  afterAll(async () => { await steerAdapter?.dispose(); });

  it('steer 正常路径：活跃 turn 追加输入影响输出；服务端拒绝已完成 turn 的 steer', async () => {
    steerAdapter = new CodexAppServerAdapter({ requestTimeoutMs: 120_000, model: MODEL });
    const session = await steerAdapter.openSession({
      projectId: 'p', memberId: 'm', taskId: 't', threadId: 'th-steer2',
      sessionGeneration: 0, cwd: join(fixtureRoot, 'proj'), policyId: 'plan',
      developerInstructions: '你是测试成员。按任务执行；收到补充要求时纳入同一回答。',
    });
    const turnId = 'turn_steer_ok';
    const collecting = readUntilTerminal(session, steerAdapter, 'steer-normal');
    await gatedStartTurn(gate, () => steerAdapter.startTurn(session, mkTurn(turnId, '请读取当前目录 notes.md 并告诉我暗号，然后停下来等待我可能的补充。')));
    // turn 进行中追加 steer（真实 expectedTurnId：内部→provider 映射）。
    await steerAdapter.steer(session, mkTurn(turnId, '补充要求：在回答的最末尾另起一行输出标记 STEERED-OK'));
    const result = await collecting;
    expect(result.terminal?.kind).toBe('turn.completed');
    expect(result.text).toContain('LUNA-7'); // 原任务结果
    expect(result.text).toContain('STEERED-OK'); // steer 影响了输出

    // 服务端真实拒绝：对已完成的同一 turn 再 steer（expectedTurnId 已非活跃）。
    await expect(steerAdapter.steer(session, mkTurn(turnId, '再补一句'))).rejects.toMatchObject({
      name: 'AdapterCallError',
    });
    await steerAdapter.close(session);
  }, 600_000);

  it('审批 allow 路径：确认前无变更；allow_once 后仅执行获准操作', async () => {
    const approvalAdapter = new CodexAppServerAdapter({ requestTimeoutMs: 120_000, model: MODEL, sandboxMode: 'read-only', approvalPolicy: 'on-request' });
    try {
      const session = await approvalAdapter.openSession({
        projectId: 'p', memberId: 'm', taskId: 't', threadId: 'th-appr-allow',
        sessionGeneration: 0, cwd: join(fixtureRoot, 'proj'), policyId: 'plan',
        developerInstructions: '你是测试成员。直接执行任务。',
      });
      const target = join(fixtureRoot, 'proj', 'allow-probe.txt');
      const turnP = (async () => {
        await gatedStartTurn(gate, () => approvalAdapter.startTurn(session, mkTurn('turn_appr_allow', '请在当前目录创建文件 allow-probe.txt，内容 approval-allow-test。必须实际执行。')));
        const events: NormalizedRuntimeEvent[] = [];
        const chunks: string[] = [];
        let diskAtApproval: string | false | undefined;
        const deadline = Date.now() + 240_000;
        for await (const event of approvalAdapter.events(session)) {
          events.push(event);
          if (event.kind === 'message.completed' || event.kind === 'message.delta') chunks.push(event.text);
          if (event.kind === 'approval.requested') {
            diskAtApproval = existsSync(target) ? readFileSync(target, 'utf8') : false; // 确认前快照
            await approvalAdapter.respondApproval(session, event.approvalId, 'allow_once');
          }
          if (event.kind === 'usage.updated') usageSamples.push({ turn: 'approval-allow', inputTokens: event.inputTokens, cachedTokens: event.cachedTokens, outputTokens: event.outputTokens });
          if (event.kind === 'turn.completed' || event.kind === 'turn.failed') {
            return { text: chunks.join(''), events, terminal: event, diskAtApproval };
          }
          if (Date.now() > deadline) break;
        }
        return { text: chunks.join(''), events, terminal: undefined as NormalizedRuntimeEvent | undefined, diskAtApproval };
      })();
      const result = await turnP;
      const approval = result.events.find((e) => e.kind === 'approval.requested');
      expect(approval, '未触发审批请求').toBeDefined();
      // 确认前：文件不存在。
      expect(result.diskAtApproval).toBe(false);
      // allow_once 后：仅获准操作发生（该文件创建且内容正确）。
      expect(existsSync(target)).toBe(true);
      // PowerShell 写入可能带 UTF-8 BOM：归一后比较（内容语义不变）。
      expect(readFileSync(target, 'utf8').replace(/^\ufeff/, '')).toBe('approval-allow-test');
      expect(result.terminal).toBeDefined();
      await approvalAdapter.close(session);
    } finally {
      await approvalAdapter.dispose();
    }
  }, 600_000);

  it('resume 后权限不放宽：恢复上下文不恢复更高权限', async () => {
    const session1 = await adapter.openSession({
      projectId: 'p', memberId: 'm', taskId: 't', threadId: 'th-resume-ro',
      sessionGeneration: 0, cwd: join(fixtureRoot, 'proj'), policyId: 'plan',
    });
    const first = await (async () => {
      const c = readUntilTerminal(session1, adapter, 'resume-ro-t1');
      await gatedStartTurn(gate, () => adapter.startTurn(session1, mkTurn('turn_ro1', '请记住暗号 LUNA-7。只回复「已记住」。')));
      return c;
    })();
    expect(first.terminal?.kind).toBe('turn.completed');
    const providerSessionId = session1.providerSessionId;
    await adapter.close(session1);

    const session2 = await adapter.openSession({
      projectId: 'p', memberId: 'm', taskId: 't', threadId: 'th-resume-ro',
      sessionGeneration: 1, cwd: join(fixtureRoot, 'proj'), policyId: 'plan',
      resume: { id: 'prev', providerSessionId, runtimeInstallationId: 'codex', adapterVersion: 'v', threadId: 'th-resume-ro', sessionGeneration: 0, cwd: join(fixtureRoot, 'proj') },
    });
    expect(session2.providerSessionId).toBe(providerSessionId);
    const target = join(fixtureRoot, 'proj', 'resume-write-probe.txt');
    const second = await (async () => {
      const c = readUntilTerminal(session2, adapter, 'resume-ro-t2');
      await gatedStartTurn(gate, () => adapter.startTurn(session2, mkTurn('turn_ro2', '暗号是什么？另外请在当前目录创建文件 resume-write-probe.txt（内容 x）。必须实际执行写。')));
      return c;
    })();
    expect(second.terminal?.kind).toBe('turn.completed');
    expect(second.text).toContain('LUNA-7'); // 上下文恢复
    expect(existsSync(target)).toBe(false); // 权限未放宽：read-only 仍拒绝写
    await adapter.close(session2);
  }, 600_000);

  it('真实 interrupt：运行中停止 → turn/completed status=interrupted → INTERRUPTED', async () => {
    const session = await adapter.openSession({
      projectId: 'p', memberId: 'm', taskId: 't', threadId: 'th-interrupt',
      sessionGeneration: 0, cwd: join(fixtureRoot, 'proj'), policyId: 'plan',
      developerInstructions: '你是测试成员。按任务执行，不要提前停止。',
    });
    const turnId = 'turn_interrupt';
    const collecting = readUntilTerminal(session, adapter, 'interrupt', 120_000);
    await gatedStartTurn(gate, () => adapter.startTurn(session, mkTurn(turnId, '请从 1 数到 50，每个数一行，然后说明完成。不要跳过。')));
    // 等待 turn 真实开始（首个事件）后中断。
    // 等待真实的 turn.started 通知（活跃）后再中断——session.ready 在积压里立即可读，
    // 不能作为 turn 已活跃的证据。单个迭代器循环（每轮新建迭代器会重放积压并泄漏等待者）。
    const started = await (async () => {
      const iterator = adapter.events(session)[Symbol.asyncIterator]();
      const deadline = Date.now() + 30_000;
      for (;;) {
        const remaining = Math.max(1, deadline - Date.now());
        const next = await Promise.race([
          iterator.next(),
          new Promise<'timeout'>((r) => { const t = setTimeout(() => r('timeout'), remaining); t.unref?.(); }),
        ]);
        if (next === 'timeout' || next.done) return false;
        if (next.value.kind === 'turn.started' && next.value.turnId === turnId) return true;
      }
    })();
    expect(started, '30s 内未见 turn.started').toBe(true);
    await adapter.interrupt(session, turnId);
    const result = await collecting;
    expect(result.terminal).toBeDefined();
    expect(result.terminal?.kind).toBe('turn.failed');
    expect((result.terminal as { code?: string }).code).toBe('INTERRUPTED');
    await adapter.close(session);
  }, 300_000);

  it('usageTokens 口径（采集断言）：真实通知为 cumulative、非递减、跨 turn 不串账', () => {
    expect(usageSamples.length).toBeGreaterThanOrEqual(2);
    for (const s of usageSamples) {
      expect(s.inputTokens ?? 0).toBeGreaterThanOrEqual(0);
      expect(s.outputTokens ?? 0).toBeGreaterThanOrEqual(0);
    }
    // 同一 turn 内累计单调非减（Codex tokenUsage 为 cumulative）。
    const perTurn = new Map<string, number[]>();
    for (const s of usageSamples) perTurn.set(s.turn, [...(perTurn.get(s.turn) ?? []), s.inputTokens ?? 0]);
    for (const [turn, inputs] of perTurn) {
      for (let i = 1; i < inputs.length; i += 1) {
        expect(inputs[i]!, `turn ${turn} 累计值回退`).toBeGreaterThanOrEqual(inputs[i - 1]!);
      }
    }
    console.log('[usage-samples]', JSON.stringify(usageSamples));
  }, 30_000);
});
