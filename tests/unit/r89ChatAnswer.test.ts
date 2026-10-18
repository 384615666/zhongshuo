import { describe, expect, it } from 'vitest';
import { chatAnswer, extractAppendedTaskComplete } from '../../src/contracts/chatAnswer.ts';

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

  it('does not accept a mismatched identity or a fenced/truncated suffix as control', () => {
    const natural = '自然回答';
    const appended = `${natural}\n\n${JSON.stringify(control)}`;
    expect(extractAppendedTaskComplete(appended, 'result_other')).toBeNull();
    expect(extractAppendedTaskComplete(`${natural}\n\n\`\`\`json\n${JSON.stringify(control)}\n\`\`\``, control.resultKey)).toBeNull();
    expect(extractAppendedTaskComplete(`${natural}\n\n${JSON.stringify(control).slice(0, -4)}`, control.resultKey)).toBeNull();
  });
});
