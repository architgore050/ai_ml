import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vitest/config';

// `vite.config.ts` is not merged with this file automatically, so the alias and
// the React plugin are re-declared here. Keep them in sync with vite.config.ts.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/setupTests.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // The player store and the auth store are module-level singletons keyed off
    // sessionStorage. Tests must not interleave file pools through them.
    restoreMocks: true,
  },
});
