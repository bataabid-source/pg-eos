// modules/billing/tests/record-billable-event/record-billable-event.test.ts — WBS 4.2 (lane 2).
//
// RESCOPED (round-1 review finding 1, FINAL round under D-186): `01-Data-Model.sql:1047` — the
// table is "generated automatically from domain events. No manual entry (P10)". These are
// INTEGRATION tests of the infrastructure repository's `insertBillableEvent` port DIRECTLY — no
// application command, no HTTP handler, no CFO role gate, no Idempotency-Key (all deleted this
// round). One test per Scenario in ./record-billable-event.feature; every `describe` title below
// matches its Scenario title EXACTLY (round-1 finding 8).
//
// Sources: docs/notes/slice-briefs/_slice-4.2.brief.md (Facts/D1-D2, verbatim), doc 38 line 152,
// database/schema/01-Data-Model.sql:1048-1080,
// database/schema/13B-Schema-Reference-Consolidation.sql:2353-2356 + 4128-4132 (ق-38).
//
// ACTUAL SURFACE (as landed by pg-backend's parallel rewrite —
// modules/billing/infrastructure/record-billable-event/repository.ts):
//   export async function insertBillableEvent(
//     tx: NodePgDatabase,
//     params: InsertBillableEventParams, // sourceModule, sourceTable, sourceId, serviceId,
//                                         // clientId, qty, uom, occurredAt, correlationId, plus
//                                         // optional contractId/isIntercompany/
//                                         // counterpartyEntityId/actorId
//     eventType?: CatalogedEventType,
//   ): Promise<{ id: string; status: string }>
//   — runs INSIDE the `tx` the CALLER's own withContext(ctx, fn) already opened (this file opens
//   it, same as any other repository-level test), resolves entity_id/client_id by reading the
//   source row named by (sourceTable, sourceId), validates the closed list / client match / qty
//   (domain/, moved per round-1 finding 3), INSERTs at status='pending' with every commercial
//   column null, and writes ONE platform.outbox row + ONE platform.audit_log row in the SAME
//   transaction (Master ruling, G9 pairing).
//
// OUTBOX EVENT NAME — the granted catalog entry (Master ruling, packages/events/catalog.ts commit
// 7e7e91e): BILLING_EVENT_TYPE_RECORDED below matches the repository's own
// BILLABLE_EVENT_RECORDED_EVENT_TYPE default, `'billing.billable_event.recorded'` — a real granted
// `CatalogedEventType`, not a placeholder.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WithContextCtx } from '@pg-eos/db';
import { withContext } from '@pg-eos/db';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { CatalogedEventType } from '@pg-eos/events';

// The module under test.
import {
  insertBillableEvent,
  type InsertBillableEventParams,
} from '../../infrastructure/record-billable-event/repository.js';
import {
  ClientMismatchError,
  DuplicateBillableEventError,
  InvalidSourceTableError,
  NonPositiveQtyError,
  SourceEventNotFoundError,
} from '../../domain/record-billable-event/errors.js';

// Admin pool (PGUSER, bypasses RLS) — fixture setup/teardown/verification ONLY. The function under
// test (insertBillableEvent) opens its OWN withContext(ctx, fn) transaction internally, which binds
// to @pg-eos/db's own shared pool (PG_APP_USER, genuinely subject to RLS when set) — no dedicated
// "appPool" is needed in this file at all (round-1 finding 9: the old handler-era appPool was dead
// weight; this rewrite has no use for a second pool since there is no handler layer left to test).
const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

// --- literals ------------------------------------------------------------------------------

const STATUS_PENDING = 'pending';
const QTY_TEN = 10;
const SOURCE_MODULE_WMS = 'wms';
const SOURCE_TABLE = 'wms.inbound_orders'; // one of the closed list's five allowed values (brief D1).
const NOT_IN_CLOSED_LIST_SOURCE_TABLE = 'sales.contracts'; // not in the closed list — InvalidSourceTableError.
const UOM_UNIT = 'unit';
const SANITIZE_AUDIT_MASK = '•••'; // platform.sanitize_audit's own sentinel (13B:397-405).
const OCCURRED_AT = '2026-09-25T00:00:00.000Z';
// The granted catalog entry (see file header) — a real `CatalogedEventType`, not a placeholder.
const BILLING_EVENT_TYPE_RECORDED = 'billing.billable_event.recorded';
const BILLABLE_EVENTS_AGGREGATE_TYPE = 'billing.billable_events';

