// WBS 2.16 part 3 — RED tests for the PDA check screen (scenarios 3, 4, 6). Checker != picker (doc 40 §D4).
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
//   CHECK — apps/pda/src/features/check/
//   client.ts: CheckScan { orderCode; checkerId }; CheckRefusalCode = 'selfCheckNotAllowed' | 'orderNotFound';
//     CheckVerdict = { accepted: true; orderId; expectedVersion } | { accepted: false; code }; CheckTransportError;
//     CheckClient { checkOrder(scan: CheckScan): Promise<CheckVerdict> }.
//   invalid = orderCode blank after trim (no contract field; checked before any client call or key).
//   check-queue.ts: CheckOrderCommand { kind: 'check-order'; idempotencyKey; body: CheckOrderInput; scannedAt };
//     CheckSubmitResult (accepted/refused/offline/failed/invalid — invalid when orderCode is blank);
//     submitCheckScan(deps, scan); body { orderId: verdict.orderId, expectedVersion: verdict.expectedVersion,
//     correlationId }.
//   check-machine.ts: checkMachine, input { checkerId }, context { checkerId, orderCode, errorKey }, events
//     SCAN{value} | SUBMIT, states ready -> submitting -> checked (final) | ready + errorKey; REFUSAL_KEY
//     selfCheckNotAllowed->check.refused.selfCheckNotAllowed, orderNotFound->check.refused.orderNotFound;
//     STATUS_KEY invalid->check.refused.invalidInput, offline->check.offline.retry, failed->check.error.unexpected.
//   mock-client.ts: MOCK_ORDER_ID, MOCK_ORDER_CODE = 'PCC-OUT-00001', MOCK_EXPECTED_VERSION = 5, MOCK_PICKER_ID
//     (uuid), MOCK_CHECKER_ID (another uuid), MOCK_PICKER_IDS: readonly string[] = [MOCK_PICKER_ID];
//     mockCheckClient: orderCode != MOCK_ORDER_CODE -> 'orderNotFound'; checkerId in MOCK_PICKER_IDS ->
//     'selfCheckNotAllowed' (reproduces the server's SelfCheckNotAllowedError, i18nKey
//     wms.outbound.check.selfCheckNotAllowed — the screen does not re-implement the rule); else accepted.
//   check-screen.tsx: CheckScreenProps { client; checkerId; signal; newKey; newCorrelationId; now; locale?;
//     enqueue? }; root data-testid="check-screen", <h1> screen.check; input labelled check.scan.label
//     (data-testid="check-order"); button check.submit; status check.checked.
//   router.tsx: '/check' -> <CheckScreen client={mockCheckClient} checkerId={MOCK_CHECKER_ID} .../>.
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from '@tanstack/react-router';
import { CheckOrderInputSchema } from '@pg-eos/contracts/wms/process-outbound';

import { CheckScreen } from '../../src/features/check/check-screen';
import { CheckTransportError, type CheckClient, type CheckRefusalCode } from '../../src/features/check/client';
import {
  mockCheckClient,
  MOCK_ORDER_ID,
  MOCK_ORDER_CODE,
  MOCK_EXPECTED_VERSION,
  MOCK_PICKER_ID,
  MOCK_CHECKER_ID,
} from '../../src/features/check/mock-client';
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
const CHECKER_ID = '44444444-4444-4444-8444-444444444444';
const CORR = '33333333-3333-4333-8333-333333333331';
const EXPECTED_VERSION = 5;
const ORDER_CODE = 'PCC-OUT-00001';
const OTHER_ORDER_CODE = 'PCC-OUT-99999';
const FIXED_NOW = new Date('2026-09-29T08:00:00.000Z');
const ONCE = 1;
const TWICE = 2;
const NEVER = 0;
const RAW: Record<string, Record<string, string>> = { ar, en, hi, ur, bn, am };
const REFUSALS: ReadonlyArray<[CheckRefusalCode, string]> = [
  ['selfCheckNotAllowed', 'check.refused.selfCheckNotAllowed'],
  ['orderNotFound', 'check.refused.orderNotFound'],
];

