import { describe, it, expect } from 'vitest';
import { usageSummary, budgetText, activityLabel } from '../../src/ui/hifi/components/TaskDetailsFacts.tsx';
describe('R79 truthful readable detail summaries',()=>{
  it('uses the latest cumulative snapshot once, separates deltas and unknowns',()=>{
    const text=usageSummary([{normalized:{accounting:'cumulative',inputTokens:12,cost:0.1,currency:'USD'},quality:'reported'},{normalized:{accounting:'cumulative',inputTokens:7,cost:0.05},quality:'estimated'}]);
    expect(text).toContain('输入 12');expect(text).not.toContain('输入 19');expect(text).toContain('渠道报告');expect(text).toContain('其余记录未重复相加');
    const delta=usageSummary([{normalized:{accounting:'delta',inputTokens:5},quality:'unknown'}]);expect(delta).toContain('不据部分记录推算总用量');expect(delta).not.toContain('0');
    expect(budgetText({maxTurns:6,usedTurns:2})).toContain('在途预占 未提供');expect(budgetText(null)).toContain('无可解析');
    expect(activityLabel('turn.failed')).toBe('执行失败');expect(activityLabel('new.internal.key')).toBe('执行记录');
  });
});
