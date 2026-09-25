// modules/wms/infrastructure/manage-space/repository.ts — WBS 2.15 (lane 2).
//
// infrastructure/ layer: every DB statement for the manage-space use case, run against the
// `tx` a caller's own withContext(ctx, fn) already opened. Implements
// ../../application/manage-space/ports.ts's `ManageSpaceRepository`.
//
// LOCK ORDER — the one every command follows (each command's own header points here):
//   0. the idempotency advisory lock + platform.idempotency_keys upsert (packages/db/src/
//      idempotency.ts's withIdempotentContext), FIRST — before step 1 — whenever the command's
//      own input carries an `idem` (every write command in this use case).
//   1. hasAnyRole — a plain read, no lock.
//   2. getBlockEntityId — round-1 review finding 1: `select entity_id from wms.space_blocks
//      where id = $1 for update`, LOCKING the block row (not just reading it) BEFORE the
//      capacity check, so two concurrent AllocateSpace/ReserveSpace calls on the SAME block
//      serialize instead of both reading a stale sellable figure and both passing (the FOR UPDATE
//      row lock is held for the rest of the transaction — through step 3 and the INSERT — and
//      released only at COMMIT/ROLLBACK). Neither space_allocations nor space_reservations has a
//      status column this slice mutates through edges (D1) — the lock is on `space_blocks`, the
//      row whose derived sellable figure both commands must serialize against, never on an
//      existing allocation/reservation row (each command only INSERTs a fresh one).
//   3. checkSpaceAvailable — `select wms.check_space_available(...)` (D3/D4), a plain SELECT that
//      raises (SQLSTATE P0001) on insufficient sellable capacity — BEFORE the INSERT, still inside
//      the same transaction holding the step 2 row lock.
//   4. insertAllocation / insertReservation, then writeAuditRow, last (ADR-0002 discipline — no
//      row lock is taken after the audit-chain write).
//
// D6: no outbox event for this use case (Facts — no event named in doc 40's events list covers
// space allocation/reservation) — writeAuditRow is the only side-record.

const SPACE_SCHEMA = 'wms';
const ALLOCATIONS_TABLE_NAME = 'space_allocations';
const ALLOCATIONS_TABLE = `${SPACE_SCHEMA}.${ALLOCATIONS_TABLE_NAME}`;
const RESERVATIONS_TABLE_NAME = 'space_reservations';
const RESERVATIONS_TABLE = `${SPACE_SCHEMA}.${RESERVATIONS_TABLE_NAME}`;
const AUDIT_ACTOR_TYPE_USER = 'user'; // every actor is ctx.userId — never 'system' here.
const AUDIT_TABLE_BY_TARGET = {
  space_allocations: ALLOCATIONS_TABLE_NAME,
  space_reservations: RESERVATIONS_TABLE_NAME,
} as const;

// D4/Facts: `platform.thresholds` key `space.reservation_max_days` — never hardcoded (CLAUDE.md
// "No magic numbers"). The key NAME is a stable identifier, not the threshold VALUE itself.
const RESERVATION_MAX_DAYS_THRESHOLD_KEY = 'space.reservation_max_days';

// D3/D4/Facts: `wms.check_space_available()` raises a plain exception with SQLSTATE P0001 (the
// Postgres default for `RAISE EXCEPTION` with no explicit SQLSTATE) when the block's sellable
// capacity is less than the requested qty — never any other SQLSTATE for this specific failure.
const SPACE_NOT_AVAILABLE_SQLSTATE = 'P0001';

// Round-4 review finding: `wms.space_allocations`'s own `positive_qty` CHECK (13B) raises SQLSTATE
// 23514 (check_violation) with `constraint = 'positive_qty'` — mapped to NonPositiveQtyError (422)
// as a defense-in-depth backstop behind the domain pre-check, never an unhandled 500.
const CHECK_VIOLATION_SQLSTATE = '23514';
const POSITIVE_QTY_CONSTRAINT = 'positive_qty';

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  EntityScopeAmbiguousError,
  NonPositiveQtyError,
  SpaceNotAvailableError,
} from '../../domain/manage-space/errors.js';
import type {
  AllocationInsertColumns,
  ManageSpaceRepository,
  ReservationInsertColumns,
} from '../../application/manage-space/ports.js';

/** Walks `error`'s own cause chain for a Postgres error with the given SQLSTATE — same
 *  walk-the-cause-chain discipline as ../../../hr/infrastructure/maintain-shift/repository.ts's
 *  own isConstraintViolation, but keyed on SQLSTATE alone: a plain `RAISE EXCEPTION` (P0001) never
 *  carries a `constraint` name, unlike a unique/exclusion-constraint violation. Returns the
 *  MATCHING error in the chain (never drizzle's own outer "Failed query: ..." wrapper) — its own
 *  `.message` is the raw Postgres message (`wms.check_space_available()`'s own RAISE text,
 *  carrying the exact sellable qty), the one this adapter relays VERBATIM. */
function findRaisedException(error: unknown, sqlstate: string): Error | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = 'code' in current ? current.code : undefined;
    if (code === sqlstate) {
      return current;
    }
    current = current.cause;
  }

  return undefined;
}

