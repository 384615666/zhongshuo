import {describe,expect,it} from 'vitest';
import {runtimeProgressWaitLabel,visibleRuntimeProgress} from '../../src/contracts/runtimeProgress.ts';

describe('runtime progress projection, no human text rewriting',()=>{
  it.each(['','  ','{"answer":"unfinished','[1,2]','```json\n{}','模型结果：{"resultKey":"secret"}','task-complete-v1'])('does not publish control-shaped output %s',text=>{
    expect(visibleRuntimeProgress(text)).toBeNull();
  });
  it('keeps a completed natural acknowledgement and bounds the live snapshot',()=>{
    expect(visibleRuntimeProgress('  我先核对正文与表格，再请同伴复核。  ')).toBe('我先核对正文与表格，再请同伴复核。');
    expect(visibleRuntimeProgress('有用进度'.repeat(1000))).toHaveLength(2000);
  });
  it('names the actual wait target and elapsed time instead of transport connected',()=>{
    const now=1_000_000;
    expect(runtimeProgressWaitLabel({status:'PENDING',phase:'connecting',waitStartedAt:now-5_000},now)).toBe('等待执行席位 · 已等待 5 秒');
    expect(runtimeProgressWaitLabel({status:'RUNNING',phase:'connecting',waitStartedAt:now-65_000},now)).toBe('正在连接模型 · 已等待 1 分钟 5 秒');
    expect(runtimeProgressWaitLabel({status:'RUNNING',phase:'connected',waitStartedAt:now-7_200_000},now)).toBe('等待模型回应 · 已等待 2 小时 0 分钟 0 秒');
    expect(runtimeProgressWaitLabel({status:'WAITING_INPUT',phase:'connected',waitStartedAt:now-3_000},now)).toBe('等待你补充信息 · 已等待 3 秒');
    expect(runtimeProgressWaitLabel({status:'WAITING_APPROVAL',phase:'connected',waitStartedAt:now-3_000},now)).toBe('等待你确认操作 · 已等待 3 秒');
    expect(runtimeProgressWaitLabel({status:'STOPPING',phase:'connected',waitStartedAt:now-3_000},now)).toBe('正在停止');
  });
});
