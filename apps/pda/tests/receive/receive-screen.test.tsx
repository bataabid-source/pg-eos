// WBS 2.16 part 2 — RED tests for the PDA receive screen (scenarios 1, 2, 4, 5).
// The modules under test do not exist yet: every import below fails until pg-builder writes them.
//
// BUILD CONTRACT (restated so the builder needs no other source). Queued bodies are the real
// `@pg-eos/contracts/wms/receive-inbound` types, consumed as they are.
//
//   apps/pda/src/features/receive/scan-signal.ts
//     export interface ScanSignal { ok(): void; error(): void }   // sound + vibration in the browser
//     export const browserScanSignal: ScanSignal
//   apps/pda/src/features/receive/client.ts
//     export interface ReceiveScan { orderId: string; skuCode: string; batchNo: string;
//       expiryDate: string; qty: string }
//     export type ReceiveRefusalCode = 'lineNotFound' | 'skuClientMismatch' | 'lineAlreadyReceived'
//       (LineNotFoundError / SkuClientMismatchError / LineAlreadyReceivedError of the server)
//     export type ReceiveScanVerdict = { accepted: true; lineId: string; expectedVersion: number }
//       | { accepted: false; code: ReceiveRefusalCode }
//     export interface ReceiveClient { checkScan(scan: ReceiveScan): Promise<ReceiveScanVerdict> }
//       checkScan REJECTS ONLY on transport failure; a server 4xx RESOLVES to a refusal verdict.
//       lineId / expectedVersion exist ONLY on an accepted verdict.
//   OFFLINE RECEIPT QUEUING IS DEFERRED to WBS 2.16 part 2b (pre-build review finding 1: the flush
//   must re-resolve the line from the scanned SKU). In this part a checkScan transport failure
//   REFUSES the scan: signal.error once, role=alert receive.offline.retry, nothing enqueued, no key.
//   apps/pda/src/features/receive/mock-client.ts
//     export const mockReceiveClient: ReceiveClient   (accepts ACCEPTED_SCAN_FIXTURE and returns
//       { accepted: true, lineId: MOCK_LINE_ID, expectedVersion: MOCK_EXPECTED_VERSION })
//     export const MOCK_ORDER_ID: string / MOCK_LINE_ID: string   (UUIDs) / MOCK_EXPECTED_VERSION: number
//     export const ACCEPTED_SCAN_FIXTURE: { skuCode; batchNo; expiryDate; qty }
//   apps/pda/src/features/receive/scan-queue.ts
//     export interface ReceiveLineCommand { kind: 'receive-line'; idempotencyKey: string;
//       body: ReceiveLineInput; scannedAt: string }     // ReceiveLineInput from the contract
//     export interface SubmitDeps { client: ReceiveClient; newKey: () => string;
//       newCorrelationId: () => string; now: () => Date; enqueue: (payload: unknown) => Promise<void> }
//     export type SubmitResult = { status: 'accepted'; command: ReceiveLineCommand }
//       | { status: 'refused'; code: ReceiveRefusalCode } | { status: 'offline' } | { status: 'invalid' }
//       'invalid' = the assembled fields fail the contract's own field schemas (expiryDate must be an
//       ISO date YYYY-MM-DD, qtyActual a non-negative numeric string up to 3 decimals). Validation
//       happens before any key is generated: refused / offline / invalid call none of newKey /
//       newCorrelationId / enqueue. The screen shows role=alert receive.refused.invalidInput and
//       signal.error() once for 'invalid'.
//       A REJECTED enqueue (screen level): role=alert pda.queue.saveFailed, signal.error() once,
//       signal.ok() never (ok only AFTER a successful enqueue), the submit control usable again.
//     export function submitReceiveScan(deps: SubmitDeps, scan: ReceiveScan): Promise<SubmitResult>
//       accepted verdict ONLY: newKey() once, newCorrelationId() once, enqueue once with
//       { kind, idempotencyKey, body: { orderId, lineId (verdict), qtyActual: scan.qty, batchNo,
//       expiryDate, expectedVersion (verdict), correlationId }, scannedAt: now().toISOString() }.
//       No skuCode in the body. refused / offline (checkScan rejected): none of newKey /
//       newCorrelationId / enqueue is called.
//     export function replayReceiveCommand(c: ReceiveLineCommand):
//       { headers: { 'Idempotency-Key': string }; body: ReceiveLineInput }   (pure, no enqueue)
//   apps/pda/src/features/receive/receive-screen.tsx
//     export interface ReceiveScreenProps { client: ReceiveClient; orderId: string; signal: ScanSignal;
//       newKey: () => string; newCorrelationId: () => string; now: () => Date; locale?: Locale;
//       enqueue?: (payload: unknown) => Promise<void> }   // default: offline-queue.ts enqueue
//     export function ReceiveScreen(props)
//     Inputs by label: receive.sku.label · receive.batch.label · receive.expiry.label ·
//       receive.qty.label; button name receive.submit; <h1> screen.receive.
//     testids: receive-screen · receive-sku · receive-batch · receive-expiry · receive-qty ·
//       receive-submit · receive-status (role=status, receive.accepted) · receive-error (role=alert,
//       receive.refused.<code>, or receive.offline.retry on a transport failure). A submit while a
//       scan is pending is ignored (one key per scan).
//   apps/pda/src/router.tsx: '/receive' -> <ReceiveScreen client={mockReceiveClient}
//     orderId={MOCK_ORDER_ID} .../> with browserScanSignal, crypto.randomUUID for both generators.
//   i18n keys: receive.sku.label · receive.batch.label · receive.expiry.label · receive.qty.label ·
//     receive.submit · receive.accepted · receive.refused.lineNotFound ·
//     receive.refused.skuClientMismatch · receive.refused.lineAlreadyReceived · receive.offline.retry ·
//     receive.refused.invalidInput · pda.queue.saveFailed
//     (each refusal / retry text states the worker's NEXT ACTION).

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from '@tanstack/react-router';
import { ReceiveLineInputSchema } from '@pg-eos/contracts/wms/receive-inbound';

