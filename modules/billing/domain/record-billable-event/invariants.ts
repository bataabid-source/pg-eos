// modules/billing/domain/record-billable-event/invariants.ts — WBS 4.2 (lane 2).
//
// domain/ layer: pure invariant checks — no I/O, no Date, no Math.random() (CLAUDE.md · AGENT
// CONSTRAINTS). RESCOPED (Master ruling, round-1 finding 1 — FINAL): 4.2 has no application layer
// (billing.billable_events is written only by WBS 4.3's future system-actor subscribers, 01-Data-
// Model.sql:1047 P10) — these functions are called directly by
// ../../infrastructure/record-billable-event/repository.ts's `insertBillableEvent`, which is the
// port 4.3 will call. Round-1 finding 3: the closed-list `sourceTable` check and the client-match
// check moved here FROM the (now-deleted) application command, typed against `BILLABLE_SOURCE_TABLES`
// (a union, not a plain `string`) so the repository's `sql.raw()` use of `sourceTable` is type-safe,
// not just runtime-checked. pg-tester's property tests
// (../../tests/record-billable-event/invariants.property.test.ts) exercise these functions directly.

import { ClientMismatchError, InvalidSourceTableError, NonPositiveQtyError } from './errors.js';

/** D1: the closed list of billing-source tables actually named in doc 40 for shipped event hooks
 *  (docs/notes/slice-briefs/_slice-4.2.brief.md, D1). Any other value -> InvalidSourceTableError. */
export const BILLABLE_SOURCE_TABLES = [
  'wms.inbound_orders',
  'wms.outbound_orders',
  'wms.occupancy_snapshots',
  'wms.inventory_counts',
  'tms.delivery_tasks',
] as const;

/** The closed-list union `sourceTable` narrows to once `assertBillableSourceTable` returns without
 *  throwing — round-1 finding 3: repository.ts's `sql.raw(sourceTable)` interpolation is type-safe
 *  against THIS union, not a plain `string`. */
export type BillableSourceTable = (typeof BILLABLE_SOURCE_TABLES)[number];

/** D1/round-1 finding 3: throws InvalidSourceTableError unless `sourceTable` is one of the closed
 *  list, BEFORE it is ever interpolated as a table identifier. A TypeScript assertion signature so
 *  every caller downstream of this check has `sourceTable: BillableSourceTable`, not `string`. */
export function assertBillableSourceTable(sourceTable: string): asserts sourceTable is BillableSourceTable {
  if (!(BILLABLE_SOURCE_TABLES as readonly string[]).includes(sourceTable)) {
    throw new InvalidSourceTableError(
      `RecordBillableEvent: sourceTable '${sourceTable}' is not in the closed list. ` +
        `(Allowed: ${BILLABLE_SOURCE_TABLES.join(', ')})`,
    );
  }
}

/** D1: the caller-supplied `clientId` must match the resolved source row's own `client_id` exactly
 *  — a null source `client_id` (e.g. `wms.inventory_counts.client_id` is nullable) means there is
 *  nothing to compare against, so no mismatch check applies. */
export function assertClientMatches(sourceClientId: string | null, callerClientId: string): void {
  if (sourceClientId !== null && sourceClientId !== callerClientId) {
    throw new ClientMismatchError(
      `RecordBillableEvent: caller-supplied clientId ${callerClientId} disagrees with the source ` +
        `row's own client_id ${sourceClientId}. (Allowed: the source row's own clientId)`,
    );
  }
}

/** D1/Scenario "qty is rejected unless finite and strictly positive" (round-1 finding 2: the OLD
 *  `qty <= 0` check let `NaN` through, since `NaN <= 0` is `false`). `billing.billable_events` has
 *  no DB CHECK on qty (brief Facts) — this is the ONLY enforcement. */
export function assertPositiveQty(qty: number): void {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new NonPositiveQtyError(
      `RecordBillableEvent requires a finite qty > 0; received ${qty}. ` +
        `(Allowed: a strictly positive, finite quantity)`,
    );
  }
}

/** A (sourceTable, sourceId, serviceId) triple — the natural key the pre-existing unique index
 *  (13B ق-38) enforces. */
export interface BillableEventTriple {
  readonly sourceTable: string;
  readonly sourceId: string;
  readonly serviceId: string;
}

/** D2's domain-level PRE-check (best-effort; the real backstop is the DB's own unique index on
 *  (source_table, source_id, service_id) — proven deterministically by the integration test that
 *  seeds a same-triple row under a DIFFERENT entity via the admin pool, so this RLS-scoped
 *  pre-check cannot see it and the real SQLSTATE 23505 catch in the repository is what fires, NOT
 *  by this pure function). Returns false iff `candidate` matches an entry in `existing` on ALL
 *  THREE fields; true otherwise — a difference in only one or two of the three fields is still
 *  "non-duplicate". */
export function isNonDuplicateTriple(
  existing: readonly BillableEventTriple[],
  candidate: BillableEventTriple,
): boolean {
  return !existing.some(
    (entry) =>
      entry.sourceTable === candidate.sourceTable &&
      entry.sourceId === candidate.sourceId &&
      entry.serviceId === candidate.serviceId,
  );
}
