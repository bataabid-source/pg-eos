// modules/billing/infrastructure/record-billable-event/repository.ts — WBS 4.2 (lane 2).
//
// RESCOPED (Master ruling, round-1 review finding 1 — FINAL, D-186 two-round cap): 01-Data-
// Model.sql:1047's comment says `billing.billable_events` is "generated automatically from domain
// events. No manual entry (P10)" — there is no CFO-invoked application command for this table. 4.2
// delivers ONLY this repository insert function: the PORT WBS 4.3's future system-actor subscribers
// will call directly (no application layer above it, no api/ wiring, no CFO role gate, no caller
// identity). `insertBillableEvent` runs entirely INSIDE the `tx` a caller's own withContext(ctx, fn)
// already opened — RLS's own entity_scope policies govern every read/write here.
//
// STEP ORDER (docs/notes/slice-briefs/_slice-4.2.brief.md, D1/D2):
//   1. assertBillableSourceTable(sourceTable) (round-1 finding 3, ../../domain/record-billable-event/
//      invariants.ts) -> InvalidSourceTableError (422) BEFORE sourceTable is ever interpolated as a
//      table identifier — narrows `sourceTable` to the closed-list union `BillableSourceTable`, so
//      the `sql.raw()` use below is type-safe, not just runtime-checked.
//   2. assertPositiveQty(qty) (round-1 finding 2: rejects NaN/Infinity/zero/negative; WBS 4.2 part 2:
//      `qty` is an exact decimal `numeric(14,3)` STRING validated via `Quantity.of(qty).isPositive()`,
//      never a JS `number`) -> NonPositiveQtyError (422). `billing.billable_events` has no DB CHECK
//      on qty (brief Facts) — this is the ONLY enforcement.
//   3. getSourceRow — resolve entity_id/client_id THROUGH the SOURCE ROW named by (sourceTable,
//      sourceId) — never caller-supplied. A missing/invisible source row -> SourceEventNotFoundError.
//   4. assertClientMatches(sourceRow.clientId, clientId) -> ClientMismatchError (422).
//   5. D2 domain-level pre-check (best-effort; the DB's own unique index, caught below, is the real
//      race-safe backstop) -> DuplicateBillableEventError.
//   6. INSERT billing.billable_events (status='pending', every commercial column null — pricing is
//      out of scope this slice). A 23505 on the pre-existing unique index (13B ق-38) is caught by
//      constraint name and re-thrown as DuplicateBillableEventError.
//   7. ONE platform.outbox row (Master ruling — supersedes the original "no outbox" D1 reading),
//      via @pg-eos/events's writeOutboxEvent, SAME transaction.
//   8. ONE platform.audit_log row, SAME transaction (G9 pairing discipline) — last.
//
// Outbox event name: `billing.billable_event.recorded` — granted by the Master, packages/events/
// catalog.ts commit 7e7e91e, doc 40 §B3 <module>.<aggregate>.<past_tense> naming (precedent:
// `hr.employee_document.recorded`). `eventType` stays an explicit parameter (typed
// `CatalogedEventType`, defaulting to the granted name) so WBS 4.3 can override it once it needs a
// more specific event of its own, without changing this function's shape.

const BILLING_SCHEMA = 'billing';
const BILLABLE_EVENTS_TABLE_NAME = 'billable_events';
const BILLABLE_EVENTS_TABLE = `${BILLING_SCHEMA}.${BILLABLE_EVENTS_TABLE_NAME}`;
const BILLABLE_EVENTS_AGGREGATE_TYPE = BILLABLE_EVENTS_TABLE;
const AUDIT_ACTOR_TYPE_USER = 'user';
const AUDIT_ACTOR_TYPE_SYSTEM = 'system'; // decision 7 precedent (wms/src/stock-ledger/post-movement.ts): actorId === null -> 'system'.
const AUDIT_OPERATION_INSERT = 'insert';
const STATUS_PENDING = 'pending'; // the column's own DEFAULT — exported for test assertions.

// D2/13B ق-38: the pre-existing unique index's own (Postgres-generated) name — a unique_violation
// (SQLSTATE 23505) on it is the real, race-safe backstop behind the domain-level pre-check.
const UNIQUE_VIOLATION_SQLSTATE = '23505';
const DUPLICATE_TRIPLE_INDEX_NAME = 'billable_events_source_table_source_id_service_id_idx';

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

const BILLABLE_EVENT_RECORDED_EVENT_TYPE: CatalogedEventType = 'billing.billable_event.recorded';

import {
  assertBillableSourceTable,
  assertClientMatches,
  assertPositiveQty,
  isNonDuplicateTriple,
  type BillableEventTriple,
  type BillableSourceTable,
} from '../../domain/record-billable-event/invariants.js';
import { DuplicateBillableEventError, SourceEventNotFoundError } from '../../domain/record-billable-event/errors.js';

/** Walks `error`'s own cause chain for a Postgres error with the given SQLSTATE — same discipline
 *  as ../../../wms/infrastructure/manage-space/repository.ts's own findRaisedException. Returns
 *  the MATCHING error in the chain (never drizzle's own outer "Failed query: ..." wrapper). */
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