function resetQueue(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

const makeSignal = (): ScanSignal => ({ ok: vi.fn(), error: vi.fn() });
const acceptingClient = (): CheckClient => ({
  checkOrder: vi.fn().mockResolvedValue({ accepted: true, orderId: ORDER_ID, expectedVersion: EXPECTED_VERSION }),
});

function renderScreen(
  client: CheckClient,
  signal: ScanSignal,
  newKey: () => string,
  opts: { locale?: Locale; enqueue?: (payload: unknown) => Promise<void>; checkerId?: string } = {},
) {
  const newCorrelationId = vi.fn(() => CORR);
  render(
    <CheckScreen
      client={client}
      checkerId={opts.checkerId ?? CHECKER_ID}
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
  await user.type(screen.getByLabelText(t('en', 'check.scan.label')), code);
  await user.click(screen.getByRole('button', { name: t('en', 'check.submit') }));
}

beforeEach(async () => {
  await resetQueue();
});

describe('Scenario: The user who picked the order is refused on the check screen with the next action', () => {
  it('the mock client + checkerId = MOCK_PICKER_ID: alert selfCheckNotAllowed, error signal once, nothing enqueued, no key', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const newKey = vi.fn(() => 'never');
    const { newCorrelationId } = renderScreen(mockCheckClient, signal, newKey, { checkerId: MOCK_PICKER_ID });
    await scanAndSubmit(user, MOCK_ORDER_CODE);

    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'check.refused.selfCheckNotAllowed'));
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(signal.ok).not.toHaveBeenCalled();
    expect(newKey).not.toHaveBeenCalled();
    expect(newCorrelationId).not.toHaveBeenCalled();
    expect(await count()).toBe(NEVER);
  });

  it('the screen does not re-implement the rule: a client accepting the picker is honoured', async () => {
    const user = userEvent.setup();
    renderScreen(acceptingClient(), makeSignal(), () => 'key-x', { checkerId: MOCK_PICKER_ID });
    await scanAndSubmit(user, ORDER_CODE);
    await waitFor(async () => expect(await count()).toBe(ONCE));
  });

  it.each(REFUSALS)('refusal %s -> alert %s, error signal once, no key, nothing enqueued', async (code, key) => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const newKey = vi.fn(() => 'never');
    const client: CheckClient = { checkOrder: vi.fn().mockResolvedValue({ accepted: false, code }) };
    renderScreen(client, signal, newKey);
    await scanAndSubmit(user, ORDER_CODE);
    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', key as Parameters<typeof t>[1]));
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(newKey).not.toHaveBeenCalled();
    expect(await count()).toBe(NEVER);
  });

  it('the mock client refuses an unknown order code as orderNotFound', async () => {
    const user = userEvent.setup();
    renderScreen(mockCheckClient, makeSignal(), () => 'never', { checkerId: MOCK_CHECKER_ID });
    await scanAndSubmit(user, OTHER_ORDER_CODE);
    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'check.refused.orderNotFound'));
    expect(await count()).toBe(NEVER);
  });
});

describe('Scenario: A user who did not pick the order checks it and one CheckOrder write is queued', () => {
  it('the mock client + checkerId = MOCK_CHECKER_ID queues one check-order command that parses with CheckOrderInputSchema', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const newKey = vi.fn(() => 'key-check-1');
    const { newCorrelationId } = renderScreen(mockCheckClient, signal, newKey, { checkerId: MOCK_CHECKER_ID });
    await scanAndSubmit(user, MOCK_ORDER_CODE);

    await waitFor(async () => expect(await count()).toBe(ONCE));
    const payload = (await list())[0]?.payload as { body: unknown };
    expect(payload).toEqual({
      kind: 'check-order',
      idempotencyKey: 'key-check-1',
      body: { orderId: MOCK_ORDER_ID, expectedVersion: MOCK_EXPECTED_VERSION, correlationId: CORR },
      scannedAt: FIXED_NOW.toISOString(),
    });
    expect(MOCK_EXPECTED_VERSION).toBe(EXPECTED_VERSION);
    expect(CheckOrderInputSchema.safeParse(payload.body).success).toBe(true);
    expect(newKey).toHaveBeenCalledTimes(ONCE);
    expect(newCorrelationId).toHaveBeenCalledTimes(ONCE);
    expect(signal.ok).toHaveBeenCalledTimes(ONCE);
    expect(signal.error).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(t('en', 'check.checked'));
  });

  it('the client is asked with the scanned order code and the checker id', async () => {
    const user = userEvent.setup();
    const client = acceptingClient();
    renderScreen(client, makeSignal(), () => 'k');
    await scanAndSubmit(user, ORDER_CODE);
    await waitFor(() => expect(client.checkOrder).toHaveBeenCalledWith({ orderCode: ORDER_CODE, checkerId: CHECKER_ID }));
  });

  it('a blank order code is invalid: alert, error signal once, no client call, no key, nothing enqueued', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const newKey = vi.fn(() => 'never');
    const client = acceptingClient();
    renderScreen(client, signal, newKey);
    await user.click(screen.getByRole('button', { name: t('en', 'check.submit') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'check.refused.invalidInput'));
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(client.checkOrder).not.toHaveBeenCalled();
    expect(newKey).not.toHaveBeenCalled();
    expect(await count()).toBe(NEVER);
  });

  it('a double submit click enqueues once and generates one key', async () => {
    const user = userEvent.setup();
    const newKey = vi.fn(() => 'key-check-1');
    renderScreen(acceptingClient(), makeSignal(), newKey);
    await user.type(screen.getByLabelText(t('en', 'check.scan.label')), ORDER_CODE);
    const submit = screen.getByRole('button', { name: t('en', 'check.submit') });
    await user.click(submit);
    await user.click(submit);
    await waitFor(async () => expect(await count()).toBe(ONCE));
    expect(newKey).toHaveBeenCalledTimes(ONCE);
  });

  it('a submit while the verdict is in flight is ignored', async () => {
    const user = userEvent.setup();
    let release: (v: { accepted: true; orderId: string; expectedVersion: number }) => void = () => undefined;
    const checkOrder = vi.fn(
      () => new Promise<{ accepted: true; orderId: string; expectedVersion: number }>((resolve) => (release = resolve)),
    );
    renderScreen({ checkOrder }, makeSignal(), () => 'key-check-1');
    await user.type(screen.getByLabelText(t('en', 'check.scan.label')), ORDER_CODE);
    const submit = screen.getByRole('button', { name: t('en', 'check.submit') });
    await user.click(submit);
    await user.click(submit);
    expect(checkOrder).toHaveBeenCalledTimes(ONCE);
    release({ accepted: true, orderId: ORDER_ID, expectedVersion: EXPECTED_VERSION });
    await waitFor(async () => expect(await count()).toBe(ONCE));
  });

  it('a CheckTransportError shows the offline retry message; nothing enqueued, no key', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const newKey = vi.fn(() => 'never');
    renderScreen({ checkOrder: vi.fn().mockRejectedValue(new CheckTransportError('down')) }, signal, newKey);
    await scanAndSubmit(user, ORDER_CODE);
    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'check.offline.retry'));
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(newKey).not.toHaveBeenCalled();
    expect(await count()).toBe(NEVER);
  });

  it('any other client rejection shows the unexpected-error message', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    renderScreen({ checkOrder: vi.fn().mockRejectedValue(new Error('boom')) }, signal, () => 'never');
    await scanAndSubmit(user, ORDER_CODE);
    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'check.error.unexpected'));
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(await count()).toBe(NEVER);
  });

  it('a rejected enqueue shows the save-failed alert, error signal once, never ok; a second submit calls enqueue again', async () => {
    const user = userEvent.setup();
    const signal = makeSignal();
    const enqueue = vi.fn().mockRejectedValueOnce(new Error('quota')).mockResolvedValue(undefined);
    renderScreen(acceptingClient(), signal, () => 'key-check-1', { enqueue });
    await scanAndSubmit(user, ORDER_CODE);
    expect(await screen.findByRole('alert')).toHaveTextContent(t('en', 'pda.queue.saveFailed'));
    expect(enqueue).toHaveBeenCalledTimes(ONCE);
    expect(signal.error).toHaveBeenCalledTimes(ONCE);
    expect(signal.ok).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: t('en', 'check.submit') }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(TWICE));
  });
});

