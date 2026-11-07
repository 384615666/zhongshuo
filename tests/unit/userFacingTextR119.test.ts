import {describe,expect,it} from 'vitest';
import {userFacingSystemText,userFacingSystemEventText} from '../../src/contracts/userFacingText.ts';

it('explains settings read timeouts without presenting them as an uncertain send', () => {
  expect(userFacingSystemText("Error invoking remote method 'zs:command': Error: 请求超时（15000ms）：app.settings.get"))
    .toBe('读取设置超时，请稍后重试。');
  const writeTimeout = '请求超时（15000ms）：app.settings.set';
  expect(userFacingSystemText(writeTimeout)).toBe(writeTimeout);
});

describe('R119 legacy program status presentation',()=>{
  it('points a retained execution error to the readonly interruption check without exposing refund instructions',()=>{
    const raw='拒绝派发：turn=old-turn protection_state=retained。需人工退款或 recovery.reconcile。';
    const text=userFacingSystemText(raw);
    expect(text).toBe('上次执行尚未确认结束。请点击“检查中断”查看具体成员和程序检查结果，解除占用后再继续。');
    expect(text).not.toMatch(/人工退款|reconcile|old-turn|retained/);
    expect(raw).toContain('protection_state=retained');
    expect(userFacingSystemEventText('tool.completed',raw)).toBe(raw);
    expect(userFacingSystemEventText('unknown',raw)).toBe(raw);
    expect(userFacingSystemText('protection_state=released，原结果保留')).toBe('protection_state=released，原结果保留');
  });
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
