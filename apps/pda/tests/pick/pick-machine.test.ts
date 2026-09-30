// WBS 2.16 part 3 — pickMachine (XState v5) behind the pick screen.
// BUILD CONTRACT: apps/pda/src/features/pick/pick-machine.ts exports `pickMachine`, `REFUSAL_KEY`, `STATUS_KEY`;
// input { orderId, lineId }; context { orderId, lineId, fields: { locationCode, qtyActual, varianceReason }, errorKey };
// events FIELD { name, value } | SUBMIT; actor submitScan: fromPromise<PickSubmitResult, PickScan>; actions signalOk,
// signalError; states ready -> submitting -> picked (final) | ready (+ errorKey).
import { createActor, fromPromise, waitFor } from 'xstate';
import { describe, expect, it, vi } from 'vitest';

import type { PickRefusalCode, PickScan } from '../../src/features/pick/client';
import type { PickSubmitResult } from '../../src/features/pick/pick-queue';
import { pickMachine, REFUSAL_KEY, STATUS_KEY } from '../../src/features/pick/pick-machine';

const ORDER_ID = 'order-1';
const LINE_ID = 'line-1';
const EXPECTED_VERSION = 3;
const ONCE = 1;
const TWICE = 2;
const FIELDS = { locationCode: 'A-01-01', qtyActual: '10', varianceReason: '' } as const;
const EMPTY_FIELDS = { locationCode: '', qtyActual: '', varianceReason: '' };
const REFUSAL_CODES: PickRefusalCode[] = [
  'lineNotFound',
  'lineAlreadyPicked',
  'qtyExceedsReserved',
  'lineNotReserved',
  'varianceReasonRequired',
];
const ACCEPTED: PickSubmitResult = {
  status: 'accepted',
  command: {
    kind: 'pick-line',
    idempotencyKey: 'k',
    body: { orderId: ORDER_ID, lineId: LINE_ID, expectedVersion: EXPECTED_VERSION, qtyActual: '10', correlationId: 'c' },
    scannedAt: '2030-01-01T00:00:00.000Z',
  },
};

function setup(impl: (scan: PickScan) => Promise<PickSubmitResult>) {
  const submitScan = vi.fn(impl);
  const signalOk = vi.fn();
  const signalError = vi.fn();
  const actor = createActor(
    pickMachine.provide({
      actors: { submitScan: fromPromise(async ({ input }: { input: PickScan }) => submitScan(input)) },
      actions: { signalOk, signalError },
    }),
    { input: { orderId: ORDER_ID, lineId: LINE_ID } },
  );
  actor.start();
  return { actor, submitScan, signalOk, signalError };
}

function fill(actor: ReturnType<typeof setup>['actor']) {
  for (const [name, value] of Object.entries(FIELDS)) {
    actor.send({ type: 'FIELD', name: name as keyof typeof FIELDS, value });
  }
}

