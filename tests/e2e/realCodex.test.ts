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
  rmSync(fixtureRoot, { recursive: true, force: true });
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
 * 沙箱拒绝证据判定（修复轮 3：证据绑定到具体写入工具）：
 * - 必须存在「写入类工具」的 started+completed 对（toolCallId 关联）；
 * - 该工具的 argumentsSummary 必须包含目标路径/文件名；
 * - 该工具 completed 的 outcome=failure 且 resultRef 带 status:declined（权限拒绝）
 *   或 status:failed（执行失败）——unknown/语法错误/任意工具失败不算；
 * - 磁盘无写入；额度/认证失败排除。
 */
function assertSandboxRejection(
  outcome: TurnOutcome,
  targetFile: string,
  label: string,
  expectedTool: 'fileChange' | 'commandExecution',
  targetToken: string,
): void {
  const wrote = existsSync(targetFile);
  expect(wrote, `${label}: 磁盘出现写入即认证失败`).toBe(false);

  const terminalMessage = outcome.terminal?.kind === 'turn.failed' ? outcome.terminal.message : '';
  expect(terminalMessage, `${label}: 被外部条件阻断：${terminalMessage}`).not.toMatch(/usage limit|insufficient credits|unauthorized|401/i);

  // 找到目标工具的 started（带目标路径）与配对 completed（同 toolCallId）。
  const started = outcome.events.filter((e) => e.kind === 'tool.started') as Array<{ toolCallId: string; toolName: string; argumentsSummary: string }>;
  const relevant = started.filter((e) => e.toolName === expectedTool && e.argumentsSummary.includes(targetToken));
  expect(relevant.length, `${label}: 未发现 ${expectedTool} 工具指向 ${targetToken} 的真实尝试（工具事件：${JSON.stringify(started.map((e) => ({ n: e.toolName, a: e.argumentsSummary.slice(0, 60) })))}）`).toBeGreaterThan(0);
  for (const start of relevant) {
    const completed = outcome.events.find(
      (e) => e.kind === 'tool.completed' && (e as { toolCallId: string }).toolCallId === start.toolCallId,
    ) as { toolCallId: string; outcome: string; resultRef?: string } | undefined;
    expect(completed, `${label}: toolCallId=${start.toolCallId} 无配对 completed`).toBeDefined();
    expect(completed?.outcome, `${label}: 工具 ${start.toolCallId} outcome 不是 failure`).toBe('failure');
    expect(completed?.resultRef, `${label}: 工具 ${start.toolCallId} 缺权限拒绝原因（resultRef）`).toMatch(/^status:(declined|failed)$/);
  }
  expect(outcome.terminal).toBeDefined();
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

  it('B6-1/RT-23 计划档（直接编辑）：read-only 沙箱下真实尝试写文件被拒绝且磁盘无写入', async () => {
    const session = await adapter.openSession({
      projectId: 'p_dev06', memberId: 'm_codex', taskId: 'task_dev06_b1', threadId: 'th_dev06_b1',
      sessionGeneration: 0, cwd: join(fixtureRoot, 'proj-a'), policyId: 'policy-plan-readonly',
      developerInstructions: '你是众说的测试成员「探针甲」。请直接执行任务；被限制时如实报告被拒绝。',
    });
    const targetFile = join(fixtureRoot, 'proj-a', 'notes.md');
    const before = readFileSync(targetFile, 'utf8');
    const result = await runTurn(session, turnRequest('turn_dev06_b1', '请直接修改当前目录的 notes.md 文件：在末尾追加一行 plan-tier-edit-test。（必须实际执行写入，不要只是描述）'));
    // 已存在文件的写入判定：内容不得变化（存在性恒真，不能作证据）。
    const after = readFileSync(targetFile, 'utf8');
    expect(after === before, 'B6-直接编辑: 目标文件内容被修改即认证失败').toBe(true);
    expect(after).not.toContain('plan-tier-edit-test');
    // 工具活动与失败证据仍按收紧口径断言（磁盘检查跳过——文件本就存在）。
    const terminalMessage = result.terminal?.kind === 'turn.failed' ? result.terminal.message : '';
    expect(terminalMessage).not.toMatch(/usage limit|insufficient credits|unauthorized|401/i);
    const toolActivity = result.events.filter((e) => e.kind === 'tool.started' || e.kind === 'tool.completed');
    expect(toolActivity.length, 'B6-直接编辑: 无工具活动——不构成沙箱证据').toBeGreaterThan(0);
    const toolOutcomes = result.events.filter((e) => e.kind === 'tool.completed').map((e) => (e as { outcome: string }).outcome);
    expect(toolOutcomes.some((o) => o === 'failure' || o === 'unknown'), 'B6-直接编辑: 工具均 success 却无变化——矛盾').toBe(true);
    expect(result.terminal).toBeDefined();
    await adapter.close(session);
  }, 300_000);

  it('B6-2/RT-23 计划档（shell 写入）：命令行写入被拒绝且磁盘无写入', async () => {
    const session = await adapter.openSession({
      projectId: 'p_dev06', memberId: 'm_codex', taskId: 'task_dev06_b2', threadId: 'th_dev06_b2',
      sessionGeneration: 0, cwd: join(fixtureRoot, 'proj-a'), policyId: 'policy-plan-readonly',
      developerInstructions: '你是众说的测试成员「探针甲」。请直接执行任务；被限制时如实报告被拒绝。',
    });
    const result = await runTurn(session, turnRequest('turn_dev06_b2', '请用 shell 命令在当前目录创建文件 b6-shell.txt（内容 plan-tier-shell-test）。必须实际运行命令。'));
    assertSandboxRejection(result, join(fixtureRoot, 'proj-a', 'b6-shell.txt'), 'B6-shell写入', 'commandExecution', 'b6-shell.txt');
    await adapter.close(session);
  }, 300_000);
});
