import { defineConfig } from 'vitest/config';

// The CLI runs in plain Node, unlike the Worker suite.
export default defineConfig({
  test: { include: ['cli/test/**/*.test.ts'], environment: 'node' },
});
