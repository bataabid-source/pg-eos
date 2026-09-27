// tests/scenarios/S18.spec.ts — doc 40 Part E, Feature S18 (lines 572-579), integration lane wave 1
// (docs/notes/slice-briefs/_slice-X-s18.brief.md).
//
// HONEST STATE: every Gherkin line below is its own `test.step`, verbatim. The Given's allocation
// and the (daily, not monthly — see the step's own comment) snapshot are BACKED by real handlers —
// asserted HARD via `HTTP_STATUS_OK`. Every remaining Then/And/When is NOT BUILT (row 4.15 payable
// mirror + invoice auto-match, doc 40 §C6 line 324; row 4.3/pricing) and reported via a NAMED
// `expect.soft` — the test still fails, every gap is reported by name, never hidden or softened
// into a pass. The literal `variance_review` (doc 40 line 579) is not a legal
// `partners.partner_invoices.status` value under the live CHECK constraint — this is a DOC/SCHEMA
// GAP filed as docs/notes/SCR-PARTNERS-01.md; the last step asserts only the schema-legal frozen
// state (`status = 'frozen'`), never the literal `variance_review`.

import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import type { Pool, QueryResult } from 'pg';

import { HTTP_STATUS_OK } from '@pg-eos/api-kit';

import { createManageSpaceDeps } from '../../modules/wms/api/manage-space/composition.js';
import { handleAllocateSpace } from '../../modules/wms/api/manage-space/handlers.js';
import { createTakeOccupancySnapshotDeps } from '../../modules/wms/api/take-occupancy-snapshot/composition.js';
import { handleTakeOccupancySnapshot } from '../../modules/wms/api/take-occupancy-snapshot/handlers.js';

import { createActor, teardownActor } from './fixtures/actors.js';
import { clock, createIds, SCENARIO_CLOCK_DATE } from './fixtures/clock.js';
import { runCleanupSteps } from './fixtures/cleanup.js';
import { SCENARIO_ENTITY_CODE, getEntityIdByCode, getServiceIdByCode } from './fixtures/lookups.js';
import {
  deleteDecisionsForInvoice,
  deleteOccupancySnapshotsForWarehouse,
  deletePartner,
  deletePartnerContract,
  deletePartnerInvoice,
  deletePartnerPriceLine,
  deletePartnerWarehouse,
  deleteSpaceAllocationsForBlock,
  deleteSpaceBlock,
  deleteZone,
  insertPartner,
  insertPartnerContract,
  insertPartnerInvoice,
  insertPartnerPriceLine,
  insertPartnerSpaceBlock,
  insertPartnerWarehouse,
  insertStorageZone,
  PARTNER_INVOICES_SOURCE_TABLE,
} from './fixtures/partners.js';
import { createPool } from './fixtures/pool.js';
import { createCorrelationTracker, ctxFor, requestWithKey } from './fixtures/request.js';
import {
  deleteClient,
  deleteContract,
  deletePriceList,
  insertClient,
  insertContract,
  insertPriceList,
  insertPriceListLine,
} from './fixtures/seed.js';

// --- named constants (CLAUDE.md — no magic numbers) -----------------------------------------------

const ST_01_SERVICE_CODE = 'ST-01';
const PARTNER_COST_PRICE = '1.800'; // "cost 1.800" (doc 40 line 573).
const CLIENT_PRICE = '2.600'; // "price 2.600" (doc 40 line 573).
const ALLOCATION_QTY_PALLETS = 200; // "allocated 200 pallets" (doc 40 line 573).
const SPACE_UOM_PALLET = 'pallet';
const SPACE_ALLOCATION_STATUS_ACTIVE = 'active';
const BILLABLE_AMOUNT = '520.000'; // 200 x 2.600 (doc 40 line 575).
const PAYABLE_AMOUNT = '360.000'; // 200 x 1.800 (doc 40 line 575).
const RESALE_MARGIN_PCT = 30.77; // 100 x (520 - 360) / 520, view's own 2 dp precision (doc 40 line 576 prints 30.8%, presentation-rounded).
const BILLABLE_EVENT_STATUSES = ['priced', 'invoiced'] as const; // the only statuses partners.resale_margin reads.
const CLAIMED_AMOUNT = '8400.000'; // "claims 8,400" (doc 40 line 578).
const MATCHED_AMOUNT = '7900.000'; // "matched 7,900" (doc 40 line 578).
const VARIANCE_AMOUNT = '500.000'; // 8400 - 7900.
const PAID_AMOUNT_DEFAULT = '0.000'; // NOT NULL DEFAULT 0 — "payment is frozen" (doc 40 line 579).
const INVOICE_STATUS_FROZEN = 'frozen'; // the schema-legal state for "payment is frozen" — SCR-PARTNERS-01.
const MATCH_TOLERANCE_PCT_KEY = 'partner.match_tolerance_pct'; // read from platform.thresholds, never hard-coded.
const MANAGE_SPACE_IDS_SEED = 91018;
const TAKE_SNAPSHOT_IDS_SEED = 91019;
const S18_ACTOR_ROLE_CODES = ['SALES_MGR', 'WH_MGR'] as const;

