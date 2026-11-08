import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { root: '.', include: ['server/test/**/*.test.ts'], testTimeout: 30_000 } });
