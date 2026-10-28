import {describe,expect,it} from 'vitest';
import {userFacingSystemText,userFacingSystemEventText} from '../../src/contracts/userFacingText.ts';

describe('R119 legacy program status presentation',()=>{
  it('shows the actual failure without the old rule reference or development explanation',()=>{
    expect(userFacingSystemText('全员无有效输入（§6.1 INDEPENDENT 终结规则；不合成虚构研讨报告）'))
      .toBe('所有 AI 都未返回有效结果');
    expect(userFacingSystemText('房间已归档，不能新增任务；可查看既有记录（§16.5）'))
      .toBe('房间已归档，不能新增任务；可查看既有记录');
  });
  it('keeps useful conditions and actions and uses readable stage labels',()=>{
    expect(userFacingSystemText('推送不是快进（远端含本地没有的提交）（§14.6/RT-24）；请先拉取合并'))
      .toBe('推送不是快进（远端含本地没有的提交）；请先拉取合并');
    expect(userFacingSystemText('INDEPENDENT · 第 0 轮')).toBe('独立分析 · 第 0 轮');
    expect(userFacingSystemText('前置预算耗尽，按 §6.5 转入整合')).toBe('前置预算耗尽，转入整合');
  });
  it('preserves selected filenames, amounts, and ordinary parentheses',()=>{
    const value='读取 D:/project/INDEPENDENT/report.md 失败（权限不足），金额上限为 50%';
    expect(userFacingSystemText(value)).toBe(value);
    expect(userFacingSystemText('费用（不含税）为 120 元')).toBe('费用（不含税）为 120 元');
  });
  it('cleans known system event explanations and preserves business and tool summaries',()=>{
    const legacy='全员无有效输入（§6.1 INDEPENDENT 终结规则；不合成虚构研讨报告）';
    expect(userFacingSystemEventText('run.statusChanged',legacy)).toBe('所有 AI 都未返回有效结果');
    expect(userFacingSystemEventText('run.stageAdvanced','按 §6.5 转入整合')).toBe('转入整合');
    const business='请按文档（§6.4）核对 INDEPENDENT / RATIFY；R119 是业务编号。';
    for(const kind of ['input.requested','task.statusChanged','run.statusChanged','tool.completed','run.completed','unknown']) {
      expect(userFacingSystemEventText(kind,business)).toBe(business);
    }
  });
});
