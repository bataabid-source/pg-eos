// modules/billing/tests/record-billable-event/outbound-checked.fixtures.ts — WBS 4.3 part 1 (lane 2).
//
// Shared fixture helpers for the two DB-backed RED suites of the wms.outbound.checked subscriber
// (record-outbound-checked.test.ts, billable-idempotency.property.test.ts). Not a test file itself.
// Every helper uses the ADMIN pool (PGUSER, bypasses RLS) for setup/verification only; the code
// under test opens its own withContext transaction. Service ids are always read by code.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';

export const CHECKED_EVENT_TYPE = 'wms.outbound.checked';
export const OUTBOUND_ORDERS_TABLE = 'wms.outbound_orders';
export const SUBSCRIBER_NAME = 'billing.wms-outbound-checked';
export const STATUS_PENDING = 'pending';
export const STATUS_CHECKED = 'checked';
export const QTY_ONE = '1.000';
export const EXPECTED_SERVICE_CODES: readonly string[] = ['OF-01', 'OF-02', 'OF-06', 'OF-07'];
export const EXPECTED_ROWS_PER_ORDER = EXPECTED_SERVICE_CODES.length;
export const MAIN_ENTITY_CODE = 'PST';
export const WAREHOUSE_CODE = 'WH1';
const CONTRACT_START_DATE = '2026-01-01';

export const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

export interface CheckedOrder {
  readonly orderId: string;
  readonly entityId: string;
  readonly clientId: string;
  readonly contractId: string;
}

export interface OutboxFixture {
  readonly outboxId: string;
  readonly correlationId: string;
}

export interface BillableRow {
  readonly code: string;
  readonly status: string;
  readonly qty: string;
  readonly uom: string;
  readonly entity_id: string;
  readonly client_id: string;
  readonly contract_id: string | null;
  readonly xmin: string;
  readonly occurred_at: Date;
}

export interface CatalogService {
  readonly code: string;
  readonly uom: string;
}

const correlationIds: string[] = [];
const orderIds: string[] = [];
const contractIds: string[] = [];
const clientIds: string[] = [];

export async function entityIdByCode(code: string): Promise<string> {
  const r: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, [code]);
  const row = r.rows[0];
  if (!row) throw new Error(`fixture: platform.entities row not found for code ${code}`);
  return row.id;
}

export async function otherEntityId(notEntityId: string): Promise<string> {
  const r: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where id <> $1 order by code limit 1`,
    [notEntityId],
  );
  const row = r.rows[0];
  if (!row) throw new Error('fixture: expected at least 2 rows in platform.entities');
  return row.id;
}

export async function catalogServices(): Promise<readonly CatalogService[]> {
  const r: QueryResult<CatalogService> = await pool.query(
    `select code, uom from catalog.services where code = any($1::text[]) and is_active order by code`,
    [[...EXPECTED_SERVICE_CODES]],
  );
  return r.rows;
}

// A real wms.outbound_orders row at status 'checked' for a fresh client + contract of `entityId`.
export async function createCheckedOrder(entityId: string): Promise<CheckedOrder> {
  const warehouse: QueryResult<{ id: string }> = await pool.query(
    `select id from wms.warehouses where code = $1`,
    [WAREHOUSE_CODE],
  );
  const warehouseId = warehouse.rows[0]?.id;
  if (!warehouseId) throw new Error(`fixture: wms.warehouses row not found for code ${WAREHOUSE_CODE}`);

  const client: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [`_obchk_fixture_${randomUUID()}`, 'عميل اختبار مشترك فوترة الإخراج'],
  );
  const clientId = (client.rows[0] as { id: string }).id;
  clientIds.push(clientId);

  const contract: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.contracts (entity_id, doc_no, account_id, title, start_date)
     values ($1, $2, $3, $4, $5) returning id`,
    [entityId, `_obchk-${randomUUID()}`, clientId, 'عقد اختبار مشترك فوترة الإخراج', CONTRACT_START_DATE],
  );
  const contractId = (contract.rows[0] as { id: string }).id;
  contractIds.push(contractId);

  const order: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.outbound_orders (entity_id, doc_no, client_id, contract_id, warehouse_id, status)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [entityId, `_obchk-${randomUUID()}`, clientId, contractId, warehouseId, STATUS_CHECKED],
  );
  const orderId = (order.rows[0] as { id: string }).id;
  orderIds.push(orderId);
  return { orderId, entityId, clientId, contractId };
}

// A platform.outbox row as check-order.ts writes it (entity_id, aggregate = the order, payload).
export async function insertOutboxRow(
  eventType: string,
  aggregateId: string,
  entityId: string | null,
  payload: Record<string, unknown>,
): Promise<OutboxFixture> {
  const correlationId = randomUUID();
  correlationIds.push(correlationId);
  const r: QueryResult<{ id: string }> = await pool.query(
    `insert into platform.outbox (entity_id, aggregate_type, aggregate_id, event_type, payload, correlation_id)
     values ($1, $2, $3, $4, $5::jsonb, $6) returning id::text as id`,
    [entityId, OUTBOUND_ORDERS_TABLE, aggregateId, eventType, JSON.stringify(payload), correlationId],
  );
  return { outboxId: (r.rows[0] as { id: string }).id, correlationId };
}

