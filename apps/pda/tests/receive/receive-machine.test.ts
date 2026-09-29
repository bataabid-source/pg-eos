// WBS 2.16 part 2 — receiveMachine (XState v5) behind the receive screen.
import { createActor, fromPromise, waitFor } from 'xstate';
import { describe, expect, it, vi } from 'vitest';

import type { ReceiveScan } from '../../src/features/receive/client';
import type { ReceiveRefusalCode } from '../../src/features/receive/client';
import type { SubmitResult } from '../../src/features/receive/scan-queue';
import { receiveMachine } from '../../src/features/receive/receive-machine';

const ORDER_ID = 'order-1';
const ONCE = 1;
const FIELDS = { skuCode: 'SKU-1', batchNo: 'B-1', expiryDate: '2030-01-31', qty: '5' } as const;
const EMPTY_FIELDS = { skuCode: '', batchNo: '', expiryDate: '', qty: '' };
const ACCEPTED: SubmitResult = {
  status: 'accepted',
  command: {
    kind: 'receive-line',
    idempotencyKey: 'k',
    body: {
      orderId: ORDER_ID,
      lineId: 'l',
      qtyActual: '5',
      batchNo: 'B-1',
      expiryDate: '2030-01-31',
      expectedVersion: 1,
      correlationId: 'c',
    },
    scannedAt: '2030-01-01T00:00:00.000Z',
  },
};

function setup(impl: (scan: ReceiveScan) => Promise<SubmitResult>) {
  const submitScan = vi.fn(impl);
  const signalOk = vi.fn();
  const signalError = vi.fn();
  const actor = createActor(
    receiveMachine.provide({
      actors: { submitScan: fromPromise(async ({ input }: { input: ReceiveScan }) => submitScan(input)) },
      actions: { signalOk, signalError },
    }),
    { input: { orderId: ORDER_ID } },
  );
  actor.start();
  return { actor, submitScan, signalOk, signalError };
}

function fill(actor: ReturnType<typeof setup>['actor']) {
  for (const [name, value] of Object.entries(FIELDS)) {
    actor.send({ type: 'FIELD', name: name as keyof typeof FIELDS, value });
  }
}

