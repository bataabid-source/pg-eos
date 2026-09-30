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
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

import { createRouter } from '../../src/router';
import { t } from '../../src/i18n/t';
import { TOUCH_TARGET_MIN_PX, TOUCH_TARGET_CLASS, ONE_STEP_TEST_ID, SCAN_FIELD_MIN_HEIGHT_PX } from '../../src/ui/tokens';
import tokensCss from '../../src/styles/tokens.css?raw';
import mainSource from '../../src/main.tsx?raw';
import tailwindConfig from '../../tailwind.config';

const DB_NAME = 'pda-offline-queue';
const MIN_TOUCH_PX = 48;
const ONE = 1;
const NONE = 0;
const CONTROL_SELECTOR = 'button, input, select, a[href]';
const CLASS_H = 'min-h-touch';
const CLASS_W = 'min-w-touch';
const EMAIL = 'worker@example.com';
const WRONG_CODE = '000000';
const HOME_D4_ROUTES = ['/receive', '/put-away', '/pick', '/check', '/load', '/count', '/transfer-return', '/lookup'] as const;
const HOME_LINK_KEYS = [
  'screen.receive',
  'screen.putAway',
  'screen.pick',
  'screen.check',
  'screen.load',
  'screen.count',
  'screen.transferReturn',
  'screen.lookup',
] as const;

function resetQueue(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function expectAllControlsTouchSized(root: HTMLElement): void {
  const controls = Array.from(root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR));
  expect(controls.length).toBeGreaterThan(NONE);
  for (const control of controls) {
    expect(control.classList.contains(CLASS_H), `${control.outerHTML} lacks ${CLASS_H}`).toBe(true);
    expect(control.classList.contains(CLASS_W), `${control.outerHTML} lacks ${CLASS_W}`).toBe(true);
  }
}

beforeEach(async () => {
  await resetQueue();
});