/** D1 (CORRECTED): `sourceTable` is ALWAYS the closed-list union `BillableSourceTable`, validated
 *  BEFORE this is called — safe to interpolate as a table identifier. RLS's own entity_scope policy
 *  on the source table governs visibility; a missing/invisible row returns `null`, never a guess. */
async function getSourceRow(
  tx: NodePgDatabase,
  sourceTable: BillableSourceTable,
  sourceId: string,
): Promise<{ readonly entityId: string; readonly clientId: string | null } | null> {
  const result = await tx.execute<{ entity_id: string; client_id: string | null }>(
    sql`select entity_id, client_id from ${sql.raw(sourceTable)} where id = ${sourceId}::uuid`,
  );
  const row = result.rows[0];
  if (!row) return null;
  return { entityId: row.entity_id, clientId: row.client_id };
}

/** D2's domain-level pre-check data — every existing row matching the candidate's own triple (at
 *  most one, given the DB's own unique index). Best-effort only. */
async function findMatchingTriples(
  tx: NodePgDatabase,
  candidate: BillableEventTriple,
): Promise<readonly BillableEventTriple[]> {
  const result = await tx.execute<{ source_table: string; source_id: string; service_id: string }>(sql`
    select source_table, source_id::text as source_id, service_id::text as service_id
      from ${sql.raw(BILLABLE_EVENTS_TABLE)}
     where source_table = ${candidate.sourceTable} and source_id = ${candidate.sourceId}::uuid
       and service_id = ${candidate.serviceId}::uuid
  `);
  return result.rows.map((row) => ({
    sourceTable: row.source_table,
    sourceId: row.source_id,
    serviceId: row.service_id,
  }));
}

