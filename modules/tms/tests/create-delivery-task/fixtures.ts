// modules/tms/tests/create-delivery-task/fixtures.ts — WBS 3.4 part 1.
//
// Shared fixture helpers for create-delivery-task.test.ts and handlers.test.ts (not a test file:
// vitest's include is tests/**/*.test.ts). Admin pool (PGUSER — bypasses RLS, fixture setup and
// teardown only) plus a real internal identity.users actor who is a member of every entity, so
// every use-case call runs through withContext as pgeos_app, genuinely under RLS. Orders live in
// PDL (S1's entity). D-183: DELETE only in `cleanup()` (called from the suite's afterAll), and only
// ids this run created; platform.audit_log is never deleted.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';

export const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

export const PDL_ENTITY_CODE = 'PDL'; // 01-Data-Model.sql:1572 — S1's delivery entity.
export const TASK_DOC_TYPE = 'TSK'; // tms.brief.md §4 / 01-Data-Model.sql:1599.
export const TASK_CREATED_EVENT_TYPE = 'tms.task.created'; // doc 03 line 132.
export const TASK_AGGREGATE_TYPE = 'tms.delivery_tasks';
export const CREATED_STATUS = 'created'; // chk_delivery_tasks_status, 13B:2338-2339.
export const INITIAL_VERSION = 1; // brief Decision 2 / 4.

export const ADDRESS_INCOMPLETE_I18N_KEY = 'tms.task.create.addressIncomplete';
export const ORDER_NOT_READY_I18N_KEY = 'tms.task.create.orderNotReady';
export const ALREADY_EXISTS_I18N_KEY = 'tms.task.create.alreadyExists';

export interface OrderFixture {
  readonly id: string;
  readonly version: number;
}

export interface TaskBodyOverrides {
  readonly expectedVersion?: number;
  readonly correlationId?: string;
}

export class Fixtures {
  entityId = '';
  warehouseId = '';
  clientId = '';
  contractId = '';
  readonly actorId = randomUUID(); // per run: no pre-clean DELETE needed (D-183).
  private readonly orderIds: string[] = [];
  private readonly correlationIds: string[] = [];

  constructor(private readonly label: string) {}

  /** The caller context: an internal user whose active entity is PDL (app.entity_id). */
  ctx(): { userId: string; clientId: null; isInternal: true; entityId: string } {
    return { userId: this.actorId, clientId: null, isInternal: true, entityId: this.entityId };
  }

  async setup(): Promise<void> {
    const entity: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, [
      PDL_ENTITY_CODE,
    ]);
    this.entityId = (entity.rows[0] as { id: string }).id;
    const warehouse: QueryResult<{ id: string }> = await pool.query(`select id from wms.warehouses order by code limit 1`);
    this.warehouseId = (warehouse.rows[0] as { id: string }).id;

    const client: QueryResult<{ id: string }> = await pool.query(
      `insert into sales.accounts (code, name_ar, account_type, status) values ($1, $2, 'client', 'active') returning id`,
      [`_deltask_${this.label}_${randomUUID()}`, 'عميل اختبار مهمة التوصيل'],
    );
    this.clientId = (client.rows[0] as { id: string }).id;

    const cntDocNo: QueryResult<{ doc_no: string }> = await pool.query(`select platform.next_doc_no($1, 'CNT') as doc_no`, [
      this.entityId,
    ]);
    const contract: QueryResult<{ id: string }> = await pool.query(
      `insert into sales.contracts (entity_id, doc_no, account_id, title, status, start_date)
       values ($1, $2, $3, $4, 'active', current_date) returning id`,
      [this.entityId, (cntDocNo.rows[0] as { doc_no: string }).doc_no, this.clientId, 'عقد اختبار مهمة التوصيل'],
    );
    this.contractId = (contract.rows[0] as { id: string }).id;

    await pool.query(`insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`, [
      this.actorId,
      `_deltask_${this.label}_${randomUUID()}@test.invalid`,
      'ممثل اختبار مهمة التوصيل',
    ]);
    const entities: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities`);
    for (const row of entities.rows) {
      await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [this.actorId, row.id]);
    }
  }

  /** A fresh outbound order in PDL at `status` (S1 reaches 'checked'), with client and contract set. */
  async insertOrder(status: string): Promise<OrderFixture> {
    const docNo: QueryResult<{ doc_no: string }> = await pool.query(`select platform.next_doc_no($1, 'OUT') as doc_no`, [
      this.entityId,
    ]);
    const order: QueryResult<{ id: string; version: number }> = await pool.query(
      `insert into wms.outbound_orders
         (entity_id, doc_no, client_id, contract_id, warehouse_id, order_type, status,
          ship_to_name, ship_to_phone, ship_to_address, ship_to_area)
       values ($1, $2, $3, $4, $5, 'standard', $6, 'x', 'x', 'x', 'x') returning id, version`,
      [this.entityId, (docNo.rows[0] as { doc_no: string }).doc_no, this.clientId, this.contractId, this.warehouseId, status],
    );
    const row = order.rows[0] as OrderFixture;
    this.orderIds.push(row.id);
    return row;
  }

  nextCorrelationId(): string {
    const id = randomUUID();
    this.correlationIds.push(id);
    return id;
  }

  /** A complete CreateDeliveryTask body (INV-C4-2 fields all present) for `order`. */
  body(order: OrderFixture, overrides: TaskBodyOverrides = {}): Record<string, unknown> {
    return {
      outboundOrderId: order.id,
      expectedVersion: overrides.expectedVersion ?? order.version,
      recipientName: 'Fixture Recipient',
      recipientPhone: '+96550000000',
      area: 'Salmiya',
      block: '5',
      street: 'Salem Al-Mubarak',
      correlationId: overrides.correlationId ?? this.nextCorrelationId(),
    };
  }

  async cleanup(): Promise<void> {
    const tasks: QueryResult<{ id: string }> = await pool.query(
      `select id from tms.delivery_tasks where outbound_order_id = any($1::uuid[])`,
      [this.orderIds],
    );
    const taskIds = tasks.rows.map((row) => row.id);
    await pool.query(`delete from platform.outbox where aggregate_id = any($1::uuid[]) or correlation_id = any($2::uuid[])`, [
      taskIds,
      this.correlationIds,
    ]);
    await pool.query(`delete from tms.delivery_tasks where id = any($1::uuid[])`, [taskIds]);
    await pool.query(`delete from wms.outbound_orders where id = any($1::uuid[])`, [this.orderIds]);
    await pool.query(`delete from sales.contracts where id = $1`, [this.contractId || randomUUID()]);
    await pool.query(`delete from sales.accounts where id = $1`, [this.clientId || randomUUID()]);
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [this.actorId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [this.actorId]);
    await pool.query(`delete from identity.users where id = $1`, [this.actorId]);
  }
}
