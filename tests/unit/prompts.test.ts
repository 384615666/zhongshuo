import { describe, expect, it } from 'vitest';
import {
  computeTurnBundleHash,
  renderStandingPrompt,
  renderTurnBundle,
  scanSensitivePatterns,
  selectStageInstruction,
  STANDING_PROMPT_TEMPLATE,
  STANDING_PROMPT_VERSION,
  DM_STANDING_PROMPT_VERSION,
  TASK_COMPLETE_SCHEMA_VERSION,
  turnBundleEnvelopeSchema,
  taskCompleteSchema,
  taskCompleteOutputSchema,
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

  it('DM 会话 → 私信模板渲染（DEV-21-M3/DEV-22：无房间/线程变量；缺/多变量按启动失败）', () => {
    // 房间变量（含 roomId/threadId）对 DM 是「多变量」——拒绝，不填伪造 roomId。
    const r = renderStandingPrompt({ vars: STANDING_VARS, conversationKind: 'dm' });
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_INVALID' } });
    if (r.ok) return;
    expect(r.error.message).toContain('私信常驻提示词变量白名单校验失败');
    // DM 白名单变量齐全 → 渲染成功（版本=私信模板；文本含会话上下文、无房间语义）。
    const dmVars = {
      memberId: 'm1', memberDisplayName: '成员甲', projectId: 'p1', projectName: '项目甲',
      conversationId: 'dm_1', workspacePath: 'D:/x', draftDir: 'D:/drafts',
    };
    const ok = renderStandingPrompt({ vars: dmVars, conversationKind: 'dm' });
    expect(ok).toMatchObject({ ok: true });
    if (!ok.ok) return;
    expect(ok.value.version).toBe(DM_STANDING_PROMPT_VERSION);
    expect(ok.value.text).toContain('一对一私信会话');
    expect(ok.value.text).toContain('dm_1');
    expect(ok.value.text).not.toContain('房间：');
  });

  it('模板源不可变检查：hash 稳定（改模板必须升版本）', () => {
    const r1 = renderStandingPrompt({ vars: STANDING_VARS, conversationKind: 'room' });
    const r2 = renderStandingPrompt({ vars: STANDING_VARS, conversationKind: 'room' });
    expect(r1.ok && r2.ok && r1.value.templateHash).toBe(r2.ok ? r2.value.templateHash : '');
    expect(STANDING_PROMPT_TEMPLATE).toContain('指令层级');
  });

  it('standing prompt carries shortest-useful chat, nullable document and concrete handoff rules', () => {
    const r = renderStandingPrompt({ vars: STANDING_VARS, conversationKind: 'room' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text).toContain('最短有用');
    expect(r.value.text).toContain('document');
    expect(r.value.text).toContain('停止前');
    expect(r.value.text).toContain('具体交接');
  });
});

