// modules/wms/src/stock-ledger/post-movement.ts — WBS 2.8 (pg-backend).
//
// postMovement / postTransfer / reverseMovement — every DB access goes through
// withContext(ctx, fn) (@pg-eos/db, CLAUDE.md · ARCHITECTURE); SQL via drizzle `sql` tags on
// tx.execute (the 0.12/0.17 style — see packages/identity/src/rbac.ts, packages/events/src/
// outbox.ts).
//
// Per posted ledger row, in the SAME transaction (decision 7, G9 doc 40:639):
//   1. insert wms.stock_movements (single-sided, qty > 0 — decision 1)
//   2. upsert wms.stock_balance: qty_on_hand = qty_on_hand +/- qty (decision 2); the
//      01 wms.stock_balance constraint no_negative_stock (decision 3) is the only rejection authority — this
//      mechanism never pre-checks with a racy read, it maps the constraint violation to a typed
//      NegativeStockError instead.
//   3. writeOutboxEvent (aggregateType 'wms.stock_movements', eventType 'wms.stock.moved')
//   4. one platform.audit_log row carrying the SAME correlation_id as the outbox row (G9).
//
// decision 4: qty <= 0 / an invalid entry shape is rejected by validateEntry BEFORE withContext is
// even called — no transaction is opened, so no DB call of any kind happens for that attempt.

import { withContext, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';
import { Quantity, type Clock, type IdGenerator } from '@pg-eos/domain-kit';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  balanceKey,
  balanceRebuildLockKey,
  evaluateLocationLimits,
  hasWeightVolumeLimits,
  locationLimitLockKey,
  planReversal,
  planTransfer,
  validateEntry,
  type LedgerEntry,
  type MovementType,
} from './domain.js';
import {
  LocationBlockedError,
  LocationLimitExceededError,
  MovementNotFoundError,
  NegativeStockError,
} from './errors.js';

// decision 1: SQLSTATE for a CHECK constraint violation (Postgres error class 23 — integrity
// constraint violation, code 23514) — the class 01 wms.stock_balance constraint no_negative_stock raises.
const CHECK_VIOLATION_SQLSTATE = '23514';
// 01 wms.stock_balance constraint no_negative_stock — matched together with the SQLSTATE so no
// OTHER check violation on the same table is ever mistaken for a negative-stock rejection.
const NO_NEGATIVE_STOCK_CONSTRAINT = 'no_negative_stock';

// doc 40 §B3 naming convention `<module>.<aggregate>.<past_tense>`; packages/events/catalog.ts
// (Master-added, frozen path) lists this literal — assigning it to CatalogedEventType makes a typo
// or a drift from the catalog a compile error rather than a silent runtime mismatch.
const STOCK_MOVED_EVENT_TYPE: CatalogedEventType = 'wms.stock.moved';
// decision 7: aggregateType / audit_log schema+table for every row this mechanism writes.
const STOCK_MOVEMENTS_AGGREGATE_TYPE = 'wms.stock_movements';
const AUDIT_SCHEMA_NAME = 'wms';
const AUDIT_TABLE_NAME = 'stock_movements';
const AUDIT_OPERATION_INSERT = 'insert';
// decision 7: "'user' | 'system' when userId is null".
const AUDIT_ACTOR_TYPE_USER = 'user';
const AUDIT_ACTOR_TYPE_SYSTEM = 'system';
// decision 5: reversal ref_table / reason_code, verbatim.
const REVERSAL_REF_TABLE = 'wms.stock_movements';
const REVERSAL_REASON_CODE = 'reversal';

export interface PostMovementInput {
  readonly entityId: string;
  readonly entry: LedgerEntry;
  readonly correlationId: string;
  readonly performedBy: string;
  readonly refTable?: string | null;
  readonly refId?: string | null;
  readonly reasonCode?: string | null;
  readonly deviceId?: string | null;
}

export interface LedgerDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface PostedMovement {
  readonly movementIds: readonly string[];
  readonly correlationId: string;
}

/**
 * The row as `wms.stock_movements` actually stored it — used, unchanged, as both the outbox
 * payload and the audit_log `new_value` (decision 7: "the ledger entry as written").
 */
type StoredMovementRow = {
  readonly id: string;
  readonly entity_id: string;
  readonly occurred_at: string;
  readonly movement_type: string;
  readonly client_id: string;
  readonly sku_id: string;
  readonly from_location_id: string | null;
  readonly to_location_id: string | null;
  readonly qty: string;
  readonly uom: string;
  readonly batch_no: string | null;
  readonly ref_table: string | null;
  readonly ref_id: string | null;
  readonly reason_code: string | null;
  readonly performed_by: string;
  readonly device_id: string | null;
};

