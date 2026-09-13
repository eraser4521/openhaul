import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: { reporter: ['text', 'lcov'], include: ['src/lib/**'] },
  },
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), 'src'),
      // `server-only` throws when imported outside a React Server Component
      // graph, which is every test. Stubbed so the modules it guards can be
      // unit tested directly.
      'server-only': path.resolve(process.cwd(), 'tests/stubs/server-only.ts'),
    },
  },
});