const OWNER_ACTOR_UUID = '00000000-0000-4000-8000-0000000402a1';
const OUTSIDER_ACTOR_UUID = '00000000-0000-4000-8000-0000000402a3'; // no user_entities row for `entityId`.

let entityId: string;
let outsiderEntityId: string;
let warehouseId: string;
let fixtureClientId: string;
let fixtureOtherClientId: string; // clientId-mismatch scenario — a DIFFERENT client than the source row's own.
let fixtureServiceId: string;
let fixtureServiceCategoryId: string;

const usedCorrelationIds = new Set<string>();
const fixtureEventIds: string[] = [];
const fixtureSourceOrderIds: string[] = []; // wms.inbound_orders rows seeded as REAL source rows.

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

function ctxFor(userId: string): WithContextCtx {
  return { userId, clientId: null, isInternal: true };
}

// Seeds a REAL wms.inbound_orders row — the source row that entity_id/client_id are resolved FROM.
// Tracked for afterAll cleanup.
async function createSourceInboundOrder(ownerEntityId: string, ownerClientId: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.inbound_orders (entity_id, doc_no, client_id, warehouse_id, status)
     values ($1, $2, $3, $4, 'draft') returning id`,
    [ownerEntityId, `_recbill-${randomUUID()}`, ownerClientId, warehouseId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture wms.inbound_orders insert returned no row');
  fixtureSourceOrderIds.push(row.id);
  return row.id;
}

// A REAL, RLS-visible source row under `entityId`/`fixtureClientId` — the happy-path fixture used
// by every scenario that is NOT itself testing entity/source resolution.
async function freshTriple(): Promise<{ sourceTable: string; sourceId: string; serviceId: string }> {
  const sourceId = await createSourceInboundOrder(entityId, fixtureClientId);
  return { sourceTable: SOURCE_TABLE, sourceId, serviceId: fixtureServiceId };
}

function baseInput(triple: { sourceTable: string; sourceId: string; serviceId: string }): InsertBillableEventParams {
  return {
    sourceModule: SOURCE_MODULE_WMS,
    sourceTable: triple.sourceTable,
    sourceId: triple.sourceId,
    serviceId: triple.serviceId,
    clientId: fixtureClientId,
    qty: QTY_TEN,
    uom: UOM_UNIT,
    occurredAt: OCCURRED_AT,
    correlationId: nextCorrelationId(),
  };
}

// Opens the SAME withContext(ctx, fn) transaction a real caller (WBS 4.3's future subscriber) would
// open, and calls insertBillableEvent inside it — the repository function itself takes the already-
// open `tx`, not a ctx (see file header, ACTUAL SURFACE).
async function callInsert(
  userId: string,
  input: InsertBillableEventParams,
  eventType?: CatalogedEventType,
): Promise<{ readonly id: string; readonly status: string }> {
  return withContext(ctxFor(userId), (tx: NodePgDatabase) => insertBillableEvent(tx, input, eventType));
}

async function createFixtureActor(userId: string, entityIds: readonly string[]): Promise<void> {
  await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
  await pool.query(`delete from identity.users where id = $1`, [userId]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [userId, `_recbill_fixture_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار تسجيل الحدث القابل للفوترة — WBS 4.2'],
  );
  for (const eid of entityIds) {
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, eid]);
  }
}

