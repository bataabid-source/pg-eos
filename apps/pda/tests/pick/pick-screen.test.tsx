// WBS 2.16 part 3 — RED tests for the PDA pick screen (scenarios 1, 2, 6).
//
// BUILD CONTRACT:
//   Common: every screen takes `signal: ScanSignal` (type from '../receive/scan-signal'), `newKey: () => string`,
//   `newCorrelationId: () => string`, `now: () => Date`, `locale?: Locale` (default 'ar'),
//   `enqueue?: (payload: unknown) => Promise<void>` (default: `enqueue` of apps/pda/src/offline-queue.ts).
//   Same mechanics as receive: the contract's own Zod field schemas validate the input BEFORE any client call or
//   key; the client verdict decides acceptance; on acceptance newKey() once, newCorrelationId() once, enqueue once
//   with { kind, idempotencyKey, body, scannedAt: now().toISOString() }, signal.ok() once, role=status shows the
//   success key; on refusal signal.error() once, role=alert shows the refusal key (states the next action), no key
//   generated, nothing enqueued; a client rejection with the feature's TransportError -> status 'offline' -> alert
//   `<feature>.offline.retry`; any other rejection -> `<feature>.error.unexpected`; a REJECTED enqueue -> alert
//   `pda.queue.saveFailed`, signal.error() once, a second submit calls enqueue again. A submit while one is in
//   flight is ignored. Each screen is an XState v5 machine (`<feature>-machine.ts`, setup/createMachine, `submitScan`
//   actor `fromPromise<SubmitResult, …>` like receiveMachine; `REFUSAL_KEY` and `STATUS_KEY` exported records,
//   no if/switch).
//
//   PICK — apps/pda/src/features/pick/
//   client.ts: export interface PickScan { orderId; lineId; locationCode; qtyActual: string; varianceReason?: string }
//     export type PickRefusalCode = 'lineNotFound' | 'lineAlreadyPicked' | 'qtyExceedsReserved' | 'lineNotReserved'
//       | 'varianceReasonRequired'   (server: OrderLineNotFoundError, LineAlreadyPickedError,
//       PickQuantityExceedsReservedError, LineNotReservedForPickError, VarianceReasonRequiredError)
//     export type PickVerdict = { accepted: true; expectedVersion: number } | { accepted: false; code: PickRefusalCode }
//     export class PickTransportError extends Error
//     export interface PickClient { checkPick(scan: PickScan): Promise<PickVerdict> }  (rejects with
//       PickTransportError only on transport failure)
//   pick-queue.ts: PickLineCommand { kind: 'pick-line'; idempotencyKey; body: PickLineInput; scannedAt }
//     PickSubmitResult = accepted{command} | refused{code} | offline | failed | invalid
//     submitPickScan(deps { client, newKey, newCorrelationId, now, enqueue }, scan): validates qtyActual with
//       PickLineInputSchema.shape.qtyActual (invalid -> 'invalid', no client call); body = { orderId, lineId,
//       expectedVersion: verdict.expectedVersion, qtyActual, varianceReason (only when non-empty), correlationId }
//   pick-machine.ts: export const pickMachine; input { orderId, lineId }; context { orderId, lineId,
//     fields { locationCode, qtyActual, varianceReason }, errorKey }; events FIELD{name,value} | SUBMIT; actor
//     submitScan; actions signalOk, signalError; states ready -> submitting -> picked (final) | ready + errorKey.
//     REFUSAL_KEY lineNotFound->pick.refused.lineNotFound, lineAlreadyPicked->pick.refused.lineAlreadyPicked,
//     qtyExceedsReserved->pick.refused.qtyExceedsReserved, lineNotReserved->pick.refused.lineNotReserved,
//     varianceReasonRequired->pick.refused.varianceReasonRequired; STATUS_KEY invalid->pick.refused.invalidInput,
//     offline->pick.offline.retry, failed->pick.error.unexpected.
//   mock-client.ts: MOCK_ORDER_ID (uuid), MOCK_LINE_ID (uuid), MOCK_EXPECTED_VERSION = 3,
//     MOCK_PICK_LINE = { skuCode: 'SKU-100', locationCode: 'A-01-01', qtyReserved: '10' }, mockPickClient:
//     lineId != MOCK_LINE_ID -> refused 'lineNotFound'; qtyActual > qtyReserved (numeric) -> 'qtyExceedsReserved';
//     qtyActual < qtyReserved (the mock line's qtyOrdered = qtyReserved) and varianceReason blank after trim ->
//     'varianceReasonRequired' (server invariant: qtyActual < qtyOrdered and blank-after-trim reason);
//     else accepted { expectedVersion: MOCK_EXPECTED_VERSION }. locationCode is a scanned field passed to the
//     client; no location comparison anywhere (PickLineInput has no location field).
//   pick-screen.tsx: PickScreenProps { client; orderId; lineId; line { skuCode, locationCode, qtyReserved }; signal;
//     newKey; newCorrelationId; now; locale?; enqueue? }; root data-testid="pick-screen", <h1> screen.pick;
//     data-testid="pick-line" shows t('pick.line', { sku, location, qty }); inputs labelled pick.location.label
//     (data-testid="pick-location"), pick.qty.label (data-testid="pick-qty"), pick.reason.label
//     (data-testid="pick-reason"); button pick.submit; status pick.picked. The screen never compares qty/location
//     itself — the client verdict decides.
//   router.tsx: '/pick' -> <PickScreen client={mockPickClient} orderId={MOCK_ORDER_ID} lineId={MOCK_LINE_ID}
//     line={MOCK_PICK_LINE} .../>.
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PickLineInputSchema } from '@pg-eos/contracts/wms/process-outbound';

