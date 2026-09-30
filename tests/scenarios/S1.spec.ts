// tests/scenarios/S1.spec.ts — doc 40 Part E, Feature S1 (lines 432-446), enablement item 3a.
//
// HONEST STATE (docs/notes/slice-briefs/_slice-X-scenarios.brief.md): every Gherkin line below is
// its own `test.step`, verbatim. Command steps (a Given/When that calls a real handler) assert
// their `status === HTTP_STATUS_OK` HARD. Observation steps (Then/And) use `expect.soft(...)`
// naming the missing capability for every step the HONEST STATE classifies NOT BUILT — the test
// still fails, and every gap is reported by name, never hidden or softened into a pass.
//
// S1/1 exercises: handleApproveInbound -> handleReceiveLine (receive-inbound, THE GOLDEN SLICE).
// S1/2 seeds two batches through the SAME golden slice (approve -> receive x2 -> confirm putaway
// x2), then drives process-outbound's own chain: handleCreateOutbound -> handleRunOutboundChecks ->
// handleApproveOutbound -> handleAllocate -> handleGeneratePickList -> handlePickLine ->
// handleCheckOrder (by a SECOND actor — checker != picker, SelfCheckNotAllowedError otherwise).
//
// X part 5d (ADR-0006 Decision 2): every command below is now a REAL HTTP call — `app.inject(...)`
// against the Fastify host built by fixtures/host.ts, authenticated by a real `identity.sessions`
// Bearer token (fixtures/actors.ts's `issueActorSession`), scoped by `X-Entity-Id`. The host itself
// resolves the handler, runs authentication + entity scope, and returns the handler's own
// `{ status, body }` — this file no longer builds an `ApiRequest` or calls a handler in-process.

import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import type { QueryResult } from 'pg';
import type { Pool } from 'pg';

import { HTTP_STATUS_OK } from '@pg-eos/api-kit';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';

import { handleApproveInbound, handleConfirmPutaway, handleReceiveLine } from '../../modules/wms/api/receive-inbound/handlers.js';
import {
  handleAllocate,
  handleApproveOutbound,
  handleCheckOrder,
  handleCreateOutbound,
  handleGeneratePickList,
  handlePickLine,
  handleRunOutboundChecks,
} from '../../modules/wms/api/process-outbound/handlers.js';

import { SCENARIO_ACTOR_ROLE_CODES, createActor, issueActorSession, teardownActor } from './fixtures/actors.js';
import { MS_PER_HOUR, clock, createIds, daysAfterClock } from './fixtures/clock.js';
import { buildScenarioHost, type NamedHandler, type ScenarioHost } from './fixtures/host.js';
import {
  PDL_ENTITY_CODE,
  SCENARIO_ENTITY_CODE,
  SCENARIO_WAREHOUSE_CODE,
  getEntityIdByCode,
  getServiceIdByCode,
  getWarehouseIdByCode,
  pickStorageLocationIds,
} from './fixtures/lookups.js';
import { runCleanupSteps } from './fixtures/cleanup.js';
import { createPool } from './fixtures/pool.js';
import { createCorrelationTracker } from './fixtures/request.js';
import {
  deleteClient,
  deleteContract,
  deleteDocumentTemplateIfOwned,
  deleteDocumentsForOrders,
  deleteOrderAndLines,
  deletePriceList,
  deleteSku,
  deleteStockForSku,
  ensureDocumentTemplate,
  insertClient,
  insertContract,
  insertDraftInboundOrder,
  insertOrderLine,
  insertPriceList,
  insertPriceListLine,
  insertSku,
} from './fixtures/seed.js';

// --- named constants (CLAUDE.md — no magic numbers) -----------------------------------------------

const S1_MIN_SHELF_LIFE_DAYS = 180; // "min receipt shelf life 180 days".
const S1_1_BATCH_EXPIRY_DAYS_FROM_CLOCK = 120; // "expiry 120 days from today".
const S1_1_ORDERED_QTY = '10.000';
const S1_1_BATCH_NO = 'B2409-7';
const DECISION_DUE_WITHIN_HOURS = 48; // "within 48 h".
const QUARANTINE_ZONE_CODE = 'QRT';
const STORAGE_ZONE_TYPE = 'storage';

