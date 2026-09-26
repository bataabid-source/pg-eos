// WBS 2.16 part 1a — Vite config for @pg-eos/pda (first-ever PDA slice, same shape as
// apps/admin/vite.config.ts, WBS 0.19's own precedent). The `test` block configures Vitest
// directly from this file (no separate vitest.config.ts); jsdom environment + Testing Library
// matchers for the component tests under tests/shell/*.
/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.tsx', 'tests/**/*.test.ts'],
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
