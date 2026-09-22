import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Launching a real headless Chromium instance and printing two PDFs in a single test (WBS
    // 0.15's third scenario) is slower than vitest's 5s default, especially on a cold
    // `~/.cache/puppeteer` or a loaded CI runner — same rationale packages/events documents for
    // its own config decisions (this file's own header precedent). 30s leaves comfortable margin
    // without masking a genuinely hung render.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
