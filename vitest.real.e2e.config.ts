import { defineConfig } from 'vitest/config';

// 真实 runtime 认证：**消耗真实模型调用**——显式 opt-in 专用入口（不进默认 test/test:e2e；
// §19.2）。执行前须满足两层门禁：
// 1) 用本配置运行（npm run test:real）；
// 2) 环境变量 ZS_REAL_E2E=1（realCodex*.test.ts 内 describe 级门禁——缺省 skip，不发请求）。
// 模型与预算：ZS_E2E_MODEL 指定（缺省 gpt-6-luna，走 ~/.codex/config.toml 渠道配置）；
// 上限由各文件内用例数约束——**运行前按报告登记目标与次数上限，不静默混跑**。
// 后续优先真实补证渠道=Claude Code+deepseek-flash（用户指令）；Codex 专项另列目标与预算。
export default defineConfig({
  test: {
    include: ['tests/e2e/real*.test.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
