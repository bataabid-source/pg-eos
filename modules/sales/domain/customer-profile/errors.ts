// modules/sales/domain/customer-profile/errors.ts — WBS 1.9, M02 sales.
//
// Typed error for the customer-profile use case. `name` is set explicitly (CLAUDE.md · AGENT
// CONSTRAINTS) — an `Error` subclass does NOT get its constructor name for free at runtime.
// No HTTP endpoint this slice (mechanism slice, precedent 1.4/1.7) — nothing here maps to a
// Problem envelope status yet; a future API layer does that.

/** No `sales.accounts` row is visible for the given id — it does not exist, or RLS
 *  (client_portal_scope) hides it from the caller. Never leaked as a distinct 403/404 — the two
 *  cases are indistinguishable, by design (Master decision 6, same convention as 1.7/1.8). */
export class AccountNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountNotFoundError';
  }
}
