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

export interface ReceiveClient {
  /**
   * Resolves the scanned SKU to its order line. Rejects ONLY on transport failure; a server 4xx
   * resolves to a refusal verdict.
   */
  checkScan(scan: ReceiveScan): Promise<ReceiveScanVerdict>;
}
