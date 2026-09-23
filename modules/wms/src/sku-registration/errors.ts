// modules/wms/src/sku-registration/errors.ts — WBS 2.6 (pg-backend).
//
// Typed errors for the SKU registration mechanism (brief "Public surface" block). Every class
// sets `name` explicitly (CLAUDE.md · AGENT CONSTRAINTS) — an `Error` subclass does NOT get its
// constructor name for free at runtime. Same discipline as modules/wms/src/stock-ledger/errors.ts.

/** decision 4: clientId/code/nameAr missing or empty, or status/pickingPolicy present and outside
 *  its enum. Thrown by validateSkuInput before any DB call — one class covering all of these,
 *  same discipline as InvalidLedgerEntryError in the 2.8 precedent. */
export class InvalidSkuInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSkuInputError';
  }
}

/** decision 5: thrown by registerSku itself (not validateSkuInput, since it needs ctx), before
 *  withContext is opened, when a portal caller (!ctx.isInternal) attempts to register a SKU under
 *  a clientId other than its own. */
export class CrossClientSkuError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrossClientSkuError';
  }
}

/** decision 6: mapped from a 23505 violation of skus_client_id_code_key — the same (client_id,
 *  code) pair already exists. A duplicate code under a DIFFERENT client_id is NOT this error. */
export class DuplicateSkuCodeError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'DuplicateSkuCodeError';
  }
}

/** decision 7: mapped from a 23503 violation of skus_client_id_fkey — client_id does not
 *  reference an existing sales.accounts row. */
export class UnknownClientError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'UnknownClientError';
  }
}