const S1_2_BATCH_90_EXPIRY_DAYS = 90;
const S1_2_BATCH_200_EXPIRY_DAYS = 200;
const S1_2_BATCH_90_QTY = '15.000'; // finding 11: the 90-day batch holds >= the 12-unit order.
const S1_2_BATCH_200_QTY = '20.000';
const S1_2_BATCH_90_NO = 'B90';
const S1_2_BATCH_200_NO = 'B200';
const S1_2_OUTBOUND_QTY = '12.000';
const S1_2_OUTBOUND_ALLOCATED_ON_90_DAY_BATCH = 12;
const S1_2_OUTBOUND_ALLOCATED_ON_200_DAY_BATCH = 0;
const OF_01_PRICE = '25.000';
const OUTBOUND_ORDER_TYPE_STANDARD = 'standard';
const SHIP_TO_NAME = 'مستلم اختبار جالف';
const SHIP_TO_PHONE = '+96500000000';
const SHIP_TO_ADDRESS = 'عنوان اختبار جالف';
const SHIP_TO_AREA = 'منطقة اختبار جالف';
const OF_01_SERVICE_CODE = 'OF-01';
const OF_02_SERVICE_CODE = 'OF-02';
const OF_06_SERVICE_CODE = 'OF-06';
const OF_07_SERVICE_CODE = 'OF-07';
const S1_2_BILLABLE_SERVICE_CODES = [OF_01_SERVICE_CODE, OF_02_SERVICE_CODE, OF_06_SERVICE_CODE, OF_07_SERVICE_CODE] as const;
const S1_2_BILLABLE_EVENT_EXPECTED_COUNT = 1; // fix round finding 3: exactly one row per code.

// X part 5d: the host builds ALL_ROUTES' deps ONCE for the whole table (ADR-0006) — the two former
// per-composition seeds (receive-inbound, process-outbound) collapse into the one id generator the
// host is built with; same numeric seed as the former RECEIVE_INBOUND_IDS_SEED, never re-invented.
const S1_HOST_IDS_SEED = 91011;
const GRN_TEMPLATE_CODE = 'GRN-01';
const STORAGE_LOCATIONS_NEEDED = 2; // one per S1/2 batch (90-day, 200-day).
const INBOUND_LINE_NO_BATCH_90 = 1;
const INBOUND_LINE_NO_BATCH_200 = 2;

const ENTITY_ID_HEADER = 'x-entity-id';
const CONTENT_TYPE_HEADER = 'content-type';
const JSON_CONTENT_TYPE = 'application/json';
const GET_METHOD = 'GET';

