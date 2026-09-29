import { defineConfig } from 'vitest/config';

// 真实 runtime 认证：**消耗真实模型调用**——显式 opt-in 专用入口（不进默认 test/test:e2e；
// §19.2）。执行前须满足两层门禁：
// 1) 用本配置运行（npm run test:real）；
// 2) 环境变量 ZS_REAL_E2E=1（realCodex*.test.ts 内 describe 级门禁——缺省 skip，不发请求）。
// 模型：ZS_E2E_MODEL 指定（缺省 gpt-6-luna，走 ~/.codex/config.toml 渠道配置）。
// 预算（第八轮修订）：**用例数 ≠ startTurn 次数**——上限不再以用例数为依据。每个
// real*.test.ts 在任何 startTurn 之前经 RealCallGate（tests/util/realCallGate.ts）计数：
// - 显式 runtime/model/maxStartTurns（默认=该文件实际 startTurn 调用点数+1）；
// - 超限在请求前拦截（不发网络请求），拒绝与结果（sent/failed/timeout/uncertain）落文件账本；
// - 同批多个文件/进程共享额度：显式设同一 ZS_REAL_BUDGET_DIR（账本既定额度为准，后开者不得改限）；
// - 环境变量门禁（ZS_REAL_E2E）只是跳过开关，与预算硬上限分别验收（realCallBudget.test.ts）。
// 后续优先真实补证渠道=Claude Code+deepseek-flash（用户指令）；Codex 专项另列目标与预算。
export default defineConfig({
  test: {
    include: ['tests/e2e/real*.test.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
