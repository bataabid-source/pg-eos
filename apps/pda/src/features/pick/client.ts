// WBS 2.16 part 3 — port for the pick screen (same pattern as receive/client.ts).
export interface PickScan {
  orderId: string;
  lineId: string;
  locationCode: string;
  qtyActual: string;
  varianceReason?: string;
}

// OrderLineNotFoundError / LineAlreadyPickedError / PickQuantityExceedsReservedError /
// LineNotReservedForPickError / VarianceReasonRequiredError of the server.
export type PickRefusalCode =
  | 'lineNotFound'
  | 'lineAlreadyPicked'
  | 'qtyExceedsReserved'
  | 'lineNotReserved'
  | 'varianceReasonRequired';

export type PickVerdict = { accepted: true; expectedVersion: number } | { accepted: false; code: PickRefusalCode };

// Thrown by a PickClient ONLY when the transport failed (no connection, timeout).
export class PickTransportError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'PickTransportError';
  }
}

export interface PickClient {
  /**
   * Asks the server whether the pick is acceptable. Rejects with PickTransportError ONLY on transport
   * failure; a server 4xx resolves to a refusal verdict. Any other rejection is a fault.
   */
  checkPick(scan: PickScan): Promise<PickVerdict>;
}