describe('pickMachine', () => {
  it('starts ready with empty fields and no error', () => {
    const { actor } = setup(async () => ACCEPTED);
    expect(actor.getSnapshot().value).toBe('ready');
    expect(actor.getSnapshot().context).toEqual({
      orderId: ORDER_ID,
      lineId: LINE_ID,
      fields: EMPTY_FIELDS,
      errorKey: null,
    });
  });

  it('FIELD updates the named field only', () => {
    const { actor } = setup(async () => ACCEPTED);
    actor.send({ type: 'FIELD', name: 'qtyActual', value: '4' });
    expect(actor.getSnapshot().context.fields).toEqual({ ...EMPTY_FIELDS, qtyActual: '4' });
  });

  it('SUBMIT invokes submitScan with orderId, lineId and the fields', async () => {
    const { actor, submitScan } = setup(async () => ACCEPTED);
    fill(actor);
    actor.send({ type: 'SUBMIT' });
    expect(actor.getSnapshot().value).toBe('submitting');
    expect(submitScan).toHaveBeenCalledWith({ orderId: ORDER_ID, lineId: LINE_ID, ...FIELDS });
    await waitFor(actor, (s) => s.status === 'done');
  });

  it('accepted -> picked (final), signalOk once, fields cleared, no error', async () => {
    const { actor, signalOk, signalError } = setup(async () => ACCEPTED);
    fill(actor);
    actor.send({ type: 'SUBMIT' });
    const snap = await waitFor(actor, (s) => s.value === 'picked');
    expect(snap.status).toBe('done');
    expect(snap.context.fields).toEqual(EMPTY_FIELDS);
    expect(snap.context.errorKey).toBeNull();
    expect(signalOk).toHaveBeenCalledTimes(ONCE);
    expect(signalError).not.toHaveBeenCalled();
  });

  it.each(REFUSAL_CODES)('refused %s -> ready, errorKey = REFUSAL_KEY, signalError once, fields kept', async (code) => {
    const { actor, signalOk, signalError } = setup(async () => ({ status: 'refused', code }));
    fill(actor);
    actor.send({ type: 'SUBMIT' });
    const snap = await waitFor(actor, (s) => s.value === 'ready');
    expect(snap.context.errorKey).toBe(REFUSAL_KEY[code]);
    expect(snap.context.fields).toEqual(FIELDS);
    expect(signalError).toHaveBeenCalledTimes(ONCE);
    expect(signalOk).not.toHaveBeenCalled();
  });

  it('REFUSAL_KEY and STATUS_KEY carry the contract keys', () => {
    expect(REFUSAL_KEY).toEqual({
      lineNotFound: 'pick.refused.lineNotFound',
      lineAlreadyPicked: 'pick.refused.lineAlreadyPicked',
      qtyExceedsReserved: 'pick.refused.qtyExceedsReserved',
      lineNotReserved: 'pick.refused.lineNotReserved',
      varianceReasonRequired: 'pick.refused.varianceReasonRequired',
    });
    expect(STATUS_KEY).toEqual({
      invalid: 'pick.refused.invalidInput',
      offline: 'pick.offline.retry',
      failed: 'pick.error.unexpected',
    });
  });

  it.each(['invalid', 'offline', 'failed'] as const)('status %s -> ready with STATUS_KEY, signalError once', async (status) => {
    const { actor, signalError } = setup(async () => ({ status }));
    fill(actor);
    actor.send({ type: 'SUBMIT' });
    const snap = await waitFor(actor, (s) => s.value === 'ready');
    expect(snap.context.errorKey).toBe(STATUS_KEY[status]);
    expect(signalError).toHaveBeenCalledTimes(ONCE);
  });

  it('actor rejecting -> ready, errorKey pda.queue.saveFailed, signalError once', async () => {
    const { actor, signalError } = setup(async () => {
      throw new Error('quota');
    });
    fill(actor);
    actor.send({ type: 'SUBMIT' });
    const snap = await waitFor(actor, (s) => s.value === 'ready');
    expect(snap.context.errorKey).toBe('pda.queue.saveFailed');
    expect(signalError).toHaveBeenCalledTimes(ONCE);
  });

  it('a SUBMIT while submitting is ignored (one invocation)', async () => {
    const { actor, submitScan } = setup(async () => ACCEPTED);
    fill(actor);
    actor.send({ type: 'SUBMIT' });
    actor.send({ type: 'SUBMIT' });
    await waitFor(actor, (s) => s.status === 'done');
    expect(submitScan).toHaveBeenCalledTimes(ONCE);
  });

  it('after a refusal a second SUBMIT invokes the actor again', async () => {
    const submit = vi
      .fn<(scan: PickScan) => Promise<PickSubmitResult>>()
      .mockResolvedValueOnce({ status: 'refused', code: 'lineNotFound' })
      .mockResolvedValue(ACCEPTED);
    const { actor } = setup(submit);
    fill(actor);
    actor.send({ type: 'SUBMIT' });
    await waitFor(actor, (s) => s.value === 'ready' && s.context.errorKey !== null);
    actor.send({ type: 'SUBMIT' });
    await waitFor(actor, (s) => s.value === 'picked');
    expect(submit).toHaveBeenCalledTimes(TWICE);
  });
});
