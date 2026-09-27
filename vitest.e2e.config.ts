import { defineConfig } from 'vitest/config';

// 真实 runtime 冒烟：消耗真实模型调用；按需单独执行，不进默认 pnpm test（§19.2）。
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
