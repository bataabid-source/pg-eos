// WBS 2.16 part 3 — RED tests for the PDA load screen (scenarios 5, 6).
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
//   flight is ignored. Each screen is an XState v5 machine (`<feature>-machine.ts`, setup/createMachine, `submit`
//   actor `fromPromise<SubmitResult, …>` like receiveMachine; `REFUSAL_KEY` and `STATUS_KEY` exported records,
//   no if/switch).
//
//   LOAD — apps/pda/src/features/load/
//   client.ts: LoadScan { orderCode }; LoadRefusalCode = 'orderNotPacked' | 'orderNotFound'; LoadVerdict =
//     { accepted: true; orderId; expectedVersion } | { accepted: false; code }; LoadTransportError;
//     LoadClient { checkLoad(scan): Promise<LoadVerdict> }.
//   invalid = orderCode blank after trim (no contract field; checked before any client call or key).
//   load-queue.ts: LoadOrderCommand { kind: 'load-order'; idempotencyKey; body: LoadOrderInput; scannedAt },
//     LoadSubmitResult, submitLoadScan.
//   load-machine.ts: loadMachine, context { orderCode, errorKey }, events SCAN | SUBMIT, states ready -> submitting
//     -> loaded (final) | ready; REFUSAL_KEY orderNotPacked->load.refused.orderNotPacked,
//     orderNotFound->load.refused.orderNotFound; STATUS_KEY invalid->load.refused.invalidInput,
//     offline->load.offline.retry, failed->load.error.unexpected.
//   mock-client.ts: MOCK_ORDER_ID, MOCK_PACKED_ORDER_CODE = 'PCC-OUT-00002', MOCK_UNPACKED_ORDER_CODE =
//     'PCC-OUT-00003', MOCK_EXPECTED_VERSION = 7; mockLoadClient: packed code -> accepted; unpacked code ->
//     'orderNotPacked'; else 'orderNotFound' (the load mock starts from a packed order — brief decision 3).
//   load-screen.tsx: LoadScreenProps { client; signal; newKey; newCorrelationId; now; locale?; enqueue? }; root
//     data-testid="load-screen", <h1> screen.load; input labelled load.scan.label (data-testid="load-order");
//     button load.submit; status load.loaded.
//   router.tsx: '/load' -> <LoadScreen client={mockLoadClient} .../>.
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from '@tanstack/react-router';
import { LoadOrderInputSchema } from '@pg-eos/contracts/wms/process-outbound';

import { LoadScreen } from '../../src/features/load/load-screen';
import { LoadTransportError, type LoadClient, type LoadRefusalCode } from '../../src/features/load/client';
import {
  mockLoadClient,
  MOCK_ORDER_ID,
  MOCK_PACKED_ORDER_CODE,
  MOCK_UNPACKED_ORDER_CODE,
  MOCK_EXPECTED_VERSION,
} from '../../src/features/load/mock-client';
import type { ScanSignal } from '../../src/features/receive/scan-signal';
import { count, list } from '../../src/offline-queue';
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
const CORR = '33333333-3333-4333-8333-333333333331';
const EXPECTED_VERSION = 7;
const ORDER_CODE = 'PCC-OUT-00002';
const OTHER_ORDER_CODE = 'PCC-OUT-99999';
const FIXED_NOW = new Date('2026-09-29T08:00:00.000Z');
const ONCE = 1;
const TWICE = 2;
const NEVER = 0;
const RAW: Record<string, Record<string, string>> = { ar, en, hi, ur, bn, am };
const REFUSALS: ReadonlyArray<[LoadRefusalCode, string]> = [
  ['orderNotPacked', 'load.refused.orderNotPacked'],
  ['orderNotFound', 'load.refused.orderNotFound'],
];

