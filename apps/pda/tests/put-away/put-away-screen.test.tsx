// WBS 2.16 part 2 — RED tests for the PDA put-away screen (scenarios 3, 4, 5).
// Queued bodies are the real `@pg-eos/contracts/wms/receive-inbound` types, consumed as they are.
//
// BUILD CONTRACT:
//   apps/pda/src/features/put-away/client.ts
//     export interface PutawayClient {
//       suggestLocation(input: SuggestLocationInput): Promise<{ locationId: string; locationCode: string }> }
//       SuggestLocationInput = { skuId, qty, warehouseId } from the contract.
//       suggestLocation REJECTS ONLY on transport failure (offline / unavailable).
//   apps/pda/src/features/put-away/mock-client.ts
//     export const mockPutawayClient: PutawayClient
//     export const MOCK_LINE_ID / MOCK_ORDER_ID / MOCK_SUGGEST_INPUT (SuggestLocationInput)
//     export const MOCK_SUGGESTED_LOCATION_CODE: string   (locationCode the mock resolves)
//   apps/pda/src/features/put-away/put-away-screen.tsx
//     export interface PutawayScreenProps { client: PutawayClient; orderId: string; lineId: string;
//       expectedVersion: number; suggest: SuggestLocationInput;
//       signal: ScanSignal (type from '../receive/scan-signal'); newKey: () => string;
//       newCorrelationId: () => string; now: () => Date; locale?: Locale;
//       enqueue?: (payload: unknown) => Promise<void> }   // default: offline-queue.ts enqueue
//     export function PutawayScreen(props)
//     On mount: client.suggestLocation(suggest) once; the element data-testid="putaway-suggested"
//       shows t(locale,'putaway.suggested',{ location: locationCode }).
//     The worker scans a location CODE into the input labelled putaway.scan.label
//       (data-testid="putaway-location") and presses the button named putaway.confirm.
//       Scanned === locationCode: newKey() once, newCorrelationId() once, enqueue once with
//         { kind:'confirm-putaway', idempotencyKey, body: { orderId, lineId, toLocationId: locationId,
//           expectedVersion, correlationId }, scannedAt: now().toISOString() }  (ConfirmPutawayInput),
//         signal.ok(), role=status shows putaway.confirmed.
//       Scanned !== locationCode: signal.error(), role=alert shows putaway.error.wrongLocation
//         { location: locationCode } (states the next action), no key, nothing enqueued.
//       Suggestion rejected (unavailable): signal.error() once, role=alert shows
//         putaway.suggestion.unavailable (states the next action: retry); NOTHING is enqueued
//         and newKey is never called, even if a code is then scanned.
//     root data-testid="putaway-screen"; <h1> screen.putAway. A confirm while one is in flight is
//       ignored.
//     Suggestion unavailable also leaves the confirm button disabled.
//     A REJECTED enqueue: role=alert pda.queue.saveFailed, signal.error() once, signal.ok() never;
//       the in-flight guard is cleared, so a second confirm calls enqueue again.
//   apps/pda/src/router.tsx: '/put-away' -> <PutawayScreen client={mockPutawayClient}
//     orderId={MOCK_ORDER_ID} lineId={MOCK_LINE_ID} expectedVersion={MOCK_EXPECTED_VERSION}
//     suggest={MOCK_SUGGEST_INPUT} .../>  (put-away mock-client exports MOCK_ORDER_ID, MOCK_LINE_ID,
//     MOCK_EXPECTED_VERSION, MOCK_SUGGEST_INPUT, MOCK_SUGGESTED_LOCATION_CODE).
//   i18n keys: putaway.suggested · putaway.scan.label · putaway.confirm · putaway.confirmed ·
//     putaway.error.wrongLocation · putaway.suggestion.unavailable
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from '@tanstack/react-router';
import { ConfirmPutawayInputSchema, type SuggestLocationInput } from '@pg-eos/contracts/wms/receive-inbound';

import { PutawayScreen } from '../../src/features/put-away/put-away-screen';
import type { PutawayClient } from '../../src/features/put-away/client';
import { MOCK_SUGGESTED_LOCATION_CODE } from '../../src/features/put-away/mock-client';
import type { ScanSignal } from '../../src/features/receive/scan-signal';
import { count, list } from '../../src/offline-queue';
import { createRouter } from '../../src/router';
import { t, SUPPORTED_LOCALES } from '../../src/i18n/t';
import ar from '../../src/i18n/ar.json';
import en from '../../src/i18n/en.json';
import hi from '../../src/i18n/hi.json';
import ur from '../../src/i18n/ur.json';
import bn from '../../src/i18n/bn.json';
import am from '../../src/i18n/am.json';