async function countEventsForTriple(triple: { sourceTable: string; sourceId: string; serviceId: string }): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from billing.billable_events
      where source_table = $1 and source_id = $2 and service_id = $3`,
    [triple.sourceTable, triple.sourceId, triple.serviceId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function getEvent(id: string): Promise<{
  status: string;
  entity_id: string;
  client_id: string;
  unit_price: string | null;
  price_source: string | null;
  amount: string | null;
}> {
  const result: QueryResult<{
    status: string;
    entity_id: string;
    client_id: string;
    unit_price: string | null;
    price_source: string | null;
    amount: string | null;
  }> = await pool.query(
    `select status, entity_id::text as entity_id, client_id::text as client_id,
            unit_price::text as unit_price, price_source, amount::text as amount
       from billing.billable_events where id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no billing.billable_events row for id ${id}`);
  return row;
}

async function auditRowForRecord(recordId: string): Promise<{
  correlation_id: string | null;
  new_value: Record<string, unknown> | null;
} | null> {
  const result: QueryResult<{ correlation_id: string | null; new_value: Record<string, unknown> | null }> = await pool.query(
    `select correlation_id::text as correlation_id, new_value
       from platform.audit_log
      where schema_name = 'billing' and table_name = 'billable_events' and record_id = $1`,
    [recordId],
  );
  return result.rows[0] ?? null;
}

async function outboxRowForCorrelation(correlationId: string): Promise<{
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
} | null> {
  const result: QueryResult<{ event_type: string; aggregate_type: string; aggregate_id: string }> = await pool.query(
    `select event_type, aggregate_type, aggregate_id::text as aggregate_id
       from platform.outbox where correlation_id = $1`,
    [correlationId],
  );
  return result.rows[0] ?? null;
}

async function outboxCountForCorrelation(correlationId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.outbox where correlation_id = $1`,
    [correlationId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  entityId = (entityResult.rows[0] as { id: string }).id;

  const outsiderEntityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where id <> $1 limit 1`,
    [entityId],
  );
  const outsiderEntityRow = outsiderEntityResult.rows[0];
  if (!outsiderEntityRow) throw new Error('expected at least 2 rows in platform.entities (RLS fixture)');
  outsiderEntityId = outsiderEntityRow.id;

  await createFixtureActor(OWNER_ACTOR_UUID, [entityId]);
  await createFixtureActor(OUTSIDER_ACTOR_UUID, [outsiderEntityId]); // NEVER granted `entityId`.

  const warehouseResult: QueryResult<{ id: string }> = await pool.query(
    `select id from wms.warehouses where code = 'WH1'`,
  );
  const warehouseRow = warehouseResult.rows[0];
  if (!warehouseRow) throw new Error(`wms.warehouses row not found for code WH1`);
  warehouseId = warehouseRow.id;

  const clientResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [`_recbill_fixture_${randomUUID()}`, 'عميل اختبار تسجيل الحدث القابل للفوترة'],
  );
  fixtureClientId = (clientResult.rows[0] as { id: string }).id;

  const otherClientResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [`_recbill_fixture_other_${randomUUID()}`, 'عميل آخر اختبار (عدم تطابق العميل)'],
  );
  fixtureOtherClientId = (otherClientResult.rows[0] as { id: string }).id;

  const categoryResult: QueryResult<{ id: string }> = await pool.query(
    `insert into catalog.service_categories (code, name_ar) values ($1, $2) returning id`,
    [`_RECBILL-CAT-${randomUUID()}`, 'فئة خدمة اختبار'],
  );
  fixtureServiceCategoryId = (categoryResult.rows[0] as { id: string }).id;

  const serviceResult: QueryResult<{ id: string }> = await pool.query(
    `insert into catalog.services (code, category_id, name_ar, uom, billing_basis)
     values ($1, $2, $3, $4, 'per_event') returning id`,
    [`_RECBILL-SVC-${randomUUID()}`, fixtureServiceCategoryId, 'خدمة اختبار تسجيل الحدث', UOM_UNIT],
  );
  fixtureServiceId = (serviceResult.rows[0] as { id: string }).id;
});

afterAll(async () => {
  if (usedCorrelationIds.size > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [[...usedCorrelationIds]]);
  }
  if (fixtureEventIds.length > 0) {
    await pool.query(`delete from billing.billable_events where id = any($1::uuid[])`, [fixtureEventIds]);
  }
  // sweep any row the code under test wrote that this suite did not individually track, scoped by
  // fixtureServiceId (unique to this file's fixtures).
  if (fixtureServiceId) {
    await pool.query(`delete from billing.billable_events where service_id = $1`, [fixtureServiceId]);
    await pool.query(`delete from catalog.services where id = $1`, [fixtureServiceId]);
  }
  if (fixtureServiceCategoryId) {
    await pool.query(`delete from catalog.service_categories where id = $1`, [fixtureServiceCategoryId]);
  }
  if (fixtureSourceOrderIds.length > 0) {
    await pool.query(`delete from wms.inbound_orders where id = any($1::uuid[])`, [fixtureSourceOrderIds]);
  }
  if (fixtureClientId) await pool.query(`delete from sales.accounts where id = $1`, [fixtureClientId]);
  if (fixtureOtherClientId) await pool.query(`delete from sales.accounts where id = $1`, [fixtureOtherClientId]);
  for (const userId of [OWNER_ACTOR_UUID, OUTSIDER_ACTOR_UUID]) {
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
});

// --- Scenario: a fresh triple with a real seeded source row succeeds --------------------------

describe('Scenario: a fresh (sourceTable, sourceId, serviceId) triple with a real seeded source row succeeds', () => {
  it('writes one billing.billable_events row at status "pending", entity_id/client_id resolved from the source row, one platform.outbox row and one platform.audit_log row in the same transaction, unit_price/amount null', async () => {
    const triple = await freshTriple();
    const input = baseInput(triple);

    const result = await callInsert(OWNER_ACTOR_UUID, input);
    fixtureEventIds.push(result.id);

    expect(await countEventsForTriple(triple)).toBe(1);
    const stored = await getEvent(result.id);
    expect(stored.status).toBe(STATUS_PENDING);
    // entity_id/client_id equal the SOURCE ROW's own values (freshTriple() seeded the source row
    // under `entityId`/`fixtureClientId`) — never a value the caller supplied directly.
    expect(stored.entity_id).toBe(entityId);
    expect(stored.client_id).toBe(fixtureClientId);
    expect(stored.unit_price).toBeNull();
    expect(stored.amount).toBeNull();

    const audit = await auditRowForRecord(result.id);
    expect(audit).not.toBeNull();
    expect(audit?.correlation_id).toBe(input.correlationId);

    expect(await outboxCountForCorrelation(input.correlationId)).toBe(1);
    const outboxRow = await outboxRowForCorrelation(input.correlationId);
    expect(outboxRow).not.toBeNull();
    expect(outboxRow?.aggregate_id).toBe(result.id);
    expect(outboxRow?.aggregate_type).toBe(BILLABLE_EVENTS_AGGREGATE_TYPE);
    expect(outboxRow?.event_type).toBe(BILLING_EVENT_TYPE_RECORDED);
  });
});

// --- Scenario: sourceId points to a nonexistent or RLS-invisible source row ---------------------

describe('Scenario: sourceId points to a nonexistent or RLS-invisible source row', () => {
  it('rejects with a typed not-found error and writes nothing when the source row genuinely does not exist', async () => {
    const triple = { sourceTable: SOURCE_TABLE, sourceId: randomUUID(), serviceId: fixtureServiceId };

    await expect(
      callInsert(OWNER_ACTOR_UUID, baseInput(triple)),
    ).rejects.toBeInstanceOf(SourceEventNotFoundError);

    expect(await countEventsForTriple(triple)).toBe(0);
  });

  it('rejects with the same typed not-found error and writes nothing when the source row exists but is outside the caller\'s RLS-visible entities', async () => {
    const outsiderSourceId = await createSourceInboundOrder(outsiderEntityId, fixtureClientId);
    const triple = { sourceTable: SOURCE_TABLE, sourceId: outsiderSourceId, serviceId: fixtureServiceId };

    // OWNER_ACTOR_UUID is only scoped to `entityId` (PST), NOT `outsiderEntityId`.
    await expect(
      callInsert(OWNER_ACTOR_UUID, baseInput(triple)),
    ).rejects.toBeInstanceOf(SourceEventNotFoundError);

    expect(await countEventsForTriple(triple)).toBe(0);
  });
});

// --- Scenario: sourceTable is outside the closed list --------------------------------------------

describe('Scenario: sourceTable is outside the closed list', () => {
  it('rejects with a typed InvalidSourceTableError and writes nothing', async () => {
    const triple = await freshTriple();
    const input = { ...baseInput(triple), sourceTable: NOT_IN_CLOSED_LIST_SOURCE_TABLE };

    await expect(
      callInsert(OWNER_ACTOR_UUID, input),
    ).rejects.toBeInstanceOf(InvalidSourceTableError);

    const rows: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from billing.billable_events where source_id = $1`,
      [triple.sourceId],
    );
    expect(Number(rows.rows[0]?.n ?? '0')).toBe(0);
  });

  it('rejects with InvalidSourceTableError for a made-up table name too', async () => {
    const triple = await freshTriple();
    const input = { ...baseInput(triple), sourceTable: 'not.a_real_table' };

    await expect(
      callInsert(OWNER_ACTOR_UUID, input),
    ).rejects.toBeInstanceOf(InvalidSourceTableError);
  });
});

