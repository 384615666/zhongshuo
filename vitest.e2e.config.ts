import { defineConfig } from 'vitest/config';

// fake 档 UI/daemon e2e：**不消耗模型调用**（2026-09-29 核账教训：本配置曾收集全部 e2e，
// realCodex*.test.ts 无门禁随全量混跑——上轮 3 次全量+3 次单跑共 45 会话/55 真实 turn，
// 与「零真实调用」声明矛盾）。真实认证一律走 vitest.real.e2e.config.ts 显式入口
// （ZS_REAL_E2E=1 双门禁），本配置按文件名排除 real*——两层隔离（文件级 exclude +
// 用例级环境门禁），不依赖子进程环境做网络隔离。
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.git/**', 'tests/e2e/real*.test.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
