// tests/scenarios/S6.spec.ts — doc 40 Part E, Feature S6 (lines 485-494), integration lane wave 1
// (docs/notes/slice-briefs/_slice-X-s6.brief.md).
//
// HONEST STATE: every Gherkin line below is its own `test.step`, verbatim. The Given/And seed
// steps (client + three contracts + the REAL `handleSetCreditLimit` + the overdue PST invoice) are
// BACKED by real handlers/fixtures — asserted HARD via `HTTP_STATUS_OK` / direct column reads.
// 38-WBS.md row 1.8 "Group-level credit limit and hold" (the MANUAL limit/hold `sales.accounts`
// carries) is DONE @ 7fa0c43 — the Given step exercises it for real via `handleSetCreditLimit`. The
// AUTOMATIC nightly exposure/credit-hold job doc 40 line 489 describes belongs to a DIFFERENT row —
// 38-WBS.md row 4.9 "Aging, reminders (−3, 0, +7, +15, +30), automatic group-level hold" — which is
// TODO (depends on 4.7); row 1.11 (S6/S10 Playwright green) stays BLOCKED (D-178) on it. Every
// remaining Then/And is therefore a NAMED `expect.soft` — the test still fails, every gap is
// reported by name, never hidden or softened into a pass, and `handleSetCreditHold` is NEVER called
// to fake the job's outcome. The PST outbound-order step calls the REAL `handleCreateOutbound` /
// `handleRunOutboundChecks` against a fixture that satisfies every one of the other nine outbound
// conditions (doc 40 line 253) for real: stock received and put away through the REAL
// receive-inbound handlers (`handleApproveInbound` / `handleReceiveLine` / `handleConfirmPutaway`,
// same chain as S1.spec.ts:375-447 — real `wms.stock_movements` + `wms.stock_balance` rows, never a
// ledgerless raw insert, so G1 `wms.verify_balance_integrity` stays green), a client-owned SKU, a
// price-resolvable contract, a complete ship-to. errors.ts checks credit hold LAST, so with
// `credit_hold` genuinely still `false` (row 4.9's job never ran) the order genuinely does NOT reach
// `credit_rejected` even though every other condition passes; the soft-assertion message names the
// observed status/reason and the missing row-4.9 job as the cause. The PDL delivery-task step
// (38-WBS.md row 3.4) and the PCC queue step (row 5.1) have no command AND no module at all
// (`modules/tms/api`, `modules/cc` do not exist, grep-checked) — psql confirmed neither
// `tms.delivery_tasks` nor `cc.queues` carries a trigger that would enforce the hold at the DB level
// either (`pg_trigger`, 0 rows each), so both steps are pure NOT BUILT with no real check to
// exercise instead.

import { expect, test } from '@playwright/test';
import type { Pool, QueryResult } from 'pg';

import { HTTP_STATUS_OK } from '@pg-eos/api-kit';

import { createManageAccountCreditDeps } from '../../modules/sales/api/manage-account-credit/composition.js';
import { handleSetCreditLimit } from '../../modules/sales/api/manage-account-credit/handlers.js';
import { createReceiveInboundDeps } from '../../modules/wms/api/receive-inbound/composition.js';
import { handleApproveInbound, handleConfirmPutaway, handleReceiveLine } from '../../modules/wms/api/receive-inbound/handlers.js';
import { createProcessOutboundDeps } from '../../modules/wms/api/process-outbound/composition.js';
import { handleCreateOutbound, handleRunOutboundChecks } from '../../modules/wms/api/process-outbound/handlers.js';

