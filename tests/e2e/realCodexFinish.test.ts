/**
 * DEV-06 收尾认证：steer（PP-12 局部）/ resume 续接（PP-02 局部）/ 审批桥 deny（RT-23 确认档局部）。
 * 专用 fixture + 有限预算（≤5 turn）；仅 `pnpm test:e2e` 执行。模型 gpt-6-luna。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerAdapter } from '../../src/adapter/codex/appServerAdapter.ts';
import type { NormalizedRuntimeEvent, SessionRef } from '../../src/contracts/runtime.ts';

const MODEL = process.env.ZS_E2E_MODEL ?? 'gpt-6-luna';
const fixtureRoot = mkdtempSync(join(tmpdir(), 'zhongshuo-dev06b-'));
let adapter: CodexAppServerAdapter;

beforeAll(() => {
  mkdirSync(join(fixtureRoot, 'proj'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'proj', 'notes.md'), '# 备忘\n\n暗号：LUNA-RESUME-7\n', 'utf8');
  adapter = new CodexAppServerAdapter({ requestTimeoutMs: 120_000, model: MODEL });
});
afterAll(async () => {
  await adapter?.dispose();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

async function runTurn(session: SessionRef, text: string, timeoutMs = 240_000): Promise<{ text: string; events: NormalizedRuntimeEvent[]; terminal: NormalizedRuntimeEvent | undefined }> {
  await adapter.startTurn(session, { turnId: `turn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, dispatchKey: `dk-${Date.now()}`, inputBundleId: 'b', text, policyId: 'p', taskRevision: 0 });
  const events: NormalizedRuntimeEvent[] = [];
  const chunks: string[] = [];
  const deadline = Date.now() + timeoutMs;
  for await (const event of adapter.events(session)) {
    events.push(event);
    if (event.kind === 'message.completed' || event.kind === 'message.delta') chunks.push(event.text);
    if (event.kind === 'turn.completed' || event.kind === 'turn.failed') return { text: chunks.join(''), events, terminal: event };
    if (Date.now() > deadline) break;
  }
  return { text: chunks.join(''), events, terminal: undefined };
}

describe('DEV-06 收尾：steer / resume / 审批桥（gpt-6-luna）', () => {
  it('steer：错误 expectedTurnId 被拒（无模型调用）', async () => {
    const session = await adapter.openSession({
      projectId: 'p', memberId: 'm', taskId: 't', threadId: 'th-steer',
      sessionGeneration: 0, cwd: join(fixtureRoot, 'proj'), policyId: 'plan',
    });
    // 未登记任何 provider turn → steer 无 expectedTurnId 可用即拒绝；
    // 再用伪造 ID 直接请求协议层校验。
    await expect(
      adapter.steer(session, { turnId: 'turn_nonexistent', dispatchKey: 'dk', inputBundleId: 'b', text: 'x', policyId: 'p', taskRevision: 0 }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    await adapter.close(session);
  }, 30_000);

  it('resume：会话关闭后 thread/resume 续接——上轮暗号可回忆', async () => {
    // turn 1：记忆暗号。
    const s1 = await adapter.openSession({
      projectId: 'p', memberId: 'm', taskId: 't', threadId: 'th-resume',
      sessionGeneration: 0, cwd: join(fixtureRoot, 'proj'), policyId: 'plan',
    });
    const first = await runTurn(s1, '请记住：本次会话的专属暗号是 LUNA-RESUME-7。只回复「已记住」。');
    expect(first.terminal?.kind).toBe('turn.completed');
    const providerSessionId = s1.providerSessionId;
    await adapter.close(s1); // 关闭（进程随最后会话退出）

    // 重新拉起进程并 resume 同一 provider 线程。
    const s2 = await adapter.openSession({
      projectId: 'p', memberId: 'm', taskId: 't', threadId: 'th-resume',
      sessionGeneration: 1, cwd: join(fixtureRoot, 'proj'), policyId: 'plan',
      resume: { id: 'prev', providerSessionId, runtimeInstallationId: 'codex', adapterVersion: 'v', threadId: 'th-resume', sessionGeneration: 0, cwd: join(fixtureRoot, 'proj') },
    });
    expect(s2.providerSessionId).toBe(providerSessionId);
    const second = await runTurn(s2, '本次会话的专属暗号是什么？只回复暗号本身。');
    expect(second.terminal?.kind).toBe('turn.completed');
    expect(second.text).toContain('LUNA-RESUME-7'); // 上下文确实恢复
    await adapter.close(s2);
  }, 600_000);

  it('审批桥：workspace-write+on-request 下写文件触发审批，deny 后无写入', async () => {
    const approvalAdapter = // 确认档语义：read-only 沙箱 + on-request——写操作必须经审批升级（workspace-write 内的写入会被自动放行，不触发审批）。
    new CodexAppServerAdapter({ requestTimeoutMs: 120_000, model: MODEL, sandboxMode: 'read-only', approvalPolicy: 'on-request' });
    try {
      const session = await approvalAdapter.openSession({
        projectId: 'p', memberId: 'm', taskId: 't-appr', threadId: 'th-appr',
        sessionGeneration: 0, cwd: join(fixtureRoot, 'proj'), policyId: 'plan',
      });
      // 发起带审批语义的 turn：让模型创建文件（会触发审批请求）。
      const turnP = (async () => {
        await approvalAdapter.startTurn(session, { turnId: 'turn_appr', dispatchKey: 'dk-appr', inputBundleId: 'b', text: '请在当前目录创建文件 appr-probe.txt，内容 approval-test。必须实际执行。', policyId: 'p', taskRevision: 0 });
        const events: NormalizedRuntimeEvent[] = [];
        const chunks: string[] = [];
        const deadline = Date.now() + 240_000;
        for await (const event of approvalAdapter.events(session)) {
          events.push(event);
          if (event.kind === 'message.completed' || event.kind === 'message.delta') chunks.push(event.text);
          if (event.kind === 'approval.requested') {
            // 收到审批：立即 deny。
            await approvalAdapter.respondApproval(session, event.approvalId, 'deny');
          }
          if (event.kind === 'turn.completed' || event.kind === 'turn.failed') {
            return { text: chunks.join(''), events, terminal: event };
          }
          if (Date.now() > deadline) break;
        }
        return { text: chunks.join(''), events, terminal: undefined as NormalizedRuntimeEvent | undefined };
      })();
      const result = await turnP;
      // 审批通道真实触发过。
      const approval = result.events.find((e) => e.kind === 'approval.requested');
      expect(approval, '未触发审批请求（approvalPolicy 语义未生效或模型未尝试写入）').toBeDefined();
      // deny 后磁盘无写入。
      expect(existsSync(join(fixtureRoot, 'proj', 'appr-probe.txt'))).toBe(false);
      // 终态存在（拒绝后 turn 正常收尾）。
      expect(result.terminal).toBeDefined();
      await approvalAdapter.close(session);
    } finally {
      await approvalAdapter.dispose();
    }
  }, 600_000);
});
