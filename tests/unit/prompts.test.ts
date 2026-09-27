import { describe, expect, it } from 'vitest';
import {
  computeTurnBundleHash,
  renderStandingPrompt,
  scanSensitivePatterns,
  selectStageInstruction,
  STANDING_PROMPT_TEMPLATE,
  STANDING_PROMPT_VERSION,
  TASK_COMPLETE_SCHEMA_VERSION,
  taskCompleteSchema,
  TURN_BUNDLE_VERSION,
} from '../../src/contracts/prompts.ts';
import { canonicalJson } from '../../src/contracts/common.ts';

const STANDING_VARS = {
  memberId: 'm_a',
  memberDisplayName: '甲',
  projectId: 'p1',
  projectName: '演示项目',
  roomId: 'room_1',
  roomName: '大厅',
  threadId: 'thread_1',
  taskId: 'task_1',
  workspacePath: 'D:/demo',
  draftDir: 'C:/appdata/zhongshuo/drafts/p1',
} as const;

describe('层 A：常驻提示词渲染（规格 §3/§5.1）', () => {
  it('完整变量渲染成功：变量被替换、模板文本不含 {{}}', () => {
    const r = renderStandingPrompt({ vars: STANDING_VARS, conversationKind: 'room' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.version).toBe(STANDING_PROMPT_VERSION);
    expect(r.value.text).toContain('你是「甲」（成员 ID：m_a）');
    expect(r.value.text).toContain('当前任务线程：thread_1');
    expect(r.value.text).not.toContain('{{');
    expect(r.value.templateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.value.renderedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.value.templateHash).not.toBe(r.value.renderedHash);
  });

  it('缺变量/多变量 → 渲染失败（不得以半渲染文本开 turn）', () => {
    const missing = renderStandingPrompt({
      vars: { ...STANDING_VARS, draftDir: undefined as unknown as string },
      conversationKind: 'room',
    });
    expect(missing).toMatchObject({ ok: false, error: { code: 'VALIDATION_INVALID' } });
    const extra = renderStandingPrompt({
      // 多余变量经类型不允许；运行时构造传反例
      vars: { ...STANDING_VARS, extra: 'x' } as unknown as typeof STANDING_VARS,
      conversationKind: 'room',
    });
    expect(extra).toMatchObject({ ok: false });
  });

  it('DM 会话 → 明确拒绝（私信提示词契约未完成，不填伪造 roomId）', () => {
    const r = renderStandingPrompt({ vars: STANDING_VARS, conversationKind: 'dm' });
    expect(r).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNSUPPORTED' } });
    if (r.ok) return;
    expect(r.error.message).toContain('私信提示词契约未完成');
  });

  it('模板源不可变检查：hash 稳定（改模板必须升版本）', () => {
    const r1 = renderStandingPrompt({ vars: STANDING_VARS, conversationKind: 'room' });
    const r2 = renderStandingPrompt({ vars: STANDING_VARS, conversationKind: 'room' });
    expect(r1.ok && r2.ok && r1.value.templateHash).toBe(r2.ok ? r2.value.templateHash : '');
    expect(STANDING_PROMPT_TEMPLATE).toContain('指令层级');
  });
});

describe('模板选择程序表（规格 §4.3/开工契约 §7）', () => {
  it('DIRECT/executor/stage_work → 模板命中', () => {
    const r = selectStageInstruction({ mode: 'DIRECT', role: 'executor', stage: null, turnPurpose: 'stage_work' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toContain('你是本任务唯一执行成员');
  });

  it('AUTO/未知阶段/非 host 的 checkpoint → 未实现，组装失败（不降级渲染）', () => {
    for (const input of [
      { mode: 'AUTO', role: 'coordinator', stage: null, turnPurpose: 'stage_work' },
      { mode: 'DELIBERATE', role: 'participant', stage: 'UNKNOWN_STAGE', turnPurpose: 'stage_work' },
      { mode: 'DIRECT', role: 'executor', stage: null, turnPurpose: 'checkpoint' },
    ]) {
      expect(selectStageInstruction(input)).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNSUPPORTED' } });
    }
  });

  it('M1 DELIBERATE 各阶段模板可选；checkpoint 仅 host（DEV-21-M1）', () => {
    for (const input of [
      { mode: 'DELIBERATE', role: 'participant', stage: 'INDEPENDENT', turnPurpose: 'stage_work' },
      { mode: 'DELIBERATE', role: 'participant', stage: 'CROSS_REVIEW', turnPurpose: 'stage_work' },
      { mode: 'DELIBERATE', role: 'participant', stage: 'ISSUE_DISCUSSION', turnPurpose: 'stage_work' },
      { mode: 'DELIBERATE', role: 'host', stage: 'ISSUE_DISCUSSION', turnPurpose: 'checkpoint' },
      { mode: 'DELIBERATE', role: 'host', stage: 'SYNTHESIS', turnPurpose: 'stage_work' },
      { mode: 'DELIBERATE', role: 'participant', stage: 'RATIFY', turnPurpose: 'stage_work' },
    ]) {
      expect(selectStageInstruction(input).ok).toBe(true);
    }
    // checkpoint 模板 host 专属：普通成员不得复用（§6.1）。
    expect(selectStageInstruction({ mode: 'DELIBERATE', role: 'member', stage: 'ISSUE_DISCUSSION', turnPurpose: 'checkpoint' })).toMatchObject({ ok: false });
  });
});

describe('TaskComplete 输出契约（规格 §4.4：版本不可变、strict）', () => {
  const valid = {
    schemaVersion: TASK_COMPLETE_SCHEMA_VERSION,
    resultKey: 'result_turn_1',
    changeSummary: '新增登录校验',
    files: ['src/auth.ts'],
    executedVerifications: ['pnpm test 8/8'],
    unexecutedVerifications: [{ item: '浏览器手测', reason: '环境未就绪' }],
    remainingIssues: ['令牌过期分支未覆盖'],
  };

  it('成功 fixture 通过', () => {
    expect(taskCompleteSchema.safeParse(valid).success).toBe(true);
  });

  it('缺项（未执行验证无理由）→ 拒绝', () => {
    expect(
      taskCompleteSchema.safeParse({ ...valid, unexecutedVerifications: [{ item: 'x' }] }).success,
    ).toBe(false);
    expect(taskCompleteSchema.safeParse({ ...valid, resultKey: '' }).success).toBe(false);
  });

  it('越权字段（additionalProperties）→ 拒绝', () => {
    expect(taskCompleteSchema.safeParse({ ...valid, testsPassed: true }).success).toBe(false);
  });

  it('旧版本 schemaVersion → 拒绝', () => {
    expect(taskCompleteSchema.safeParse({ ...valid, schemaVersion: 'task-complete-v0' }).success).toBe(false);
  });
});

describe('敏感模式扫描（PP-03：渲染全文零命中）', () => {
  it('干净文本零命中', () => {
    expect(scanSensitivePatterns('普通任务正文，无秘密。')).toEqual([]);
  });

  it('token/私钥形态命中即失败', () => {
    expect(scanSensitivePatterns('key sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ01')).toMatchObject([{ name: 'openai-token' }]);
    expect(scanSensitivePatterns('-----BEGIN RSA PRIVATE KEY-----')).toMatchObject([{ name: 'private-key' }]);
    expect(scanSensitivePatterns('AKIAIOSFODNN7EXAMPLE')).toMatchObject([{ name: 'aws-access-key' }]);
  });
});

describe('信封 hash（PP-04 一致性基础）', () => {
  it('canonical 序列化：字段顺序无关 → 同一信封 hash 稳定', () => {
    const a = { b: 1, a: { d: 2, c: [3, 4] } };
    const b = { a: { c: [3, 4], d: 2 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(TURN_BUNDLE_VERSION).toBe('zs-turn-v0.1.2');
    expect(computeTurnBundleHash.name).toBe('computeTurnBundleHash');
  });
});