import { PickScreen } from '../../src/features/pick/pick-screen';
import { PickTransportError, type PickClient, type PickRefusalCode } from '../../src/features/pick/client';
import { mockPickClient, MOCK_PICK_LINE, MOCK_ORDER_ID, MOCK_LINE_ID } from '../../src/features/pick/mock-client';
import type { ScanSignal } from '../../src/features/receive/scan-signal';
import { count, list } from '../../src/offline-queue';
import { RouterProvider } from '@tanstack/react-router';
import { createRouter } from '../../src/router';
import { t, SUPPORTED_LOCALES, directionOf, type Locale } from '../../src/i18n/t';
import ar from '../../src/i18n/ar.json';
import en from '../../src/i18n/en.json';
import hi from '../../src/i18n/hi.json';
import ur from '../../src/i18n/ur.json';
import bn from '../../src/i18n/bn.json';
import am from '../../src/i18n/am.json';

const DB_NAME = 'pda-offline-queue';
const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const LINE_ID = '22222222-2222-4222-8222-222222222222';
const CORR = '33333333-3333-4333-8333-333333333331';
const EXPECTED_VERSION = 3;
const FIXED_NOW = new Date('2026-09-29T08:00:00.000Z');
const LINE = { skuCode: 'SKU-100', locationCode: 'A-01-01', qtyReserved: '10' };
const QTY_OVER = '11';
const QTY_SHORT = '8';
const REASON = 'damaged';
const MOCK_IDS = { orderId: MOCK_ORDER_ID, lineId: MOCK_LINE_ID };
const ONCE = 1;
const TWICE = 2;
const NEVER = 0;
const RAW: Record<string, Record<string, string>> = { ar, en, hi, ur, bn, am };
const REFUSALS: ReadonlyArray<[PickRefusalCode, string]> = [
  ['lineNotFound', 'pick.refused.lineNotFound'],
  ['lineAlreadyPicked', 'pick.refused.lineAlreadyPicked'],
  ['qtyExceedsReserved', 'pick.refused.qtyExceedsReserved'],
  ['lineNotReserved', 'pick.refused.lineNotReserved'],
  ['varianceReasonRequired', 'pick.refused.varianceReasonRequired'],
];

