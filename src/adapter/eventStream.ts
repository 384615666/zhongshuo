/**
 * 适配器共享事件流：backlog + 尾部推送；多次迭代均从积压头部回放（重连语义，
 * 消费方按 eventKey 去重）。fake 与 codex adapter 共用。
 */
import type { NormalizedRuntimeEvent } from '../contracts/runtime.ts';

export class EventStream {
  private backlog: NormalizedRuntimeEvent[] = [];
  private waiters: Array<() => void> = [];

  push(event: NormalizedRuntimeEvent): void {
    this.backlog.push(event);
    for (const wake of this.waiters.splice(0)) wake();
  }

  async *iterate(): AsyncGenerator<NormalizedRuntimeEvent> {
    let index = 0;
    for (;;) {
      while (index < this.backlog.length) {
        yield this.backlog[index]!;
        index += 1;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}
