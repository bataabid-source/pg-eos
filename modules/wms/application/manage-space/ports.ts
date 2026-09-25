// modules/wms/application/manage-space/ports.ts — WBS 2.15 (lane 2).
//
// application/ layer: the ports this use case programs against. Each command
// (./allocate-space.ts, ./reserve-space.ts) takes ONE `deps: ManageSpaceDeps` (clock, ids, repo,
// logger) and never imports infrastructure/. ../../infrastructure/manage-space/repository.ts
// implements `ManageSpaceRepository`. ../../api/manage-space/composition.ts wires it.
//
// D1 (brief): no `machine`/version port here — neither `wms.space_allocations` nor
// `wms.space_reservations` has a status column this slice mutates through edges; both commands
// only ever INSERT a fresh row at status='active'.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** The clock and id generator the commands need (injected — domain-kit adapters in production,
 *  fixed ones in tests). `ids` is unused by this use case's own inserts (both
 *  `wms.space_allocations.id`/`wms.space_reservations.id` default to `gen_random_uuid()` in the
 *  schema) — carried for parity with every other use case's `ClockDeps` shape. */
export interface ClockDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by ../../infrastructure/manage-space/logger.ts (a
 *  @pg-eos/logger child-logger adapter); a fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** Everything a command needs, injected by the composition root
 *  (../../api/manage-space/composition.ts). Commands program only against these ports — the
 *  application layer never imports infrastructure/. */
export interface ManageSpaceDeps extends ClockDeps {
  readonly repo: ManageSpaceRepository;
  readonly logger: Logger;
}

export interface AllocationInsertColumns {
  readonly entityId: string;
  readonly contractId: string;
  readonly clientId: string;
  readonly blockId: string;
  readonly allocType: string | null;
  readonly qty: number;
  readonly uom: string;
  readonly serviceId: string | null;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly minChargeApplies: boolean | null;
  readonly createdBy: string;
}

export interface ReservationInsertColumns {
  readonly entityId: string;
  readonly blockId: string;
  readonly clientId: string | null;
  readonly quoteId: string | null;
  readonly opportunityId: string | null;
  readonly qty: number;
  readonly uom: string;
  readonly reservedFrom: string;
  readonly expiresAt: string;
  readonly reason: string;
  readonly reservedBy: string;
}

/** Every DB statement the manage-space use case needs, as an interface — the port the application
 *  layer programs against. Implemented by ../../infrastructure/manage-space/repository.ts. */
export interface ManageSpaceRepository {
  hasAnyRole(tx: NodePgDatabase, roleCodes: readonly string[]): Promise<boolean>;
  /** CORRECTED (round-1 review finding 1): entity is resolved THROUGH the block the command
   *  itself names — `wms.space_blocks` carries its own `entity_id` and an `entity_scope` RLS
   *  policy (13B:1484), so a block outside the caller's own entities is already invisible to
   *  this read; `SALES_MGR` is `all-scope`, so a caller legitimately scoped to several entities
   *  (handlers.test.ts's own fixture) still resolves unambiguously through the ONE block named by
   *  the request, never through the caller's own raw entity count, and never `ctx.entityId`. The
   *  underlying read is `SELECT ... FOR UPDATE` — it LOCKS the block row for the rest of the
   *  transaction so two concurrent calls on the same block serialize before either one checks
   *  availability, closing the race a plain read would leave open. Throws
   *  EntityScopeAmbiguousError when no row is visible. */
  getBlockEntityId(tx: NodePgDatabase, blockId: string): Promise<string>;
  /** D4: `platform.thresholds` key `space.reservation_max_days` — never hardcoded. Returns the
   *  seeded integer value (30). */
  getReservationMaxDays(tx: NodePgDatabase): Promise<number>;
  /** D3/D4: `select wms.check_space_available($1,$2,$3,$4)` — the function returns void and RAISES
   *  (SQLSTATE P0001) on insufficient sellable capacity; this call either resolves (space is
   *  available) or throws a typed `SpaceNotAvailableError` (../../domain/manage-space/errors.js),
   *  carrying the raised function's own message VERBATIM — the adapter itself catches the raw
   *  P0001 Postgres error and re-throws the typed one, same discipline as
   *  ../../infrastructure/count-inventory/repository.ts throwing typed domain errors directly. Any
   *  OTHER error (a connection failure, a different SQLSTATE) is rethrown unchanged. */
  checkSpaceAvailable(
    tx: NodePgDatabase,
    params: { readonly blockId: string; readonly qty: number; readonly from: string; readonly to: string | null },
  ): Promise<void>;
  /** Round-2 review finding 2: RETURNS `allocType`/`minChargeApplies` alongside `id`/`status` —
   *  the actually-stored values (the DB's own `alloc_type`/`min_charge_applies` DEFAULTs fire on
   *  a caller-omitted column), never fabricated from `input` or an application-side default
   *  constant. The caller (../allocate-space.ts) builds its audit-log `newValue` from these.
   *  Round-4 review finding: also RETURNS `qty` as stored at the column's numeric(14,3) scale, and
   *  maps a `positive_qty` CHECK violation (SQLSTATE 23514) to a typed `NonPositiveQtyError`
   *  (422) — a backstop behind the domain's own isPositiveQty/hasValidQtyScale pre-check. */
  insertAllocation(
    tx: NodePgDatabase,
    columns: AllocationInsertColumns,
  ): Promise<{
    readonly id: string;
    readonly status: string;
    readonly allocType: string;
    readonly minChargeApplies: boolean;
    readonly qty: number;
  }>;
  /** Round-4 review finding: RETURNS `qty` as stored at the column's numeric(14,3) scale — the
   *  caller (../reserve-space.ts) audits this value, never `input.qty`. */
  insertReservation(
    tx: NodePgDatabase,
    columns: ReservationInsertColumns,
  ): Promise<{ readonly id: string; readonly status: string; readonly qty: number }>;
  /** doc 40 P3/P7: one append-only `platform.audit_log` row (D6 — no outbox event for this use
   *  case). `occurredAt` is mandatory (always from the injected Clock, never the column's own
   *  `default now()`). */
  writeAuditRow(
    tx: NodePgDatabase,
    params: {
      readonly entityId: string;
      readonly tableName: 'space_allocations' | 'space_reservations';
      readonly recordId: string;
      readonly operation: string;
      readonly correlationId: string;
      readonly actorId: string;
      readonly newValue: unknown;
      readonly occurredAt: Date;
    },
  ): Promise<void>;
}