function resetQueue(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

const makeSignal = (): ScanSignal => ({ ok: vi.fn(), error: vi.fn() });
const acceptingClient = (): PickClient => ({
  checkPick: vi.fn().mockResolvedValue({ accepted: true, expectedVersion: EXPECTED_VERSION }),
});

function renderScreen(
  client: PickClient,
  signal: ScanSignal,
  newKey: () => string,
  locale: Locale = 'en',
  enqueue?: (payload: unknown) => Promise<void>,
  ids: { orderId: string; lineId: string } = { orderId: ORDER_ID, lineId: LINE_ID },
) {
  const newCorrelationId = vi.fn(() => CORR);
  render(
    <PickScreen
      client={client}
      orderId={ids.orderId}
      lineId={ids.lineId}
      line={LINE}
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

async function fillAndSubmit(
  user: ReturnType<typeof userEvent.setup>,
  fields: { location?: string; qty?: string; reason?: string },
) {
  if (fields.location !== undefined) {
    await user.type(screen.getByLabelText(t('en', 'pick.location.label')), fields.location);
  }
  if (fields.qty !== undefined) {
    await user.type(screen.getByLabelText(t('en', 'pick.qty.label')), fields.qty);
  }
  if (fields.reason !== undefined) {
    await user.type(screen.getByLabelText(t('en', 'pick.reason.label')), fields.reason);
  }
  await user.click(screen.getByRole('button', { name: t('en', 'pick.submit') }));
}

beforeEach(async () => {
  await resetQueue();
});

describe('Scenario: A scanned pick line queues one PickLine write with one Idempotency-Key and correlationId', () => {
  it('renders the root, the h1 and the line summary', () => {
    renderScreen(acceptingClient(), makeSignal(), () => 'k');
    expect(screen.getByTestId('pick-screen')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(t('en', 'screen.pick'));
    expect(screen.getByTestId('pick-line')).toHaveTextContent(
      t('en', 'pick.line', { sku: LINE.skuCode, location: LINE.locationCode, qty: LINE.qtyReserved }),
    );
    expect(screen.getByTestId('pick-location')).toBe(screen.getByLabelText(t('en', 'pick.location.label')));
    expect(screen.getByTestId('pick-qty')).toBe(screen.getByLabelText(t('en', 'pick.qty.label')));
    expect(screen.getByTestId('pick-reason')).toBe(screen.getByLabelText(t('en', 'pick.reason.label')));
  });

  it('an accepted pick enqueues one valid PickLineInput with one key and one correlationId', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const newKey = vi.fn(() => 'key-pick-1');
    const client = acceptingClient();
    const { newCorrelationId } = renderScreen(client, signal, newKey);
    await fillAndSubmit(user, { location: LINE.locationCode, qty: LINE.qtyReserved });

    await waitFor(async () => expect(await count()).toBe(ONCE));
    const payload = (await list())[0]?.payload as { body: unknown };
    expect(payload).toEqual({
      kind: 'pick-line',
      idempotencyKey: 'key-pick-1',
      body: {
        orderId: ORDER_ID,
        lineId: LINE_ID,
        expectedVersion: EXPECTED_VERSION,
        qtyActual: LINE.qtyReserved,
        correlationId: CORR,
      },
      scannedAt: FIXED_NOW.toISOString(),
    });
    expect(PickLineInputSchema.safeParse(payload.body).success).toBe(true);
    expect(client.checkPick).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: ORDER_ID,
        lineId: LINE_ID,
        locationCode: LINE.locationCode,
        qtyActual: LINE.qtyReserved,
      }),
    );
    expect(newKey).toHaveBeenCalledTimes(ONCE);
    expect(newCorrelationId).toHaveBeenCalledTimes(ONCE);
    expect(signal.ok).toHaveBeenCalledTimes(ONCE);
    expect(signal.error).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(t('en', 'pick.picked'));
  });

  it('a variance reason, when typed, is carried in the queued body', async () => {
    const user = userEvent.setup();
    renderScreen(acceptingClient(), makeSignal(), () => 'key-pick-2');
    await fillAndSubmit(user, { location: LINE.locationCode, qty: QTY_SHORT, reason: REASON });
    await waitFor(async () => expect(await count()).toBe(ONCE));
    const payload = (await list())[0]?.payload as { body: { qtyActual: string; varianceReason?: string } };
    expect(payload.body.qtyActual).toBe(QTY_SHORT);
    expect(payload.body.varianceReason).toBe(REASON);
    expect(PickLineInputSchema.safeParse(payload.body).success).toBe(true);
  });

  it('a non-numeric quantity is invalid: alert, error signal once, no client call, no key, nothing enqueued', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const newKey = vi.fn(() => 'never');
    const client = acceptingClient();
    const { newCorrelationId } = renderScreen(client, signal, newKey);
    await fillAndSubmit(user, { location: LINE.locationCode, qty: 'abc' });
    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'pick.refused.invalidInput'));
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(client.checkPick).not.toHaveBeenCalled();
    expect(newKey).not.toHaveBeenCalled();
    expect(newCorrelationId).not.toHaveBeenCalled();
    expect(await count()).toBe(NEVER);
  });

  it('a double submit click enqueues once and generates one key', async () => {
    const user = userEvent.setup();
    const newKey = vi.fn(() => 'key-pick-1');
    const { newCorrelationId } = renderScreen(acceptingClient(), makeSignal(), newKey);
    await user.type(screen.getByLabelText(t('en', 'pick.location.label')), LINE.locationCode);
    await user.type(screen.getByLabelText(t('en', 'pick.qty.label')), LINE.qtyReserved);
    const submit = screen.getByRole('button', { name: t('en', 'pick.submit') });
    await user.click(submit);
    await user.click(submit);
    await waitFor(async () => expect(await count()).toBe(ONCE));
    expect(newKey).toHaveBeenCalledTimes(ONCE);
    expect(newCorrelationId).toHaveBeenCalledTimes(ONCE);
  });

  it('a submit while the verdict is in flight is ignored', async () => {
    const user = userEvent.setup();
    let release: (v: { accepted: true; expectedVersion: number }) => void = () => undefined;
    const checkPick = vi.fn(
      () => new Promise<{ accepted: true; expectedVersion: number }>((resolve) => (release = resolve)),
    );
    const newKey = vi.fn(() => 'key-pick-1');
    renderScreen({ checkPick }, makeSignal(), newKey);
    await user.type(screen.getByLabelText(t('en', 'pick.location.label')), LINE.locationCode);
    await user.type(screen.getByLabelText(t('en', 'pick.qty.label')), LINE.qtyReserved);
    const submit = screen.getByRole('button', { name: t('en', 'pick.submit') });
    await user.click(submit);
    await user.click(submit);
    expect(checkPick).toHaveBeenCalledTimes(ONCE);
    release({ accepted: true, expectedVersion: EXPECTED_VERSION });
    await waitFor(async () => expect(await count()).toBe(ONCE));
    expect(newKey).toHaveBeenCalledTimes(ONCE);
  });

  it('a rejected enqueue shows the save-failed alert, error signal once, never ok; a second submit calls enqueue again', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const enqueue = vi.fn().mockRejectedValueOnce(new Error('quota')).mockResolvedValue(undefined);
    renderScreen(acceptingClient(), signal, () => 'key-pick-1', 'en', enqueue);
    await user.type(screen.getByLabelText(t('en', 'pick.location.label')), LINE.locationCode);
    await user.type(screen.getByLabelText(t('en', 'pick.qty.label')), LINE.qtyReserved);
    await user.click(screen.getByRole('button', { name: t('en', 'pick.submit') }));

    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'pda.queue.saveFailed'));
    expect(enqueue).toHaveBeenCalledTimes(ONCE);
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(signal.ok).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: t('en', 'pick.submit') }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(TWICE));
  });
});