function resetQueue(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

const makeSignal = (): ScanSignal => ({ ok: vi.fn(), error: vi.fn() });
const acceptingClient = (): LoadClient => ({
  checkLoad: vi.fn().mockResolvedValue({ accepted: true, orderId: ORDER_ID, expectedVersion: EXPECTED_VERSION }),
});

function renderScreen(
  client: LoadClient,
  signal: ScanSignal,
  newKey: () => string,
  opts: { locale?: Locale; enqueue?: (payload: unknown) => Promise<void> } = {},
) {
  const newCorrelationId = vi.fn(() => CORR);
  render(
    <LoadScreen
      client={client}
      signal={signal}
      newKey={newKey}
      newCorrelationId={newCorrelationId}
      now={() => FIXED_NOW}
      locale={opts.locale ?? 'en'}
      {...(opts.enqueue ? { enqueue: opts.enqueue } : {})}
    />,
  );
  return { newCorrelationId };
}

async function scanAndSubmit(user: ReturnType<typeof userEvent.setup>, code: string) {
  await user.type(screen.getByLabelText(t('en', 'load.scan.label')), code);
  await user.click(screen.getByRole('button', { name: t('en', 'load.submit') }));
}

beforeEach(async () => {
  await resetQueue();
});

describe('Scenario: Loading a packed order queues one LoadOrder write', () => {
  it('the mock client + the packed order code queues one load-order command that parses with LoadOrderInputSchema', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const newKey = vi.fn(() => 'key-load-1');
    const { newCorrelationId } = renderScreen(mockLoadClient, signal, newKey);
    await scanAndSubmit(user, MOCK_PACKED_ORDER_CODE);

    await waitFor(async () => expect(await count()).toBe(ONCE));
    const payload = (await list())[0]?.payload as { body: unknown };
    expect(payload).toEqual({
      kind: 'load-order',
      idempotencyKey: 'key-load-1',
      body: { orderId: MOCK_ORDER_ID, expectedVersion: MOCK_EXPECTED_VERSION, correlationId: CORR },
      scannedAt: FIXED_NOW.toISOString(),
    });
    expect(MOCK_EXPECTED_VERSION).toBe(EXPECTED_VERSION);
    expect(LoadOrderInputSchema.safeParse(payload.body).success).toBe(true);
    expect(newKey).toHaveBeenCalledTimes(ONCE);
    expect(newCorrelationId).toHaveBeenCalledTimes(ONCE);
    expect(signal.ok).toHaveBeenCalledTimes(ONCE);
    expect(signal.error).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(t('en', 'load.loaded'));
  });

  it('the mock client refuses an unpacked order as orderNotPacked, nothing enqueued, no key', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const newKey = vi.fn(() => 'never');
    renderScreen(mockLoadClient, signal, newKey);
    await scanAndSubmit(user, MOCK_UNPACKED_ORDER_CODE);
    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'load.refused.orderNotPacked'));
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(newKey).not.toHaveBeenCalled();
    expect(await count()).toBe(NEVER);
  });

  it('the mock client refuses an unknown order code as orderNotFound', async () => {
    const user = userEvent.setup();
    renderScreen(mockLoadClient, makeSignal(), () => 'never');
    await scanAndSubmit(user, OTHER_ORDER_CODE);
    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'load.refused.orderNotFound'));
    expect(await count()).toBe(NEVER);
  });

  it.each(REFUSALS)('refusal %s -> alert %s, error signal once, no key, nothing enqueued', async (code, key) => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const newKey = vi.fn(() => 'never');
    const client: LoadClient = { checkLoad: vi.fn().mockResolvedValue({ accepted: false, code }) };
    const { newCorrelationId } = renderScreen(client, signal, newKey);
    await scanAndSubmit(user, ORDER_CODE);
    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', key as Parameters<typeof t>[1]));
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(signal.ok).not.toHaveBeenCalled();
    expect(newKey).not.toHaveBeenCalled();
    expect(newCorrelationId).not.toHaveBeenCalled();
    expect(await count()).toBe(NEVER);
  });

  it('the client is asked with the scanned order code', async () => {
    const user = userEvent.setup();
    const client = acceptingClient();
    renderScreen(client, makeSignal(), () => 'k');
    await scanAndSubmit(user, ORDER_CODE);
    await waitFor(() => expect(client.checkLoad).toHaveBeenCalledWith({ orderCode: ORDER_CODE }));
  });

  it('a blank order code is invalid: alert, error signal once, no client call, no key, nothing enqueued', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const newKey = vi.fn(() => 'never');
    const client = acceptingClient();
    renderScreen(client, signal, newKey);
    await user.click(screen.getByRole('button', { name: t('en', 'load.submit') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'load.refused.invalidInput'));
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(client.checkLoad).not.toHaveBeenCalled();
    expect(newKey).not.toHaveBeenCalled();
    expect(await count()).toBe(NEVER);
  });

  it('a double submit click enqueues once and generates one key', async () => {
    const user = userEvent.setup();
    const newKey = vi.fn(() => 'key-load-1');
    renderScreen(acceptingClient(), makeSignal(), newKey);
    await user.type(screen.getByLabelText(t('en', 'load.scan.label')), ORDER_CODE);
    const submit = screen.getByRole('button', { name: t('en', 'load.submit') });
    await user.click(submit);
    await user.click(submit);
    await waitFor(async () => expect(await count()).toBe(ONCE));
    expect(newKey).toHaveBeenCalledTimes(ONCE);
  });

  it('a submit while the verdict is in flight is ignored', async () => {
    const user = userEvent.setup();
    let release: (v: { accepted: true; orderId: string; expectedVersion: number }) => void = () => undefined;
    const checkLoad = vi.fn(
      () => new Promise<{ accepted: true; orderId: string; expectedVersion: number }>((resolve) => (release = resolve)),
    );
    renderScreen({ checkLoad }, makeSignal(), () => 'key-load-1');
    await user.type(screen.getByLabelText(t('en', 'load.scan.label')), ORDER_CODE);
    const submit = screen.getByRole('button', { name: t('en', 'load.submit') });
    await user.click(submit);
    await user.click(submit);
    expect(checkLoad).toHaveBeenCalledTimes(ONCE);
    release({ accepted: true, orderId: ORDER_ID, expectedVersion: EXPECTED_VERSION });
    await waitFor(async () => expect(await count()).toBe(ONCE));
  });

  it('a LoadTransportError shows the offline retry message; nothing enqueued, no key', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const newKey = vi.fn(() => 'never');
    renderScreen({ checkLoad: vi.fn().mockRejectedValue(new LoadTransportError('down')) }, signal, newKey);
    await scanAndSubmit(user, ORDER_CODE);
    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'load.offline.retry'));
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(newKey).not.toHaveBeenCalled();
    expect(await count()).toBe(NEVER);
  });

  it('any other client rejection shows the unexpected-error message', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    renderScreen({ checkLoad: vi.fn().mockRejectedValue(new Error('boom')) }, signal, () => 'never');
    await scanAndSubmit(user, ORDER_CODE);
    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'load.error.unexpected'));
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(await count()).toBe(NEVER);
  });

  it('a rejected enqueue shows the save-failed alert, error signal once, never ok; a second submit calls enqueue again', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const enqueue = vi.fn().mockRejectedValueOnce(new Error('quota')).mockResolvedValue(undefined);
    renderScreen(acceptingClient(), signal, () => 'key-load-1', { enqueue });
    await scanAndSubmit(user, ORDER_CODE);
    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'pda.queue.saveFailed'));
    expect(enqueue).toHaveBeenCalledTimes(ONCE);
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(signal.ok).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: t('en', 'load.submit') }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(TWICE));
  });
});