describe('模板选择程序表（规格 §4.3/开工契约 §7）', () => {
  it('DIRECT/executor/stage_work → 模板命中', () => {
    const r = selectStageInstruction({ mode: 'DIRECT', role: 'executor', stage: null, turnPurpose: 'stage_work' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toContain('你负责回应这条消息');
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

  it('R101 DELIBERATE 提示词只写新增内容、复用同名文档且不机械造文件', () => {
    const expected = new Map([
      ['INDEPENDENT', '本轮新增结论'],
      ['CROSS_REVIEW', '只写本轮新增'],
      ['ISSUE_DISCUSSION', '只写本轮新增证据'],
      ['SYNTHESIS', '沿用合适的同名文件'],
      ['RATIFY', '不重抄整份整合稿'],
    ]);
    for (const [stage, phrase] of expected) {
      const role = stage === 'SYNTHESIS' ? 'host' : 'member';
      const result = selectStageInstruction({ mode: 'DELIBERATE', role, stage, turnPurpose: 'stage_work' });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value).toContain(phrase);
      expect(result.value).toContain('document=null');
      expect(result.value).toContain('不按字数或数量强行造文件');
      expect(result.value).toContain('自主判断');
    }
  });

  it('R101 主持者 RATIFY 保留最终用户总览，普通成员保持简短确认', () => {
    const host = selectStageInstruction({ mode: 'DELIBERATE', role: 'host', stage: 'RATIFY', turnPurpose: 'stage_work' });
    const member = selectStageInstruction({ mode: 'DELIBERATE', role: 'member', stage: 'RATIFY', turnPurpose: 'stage_work' });
    expect(host.ok).toBe(true);
    expect(member.ok).toBe(true);
    if (!host.ok || !member.ok) return;
    expect(host.value).toContain('最终用户总览');
    expect(host.value).toContain('核心结论');
    expect(host.value).toContain('实际交付物');
    expect(host.value).toContain('关键遗留/限制');
    expect(host.value).toContain('不能只写“确认通过”');
    expect(member.value).toContain('简短确认');
    expect(member.value).toContain('不承担最终用户总览');
    expect(member.value).not.toContain('你的 summary 是最终用户总览');
  });

  it('R101 业务沟通用成员自然名，一致否定不写成同意或直接 resolved', () => {
    const crossReview = selectStageInstruction({ mode: 'DELIBERATE', role: 'member', stage: 'CROSS_REVIEW', turnPurpose: 'stage_work' });
    const synthesis = selectStageInstruction({ mode: 'DELIBERATE', role: 'host', stage: 'SYNTHESIS', turnPurpose: 'stage_work' });
    expect(crossReview.ok).toBe(true);
    expect(synthesis.ok).toBe(true);
    if (!crossReview.ok || !synthesis.ok) return;
    expect(crossReview.value).toContain('角色/displayName');
    expect(crossReview.value).toContain('不要让 UUID 代替自然说明');
    expect(crossReview.value).toContain('artifactId/revision/claimId');
    expect(synthesis.value).toContain('全员明确 disagree');
    expect(synthesis.value).toContain('不要把一致否定写成对原命题的同意');
    expect(synthesis.value).toContain('保留全部否定立场的前提下把该争议标为已处理');
    expect(synthesis.value).toContain('更正的 claims 仍须 RAT 确认');
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

  it('accepts nullable model document while keeping legacy detailMarkdown storage compatible', () => {
    expect(taskCompleteSchema.safeParse({ ...valid, answer: '短结论', detailMarkdown: '# 完整详情\n\n证据。' }).success).toBe(true);
    expect(taskCompleteSchema.safeParse(valid).success).toBe(true);
    expect(taskCompleteSchema.safeParse({ ...valid, detailMarkdown: 123 }).success).toBe(false);
    const document = { filename: '登录校验方案.md', purpose: '记录实际实现与验证', markdown: '# 登录校验方案\n\n证据。' };
    expect(taskCompleteSchema.safeParse({ ...valid, document }).success).toBe(true);
    expect(taskCompleteSchema.safeParse({ ...valid, document: null }).success).toBe(true);
    expect(taskCompleteSchema.safeParse({ ...valid, document: { ...document, filename: '../登录.md' } }).success).toBe(false);
    const providerSchema = taskCompleteOutputSchema('result_test') as { required?: string[] };
    expect(providerSchema.required).toContain('document');
    expect(providerSchema.required).not.toContain('detailMarkdown');
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

describe('R97 permission header', () => {
  it('fullAccess=true 即使 effective tier=auto_edit，也显示完全访问而不是自动编辑', () => {
    const envelope = turnBundleEnvelopeSchema.parse({
      bundleVersion: TURN_BUNDLE_VERSION,
      promptVersion: STANDING_PROMPT_VERSION,
      turnId: 'turn_full',
      taskRevision: 1,
      mode: 'DIRECT',
      stage: null,
      turnPurpose: 'stage_work',
      you: { memberId: 'm_a', role: 'executor' },
      roster: [{ memberId: 'm_a', displayName: '甲', status: 'expected' }],
      budget: {
        runMaxTurns: 4, usedTurns: 0, inFlightReservedTurns: 1, remainingTurns: 3,
        tailReserved: 0, tailReservationByStage: {}, stageAvailableTurns: 3,
      },
      permission: {
        tier: 'auto_edit', intent: 'modify', policyId: 'policy-full-access',
        modificationAuthorized: true, fullAccess: true, allowedWriteRoots: [],
      },
      task: { taskId: 'task_full', threadId: 'thread_full', objective: '执行', userConstraints: [] },
      baseline: null,
      materials: [],
      threadDigest: { rootMessageId: 'msg_root', rootText: '执行', fromSeq: 1, toSeq: 1, truncated: false, messages: [] },
      outputContract: { kind: 'TaskComplete', submitVia: 'final-result', resultKey: 'result_turn_full', progressAllowed: true },
      communicationContract: { mentionEnabled: false, disabledReason: '单一执行者' },
    });
    const text = renderTurnBundle(envelope);
    expect(text).toContain('权限=完全访问(修改)');
    expect(text).toContain('本轮已明确选择完全访问');
    expect(text).not.toContain('权限=自动编辑(修改)');
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

describe('R87 actual collaboration role instructions',()=>{
  it.each([
    ['AUTO','coordinator','coordination.planning','规划/审核职责不改变'],
    ['DIRECT','executor','coordination.child','接手同伴的具体请求'],
    ['AUTO','coordinator','coordination.integration','不再生成新计划'],
  ] as const)('%s/%s/%s selects the real role, without a conflicting sole executor instruction',(mode,role,stage,expected)=>{
    const result=selectStageInstruction({mode,role,stage,turnPurpose:'stage_work'});
    expect(result.ok).toBe(true);if(!result.ok)return;
    expect(result.value).toContain(expected);expect(result.value).not.toContain('唯一执行成员');
    expect(result.value).not.toContain('request_participant');
  });
});

describe('信封 hash（PP-04 一致性基础）', () => {
  it('canonical 序列化：字段顺序无关 → 同一信封 hash 稳定', () => {
    const a = { b: 1, a: { d: 2, c: [3, 4] } };
    const b = { a: { c: [3, 4], d: 2 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(TURN_BUNDLE_VERSION).toBe('zs-turn-v0.1.5');
    expect(computeTurnBundleHash.name).toBe('computeTurnBundleHash');
  });
});