describe('Scenario: A server refusal on a pick plays the error sound + vibration and states the next action', () => {
  it.each(REFUSALS)('refusal %s -> alert %s, error signal once, no key, nothing enqueued', async (code, key) => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const newKey = vi.fn(() => 'never');
    const client: PickClient = { checkPick: vi.fn().mockResolvedValue({ accepted: false, code }) };
    const { newCorrelationId } = renderScreen(client, signal, newKey);
    await fillAndSubmit(user, { location: LINE.locationCode, qty: LINE.qtyReserved });

    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', key as Parameters<typeof t>[1]));
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(signal.ok).not.toHaveBeenCalled();
    expect(newKey).not.toHaveBeenCalled();
    expect(newCorrelationId).not.toHaveBeenCalled();
    expect(await count()).toBe(NEVER);
  });

  it('a PickTransportError shows the offline retry message; nothing enqueued, no key', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const newKey = vi.fn(() => 'never');
    const client: PickClient = { checkPick: vi.fn().mockRejectedValue(new PickTransportError('down')) };
    renderScreen(client, signal, newKey);
    await fillAndSubmit(user, { location: LINE.locationCode, qty: LINE.qtyReserved });
    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'pick.offline.retry'));
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(newKey).not.toHaveBeenCalled();
    expect(await count()).toBe(NEVER);
  });

  it('any other client rejection shows the unexpected-error message', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const client: PickClient = { checkPick: vi.fn().mockRejectedValue(new Error('boom')) };
    renderScreen(client, signal, () => 'never');
    await fillAndSubmit(user, { location: LINE.locationCode, qty: LINE.qtyReserved });
    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'pick.error.unexpected'));
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(await count()).toBe(NEVER);
  });

  it('the mock client refuses a self-invented quantity above the reserved one', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const newKey = vi.fn(() => 'never');
    renderScreen(mockPickClient, signal, newKey, 'en', undefined, MOCK_IDS);
    await fillAndSubmit(user, { location: MOCK_PICK_LINE.locationCode, qty: QTY_OVER });
    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'pick.refused.qtyExceedsReserved'));
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(newKey).not.toHaveBeenCalled();
    expect(await count()).toBe(NEVER);
  });

  it('the mock client refuses a line other than MOCK_LINE_ID as lineNotFound', async () => {
    const user = userEvent.setup();
    renderScreen(mockPickClient, makeSignal(), () => 'never');
    await fillAndSubmit(user, { location: MOCK_PICK_LINE.locationCode, qty: MOCK_PICK_LINE.qtyReserved });
    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'pick.refused.lineNotFound'));
    expect(await count()).toBe(NEVER);
  });

  it('the mock client + MOCK ids + the exact reserved quantity queues a body that parses with PickLineInputSchema', async () => {
    const user = userEvent.setup();
    renderScreen(mockPickClient, makeSignal(), () => 'key-pick-mock', 'en', undefined, MOCK_IDS);
    await fillAndSubmit(user, { location: MOCK_PICK_LINE.locationCode, qty: MOCK_PICK_LINE.qtyReserved });
    await waitFor(async () => expect(await count()).toBe(ONCE));
    const payload = (await list())[0]?.payload as { body: unknown };
    expect(PickLineInputSchema.safeParse(payload.body).success).toBe(true);
  });

  it('the mock client asks for a variance reason when the quantity is short and none is given', async () => {
    const user = userEvent.setup();
    renderScreen(mockPickClient, makeSignal(), () => 'never', 'en', undefined, MOCK_IDS);
    await fillAndSubmit(user, { location: MOCK_PICK_LINE.locationCode, qty: QTY_SHORT });
    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'pick.refused.varianceReasonRequired'));
    expect(await count()).toBe(NEVER);
  });
});