describe('Scenario: /check renders in all six locales, RTL for ar and ur', () => {
  it('renders the root, the h1, the labelled input and the submit button', () => {
    renderScreen(acceptingClient(), makeSignal(), () => 'k');
    expect(screen.getByTestId('check-screen')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(t('en', 'screen.check'));
    expect(screen.getByTestId('check-order')).toBe(screen.getByLabelText(t('en', 'check.scan.label')));
  });

  it.each(SUPPORTED_LOCALES)('locale %s: h1, label and button resolve; direction matches', (locale) => {
    renderScreen(acceptingClient(), makeSignal(), () => 'k', { locale });
    const title = RAW[locale]?.['screen.check'];
    expect(title).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(title as string);
    expect(screen.getByLabelText(t(locale, 'check.scan.label'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t(locale, 'check.submit') })).toBeInTheDocument();
    expect(directionOf(locale)).toBe(locale === 'ar' || locale === 'ur' ? 'rtl' : 'ltr');
  });

  it('every check key is a non-empty string in the raw file of all six locales', () => {
    const keys = Object.keys(ar).filter((k) => k.startsWith('check.'));
    expect(keys.length).toBeGreaterThan(NEVER);
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of keys) {
        expect((RAW[locale]?.[key] ?? '').length).toBeGreaterThan(NEVER);
      }
    }
  });
});

describe('Scenario: /check route in all six locales, RTL for ar and ur (shell selector)', () => {
  it.each(SUPPORTED_LOCALES)('route /check at locale %s: shell dir/lang and the h1 equal the locale raw value', async (locale) => {
    const user = userEvent.setup();
    render(<RouterProvider router={createRouter('/check')} />);
    expect(await screen.findByTestId('check-screen')).toBeInTheDocument();
    await user.selectOptions(screen.getByTestId('locale-select'), locale);
    expect(document.documentElement.dir).toBe(locale === 'ar' || locale === 'ur' ? 'rtl' : 'ltr');
    expect(document.documentElement.lang).toBe(locale);
    const title = RAW[locale]?.['screen.check'];
    expect(title).toBeTruthy();
    expect(within(await screen.findByTestId('check-screen')).getByRole('heading', { level: 1 })).toHaveTextContent(
      title as string,
    );
  });
});
