// WBS 2.16 part 3 — port for the load screen (doc 40 §D4).
export interface LoadScan {
  orderCode: string;
}

// Order not packed (the load mock starts from a packed order) / order not found of the server.
export type LoadRefusalCode = 'orderNotPacked' | 'orderNotFound';

export type LoadVerdict =
  | { accepted: true; orderId: string; expectedVersion: number }
  | { accepted: false; code: LoadRefusalCode };

// Thrown by a LoadClient ONLY when the transport failed (no connection, timeout).
export class LoadTransportError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'LoadTransportError';
  }
}

export interface LoadClient {
  /**
   * Resolves the scanned order code and applies the server's load rules. Rejects with
   * LoadTransportError ONLY on transport failure; a server 4xx resolves to a refusal verdict.
   */
  checkLoad(scan: LoadScan): Promise<LoadVerdict>;
}
