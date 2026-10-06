import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/browser/**/*.test.ts'],
    // 真实 runtime 冒烟（tests/e2e/）消耗真实调用，仅 pnpm test:e2e 显式执行（§19.2）
    environment: 'node',
  },
});
