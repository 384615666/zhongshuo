// Standalone entry point for the backend audit regression checks.
import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['scripts/audits/backend-20261108.test.ts'],environment:'node',testTimeout:15000}});