import { createActor, teardownActor, WH_MGR_ROLE_CODE, WH_SUP_ROLE_CODE } from './fixtures/actors.js';
import { clock, createIds, daysAfterClock, SCENARIO_CLOCK_DATE } from './fixtures/clock.js';
import { runCleanupSteps } from './fixtures/cleanup.js';
import { deleteInvoice, insertOverdueInvoice, INVOICE_STATUS_OVERDUE } from './fixtures/credit.js';
import {
  getEntityIdByCode,
  getServiceIdByCode,
  getWarehouseIdByCode,
  PDL_ENTITY_CODE,
  pickStorageLocationIds,
  SCENARIO_ENTITY_CODE,
  SCENARIO_WAREHOUSE_CODE,
} from './fixtures/lookups.js';
import { createPool } from './fixtures/pool.js';
import { createCorrelationTracker, ctxFor, requestWithKey } from './fixtures/request.js';
import {
  deleteClient,
  deleteContract,
  deleteDocumentsForOrders,
  deleteDocumentTemplateIfOwned,
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

// platform.entities.code (psql-checked: PCC | Premium CC) — not exported by fixtures/lookups.ts
// (only PST/PDL are; brief's Fixture API section lists exactly those two).
const PCC_ENTITY_CODE = 'PCC';
// identity.roles.code (psql-checked) — required by SetCreditLimit
// (modules/sales/application/manage-account-credit/set-credit-limit.ts:14,45, grep-checked).
const CFO_ROLE_CODE = 'CFO';
// WH_SUP joins WH_MGR — the same two-role actor S1.spec.ts:173-174 (SCENARIO_ACTOR_ROLE_CODES) uses
// for this exact receive-inbound chain (approve/receive/putaway).
const S6_ACTOR_ROLE_CODES = [WH_MGR_ROLE_CODE, WH_SUP_ROLE_CODE, CFO_ROLE_CODE] as const;

const CLIENT_NAME_EN = 'RETAIL'; // doc 40 line 487 literal client name.
const CLIENT_NAME_AR = 'عميل اختبار متعدد الكيانات';
const CREDIT_LIMIT_AMOUNT = '15000.000'; // doc 40 line 487 literal "credit_limit 15000".
// doc 40 line 488 ("pushes exposure above the limit") names no exact overage — this fixture chooses
// a 500 margin over CREDIT_LIMIT_AMOUNT (15000 + 500 = 15500), named here rather than an invented
// bare literal.
const OVERDUE_INVOICE_TOTAL = '15500.000';
const OVERDUE_INVOICE_DUE_DAYS_AGO = 30; // "overdue" (doc 40 line 488) — due 30 days before the clock.
const OVERDUE_INVOICE_ISSUE_DAYS_AGO = 60; // issued 30 days before its own due date.

const OF_01_SERVICE_CODE = 'OF-01'; // same service S1.spec.ts:455-525 resolves its PST order price against.
const OF_01_PRICE = '25.000'; // S1.spec.ts's own price for OF-01 — reused so RunOutboundChecks fails
// (if it does) on credit hold's own absence rather than an unrelated price-resolution gap.
const OUTBOUND_ORDER_TYPE_STANDARD = 'standard';
const PST_OUTBOUND_QTY = '5.000'; // arbitrary minimal qty — irrelevant to the credit-hold assertion.
// review round 1 fix (finding 2): the other nine outbound conditions (doc 40 line 253) must all be
// satisfiable so credit hold is the ONLY condition left to decide. Real available stock — received
// and put away through the REAL receive-inbound handlers (S1.spec.ts:375-447's own chain), never a
// raw wms.stock_balance insert (that left no wms.stock_movements row, so G1
// wms.verify_balance_integrity read a ledgerless balance — INV-C3-2). qty ≥ PST_OUTBOUND_QTY so
// "sufficient available qty" passes; putaway to an unblocked WH1 location so "location not blocked"
// passes. The real receive-inbound chain never carries expiryDate into wms.stock_balance (S1's own
// documented NOT BUILT finding, S1.spec.ts:449-450) — harmless here since the SKU's own
// min_remaining_life_issue_days is null (no shelf-life minimum configured).
const PST_OUTBOUND_STOCK_LOCATION_COUNT = 1;
const PST_OUTBOUND_STOCK_BATCH_NO = '_s6_batch_1';
const PST_OUTBOUND_STOCK_EXPIRY_DAYS_AHEAD = 200; // clock-anchored (daysAfterClock), never `new Date()`.
const PST_OUTBOUND_STOCK_QTY = '50.000'; // comfortably ≥ PST_OUTBOUND_QTY (5.000).
const INBOUND_LINE_NO = 1;
// receive-line.ts's own getDocumentTemplateId (modules/wms/infrastructure/receive-inbound/
// repository.ts:498, per S1.spec.ts:138-149's own comment) looks up this EXACT code — same literal
// S1.spec.ts:101 uses (`GRN_TEMPLATE_CODE = 'GRN-01'`), not an S6-specific one; `ensureDocumentTemplate`'s
// `on conflict (code) do nothing` (D-183) is exactly what lets two spec files share this one global
// row safely — only the run that actually inserted it (`owned`) ever deletes it.
const GRN_TEMPLATE_CODE = 'GRN-01';
const SHIP_TO_NAME = 'مستلم اختبار التجزئة';
const SHIP_TO_PHONE = '+96500000001';
const SHIP_TO_ADDRESS = 'عنوان اختبار التجزئة';
const SHIP_TO_AREA = 'منطقة اختبار التجزئة';

const CREDIT_REJECTED_STATUS = 'credit_rejected'; // legal under chk_outbound_orders_status (psql-checked).
// brief Facts (line 34): "the run transitions an order to 'credit_rejected' when the client is on
// hold (errors.ts i18n 'wms.outbound.check.creditHold')".
const CREDIT_HOLD_I18N_KEY = 'wms.outbound.check.creditHold';

const NIGHTLY_JOB_NOT_BUILT_MESSAGE =
  'NOT BUILT: 38-WBS.md row 4.9 "Aging, reminders (−3, 0, +7, +15, +30), automatic group-level hold" ' +
  'owns this automation and is TODO (depends on 4.7; row 1.8, the manual limit/hold, is DONE @ ' +
  '7fa0c43 and is exercised by the Given step) — row 1.11 (S6/S10 Playwright green) stays BLOCKED ' +
  '(D-178) on it (doc 40 line 489; docs/PROJECT_STATE.md)';

const PROCESS_OUTBOUND_IDS_SEED = 90601; // brief: "ids seed 906xx".
const MANAGE_ACCOUNT_CREDIT_IDS_SEED = 90602;
const RECEIVE_INBOUND_IDS_SEED = 90603;

test.describe('S6 Multi-entity client', () => {
  const pool: Pool = createPool();
  const manageAccountCreditDeps = createManageAccountCreditDeps({ clock, ids: createIds(MANAGE_ACCOUNT_CREDIT_IDS_SEED) });
  const processOutboundDeps = createProcessOutboundDeps({ clock, ids: createIds(PROCESS_OUTBOUND_IDS_SEED) });
  const receiveInboundDeps = createReceiveInboundDeps({ clock, ids: createIds(RECEIVE_INBOUND_IDS_SEED) });
  // fix round precedent (S1/S2/S18): every correlationId this file generates, so afterAll can
  // delete exactly (and only) the platform.outbox rows this run itself wrote.
  const correlationTracker = createCorrelationTracker();

  let pstEntityId: string;
  let pdlEntityId: string;
  let pccEntityId: string;
  let warehouseId: string;
  let of01ServiceId: string;
  let clientId: string;
  let pstContractId: string;
  let pdlContractId: string;
  let pccContractId: string;
  let priceListId: string;
  let skuId: string;
  let actorId: string;
  let inboundOrderId = '';
  let grnTemplateId = '';
  let grnTemplateOwned = false;
  // assigned inside the test — cleaned up in afterAll regardless of which step failed first.
  let invoiceId = '';
  let outboundOrderId = '';

  test.beforeAll(async () => {
    pstEntityId = await getEntityIdByCode(pool, SCENARIO_ENTITY_CODE);
    pdlEntityId = await getEntityIdByCode(pool, PDL_ENTITY_CODE);
    pccEntityId = await getEntityIdByCode(pool, PCC_ENTITY_CODE);
    warehouseId = await getWarehouseIdByCode(pool, SCENARIO_WAREHOUSE_CODE);
    of01ServiceId = await getServiceIdByCode(pool, OF_01_SERVICE_CODE);

    clientId = await insertClient(pool, { codePrefix: '_s6_', nameEn: CLIENT_NAME_EN, nameAr: CLIENT_NAME_AR });

    pstContractId = await insertContract(pool, { entityId: pstEntityId, accountId: clientId, titleAr: 'عقد اختبار التجزئة - بي إس تي' });
    pdlContractId = await insertContract(pool, { entityId: pdlEntityId, accountId: clientId, titleAr: 'عقد اختبار التجزئة - بي دي إل' });
    pccContractId = await insertContract(pool, { entityId: pccEntityId, accountId: clientId, titleAr: 'عقد اختبار التجزئة - بي سي سي' });

    priceListId = await insertPriceList(pool, { entityId: pstEntityId, codePrefix: '_s6_pl_', nameAr: 'قائمة تسعير اختبار التجزئة' });
    await insertPriceListLine(pool, { priceListId, serviceId: of01ServiceId, price: OF_01_PRICE });
    await pool.query(`update sales.contracts set price_list_id = $1 where id = $2`, [priceListId, pstContractId]);

    skuId = await insertSku(pool, {
      clientId,
      codePrefix: '_s6_sku_',
      nameEn: 'RETAIL-SKU',
      nameAr: 'صنف اختبار التجزئة',
      minRemainingLifeReceiptDays: null,
      minRemainingLifeIssueDays: null,
      trackBatch: true,
      trackExpiry: true,
      pickingPolicy: 'FEFO',
    });

    actorId = await createActor(pool, { namePrefix: '_s6_actor', roleCodes: S6_ACTOR_ROLE_CODES });

    // review round 1 fix (finding 2): real available stock via the REAL receive-inbound chain — same
    // draft/approve/receive/putaway sequence as S1.spec.ts:375-447 — so "sufficient available qty"
    // and "location not blocked" (doc 40 line 253) are satisfied by a real wms.stock_movements +
    // wms.stock_balance pair, never a ledgerless raw insert (G1 wms.verify_balance_integrity /
    // INV-C3-2).
    const grnTemplate = await ensureDocumentTemplate(pool, {
      code: GRN_TEMPLATE_CODE,
      nameAr: 'إذن استلام بضاعة اختبار التجزئة',
      bodyHtml: '<div>GRN {{doc_no}}</div>',
    });
    grnTemplateId = grnTemplate.id;
    grnTemplateOwned = grnTemplate.owned;

    const draftInbound = await insertDraftInboundOrder(pool, { entityId: pstEntityId, clientId, warehouseId });
    inboundOrderId = draftInbound.id;
    const inboundLineId = await insertOrderLine(pool, {
      orderTable: 'wms.inbound_orders',
      orderId: inboundOrderId,
      skuId,
      qtyOrdered: PST_OUTBOUND_STOCK_QTY,
      lineNo: INBOUND_LINE_NO,
    });

    const approveInboundResult = await handleApproveInbound(
      requestWithKey({ orderId: inboundOrderId, expectedVersion: draftInbound.version, correlationId: correlationTracker.next() }, ctxFor(actorId)),
      receiveInboundDeps,
    );
    expect(approveInboundResult.status).toBe(HTTP_STATUS_OK);
    let inboundVersion = (
      await pool.query<{ version: number }>(`select version from wms.inbound_orders where id = $1`, [inboundOrderId])
    ).rows[0]?.version;
    if (inboundVersion === undefined) throw new Error('fixture: inbound order version missing after approve');

    const receiveLineResult = await handleReceiveLine(
      requestWithKey(
        {
          orderId: inboundOrderId,
          lineId: inboundLineId,
          qtyActual: PST_OUTBOUND_STOCK_QTY,
          batchNo: PST_OUTBOUND_STOCK_BATCH_NO,
          expiryDate: daysAfterClock(PST_OUTBOUND_STOCK_EXPIRY_DAYS_AHEAD),
          expectedVersion: inboundVersion,
          correlationId: correlationTracker.next(),
        },
        ctxFor(actorId),
      ),
      receiveInboundDeps,
    );
    expect(receiveLineResult.status).toBe(HTTP_STATUS_OK);
    inboundVersion = (
      await pool.query<{ version: number }>(`select version from wms.inbound_orders where id = $1`, [inboundOrderId])
    ).rows[0]?.version;
    if (inboundVersion === undefined) throw new Error('fixture: inbound order version missing after receiving the batch');

    const stockLocationIds = await pickStorageLocationIds(pool, warehouseId, PST_OUTBOUND_STOCK_LOCATION_COUNT);
    const stockLocationId = stockLocationIds[0];
    if (!stockLocationId) throw new Error('fixture: no unblocked WH1 storage location found for the S6 stock seed');
    const putawayResult = await handleConfirmPutaway(
      requestWithKey(
        {
          orderId: inboundOrderId,
          lineId: inboundLineId,
          toLocationId: stockLocationId,
          expectedVersion: inboundVersion,
          correlationId: correlationTracker.next(),
        },
        ctxFor(actorId),
      ),
      receiveInboundDeps,
    );
    expect(putawayResult.status).toBe(HTTP_STATUS_OK);
  });

  test.afterAll(async () => {
    // every cleanup step runs even if an earlier one throws (precedent S1/S2/S18's own afterAll) —
    // a partial cleanup must never abort at the first failing DELETE and leak every later table's
    // rows. Order per S1.spec.ts:182-220's own afterAll: outbox, documents, outbound/inbound
    // orders+lines, stock, skus, (S6's own) invoice, contracts, price lists, client, actor, then the
    // owned-only document template last.
    const orderIds = [outboundOrderId, inboundOrderId].filter((id) => id !== '');
    try {
      await runCleanupSteps([
        ['platform.outbox', () => pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [correlationTracker.all()])],
        ['platform.documents', () => deleteDocumentsForOrders(pool, orderIds)],
        ['wms.outbound_orders', () => (outboundOrderId ? deleteOrderAndLines(pool, 'wms.outbound_orders', outboundOrderId) : Promise.resolve())],
        ['wms.inbound_orders', () => (inboundOrderId ? deleteOrderAndLines(pool, 'wms.inbound_orders', inboundOrderId) : Promise.resolve())],
        ['wms.stock (sku)', () => (skuId ? deleteStockForSku(pool, skuId) : Promise.resolve())],
        ['wms.skus', () => (skuId ? deleteSku(pool, skuId) : Promise.resolve())],
        ['billing.invoices', () => (invoiceId ? deleteInvoice(pool, invoiceId) : Promise.resolve())],
        ['sales.contracts (PST)', () => (pstContractId ? deleteContract(pool, pstContractId) : Promise.resolve())],
        ['sales.contracts (PDL)', () => (pdlContractId ? deleteContract(pool, pdlContractId) : Promise.resolve())],
        ['sales.contracts (PCC)', () => (pccContractId ? deleteContract(pool, pccContractId) : Promise.resolve())],
        ['catalog.price_lists', () => (priceListId ? deletePriceList(pool, priceListId) : Promise.resolve())],
        ['sales.accounts', () => (clientId ? deleteClient(pool, clientId) : Promise.resolve())],
        ['actor', () => (actorId ? teardownActor(pool, actorId) : Promise.resolve())],
        // fix round finding 1 precedent (S1.spec.ts:216-220): only deletes when THIS run inserted it (D-183).
        ['platform.document_templates', () => (grnTemplateId ? deleteDocumentTemplateIfOwned(pool, grnTemplateId, grnTemplateOwned) : Promise.resolve())],
      ]);
    } finally {
      await pool.end();
    }
  });

  test('Group-level hold blocks all entities', async () => {
    await test.step('Given client "RETAIL" has contracts with PST, PDL and PCC and credit_limit 15000', async () => {
      const clientResult: QueryResult<{ name_en: string | null; version: number }> = await pool.query(
        `select name_en, version from sales.accounts where id = $1`,
        [clientId],
      );
      const clientRow = clientResult.rows[0];
      if (!clientRow) throw new Error('fixture sales.accounts row not found for the S6 client');
      expect(clientRow.name_en).toBe(CLIENT_NAME_EN);

      const contractsResult: QueryResult<{ entity_id: string; status: string }> = await pool.query(
        `select entity_id, status from sales.contracts where account_id = $1 and entity_id = any($2::uuid[])`,
        [clientId, [pstEntityId, pdlEntityId, pccEntityId]],
      );
      expect(contractsResult.rows).toHaveLength(3);
      for (const row of contractsResult.rows) expect(row.status).toBe('active');

      const setCreditLimitResult = await handleSetCreditLimit(
        requestWithKey(
          {
            accountId: clientId,
            creditLimit: CREDIT_LIMIT_AMOUNT,
            expectedVersion: clientRow.version,
            correlationId: correlationTracker.next(),
          },
          ctxFor(actorId),
        ),
        manageAccountCreditDeps,
      );
      expect(setCreditLimitResult.status).toBe(HTTP_STATUS_OK);

      const creditLimitResult: QueryResult<{ credit_limit: string }> = await pool.query(
        `select credit_limit::text as credit_limit from sales.accounts where id = $1`,
        [clientId],
      );
      expect(creditLimitResult.rows[0]?.credit_limit).toBe(CREDIT_LIMIT_AMOUNT);
    });

    await test.step('And an overdue PST invoice pushes exposure above the limit', async () => {
      invoiceId = await insertOverdueInvoice(pool, {
        entityId: pstEntityId,
        clientId,
        contractId: pstContractId,
        total: OVERDUE_INVOICE_TOTAL,
        issueDate: daysAfterClock(-OVERDUE_INVOICE_ISSUE_DAYS_AGO),
        dueDate: daysAfterClock(-OVERDUE_INVOICE_DUE_DAYS_AGO),
      });

      const invoiceResult: QueryResult<{ balance: string; status: string; due_date: string }> = await pool.query(
        `select balance::text as balance, status, due_date::text as due_date from billing.invoices where id = $1`,
        [invoiceId],
      );
      const invoiceRow = invoiceResult.rows[0];
      if (!invoiceRow) throw new Error('fixture billing.invoices row not found for the S6 overdue invoice');
      expect(Number(invoiceRow.balance)).toBeGreaterThan(Number(CREDIT_LIMIT_AMOUNT));
      // paid_amount stays at its own NOT NULL DEFAULT 0, so balance (GENERATED total - paid_amount) reads total.
      expect(Number(invoiceRow.balance)).toBe(Number(OVERDUE_INVOICE_TOTAL));
      expect(invoiceRow.status).toBe(INVOICE_STATUS_OVERDUE);
      expect(invoiceRow.due_date < SCENARIO_CLOCK_DATE).toBe(true);
    });

    await test.step('When the nightly job runs', async () => {
      // NEVER call handleSetCreditHold here — that would fake the job's outcome instead of reporting
      // its absence. There is nothing real to call.
      expect.soft(false, NIGHTLY_JOB_NOT_BUILT_MESSAGE).toBe(true);
    });

    await test.step('Then credit_hold = true', async () => {
      const holdResult: QueryResult<{ credit_hold: boolean }> = await pool.query(
        `select credit_hold from sales.accounts where id = $1`,
        [clientId],
      );
      expect.soft(
        holdResult.rows[0]?.credit_hold,
        `${NIGHTLY_JOB_NOT_BUILT_MESSAGE} — sales.accounts.credit_hold is still its own NOT NULL DEFAULT false, never set by this scenario`,
      ).toBe(true);
    });

    await test.step('And a new PST outbound order is rejected with reason "credit hold"', async () => {
      const createResult = await handleCreateOutbound(
        requestWithKey(
          {
            entityId: pstEntityId,
            clientId,
            warehouseId,
            contractId: pstContractId,
            orderType: OUTBOUND_ORDER_TYPE_STANDARD,
            shipToName: SHIP_TO_NAME,
            shipToPhone: SHIP_TO_PHONE,
            shipToAddress: SHIP_TO_ADDRESS,
            shipToArea: SHIP_TO_AREA,
            correlationId: correlationTracker.next(),
          },
          ctxFor(actorId),
        ),
        processOutboundDeps,
      );
      expect(createResult.status).toBe(HTTP_STATUS_OK);
      if (!('orderId' in createResult.body)) throw new Error(`handleCreateOutbound did not return ${HTTP_STATUS_OK}`);
      outboundOrderId = createResult.body.orderId;
      if (!outboundOrderId) throw new Error('handleCreateOutbound did not return an order id');
      const version = createResult.body.version;

      await insertOrderLine(pool, { orderTable: 'wms.outbound_orders', orderId: outboundOrderId, skuId, qtyOrdered: PST_OUTBOUND_QTY });

      const checksResult = await handleRunOutboundChecks(
        requestWithKey({ orderId: outboundOrderId, expectedVersion: version, correlationId: correlationTracker.next() }, ctxFor(actorId)),
        processOutboundDeps,
      );
      const checksI18nKey = 'i18nKey' in checksResult.body ? checksResult.body.i18nKey : undefined;

      const orderStatusResult: QueryResult<{ status: string }> = await pool.query(
        `select status from wms.outbound_orders where id = $1`,
        [outboundOrderId],
      );
      const observedStatus = orderStatusResult.rows[0]?.status;
      const observedReason =
        checksI18nKey ??
        `none — handleRunOutboundChecks returned HTTP ${checksResult.status} (the fixture's own stock/price/ship-to setup satisfies every non-credit condition)`;
      // Master correction (before review): this fixture now supplies real stock (location not
      // blocked, sufficient available qty), a price-resolvable contract, a client-owned SKU and a
      // complete ship-to — every one of the other nine outbound conditions (doc 40 line 253) — so
      // credit hold is the ONLY condition left to decide. It is decided last (brief Facts line 34)
      // and sales.accounts.credit_hold is genuinely still false (the nightly job never ran), so the
      // order can never reach 'credit_rejected' here even though every other condition passes.
      const creditHoldRejectionMessage =
        `${NIGHTLY_JOB_NOT_BUILT_MESSAGE} — observed: handleRunOutboundChecks returned HTTP ${checksResult.status}, ` +
        `order status '${String(observedStatus)}', reason '${observedReason}' — never '${CREDIT_REJECTED_STATUS}'/` +
        `'${CREDIT_HOLD_I18N_KEY}' because credit_hold is genuinely still false, even though every other outbound ` +
        'condition (stock, SKU, price, ship-to, contract) was set up here to pass';
      expect.soft(observedStatus, creditHoldRejectionMessage).toBe(CREDIT_REJECTED_STATUS);
      expect.soft(checksI18nKey, creditHoldRejectionMessage).toBe(CREDIT_HOLD_I18N_KEY);
    });

    await test.step('And a new PDL delivery task is rejected with the same reason', async () => {
      const pdlMissingMessage =
        'NOT BUILT: no delivery-task command or module exists (modules/tms/api does not exist, grep-checked) — ' +
        '38-WBS.md row 3.4 "Delivery tasks, routes, POD..." owns tms.delivery_tasks and is not built. psql ' +
        'pg_trigger on tms.delivery_tasks returns 0 rows — no DB-level trigger enforces the credit hold either, ' +
        'so there is no real check to exercise instead of the missing command.';
      expect.soft(false, pdlMissingMessage).toBe(true);
    });

    await test.step('And a new PCC queue for "RETAIL" is rejected', async () => {
      const pccMissingMessage =
        'NOT BUILT: no cc module exists at all (modules/cc does not exist, grep-checked) — 38-WBS.md row 5.1 ' +
        '"M06 Call center: queues, agents, calls, tickets..." owns cc.queues and is not built. psql pg_trigger ' +
        'on cc.queues returns 0 rows — no DB-level trigger enforces the credit hold either, so there is no real ' +
        'check to exercise instead of the missing command.';
      expect.soft(false, pccMissingMessage).toBe(true);
    });
  });
});
