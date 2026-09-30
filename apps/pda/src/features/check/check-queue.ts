// WBS 2.16 part 3 — submit a check scan: the Idempotency-Key and correlation id are generated once,
// only for an accepted scan. A transport failure (CheckTransportError) is 'offline'; any other
// rejection is 'failed'. Neither enqueues nor generates a key.
import type { CheckOrderInput } from '@pg-eos/contracts/wms/process-outbound';

import { CheckTransportError, type CheckClient, type CheckRefusalCode, type CheckScan } from './client';

export interface CheckOrderCommand {
  kind: 'check-order';
  idempotencyKey: string;
  body: CheckOrderInput;
  scannedAt: string;
}

export interface CheckSubmitDeps {
  client: CheckClient;
  newKey: () => string;
  newCorrelationId: () => string;
  now: () => Date;
  enqueue: (payload: unknown) => Promise<void>;
}

export type CheckSubmitResult =
  | { status: 'accepted'; command: CheckOrderCommand }
  | { status: 'refused'; code: CheckRefusalCode }
  | { status: 'offline' }
  | { status: 'failed' }
  | { status: 'invalid' };

export async function submitCheckScan(deps: CheckSubmitDeps, scan: CheckScan): Promise<CheckSubmitResult> {
  // No contract field carries the order code: blank after trim is invalid, before any call or key.
  if (scan.orderCode.trim().length === 0) {
    return { status: 'invalid' };
  }
  let verdict;
  try {
    verdict = await deps.client.checkOrder(scan);
  } catch (error) {
    return error instanceof CheckTransportError ? { status: 'offline' } : { status: 'failed' };
  }
  if (!verdict.accepted) {
    return { status: 'refused', code: verdict.code };
  }
  const command: CheckOrderCommand = {
    kind: 'check-order',
    idempotencyKey: deps.newKey(),
    body: {
      orderId: verdict.orderId,
      expectedVersion: verdict.expectedVersion,
      correlationId: deps.newCorrelationId(),
    },
    scannedAt: deps.now().toISOString(),
  };
  await deps.enqueue(command);
  return { status: 'accepted', command };
}
