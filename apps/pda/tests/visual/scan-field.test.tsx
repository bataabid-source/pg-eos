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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ReceiveScreen } from '../../src/features/receive/receive-screen';
import { PutawayScreen } from '../../src/features/put-away/put-away-screen';
import type { ReceiveClient } from '../../src/features/receive/client';
import type { ScanSignal } from '../../src/features/receive/scan-signal';
import { ACCEPTED_SCAN_FIXTURE, mockReceiveClient } from '../../src/features/receive/mock-client';
import {
  mockPutawayClient,
  MOCK_ORDER_ID as PUTAWAY_ORDER_ID,
  MOCK_LINE_ID as PUTAWAY_LINE_ID,
  MOCK_EXPECTED_VERSION as PUTAWAY_VERSION,
  MOCK_SUGGEST_INPUT,
} from '../../src/features/put-away/mock-client';
import { t, type Locale } from '../../src/i18n/t';
import { SCAN_FIELD_MIN_HEIGHT_PX, TOUCH_TARGET_MIN_PX } from '../../src/ui/tokens';
import tailwindConfig from '../../tailwind.config';

const DB_NAME = 'pda-offline-queue';
const LOCALE: Locale = 'en';
const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const FIXED_NOW = new Date('2026-09-29T08:00:00.000Z');
const ONCE = 1;
const WRONG_LOCATION = 'NOT-THE-SUGGESTED-CODE';
const SEVERITY_ERROR = 'error';

function resetQueue(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function makeSignal(): ScanSignal {
  return { ok: vi.fn(), error: vi.fn() };
}

function keys(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `generated-${n}`;
  };
}

function renderReceive(client: ReceiveClient = mockReceiveClient, signal: ScanSignal = makeSignal()) {
  render(
    <ReceiveScreen
      client={client}
      orderId={ORDER_ID}
      signal={signal}
      newKey={keys()}
      newCorrelationId={keys()}
      now={() => FIXED_NOW}
      locale={LOCALE}
    />,
  );
  return signal;
}

function renderPutaway(signal: ScanSignal = makeSignal()) {
  render(
    <PutawayScreen
      client={mockPutawayClient}
      orderId={PUTAWAY_ORDER_ID}
      lineId={PUTAWAY_LINE_ID}
      expectedVersion={PUTAWAY_VERSION}
      suggest={MOCK_SUGGEST_INPUT}
      signal={signal}
      newKey={keys()}
      newCorrelationId={keys()}
      now={() => FIXED_NOW}
      locale={LOCALE}
    />,
  );
  return signal;
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, sku: string): Promise<void> {
  await user.type(screen.getByLabelText(t(LOCALE, 'receive.sku.label')), sku);
  await user.type(screen.getByLabelText(t(LOCALE, 'receive.batch.label')), ACCEPTED_SCAN_FIXTURE.batchNo);
  await user.type(screen.getByLabelText(t(LOCALE, 'receive.expiry.label')), ACCEPTED_SCAN_FIXTURE.expiryDate);
  await user.type(screen.getByLabelText(t(LOCALE, 'receive.qty.label')), ACCEPTED_SCAN_FIXTURE.qty);
  await user.click(screen.getByRole('button', { name: t(LOCALE, 'receive.submit') }));
}

beforeEach(async () => {
  await resetQueue();
});

describe('Scenario: The scan field is large, autofocused on mount and refocused after each accepted scan', () => {
  it('tokens: the scan field is at least as tall as a touch target, and the tailwind config names min-h-scan', () => {
    expect(SCAN_FIELD_MIN_HEIGHT_PX).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
    const extend = tailwindConfig.theme?.extend as { minHeight?: Record<string, string> };
    expect(extend.minHeight?.scan).toBe(`${SCAN_FIELD_MIN_HEIGHT_PX}px`);
  });

  it('receive: the SKU input has min-h-scan and is the active element right after mount', () => {
    renderReceive();
    const sku = screen.getByTestId('receive-sku');
    expect(sku.classList.contains('min-h-scan')).toBe(true);
    expect(sku.classList.contains('min-h-touch')).toBe(true);
    expect(sku.classList.contains('min-w-touch')).toBe(true);
    expect(document.activeElement).toBe(sku);
  });

  it('receive: after an accepted scan the fields are cleared and the SKU input is focused again', async () => {
    const user = userEvent.setup();
    renderReceive();
    await fillAndSubmit(user, ACCEPTED_SCAN_FIXTURE.skuCode);
    await screen.findByRole('status');
    const sku = screen.getByTestId('receive-sku');
    expect(sku).toHaveValue('');
    expect(document.activeElement).toBe(sku);
  });

  it('put-away: the location input is focused once the suggestion has arrived', async () => {
    renderPutaway();
    await screen.findByTestId('putaway-suggested');
    expect(document.activeElement).toBe(screen.getByTestId('putaway-location'));
  });
});

describe('Scenario: A refused scan plays sound + vibration and shows a message stating the next action', () => {
  it('receive: a refused scan calls signal.error once and shows a role=alert next-action message with data-severity=error', async () => {
    const user = userEvent.setup();
    const signal = renderReceive();
    await fillAndSubmit(user, `${ACCEPTED_SCAN_FIXTURE.skuCode}-UNKNOWN`);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(t(LOCALE, 'receive.refused.lineNotFound'));
    expect(alert.getAttribute('data-severity')).toBe(SEVERITY_ERROR);
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(signal.ok).not.toHaveBeenCalled();
  });

  it('receive: an accepted scan status is role=status and is not an alert', async () => {
    const user = userEvent.setup();
    renderReceive();
    await fillAndSubmit(user, ACCEPTED_SCAN_FIXTURE.skuCode);
    expect(await screen.findByRole('status')).toHaveTextContent(t(LOCALE, 'receive.accepted'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('put-away: a wrong location calls signal.error once and shows a role=alert message with data-severity=error', async () => {
    const user = userEvent.setup();
    const signal = renderPutaway();
    await screen.findByTestId('putaway-suggested');
    await user.type(screen.getByTestId('putaway-location'), WRONG_LOCATION);
    await user.click(screen.getByRole('button', { name: t(LOCALE, 'putaway.confirm') }));
    const alert = await screen.findByRole('alert');
    expect(alert.getAttribute('data-severity')).toBe(SEVERITY_ERROR);
    expect(alert.textContent ?? '').not.toBe('');
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(signal.ok).not.toHaveBeenCalled();
  });
});