async function writeAuditRow(
  tx: NodePgDatabase,
  params: {
    readonly entityId: string;
    readonly recordId: string;
    readonly correlationId: string;
    readonly actorId: string | null;
    readonly newValue: unknown;
    readonly occurredAt: Date;
  },
): Promise<void> {
  const actorType = params.actorId === null ? AUDIT_ACTOR_TYPE_SYSTEM : AUDIT_ACTOR_TYPE_USER;
  await tx.execute(sql`
    insert into platform.audit_log
      (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation,
       new_value, correlation_id)
    values
      (${params.occurredAt.toISOString()}::timestamptz, ${params.actorId}::uuid, ${actorType},
       ${params.entityId}::uuid, ${BILLING_SCHEMA}, ${BILLABLE_EVENTS_TABLE_NAME}, ${params.recordId}::uuid,
       ${AUDIT_OPERATION_INSERT}, ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

export interface InsertBillableEventParams {
  readonly occurredAt: string;
  readonly clientId: string;
  readonly contractId?: string | null;
  readonly serviceId: string;
  /** WBS 4.2 part 2: exact decimal `numeric(14,3)` text, never a JS `number` — see
   *  ../../domain/record-billable-event/invariants.ts's `assertPositiveQty`. */
  readonly qty: string;
  readonly uom: string;
  readonly sourceModule: string;
  readonly sourceTable: string;
  readonly sourceId: string;
  readonly isIntercompany?: boolean;
  readonly counterpartyEntityId?: string | null;
  readonly correlationId: string;
  /** D1: no caller identity this slice — a system-actor call carries `null` (audit_log's
   *  actor_type becomes 'system'); a future human-triggered caller may pass a userId. */
  readonly actorId?: string | null;
}

/**
 * The port WBS 4.3's system-actor subscribers will call directly, inside the SAME `tx` their own
 * withContext(ctx, fn) already opened. Validates (closed-list sourceTable, client-match, finite
 * positive qty), resolves the source row, INSERTs one `billing.billable_events` row at
 * `status='pending'`, and writes ONE `platform.outbox` row + ONE `platform.audit_log` row in the
 * SAME transaction (G9 pairing discipline).
 *
 * `eventType` defaults to `billing.billable_event.recorded` (the granted catalog entry) — WBS 4.3
 * may override it once it needs a more specific event of its own.
 */
export async function insertBillableEvent(
  tx: NodePgDatabase,
  params: InsertBillableEventParams,
  eventType: CatalogedEventType = BILLABLE_EVENT_RECORDED_EVENT_TYPE,
): Promise<{ readonly id: string; readonly status: string }> {
  // Step 1 — the closed list, BEFORE any read that would otherwise interpolate an unvalidated table
  // identifier. Narrows `params.sourceTable` to `BillableSourceTable`.
  assertBillableSourceTable(params.sourceTable);
  const sourceTable = params.sourceTable;

  // Step 2 — the ONLY qty enforcement (no DB CHECK); rejects NaN/Infinity too (round-1 finding 2).
  // Round-1 (part 2) finding 2: use the returned Quantity's CANONICAL `.toString()` form downstream
  // (SQL insert, outbox payload, audit new_value) — never `params.qty` (the caller's raw string),
  // since Quantity.of accepts non-canonical input (`'10'`, `'007'`) that numeric(14,3) stores
  // canonically (`10.000`, `7.000`).
  const qty = assertPositiveQty(params.qty).toString();

  // Step 3 — D1 CORRECTED: entity_id/client_id resolved THROUGH the source row, never caller-supplied.
  const sourceRow = await getSourceRow(tx, sourceTable, params.sourceId);
  if (!sourceRow) {
    throw new SourceEventNotFoundError(
      `RecordBillableEvent: no ${sourceTable} row visible for id ${params.sourceId}. ` +
        `(Allowed: an existing, RLS-visible source row)`,
    );
  }

  // Step 4.
  assertClientMatches(sourceRow.clientId, params.clientId);

  const candidateTriple: BillableEventTriple = {
    sourceTable,
    sourceId: params.sourceId,
    serviceId: params.serviceId,
  };

  // Step 5 — D2 domain-level pre-check (best-effort; the DB's own unique index, step 6, is the real
  // race-safe backstop).
  const existingTriples = await findMatchingTriples(tx, candidateTriple);
  if (!isNonDuplicateTriple(existingTriples, candidateTriple)) {
    throw new DuplicateBillableEventError(
      `RecordBillableEvent: a ${BILLABLE_EVENTS_TABLE} row already exists for (sourceTable=` +
        `${candidateTriple.sourceTable}, sourceId=${candidateTriple.sourceId}, serviceId=` +
        `${candidateTriple.serviceId}). (Allowed: one billable event per (source_table, source_id, ` +
        `service_id) triple)`,
    );
  }

  const contractId = params.contractId ?? null;
  const isIntercompany = params.isIntercompany ?? false;
  const counterpartyEntityId = params.counterpartyEntityId ?? null;
  const actorId = params.actorId ?? null;

  // Step 6 — the INSERT. Every commercial column stays null (pricing happens later, out of scope).
  let result;
  try {
    result = await tx.execute<{ id: string; status: string }>(sql`
      insert into ${sql.raw(BILLABLE_EVENTS_TABLE)}
        (entity_id, occurred_at, client_id, contract_id, service_id, qty, uom, source_module,
         source_table, source_id, is_intercompany, counterparty_entity_id)
      values
        (${sourceRow.entityId}::uuid, ${params.occurredAt}::timestamptz, ${params.clientId}::uuid,
         ${contractId}::uuid, ${params.serviceId}::uuid, ${qty}::numeric, ${params.uom},
         ${params.sourceModule}, ${sourceTable}, ${params.sourceId}::uuid,
         ${isIntercompany}::boolean, ${counterpartyEntityId}::uuid)
      returning id, status
    `);
  } catch (error) {
    const raised = findRaisedException(error, UNIQUE_VIOLATION_SQLSTATE);
    if (raised && 'constraint' in raised && raised.constraint === DUPLICATE_TRIPLE_INDEX_NAME) {
      throw new DuplicateBillableEventError(
        `RecordBillableEvent: a ${BILLABLE_EVENTS_TABLE} row already exists for (source_table=` +
          `${sourceTable}, source_id=${params.sourceId}, service_id=${params.serviceId}). ` +
          `(Allowed: one billable event per (source_table, source_id, service_id) triple) — ${raised.message}`,
        { cause: error },
      );
    }
    throw error;
  }
  const row = result.rows[0];
  if (!row) throw new Error(`insert into ${BILLABLE_EVENTS_TABLE} returned no row`);

  const occurredAt = new Date(params.occurredAt);

  const newValue = {
    id: row.id,
    status: row.status,
    client_id: params.clientId,
    contract_id: contractId,
    service_id: params.serviceId,
    qty,
    uom: params.uom,
    source_module: params.sourceModule,
    source_table: sourceTable,
    source_id: params.sourceId,
    unit_price: null,
    price_source: null,
    price_ref_id: null,
    amount: null,
    exclusion_reason: null,
    invoice_line_id: null,
    is_intercompany: isIntercompany,
    counterparty_entity_id: counterpartyEntityId,
  };

  // Step 7 — ONE platform.outbox row, SAME transaction (Master ruling).
  await writeOutboxEvent(tx, {
    entityId: sourceRow.entityId,
    aggregateType: BILLABLE_EVENTS_AGGREGATE_TYPE,
    aggregateId: row.id,
    eventType,
    payload: newValue,
    correlationId: params.correlationId,
    actorId,
  });

  // Step 8 — ONE platform.audit_log row, SAME transaction (G9 pairing discipline), last.
  // unit_price/price_source/amount are `commercial`-classified and stay null on insert
  // (platform.sanitize_audit masks them regardless of the null value — the classification, not the
  // value, drives the mask).
  await writeAuditRow(tx, {
    entityId: sourceRow.entityId,
    recordId: row.id,
    correlationId: params.correlationId,
    actorId,
    newValue,
    occurredAt,
  });

  return { id: row.id, status: row.status };
}

export { BILLING_SCHEMA, BILLABLE_EVENTS_TABLE_NAME, BILLABLE_EVENTS_TABLE, STATUS_PENDING };
