// modules/tms/tests/create-delivery-task/create-delivery-task.test.ts — WBS 3.4 part 1.
//
// Integration tests (application layer, real database as pgeos_app under RLS), one per scenario in
// ./create-delivery-task.feature. Sources: brief Decision 4 / Acceptance (b), doc 40 lines 273-274 and
// 444-446, doc 03 lines 132-133, tests/scenarios/S1.spec.ts:696-703.
//
// Layering (D-208): INV-C4-2 and the order-status set are asserted ONCE, in
// ./invariants.unit.test.ts. This file proves what only the database can: the row, doc_no, version,
// the copied client/contract, the outbound order's back-link + version bump, the same-transaction
// outbox row, the S1 query, optimistic locking, one-task-per-order, and that a refused create
// writes nothing. Idempotent replay: ./handlers.test.ts (where the golden slice proves it).
//
// Expected surface (the builder implements exactly this):
//   modules/tms/application/create-delivery-task/index.ts
//     createDeliveryTask(ctx: WithContextCtx, input: CreateDeliveryTaskInput & { idem?: IdempotencyInput },
//                        deps: CreateDeliveryTaskDeps): Promise<CreateDeliveryTaskResult>
//     CreateDeliveryTaskResult = { taskId: string; docNo: string; status: 'created'; version: number }
//   modules/tms/api/create-delivery-task/composition.ts  createCreateDeliveryTaskDeps({ clock, ids, logger? })
//   modules/tms/domain/create-delivery-task/errors.ts
//     StaleVersionError, OrderNotFoundError, AddressIncompleteError, OrderNotReadyError,
//     DeliveryTaskAlreadyExistsError  (each `(message: string)`; the last three carry `i18nKey`).

import { randomUUID } from 'node:crypto';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { EntityScopeRequiredError } from '@pg-eos/db';
import { CreateDeliveryTaskInputSchema } from '@pg-eos/contracts/tms/create-delivery-task';

import { createDeliveryTask } from '../../application/create-delivery-task/index.js';
import type { CreateDeliveryTaskDeps } from '../../application/create-delivery-task/ports.js';
import { createCreateDeliveryTaskDeps } from '../../api/create-delivery-task/composition.js';
import {
  AddressIncompleteError,
  DeliveryTaskAlreadyExistsError,
  OrderNotFoundError,
  OrderNotReadyError,
  StaleVersionError,
} from '../../domain/create-delivery-task/errors.js';
import {
  CREATED_STATUS,
  Fixtures,
  INITIAL_VERSION,
  TASK_AGGREGATE_TYPE,
  TASK_CREATED_EVENT_TYPE,
  TASK_DOC_TYPE,
  pool,
} from './fixtures.js';

const SEED_BASE = 3041;
const NOT_READY_STATUS = 'draft';
const STALE_VERSION_OFFSET = 999;
const NEW_ORDER_VERSION_BUMP = 1;
const BLANK = '   ';
const MIN_AMBIGUOUS_ENTITIES = 2;

const clock = new FixedClock(new Date('2026-09-30T00:00:00.000Z'));
const ids = new SequentialIdGenerator(SEED_BASE);
const deps = createCreateDeliveryTaskDeps({ clock, ids });
const fx = new Fixtures('create');

interface TaskRow {
  id: string;
  entity_id: string;
  doc_no: string;
  client_id: string;
  contract_id: string | null;
  status: string;
  version: number;
  vehicle_id: string | null;
  driver_id: string | null;
  outbound_order_id: string;
  source_type: string;
  task_type: string;
  recipient_phone: string | null;
  area: string | null;
  block: string | null;
  street: string | null;
}

async function tasksOf(orderId: string): Promise<TaskRow[]> {
  const result: QueryResult<TaskRow> = await pool.query(`select * from tms.delivery_tasks where outbound_order_id = $1`, [orderId]);
  return result.rows;
}

async function orderRow(orderId: string): Promise<{ delivery_task_id: string | null; version: number }> {
  const result: QueryResult<{ delivery_task_id: string | null; version: number }> = await pool.query(
    `select delivery_task_id, version from wms.outbound_orders where id = $1`,
    [orderId],
  );
  return result.rows[0] as { delivery_task_id: string | null; version: number };
}

