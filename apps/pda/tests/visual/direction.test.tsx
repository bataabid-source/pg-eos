/// <reference types="vite/client" />
// WBS 2.16 part 2e — RED tests for the PDA visual layer.
//
// BUILD CONTRACT (2.16 part 2e — no logic change: machines, clients, mock clients, scan-queue, offline-queue, routes and i18n keys untouched; existing apps/pda tests pass unchanged):
// - `apps/pda/src/ui/tokens.ts`: `export const TOUCH_TARGET_MIN_PX = 48` (GM-approved scope), `export const SCAN_FIELD_MIN_HEIGHT_PX = 64` (DEFAULT, one CHANGELOG line; tests assert only ≥ TOUCH_TARGET_MIN_PX), `export const TOUCH_TARGET_CLASS = 'min-h-touch min-w-touch'`, `export const SCAN_FIELD_CLASS = 'min-h-scan'`, `export const ONE_STEP_TEST_ID = 'pda-step'`.
// - `apps/pda/tailwind.config.ts` (default export `Config`, `content: ['./index.html', './src/**/*.{ts,tsx}']`, colours as apps/admin, and `theme.extend.minHeight.touch = `${TOUCH_TARGET_MIN_PX}px``, `theme.extend.minWidth.touch` same, `theme.extend.minHeight.scan = `${SCAN_FIELD_MIN_HEIGHT_PX}px``); `apps/pda/postcss.config.js` as admin; `apps/pda/src/styles/tokens.css` gains the `@tailwind base/components/utilities` directives + the hsl colour variables; `index.html` unchanged in meaning.
// - Presentational components in `apps/pda/src/ui/`: `Button` (renders `<button>` with `TOUCH_TARGET_CLASS` in `className`, forwards all button props incl. `data-testid`, `type`, `disabled`), `ScanField` (a `<label>` + `<input>`; the input has `SCAN_FIELD_CLASS` + `TOUCH_TARGET_CLASS`, `autoFocus` on mount, `inputMode` given by props, forwards `data-testid`, `value`, `onChange`; exposes `refocus` via a `ref` prop — used by the receive screen after an accepted scan), `Screen` (one-step layout: `<section data-testid="pda-step">` with the `<h1>` title and ONE child step; root `className` includes `min-h-screen`), `Alert` (`role="alert"`, destructive colours), `Status` (`role="status"`), `Input` (`<input>` + TOUCH_TARGET_CLASS, no autoFocus). ScanField is used exactly once per screen (receive SKU, put-away location); other inputs use `Input`.
// - No dependency beyond tailwindcss/postcss/autoprefixer; components compose className with template strings; no cva/clsx/tailwind-merge/radix. If gate ① flags `tailwind.config.ts`, the builder may edit `apps/pda/{tsconfig*.json,vite.config.ts}` (inside lock `pda`; DEFAULT recorded).
// - Touch targets: EVERY interactive control (`button`, `input`, `select`, `a[href]`) rendered by the shell (locale select, kiosk button), `/home`, `/login`, `/receive`, `/put-away` carries both `min-h-touch` and `min-w-touch` in its `classList`. `tokens.ts` values: `TOUCH_TARGET_MIN_PX >= 48` and the tailwind config's `minHeight.touch === `${TOUCH_TARGET_MIN_PX}px`` (import the config in the test and read `theme.extend`).
// - Home (`/home`): a real `apps/pda/src/features/home/home-screen.tsx` replaces the placeholder — `<h1>` `screen.home` and one TanStack `<Link>` (rendered `<a href>`) per D4 route (`/receive`, `/put-away`, `/pick`, `/check`, `/load`, `/count`, `/transfer-return`, `/lookup`), each labelled with its `screen.*` key and a touch target. No new i18n key.
// - One step per screen: each of `/login`, `/receive`, `/put-away`, `/home` renders exactly one element with `data-testid="pda-step"`, and `/login`, `/receive` and `/put-away` render exactly ONE `<form>` at a time (login: request OR verify).
// - Scan field: on `/receive` the SKU input (`data-testid="receive-sku"` as today — keep every existing testid/label/role) is `document.activeElement` right after mount, has `min-h-scan` in its classList, and is focused again after an accepted scan (fields cleared); on `/put-away` the location input (`data-testid="putaway-location"`) is focused after the suggestion arrives.
// - Errors: refused scan on receive/put-away keeps `signal.error()` once + `role="alert"` with the next-action text (existing behaviour, decision 5) and the alert element carries a `data-severity="error"` attribute; login errors render through `Alert` (`role="alert"`, `data-severity="error"`); home has no error state (no data source).
// - Direction: `document.documentElement.dir` is `rtl` for ar/ur and `ltr` for en/hi/bn/am on each of `/home`, `/login`, `/receive`, `/put-away` (through the shell's locale select), and no rendered text node matches the untranslated-key pattern `/^[a-z]+(\.[A-Za-z]+)+$/`.

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from '@tanstack/react-router';

