/**
 * DEV-06 真实适配认证：Codex App Server（0.157.1，stdio 换行 JSON-RPC）。
 * 专用 fixture + 独立测试会话 + 有限预算（本文件 ≤4 个真实 turn）。
 * 仅 `pnpm test:e2e` 执行；默认套件不消耗额度（§19.2）。
 * 模型：deepseek-flash（用户指定低成本渠道；经 adapter model 参数覆盖 thread/start）。
 *
 * 认证项（修复轮收紧口径）：
 * - G2-C1：真实文件内容回流（读 fixture notes.md 的暗号——非种子文本）
 * - PP-01 局部：层 A developerInstructions 实际生效（指令要求以特定暗语开头作答）
 * - B6/RT-23 计划档（read-only 沙箱）：**要求真实尝试过受限操作**——终态前必须出现
 *   对应工具活动（tool.started），且磁盘无写入；「模型失败/空结果/口头拒绝但未尝试」
 *   不构成沙箱证据。直接编辑与 shell 写入分别覆盖。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerAdapter, SUPPORTED_CODEX_VERSION_PREFIX } from '../../src/adapter/codex/appServerAdapter.ts';
import { verifySandboxRejectionEvidence } from '../../src/adapter/codex/evidence.ts';
import type { NormalizedRuntimeEvent, SessionRef } from '../../src/contracts/runtime.ts';

// 模型：默认不覆盖（走 ~/.codex/config.toml 的渠道配置）；可用 ZS_E2E_MODEL 显式指定。
const MODEL = process.env.ZS_E2E_MODEL ?? 'gpt-6-luna';
const fixtureRoot = mkdtempSync(join(tmpdir(), 'zhongshuo-dev06-'));
let adapter: CodexAppServerAdapter;

beforeAll(() => {
  mkdirSync(join(fixtureRoot, 'proj-a'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'proj-a', 'notes.md'), '# 项目备忘\n\n宇宙密码：ZS-DEV06-4242\n', 'utf8');
  adapter = new CodexAppServerAdapter({ requestTimeoutMs: 120_000, model: MODEL });
});

afterAll(async () => {
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

interface TurnOutcome {
  text: string;
  events: NormalizedRuntimeEvent[];
  terminal: NormalizedRuntimeEvent | undefined;
}

async function runTurn(session: SessionRef, input: Parameters<typeof adapter.startTurn>[1], timeoutMs = 240_000): Promise<TurnOutcome> {
  await adapter.startTurn(session, input);
  const events: NormalizedRuntimeEvent[] = [];
  const text: string[] = [];
  const deadline = Date.now() + timeoutMs;
  for await (const event of adapter.events(session)) {
    events.push(event);
    if (event.kind === 'message.completed' || event.kind === 'message.delta') text.push(event.text);
    if (event.kind === 'turn.completed' || event.kind === 'turn.failed') {
      return { text: text.join(''), events, terminal: event };
    }
    if (Date.now() > deadline) break;
  }
  return { text: text.join(''), events, terminal: undefined };
}

function turnRequest(turnId: string, text: string): Parameters<typeof adapter.startTurn>[1] {
  return { turnId, dispatchKey: `dk-${turnId}`, inputBundleId: `bundle-${turnId}`, text, policyId: 'policy-plan-readonly', taskRevision: 0 };
}

/**
 * 沙箱拒绝证据判定（修复轮 4）：共享 verifySandboxRejectionEvidence（declined-only——
 * status:failed 只是执行失败，不构成权限拒绝）+ 磁盘前后状态 + 额度/认证排除。
 */
function assertSandboxRejection(
  outcome: TurnOutcome,
  label: string,
  expectedTool: 'fileChange' | 'commandExecution',
  targetToken: string,
  diskBefore: string | false,
  diskAfter: string | false,
): void {
  const terminalMessage = outcome.terminal?.kind === 'turn.failed' ? outcome.terminal.message : '';
  expect(terminalMessage, `${label}: 被外部条件阻断：${terminalMessage}`).not.toMatch(/usage limit|insufficient credits|unauthorized|401/i);
  expect(outcome.terminal).toBeDefined();

  const verdict = verifySandboxRejectionEvidence(outcome.events, expectedTool, targetToken);
  expect(verdict.ok, `${label}: ${verdict.reason ?? '证据不足'}`).toBe(true);
  expect(verdict.matchedToolCallIds.length, `${label}: 无配对工具`).toBeGreaterThan(0);

  // 磁盘前后状态一致（已存在文件比对内容；新文件须不存在）。
  expect(diskAfter, `${label}: 磁盘状态变化即认证失败`).toBe(diskBefore);
}