async function outboxCount(orderTaskIds: readonly string[], eventType: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.outbox where aggregate_id = any($1::uuid[]) and event_type = $2`,
    [orderTaskIds, eventType],
  );
  return Number((result.rows[0] as { n: string }).n);
}

beforeAll(async () => {
  await fx.setup();
});

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe('Scenario: a checked outbound order in PDL gets exactly one delivery task, created, with a TSK doc_no, version 1 and a tms.task.created outbox row', () => {
  let orderId: string;
  let orderVersion: number;
  let correlationId: string;
  let result: Awaited<ReturnType<typeof createDeliveryTask>>;

  beforeAll(async () => {
    const order = await fx.insertOrder('checked');
    orderId = order.id;
    orderVersion = order.version;
    correlationId = fx.nextCorrelationId();
    const input = CreateDeliveryTaskInputSchema.parse(fx.body(order, { correlationId }));
    result = await createDeliveryTask(fx.ctx(), input, deps);
  });

  it('writes exactly one tms.delivery_tasks row: status created, version 1, no vehicle, no driver, entity/client/contract from the order', async () => {
    const rows = await tasksOf(orderId);
    expect(rows).toHaveLength(1);
    const row = rows[0] as TaskRow;
    expect(row.id).toBe(result.taskId);
    expect(row.status).toBe(CREATED_STATUS);
    expect(row.version).toBe(INITIAL_VERSION);
    expect(row.vehicle_id).toBeNull();
    expect(row.driver_id).toBeNull();
    expect(row.entity_id).toBe(fx.entityId);
    expect(row.client_id).toBe(fx.clientId);
    expect(row.contract_id).toBe(fx.contractId);
    expect(row.source_type).toBe('internal');
    expect(row.task_type).toBe('b2c');
    expect([row.area, row.block, row.street, row.recipient_phone]).toEqual(['Salmiya', '5', 'Salem Al-Mubarak', '+96550000000']);
  });

  it('returns the created task: taskId, docNo, status created, version 1', () => {
    expect(result).toEqual({ taskId: result.taskId, docNo: result.docNo, status: CREATED_STATUS, version: INITIAL_VERSION });
  });

  it('doc_no comes from platform.next_doc_no(entity, TSK): the entity TSK counter prefix, persisted equal to the result', async () => {
    const counter: QueryResult<{ prefix: string }> = await pool.query(
      `select prefix from platform.counters where entity_id = $1 and doc_type = $2`,
      [fx.entityId, TASK_DOC_TYPE],
    );
    const prefix = (counter.rows[0] as { prefix: string }).prefix;
    const row = (await tasksOf(orderId))[0] as TaskRow;
    expect(row.doc_no).toBe(result.docNo);
    expect(row.doc_no.startsWith(prefix)).toBe(true);
    expect(row.doc_no.length).toBeGreaterThan(prefix.length);
  });

  it('sets wms.outbound_orders.delivery_task_id and bumps the order version by one', async () => {
    const order = await orderRow(orderId);
    expect(order.delivery_task_id).toBe(result.taskId);
    expect(order.version).toBe(orderVersion + NEW_ORDER_VERSION_BUMP);
  });

  it('writes exactly one platform.outbox row, event tms.task.created, for that aggregate, with the command correlationId', async () => {
    expect(await outboxCount([result.taskId], TASK_CREATED_EVENT_TYPE)).toBe(1);
    const outbox: QueryResult<{ aggregate_type: string; correlation_id: string }> = await pool.query(
      `select aggregate_type, correlation_id from platform.outbox where aggregate_id = $1 and event_type = $2`,
      [result.taskId, TASK_CREATED_EVENT_TYPE],
    );
    expect(outbox.rows[0]?.aggregate_type).toBe(TASK_AGGREGATE_TYPE);
    expect(outbox.rows[0]?.correlation_id).toBe(correlationId);
  });

  it('the S1 query, verbatim, returns exactly one row for (outbound order, PDL)', async () => {
    const s1: QueryResult<{ id: string }> = await pool.query(
      `select id from tms.delivery_tasks where outbound_order_id = $1 and entity_id = $2`,
      [orderId, fx.entityId],
    );
    expect(s1.rows).toHaveLength(1);
    expect(s1.rows[0]?.id).toBe(result.taskId);
  });
});

describe('Scenario: a second create for the same order is refused (alreadyExists) and still leaves one row', () => {
  it('DeliveryTaskAlreadyExistsError (tms.task.create.alreadyExists), one row, one outbox row, order version unchanged by the refusal', async () => {
    const order = await fx.insertOrder('checked');
    const first = await createDeliveryTask(fx.ctx(), CreateDeliveryTaskInputSchema.parse(fx.body(order)), deps);
    const afterFirst = await orderRow(order.id);

    const secondAttempt = createDeliveryTask(
      fx.ctx(),
      CreateDeliveryTaskInputSchema.parse(fx.body(order, { expectedVersion: afterFirst.version })),
      deps,
    );
    await expect(secondAttempt).rejects.toBeInstanceOf(DeliveryTaskAlreadyExistsError);

    expect(await tasksOf(order.id)).toHaveLength(1);
    expect(await outboxCount([first.taskId], TASK_CREATED_EVENT_TYPE)).toBe(1);
    expect((await orderRow(order.id)).version).toBe(afterFirst.version);
  });
});

describe('Scenario: a create for an order not yet checked is refused and writes nothing', () => {
  it('OrderNotReadyError for a draft order: no task row, no back-link, version untouched', async () => {
    const order = await fx.insertOrder(NOT_READY_STATUS);
    await expect(createDeliveryTask(fx.ctx(), CreateDeliveryTaskInputSchema.parse(fx.body(order)), deps)).rejects.toBeInstanceOf(
      OrderNotReadyError,
    );
    expect(await tasksOf(order.id)).toHaveLength(0);
    const after = await orderRow(order.id);
    expect(after.delivery_task_id).toBeNull();
    expect(after.version).toBe(order.version);
  });
});

describe('Scenario: a create with an incomplete address (INV-C4-2) writes nothing', () => {
  it('the use case runs the domain rule before any write: blank block (past the contract) -> AddressIncompleteError, no row', async () => {
    const order = await fx.insertOrder('checked');
    const parsed = CreateDeliveryTaskInputSchema.parse(fx.body(order));
    await expect(createDeliveryTask(fx.ctx(), { ...parsed, block: BLANK }, deps)).rejects.toBeInstanceOf(AddressIncompleteError);
    expect(await tasksOf(order.id)).toHaveLength(0);
    expect((await orderRow(order.id)).version).toBe(order.version);
  });
});

describe('optimistic lock and unknown order', () => {
  it('a stale expectedVersion -> StaleVersionError; no task row, no outbox row, no back-link', async () => {
    const order = await fx.insertOrder('checked');
    const correlationId = fx.nextCorrelationId();
    const input = CreateDeliveryTaskInputSchema.parse(
      fx.body(order, { expectedVersion: order.version + STALE_VERSION_OFFSET, correlationId }),
    );
    await expect(createDeliveryTask(fx.ctx(), input, deps)).rejects.toBeInstanceOf(StaleVersionError);
    expect(await tasksOf(order.id)).toHaveLength(0);
    const outbox: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from platform.outbox where correlation_id = $1`,
      [correlationId],
    );
    expect(Number((outbox.rows[0] as { n: string }).n)).toBe(0);
    const after = await orderRow(order.id);
    expect(after.delivery_task_id).toBeNull();
    expect(after.version).toBe(order.version);
  });

  it('an order id that does not exist (or is hidden by RLS) -> OrderNotFoundError', async () => {
    const order = await fx.insertOrder('checked');
    const input = CreateDeliveryTaskInputSchema.parse({
      ...fx.body(order),
      outboundOrderId: '00000000-0000-4000-8000-000000000000',
    });
    await expect(createDeliveryTask(fx.ctx(), input, deps)).rejects.toBeInstanceOf(OrderNotFoundError);
  });
});