import { createRouter } from '../../src/router';
import { SUPPORTED_LOCALES, directionOf, t } from '../../src/i18n/t';
import { ONE_STEP_TEST_ID } from '../../src/ui/tokens';

const DB_NAME = 'pda-offline-queue';
const RTL_LOCALES = ['ar', 'ur'];
const UNTRANSLATED_KEY = /^[a-z]+(\.[A-Za-z]+)+$/;
const ROUTES = ['/home', '/login', '/receive', '/put-away'] as const;

function resetQueue(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function textNodes(root: Node): string[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = (node.textContent ?? '').trim();
    if (text.length > 0) {
      out.push(text);
    }
  }
  return out;
}

beforeEach(async () => {
  await resetQueue();
});

const PHYSICAL_PROPERTY = /(?<![\w-])(m[lr]|p[lr]|left|right|border-[lr]|rounded-[lr]|text-(left|right))(-|\b)/;
const CLASSNAME_STRING = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g;
const QUOTED_STRING = /(['"`])([^'"`]*)\1/g;
const SOURCES = import.meta.glob('../../src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('Decision 4: logical properties only', () => {
  it('no className string in apps/pda/src uses a physical left/right utility', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(0);
    for (const [file, source] of Object.entries(SOURCES)) {
      for (const match of source.matchAll(CLASSNAME_STRING)) {
        const value = match[1] ?? match[2] ?? match[3] ?? '';
        expect(value, `${file}: ${value}`).not.toMatch(PHYSICAL_PROPERTY);
      }
    }
  });
});

describe('Decision 4: logical properties only (every string literal in src/ui)', () => {
  it('no quoted string in apps/pda/src/ui uses a physical left/right utility', () => {
    const uiSources = Object.entries(SOURCES).filter(([file]) => file.includes('/src/ui/'));
    for (const [file, source] of uiSources) {
      for (const match of source.matchAll(QUOTED_STRING)) {
        const value = match[2] ?? '';
        expect(value, `${file}: ${value}`).not.toMatch(PHYSICAL_PROPERTY);
      }
    }
  });
});

describe('Scenario: ar and ur render dir="rtl"; en, hi, bn and am render dir="ltr", with no untranslated key', () => {
  it('the shell offers exactly the six locales', () => {
    expect([...SUPPORTED_LOCALES].sort()).toEqual(['am', 'ar', 'bn', 'en', 'hi', 'ur']);
  });

  for (const path of ROUTES) {
    it.each(SUPPORTED_LOCALES)(`${path} in %s: dir matches the locale, one step rendered, no untranslated key`, async (locale) => {
      const user = userEvent.setup();
      render(<RouterProvider router={createRouter(path)} />);
      await screen.findByTestId(ONE_STEP_TEST_ID);
      await user.selectOptions(screen.getByTestId('locale-select'), locale);

      const expected = RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr';
      expect(directionOf(locale)).toBe(expected);
      expect(document.documentElement.dir).toBe(expected);
      expect(document.documentElement.lang).toBe(locale);
      expect(await screen.findByTestId(ONE_STEP_TEST_ID)).toBeInTheDocument();
      expect(screen.getAllByRole('heading', { level: 1 }).length).toBeGreaterThan(0);
      expect(screen.getByRole('heading', { level: 1 }).textContent).not.toBe('');
      for (const text of textNodes(document.body)) {
        expect(text, `untranslated key rendered: ${text}`).not.toMatch(UNTRANSLATED_KEY);
      }
    });
  }

  it('/home links are labelled in the selected locale', async () => {
    const user = userEvent.setup();
    render(<RouterProvider router={createRouter('/home')} />);
    await screen.findByTestId(ONE_STEP_TEST_ID);
    await user.selectOptions(screen.getByTestId('locale-select'), 'en');
    expect(await screen.findByRole('link', { name: t('en', 'screen.receive') })).toBeInTheDocument();
  });
});