describe('Scenario: Every interactive control is at least 48 px in both dimensions', () => {
  it('tokens: TOUCH_TARGET_MIN_PX >= 48 and TOUCH_TARGET_CLASS names both touch utilities', () => {
    expect(TOUCH_TARGET_MIN_PX).toBeGreaterThanOrEqual(MIN_TOUCH_PX);
    expect(TOUCH_TARGET_CLASS.split(' ')).toEqual([CLASS_H, CLASS_W]);
  });

  it('tailwind config: minHeight.touch and minWidth.touch equal the token in px', () => {
    const extend = tailwindConfig.theme?.extend as { minHeight?: Record<string, string>; minWidth?: Record<string, string> };
    expect(extend.minHeight?.touch).toBe(`${TOUCH_TARGET_MIN_PX}px`);
    expect(extend.minWidth?.touch).toBe(`${TOUCH_TARGET_MIN_PX}px`);
  });

  it('shell (locale select, kiosk button) controls carry both touch classes', async () => {
    const { container } = render(<RouterProvider router={createRouter('/home')} />);
    await screen.findByTestId(ONE_STEP_TEST_ID);
    const header = container.querySelector('header');
    expect(header).not.toBeNull();
    expectAllControlsTouchSized(header as HTMLElement);
    expect(screen.getByTestId('locale-select').classList.contains(CLASS_H)).toBe(true);
  });

  it.each(['/home', '/login', '/receive', '/put-away'])('%s: every button/input/select/a[href] carries both touch classes', async (path) => {
    const { container } = render(<RouterProvider router={createRouter(path)} />);
    await screen.findByTestId(ONE_STEP_TEST_ID);
    if (path === '/put-away') {
      await screen.findByTestId('putaway-suggested');
    }
    expectAllControlsTouchSized(container);
  });

  it('/login verify step: its controls carry both touch classes too', async () => {
    const user = userEvent.setup();
    const { container } = render(<RouterProvider router={createRouter('/login')} />);
    await user.type(await screen.findByLabelText(t('ar', 'login.email.label')), EMAIL);
    await user.click(screen.getByRole('button', { name: t('ar', 'login.email.submit') }));
    await screen.findByLabelText(t('ar', 'login.code.label'));
    expectAllControlsTouchSized(container);
  });

  it('/home renders one real link per D4 route, each labelled with its screen key', async () => {
    render(<RouterProvider router={createRouter('/home')} />);
    await screen.findByTestId(ONE_STEP_TEST_ID);
    const step = screen.getByTestId(ONE_STEP_TEST_ID);
    const links = Array.from(step.querySelectorAll<HTMLAnchorElement>('a[href]'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual([...HOME_D4_ROUTES]);
    expect(links.map((a) => a.textContent)).toEqual(HOME_LINK_KEYS.map((key) => t('ar', key)));
  });
});

describe('Scenario: the touch-target utilities compile to real CSS and are wired into the app', () => {
  it('tailwind compiles min-h-touch, min-w-touch and min-h-scan to the token sizes', async () => {
    const result = await postcss([
      tailwindcss({
        ...tailwindConfig,
        content: [{ raw: '<i class="min-h-touch min-w-touch min-h-scan">', extension: 'html' }],
      }),
    ]).process('@tailwind utilities', { from: undefined });
    expect(result.css).toContain(`min-height: ${TOUCH_TARGET_MIN_PX}px`);
    expect(result.css).toContain(`min-width: ${TOUCH_TARGET_MIN_PX}px`);
    expect(result.css).toContain(`min-height: ${SCAN_FIELD_MIN_HEIGHT_PX}px`);
  });

  it('the config scans src, tokens.css carries the utilities directive and main.tsx imports tokens.css', () => {
    expect(tailwindConfig.content).toContain('./src/**/*.{ts,tsx}');
    expect(tokensCss).toContain('@tailwind utilities');
    expect(mainSource).toContain("'./styles/tokens.css'");
  });
});

describe('Scenario: Each screen shows one step at a time', () => {
  it.each(['/login', '/receive', '/put-away', '/home'])('%s renders exactly one pda-step element with the h1 inside', async (path) => {
    render(<RouterProvider router={createRouter(path)} />);
    await screen.findByTestId(ONE_STEP_TEST_ID);
    const steps = screen.getAllByTestId(ONE_STEP_TEST_ID);
    expect(steps).toHaveLength(ONE);
    expect(steps[0]?.querySelector('h1')).not.toBeNull();
    expect(steps[0]?.className).toContain('min-h-screen');
  });

  it.each(['/login', '/receive', '/put-away'])('%s renders exactly one form', async (path) => {
    const { container } = render(<RouterProvider router={createRouter(path)} />);
    await screen.findByTestId(ONE_STEP_TEST_ID);
    expect(container.querySelectorAll('form')).toHaveLength(ONE);
  });

  it('/login shows the request form OR the verify form, never both', async () => {
    const user = userEvent.setup();
    const { container } = render(<RouterProvider router={createRouter('/login')} />);
    await user.type(await screen.findByLabelText(t('ar', 'login.email.label')), EMAIL);
    await user.click(screen.getByRole('button', { name: t('ar', 'login.email.submit') }));
    await screen.findByLabelText(t('ar', 'login.code.label'));
    expect(container.querySelectorAll('form')).toHaveLength(ONE);
    expect(screen.queryByLabelText(t('ar', 'login.email.label'))).toBeNull();
    expect(screen.getAllByTestId(ONE_STEP_TEST_ID)).toHaveLength(ONE);
  });
});

describe('Scenario: login errors use the visual error state', () => {
  it('a wrong code on /login shows a role=alert with data-severity=error', async () => {
    const user = userEvent.setup();
    render(<RouterProvider router={createRouter('/login')} />);
    await user.type(await screen.findByLabelText(t('ar', 'login.email.label')), EMAIL);
    await user.click(screen.getByRole('button', { name: t('ar', 'login.email.submit') }));
    await user.type(await screen.findByLabelText(t('ar', 'login.code.label')), WRONG_CODE);
    await user.click(screen.getByRole('button', { name: t('ar', 'login.code.submit') }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(t('ar', 'login.error.invalidCode'));
    expect(alert.getAttribute('data-severity')).toBe('error');
  });
});