describe('cross-entity order fails closed', () => {
  // Why a stubbed repository and not a DB path: through RLS an internal caller can never SEE another
  // entity's order, so the real repo cannot reach `order.entityId !== callerEntityId`. The stub
  // returns a ready, version-matching order of entity A while the caller resolves to entity B;
  // withContext still opens a real transaction, but the stub issues no SQL and records every write call.
  it('order.entityId differs from the caller entity -> OrderNotFoundError before any write (no doc_no, insert, link, audit)', async () => {
    const orderEntityId = randomUUID();
    const callerEntityId = randomUUID();
    const orderId = randomUUID();
    const expectedVersion = 1;
    const calls: string[] = [];
    const repo: CreateDeliveryTaskDeps['repo'] = {
      getOrderForUpdate: async () => ({
        id: orderId,
        entityId: orderEntityId,
        clientId: randomUUID(),
        contractId: null,
        status: 'checked',
        version: expectedVersion,
        deliveryTaskId: null,
      }),
      resolveCallerEntityId: async () => callerEntityId,
      nextDocNo: async () => {
        calls.push('nextDocNo');
        return 'X';
      },
      insertDeliveryTask: async () => {
        calls.push('insertDeliveryTask');
        return { id: randomUUID() };
      },
      linkOrderToTask: async () => {
        calls.push('linkOrderToTask');
        return expectedVersion;
      },
      writeAuditRow: async () => {
        calls.push('writeAuditRow');
      },
    };
    const order = await fx.insertOrder('checked');
    const correlationId = fx.nextCorrelationId();
    const input = CreateDeliveryTaskInputSchema.parse(fx.body(order, { correlationId }));

    await expect(
      createDeliveryTask(fx.ctx(), { ...input, outboundOrderId: orderId, expectedVersion }, { ...deps, repo }),
    ).rejects.toBeInstanceOf(OrderNotFoundError);

    expect(calls).toEqual([]);
    const outbox: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from platform.outbox where correlation_id = $1`,
      [correlationId],
    );
    expect(Number((outbox.rows[0] as { n: string }).n)).toBe(0);
    expect(await tasksOf(order.id)).toHaveLength(0);
    expect((await orderRow(order.id)).delivery_task_id).toBeNull();
  });
});

describe('entity scope fails closed', () => {
  it('ctx.entityId null for a user who is a member of 2+ entities -> EntityScopeRequiredError, no tms.delivery_tasks row', async () => {
    const membership: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from identity.user_entities where user_id = $1`,
      [fx.actorId],
    );
    expect(Number((membership.rows[0] as { n: string }).n)).toBeGreaterThanOrEqual(MIN_AMBIGUOUS_ENTITIES);
    const order = await fx.insertOrder('checked');
    const input = CreateDeliveryTaskInputSchema.parse(fx.body(order));
    await expect(createDeliveryTask({ ...fx.ctx(), entityId: null }, input, deps)).rejects.toBeInstanceOf(EntityScopeRequiredError);
    expect(await tasksOf(order.id)).toHaveLength(0);
    expect((await orderRow(order.id)).delivery_task_id).toBeNull();
  });
});