export async function outboxState(
  outboxId: string,
): Promise<{ published: boolean; lastError: string | null; createdAt: Date }> {
  const r: QueryResult<{ published: boolean; last_error: string | null; created_at: Date }> = await pool.query(
    `select (published_at is not null) as published, last_error, created_at from platform.outbox where id = $1`,
    [outboxId],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`fixture: no platform.outbox row ${outboxId}`);
  return { published: row.published, lastError: row.last_error, createdAt: row.created_at };
}

export async function resetOutboxRow(outboxId: string): Promise<void> {
  await pool.query(`update platform.outbox set published_at = null where id = $1`, [outboxId]);
}

// The S1 query (tests/scenarios/S1.spec.ts:676-682 shape), extended with the columns this slice
// asserts. One entry per catalog code; `cnt` is the number of billable rows for the order.
export async function billableRowsByCode(orderId: string): Promise<ReadonlyMap<string, readonly BillableRow[]>> {
  const r: QueryResult<BillableRow> = await pool.query(
    `select s.code, be.status, be.qty::text as qty, be.uom, be.entity_id::text as entity_id,
            be.client_id::text as client_id, be.contract_id::text as contract_id,
            be.xmin::text as xmin, be.occurred_at
       from billing.billable_events be
       join catalog.services s on s.id = be.service_id
      where be.source_table = $1 and be.source_id = $2 and s.code = any($3::text[])`,
    [OUTBOUND_ORDERS_TABLE, orderId, [...EXPECTED_SERVICE_CODES]],
  );
  const byCode = new Map<string, BillableRow[]>();
  for (const row of r.rows) byCode.set(row.code, [...(byCode.get(row.code) ?? []), row]);
  return byCode;
}

export interface S1Row {
  readonly code: string;
  readonly cnt: string;
  readonly status: string | null;
}

// The S1 SQL VERBATIM (tests/scenarios/S1.spec.ts:676-682): left join from catalog.services,
// count(be.id) and max(be.status) per code; a missing row shows as cnt 0, never as absence.
export async function s1BillableQuery(orderId: string): Promise<ReadonlyMap<string, S1Row>> {
  const r: QueryResult<S1Row> = await pool.query(
    `select s.code, count(be.id)::text as cnt, max(be.status) as status
           from catalog.services s
           left join billing.billable_events be
             on be.service_id = s.id and be.source_table = 'wms.outbound_orders' and be.source_id = $1
          where s.code = any($2::text[])
          group by s.code`,
    [orderId, [...EXPECTED_SERVICE_CODES]],
  );
  return new Map(r.rows.map((row) => [row.code, row]));
}

// beforeAll precondition (finding 10): the four OF-xx services seeded and active, else STOP.
export async function assertServicesSeeded(): Promise<void> {
  const found = (await catalogServices()).map((s) => s.code);
  if (found.length !== EXPECTED_SERVICE_CODES.length) {
    throw new Error(
      `STOP: catalog.services must hold the four active rows ${EXPECTED_SERVICE_CODES.join(', ')} (found: ${found.join(', ') || 'none'}); this is a seed problem for the Master, not a test defect.`,
    );
  }
}

// beforeAll precondition (finding 5): no unpublished outbox row of `eventType` that this suite did
// not create. Never deletes foreign rows — reports them by throwing.
export async function assertNoForeignUnpublished(eventType: string): Promise<void> {
  const r: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.outbox
      where published_at is null and event_type = $1 and not (correlation_id = any($2::uuid[]))`,
    [eventType, correlationIds],
  );
  const n = Number(r.rows[0]?.n ?? '0');
  if (n > 0) {
    throw new Error(
      `STOP: ${n} unpublished platform.outbox row(s) of type ${eventType} not created by this suite exist on the lane DB; relaying would process them. Report to the Master; do not delete.`,
    );
  }
}

export async function billableCount(orderId: string): Promise<number> {
  const r: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from billing.billable_events where source_table = $1 and source_id = $2`,
    [OUTBOUND_ORDERS_TABLE, orderId],
  );
  return Number(r.rows[0]?.n ?? '0');
}

// afterAll cleanup of everything this suite created (D-183: only inside the suite's own afterAll).
export async function cleanupFixtures(): Promise<void> {
  if (orderIds.length > 0) {
    await pool.query(`delete from billing.billable_events where source_table = $1 and source_id = any($2::uuid[])`, [
      OUTBOUND_ORDERS_TABLE,
      orderIds,
    ]);
  }
  if (correlationIds.length > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [correlationIds]);
  }
  if (orderIds.length > 0) await pool.query(`delete from wms.outbound_orders where id = any($1::uuid[])`, [orderIds]);
  if (contractIds.length > 0) await pool.query(`delete from sales.contracts where id = any($1::uuid[])`, [contractIds]);
  if (clientIds.length > 0) await pool.query(`delete from sales.accounts where id = any($1::uuid[])`, [clientIds]);
  await pool.end();
}