describe('Scenario: /load renders in all six locales, RTL for ar and ur', () => {
  it('renders the root, the h1, the labelled input and the submit button', () => {
    renderScreen(acceptingClient(), makeSignal(), () => 'k');
    expect(screen.getByTestId('load-screen')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(t('en', 'screen.load'));
    expect(screen.getByTestId('load-order')).toBe(screen.getByLabelText(t('en', 'load.scan.label')));
  });

  it.each(SUPPORTED_LOCALES)('locale %s: h1, label and button resolve; direction matches', (locale) => {
    renderScreen(acceptingClient(), makeSignal(), () => 'k', { locale });
    const title = RAW[locale]?.['screen.load'];
    expect(title).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(title as string);
    expect(screen.getByLabelText(t(locale, 'load.scan.label'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t(locale, 'load.submit') })).toBeInTheDocument();
    expect(directionOf(locale)).toBe(locale === 'ar' || locale === 'ur' ? 'rtl' : 'ltr');
  });

  it('every load key is a non-empty string in the raw file of all six locales', () => {
    const keys = Object.keys(ar).filter((k) => k.startsWith('load.'));
    expect(keys.length).toBeGreaterThan(NEVER);
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of keys) {
        expect((RAW[locale]?.[key] ?? '').length).toBeGreaterThan(NEVER);
      }
    }
  });
});

describe('Scenario: /load route in all six locales, RTL for ar and ur (shell selector)', () => {
  it.each(SUPPORTED_LOCALES)('route /load at locale %s: shell dir/lang and the h1 equal the locale raw value', async (locale) => {
    const user = userEvent.setup();
    render(<RouterProvider router={createRouter('/load')} />);
    expect(await screen.findByTestId('load-screen')).toBeInTheDocument();
    await user.selectOptions(screen.getByTestId('locale-select'), locale);
    expect(document.documentElement.dir).toBe(locale === 'ar' || locale === 'ur' ? 'rtl' : 'ltr');
    expect(document.documentElement.lang).toBe(locale);
    const title = RAW[locale]?.['screen.load'];
    expect(title).toBeTruthy();
    expect(within(await screen.findByTestId('load-screen')).getByRole('heading', { level: 1 })).toHaveTextContent(
      title as string,
    );
  });
});