import { ReceiveScreen } from '../../src/features/receive/receive-screen';
import type { ReceiveClient, ReceiveScanVerdict } from '../../src/features/receive/client';
import type { ScanSignal } from '../../src/features/receive/scan-signal';
import { ACCEPTED_SCAN_FIXTURE } from '../../src/features/receive/mock-client';
import { count, list } from '../../src/offline-queue';
import { createRouter } from '../../src/router';
import { t, SUPPORTED_LOCALES, type Locale } from '../../src/i18n/t';

const DB_NAME = 'pda-offline-queue';
const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const LINE_ID = '22222222-2222-4222-8222-222222222222';
const CORR_1 = '33333333-3333-4333-8333-333333333331';
const CORR_2 = '33333333-3333-4333-8333-333333333332';
const EXPECTED_VERSION = 3;
const SKU = 'SKU-100';
const BATCH = 'B2409-7';
const QTY = '10';
// doc 40 Part E S1: expiry 120 days from "today"; the clock is injected, today is fixed here.
const FIXED_NOW = new Date('2026-09-29T08:00:00.000Z');
const EXPIRY_120_DAYS = '2027-01-27';
const ONCE = 1;
const TWICE = 2;
const NEVER = 0;
const BAD_EXPIRY = '27/01/2027';
const EMPTY_QTY = '';
const REFUSAL_CODES = ['lineNotFound', 'skuClientMismatch', 'lineAlreadyReceived'] as const;
const ACCEPTED: ReceiveScanVerdict = { accepted: true, lineId: LINE_ID, expectedVersion: EXPECTED_VERSION };

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

function makeClient(checkScan: ReceiveClient['checkScan'] = vi.fn().mockResolvedValue(ACCEPTED)): ReceiveClient {
  return { checkScan };
}

function sequence(...values: string[]): () => string {
  const queue = [...values];
  return vi.fn(() => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error('test generator exhausted');
    }
    return next;
  });
}

interface Overrides {
  client?: ReceiveClient;
  signal?: ScanSignal;
  newKey?: () => string;
  newCorrelationId?: () => string;
  locale?: Locale;
  enqueue?: (payload: unknown) => Promise<void>;
}

function renderScreen(overrides: Overrides = {}) {
  const signal = overrides.signal ?? makeSignal();
  const newKey = overrides.newKey ?? sequence('key-1', 'key-2');
  const newCorrelationId = overrides.newCorrelationId ?? sequence(CORR_1, CORR_2);
  render(
    <ReceiveScreen
      client={overrides.client ?? makeClient()}
      orderId={ORDER_ID}
      signal={signal}
      newKey={newKey}
      newCorrelationId={newCorrelationId}
      now={() => FIXED_NOW}
      locale={overrides.locale ?? 'en'}
      {...(overrides.enqueue ? { enqueue: overrides.enqueue } : {})}
    />,
  );
  return { signal, newKey, newCorrelationId };
}

