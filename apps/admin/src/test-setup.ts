// WBS 0.19 — Vitest setup: registers @testing-library/jest-dom matchers (toBeVisible, etc.) used
// by tests/decision-inbox/*.test.tsx. Lives under src/ (pg-frontend's write scope), not tests/
// (pg-tester's, per CLAUDE.md BUILD METHOD).
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Testing Library's auto-cleanup only self-registers when it detects a global `afterEach`
// (globals: true); this project keeps `globals: false` and imports test APIs explicitly, so
// cleanup is wired here instead — otherwise every test's rendered DOM accumulates across the
// file (multiple "decision-card" / "locale-select" matches in later tests).
afterEach(() => {
  cleanup();
});