const DB_NAME = 'pda-offline-queue';
const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const LINE_ID = '22222222-2222-4222-8222-222222222222';
const LOCATION_ID = '55555555-5555-4555-8555-555555555555';
const SKU_ID = '66666666-6666-4666-8666-666666666666';
const WAREHOUSE_ID = '77777777-7777-4777-8777-777777777777';
const CORR = '33333333-3333-4333-8333-333333333331';
const EXPECTED_VERSION = 4;
const SUGGEST: SuggestLocationInput = { skuId: SKU_ID, qty: '10', warehouseId: WAREHOUSE_ID };
const SUGGESTED_CODE = 'QRT-01-A';
const OTHER_CODE = 'ZONE-9-Z';
const FIXED_NOW = new Date('2026-09-29T08:00:00.000Z');
const ONCE = 1;
const TWICE = 2;
const NEVER = 0;

const RAW: Record<string, Record<string, string>> = { ar, en, hi, ur, bn, am };
const NEW_KEYS = [
  'receive.sku.label', 'receive.batch.label', 'receive.expiry.label', 'receive.qty.label', 'receive.submit',
  'receive.accepted', 'receive.refused.lineNotFound', 'receive.refused.skuClientMismatch',
  'receive.refused.lineAlreadyReceived', 'receive.offline.retry',
  'receive.refused.invalidInput', 'pda.queue.saveFailed',
  'putaway.suggested', 'putaway.scan.label', 'putaway.confirm', 'putaway.confirmed',
  'putaway.error.wrongLocation', 'putaway.suggestion.unavailable',
] as const;

function resetQueue(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

const makeSignal = (): ScanSignal => ({ ok: vi.fn(), error: vi.fn() });
const makeClient = (): PutawayClient => ({
  suggestLocation: vi.fn().mockResolvedValue({ locationId: LOCATION_ID, locationCode: SUGGESTED_CODE }),
});
const offlineClient = (): PutawayClient => ({ suggestLocation: vi.fn().mockRejectedValue(new Error('offline')) });

function renderScreen(client: PutawayClient, signal: ScanSignal, newKey: () => string, locale: (typeof SUPPORTED_LOCALES)[number] = 'en',
  enqueue?: (payload: unknown) => Promise<void>,
) {
  const newCorrelationId = vi.fn(() => CORR);
  render(
    <PutawayScreen
      client={client}
      orderId={ORDER_ID}
      lineId={LINE_ID}
      expectedVersion={EXPECTED_VERSION}
      suggest={SUGGEST}
      signal={signal}
      newKey={newKey}
      newCorrelationId={newCorrelationId}
      now={() => FIXED_NOW}
      locale={locale}
      {...(enqueue ? { enqueue } : {})}
    />,
  );
  return { newCorrelationId };
}

beforeEach(async () => {
  await resetQueue();
});

describe('Scenario: Put-away shows the suggested location and confirms it by scanning the location code', () => {
  it('shows the suggested location, then a matching scan enqueues one valid ConfirmPutawayInput with toLocationId = locationId', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const newKey = vi.fn(() => 'key-pa-1');
    const client = makeClient();
    const { newCorrelationId } = renderScreen(client, signal, newKey);

    expect(await screen.findByTestId('putaway-suggested')).toHaveTextContent(t('en', 'putaway.suggested', { location: SUGGESTED_CODE }));
    expect(client.suggestLocation).toHaveBeenCalledWith(SUGGEST);
    await user.type(screen.getByLabelText(t('en', 'putaway.scan.label')), SUGGESTED_CODE);
    await user.click(screen.getByRole('button', { name: t('en', 'putaway.confirm') }));

    await waitFor(async () => expect(await count()).toBe(ONCE));
    const payload = (await list())[0]?.payload as { body: unknown };
    expect(payload).toEqual({
      kind: 'confirm-putaway',
      idempotencyKey: 'key-pa-1',
      body: { orderId: ORDER_ID, lineId: LINE_ID, toLocationId: LOCATION_ID, expectedVersion: EXPECTED_VERSION, correlationId: CORR },
      scannedAt: FIXED_NOW.toISOString(),
    });
    expect(ConfirmPutawayInputSchema.safeParse(payload.body).success).toBe(true);
    expect(newKey).toHaveBeenCalledTimes(ONCE);
    expect(newCorrelationId).toHaveBeenCalledTimes(ONCE);
    expect(signal.ok).toHaveBeenCalledTimes(ONCE);
    expect(signal.error).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(t('en', 'putaway.confirmed'));
  });

  it('a different location code plays the error signal, states the next action and enqueues nothing', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const newKey = vi.fn(() => 'never');
    const { newCorrelationId } = renderScreen(makeClient(), signal, newKey);
    await screen.findByTestId('putaway-suggested');
    await user.type(screen.getByLabelText(t('en', 'putaway.scan.label')), OTHER_CODE);
    await user.click(screen.getByRole('button', { name: t('en', 'putaway.confirm') }));

    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'putaway.error.wrongLocation', { location: SUGGESTED_CODE }));
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(signal.ok).not.toHaveBeenCalled();
    expect(newKey).not.toHaveBeenCalled();
    expect(newCorrelationId).not.toHaveBeenCalled();
    expect(await count()).toBe(NEVER);
  });

  it('a double confirm click enqueues once and generates one key', async () => {
    const user = userEvent.setup();
    const newKey = vi.fn(() => 'key-pa-1');
    const { newCorrelationId } = renderScreen(makeClient(), makeSignal(), newKey);
    await screen.findByTestId('putaway-suggested');
    await user.type(screen.getByLabelText(t('en', 'putaway.scan.label')), SUGGESTED_CODE);
    const confirm = screen.getByRole('button', { name: t('en', 'putaway.confirm') });
    await user.click(confirm);
    await user.click(confirm);
    await waitFor(async () => expect(await count()).toBe(ONCE));
    expect(newKey).toHaveBeenCalledTimes(ONCE);
    expect(newCorrelationId).toHaveBeenCalledTimes(ONCE);
  });
  it('a rejected enqueue shows the save-failed alert, error signal once, never ok; a second confirm calls enqueue again', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const enqueue = vi.fn().mockRejectedValueOnce(new Error('quota')).mockResolvedValue(undefined);
    renderScreen(makeClient(), signal, () => 'key-pa-1', 'en', enqueue);
    await screen.findByTestId('putaway-suggested');
    await user.type(screen.getByLabelText(t('en', 'putaway.scan.label')), SUGGESTED_CODE);
    const confirm = screen.getByRole('button', { name: t('en', 'putaway.confirm') });
    await user.click(confirm);

    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'pda.queue.saveFailed'));
    expect(enqueue).toHaveBeenCalledTimes(ONCE);
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(signal.ok).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: t('en', 'putaway.confirm') }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(TWICE));
  });
});

