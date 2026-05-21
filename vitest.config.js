import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Vitest auto-discovers *.spec.js, but the SauceLabs runner spec is a
    // Playwright test (executed inside the SauceLabs VM, not by vitest).
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/release/**',
      'src/saucelabs-runner/**'
    ],
  },
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
    },
  },
});
