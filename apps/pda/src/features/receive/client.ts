// WBS 2.16 part 2 — port for the receive screen (same pattern as otp-login/client.ts).
export interface ReceiveScan {
  orderId: string;
  skuCode: string;
  batchNo: string;
  expiryDate: string;
  qty: string;
}

// LineNotFoundError / SkuClientMismatchError / LineAlreadyReceivedError of the server.
export type ReceiveRefusalCode = 'lineNotFound' | 'skuClientMismatch' | 'lineAlreadyReceived';

export type ReceiveScanVerdict =
  | { accepted: true; lineId: string; expectedVersion: number }
  | { accepted: false; code: ReceiveRefusalCode };

// Thrown by a ReceiveClient ONLY when the transport failed (no connection, timeout).
export class ReceiveTransportError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'ReceiveTransportError';
  }
}

export interface ReceiveClient {
  /**
   * Resolves the scanned SKU to its order line. Rejects with ReceiveTransportError ONLY on transport
   * failure; a server 4xx resolves to a refusal verdict. Any other rejection is a fault.
   */
  checkScan(scan: ReceiveScan): Promise<ReceiveScanVerdict>;
}