async function fill(
  user: ReturnType<typeof userEvent.setup>,
  locale: Locale,
  values: { sku: string; batch: string; expiry: string; qty: string },
): Promise<void> {
  const fields: Array<[Parameters<typeof t>[1], string]> = [
    ['receive.sku.label', values.sku],
    ['receive.batch.label', values.batch],
    ['receive.expiry.label', values.expiry],
    ['receive.qty.label', values.qty],
  ];
  for (const [key, value] of fields) {
    await user.clear(screen.getByLabelText(t(locale, key)));
    if (value.length > 0) {
      await user.type(screen.getByLabelText(t(locale, key)), value);
    }
  }
}

async function scanAll(
  user: ReturnType<typeof userEvent.setup>,
  locale: Locale,
  batch = BATCH,
  expiry = EXPIRY_120_DAYS,
  qty = QTY,
): Promise<void> {
  await fill(user, locale, { sku: SKU, batch, expiry, qty });
  await user.click(screen.getByRole('button', { name: t(locale, 'receive.submit') }));
}

beforeEach(async () => {
  await resetQueue();
});

describe('Scenario: Scanning SKU, batch and expiry enqueues one receive-line command with one Idempotency-Key', () => {
  it('enqueues exactly one receive-line command whose body is a valid ReceiveLineInput, with the key generated at scan time', async () => {
    const user = userEvent.setup();
    const { signal, newKey, newCorrelationId } = renderScreen();
    await scanAll(user, 'en');

    await waitFor(async () => expect(await count()).toBe(ONCE));
    const payload = (await list())[0]?.payload as { body: unknown };
    expect(payload).toEqual({
      kind: 'receive-line',
      idempotencyKey: 'key-1',
      body: {
        orderId: ORDER_ID,
        lineId: LINE_ID,
        qtyActual: QTY,
        batchNo: BATCH,
        expiryDate: EXPIRY_120_DAYS,
        expectedVersion: EXPECTED_VERSION,
        correlationId: CORR_1,
      },
      scannedAt: FIXED_NOW.toISOString(),
    });
    expect(ReceiveLineInputSchema.safeParse(payload.body).success).toBe(true);
    expect(newKey).toHaveBeenCalledTimes(ONCE);
    expect(newCorrelationId).toHaveBeenCalledTimes(ONCE);
    expect(signal.ok).toHaveBeenCalledTimes(ONCE);
    expect(signal.error).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(t('en', 'receive.accepted'));
  });

  it('two accepted scans enqueue two commands with two distinct Idempotency-Keys', async () => {
    const user = userEvent.setup();
    renderScreen();
    await scanAll(user, 'en');
    await waitFor(async () => expect(await count()).toBe(ONCE));
    await scanAll(user, 'en', 'B2409-8');
    await waitFor(async () => expect(await count()).toBe(TWICE));
    const keys = (await list()).map((entry) => (entry.payload as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys)).toEqual(new Set(['key-1', 'key-2']));
  });

  it('a double submit while checkScan is pending enqueues once and generates one key', async () => {
    const user = userEvent.setup();
    let release: (verdict: ReceiveScanVerdict) => void = () => undefined;
    const pending = new Promise<ReceiveScanVerdict>((resolve) => {
      release = resolve;
    });
    const { newKey, newCorrelationId } = renderScreen({ client: makeClient(vi.fn().mockReturnValue(pending)) });
    await fill(user, 'en', { sku: SKU, batch: BATCH, expiry: EXPIRY_120_DAYS, qty: QTY });
    const submit = screen.getByRole('button', { name: t('en', 'receive.submit') });
    await user.click(submit);
    await user.click(submit);
    release(ACCEPTED);
    await waitFor(async () => expect(await count()).toBe(ONCE));
    expect(newKey).toHaveBeenCalledTimes(ONCE);
    expect(newCorrelationId).toHaveBeenCalledTimes(ONCE);
  });
});