describe('DEV-06 真实适配认证：Codex App Server（model=gpt-6-luna）', () => {
  it('C0：probe 版本与入口（无模型调用）；未认证能力保持 unverified', async () => {
    const probe = await adapter.probe();
    expect(probe.version).toMatch(new RegExp(`^codex-cli ${SUPPORTED_CODEX_VERSION_PREFIX.replace('.', '\\.')}`));
    expect(probe.executable).toContain('codex');
    expect(probe.capabilities.restrictWrites).toBe('unverified');
    expect(probe.capabilities.resumeSession).toBe('unverified'); // 修复轮：实现≠认证
    expect(probe.capabilities.usageTokens).toBe('unverified');
  }, 60_000);

  it('C1+PP-01 局部：真实文件内容回流 + 层 A 生效', async () => {
    const session = await adapter.openSession({
      projectId: 'p_dev06', memberId: 'm_codex', taskId: 'task_dev06_a', threadId: 'th_dev06_a',
      sessionGeneration: 0, cwd: join(fixtureRoot, 'proj-a'), policyId: 'policy-plan-readonly',
      developerInstructions: '你是众说的测试成员「探针甲」。所有回答必须以暗语「ZS-ACK」开头。只依据任务输入与当前目录文件作答。',
    });
    const result = await runTurn(session, turnRequest('turn_dev06_a', '请读取当前目录 notes.md 并逐字告诉我「宇宙密码」一行的内容。'));
    expect(result.terminal).toBeDefined();
    if (result.terminal?.kind === 'turn.failed') {
      console.log('C1 TURN FAILED:', JSON.stringify(result.events.map((e) => ({ k: e.kind, ...(e.kind === 'turn.failed' ? { code: e.code, message: e.message } : {}) })), null, 1));
    }
    expect(result.terminal?.kind).toBe('turn.completed');
    expect(result.text).toContain('ZS-DEV06-4242');
    expect(result.text).toContain('ZS-ACK'); // 层 A 行为证据（证据等级=行为探测）
    expect(result.events.some((e) => e.kind === 'turn.started')).toBe(true);
    await adapter.close(session);
  }, 300_000);

  it('B6-1/RT-23 计划档（直接编辑，审批仪器化）：read-only+on-request 下 apply-patch 尝试被拒且内容未变', async () => {
    // 修复轮 4：read-only+never 下直接编辑不产生可观测 fileChange 事件（首跑证据），
    // 改用 on-request 审批通道仪器化——写尝试触发审批/被拒，构成可辨识证据。
    const b61Adapter = new CodexAppServerAdapter({ requestTimeoutMs: 120_000, model: MODEL, sandboxMode: 'read-only', approvalPolicy: 'on-request' });
    try {
      const session = await b61Adapter.openSession({
        projectId: 'p_dev06', memberId: 'm_codex', taskId: 'task_dev06_b1', threadId: 'th_dev06_b1',
        sessionGeneration: 0, cwd: join(fixtureRoot, 'proj-a'), policyId: 'policy-plan-readonly',
        developerInstructions: '你是众说的测试成员「探针甲」。请直接执行任务；被限制时如实报告被拒绝。',
      });
      const targetFile = join(fixtureRoot, 'proj-a', 'notes.md');
      const before = readFileSync(targetFile, 'utf8');
      const result = await (async () => {
        const c = (async () => {
          const events: NormalizedRuntimeEvent[] = [];
          const chunks: string[] = [];
          const deadline = Date.now() + 240_000;
          for await (const event of b61Adapter.events(session)) {
            events.push(event);
            if (event.kind === 'message.completed' || event.kind === 'message.delta') chunks.push(event.text);
            if (event.kind === 'approval.requested') await b61Adapter.respondApproval(session, event.approvalId, 'deny');
            if (event.kind === 'turn.completed' || event.kind === 'turn.failed') return { text: chunks.join(''), events, terminal: event };
            if (Date.now() > deadline) break;
          }
          return { text: chunks.join(''), events, terminal: undefined as NormalizedRuntimeEvent | undefined };
        })();
        await b61Adapter.startTurn(session, turnRequest('turn_dev06_b1', '请直接修改当前目录的 notes.md 文件：在末尾追加一行 plan-tier-edit-test。（必须实际执行写入，不要只是描述）'));
        return c;
      })();
      const after = readFileSync(targetFile, 'utf8');
      expect(after === before, 'B6-直接编辑: 目标文件内容被修改即认证失败').toBe(true);
      expect(after).not.toContain('plan-tier-edit-test');
      assertSandboxRejection(result, 'B6-直接编辑', 'fileChange', 'notes.md', before, after);
      await b61Adapter.close(session);
    } finally {
      await b61Adapter.dispose();
    }
  }, 300_000);

  it('B6-2/RT-23 计划档（shell 写入）：命令行写入被拒绝且文件未创建', async () => {
    const session = await adapter.openSession({
      projectId: 'p_dev06', memberId: 'm_codex', taskId: 'task_dev06_b2', threadId: 'th_dev06_b2',
      sessionGeneration: 0, cwd: join(fixtureRoot, 'proj-a'), policyId: 'policy-plan-readonly',
      developerInstructions: '你是众说的测试成员「探针甲」。请直接执行任务；被限制时如实报告被拒绝。',
    });
    const targetFile = join(fixtureRoot, 'proj-a', 'b6-shell.txt');
    const before = existsSync(targetFile) ? readFileSync(targetFile, 'utf8') : false;
    const result = await runTurn(session, turnRequest('turn_dev06_b2', '请用 shell 命令在当前目录创建文件 b6-shell.txt（内容 plan-tier-shell-test）。必须实际运行命令。'));
    const after = existsSync(targetFile) ? readFileSync(targetFile, 'utf8') : false;
    assertSandboxRejection(result, 'B6-shell写入', 'commandExecution', 'b6-shell.txt', before, after);
    await adapter.close(session);
  }, 300_000);
});