/**
 * True only for wms.stock_balance's `no_negative_stock` check violation. The whole `cause` chain
 * is walked (drizzle wraps the failing query in its own error, carrying pg's DatabaseError — which
 * holds the SQLSTATE and constraint name — as `cause`), bounded by `seen` against a cyclic chain.
 * Same pattern as packages/identity/src/rbac.ts's isSodViolation.
 */
function isNegativeStockViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = 'code' in current ? current.code : undefined;
    const constraint = 'constraint' in current ? current.constraint : undefined;
    if (code === CHECK_VIOLATION_SQLSTATE && constraint === NO_NEGATIVE_STOCK_CONSTRAINT) {
      return true;
    }
    current = current.cause;
  }

  return false;
}

async function insertMovementRow(
  tx: NodePgDatabase,
  params: {
    readonly entityId: string;
    readonly entry: LedgerEntry;
    readonly occurredAt: Date;
    readonly performedBy: string;
    readonly refTable: string | null;
    readonly refId: string | null;
    readonly reasonCode: string | null;
    readonly deviceId: string | null;
  },
): Promise<StoredMovementRow> {
  const result = await tx.execute<StoredMovementRow>(sql`
    insert into wms.stock_movements
      (entity_id, occurred_at, movement_type, client_id, sku_id, from_location_id, to_location_id,
       qty, uom, batch_no, ref_table, ref_id, reason_code, performed_by, device_id)
    values
      (${params.entityId}::uuid, ${params.occurredAt.toISOString()}::timestamptz,
       ${params.entry.movementType}, ${params.entry.clientId}::uuid, ${params.entry.skuId}::uuid,
       ${params.entry.fromLocationId}::uuid, ${params.entry.toLocationId}::uuid,
       ${params.entry.qty.toString()}::numeric, ${params.entry.uom}, ${params.entry.batchNo},
       ${params.refTable}, ${params.refId}::uuid, ${params.reasonCode}, ${params.performedBy}::uuid,
       ${params.deviceId})
    returning id, entity_id, occurred_at, movement_type, client_id, sku_id, from_location_id,
              to_location_id, qty::text as qty, uom, batch_no, ref_table, ref_id, reason_code,
              performed_by, device_id
  `);

  const row = result.rows[0];
  if (!row) {
    throw new Error('insert into wms.stock_movements returned no row');
  }
  return row;
}

/** The location a single-sided entry's balance delta applies at (decision 1: exactly one side). */
function balanceLocationId(entry: LedgerEntry): string {
  const locationId = entry.toLocationId ?? entry.fromLocationId;
  if (locationId === null) {
    // Unreachable once validateEntry has run — kept so this function has no silent non-null
    // assertion and stays correct if ever called on an entry that skipped validation.
    throw new Error('balanceLocationId: entry has neither fromLocationId nor toLocationId set');
  }
  return locationId;
}

/**
 * `pg_advisory_xact_lock` serializes concurrent first-ever postings to the SAME
 * (client, sku, location, batch) balance key so two concurrent "no row yet" postings (see
 * applyLockedBalanceDelta below) can never both attempt the fallback INSERT at once. The lock is
 * transaction-scoped (`_xact_`) and always released at commit/rollback, never held past this
 * mechanism's own transaction.
 *
 * CALLERS MUST ACQUIRE ALL OF A TRANSACTION'S BALANCE LOCKS UP FRONT, IN SORTED ORDER (see
 * postTransfer, which touches two keys in one transaction) — real Postgres locks, acquired in an
 * order that can differ between concurrent transactions, can deadlock; a fixed, sorted acquisition
 * order makes a circular wait impossible regardless of what order callers construct entries in.
 */
async function lockBalanceRow(tx: NodePgDatabase, balanceKeyText: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${balanceKeyText}, 0))`);
}

/**
 * pg-reviewer slice-close round 2 finding 1 (doc 40 P4 / INV-C3-2): every posting (postMovement,
 * postTransfer, reverseMovement) takes THIS key's advisory lock in SHARED mode, for every distinct
 * (client, sku) pair it touches, BEFORE the existing per-balance-key locks (lockBalanceRow) below —
 * shared locks never block each other, so concurrent postings still run concurrently. rebuildBalance
 * takes the SAME key in EXCLUSIVE mode (rebuild-balance.ts) before folding the ledger: that waits
 * for every posting already in flight for the pair to commit, and blocks any new posting (this
 * function) from starting until the rebuild itself commits or rolls back — so a rebuild's fold can
 * never be torn against an in-flight posting. Distinct pairs are locked in SORTED order, same
 * deadlock-avoidance principle as lockBalanceRow's own "acquire in a fixed order" contract.
 */
async function lockRebuildKeysShared(
  tx: NodePgDatabase,
  pairs: ReadonlyArray<{ readonly clientId: string; readonly skuId: string }>,
): Promise<void> {
  const keys = [...new Set(pairs.map((pair) => balanceRebuildLockKey(pair.clientId, pair.skuId)))].sort();
  for (const key of keys) {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`);
  }
}