describe('receiveMachine', () => {
  it('starts idle with empty fields and no error', () => {
    const { actor } = setup(async () => ACCEPTED);
    expect(actor.getSnapshot().value).toBe('idle');
    expect(actor.getSnapshot().context).toEqual({ orderId: ORDER_ID, fields: EMPTY_FIELDS, errorKey: null });
  });

  it('FIELD updates the named field', () => {
    const { actor } = setup(async () => ACCEPTED);
    actor.send({ type: 'FIELD', name: 'batchNo', value: 'B-9' });
    expect(actor.getSnapshot().context.fields.batchNo).toBe('B-9');
  });

  it('accepted clears all fields in the same transition, errorKey null, signalOk once', async () => {
    const { actor, submitScan, signalOk, signalError } = setup(async () => ACCEPTED);
    fill(actor);
    actor.send({ type: 'SUBMIT' });
    expect(actor.getSnapshot().value).toBe('submitting');
    expect(submitScan).toHaveBeenCalledWith({ orderId: ORDER_ID, ...FIELDS });
    const snap = await waitFor(actor, (s) => s.value === 'accepted');
    expect(snap.context.fields).toEqual(EMPTY_FIELDS);
    expect(snap.context.errorKey).toBeNull();
    expect(signalOk).toHaveBeenCalledTimes(ONCE);
    expect(signalError).not.toHaveBeenCalled();
  });

  it('ignores FIELD while submitting and does not invoke submitScan twice on a second SUBMIT', async () => {
    let release: (r: SubmitResult) => void = () => undefined;
    const { actor, submitScan } = setup(() => new Promise<SubmitResult>((resolve) => (release = resolve)));
    fill(actor);
    actor.send({ type: 'SUBMIT' });
    actor.send({ type: 'SUBMIT' });
    actor.send({ type: 'FIELD', name: 'qty', value: '99' });
    expect(submitScan).toHaveBeenCalledTimes(ONCE);
    expect(actor.getSnapshot().context.fields.qty).toBe(FIELDS.qty);
    release(ACCEPTED);
    await waitFor(actor, (s) => s.value === 'accepted');
    expect(submitScan).toHaveBeenCalledTimes(ONCE);
  });

  const REFUSALS: ReadonlyArray<[ReceiveRefusalCode, string]> = [
    ['lineNotFound', 'receive.refused.lineNotFound'],
    ['skuClientMismatch', 'receive.refused.skuClientMismatch'],
    ['lineAlreadyReceived', 'receive.refused.lineAlreadyReceived'],
  ];
  it.each(REFUSALS)('refused %s -> rejected with %s, fields kept, signalError once', async (code, key) => {
    const { actor, signalOk, signalError } = setup(async () => ({ status: 'refused', code }));
    fill(actor);
    actor.send({ type: 'SUBMIT' });
    const snap = await waitFor(actor, (s) => s.value === 'rejected');
    expect(snap.context.errorKey).toBe(key);
    expect(snap.context.fields).toEqual(FIELDS);
    expect(signalError).toHaveBeenCalledTimes(ONCE);
    expect(signalOk).not.toHaveBeenCalled();
  });

  const STATUSES: ReadonlyArray<['invalid' | 'offline' | 'failed', string]> = [
    ['invalid', 'receive.refused.invalidInput'],
    ['offline', 'receive.offline.retry'],
    ['failed', 'receive.error.unexpected'],
  ];
  it.each(STATUSES)('%s -> rejected with %s, fields kept, signalError once', async (status, key) => {
    const { actor, signalError } = setup(async () => ({ status }));
    fill(actor);
    actor.send({ type: 'SUBMIT' });
    const snap = await waitFor(actor, (s) => s.value === 'rejected');
    expect(snap.context.errorKey).toBe(key);
    expect(snap.context.fields).toEqual(FIELDS);
    expect(signalError).toHaveBeenCalledTimes(ONCE);
  });

  it('submitScan rejecting -> rejected with pda.queue.saveFailed, signalError once, never signalOk', async () => {
    const { actor, signalOk, signalError } = setup(async () => {
      throw new Error('storage');
    });
    fill(actor);
    actor.send({ type: 'SUBMIT' });
    const snap = await waitFor(actor, (s) => s.value === 'rejected');
    expect(snap.context.errorKey).toBe('pda.queue.saveFailed');
    expect(signalError).toHaveBeenCalledTimes(ONCE);
    expect(signalOk).not.toHaveBeenCalled();
  });

  it('can edit fields and resubmit from rejected', async () => {
    const results: SubmitResult[] = [{ status: 'invalid' }, ACCEPTED];
    const { actor, submitScan } = setup(async () => results.shift() ?? ACCEPTED);
    fill(actor);
    actor.send({ type: 'SUBMIT' });
    await waitFor(actor, (s) => s.value === 'rejected');
    actor.send({ type: 'FIELD', name: 'qty', value: '6' });
    expect(actor.getSnapshot().context.fields.qty).toBe('6');
    actor.send({ type: 'SUBMIT' });
    await waitFor(actor, (s) => s.value === 'accepted');
    expect(submitScan).toHaveBeenCalledTimes(2);
  });

  it('SUBMIT right after accepted resubmits empty strings, never the old values', async () => {
    const { actor, submitScan } = setup(async () => ACCEPTED);
    fill(actor);
    actor.send({ type: 'SUBMIT' });
    await waitFor(actor, (s) => s.value === 'accepted');
    actor.send({ type: 'SUBMIT' });
    expect(actor.getSnapshot().value).toBe('submitting');
    expect(submitScan).toHaveBeenLastCalledWith({ orderId: ORDER_ID, ...EMPTY_FIELDS });
  });
});