async function hasAnyRole(tx: NodePgDatabase, roleCodes: readonly string[]): Promise<boolean> {
  const result = await tx.execute<{ roles: readonly string[] }>(sql`select platform.my_roles() as roles`);
  const roles = result.rows[0]?.roles ?? [];
  return roleCodes.some((roleCode) => roles.includes(roleCode));
}

/** CORRECTED (round-1 review finding 1): entity resolution is resolved THROUGH the block the
 *  command itself names — `wms.space_blocks` carries its own `entity_id` and an `entity_scope`
 *  RLS policy (13B:1484), so a block outside the caller's own entities is already invisible to
 *  this read; `SALES_MGR` is `all-scope` (brief Facts), so a caller legitimately scoped to
 *  several entities still resolves unambiguously through the ONE block named by the request —
 *  never through the caller's own raw entity count, and never `ctx.entityId`. The read is
 *  `SELECT ... FOR UPDATE`: it LOCKS the block row for the rest of the transaction, so two
 *  concurrent AllocateSpace/ReserveSpace calls on the same block serialize before either one
 *  computes/checks the sellable figure (checkSpaceAvailable, below) — without this lock, both
 *  calls could read a stale sellable figure and both pass, over-allocating. */
async function getBlockEntityId(tx: NodePgDatabase, blockId: string): Promise<string> {
  const result = await tx.execute<{ entity_id: string }>(
    sql`select entity_id from ${sql.raw(SPACE_SCHEMA)}.space_blocks where id = ${blockId}::uuid for update`,
  );
  const row = result.rows[0];
  if (!row) {
    throw new EntityScopeAmbiguousError(
      `no ${SPACE_SCHEMA}.space_blocks row visible for id ${blockId} in the caller's entities. ` +
        `(Allowed: an existing block in one of the caller's own entities)`,
    );
  }
  return row.entity_id;
}

/** D4: `platform.thresholds` key `space.reservation_max_days` — read live, never hardcoded. */
async function getReservationMaxDays(tx: NodePgDatabase): Promise<number> {
  const result = await tx.execute<{ value: string }>(
    sql`select value::text as value from platform.thresholds where key = ${RESERVATION_MAX_DAYS_THRESHOLD_KEY}`,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `platform.thresholds row '${RESERVATION_MAX_DAYS_THRESHOLD_KEY}' not found — is 13B-Schema-Reference-Consolidation.sql applied?`,
    );
  }
  return Number(row.value);
}

/** D3/D4: `select wms.check_space_available($1,$2,$3,$4)` — the function returns void and RAISES
 *  (SQLSTATE P0001) on insufficient sellable capacity. A P0001 raise is caught here and re-thrown
 *  as a typed SpaceNotAvailableError carrying the raised function's own message VERBATIM (it
 *  already states the block's code, the exact sellable qty, and the requested qty — never
 *  recomputed or reformatted). Any OTHER error is rethrown unchanged. */
async function checkSpaceAvailable(
  tx: NodePgDatabase,
  params: { readonly blockId: string; readonly qty: number; readonly from: string; readonly to: string | null },
): Promise<void> {
  try {
    await tx.execute(
      sql`select wms.check_space_available(${params.blockId}::uuid, ${params.qty}::numeric, ${params.from}::date, ${params.to}::date)`,
    );
  } catch (error) {
    const raised = findRaisedException(error, SPACE_NOT_AVAILABLE_SQLSTATE);
    if (raised) {
      throw new SpaceNotAvailableError(raised.message, { cause: error });
    }
    throw error;
  }
}

/** `alloc_type` is `not null default 'dedicated'` and `min_charge_applies` is `not null default
 *  true` (13B:1010) — a caller-omitted value must let the column's own DEFAULT fire, never an
 *  explicit NULL (which would violate NOT NULL) and never a hardcoded literal duplicating the
 *  column's own DEFAULT in application code (CLAUDE.md "No magic numbers" — round-2 review
 *  finding 2, same problem `min_charge_applies` already avoided but `alloc_type` had not yet been
 *  caught for). Both columns use Postgres's own `DEFAULT` keyword in the VALUES list when the
 *  caller omitted a value, so the DB's own default fires — the column is never left out of the
 *  column list (unlike the two-variant style used elsewhere), keeping this to ONE query.
 *  `RETURNING alloc_type, min_charge_applies` alongside `id, status`: the caller
 *  (../../application/manage-space/allocate-space.ts) builds its audit-log `newValue` from these
 *  RETURNED, actually-stored values, never from `input` or an application-side default constant
 *  (CLAUDE.md "never fabricate a number/name/decision — numbers come from the system").
 *  Round-4 review finding: `RETURNING qty` too — the value as stored at the column's numeric(14,3)
 *  scale (node-postgres returns `numeric` as a string; converted with Number(), exact for a
 *  3-decimal value) — and a `positive_qty` CHECK violation (SQLSTATE 23514) is caught and
 *  re-thrown as a typed NonPositiveQtyError (422), same catch pattern as checkSpaceAvailable's
 *  P0001. Any OTHER error (including a 23514 from a different constraint) is rethrown unchanged. */
