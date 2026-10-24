import {defineConfig} from 'vitest/config';

/** Pushes to a real repository. Requires explicit user authorization for that
 * run: vitest run --config vitest.github-sandbox.config.ts. Not part of checks. */
export default defineConfig({test:{
  include:['tests/integration/githubSandbox.test.ts'],
  environment:'node',fileParallelism:false,
}});