test.describe('S18 Storage at partner warehouse', () => {
  const pool: Pool = createPool();
  const manageSpaceDeps = createManageSpaceDeps({ clock, ids: createIds(MANAGE_SPACE_IDS_SEED) });
  const snapshotDeps = createTakeOccupancySnapshotDeps({ clock, ids: createIds(TAKE_SNAPSHOT_IDS_SEED) });
  // fix round precedent (S1/S2): every correlationId this file generates, so afterAll can delete
  // exactly (and only) the platform.outbox rows this run itself wrote.
  const correlationTracker = createCorrelationTracker();

  let entityId: string;
  let st01ServiceId: string;
  let partnerId: string;
  let partnerWarehouseId: string;
  let partnerZoneId: string;
  let partnerBlockId: string;
  let partnerContractId: string;
  let partnerContractStartDate: string;
  let partnerPriceLineId: string;
  let clientId: string;
  let clientPriceListId: string;
  let clientContractId: string;
  let actorId: string;
  // assigned inside the test — cleaned up in afterAll regardless of which step failed first.
  let invoiceId = '';

  test.beforeAll(async () => {
    entityId = await getEntityIdByCode(pool, SCENARIO_ENTITY_CODE);
    st01ServiceId = await getServiceIdByCode(pool, ST_01_SERVICE_CODE);

    partnerId = await insertPartner(pool, { codePrefix: '_s18_pw1_', nameEn: 'PW1', nameAr: 'شريك اختبار المستودع' });
    partnerWarehouseId = await insertPartnerWarehouse(pool, {
      entityId,
      partnerId,
      codePrefix: '_s18_wh_',
      nameAr: 'مستودع شريك اختبار',
    });
    partnerZoneId = await insertStorageZone(pool, {
      warehouseId: partnerWarehouseId,
      codePrefix: '_s18_zone_',
      nameAr: 'منطقة تخزين اختبار الشريك',
    });
    partnerBlockId = await insertPartnerSpaceBlock(pool, {
      entityId,
      warehouseId: partnerWarehouseId,
      zoneId: partnerZoneId,
      codePrefix: '_s18_blk_',
    });

    const partnerContract = await insertPartnerContract(pool, {
      entityId,
      partnerId,
      title: `_s18_${randomUUID()}`,
    });
    partnerContractId = partnerContract.id;
    partnerContractStartDate = partnerContract.startDate;
    partnerPriceLineId = await insertPartnerPriceLine(pool, {
      contractId: partnerContractId,
      serviceId: st01ServiceId,
      costPrice: PARTNER_COST_PRICE,
      uom: SPACE_UOM_PALLET,
      validFrom: partnerContractStartDate,
    });

    clientId = await insertClient(pool, { codePrefix: '_s18_', nameEn: 'GULF', nameAr: 'عميل اختبار جالف الشراكة' });
    clientPriceListId = await insertPriceList(pool, { entityId, codePrefix: '_s18_pl_', nameAr: 'قائمة تسعير اختبار الشراكة' });
    await insertPriceListLine(pool, { priceListId: clientPriceListId, serviceId: st01ServiceId, price: CLIENT_PRICE });
    clientContractId = await insertContract(pool, {
      entityId,
      accountId: clientId,
      titleAr: 'عقد اختبار جالف تخزين شريك',
      priceListId: clientPriceListId,
    });

    actorId = await createActor(pool, { namePrefix: '_s18_actor', roleCodes: S18_ACTOR_ROLE_CODES });
  });

  test.afterAll(async () => {
    // every cleanup step runs even if an earlier one throws (precedent S1/S2's own afterAll) — a
    // partial cleanup must never abort at the first failing DELETE and leak every later table's rows.
    try {
      await runCleanupSteps([
        ['platform.outbox', () => pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [correlationTracker.all()])],
        ['platform.decisions', () => (invoiceId ? deleteDecisionsForInvoice(pool, invoiceId) : Promise.resolve())],
        ['partners.partner_invoices', () => (invoiceId ? deletePartnerInvoice(pool, invoiceId) : Promise.resolve())],
        ['wms.space_allocations', () => (partnerBlockId ? deleteSpaceAllocationsForBlock(pool, partnerBlockId) : Promise.resolve())],
        ['wms.occupancy_snapshots', () => (partnerWarehouseId ? deleteOccupancySnapshotsForWarehouse(pool, partnerWarehouseId) : Promise.resolve())],
        ['partners.partner_price_lines', () => (partnerPriceLineId ? deletePartnerPriceLine(pool, partnerPriceLineId) : Promise.resolve())],
        ['partners.partner_contracts', () => (partnerContractId ? deletePartnerContract(pool, partnerContractId) : Promise.resolve())],
        ['sales.contracts', () => (clientContractId ? deleteContract(pool, clientContractId) : Promise.resolve())],
        ['catalog.price_lists', () => (clientPriceListId ? deletePriceList(pool, clientPriceListId) : Promise.resolve())],
        ['sales.accounts', () => (clientId ? deleteClient(pool, clientId) : Promise.resolve())],
        ['wms.space_blocks', () => (partnerBlockId ? deleteSpaceBlock(pool, partnerBlockId) : Promise.resolve())],
        ['wms.zones', () => (partnerZoneId ? deleteZone(pool, partnerZoneId) : Promise.resolve())],
        ['wms.warehouses', () => (partnerWarehouseId ? deletePartnerWarehouse(pool, partnerWarehouseId) : Promise.resolve())],
        ['partners.partners', () => (partnerId ? deletePartner(pool, partnerId) : Promise.resolve())],
        ['actor', () => (actorId ? teardownActor(pool, actorId) : Promise.resolve())],
      ]);
    } finally {
      await pool.end();
    }
  });

  test('Paired billable and payable events', async () => {
    await test.step('Given "GULF" allocated 200 pallets at partner "PW1" (cost 1.800, price 2.600)', async () => {
      const partnerLineResult: QueryResult<{ cost_price: string }> = await pool.query(
        `select cost_price::text as cost_price from partners.partner_price_lines where id = $1`,
        [partnerPriceLineId],
      );
      expect(partnerLineResult.rows[0]?.cost_price).toBe(PARTNER_COST_PRICE);

      const clientLineResult: QueryResult<{ price: string }> = await pool.query(
        `select price::text as price from catalog.price_list_lines where price_list_id = $1 and service_id = $2`,
        [clientPriceListId, st01ServiceId],
      );
      expect(clientLineResult.rows[0]?.price).toBe(CLIENT_PRICE);

      const allocateResult = await handleAllocateSpace(
        requestWithKey(
          {
            contractId: clientContractId,
            clientId,
            blockId: partnerBlockId,
            qty: ALLOCATION_QTY_PALLETS,
            uom: SPACE_UOM_PALLET,
            serviceId: st01ServiceId,
            validFrom: SCENARIO_CLOCK_DATE,
            correlationId: correlationTracker.next(),
          },
          ctxFor(actorId),
        ),
        manageSpaceDeps,
      );
      expect(allocateResult.status).toBe(HTTP_STATUS_OK);

      const allocationResult: QueryResult<{ qty: string; status: string }> = await pool.query(
        `select qty::text as qty, status from wms.space_allocations where block_id = $1 and client_id = $2`,
        [partnerBlockId, clientId],
      );
      expect(Number(allocationResult.rows[0]?.qty)).toBe(ALLOCATION_QTY_PALLETS);
      expect(allocationResult.rows[0]?.status).toBe(SPACE_ALLOCATION_STATUS_ACTIVE);
    });

    await test.step('When the monthly snapshot runs', async () => {
      // The only snapshot command that exists is the DAILY handleTakeOccupancySnapshot (WBS 2.14) —
      // the monthly, allocation-based, priced partner storage run doc 40 describes is NOT BUILT
      // (row 4.15 + 4.3 + pricing). This step calls the daily command for PW1 instead (DEFAULT
      // recorded in the brief) and asserts only its own real, backed outcome: HTTP 200. The daily
      // snapshot bills OCCUPIED (physically stored) pallets, never an allocation — with no actual
      // stock stored in PW1 for GULF, clientsSnapshotted is 0, so no billable/payable event is
      // written by this call (asserted, NOT BUILT, in the next step).
      const snapshotResult = await handleTakeOccupancySnapshot(
        requestWithKey(
          { warehouseId: partnerWarehouseId, snapshotDate: SCENARIO_CLOCK_DATE, correlationId: correlationTracker.next() },
          ctxFor(actorId),
        ),
        snapshotDeps,
      );
      expect(snapshotResult.status).toBe(HTTP_STATUS_OK);
    });

    await test.step('Then a billable event 200×2.600 and a payable event 200×1.800 exist, linked', async () => {
      const billableResult: QueryResult<{ id: string; qty: string; unit_price: string | null; amount: string | null; status: string }> =
        await pool.query(
          `select be.id, be.qty::text as qty, be.unit_price::text as unit_price, be.amount::text as amount, be.status
             from billing.billable_events be
             join catalog.services s on s.id = be.service_id
            where be.client_id = $1 and s.code = $2`,
          [clientId, ST_01_SERVICE_CODE],
        );
      const billableRow = billableResult.rows[0];
      const billableMissingMessage =
        `NOT BUILT: no billing.billable_events row exists for client GULF / service ${ST_01_SERVICE_CODE} — the ` +
        'monthly, allocation-based, priced partner storage run (doc 40 §C6 line 324; row 4.15/4.3, pricing) does not exist yet';
      expect.soft(billableRow, billableMissingMessage).toBeDefined();
      if (billableRow) {
        expect.soft(Number(billableRow.qty), billableMissingMessage).toBe(ALLOCATION_QTY_PALLETS);
        expect.soft(billableRow.unit_price, billableMissingMessage).toBe(CLIENT_PRICE);
        expect.soft(billableRow.amount, billableMissingMessage).toBe(BILLABLE_AMOUNT);
        expect.soft(BILLABLE_EVENT_STATUSES as readonly string[], billableMissingMessage).toContain(billableRow.status);
      }

      const payableResult: QueryResult<{
        id: string;
        qty: string;
        cost_price: string | null;
        amount: string | null;
        billable_event_id: string | null;
      }> = await pool.query(
        `select id, qty::text as qty, cost_price::text as cost_price, amount::text as amount, billable_event_id
           from partners.payable_events where partner_id = $1`,
        [partnerId],
      );
      const payableRow = payableResult.rows[0];
      const payableMissingMessage =
        'NOT BUILT: no partners.payable_events row exists for partner PW1 — the payable mirror (row 4.15, doc 40 ' +
        '§C6 line 324: "payable_events (mirror of billable, linked by billable_event_id)") does not exist yet';
      expect.soft(payableRow, payableMissingMessage).toBeDefined();
      if (payableRow) {
        expect.soft(Number(payableRow.qty), payableMissingMessage).toBe(ALLOCATION_QTY_PALLETS);
        expect.soft(payableRow.cost_price, payableMissingMessage).toBe(PARTNER_COST_PRICE);
        expect.soft(payableRow.amount, payableMissingMessage).toBe(PAYABLE_AMOUNT);
        expect.soft(payableRow.billable_event_id, 'the payable event must be linked to the billable event above by billable_event_id').toBe(
          billableRow?.id ?? null,
        );
      }
    });

    await test.step('And resale_margin shows 30.8%', async () => {
      const marginResult: QueryResult<{ margin_pct: string | null }> = await pool.query(
        `select margin_pct::text as margin_pct
           from partners.resale_margin
          where entity_id = $1 and client_id = $2 and service_id = $3 and period = date_trunc('month', $4::date)::date`,
        [entityId, clientId, st01ServiceId, SCENARIO_CLOCK_DATE],
      );
      const marginRow = marginResult.rows[0];
      expect.soft(
        marginRow,
        'NOT BUILT: no partners.resale_margin row for (entity PST, client GULF, service ST-01, period=clock month) — ' +
          'RED until the billable/payable events above exist (row 4.15/4.3, pricing)',
      ).toBeDefined();
      if (marginRow) {
        expect.soft(
          Number(marginRow.margin_pct),
          'NOT BUILT: partners.resale_margin sums billing.billable_events (priced/invoiced) joined to ' +
            'partners.payable_events by billable_event_id — with neither row built yet (row 4.15/4.3, ' +
            'pricing) the view can only read the wrong inputs for margin_pct',
        ).toBe(RESALE_MARGIN_PCT);
      }
    });

    await test.step('When the partner invoice claims 8,400 against matched 7,900', async () => {
      // No matching command exists (row 4.15). The INPUT below is a fixture the step seeds (the
      // partner's claim is external data) — the OUTCOME (matching 8,400 against 7,900) is never
      // written by this spec; matched_amount/status stay at their own schema DEFAULTs.
      invoiceId = await insertPartnerInvoice(pool, {
        entityId,
        partnerId,
        contractId: partnerContractId,
        partnerRefPrefix: '_s18_ref_',
        claimedAmount: CLAIMED_AMOUNT,
      });
      expect.soft(
        false,
        'NOT BUILT: no partner-invoice matching command exists (row 4.15; doc 40 §C6 line 324: "auto-match; ' +
          'variance <= thresholds.partner.match_tolerance_pct auto-approve; else freeze + Decision item") — cannot ' +
          `match the claimed ${CLAIMED_AMOUNT} against ${MATCHED_AMOUNT}`,
      ).toBe(true);
    });

    await test.step('Then the invoice status is variance_review and payment is frozen', async () => {
      const thresholdResult: QueryResult<{ value: string }> = await pool.query(
        `select value::text as value from platform.thresholds where key = $1`,
        [MATCH_TOLERANCE_PCT_KEY],
      );
      const thresholdValue = thresholdResult.rows[0]?.value;
      if (thresholdValue === undefined) throw new Error(`platform.thresholds row not found for key ${MATCH_TOLERANCE_PCT_KEY}`);
      const tolerancePct = Number(thresholdValue);

      const invoiceResult: QueryResult<{
        matched_amount: string;
        variance_amount: string;
        variance_pct: string | null;
        status: string;
        paid_amount: string;
      }> = await pool.query(
        `select matched_amount::text as matched_amount, variance_amount::text as variance_amount,
                variance_pct::text as variance_pct, status, paid_amount::text as paid_amount
           from partners.partner_invoices where id = $1`,
        [invoiceId],
      );
      const invoiceRow = invoiceResult.rows[0];
      if (!invoiceRow) throw new Error('fixture partners.partner_invoices row not found for the S18 invoice');

      // DOC/SCHEMA GAP (docs/notes/SCR-PARTNERS-01.md): the literal `variance_review` (doc 40 line
      // 579) is not a legal chk_partner_invoices_status value — never asserted here. Only the
      // schema-legal frozen state (`status = 'frozen'`) is asserted, per the SCR's "What the spec
      // asserts meanwhile" section.
      const matchingMissingMessage =
        'NOT BUILT: no partner-invoice matching command exists (row 4.15) — matched_amount/status stay at their ' +
        'own NOT NULL DEFAULTs (0 / \'received\'), never reach the matched/frozen state';
      expect.soft(invoiceRow.matched_amount, matchingMissingMessage).toBe(MATCHED_AMOUNT);
      expect.soft(
        invoiceRow.variance_amount,
        'NOT BUILT: variance_amount is GENERATED from (claimed_amount - matched_amount) — with matched_amount at ' +
          `its DEFAULT 0 it reads ${CLAIMED_AMOUNT}, never the matched ${VARIANCE_AMOUNT} (row 4.15)`,
      ).toBe(VARIANCE_AMOUNT);
      const variancePctMessage =
        'NOT BUILT: variance_pct is GENERATED and stays NULL while matched_amount = 0 (row 4.15) — expected it ' +
        `above platform.thresholds partner.match_tolerance_pct (${tolerancePct})`;
      expect.soft(invoiceRow.variance_pct, variancePctMessage).not.toBeNull();
      if (invoiceRow.variance_pct !== null) {
        expect.soft(Number(invoiceRow.variance_pct), variancePctMessage).toBeGreaterThan(tolerancePct);
      }
      expect.soft(invoiceRow.status, matchingMissingMessage).toBe(INVOICE_STATUS_FROZEN);
      expect.soft(invoiceRow.paid_amount, 'paid_amount is NOT NULL DEFAULT 0 — nothing paid while frozen').toBe(PAID_AMOUNT_DEFAULT);

      const decisionResult: QueryResult<{ id: string }> = await pool.query(
        `select id from platform.decisions where source_table = $1 and source_id = $2`,
        [PARTNER_INVOICES_SOURCE_TABLE, invoiceId],
      );
      expect.soft(
        decisionResult.rows[0],
        `NOT BUILT: no platform.decisions row exists for source_table=${PARTNER_INVOICES_SOURCE_TABLE}, source_id=${invoiceId} ` +
          '(row 4.15; doc 40 §C6 line 324: "else freeze + Decision item")',
      ).toBeDefined();
    });
  });
});
