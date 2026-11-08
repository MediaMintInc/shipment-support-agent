import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Component logs go to stderr; keep test output readable. Override with LOG_LEVEL=debug.
    env: { LOG_LEVEL: process.env.LOG_LEVEL ?? 'error' },
  },
});
