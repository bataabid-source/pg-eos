// WBS 2.16 part 3 — port for the check screen (checker != picker, doc 40 §D4).
export interface CheckScan {
  orderCode: string;
  checkerId: string;
}

// SelfCheckNotAllowedError (i18nKey wms.outbound.check.selfCheckNotAllowed) / order not found of the server.
export type CheckRefusalCode = 'selfCheckNotAllowed' | 'orderNotFound';

export type CheckVerdict =
  | { accepted: true; orderId: string; expectedVersion: number }
  | { accepted: false; code: CheckRefusalCode };

// Thrown by a CheckClient ONLY when the transport failed (no connection, timeout).
export class CheckTransportError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'CheckTransportError';
  }
}

export interface CheckClient {
  /**
   * Resolves the scanned order code and applies the server's checker != picker rule. Rejects with
   * CheckTransportError ONLY on transport failure; a server 4xx resolves to a refusal verdict.
   */
  checkOrder(scan: CheckScan): Promise<CheckVerdict>;
}
