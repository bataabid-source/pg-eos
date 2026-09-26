// WBS 2.16 part 1a — Vite config for @pg-eos/pda (first-ever PDA slice, same shape as
// apps/admin/vite.config.ts, WBS 0.19's own precedent). The `test` block configures Vitest
// directly from this file (no separate vitest.config.ts); jsdom environment + Testing Library
// matchers for the component tests under tests/shell/*.
/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// WBS 2.16 part 1a-2 — PWA manifest + service worker (brief Master decision 4): default
// `generateSW` strategy (not `injectManifest` — no custom caching logic this part),
// `registerType: 'autoUpdate'`, precaching the Vite build output only. No push notifications, no
// background sync API this part.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Premium WH',
        short_name: 'Premium WH',
        // fix round 1, finding 5: the brief says "theme colors matching
        // apps/pda/src/styles/tokens.css" — checked, and tokens.css defines no theme/background
        // colour tokens this part (its own comment: "no design-token set is defined by the
        // D-blueprint for this app yet"). Recorded here as an honest default, not a brief quote.
        theme_color: '#000000',
        background_color: '#ffffff',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.tsx', 'tests/**/*.test.ts'],
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