async function insertAllocation(
  tx: NodePgDatabase,
  columns: AllocationInsertColumns,
): Promise<{
  readonly id: string;
  readonly status: string;
  readonly allocType: string;
  readonly minChargeApplies: boolean;
  readonly qty: number;
}> {
  const allocTypeValue = columns.allocType === null ? sql.raw('default') : sql`${columns.allocType}`;
  const minChargeAppliesValue =
    columns.minChargeApplies === null ? sql.raw('default') : sql`${columns.minChargeApplies}::boolean`;
  let result;
  try {
    result = await tx.execute<{ id: string; status: string; alloc_type: string; min_charge_applies: boolean; qty: string }>(sql`
      insert into ${sql.raw(ALLOCATIONS_TABLE)}
        (entity_id, contract_id, client_id, block_id, alloc_type, qty, uom, service_id, valid_from, valid_to,
         min_charge_applies, created_by)
      values
        (${columns.entityId}::uuid, ${columns.contractId}::uuid, ${columns.clientId}::uuid, ${columns.blockId}::uuid,
         ${allocTypeValue}, ${columns.qty}::numeric, ${columns.uom}, ${columns.serviceId}::uuid,
         ${columns.validFrom}::date, ${columns.validTo}::date, ${minChargeAppliesValue}, ${columns.createdBy}::uuid)
      returning id, status, alloc_type, min_charge_applies, qty::text as qty
    `);
  } catch (error) {
    const raised = findRaisedException(error, CHECK_VIOLATION_SQLSTATE);
    if (raised && 'constraint' in raised && raised.constraint === POSITIVE_QTY_CONSTRAINT) {
      throw new NonPositiveQtyError(
        `AllocateSpace: ${ALLOCATIONS_TABLE}.qty must be > 0 as stored at its numeric scale; received ${columns.qty}. ` +
          `(Allowed: a strictly positive quantity) — ${raised.message}`,
        { cause: error },
      );
    }
    throw error;
  }
  const row = result.rows[0];
  if (!row) throw new Error(`insert into ${ALLOCATIONS_TABLE} returned no row`);
  return {
    id: row.id,
    status: row.status,
    allocType: row.alloc_type,
    minChargeApplies: row.min_charge_applies,
    qty: Number(row.qty),
  };
}

/** Round-4 review finding: `RETURNING qty` — the value as stored at the column's numeric(14,3)
 *  scale; the caller (../../application/manage-space/reserve-space.ts) audits this, never
 *  `input.qty`. `space_reservations` has no positive-qty CHECK (D7) — no 23514 mapping here; the
 *  domain pre-check is the only enforcement. */
async function insertReservation(
  tx: NodePgDatabase,
  columns: ReservationInsertColumns,
): Promise<{ readonly id: string; readonly status: string; readonly qty: number }> {
  const result = await tx.execute<{ id: string; status: string; qty: string }>(sql`
    insert into ${sql.raw(RESERVATIONS_TABLE)}
      (entity_id, block_id, client_id, quote_id, opportunity_id, qty, uom, reserved_from, expires_at, reason,
       reserved_by)
    values
      (${columns.entityId}::uuid, ${columns.blockId}::uuid, ${columns.clientId}::uuid, ${columns.quoteId}::uuid,
       ${columns.opportunityId}::uuid, ${columns.qty}::numeric, ${columns.uom}, ${columns.reservedFrom}::date,
       ${columns.expiresAt}::date, ${columns.reason}, ${columns.reservedBy}::uuid)
    returning id, status, qty::text as qty
  `);
  const row = result.rows[0];
  if (!row) throw new Error(`insert into ${RESERVATIONS_TABLE} returned no row`);
  return { id: row.id, status: row.status, qty: Number(row.qty) };
}

/** doc 40 P3/P7: one append-only audit_log row, correlation_id shared with any outbox row the
 *  same call writes (G9 — D6: this use case writes none). `occurredAt` is mandatory (always from
 *  the injected Clock, never the column's own `default now()`). */
async function writeAuditRow(
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
): Promise<void> {
  await tx.execute(sql`
    insert into platform.audit_log
      (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation,
       new_value, correlation_id)
    values
      (${params.occurredAt.toISOString()}::timestamptz, ${params.actorId}::uuid, ${AUDIT_ACTOR_TYPE_USER},
       ${params.entityId}::uuid, ${SPACE_SCHEMA}, ${AUDIT_TABLE_BY_TARGET[params.tableName]}, ${params.recordId}::uuid,
       ${params.operation}, ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

export const manageSpaceRepository: ManageSpaceRepository = {
  hasAnyRole,
  getBlockEntityId,
  getReservationMaxDays,
  checkSpaceAvailable,
  insertAllocation,
  insertReservation,
  writeAuditRow,
};

export { SPACE_SCHEMA, ALLOCATIONS_TABLE_NAME, ALLOCATIONS_TABLE, RESERVATIONS_TABLE_NAME, RESERVATIONS_TABLE };