describe('Scenario: A refused scan plays the error signal and shows the next action, and nothing is enqueued', () => {
  it.each(REFUSAL_CODES)('refusal %s: error signal, its own next-action message, no key, nothing enqueued', async (code) => {
    const user = userEvent.setup();
    const client = makeClient(vi.fn().mockResolvedValue({ accepted: false, code }));
    const { signal, newKey, newCorrelationId } = renderScreen({ client });
    await scanAll(user, 'en');

    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', `receive.refused.${code}`));
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(signal.ok).not.toHaveBeenCalled();
    expect(newKey).not.toHaveBeenCalled();
    expect(newCorrelationId).not.toHaveBeenCalled();
    expect(await count()).toBe(NEVER);
  });
});

describe('Scenario: Invalid fields and a failed save are refused visibly (close review round 1)', () => {
  it.each([
    ['expiry 27/01/2027', BAD_EXPIRY, QTY],
    ['empty qty', EXPIRY_120_DAYS, EMPTY_QTY],
  ])('%s with an accepted verdict: error signal, invalidInput alert, no key, nothing enqueued', async (_label, expiry, qty) => {
    const user = userEvent.setup();
    const { signal, newKey, newCorrelationId } = renderScreen();
    await scanAll(user, 'en', BATCH, expiry, qty);

    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'receive.refused.invalidInput'));
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(signal.ok).not.toHaveBeenCalled();
    expect(newKey).not.toHaveBeenCalled();
    expect(newCorrelationId).not.toHaveBeenCalled();
    expect(await count()).toBe(NEVER);
  });

  it('a rejected enqueue shows the save-failed alert, plays the error signal once and never the ok signal', async () => {
    const user = userEvent.setup();
    const enqueue = vi.fn().mockRejectedValue(new Error('quota'));
    const { signal } = renderScreen({ enqueue });
    await scanAll(user, 'en');

    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'pda.queue.saveFailed'));
    expect(enqueue).toHaveBeenCalledTimes(ONCE);
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(signal.ok).not.toHaveBeenCalled();
  });
});

describe('Scenario: Offline, both screens keep working and the unsynced counter rises', () => {
  it('a checkScan rejection (transport failure) REFUSES the scan: error signal once, retry message, nothing enqueued, no key', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const { newKey, newCorrelationId } = renderScreen({ client: makeClient(vi.fn().mockRejectedValue(new Error('offline'))), signal });
    await scanAll(user, 'en');

    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'receive.offline.retry'));
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(signal.ok).not.toHaveBeenCalled();
    expect(newKey).not.toHaveBeenCalled();
    expect(newCorrelationId).not.toHaveBeenCalled();
    expect(await count()).toBe(NEVER);
  });

  it('route /receive: an accepted mock scan raises the shell badge to 1', async () => {
    const user = userEvent.setup();
    render(<RouterProvider router={createRouter('/receive')} />);
    await user.type(await screen.findByLabelText(t('ar', 'receive.sku.label')), ACCEPTED_SCAN_FIXTURE.skuCode);
    await user.type(screen.getByLabelText(t('ar', 'receive.batch.label')), ACCEPTED_SCAN_FIXTURE.batchNo);
    await user.type(screen.getByLabelText(t('ar', 'receive.expiry.label')), ACCEPTED_SCAN_FIXTURE.expiryDate);
    await user.type(screen.getByLabelText(t('ar', 'receive.qty.label')), ACCEPTED_SCAN_FIXTURE.qty);
    await user.click(screen.getByRole('button', { name: t('ar', 'receive.submit') }));
    await waitFor(() =>
      expect(screen.getByTestId('unsynced-queue-badge')).toHaveTextContent(t('ar', 'queue.unsynced', { count: ONCE })),
    );
  });
});

describe('Scenario: Every visible string resolves in ar, en, hi, ur, bn, am', () => {
  it.each(SUPPORTED_LOCALES)('locale %s: title, labels and submit resolve through t() and are non-empty', (locale) => {
    renderScreen({ locale });
    expect(screen.getByRole('heading', { name: t(locale, 'screen.receive') })).toBeInTheDocument();
    for (const key of ['receive.sku.label', 'receive.batch.label', 'receive.expiry.label', 'receive.qty.label'] as const) {
      expect(t(locale, key).length).toBeGreaterThan(0);
      expect(screen.getByLabelText(t(locale, key))).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: t(locale, 'receive.submit') })).toBeInTheDocument();
  });
});