/**
 * pg-reviewer fix round 1 finding F2: true only for the SQLSTATE `wms.check_location_limits`
 * itself raises (`RAISE EXCEPTION` with no explicit SQLSTATE defaults to P0001, "raise_exception")
 * — walked through the `cause` chain the same way isNegativeStockViolation does above, bounded by
 * `seen` against a cyclic chain. Any OTHER error (a connection failure, a different constraint, a
 * programming mistake) is rethrown unchanged by the caller, never folded into
 * LocationLimitExceededError.
 */
function isCheckLocationLimitsViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = 'code' in current ? current.code : undefined;
    if (code === 'P0001') {
      return true;
    }
    current = current.cause;
  }

  return false;
}

/**
 * WBS 2.4 (D1-D4): enforces a location's max_weight_kg/max_volume_cbm and is_blocked flag on the
 * RESULTING load — existing wms.stock_balance (all clients/SKUs) plus the incoming qty (D2) — for
 * a single ledger entry that ADDS stock to a location (entry.toLocationId set). A no-op for an
 * entry that only removes stock (toLocationId null) — decision D1 only enforces on the ADDING
 * side. Called BEFORE the ledger insert, inside the same transaction, by every caller
 * (postMovement, both legs of postTransfer, and reverseMovement, via checkLocationLimitsForEntries).
 *
 * D4: takes `pg_advisory_xact_lock` keyed on the location (locationLimitLockKey, hashed the same
 * way lockBalanceRow/lockRebuildKeysShared hash their own keys) BEFORE reading the current load —
 * this is the FIRST statement below — so two concurrent put-aways into the same location that
 * together exceed the limit are serialised: the second waits for the first's transaction to
 * commit or roll back, then reads the (now updated, or reverted) load itself.
 *
 * Three steps after the lock: read the location row, compute the resulting weight/volume and the
 * exceeds/missing-dimension flags in one load query (D5: the arithmetic runs in SQL, on numeric columns — never JS float) against the
 * location and SKU rows AS OF right now, inside this locked transaction. That computed state — not
 * a parse of `wms.check_location_limits`'s Arabic exception text (D2: "rather than by parsing
 * Arabic exception text") — is what selects LocationBlockedError vs LocationLimitExceededError.
 * For storage locations only (hasWeightVolumeLimits: pallet/shelf — operational locations skip
 * it, F9 scope), `wms.check_location_limits` (019:343-365) is then called as the final barrier
 * (D2). If it raises its own `raise exception` (SQLSTATE P0001) despite every check above passing,
 * that is mapped to LocationLimitExceededError, wrapping the original cause; any other error
 * (connection, timeout, cancellation, missing grant) is rethrown unchanged (F2).
 */
