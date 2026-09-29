// WBS 2.16 part 2 — close-review blocking finding: only a ReceiveTransportError is "offline";
// any other checkScan rejection is 'failed' (nothing enqueued, no key generated).
import { describe, it, expect, vi } from 'vitest';

import { ReceiveTransportError, type ReceiveClient } from '../../src/features/receive/client';
import { submitReceiveScan, type SubmitDeps } from '../../src/features/receive/scan-queue';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const SCAN = { orderId: ORDER_ID, skuCode: 'SKU-100', batchNo: 'B2409-7', expiryDate: '2027-01-27', qty: '10' };
const ONCE = 1;

function makeDeps(reason: unknown): SubmitDeps {
  const client: ReceiveClient = { checkScan: vi.fn().mockRejectedValue(reason) };
  return {
    client,
    newKey: vi.fn(() => 'key'),
    newCorrelationId: vi.fn(() => 'corr'),
    now: () => new Date('2026-09-29T08:00:00.000Z'),
    enqueue: vi.fn().mockResolvedValue(undefined),
  };
}

describe('submitReceiveScan rejection classification', () => {
  it('ReceiveTransportError is an Error subclass', () => {
    expect(new ReceiveTransportError('offline')).toBeInstanceOf(Error);
  });

  it('a ReceiveTransportError rejection yields offline', async () => {
    const deps = makeDeps(new ReceiveTransportError('offline'));
    expect(await submitReceiveScan(deps, SCAN)).toEqual({ status: 'offline' });
    expect(deps.client.checkScan).toHaveBeenCalledTimes(ONCE);
    expect(deps.newKey).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['Error', new Error('boom')],
    ['TypeError', new TypeError('boom')],
  ])('a plain %s rejection yields failed, no key, nothing enqueued', async (_n, reason) => {
    const deps = makeDeps(reason);
    expect(await submitReceiveScan(deps, SCAN)).toEqual({ status: 'failed' });
    expect(deps.newKey).not.toHaveBeenCalled();
    expect(deps.newCorrelationId).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
});