test.describe('S1 Full 3PL client (Segment A, PST + PDL)', () => {
  const pool: Pool = createPool();
  // fix round finding 2: every correlationId this file generates, so afterAll can delete exactly
  // (and only) the platform.outbox rows this run itself wrote.
  const correlationTracker = createCorrelationTracker();

  let entityId: string;
  let warehouseId: string;
  let pdlEntityId: string;
  let clientId: string;
  let contractId: string;
  let skuOneId: string;
  let skuTwoId: string;
  let mainActorId: string;
  let checkerActorId: string;
  let mainActorToken = '';
  let checkerActorToken = '';
  let host: ScenarioHost | undefined;
  // Assigned inside the two tests below — cleaned up in the describe-level afterAll, since both
  // tests share ONE beforeAll/afterAll (Master decision 5) and NOT serial mode means test 2 must
  // still be able to run (and be cleaned up) even if test 1 fails first.
  let s1OneOrderId = '';
  let s1TwoInboundOrderId = '';
  let s1TwoOutboundOrderId = '';
  let s1TwoPriceListId = '';
  let grnTemplateId = '';
  let grnTemplateOwned = false;

  /** apps/api/src/server.ts reads a GET route's command from `request.query`, never `request.body`
   *  (`body: method === 'GET' ? request.query : request.body`) — so a GET call's fields must travel
   *  as a query string, never a JSON payload. */
  function toQueryString(body: Record<string, unknown>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    return params.toString();
  }

  /** X part 5d: every in-process `handleXxx(requestWithKey(body, ctxFor(actor)), deps)` call becomes
   *  this — an HTTP request to the real host. `handler` is the imported function itself (its `.name`
   *  is looked up against the mounted route table — never a hand-typed path); `forEntityId` is the
   *  entity the step acts in (PST for every warehouse step below). */
  async function callHttp(
    handler: NamedHandler,
    body: Record<string, unknown>,
    token: string,
    forEntityId: string,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    if (!host) throw new Error('callHttp: host is not built yet — beforeAll must run first');
    const route = host.routeFor(handler);
    const isGet = route.method === GET_METHOD;
    const query = isGet ? toQueryString(body) : '';
    const url = query ? `${route.path}?${query}` : route.path;
    // fix round finding 5: Idempotency-Key and content-type only apply to a command with a body —
    // a GET carries neither (its fields travel as the query string above).
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      [ENTITY_ID_HEADER]: forEntityId,
    };
    if (!isGet) {
      headers[IDEMPOTENCY_KEY_HEADER_NAME] = randomUUID();
      headers[CONTENT_TYPE_HEADER] = JSON_CONTENT_TYPE;
    }
    const response = await host.app.inject({
      method: route.method,
      url,
      headers,
      ...(isGet ? {} : { payload: body }),
    });
    // A non-JSON response (by content-type) falls back to the raw body so `expect(result.status)`
    // still reports; a JSON content-type MUST parse — its parse error surfaces, never swallowed.
    const responseContentType = String(response.headers[CONTENT_TYPE_HEADER] ?? '');
    const responseBody: unknown = responseContentType.includes(JSON_CONTENT_TYPE) ? response.json() : response.body;
    return { status: response.statusCode, body: responseBody };
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  test.beforeAll(async () => {
    entityId = await getEntityIdByCode(pool, SCENARIO_ENTITY_CODE);
    warehouseId = await getWarehouseIdByCode(pool, SCENARIO_WAREHOUSE_CODE);
    pdlEntityId = await getEntityIdByCode(pool, PDL_ENTITY_CODE);

    // receive-line.ts's own getDocumentTemplateId requires this row before it can post a receipt
    // (fixture defect found while running this suite — same seed the golden slice's own
    // receive-inbound.test.ts:572-577 performs; never a reclassification of a BACKED step). Fix
    // round finding 1: only delete it in afterAll if THIS run inserted it (D-183) — another suite
    // (or an interrupted previous run) may already own the same global `code`.
    const grnTemplate = await ensureDocumentTemplate(pool, {
      code: GRN_TEMPLATE_CODE,
      nameAr: 'إذن استلام بضاعة اختبار سيناريو',
      bodyHtml: '<div>GRN {{doc_no}}</div>',
    });
    grnTemplateId = grnTemplate.id;
    grnTemplateOwned = grnTemplate.owned;

    clientId = await insertClient(pool, { codePrefix: '_s1_', nameEn: 'GULF', nameAr: 'عميل اختبار جالف' });
    contractId = await insertContract(pool, { entityId, accountId: clientId, titleAr: 'عقد اختبار جالف الكامل' });

    skuOneId = await insertSku(pool, {
      clientId,
      codePrefix: 'S1-GULF-0137-',
      nameEn: 'GULF-0137',
      nameAr: 'صنف اختبار جالف قصير الصلاحية',
      minRemainingLifeReceiptDays: S1_MIN_SHELF_LIFE_DAYS,
    });
    skuTwoId = await insertSku(pool, {
      clientId,
      codePrefix: 'S1-GULF-0137-',
      nameEn: 'GULF-0137',
      nameAr: 'صنف اختبار جالف صرف صادر',
      minRemainingLifeReceiptDays: null,
      minRemainingLifeIssueDays: null,
      trackBatch: true,
      trackExpiry: true,
      pickingPolicy: 'FEFO',
    });

    mainActorId = await createActor(pool, { namePrefix: '_s1_main', roleCodes: SCENARIO_ACTOR_ROLE_CODES });
    checkerActorId = await createActor(pool, { namePrefix: '_s1_checker', roleCodes: SCENARIO_ACTOR_ROLE_CODES });
    mainActorToken = await issueActorSession(pool, mainActorId);
    checkerActorToken = await issueActorSession(pool, checkerActorId);

    host = await buildScenarioHost(clock, createIds(S1_HOST_IDS_SEED));
  });

  test.afterAll(async () => {
    // fix round finding 11: every step below runs even if an earlier one throws (never abort at the
    // first failing DELETE and leak later tables); the pool always gets closed.
    const orderIds = [s1OneOrderId, s1TwoInboundOrderId, s1TwoOutboundOrderId].filter((id) => id !== '');
    try {
      await runCleanupSteps([
        // fix round finding 2: platform.outbox is NOT protected like platform.audit_log.
        [
          'platform.outbox',
          () => pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [correlationTracker.all()]),
        ],
        // fix round finding 1: scoped to THIS run's own order ids, never to the template id.
        ['platform.documents', () => deleteDocumentsForOrders(pool, orderIds)],
        [
          'wms.outbound_orders',
          () => (s1TwoOutboundOrderId ? deleteOrderAndLines(pool, 'wms.outbound_orders', s1TwoOutboundOrderId) : Promise.resolve()),
        ],
        [
          'wms.inbound_orders (S1/2)',
          () => (s1TwoInboundOrderId ? deleteOrderAndLines(pool, 'wms.inbound_orders', s1TwoInboundOrderId) : Promise.resolve()),
        ],
        [
          'wms.inbound_orders (S1/1)',
          () => (s1OneOrderId ? deleteOrderAndLines(pool, 'wms.inbound_orders', s1OneOrderId) : Promise.resolve()),
        ],
        // ReceiveLine always posts a receipt movement into a receiving-zone location (even for
        // S1/1's short-shelf-life batch) — both SKUs carry a real ledger row to clean up, never a
        // direct DELETE of anything the FEATURE itself was supposed to write (there is none: G1
        // only forbids inserting a ledgerless balance row, not this package's own teardown of rows
        // IT posted via the real handlers).
        ['wms.stock (sku 1)', () => (skuOneId ? deleteStockForSku(pool, skuOneId) : Promise.resolve())],
        ['wms.stock (sku 2)', () => (skuTwoId ? deleteStockForSku(pool, skuTwoId) : Promise.resolve())],
        ['wms.skus (sku 1)', () => (skuOneId ? deleteSku(pool, skuOneId) : Promise.resolve())],
        ['wms.skus (sku 2)', () => (skuTwoId ? deleteSku(pool, skuTwoId) : Promise.resolve())],
        ['sales.contracts', () => (contractId ? deleteContract(pool, contractId) : Promise.resolve())],
        ['catalog.price_lists', () => (s1TwoPriceListId ? deletePriceList(pool, s1TwoPriceListId) : Promise.resolve())],
        ['sales.accounts', () => (clientId ? deleteClient(pool, clientId) : Promise.resolve())],
        ['actor (main)', () => (mainActorId ? teardownActor(pool, mainActorId) : Promise.resolve())],
        ['actor (checker)', () => (checkerActorId ? teardownActor(pool, checkerActorId) : Promise.resolve())],
        // fix round finding 1: only deletes when THIS run inserted it (D-183).
        [
          'platform.document_templates',
          () => (grnTemplateId ? deleteDocumentTemplateIfOwned(pool, grnTemplateId, grnTemplateOwned) : Promise.resolve()),
        ],
      ]);
    } finally {
      // fix round finding 1: pool.end() must always run even if closing the host throws.
      try {
        await host?.app.close();
      } finally {
        await pool.end();
      }
    }
  });

  test('Inbound with short-shelf-life batch is quarantined', async () => {
    let orderId = '';
    let orderVersion = 0;

    await test.step('Given client "GULF" has active PST contract with min receipt shelf life 180 days', async () => {
      const contractResult: QueryResult<{ status: string; entity_id: string }> = await pool.query(
        `select status, entity_id from sales.contracts where id = $1`,
        [contractId],
      );
      const contractRow = contractResult.rows[0];
      expect(contractRow?.status).toBe('active');
      expect(contractRow?.entity_id).toBe(entityId);

      const skuResult: QueryResult<{ min_remaining_life_receipt_days: number }> = await pool.query(
        `select min_remaining_life_receipt_days from wms.skus where id = $1`,
        [skuOneId],
      );
      expect(skuResult.rows[0]?.min_remaining_life_receipt_days).toBe(S1_MIN_SHELF_LIFE_DAYS);
    });

    await test.step('And an approved inbound order for SKU "GULF-0137"', async () => {
      const draft = await insertDraftInboundOrder(pool, { entityId, clientId, warehouseId });
      await insertOrderLine(pool, { orderTable: 'wms.inbound_orders', orderId: draft.id, skuId: skuOneId, qtyOrdered: S1_1_ORDERED_QTY });
      orderId = draft.id;
      s1OneOrderId = draft.id;

      const approveResult = await callHttp(
        handleApproveInbound,
        { orderId, expectedVersion: draft.version, correlationId: correlationTracker.next() },
        mainActorToken,
        entityId,
      );
      expect(approveResult.status).toBe(HTTP_STATUS_OK);

      const versionResult: QueryResult<{ version: number }> = await pool.query(
        `select version from wms.inbound_orders where id = $1`,
        [orderId],
      );
      const approvedVersion = versionResult.rows[0]?.version;
      expect(typeof approvedVersion, 'inbound order version must be read back as a number after approve').toBe('number');
      if (approvedVersion === undefined) throw new Error('fixture: inbound order version missing after approve');
      orderVersion = approvedVersion;
    });

    await test.step('When the PDA receives batch "B2409-7" with expiry 120 days from today', async () => {
      const lineResult: QueryResult<{ id: string }> = await pool.query(
        `select id from wms.order_lines where order_table = 'wms.inbound_orders' and order_id = $1`,
        [orderId],
      );
      const lineId = lineResult.rows[0]?.id;
      if (!lineId) throw new Error('fixture wms.order_lines row not found for the S1/1 inbound order');

      const receiveResult = await callHttp(
        handleReceiveLine,
        {
          orderId,
          lineId,
          qtyActual: S1_1_ORDERED_QTY,
          batchNo: S1_1_BATCH_NO,
          expiryDate: daysAfterClock(S1_1_BATCH_EXPIRY_DAYS_FROM_CLOCK),
          expectedVersion: orderVersion,
          correlationId: correlationTracker.next(),
        },
        mainActorToken,
        entityId,
      );
      expect(receiveResult.status).toBe(HTTP_STATUS_OK);
    });

    await test.step('Then the line is placed in zone QRT', async () => {
      const balanceResult: QueryResult<{ zoneCode: string }> = await pool.query(
        `select z.code as "zoneCode"
           from wms.stock_balance sb
           join wms.locations l on l.id = sb.location_id
           join wms.zones z on z.id = l.zone_id
          where sb.sku_id = $1 and sb.batch_no = $2`,
        [skuOneId, S1_1_BATCH_NO],
      );
      expect.soft(
        balanceResult.rows[0]?.zoneCode,
        'NOT BUILT: receive-inbound has no shelf-life -> quarantine routing yet (backlog row "S1 QRT routing", owner 2.9 part 3) — ' +
          'the batch landed on a non-QRT zone instead',
      ).toBe(QUARANTINE_ZONE_CODE);
    });

    await test.step('And a decision item "quarantine_decision" is created for client contact within 48 h', async () => {
      const decisionResult: QueryResult<{ id: string; created_at: string; due_at: string | null }> = await pool.query(
        `select id, created_at, due_at from platform.decisions
          where kind = 'quarantine_decision' and source_table = 'wms.inbound_orders' and source_id = $1`,
        [orderId],
      );
      const decisionRow = decisionResult.rows[0];
      expect.soft(
        decisionRow,
        'NOT BUILT: no quarantine_decision item exists for platform.decisions (source_table=wms.inbound_orders, ' +
          `source_id=${orderId}) — the short-shelf-life-receipt decision workflow is not built yet (backlog row "S1 quarantine_decision", owner 2.9 part 3)`,
      ).toBeDefined();
      if (decisionRow) {
        const dueBoundMs = new Date(decisionRow.created_at).getTime() + DECISION_DUE_WITHIN_HOURS * MS_PER_HOUR;
        expect.soft(new Date(decisionRow.due_at ?? Number.NaN).getTime(), 'decision due_at must be within 48h of its own created_at').toBeLessThanOrEqual(
          dueBoundMs,
        );
      }
    });

    await test.step('And no stock_movement to a storage location exists for that batch', async () => {
      const movementResult: QueryResult<{ cnt: string }> = await pool.query(
        `select count(*)::text as cnt
           from wms.stock_movements sm
           join wms.locations l on l.id = sm.to_location_id
           join wms.zones z on z.id = l.zone_id
          where sm.sku_id = $1 and sm.batch_no = $2 and z.zone_type = $3`,
        [skuOneId, S1_1_BATCH_NO, STORAGE_ZONE_TYPE],
      );
      expect.soft(movementResult.rows[0]?.cnt, 'zero stock_movements into a storage-type zone for this batch').toBe('0');
    });
  });

  test('Outbound FEFO allocation and billing chain', async () => {
    let inboundOrderId = '';
    let outboundOrderId = '';
    const pickedLocations = await pickStorageLocationIds(pool, warehouseId, STORAGE_LOCATIONS_NEEDED);
    // fix round finding 6: repository.ts's own lot-picking, with both batches' expiry_date left
    // null by the pre-existing ledger defect asserted below, orders candidate lots by `location_id`
    // ascending — NOT by FEFO. Assigning the 90-day batch to whichever location id sorts LAST keeps
    // "Then allocation takes 12 units from the 90-day batch" genuinely RED (the 200-day batch's
    // smaller-sorting location is picked first) instead of passing by chance depending on
    // pickStorageLocationIds' own (code-ordered) result order.
    const [sortedFirst, sortedLast] = [...pickedLocations].sort();
    if (!sortedFirst || !sortedLast) throw new Error('fixture: expected two distinct storage locations');
    const location200 = sortedFirst;
    const location90 = sortedLast;

    await test.step('Given available stock of "GULF-0137" in two batches with expiries 90 and 200 days', async () => {
      const draft = await insertDraftInboundOrder(pool, { entityId, clientId, warehouseId });
      inboundOrderId = draft.id;
      s1TwoInboundOrderId = draft.id;
      const line90Id = await insertOrderLine(pool, {
        orderTable: 'wms.inbound_orders',
        orderId: inboundOrderId,
        skuId: skuTwoId,
        qtyOrdered: S1_2_BATCH_90_QTY,
        lineNo: INBOUND_LINE_NO_BATCH_90,
      });
      const line200Id = await insertOrderLine(pool, {
        orderTable: 'wms.inbound_orders',
        orderId: inboundOrderId,
        skuId: skuTwoId,
        qtyOrdered: S1_2_BATCH_200_QTY,
        lineNo: INBOUND_LINE_NO_BATCH_200,
      });

      const approveResult = await callHttp(
        handleApproveInbound,
        { orderId: inboundOrderId, expectedVersion: draft.version, correlationId: correlationTracker.next() },
        mainActorToken,
        entityId,
      );
      expect(approveResult.status).toBe(HTTP_STATUS_OK);
      let version = (
        await pool.query<{ version: number }>(`select version from wms.inbound_orders where id = $1`, [inboundOrderId])
      ).rows[0]?.version;
      if (version === undefined) throw new Error('fixture: inbound order version missing after approve');

      const receive90 = await callHttp(
        handleReceiveLine,
        {
          orderId: inboundOrderId,
          lineId: line90Id,
          qtyActual: S1_2_BATCH_90_QTY,
          batchNo: S1_2_BATCH_90_NO,
          expiryDate: daysAfterClock(S1_2_BATCH_90_EXPIRY_DAYS),
          expectedVersion: version,
          correlationId: correlationTracker.next(),
        },
        mainActorToken,
        entityId,
      );
      expect(receive90.status).toBe(HTTP_STATUS_OK);
      version = (
        await pool.query<{ version: number }>(`select version from wms.inbound_orders where id = $1`, [inboundOrderId])
      ).rows[0]?.version;
      if (version === undefined) throw new Error('fixture: inbound order version missing after receiving the 90-day batch');

      const receive200 = await callHttp(
        handleReceiveLine,
        {
          orderId: inboundOrderId,
          lineId: line200Id,
          qtyActual: S1_2_BATCH_200_QTY,
          batchNo: S1_2_BATCH_200_NO,
          expiryDate: daysAfterClock(S1_2_BATCH_200_EXPIRY_DAYS),
          expectedVersion: version,
          correlationId: correlationTracker.next(),
        },
        mainActorToken,
        entityId,
      );
      expect(receive200.status).toBe(HTTP_STATUS_OK);
      version = (
        await pool.query<{ version: number }>(`select version from wms.inbound_orders where id = $1`, [inboundOrderId])
      ).rows[0]?.version;
      if (version === undefined) throw new Error('fixture: inbound order version missing after receiving the 200-day batch');

      const putaway90 = await callHttp(
        handleConfirmPutaway,
        { orderId: inboundOrderId, lineId: line90Id, toLocationId: location90, expectedVersion: version, correlationId: correlationTracker.next() },
        mainActorToken,
        entityId,
      );
      expect(putaway90.status).toBe(HTTP_STATUS_OK);
      version = (
        await pool.query<{ version: number }>(`select version from wms.inbound_orders where id = $1`, [inboundOrderId])
      ).rows[0]?.version;
      if (version === undefined) throw new Error('fixture: inbound order version missing after putaway of the 90-day batch');

      const putaway200 = await callHttp(
        handleConfirmPutaway,
        { orderId: inboundOrderId, lineId: line200Id, toLocationId: location200, expectedVersion: version, correlationId: correlationTracker.next() },
        mainActorToken,
        entityId,
      );
      expect(putaway200.status).toBe(HTTP_STATUS_OK);

      // expiry_date is read as text (yyyy-mm-dd) so it compares exactly with daysAfterClock's ISO date.
      const expiryResult: QueryResult<{ batch_no: string; expiry_date: string | null }> = await pool.query(
        `select batch_no, expiry_date::text as expiry_date from wms.stock_balance where sku_id = $1 and batch_no = any($2::text[])`,
        [skuTwoId, [S1_2_BATCH_90_NO, S1_2_BATCH_200_NO]],
      );
      const expiryByBatch = new Map(expiryResult.rows.map((row) => [row.batch_no, row.expiry_date]));
      expect.soft(
        expiryByBatch.get(S1_2_BATCH_90_NO),
        'wms.stock_balance.expiry_date must equal the 90-day batch expiry (scenario clock date + 90 days)',
      ).toBe(daysAfterClock(S1_2_BATCH_90_EXPIRY_DAYS));
      expect.soft(
        expiryByBatch.get(S1_2_BATCH_200_NO),
        'wms.stock_balance.expiry_date must equal the 200-day batch expiry (scenario clock date + 200 days)',
      ).toBe(daysAfterClock(S1_2_BATCH_200_EXPIRY_DAYS));
    });

    await test.step('When an outbound order for 12 units is approved', async () => {
      const priceListId = await insertPriceList(pool, { entityId, codePrefix: '_s1_pl_', nameAr: 'قائمة تسعير اختبار جالف' });
      s1TwoPriceListId = priceListId;
      const of01ServiceId = await getServiceIdByCode(pool, OF_01_SERVICE_CODE);
      await insertPriceListLine(pool, { priceListId, serviceId: of01ServiceId, price: OF_01_PRICE });
      await pool.query(`update sales.contracts set price_list_id = $1 where id = $2`, [priceListId, contractId]);

      const createResult = await callHttp(
        handleCreateOutbound,
        {
          entityId,
          clientId,
          warehouseId,
          contractId,
          orderType: OUTBOUND_ORDER_TYPE_STANDARD,
          shipToName: SHIP_TO_NAME,
          shipToPhone: SHIP_TO_PHONE,
          shipToAddress: SHIP_TO_ADDRESS,
          shipToArea: SHIP_TO_AREA,
          correlationId: correlationTracker.next(),
        },
        mainActorToken,
        entityId,
      );
      expect(createResult.status).toBe(HTTP_STATUS_OK);
      const createBody = createResult.body;
      if (!isRecord(createBody) || typeof createBody['orderId'] !== 'string') {
        throw new Error(`handleCreateOutbound did not return ${HTTP_STATUS_OK}`);
      }
      outboundOrderId = createBody['orderId'];
      if (!outboundOrderId) throw new Error('handleCreateOutbound did not return an order id');
      s1TwoOutboundOrderId = outboundOrderId;
      const createdVersion = createBody['version'];
      expect(typeof createdVersion, 'handleCreateOutbound must return a numeric version').toBe('number');
      if (typeof createdVersion !== 'number') throw new Error('handleCreateOutbound did not return a numeric version');
      let version: number | undefined = createdVersion;

      await insertOrderLine(pool, { orderTable: 'wms.outbound_orders', orderId: outboundOrderId, skuId: skuTwoId, qtyOrdered: S1_2_OUTBOUND_QTY });

      const checksResult = await callHttp(
        handleRunOutboundChecks,
        { orderId: outboundOrderId, expectedVersion: version, correlationId: correlationTracker.next() },
        mainActorToken,
        entityId,
      );
      expect(checksResult.status).toBe(HTTP_STATUS_OK);
      version = (
        await pool.query<{ version: number }>(`select version from wms.outbound_orders where id = $1`, [outboundOrderId])
      ).rows[0]?.version;
      if (version === undefined) throw new Error('fixture: outbound order version missing after RunOutboundChecks');

      const approveResult = await callHttp(
        handleApproveOutbound,
        { orderId: outboundOrderId, expectedVersion: version, correlationId: correlationTracker.next() },
        mainActorToken,
        entityId,
      );
      expect(approveResult.status).toBe(HTTP_STATUS_OK);
      version = (
        await pool.query<{ version: number }>(`select version from wms.outbound_orders where id = $1`, [outboundOrderId])
      ).rows[0]?.version;
      if (version === undefined) throw new Error('fixture: outbound order version missing after ApproveOutbound');

      const allocateResult = await callHttp(
        handleAllocate,
        { orderId: outboundOrderId, expectedVersion: version, correlationId: correlationTracker.next() },
        mainActorToken,
        entityId,
      );
      expect(allocateResult.status).toBe(HTTP_STATUS_OK);
    });

    await test.step('Then allocation takes 12 units from the 90-day batch', async () => {
      const allocationResult: QueryResult<{ batch_no: string; qty_allocated: string }> = await pool.query(
        `select batch_no, qty_allocated from wms.stock_balance where sku_id = $1 and batch_no = any($2::text[])`,
        [skuTwoId, [S1_2_BATCH_90_NO, S1_2_BATCH_200_NO]],
      );
      const allocatedByBatch = new Map(allocationResult.rows.map((row) => [row.batch_no, Number(row.qty_allocated)]));
      expect.soft(
        allocatedByBatch.get(S1_2_BATCH_90_NO),
        'expected 12 units allocated from the 90-day batch (FEFO: earliest expiry first)',
      ).toBe(S1_2_OUTBOUND_ALLOCATED_ON_90_DAY_BATCH);
      expect.soft(allocatedByBatch.get(S1_2_BATCH_200_NO), 'expected 0 units allocated from the 200-day batch').toBe(
        S1_2_OUTBOUND_ALLOCATED_ON_200_DAY_BATCH,
      );
    });

    await test.step('And after checked, billable events OF-01×1, OF-02×1, OF-06×1, OF-07×1 exist with status pending', async () => {
      let version = (
        await pool.query<{ version: number }>(`select version from wms.outbound_orders where id = $1`, [outboundOrderId])
      ).rows[0]?.version;
      if (version === undefined) throw new Error('fixture: outbound order version missing before GeneratePickList');

      const pickListResult = await callHttp(
        handleGeneratePickList,
        { orderId: outboundOrderId, correlationId: correlationTracker.next() },
        mainActorToken,
        entityId,
      );
      expect(pickListResult.status).toBe(HTTP_STATUS_OK);

      const lineResult: QueryResult<{ id: string }> = await pool.query(
        `select id from wms.order_lines where order_table = 'wms.outbound_orders' and order_id = $1`,
        [outboundOrderId],
      );
      const outboundLineId = lineResult.rows[0]?.id;
      if (!outboundLineId) throw new Error('fixture: outbound order line not found');

      const pickResult = await callHttp(
        handlePickLine,
        { orderId: outboundOrderId, lineId: outboundLineId, expectedVersion: version, qtyActual: S1_2_OUTBOUND_QTY, correlationId: correlationTracker.next() },
        mainActorToken,
        entityId,
      );
      expect(pickResult.status).toBe(HTTP_STATUS_OK);
      version = (
        await pool.query<{ version: number }>(`select version from wms.outbound_orders where id = $1`, [outboundOrderId])
      ).rows[0]?.version;
      if (version === undefined) throw new Error('fixture: outbound order version missing after PickLine');

      // checker != picker (SelfCheckNotAllowedError otherwise) — a SECOND actor's own Bearer token.
      const checkResult = await callHttp(
        handleCheckOrder,
        { orderId: outboundOrderId, expectedVersion: version, correlationId: correlationTracker.next() },
        checkerActorToken,
        entityId,
      );
      expect(checkResult.status).toBe(HTTP_STATUS_OK);

      // fix round finding 3: exactly ONE row per code (a duplicate must fail this too), then its
      // status — never mere existence.
      const billableResult: QueryResult<{ code: string; cnt: string; status: string | null }> = await pool.query(
        `select s.code, count(be.id)::text as cnt, max(be.status) as status
           from catalog.services s
           left join billing.billable_events be
             on be.service_id = s.id and be.source_table = 'wms.outbound_orders' and be.source_id = $1
          where s.code = any($2::text[])
          group by s.code`,
        [outboundOrderId, S1_2_BILLABLE_SERVICE_CODES],
      );
      const rowByCode = new Map(billableResult.rows.map((row) => [row.code, row]));
      for (const code of S1_2_BILLABLE_SERVICE_CODES) {
        const row = rowByCode.get(code);
        const missingCapabilityMessage = `NOT BUILT: billing.billable_events row for ${code} does not exist (WBS 4.3 subscriber, stream B) for wms.outbound_orders/${outboundOrderId}`;
        expect.soft(Number(row?.cnt ?? 0), missingCapabilityMessage).toBe(S1_2_BILLABLE_EVENT_EXPECTED_COUNT);
        expect.soft(row?.status ?? undefined, missingCapabilityMessage).toBe('pending');
      }
    });

    await test.step('And the delivery task is created in PDL', async () => {
      const deliveryResult: QueryResult<{ id: string }> = await pool.query(
        `select id from tms.delivery_tasks where outbound_order_id = $1 and entity_id = $2`,
        [outboundOrderId, pdlEntityId],
      );
      expect.soft(
        deliveryResult.rows[0],
        `NOT BUILT: no tms.delivery_tasks row exists for outbound_order_id=${outboundOrderId}, entity_id=PDL (WBS 3.4, stream B/C)`,
      ).toBeDefined();
    });
  });
});
