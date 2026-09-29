// WBS 2.16 part 2 — submit a receive scan: the Idempotency-Key and correlation id are generated
// once, at scan time, and only for an accepted scan. Offline queuing is deferred to 2.16 part 2b:
// a transport failure (ReceiveTransportError) refuses the scan as 'offline'; any other
// rejection is a fault and yields 'failed'. Neither enqueues nor generates a key.
import { ReceiveLineInputSchema, type ReceiveLineInput } from '@pg-eos/contracts/wms/receive-inbound';

import { ReceiveTransportError, type ReceiveClient, type ReceiveRefusalCode, type ReceiveScan } from './client';

export interface ReceiveLineCommand {
  kind: 'receive-line';
  idempotencyKey: string;
  body: ReceiveLineInput;
  scannedAt: string;
}

export interface SubmitDeps {
  client: ReceiveClient;
  newKey: () => string;
  newCorrelationId: () => string;
  now: () => Date;
  enqueue: (payload: unknown) => Promise<void>;
}

export type SubmitResult =
  | { status: 'accepted'; command: ReceiveLineCommand }
  | { status: 'refused'; code: ReceiveRefusalCode }
  | { status: 'offline' }
  | { status: 'failed' }
  | { status: 'invalid' };

export async function submitReceiveScan(deps: SubmitDeps, scan: ReceiveScan): Promise<SubmitResult> {
  // The contract's own field schemas decide validity, before any call, key or enqueue.
  const fields = ReceiveLineInputSchema.shape;
  const valid =
    fields.batchNo.safeParse(scan.batchNo).success &&
    fields.expiryDate.safeParse(scan.expiryDate).success &&
    fields.qtyActual.safeParse(scan.qty).success;
  if (!valid) {
    return { status: 'invalid' };
  }
  let verdict;
  try {
    verdict = await deps.client.checkScan(scan);
  } catch (error) {
    return error instanceof ReceiveTransportError ? { status: 'offline' } : { status: 'failed' };
  }
  if (!verdict.accepted) {
    return { status: 'refused', code: verdict.code };
  }
  const command: ReceiveLineCommand = {
    kind: 'receive-line',
    idempotencyKey: deps.newKey(),
    body: {
      orderId: scan.orderId,
      lineId: verdict.lineId,
      qtyActual: scan.qty,
      batchNo: scan.batchNo,
      expiryDate: scan.expiryDate,
      expectedVersion: verdict.expectedVersion,
      correlationId: deps.newCorrelationId(),
    },
    scannedAt: deps.now().toISOString(),
  };
  await deps.enqueue(command);
  return { status: 'accepted', command };
}

export function replayReceiveCommand(c: ReceiveLineCommand): {
  headers: { 'Idempotency-Key': string };
  body: ReceiveLineInput;
} {
  return { headers: { 'Idempotency-Key': c.idempotencyKey }, body: c.body };
}