// --- Scenario: caller-supplied clientId disagrees with the source row's own client_id ------------

describe('Scenario: caller-supplied clientId disagrees with the source row\'s own client_id', () => {
  it('rejects with a typed ClientMismatchError and writes nothing', async () => {
    const sourceId = await createSourceInboundOrder(entityId, fixtureClientId); // source row's own client_id = fixtureClientId
    const triple = { sourceTable: SOURCE_TABLE, sourceId, serviceId: fixtureServiceId };
    const input = { ...baseInput(triple), clientId: fixtureOtherClientId }; // caller supplies a DIFFERENT client

    await expect(
      callInsert(OWNER_ACTOR_UUID, input),
    ).rejects.toBeInstanceOf(ClientMismatchError);

    expect(await countEventsForTriple(triple)).toBe(0);
  });
});

// --- Scenario: the same triple is inserted twice in sequence (DETERMINISTIC, round-1 finding 5) --

describe('Scenario: the same (sourceTable, sourceId, serviceId) triple is inserted twice in sequence', () => {
  it('the second call rejects with a typed DuplicateBillableEventError raised via the SQLSTATE 23505 catch, proving the DB-constraint backstop fires, not just the domain pre-check', async () => {
    const triple = await freshTriple();

    // Directly INSERT (admin pool, bypasses RLS) a billing.billable_events row with the SAME
    // (sourceTable, sourceId, serviceId) triple but under the OUTSIDER entity. The unique index
    // (billable_events_source_table_source_id_service_id_idx) is GLOBAL, not RLS-scoped — but the
    // domain-level pre-check in the repository (isNonDuplicateTriple) reads through the caller's
    // OWN RLS-scoped tx (entity_scope = entityId), so it genuinely cannot see this other-entity
    // row and will report "non-duplicate" going in. That forces the caller's own insertBillableEvent
    // call past the pre-check and into the real INSERT statement, where the DB's own unique index
    // — not the pre-check — is what raises SQLSTATE 23505.
    const outsiderRow: QueryResult<{ id: string }> = await pool.query(
      `insert into billing.billable_events
         (entity_id, occurred_at, client_id, service_id, qty, uom, source_module, source_table, source_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [
        outsiderEntityId,
        OCCURRED_AT,
        fixtureClientId,
        triple.serviceId,
        QTY_TEN,
        UOM_UNIT,
        SOURCE_MODULE_WMS,
        triple.sourceTable,
        triple.sourceId,
      ],
    );
    const outsiderRowId = (outsiderRow.rows[0] as { id: string }).id;
    fixtureEventIds.push(outsiderRowId);

    // Prove the pre-check's own condition is genuinely false going in (RLS hides the outsider row
    // from the OWNER's scoped view): the OWNER's own withContext tx sees ZERO matching rows here,
    // even though one now exists globally.
    const preCheckVisibleCount = await withContext(ctxFor(OWNER_ACTOR_UUID), async (tx) => {
      const r = await tx.execute<{ n: string }>(sql`
        select count(*)::text as n from billing.billable_events
         where source_table = ${triple.sourceTable} and source_id = ${triple.sourceId}::uuid
           and service_id = ${triple.serviceId}::uuid
      `);
      return Number(r.rows[0]?.n ?? '0');
    });
    expect(preCheckVisibleCount).toBe(0);

    // The caller's insertBillableEvent call now runs, sails past its own (RLS-blind) pre-check, and
    // hits the real, global unique index — the actual SQLSTATE 23505 catch path.
    let caught: unknown;
    try {
      await callInsert(OWNER_ACTOR_UUID, baseInput(triple));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DuplicateBillableEventError);
    // Proves the raise came from the DB-constraint catch specifically, not the pre-check (which
    // throws the same error type but WITHOUT a `.cause` — see repository.ts's two throw sites: the
    // pre-check throw at line ~207 has no `cause` option, only the 23505 catch at line ~237 sets
    // `{ cause: error }`). Walk that cause chain for the real Postgres SQLSTATE.
    const withCause = caught as { cause?: unknown };
    expect(withCause.cause).toBeDefined();
    let sawSqlstate23505 = false;
    let current: unknown = withCause.cause;
    const seen = new Set<unknown>();
    while (current instanceof Error && !seen.has(current)) {
      seen.add(current);
      if ((current as { code?: unknown }).code === '23505') {
        sawSqlstate23505 = true;
        break;
      }
      current = (current as { cause?: unknown }).cause;
    }
    expect(sawSqlstate23505).toBe(true);

    // Only the outsider's row exists for the triple globally — the owner's own attempt hit the
    // unique-index conflict and wrote nothing.
    expect(await countEventsForTriple(triple)).toBe(1);
  });
});

// --- Scenario: qty is not a finite positive number ------------------------------------------------

describe('Scenario: qty is not a finite positive number', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['zero', 0],
    ['a negative number', -5],
  ])('rejects qty = %s with a typed error and writes nothing', async (_label, qty) => {
    const triple = await freshTriple();

    await expect(
      callInsert(OWNER_ACTOR_UUID, { ...baseInput(triple), qty }),
    ).rejects.toBeInstanceOf(NonPositiveQtyError);

    expect(await countEventsForTriple(triple)).toBe(0);
  });
});

// --- Scenario: cross-entity isolation — RLS entity_scope governs the table -------------------------

describe('Scenario: cross-entity isolation — RLS entity_scope governs the table', () => {
  it('a row written under one entity is invisible to a caller scoped to a different entity, and visible to the owner, via the same query', async () => {
    const triple = await freshTriple();
    const result = await callInsert(OWNER_ACTOR_UUID, baseInput(triple));
    fixtureEventIds.push(result.id);

    const outsiderRows = await withContext(ctxFor(OUTSIDER_ACTOR_UUID), async (tx) => {
      const r = await tx.execute<{ id: string }>(
        sql`select id::text as id from billing.billable_events where id = ${result.id}::uuid`,
      );
      return r.rows;
    });
    expect(outsiderRows).toHaveLength(0);

    const ownerRows = await withContext(ctxFor(OWNER_ACTOR_UUID), async (tx) => {
      const r = await tx.execute<{ id: string }>(
        sql`select id::text as id from billing.billable_events where id = ${result.id}::uuid`,
      );
      return r.rows;
    });
    expect(ownerRows).toHaveLength(1);
  });
});

// --- Scenario: commercial-column masking on the audit row ------------------------------------------

describe('Scenario: commercial-column masking on the audit row', () => {
  it('platform.sanitize_audit masks unit_price/price_source/amount to "•••" even though the stored value is null; a non-commercial key stays unmasked', async () => {
    const triple = await freshTriple();
    const result = await callInsert(OWNER_ACTOR_UUID, baseInput(triple));
    fixtureEventIds.push(result.id);

    const sanitizedResult: QueryResult<{ sanitized: Record<string, unknown> }> = await pool.query(
      `select platform.sanitize_audit('billing', 'billable_events', new_value) as sanitized
         from platform.audit_log
        where schema_name = 'billing' and table_name = 'billable_events' and record_id = $1`,
      [result.id],
    );
    const sanitized = sanitizedResult.rows[0]?.sanitized;
    expect(sanitized).toBeDefined();
    const record = sanitized as Record<string, unknown>;
    expect(record['unitPrice'] ?? record['unit_price']).toBe(SANITIZE_AUDIT_MASK);
    expect(record['priceSource'] ?? record['price_source']).toBe(SANITIZE_AUDIT_MASK);
    expect(record['amount']).toBe(SANITIZE_AUDIT_MASK);
    // a non-commercial key is read back unmasked (status is never classified commercial/secret/
    // personal/payroll) — proves the mask is column-classification-driven, not blanket.
    expect(record['status']).not.toBe(SANITIZE_AUDIT_MASK);
  });
});