describe('Scenario: Offline, both screens keep working and the unsynced counter rises', () => {
  it('suggestion unavailable: error signal once, the retry message, nothing enqueued, no key ever generated', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const newKey = vi.fn(() => 'never');
    const { newCorrelationId } = renderScreen(offlineClient(), signal, newKey);

    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'putaway.suggestion.unavailable'));
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(screen.getByRole('button', { name: t('en', 'putaway.confirm') })).toBeDisabled();
    await user.type(screen.getByLabelText(t('en', 'putaway.scan.label')), OTHER_CODE);
    await user.click(screen.getByRole('button', { name: t('en', 'putaway.confirm') }));
    expect(await count()).toBe(NEVER);
    expect(newKey).not.toHaveBeenCalled();
    expect(newCorrelationId).not.toHaveBeenCalled();
  });

  it('route /put-away: renders the screen with the mock suggestion and the shell badge is present', async () => {
    render(<RouterProvider router={createRouter('/put-away')} />);
    expect(await screen.findByTestId('putaway-screen')).toBeInTheDocument();
    expect(await screen.findByTestId('putaway-suggested')).toHaveTextContent(MOCK_SUGGESTED_LOCATION_CODE);
    expect(screen.getByTestId('unsynced-queue-badge')).toBeInTheDocument();
  });
});

describe('Scenario: Every visible string resolves in ar, en, hi, ur, bn, am', () => {
  it.each(SUPPORTED_LOCALES)('locale %s: title, scan label and confirm resolve through t()', async (locale) => {
    renderScreen(makeClient(), makeSignal(), () => 'k', locale);
    expect(screen.getByRole('heading', { name: t(locale, 'screen.putAway') })).toBeInTheDocument();
    expect(screen.getByLabelText(t(locale, 'putaway.scan.label'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t(locale, 'putaway.confirm') })).toBeInTheDocument();
    expect(await screen.findByTestId('putaway-suggested')).toHaveTextContent(SUGGESTED_CODE);
  });

  it('every new receive/put-away key exists, non-empty, in the raw file of all six locales (t() fallback bypassed)', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const table = RAW[locale];
      for (const key of NEW_KEYS) {
        expect(typeof table?.[key]).toBe('string');
        expect((table?.[key] ?? '').length).toBeGreaterThan(0);
      }
    }
  });

  it('the six locale files keep identical key sets', () => {
    const arKeys = Object.keys(ar).sort();
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(RAW[locale] ?? {}).sort()).toEqual(arKeys);
    }
  });
});
