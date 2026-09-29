/**
 * 真实调用预算护栏本地模拟（零网络——不执行任何真实认证/模型调用）。
 * 验证：跨进程文件账本+目录锁下总额度不超限、超限请求前拦截、结果如实记录。
 * 运行方式：node --experimental-strip-types tests/fixtures/realCallGateRunner.ts <storeDir> <label> <attempts>
 */
import { RealCallGate, RealCallLimitError } from '../util/realCallGate.ts';

const [, , storeDir, label, attemptsArg] = process.argv;
const attempts = Number(attemptsArg ?? 5);
const gate = RealCallGate.open({
  runtime: 'claude', model: 'deepseek-flash', maxStartTurns: 1_000, budgetLabel: label ?? 'runner', storeDir: storeDir!,
});
let acquired = 0;
let rejected = 0;
for (let i = 0; i < attempts; i += 1) {
  try {
    const ticket = gate.acquireStartTurn();
    acquired += 1;
    if (i % 3 === 0) gate.recordOutcome(ticket, 'failed', `sim-fail-${i}`);
    else gate.recordOutcome(ticket, 'sent', `sim-ok-${i}`);
  } catch (error) {
    if (error instanceof RealCallLimitError) rejected += 1;
    else throw error;
  }
}
console.log(JSON.stringify({ label, acquired, rejected }));
