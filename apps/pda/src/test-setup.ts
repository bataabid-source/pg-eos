// WBS 2.16 part 1a — Vitest setup: registers @testing-library/jest-dom matchers (toBeVisible, etc.)
// used by tests/shell/*.test.tsx. Lives under src/ (pg-frontend's write scope), not tests/
// (pg-tester's, per CLAUDE.md BUILD METHOD).
// fix round 1, finding 6: `fake-indexeddb` polyfills the global `indexedDB` ONCE here, for every
// test file in this package (Master decision 5) — a per-test-file import (as
// tests/shell/offline-queue.test.ts and tests/shell/queue-badge.test.tsx also do, harmlessly and
// idempotently) is not enough on its own: any OTHER test file that renders `AppShell`
// (kiosk-mode.test.tsx, routes.test.tsx) without its own import previously hit the swallowed-error
// path in router.tsx's `count()` call with no IndexedDB polyfill at all.
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Testing Library's auto-cleanup only self-registers when it detects a global `afterEach`
// (globals: true); this project keeps `globals: false` and imports test APIs explicitly, so
// cleanup is wired here instead — otherwise every test's rendered DOM accumulates across the
// file.
afterEach(() => {
  cleanup();
});
