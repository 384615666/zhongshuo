import { describe, expect, it } from 'vitest';
import { agentReplyText, chatAnswer, extractAppendedTaskComplete, isExplicitTaskCompleteOutput } from '../../src/contracts/chatAnswer.ts';

const control = {
  schemaVersion: 'task-complete-v1',
  resultKey: 'result_turn_r89',
  responseKind: 'conversation',
  answer: '收到，测试正常。我已就绪。',
  changeSummary: '普通问候，没有文件改动',
  files: [],
  executedVerifications: [],
  unexecutedVerifications: [],
  remainingIssues: [],
  handoffs: [],
};

describe('R89 task-complete projection', () => {
  it('separates validated appended control from natural prose without hiding ordinary JSON', () => {
    const natural = '收到，测试正常。我已就绪。';
    const appended = `${natural}\n\n${JSON.stringify(control)}`;
    expect(extractAppendedTaskComplete(appended, control.resultKey)).toMatchObject({
      controlText: JSON.stringify(control),
      visibleText: natural,
      parsed: { resultKey: control.resultKey },
    });
    expect(chatAnswer(appended, 'agent')).toBe(natural);
    expect(chatAnswer(`${natural}${JSON.stringify(control)}`, 'agent')).toBe(natural);
    expect(chatAnswer(appended, 'human')).toBe(appended);
    expect(chatAnswer('普通说明\n\n{"note":"用户或模型自己的 JSON 示例"}', 'agent'))
      .toBe('普通说明\n\n{"note":"用户或模型自己的 JSON 示例"}');
  });

  it('projects an unpunctuated natural prefix when the line break or turn identity is available', () => {
    const natural = '已经收到你的问题';
    const appended = `${natural}\n\n${JSON.stringify(control)}`;
    expect(chatAnswer(appended, 'agent')).toBe(natural);
    expect(chatAnswer(`${natural}${JSON.stringify(control)}`, 'agent', control.resultKey)).toBe(natural);
    expect(chatAnswer(appended, 'agent', 'result_other')).toBe(appended);
  });

  it('does not accept a mismatched identity or a fenced/truncated suffix as control', () => {
    const natural = '自然回答';
    const appended = `${natural}\n\n${JSON.stringify(control)}`;
    expect(extractAppendedTaskComplete(appended, 'result_other')).toBeNull();
    expect(extractAppendedTaskComplete(`${natural}\n\n\`\`\`json\n${JSON.stringify(control)}\n\`\`\``, control.resultKey)).toBeNull();
    expect(extractAppendedTaskComplete(`${natural}\n\n${JSON.stringify(control).slice(0, -4)}`, control.resultKey)).toBeNull();
  });

  it('recognizes explicit malformed or wrong-key terminal control without treating ordinary JSON as control', () => {
    const natural = '自然回答';
    expect(isExplicitTaskCompleteOutput(JSON.stringify({ ...control, resultKey: 'result_other' }))).toBe(true);
    expect(isExplicitTaskCompleteOutput(JSON.stringify({ ...control, files: 'not-an-array' }))).toBe(true);
    expect(isExplicitTaskCompleteOutput(`${natural}\n\n${JSON.stringify({ ...control, resultKey: 'result_other' })}`)).toBe(true);
    expect(isExplicitTaskCompleteOutput('普通说明\n\n{"note":"用户 JSON 示例"}')).toBe(false);
  });

  it('keeps the final structured answer visible after a progress prefix', () => {
    const prefix = '结构化终态已准备好，正在提交。';
    const appended = `${prefix}\n\n${JSON.stringify(control)}`;
    expect(agentReplyText(appended, undefined, control.resultKey))
      .toBe(`${prefix}\n\n${control.answer}`);
    expect(agentReplyText(control.answer, JSON.stringify(control), control.resultKey))
      .toBe(control.answer);
    expect(agentReplyText(prefix, JSON.stringify(control), control.resultKey))
      .toBe(`${prefix}\n\n${control.answer}`);
  });
});
