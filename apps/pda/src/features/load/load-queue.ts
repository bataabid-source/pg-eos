// WBS 2.16 part 3 — submit a load scan: the Idempotency-Key and correlation id are generated once,
// only for an accepted scan. A transport failure (LoadTransportError) is 'offline'; any other
// rejection is 'failed'. Neither enqueues nor generates a key.
import type { LoadOrderInput } from '@pg-eos/contracts/wms/process-outbound';

import { LoadTransportError, type LoadClient, type LoadRefusalCode, type LoadScan } from './client';

export interface LoadOrderCommand {
  kind: 'load-order';
  idempotencyKey: string;
  body: LoadOrderInput;
  scannedAt: string;
}

export interface LoadSubmitDeps {
  client: LoadClient;
  newKey: () => string;
  newCorrelationId: () => string;
  now: () => Date;
  enqueue: (payload: unknown) => Promise<void>;
}

export type LoadSubmitResult =
  | { status: 'accepted'; command: LoadOrderCommand }
  | { status: 'refused'; code: LoadRefusalCode }
  | { status: 'offline' }
  | { status: 'failed' }
  | { status: 'invalid' };

export async function submitLoadScan(deps: LoadSubmitDeps, scan: LoadScan): Promise<LoadSubmitResult> {
  // No contract field carries the order code: blank after trim is invalid, before any call or key.
  if (scan.orderCode.trim().length === 0) {
    return { status: 'invalid' };
  }
  let verdict;
  try {
    verdict = await deps.client.checkLoad(scan);
  } catch (error) {
    return error instanceof LoadTransportError ? { status: 'offline' } : { status: 'failed' };
  }
  if (!verdict.accepted) {
    return { status: 'refused', code: verdict.code };
  }
  const command: LoadOrderCommand = {
    kind: 'load-order',
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