async function checkLocationLimits(
  tx: NodePgDatabase,
  params: { readonly toLocationId: string; readonly skuId: string; readonly qty: Quantity },
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${locationLimitLockKey(params.toLocationId)}, 0))`,
  );

  const locationResult = await tx.execute<{
    readonly location_code: string;
    readonly location_type: string;
    readonly is_blocked: boolean;
    readonly block_reason: string | null;
  }>(sql`
    select code as location_code, location_type, is_blocked, block_reason
      from wms.locations
     where id = ${params.toLocationId}::uuid
  `);

  const location = locationResult.rows[0];
  if (!location) {
    throw new Error(
      `checkLocationLimits: no wms.locations row for id ${params.toLocationId} ` +
        `(Allowed: the id of an existing wms.locations row)`,
    );
  }

  // pg-reviewer fix round 2 (Master decision, F7): the exact arithmetic — the resulting load and
  // the > comparisons against max_weight_kg/max_volume_cbm — stays in SQL, on numeric columns
  // (Quantity cannot represent volume_cbm's precision, see domain.ts's evaluateLocationLimits
  // comment); this query only computes the booleans the pure decision function consumes.
  const result = await tx.execute<{
    readonly max_weight_kg: string | null;
    readonly max_volume_cbm: string | null;
    readonly has_max_weight: boolean;
    readonly has_max_volume: boolean;
    readonly sku_has_weight: boolean;
    readonly sku_has_volume: boolean;
    readonly resulting_weight_kg: string;
    readonly resulting_volume_cbm: string;
    readonly weight_exceeds: boolean;
    readonly volume_exceeds: boolean;
  }>(sql`
    select
      l.max_weight_kg::text as max_weight_kg,
      l.max_volume_cbm::text as max_volume_cbm,
      (l.max_weight_kg is not null) as has_max_weight,
      (l.max_volume_cbm is not null) as has_max_volume,
      (s.gross_weight_kg is not null) as sku_has_weight,
      (s.volume_cbm is not null) as sku_has_volume,
      (coalesce(agg.weight_kg, 0) + (${params.qty.toString()}::numeric * coalesce(s.gross_weight_kg, 0)))::text
        as resulting_weight_kg,
      (coalesce(agg.volume_cbm, 0) + (${params.qty.toString()}::numeric * coalesce(s.volume_cbm, 0)))::text
        as resulting_volume_cbm,
      coalesce(
        (coalesce(agg.weight_kg, 0) + (${params.qty.toString()}::numeric * coalesce(s.gross_weight_kg, 0))) > l.max_weight_kg,
        false)
        as weight_exceeds,
      coalesce(
        (coalesce(agg.volume_cbm, 0) + (${params.qty.toString()}::numeric * coalesce(s.volume_cbm, 0))) > l.max_volume_cbm,
        false)
        as volume_exceeds
    from wms.locations l
    cross join wms.skus s
    left join lateral (
      select sum(sb.qty_on_hand * coalesce(sk.gross_weight_kg, 0)) as weight_kg,
             sum(sb.qty_on_hand * coalesce(sk.volume_cbm, 0)) as volume_cbm
        from wms.stock_balance sb
        join wms.skus sk on sk.id = sb.sku_id
       where sb.location_id = l.id
    ) agg on true
    where l.id = ${params.toLocationId}::uuid and s.id = ${params.skuId}::uuid
  `);

  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `checkLocationLimits: no row for location ${params.toLocationId} / sku ${params.skuId} ` +
        `(Allowed: an existing wms.locations id and an existing wms.skus id)`,
    );
  }

  const verdict = evaluateLocationLimits({
    locationType: location.location_type,
    isBlocked: location.is_blocked,
    hasMaxWeight: row.has_max_weight,
    hasMaxVolume: row.has_max_volume,
    skuHasWeight: row.sku_has_weight,
    skuHasVolume: row.sku_has_volume,
    weightExceeds: row.weight_exceeds,
    volumeExceeds: row.volume_exceeds,
  });

  if (!verdict.ok) {
    switch (verdict.reason) {
      case 'blocked':
        throw new LocationBlockedError(
          `location ${location.location_code} is blocked (${location.block_reason ?? '—'}) ` +
            `(wms.locations.is_blocked; wms.check_location_limits, 019:351-353). ` +
            `(Allowed: a destination location with is_blocked = false)`,
        );
      case 'missing_weight':
        throw new LocationLimitExceededError(
          `sku ${params.skuId} has no gross_weight_kg, but location ${location.location_code} has ` +
            `max_weight_kg = ${row.max_weight_kg} kg set — a hard barrier can't be verified ` +
            `without a number (D3). (Allowed: a SKU with gross_weight_kg set)`,
        );
      case 'missing_volume':
        throw new LocationLimitExceededError(
          `sku ${params.skuId} has no volume_cbm, but location ${location.location_code} has ` +
            `max_volume_cbm = ${row.max_volume_cbm} m3 set — a hard barrier can't be verified ` +
            `without a number (D3). (Allowed: a SKU with volume_cbm set)`,
        );
      case 'over_weight':
        throw new LocationLimitExceededError(
          `location ${location.location_code} allows max_weight_kg = ${row.max_weight_kg} kg; the ` +
            `resulting load would be ${row.resulting_weight_kg} kg (19 §3-3 hard barrier, no ` +
            `warning). (Allowed: a resulting load <= max_weight_kg)`,
        );
      case 'over_volume':
        throw new LocationLimitExceededError(
          `location ${location.location_code} allows max_volume_cbm = ${row.max_volume_cbm} m3; ` +
            `the resulting volume would be ${row.resulting_volume_cbm} m3 (19 §3-3 hard barrier, ` +
            `no warning). (Allowed: a resulting volume <= max_volume_cbm)`,
        );
    }
  }

  // F9 (Master decision): wms.check_location_limits is the final barrier for pallet/shelf
  // locations only (verdict.ok is true here, so this location is either blocked-exempt by type or
  // a passing pallet/shelf check) — operational locations are never weight/volume-checked (D1/D3
  // scope), so the barrier is skipped for them. F2: ONLY its own SQLSTATE P0001 (`raise exception`,
  // no explicit code) is mapped to LocationLimitExceededError; any other error is rethrown
  // unchanged, never folded into a false "limit exceeded".
  if (!hasWeightVolumeLimits(location.location_type)) {
    return;
  }

  try {
    await tx.execute(sql`
      select wms.check_location_limits(
        ${params.toLocationId}::uuid, ${row.resulting_weight_kg}::numeric, ${row.resulting_volume_cbm}::numeric)
    `);
  } catch (error) {
    if (isCheckLocationLimitsViolation(error)) {
      throw new LocationLimitExceededError(
        `wms.check_location_limits rejected location ${location.location_code} despite passing ` +
          `every pre-check above — treated as a limit violation (D2's final barrier). ` +
          `(Allowed: wms.check_location_limits accepting this location/weight/volume)`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** WBS 2.4 (D1): runs checkLocationLimits for every entry in `entries` that ADDS stock
 *  (toLocationId set) — a no-op for an entry that only removes stock. Callers (postMovement,
 *  postTransfer, reverseMovement) run this BEFORE any ledger insert in the transaction. */
async function checkLocationLimitsForEntries(
  tx: NodePgDatabase,
  entries: readonly LedgerEntry[],
): Promise<void> {
  for (const entry of entries) {
    if (entry.toLocationId !== null) {
      await checkLocationLimits(tx, {
        toLocationId: entry.toLocationId,
        skuId: entry.skuId,
        qty: entry.qty,
      });
    }
  }
}

/**
 * decision 2/3: NOT `insert … on conflict (…) do update` (the brief's suggested SQL shape) — that
 * shape is provably broken for a delta that can be negative against a CHECK constraint like
 * `no_negative_stock`: Postgres validates the INSERT branch's OWN candidate row (the raw,
 * un-added `qty_on_hand` value from VALUES/EXCLUDED) BEFORE it ever probes the unique index for a
 * conflict, so a negative delta fails the check even when a conflicting row with ample balance
 * already exists — confirmed directly against this schema's `no_negative_stock` constraint (not a
 * drizzle artifact: reproduced with a bare `pg` client, no ORM involved). `qty_on_hand` isn't
 * itself part of the arbiter, only the four key columns are, but Postgres still runs
 * ExecConstraints on the prepared INSERT tuple ahead of conflict resolution — so this is a genuine
 * Postgres behaviour this mechanism must route around, not a coding mistake to "fix" by tweaking
 * SQL syntax.
 *
 * This instead does a real UPDATE first — whose constraint check runs against the ACTUAL final
 * `qty_on_hand` (existing + delta), which is exactly what decision 3 wants enforced — and only
 * INSERTs when no row exists yet (in which case the raw delta genuinely IS the whole balance, and
 * a negative one is correctly rejected). The caller must already hold this key's advisory lock
 * (lockBalanceRow) before calling this. `qty_allocated` is never referenced here — untouched by
 * either branch (2.11's concern, not 2.8's).
 */
async function applyLockedBalanceDelta(
  tx: NodePgDatabase,
  entry: LedgerEntry,
  occurredAt: Date,
): Promise<void> {
  const locationId = balanceLocationId(entry);
  const signedDelta = entry.toLocationId !== null ? entry.qty : entry.qty.negate();

  try {
    const updateResult = await tx.execute(sql`
      update wms.stock_balance
         set qty_on_hand = qty_on_hand + ${signedDelta.toString()}::numeric,
             last_movement_at = ${occurredAt.toISOString()}::timestamptz
       where client_id = ${entry.clientId}::uuid and sku_id = ${entry.skuId}::uuid
         and location_id = ${locationId}::uuid and batch_no = ${entry.batchNo}
    `);

    if ((updateResult.rowCount ?? 0) === 0) {
      await tx.execute(sql`
        insert into wms.stock_balance (client_id, sku_id, location_id, batch_no, qty_on_hand, last_movement_at)
        values (${entry.clientId}::uuid, ${entry.skuId}::uuid, ${locationId}::uuid, ${entry.batchNo},
                ${signedDelta.toString()}::numeric, ${occurredAt.toISOString()}::timestamptz)
      `);
    }
  } catch (error) {
    if (isNegativeStockViolation(error)) {
      throw new NegativeStockError(
        `movement would drive qty_on_hand negative at location ${locationId} ` +
          `(01 wms.stock_balance constraint no_negative_stock). Allowed: a movement that leaves ` +
          `qty_on_hand >= 0 at that location/batch.`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** Locks, then applies, a single entry's balance delta — the one-entry case (postMovement,
 *  reverseMovement): no ordering hazard since only one key is ever locked in the transaction. */
async function lockAndApplyBalanceDelta(
  tx: NodePgDatabase,
  entry: LedgerEntry,
  occurredAt: Date,
): Promise<void> {
  const locationId = balanceLocationId(entry);
  await lockBalanceRow(tx, balanceKey(entry.clientId, entry.skuId, locationId, entry.batchNo));
  await applyLockedBalanceDelta(tx, entry, occurredAt);
}

/** decision 7 / G9: one outbox row for a posted movement, same correlationId as its audit row. */
async function writeMovementOutboxEvent(
  tx: NodePgDatabase,
  params: {
    readonly entityId: string;
    readonly movementRow: StoredMovementRow;
    readonly correlationId: string;
    readonly actorId: string | null;
  },
): Promise<void> {
  await writeOutboxEvent(tx, {
    entityId: params.entityId,
    aggregateType: STOCK_MOVEMENTS_AGGREGATE_TYPE,
    aggregateId: params.movementRow.id,
    eventType: STOCK_MOVED_EVENT_TYPE,
    payload: params.movementRow,
    correlationId: params.correlationId,
    actorId: params.actorId,
  });
}

/**
 * decision 7 / G9: one audit_log row for a posted movement, same correlationId as its outbox row.
 * ADR-0002 / doc 40 §B2: the audit row must be the LAST statement before commit — the caller is
 * responsible for calling this only after every ledger insert and balance-delta statement in the
 * same transaction has already run, so the global audit-chain advisory lock this insert takes is
 * never held while another row lock is still being acquired (the deadlock ADR-0002 fixes).
 */
async function writeMovementAuditRow(
  tx: NodePgDatabase,
  params: {
    readonly entityId: string;
    readonly movementRow: StoredMovementRow;
    readonly occurredAt: Date;
    readonly correlationId: string;
    readonly actorId: string | null;
  },
): Promise<void> {
  const actorType = params.actorId === null ? AUDIT_ACTOR_TYPE_SYSTEM : AUDIT_ACTOR_TYPE_USER;
  await tx.execute(sql`
    insert into platform.audit_log
      (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation,
       new_value, correlation_id)
    values
      (${params.occurredAt.toISOString()}::timestamptz, ${params.actorId}::uuid,
       ${actorType}, ${params.entityId}::uuid, ${AUDIT_SCHEMA_NAME}, ${AUDIT_TABLE_NAME},
       ${params.movementRow.id}::uuid, ${AUDIT_OPERATION_INSERT},
       ${JSON.stringify(params.movementRow)}::jsonb, ${params.correlationId}::uuid)
  `);
}

/** decision 7: one outbox row + one audit_log row per posted movement, same correlationId (G9).
 *  Used by postMovement/reverseMovement, where there is only ever one entry in the transaction —
 *  ledger insert and balance delta have already run before this is called, so outbox-then-audit
 *  here already satisfies ADR-0002's "audit row last" rule (the audit insert IS the last
 *  statement). postTransfer (two entries) does NOT use this helper — see its own comment. */
async function writeMovementEventAndAudit(
  tx: NodePgDatabase,
  params: {
    readonly entityId: string;
    readonly movementRow: StoredMovementRow;
    readonly occurredAt: Date;
    readonly correlationId: string;
    readonly actorId: string | null;
  },
): Promise<void> {
  await writeMovementOutboxEvent(tx, params);
  await writeMovementAuditRow(tx, params);
}

/**
 * Fix round 1 (Master decision, WBS 2.9): the transaction-scoped variant — everything
 * `postMovement` does (same lock order: shared rebuild lock -> location limits -> the balance
 * lock -> audit), but against a CALLER-SUPPLIED, already-open `tx` instead of opening its own via
 * withContext. This is what lets a caller (e.g. modules/wms/application/receive-inbound/
 * receive-line.ts) compose a ledger posting into ONE transaction alongside its own reads/writes,
 * instead of the ledger post committing as a separate transaction. `postMovement` below is now a
 * thin wrapper over this function.
 */
export async function postMovementInTx(
  tx: NodePgDatabase,
  input: PostMovementInput,
  actorId: string | null,
  deps: LedgerDeps,
): Promise<PostedMovement> {
  validateEntry(input.entry);

  // pg-reviewer slice-close round 2 finding 1: shared rebuild-key lock FIRST, before any of this
  // transaction's per-balance-key locks (see lockRebuildKeysShared's own comment for the protocol).
  await lockRebuildKeysShared(tx, [{ clientId: input.entry.clientId, skuId: input.entry.skuId }]);

  // WBS 2.4 (D1): enforced BEFORE the ledger insert, in the same transaction — a no-op unless
  // input.entry.toLocationId is set (see checkLocationLimitsForEntries).
  await checkLocationLimitsForEntries(tx, [input.entry]);

  const occurredAt = deps.clock.now();
  const row = await insertMovementRow(tx, {
    entityId: input.entityId,
    entry: input.entry,
    occurredAt,
    performedBy: input.performedBy,
    refTable: input.refTable ?? null,
    refId: input.refId ?? null,
    reasonCode: input.reasonCode ?? null,
    deviceId: input.deviceId ?? null,
  });

  await lockAndApplyBalanceDelta(tx, input.entry, occurredAt);
  await writeMovementEventAndAudit(tx, {
    entityId: input.entityId,
    movementRow: row,
    occurredAt,
    correlationId: input.correlationId,
    actorId,
  });

  return { movementIds: [row.id], correlationId: input.correlationId };
}

/** Posts one ledger row for `input.entry`. Throws before any DB call for an invalid entry. Thin
 *  wrapper: opens its own transaction and delegates to postMovementInTx (fix round 1). */
export async function postMovement(
  ctx: WithContextCtx,
  input: PostMovementInput,
  deps: LedgerDeps,
): Promise<PostedMovement> {
  validateEntry(input.entry);
  return withContext(ctx, (tx) => postMovementInTx(tx, input, ctx.userId, deps));
}

/**
 * decision 1: a transfer is two single-sided rows in one transaction — an out-row at
 * `fromLocationId` and an in-row at `toLocationId`, same client/sku/qty/batch/uom, both
 * movementType 'transfer', sharing ref_table/ref_id (whatever `input` carries) and correlationId.
 */
export type PostTransferInput = Omit<PostMovementInput, 'entry'> & {
  readonly base: Parameters<typeof planTransfer>[0];
  readonly fromLocationId: string;
  readonly toLocationId: string;
};

/** Fix round 1 (Master decision, WBS 2.9): the transaction-scoped variant of postTransfer — same
 *  lock order (shared rebuild lock -> location limits -> sorted balance locks -> audit last, per
 *  ADR-0002), against a caller-supplied `tx`. postTransfer below is now a thin wrapper. */
export async function postTransferInTx(
  tx: NodePgDatabase,
  input: PostTransferInput,
  actorId: string | null,
  deps: LedgerDeps,
): Promise<PostedMovement> {
  const [outEntry, inEntry] = planTransfer(input.base, input.fromLocationId, input.toLocationId);
  validateEntry(outEntry);
  validateEntry(inEntry);

  // pg-reviewer slice-close round 2 finding 1: shared rebuild-key lock FIRST, before any of this
  // transaction's per-balance-key locks below (see lockRebuildKeysShared's own comment for the
  // protocol). decision 1: both entries share the same client/sku, so this is a single key —
  // written as a pair list (and deduplicated by lockRebuildKeysShared) so it stays correct if a
  // transfer ever spans SKUs.
  await lockRebuildKeysShared(tx, [
    { clientId: outEntry.clientId, skuId: outEntry.skuId },
    { clientId: inEntry.clientId, skuId: inEntry.skuId },
  ]);

  // WBS 2.4 (D1): enforced BEFORE either leg's ledger insert, in the same transaction — a no-op
  // for outEntry (toLocationId null, decision 1); throwing here rolls back the whole transfer, so
  // neither leg is written (checkLocationLimitsForEntries's own comment / D1 "atomically").
  await checkLocationLimitsForEntries(tx, [outEntry, inEntry]);

  const occurredAt = deps.clock.now();

  // Both entries' balance locks are acquired up front, in SORTED key order (lockBalanceRow's own
  // contract) — never in "out row, then in row" order, which would let a concurrent transfer in
  // the opposite direction acquire the same two locks in the reverse order and deadlock.
  const lockKeys = [outEntry, inEntry]
    .map((entry) => balanceKey(entry.clientId, entry.skuId, balanceLocationId(entry), entry.batchNo))
    .sort();
  for (const key of lockKeys) {
    await lockBalanceRow(tx, key);
  }

  // ADR-0002 / doc 40 §B2: the audit row must be the LAST statement before commit. Writing the
  // out-entry's ledger+balance+outbox+audit, THEN the in-entry's balance update, would take the
  // global audit-chain advisory lock (the out-entry's audit insert) and only afterwards try to
  // acquire the in-entry's balance row lock — exactly the lock-order inversion ADR-0002 forbids
  // (observed as a live deadlock in a shared-DB full run). Instead: every ledger insert and
  // balance-delta statement for BOTH entries runs first; only once all of them have completed do
  // the outbox events get written (outbox before audit is fine — it takes no chain-wide lock),
  // and the audit_log rows are written last of all, so no row lock is ever acquired after the
  // audit-chain lock is taken.
  const rows: StoredMovementRow[] = [];
  for (const entry of [outEntry, inEntry]) {
    const row = await insertMovementRow(tx, {
      entityId: input.entityId,
      entry,
      occurredAt,
      performedBy: input.performedBy,
      refTable: input.refTable ?? null,
      refId: input.refId ?? null,
      reasonCode: input.reasonCode ?? null,
      deviceId: input.deviceId ?? null,
    });

    await applyLockedBalanceDelta(tx, entry, occurredAt);
    rows.push(row);
  }

  for (const row of rows) {
    await writeMovementOutboxEvent(tx, {
      entityId: input.entityId,
      movementRow: row,
      correlationId: input.correlationId,
      actorId,
    });
  }

  for (const row of rows) {
    await writeMovementAuditRow(tx, {
      entityId: input.entityId,
      movementRow: row,
      occurredAt,
      correlationId: input.correlationId,
      actorId,
    });
  }

  return { movementIds: rows.map((row) => row.id), correlationId: input.correlationId };
}

/**
 * decision 1: a transfer is two single-sided rows in one transaction — an out-row at
 * `fromLocationId` and an in-row at `toLocationId`, same client/sku/qty/batch/uom, both
 * movementType 'transfer', sharing ref_table/ref_id (whatever `input` carries) and correlationId.
 * Thin wrapper: opens its own transaction and delegates to postTransferInTx (fix round 1).
 */
export async function postTransfer(
  ctx: WithContextCtx,
  input: PostTransferInput,
  deps: LedgerDeps,
): Promise<PostedMovement> {
  return withContext(ctx, (tx) => postTransferInTx(tx, input, ctx.userId, deps));
}

/**
 * decision 5: posts a single counter-entry (movementType 'adjust') for the original movement — the
 * original row is never updated or deleted. Reversing a reversal is allowed. An unknown
 * `movementId` throws MovementNotFoundError (the lookup runs inside the transaction, so nothing is
 * written and the transaction rolls back with no side effect).
 */
export async function reverseMovement(
  ctx: WithContextCtx,
  input: {
    readonly movementId: string;
    readonly correlationId: string;
    readonly performedBy: string;
  },
  deps: LedgerDeps,
): Promise<PostedMovement> {
  return withContext(ctx, async (tx) => {
    const originalResult = await tx.execute<{
      readonly id: string;
      readonly entity_id: string;
      readonly movement_type: string;
      readonly client_id: string;
      readonly sku_id: string;
      readonly from_location_id: string | null;
      readonly to_location_id: string | null;
      readonly qty: string;
      readonly uom: string;
      readonly batch_no: string | null;
    }>(sql`
      select id, entity_id, movement_type, client_id, sku_id, from_location_id, to_location_id,
             qty::text as qty, uom, batch_no
        from wms.stock_movements
       where id = ${input.movementId}::uuid
    `);

    const original = originalResult.rows[0];
    if (!original) {
      throw new MovementNotFoundError(input.movementId);
    }

    const originalEntry: LedgerEntry = {
      clientId: original.client_id,
      skuId: original.sku_id,
      fromLocationId: original.from_location_id,
      toLocationId: original.to_location_id,
      qty: Quantity.of(original.qty),
      batchNo: original.batch_no ?? '',
      movementType: original.movement_type as MovementType,
      uom: original.uom,
    };
    const reversalEntry = planReversal(originalEntry);
    validateEntry(reversalEntry);

    // pg-reviewer slice-close round 2 finding 1: shared rebuild-key lock FIRST, before the
    // per-balance-key lock below (see lockRebuildKeysShared's own comment for the protocol) — taken
    // only now because the (client, sku) pair isn't known until the original row above is read.
    await lockRebuildKeysShared(tx, [
      { clientId: reversalEntry.clientId, skuId: reversalEntry.skuId },
    ]);

    // pg-reviewer fix round 1 finding F1: planReversal swaps from/to, so a reversal CAN add stock
    // to a location (reversing an outbound entry) — enforced the same as postMovement/postTransfer,
    // before the ledger insert, in the same lock order (shared rebuild lock -> location lock ->
    // sorted balance locks -> audit).
    await checkLocationLimitsForEntries(tx, [reversalEntry]);

    const occurredAt = deps.clock.now();
    const row = await insertMovementRow(tx, {
      entityId: original.entity_id,
      entry: reversalEntry,
      occurredAt,
      performedBy: input.performedBy,
      refTable: REVERSAL_REF_TABLE,
      refId: original.id,
      reasonCode: REVERSAL_REASON_CODE,
      deviceId: null,
    });

    await lockAndApplyBalanceDelta(tx, reversalEntry, occurredAt);
    await writeMovementEventAndAudit(tx, {
      entityId: original.entity_id,
      movementRow: row,
      occurredAt,
      correlationId: input.correlationId,
      actorId: ctx.userId,
    });

    return { movementIds: [row.id], correlationId: input.correlationId };
  });
}