describe('Scenario: /pick renders in all six locales, RTL for ar and ur', () => {
  it.each(SUPPORTED_LOCALES)('locale %s: h1, labels and button resolve; direction matches', (locale) => {
    renderScreen(acceptingClient(), makeSignal(), () => 'k', locale);
    const title = RAW[locale]?.['screen.pick'];
    expect(title).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(title as string);
    expect(screen.getByLabelText(t(locale, 'pick.location.label'))).toBeInTheDocument();
    expect(screen.getByLabelText(t(locale, 'pick.qty.label'))).toBeInTheDocument();
    expect(screen.getByLabelText(t(locale, 'pick.reason.label'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t(locale, 'pick.submit') })).toBeInTheDocument();
    expect(directionOf(locale)).toBe(locale === 'ar' || locale === 'ur' ? 'rtl' : 'ltr');
  });

  it('every pick key is a non-empty string in the raw file of all six locales', () => {
    const pickKeys = Object.keys(ar).filter((k) => k.startsWith('pick.'));
    expect(pickKeys.length).toBeGreaterThan(NEVER);
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of pickKeys) {
        expect((RAW[locale]?.[key] ?? '').length).toBeGreaterThan(NEVER);
      }
    }
  });
});

describe('Scenario: /pick route in all six locales, RTL for ar and ur (shell selector)', () => {
  it.each(SUPPORTED_LOCALES)('route /pick at locale %s: shell dir/lang and the h1 equal the locale raw value', async (locale) => {
    const user = userEvent.setup();
    render(<RouterProvider router={createRouter('/pick')} />);
    expect(await screen.findByTestId('pick-screen')).toBeInTheDocument();
    await user.selectOptions(screen.getByTestId('locale-select'), locale);
    expect(document.documentElement.dir).toBe(locale === 'ar' || locale === 'ur' ? 'rtl' : 'ltr');
    expect(document.documentElement.lang).toBe(locale);
    const title = RAW[locale]?.['screen.pick'];
    expect(title).toBeTruthy();
    expect(within(await screen.findByTestId('pick-screen')).getByRole('heading', { level: 1 })).toHaveTextContent(
      title as string,
    );
  });
});
