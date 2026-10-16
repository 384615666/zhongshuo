import {describe,expect,it} from 'vitest';
import {visibleRuntimeProgress} from '../../src/contracts/runtimeProgress.ts';

describe('runtime progress projection, no human text rewriting',()=>{
  it.each(['','  ','{"answer":"unfinished','[1,2]','```json\n{}','模型结果：{"resultKey":"secret"}','task-complete-v1'])('does not publish control-shaped output %s',text=>{
    expect(visibleRuntimeProgress(text)).toBeNull();
  });
  it('keeps a completed natural acknowledgement and bounds the live snapshot',()=>{
    expect(visibleRuntimeProgress('  我先核对正文与表格，再请同伴复核。  ')).toBe('我先核对正文与表格，再请同伴复核。');
    expect(visibleRuntimeProgress('有用进度'.repeat(1000))).toHaveLength(2000);
  });
});
