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
//      no_negative_stock check (01:720, decision 3) is the only rejection authority — this
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
  planReversal,
  planTransfer,
  validateEntry,
  type LedgerEntry,
  type MovementType,
} from './domain.js';
import { MovementNotFoundError, NegativeStockError } from './errors.js';

// decision 1: SQLSTATE for a CHECK constraint violation (Postgres error class 23 — integrity
// constraint violation, code 23514) — the class the `no_negative_stock` check (01:720) raises.
const CHECK_VIOLATION_SQLSTATE = '23514';
// wms.stock_balance's own constraint name (01:720) — matched together with the SQLSTATE so no
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
          `(wms.stock_balance no_negative_stock check, 01:720)`,
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

/** decision 7: one outbox row + one audit_log row per posted movement, same correlationId (G9). */
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
  await writeOutboxEvent(tx, {
    entityId: params.entityId,
    aggregateType: STOCK_MOVEMENTS_AGGREGATE_TYPE,
    aggregateId: params.movementRow.id,
    eventType: STOCK_MOVED_EVENT_TYPE,
    payload: params.movementRow,
    correlationId: params.correlationId,
    actorId: params.actorId,
  });

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

/** Posts one ledger row for `input.entry`. Throws before any DB call for an invalid entry. */
export async function postMovement(
  ctx: WithContextCtx,
  input: PostMovementInput,
  deps: LedgerDeps,
): Promise<PostedMovement> {
  validateEntry(input.entry);

  return withContext(ctx, async (tx) => {
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
      actorId: ctx.userId,
    });

    return { movementIds: [row.id], correlationId: input.correlationId };
  });
}

/**
 * decision 1: a transfer is two single-sided rows in one transaction — an out-row at
 * `fromLocationId` and an in-row at `toLocationId`, same client/sku/qty/batch/uom, both
 * movementType 'transfer', sharing ref_table/ref_id (whatever `input` carries) and correlationId.
 */
export async function postTransfer(
  ctx: WithContextCtx,
  input: Omit<PostMovementInput, 'entry'> & {
    readonly base: Parameters<typeof planTransfer>[0];
    readonly fromLocationId: string;
    readonly toLocationId: string;
  },
  deps: LedgerDeps,
): Promise<PostedMovement> {
  const [outEntry, inEntry] = planTransfer(input.base, input.fromLocationId, input.toLocationId);
  validateEntry(outEntry);
  validateEntry(inEntry);

  return withContext(ctx, async (tx) => {
    const occurredAt = deps.clock.now();
    const movementIds: string[] = [];

    // Both entries' balance locks are acquired up front, in SORTED key order (lockBalanceRow's own
    // contract) — never in "out row, then in row" order, which would let a concurrent transfer in
    // the opposite direction acquire the same two locks in the reverse order and deadlock.
    const lockKeys = [outEntry, inEntry]
      .map((entry) => balanceKey(entry.clientId, entry.skuId, balanceLocationId(entry), entry.batchNo))
      .sort();
    for (const key of lockKeys) {
      await lockBalanceRow(tx, key);
    }

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
      await writeMovementEventAndAudit(tx, {
        entityId: input.entityId,
        movementRow: row,
        occurredAt,
        correlationId: input.correlationId,
        actorId: ctx.userId,
      });

      movementIds.push(row.id);
    }

    return { movementIds, correlationId: input.correlationId };
  });
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
