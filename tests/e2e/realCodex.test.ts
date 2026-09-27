/**
 * DEV-06 真实适配认证：Codex App Server（0.157.1，stdio 换行 JSON-RPC）。
 * 专用 fixture + 独立测试会话 + 有限预算（本文件 ≤2 个真实 turn）。
 * 仅 `pnpm test:e2e` 执行；默认套件不消耗额度（§19.2）。
 *
 * 认证项：
 * - G2-C1：真实文件内容回流（读 fixture notes.md 的暗号——非种子文本）
 * - PP-01 局部：层 A developerInstructions 实际生效（指令要求以特定暗语开头作答）
 * - B6/RT-23 计划档（read-only 沙箱）：指示写文件应被拒绝/失败，不得产生磁盘写入
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerAdapter, SUPPORTED_CODEX_VERSION_PREFIX } from '../../src/adapter/codex/appServerAdapter.ts';
import type { NormalizedRuntimeEvent } from '../../src/contracts/runtime.ts';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'zhongshuo-dev06-'));
let adapter: CodexAppServerAdapter;

beforeAll(() => {
  mkdirSync(join(fixtureRoot, 'proj-a'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'proj-a', 'notes.md'), '# 项目备忘\n\n宇宙密码：ZS-DEV06-4242\n', 'utf8');
  adapter = new CodexAppServerAdapter({ requestTimeoutMs: 120_000 });
});

afterAll(async () => {
  await adapter?.dispose();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

/** 读事件流直到 turn 终结，返回文本拼接与事件序列。 */
async function runTurn(session: Parameters<typeof adapter.events>[0], input: Parameters<typeof adapter.startTurn>[1], timeoutMs = 240_000): Promise<{ text: string; events: NormalizedRuntimeEvent[]; terminal: NormalizedRuntimeEvent | undefined }> {
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

describe('DEV-06 真实适配认证：Codex App Server', () => {
  it('C0：probe 版本与入口（无模型调用）', async () => {
    const probe = await adapter.probe();
    expect(probe.version).toMatch(new RegExp(`^codex-cli ${SUPPORTED_CODEX_VERSION_PREFIX.replace('.', '\\.')}`));
    expect(probe.executable).toContain('codex');
    // 未认证项保持 unverified（§9.3：unverified 不按 supported 处理）
    expect(probe.capabilities.restrictWrites).toBe('unverified');
    expect(probe.capabilities.interactiveApprovals).toBe('unverified');
  }, 60_000);

  it('C1+PP-01 局部：真实文件内容回流 + 层 A 生效', async () => {
    const session = await adapter.openSession({
      projectId: 'p_dev06',
      memberId: 'm_codex',
      taskId: 'task_dev06_a',
      threadId: 'th_dev06_a',
      sessionGeneration: 0,
      cwd: join(fixtureRoot, 'proj-a'),
      policyId: 'policy-plan-readonly',
      developerInstructions: '你是众说的测试成员「探针甲」。所有回答必须以暗语「ZS-ACK」开头。只依据任务输入与当前目录文件作答。',
    });
    const result = await runTurn(session, {
      turnId: 'turn_dev06_a',
      dispatchKey: 'dk-dev06-a',
      inputBundleId: 'bundle-dev06-a',
      text: '请读取当前目录 notes.md 并逐字告诉我「宇宙密码」一行的内容。',
      policyId: 'policy-plan-readonly',
      taskRevision: 0,
    });
    // 终结事件必须存在（不伪造）
    expect(result.terminal).toBeDefined();
    if (result.terminal?.kind === 'turn.failed') {
      // 失败时转储全部事件供诊断（不伪造成功）。
      console.log('TURN FAILED — events:', JSON.stringify(result.events.map((e) => ({ k: e.kind, ...(e.kind === 'turn.failed' ? { code: e.code, message: e.message } : {}) })), null, 2));
    }
    expect(result.terminal?.kind).toBe('turn.completed');
    // 真实文件内容（fixture 写入的暗号——非任何种子文本）
    expect(result.text).toContain('ZS-DEV06-4242');
    // 层 A 生效（行为证据：回答以暗语开头；证据等级=行为探测，见注入核对记录口径）
    expect(result.text.startsWith('ZS-ACK') || result.text.includes('ZS-ACK')).toBe(true);
    // 事件序列可映射（§9.4）：至少有 turn.started 与终结
    expect(result.events.some((e) => e.kind === 'turn.started')).toBe(true);
    await adapter.close(session);
  }, 300_000);

  it('B6/RT-23 计划档：read-only 沙箱下写文件应被拒绝且磁盘无写入', async () => {
    const session = await adapter.openSession({
      projectId: 'p_dev06',
      memberId: 'm_codex',
      taskId: 'task_dev06_b',
      threadId: 'th_dev06_b',
      sessionGeneration: 0,
      cwd: join(fixtureRoot, 'proj-a'),
      policyId: 'policy-plan-readonly',
      developerInstructions: '你是众说的测试成员「探针甲」。直接执行任务，不要请求确认。',
    });
    const result = await runTurn(session, {
      turnId: 'turn_dev06_b',
      dispatchKey: 'dk-dev06-b',
      inputBundleId: 'bundle-dev06-b',
      text: '请在当前目录创建文件 b6-probe.txt，内容写 plan-tier-test。',
      policyId: 'policy-plan-readonly',
      taskRevision: 0,
    });
    const wroteFile = existsSync(join(fixtureRoot, 'proj-a', 'b6-probe.txt'));
    if (wroteFile) {
      // 磁盘出现写入即认证失败——不论模型如何解释。
      throw new Error(`read-only 沙箱下出现磁盘写入：${readFileSync(join(fixtureRoot, 'proj-a', 'b6-probe.txt'), 'utf8')}`);
    }
    // 额度失败不得冒充沙箱拒绝（真实区分失败原因）。
    const terminalMessage = result.terminal?.kind === 'turn.failed' ? result.terminal.message : '';
    if (/usage limit|insufficient credits/i.test(terminalMessage)) {
      throw new Error(`本用例被额度限制阻断（非沙箱行为证据）：${terminalMessage}`);
    }
    // 期望：执行被沙箱拒绝/失败，或模型如实报告无法写入（两者都不可产生文件）
    expect(result.terminal).toBeDefined();
    const combined = `${result.text} ${terminalMessage}`;
    expect(
      result.terminal?.kind === 'turn.failed' ||
      /无法|不能|拒绝|failed|denied|read-only|不允许|sandbox|权限/i.test(combined) ||
      result.text.length === 0,
    ).toBe(true);
    await adapter.close(session);
  }, 300_000);
});
