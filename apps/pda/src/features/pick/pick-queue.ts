// WBS 2.16 part 3 — submit a pick scan: the Idempotency-Key and correlation id are generated once,
// only for an accepted scan. A transport failure (PickTransportError) is 'offline'; any other
// rejection is 'failed'. Neither enqueues nor generates a key.
import { PickLineInputSchema, type PickLineInput } from '@pg-eos/contracts/wms/process-outbound';

import { PickTransportError, type PickClient, type PickRefusalCode, type PickScan } from './client';

export interface PickLineCommand {
  kind: 'pick-line';
  idempotencyKey: string;
  body: PickLineInput;
  scannedAt: string;
}

export interface PickSubmitDeps {
  client: PickClient;
  newKey: () => string;
  newCorrelationId: () => string;
  now: () => Date;
  enqueue: (payload: unknown) => Promise<void>;
}

export type PickSubmitResult =
  | { status: 'accepted'; command: PickLineCommand }
  | { status: 'refused'; code: PickRefusalCode }
  | { status: 'offline' }
  | { status: 'failed' }
  | { status: 'invalid' };

export async function submitPickScan(deps: PickSubmitDeps, scan: PickScan): Promise<PickSubmitResult> {
  // The contract's own field schema decides validity, before any call, key or enqueue.
  if (!PickLineInputSchema.shape.qtyActual.safeParse(scan.qtyActual).success) {
    return { status: 'invalid' };
  }
  let verdict;
  try {
    verdict = await deps.client.checkPick(scan);
  } catch (error) {
    return error instanceof PickTransportError ? { status: 'offline' } : { status: 'failed' };
  }
  if (!verdict.accepted) {
    return { status: 'refused', code: verdict.code };
  }
  const reason = scan.varianceReason ?? '';
  const command: PickLineCommand = {
    kind: 'pick-line',
    idempotencyKey: deps.newKey(),
    body: {
      orderId: scan.orderId,
      lineId: scan.lineId,
      expectedVersion: verdict.expectedVersion,
      qtyActual: scan.qtyActual,
      ...(reason.length > 0 ? { varianceReason: reason } : {}),
      correlationId: deps.newCorrelationId(),
    },
    scannedAt: deps.now().toISOString(),
  };
  await deps.enqueue(command);
  return { status: 'accepted', command };
}
