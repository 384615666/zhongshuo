import {describe,expect,it} from 'vitest';
import {userFacingSystemText,userFacingSystemEventText} from '../../src/contracts/userFacingText.ts';

it('explains settings read timeouts without presenting them as an uncertain send', () => {
  expect(userFacingSystemText("Error invoking remote method 'zs:command': Error: 请求超时（15000ms）：app.settings.get"))
    .toBe('读取设置超时，请稍后重试。');
  expect(userFacingSystemText('请求超时（15000ms）：app.settings.set')).toBe('请求超时');
});

describe('R119/R191 program-generated UI copy',()=>{
  it('removes error codes and command names from user-facing failures',()=>{
    expect(userFacingSystemText('VALIDATION_INVALID: 协调者不可停用（房间 AUTO 路由依赖协调者——如需更换请先调整协调者）'))
      .toBe('协调者不可停用');
    expect(userFacingSystemText('DATA_JOB_INVALID：数据操作记录不可读。')).toBe('数据操作记录不可读。');
    expect(userFacingSystemText('project.lifecycle unarchive 失败')).toBe('失败');
  });
  it('removes parenthetical explanations while preserving the actual message',()=>{
    expect(userFacingSystemText('读取失败（保留上次内容——重试=切换视图或等待自动刷新）')).toBe('读取失败');
    expect(userFacingSystemText('收藏操作失败：读取失败（状态未变）')).toBe('收藏操作失败：读取失败');
    expect(userFacingSystemText('推送不是快进（远端含本地没有的提交）（§14.6/RT-24）；请先拉取合并'))
      .toBe('推送不是快进；请先拉取合并');
  });
  it('points a retained execution error to the readonly interruption check without exposing refund instructions',()=>{
    const raw='拒绝派发：turn=old-turn protection_state=retained。需人工退款或 recovery.reconcile。';
    const text=userFacingSystemText(raw);
    expect(text).toBe('上次执行尚未确认结束。请点击“检查中断”查看具体成员和程序检查结果，解除占用后再继续。');
    expect(text).not.toMatch(/人工退款|reconcile|old-turn|retained/);
    expect(raw).toContain('protection_state=retained');
    expect(userFacingSystemEventText('tool.completed',raw)).toBe(raw);
    expect(userFacingSystemEventText('unknown',raw)).toBe(raw);
    expect(userFacingSystemText('protection_state=released，原结果保留')).toBe('原结果保留');
  });
  it('shows the actual failure without rule references or development explanations',()=>{
    expect(userFacingSystemText('全员无有效输入（§6.1 INDEPENDENT 终结规则；不合成虚构研讨报告）'))
      .toBe('所有 AI 都未返回有效结果');
    expect(userFacingSystemText('房间已归档，不能新增任务；可查看既有记录（§16.5）'))
      .toBe('房间已归档，不能新增任务；可查看既有记录');
  });
  it('keeps useful conditions and actions and uses readable stage labels',()=>{
    expect(userFacingSystemText('INDEPENDENT · 第 0 轮')).toBe('独立分析 · 第 0 轮');
    expect(userFacingSystemText('前置预算耗尽，按 §6.5 转入整合')).toBe('前置预算耗尽，转入整合');
  });
  it('removes technical English but preserves selected filenames, amounts and product names',()=>{
    const value='读取 D:/project/INDEPENDENT/report.md 失败（权限不足），金额上限为 50%';
    expect(userFacingSystemText(value)).toBe('读取 D:/project/INDEPENDENT/report.md 失败，金额上限为 50%');
    expect(userFacingSystemText('费用（不含税）为 120 元')).toBe('费用为 120 元');
    expect(userFacingSystemText('当前不在分支上（detached HEAD）——不能推送')).toBe('当前不在分支上——不能推送');
    expect(userFacingSystemText('仅 UNKNOWN turn 可对账（实际：FAILED）')).toBe('仅结果待确认轮次可对账');
    expect(userFacingSystemText('调用次数预算开关只接受 true/false，读到：x')).toBe('调用次数预算开关只接受开或关，读到：x');
  });
  it('never leaves error codes or parentheses in translated system text',()=>{
    const samples=[
      'VALIDATION_INVALID: 协调者不可停用（房间 AUTO 路由依赖协调者——如需更换请先调整协调者）',
      'STORAGE_UNAVAILABLE：数据目录无法写入（请检查权限）',
      '项目已移除（仅解除关联）：不能新增成员；如需继续使用请先恢复项目（project.lifecycle restore）',
      '未来水位拒绝：throughMessageSeq=12 超过会话最新消息序 9（未读到的不算已读）',
    ];
    for(const raw of samples){
      const text=userFacingSystemText(raw);
      expect(text,raw).not.toMatch(/[（(]/);
      expect(text,raw).not.toMatch(/[A-Z][A-Z0-9]*_[A-Z0-9]+/);
      expect(text,raw).not.toMatch(/\b(?:app|project|member|room|task|git|recovery|settings)\.[a-z]/);
    }
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
