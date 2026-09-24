// WBS 0.19 — Vite config for @pg-eos/admin (first-ever frontend slice).
// The `test` block configures Vitest directly from this file (no separate vitest.config.ts —
// keeps the deliverable list exact); jsdom environment + Testing Library matchers for the
// component tests under tests/decision-inbox/*.
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
