// modules/billing/domain/record-billable-event/errors.ts — WBS 4.2 (lane 2).
//
// RESCOPED (Master ruling, round-1 review finding 1 — FINAL, D-186 two-round cap):
// `billing.billable_events` is "generated automatically from domain events. No manual entry (P10)"
// (01-Data-Model.sql:1047) — 4.2 delivers ONLY a domain factory + an infrastructure repository
// insert (the port WBS 4.3's system-actor subscribers will call). NO application command, NO api
// layer, NO CFO role gate, NO caller identity — `RoleRequiredError`/`MissingActorError` are DELETED
// (round-1 finding-driven cleanup; there is no role gate and no ctx.userId in this slice's scope).
//
// Typed errors for the RecordBillableEvent domain (docs/notes/slice-briefs/_slice-4.2.brief.md,
// D1/D2). Every class sets `name` explicitly (CLAUDE.md · AGENT CONSTRAINTS) — an `Error` subclass
// does NOT get its constructor name for free at runtime.

/** D1/Scenario "qty is rejected unless finite and strictly positive" — round-1 finding 2: the OLD
 *  `qty <= 0` check let `NaN` through (`NaN <= 0` is `false`). `billing.billable_events` has NO DB
 *  CHECK on qty (brief Facts), so this is the ONLY enforcement, thrown BEFORE any DB write. */
export class NonPositiveQtyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonPositiveQtyError';
  }
}

/** D1 (CORRECTED, Master ruling): the (sourceTable, sourceId) pair identifies no row visible under
 *  the caller's own entity scope — either the row truly does not exist, or it exists but RLS hides
 *  it from this caller (indistinguishable by design, same "not found" convention as every prior
 *  slice's NotFoundError). Never a guess, never a caller-supplied override. Cross-module precedent:
 *  the same "not found" discipline as modules/wms/domain/manage-space/errors.ts's
 *  EntityScopeAmbiguousError. */
export class SourceEventNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceEventNotFoundError';
  }
}

/** D1/round-1 finding 3: `sourceTable` is not one of the closed list (`wms.inbound_orders`,
 *  `wms.outbound_orders`, `wms.occupancy_snapshots`, `wms.inventory_counts`, `tms.delivery_tasks`).
 *  Thrown by `assertBillableSourceTable` (./invariants.ts) BEFORE the value is ever interpolated as
 *  a table identifier. */
export class InvalidSourceTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSourceTableError';
  }
}

/** D1: the caller-supplied `clientId` disagrees with the resolved source row's own `client_id` —
 *  never silently overridden. Thrown by `assertClientMatches` (./invariants.ts). */
export class ClientMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientMismatchError';
  }
}

/** D2/doc 38 line 152's acceptance criterion — "Same event cannot bill twice." The pre-existing
 *  unique index on (source_table, source_id, service_id) (13B ق-38) is the real, race-safe
 *  backstop; a domain-level pre-check (isNonDuplicateTriple, ./invariants.ts) is belt-and-braces
 *  only. */
export class DuplicateBillableEventError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'DuplicateBillableEventError';
  }
}
