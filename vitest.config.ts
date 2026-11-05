import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import thresholds from './config/coverage.json';

export default defineConfig({
  plugins: [react()],
  define: { __MDPLUS_BUILD_ID__: JSON.stringify('test') },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/vite-env.d.ts'],
      reporter: ['text-summary', 'json-summary', 'lcov'],
      thresholds: thresholds.frontend,
    },
  },
});
