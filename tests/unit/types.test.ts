import { describe, expectTypeOf, it } from 'vitest';
import type { Mode, SendIntent } from '../../src/contracts/routing.ts';
import type { MessageTarget } from '../../src/contracts/conversation.ts';
import type { TopLevelRouteOutcome } from '../../src/contracts/routing.ts';
import type { DmRouteOutcome, ThreadFollowUpOutcome } from '../../src/contracts/routing.ts';

/**
 * 类型层测试：SendIntent 与 Mode 分开建模（§0.22/DEV-01 任务书）——
 * 'record_only' 不是 Mode 取值；不存在第四种模式或常驻「讨论」切换参数。
 */
describe('类型层不变量', () => {
  it("Mode 不接受 'record_only'（意图不是模式）", () => {
    expectTypeOf<Mode>().not.toEqualTypeOf<SendIntent>();
    expectTypeOf<'record_only'>().not.toExtend<Mode>();
    expectTypeOf<'AUTO' | 'DELIBERATE' | 'DIRECT'>().toExtend<Mode>();
  });

  it('SendIntent 恰为 default/record_only', () => {
    expectTypeOf<SendIntent>().toEqualTypeOf<'default' | 'record_only'>();
  });

  it('MessageTarget 必须且只能提供一种目标（判别联合穷尽三种 kind）', () => {
    expectTypeOf<MessageTarget['kind']>().toEqualTypeOf<'room_root' | 'thread' | 'dm'>();
  });

  it('路由结果类型穷尽：顶层 dispatch 结果必带 mode 或 record_only', () => {
    type DispatchOutcome = Extract<TopLevelRouteOutcome, { kind: 'dispatch' }>;
    expectTypeOf<DispatchOutcome['mode']>().toEqualTypeOf<Mode>();
  });

  it('DM 路由结果不携带 Mode（不在 UI 推导模式）', () => {
    expectTypeOf<DmRouteOutcome>().not.toHaveProperty('mode');
  });

  it('串内跟进结果的记录分支不携带成员（零唤醒在类型层成立）', () => {
    type RecordBranch = Extract<ThreadFollowUpOutcome, { kind: 'record_only' }>;
    expectTypeOf<RecordBranch['reason']>().toEqualTypeOf<'record_thread_default' | 'explicit_record_only'>();
  });
});
