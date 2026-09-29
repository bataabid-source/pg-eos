// tests/scenarios/S9.spec.ts — doc 40 Part E, Feature S9 (lines 509-514), integration lane 3.
//
// HONEST STATE (every Gherkin line is its own `test.step`, verbatim):
// - Given "cold storage capacity is insufficient": BACKED through the REAL `handleReserveSpace`
//   (row 2.15, `wms.check_space_available()` guard). No cold block is seeded anywhere (psql: no
//   `wms.space_blocks.block_type = 'cold'` row), and nothing but raw SQL writes `wms.space_blocks`
//   (grep-checked: only tests insert it), so a `_s9_` cold block (2–8 C, catalog ST-05 is "Chilled
//   storage (2–8 C)", 13B L2543) is inserted with capacity_pallets left at its own DEFAULT 0 (no
//   invented capacity), and the real guard is asserted to REJECT a 200-pallet reservation.
// - When "an opportunity for 200 cold pallets is created": NOT BUILT. `sales.opportunities` exists
//   (doc 01) but no command/handler writes it (grep-checked: modules/sales has no opportunity use
//   case). Owner: row 1.5 (proof only @ f790da7, full slice pending; no backlog row yet), verified
//   by 6.7 (MASTER_BACKLOG L60/L249). A raw `_s9_` row (services_scope = the real ST-05 id) is
//   inserted ONLY as the trigger stand-in; the When step itself is a named soft failure. The table
//   has no pallet-quantity column (G-01: not invented).
// - Then decision "partner_or_decline" for GM: NOT BUILT — no doc-38 row names the
//   partner_or_decline producer; platform.decisions table 0.10 DONE @ 8914f30; Decisions inbox 6.3
//   TODO; verified by 6.7. The literal appears only at doc 40 L513 within doc 40. The query does not
//   depend on source_table/source_id (G-01): ids of kind='partner_or_decline' + assigned_role='GM'
//   are snapshotted before the When step and exactly one NEW id is expected after it.
// - And quote line ST-05 at margin 12% vs threshold 15%: the REAL `handleCreateQuote` +
//   `handleUpsertQuoteLine` (row 1.6, DONE) are BACKED hard: marginWarning true, margin 12.000.
//   The seeded ST-05 has standard_cost NULL (psql), so a margin cannot be derived from it: that is a
//   named soft (NOT DEFINED), and the line uses a `_s9_` clone of ST-05 (same category/uom/billing
//   basis, entity_id, min_price, requires_contract_clause; no handler writes catalog.services)
//   whose standard_cost makes 12% exact.
//   Threshold 15 is platform.thresholds `contract.min_margin_pct` (asserted hard); the handler
//   constant MARGIN_WARNING_CEILING (upsert-quote-line.ts L37) duplicates it (row 1.6 issue,
//   outside this slice) and the handler returns no threshold.

import { expect, test } from '@playwright/test';
import type { Pool, QueryResult } from 'pg';

import { HTTP_STATUS_OK } from '@pg-eos/api-kit';
import { PROBLEM_STATUS } from '@pg-eos/contracts';

import { createManageQuoteDeps } from '../../modules/sales/api/manage-quote/composition.js';
import { handleCreateQuote, handleUpsertQuoteLine } from '../../modules/sales/api/manage-quote/handlers.js';
import { createManageSpaceDeps } from '../../modules/wms/api/manage-space/composition.js';
import { handleReserveSpace } from '../../modules/wms/api/manage-space/handlers.js';

import { createActor, teardownActor } from './fixtures/actors.js';
import { runCleanupSteps } from './fixtures/cleanup.js';
import { clock, createIds, daysAfterClock } from './fixtures/clock.js';
import { getEntityIdByCode, getServiceIdByCode, getWarehouseIdByCode, SCENARIO_ENTITY_CODE, SCENARIO_WAREHOUSE_CODE } from './fixtures/lookups.js';
import { createPool } from './fixtures/pool.js';
import { createCorrelationTracker, ctxFor, requestWithKey } from './fixtures/request.js';
import { deleteClient, insertClient } from './fixtures/seed.js';

// --- named constants (CLAUDE.md — no magic numbers) -----------------------------------------------

const SALES_MGR_ROLE_CODE = 'SALES_MGR'; // both manage-space commands: "D5: SALES_MGR only" (errors.ts).
const SALES_REP_ROLE_CODE = 'SALES_REP'; // CreateQuote role gate (create-quote.ts L46).
const GM_ROLE_CODE = 'GM'; // doc 40 L513 "for GM".
const ST_05_CODE = 'ST-05'; // doc 40 L514.
const COLD_BLOCK_TYPE = 'cold'; // legal under wms.space_blocks block_type CHECK (psql-checked).
const COLD_TEMP_MIN_C = 2; // catalog ST-05 name_en "Chilled storage (2–8 C)" (13B L2543).
const COLD_TEMP_MAX_C = 8;
const COLD_PALLETS_REQUESTED = 200; // doc 40 L512 "200 cold pallets".
const PALLET_UOM = 'pallet';
const RESERVATION_REASON_QUOTE_PENDING = 'quote_pending'; // ReserveSpace reason enum.
const RESERVATION_DAYS = 7; // fixture choice; only needs expires_at > reserved_from and within the 30-day max.
const DECISION_KIND_PARTNER_OR_DECLINE = 'partner_or_decline'; // doc 40 L513 (verbatim).
const THRESHOLD_KEY_MIN_MARGIN = 'contract.min_margin_pct'; // platform.thresholds, value 15.000 (psql-checked).
const THRESHOLD_MIN_MARGIN_PCT = 15; // doc 40 L514 "threshold 15%".
const MARGIN_PCT_EXPECTED = 12; // doc 40 L514 "margin 12%".
// Fixture arithmetic for an exact 12% margin: (price - cost) / price = 12%  =>  cost = 88% of price.
const LINE_UNIT_PRICE = '100.000';
const LINE_STANDARD_COST = '88.000';
const QUOTE_VALIDITY_DAYS = 30; // fixture choice (only needs to be after the clock).
const CR_NUMBER_FIXTURE = '_s9_cr_1'; // sales.accounts.cr_number — INV-C2-1 needs it set; no handler writes it.

const MANAGE_QUOTE_IDS_SEED = 90901;
const MANAGE_SPACE_IDS_SEED = 90902;

const NOT_BUILT_OPPORTUNITY =
  'NOT BUILT: no command/handler creates sales.opportunities (modules/sales has no opportunity use case, ' +
  'grep-checked) — owner row 1.5 (proof only @ f790da7, full slice pending; no backlog row yet), verified by 6.7 ' +
  '(MASTER_BACKLOG L60/L249). The table has no pallet-quantity column, so "200 cold pallets" has nowhere to ' +
  'live (G-01: no invented column)';
const NOT_BUILT_DECISION =
  'NOT BUILT: nothing creates a platform.decisions row of kind "partner_or_decline" for GM (the literal ' +
  'appears only at doc 40 L513, within doc 40) — no doc-38 row names the partner_or_decline producer; ' +
  'platform.decisions table 0.10 DONE @ 8914f30; Decisions inbox 6.3 TODO; verified by 6.7';
const ST05_DATA_GAP =
  'DATA GAP: INV-C1-1 (doc 40 L197) — seeded ST-05 standard_cost NULL — owner row 1.3 (DEFERRED-POST-PILOT, ' +
  'D-127); no margin can be derived from it (G-01: no invented cost)';

test.describe('S9 Multi-entity prospect to contracts', () => {
  const pool: Pool = createPool();
  const manageQuoteDeps = createManageQuoteDeps({ clock, ids: createIds(MANAGE_QUOTE_IDS_SEED) });
  const manageSpaceDeps = createManageSpaceDeps({ clock, ids: createIds(MANAGE_SPACE_IDS_SEED) });
  const correlationTracker = createCorrelationTracker();

  let entityId = '';
  let warehouseId = '';
  let clientId = '';
  let actorId = '';
  let coldBlockId = '';
  let serviceId = '';
  let opportunityId = '';
  let st05Id = '';
  let newDecisionIds: readonly string[] = [];
  let quoteId = '';

  test.beforeAll(async () => {
    entityId = await getEntityIdByCode(pool, SCENARIO_ENTITY_CODE);
    warehouseId = await getWarehouseIdByCode(pool, SCENARIO_WAREHOUSE_CODE);
    clientId = await insertClient(pool, { codePrefix: '_s9_', nameEn: '_s9_ prospect', nameAr: 'عميل محتمل اختبار' });
    await pool.query(`update sales.accounts set cr_number = $1 where id = $2`, [CR_NUMBER_FIXTURE, clientId]);
    actorId = await createActor(pool, { namePrefix: '_s9_actor', roleCodes: [SALES_MGR_ROLE_CODE, SALES_REP_ROLE_CODE] });

    // `_s9_` clone of ST-05 (no handler writes catalog.services; the real row has standard_cost NULL).
    const st05 = await pool.query<{
      id: string;
      category_id: string;
      uom: string;
      billing_basis: string;
      entity_id: string | null;
      min_price: string | null;
      requires_contract_clause: boolean;
    }>(
      `select id, category_id, uom, billing_basis, entity_id, min_price, requires_contract_clause
         from catalog.services where code = $1`,
      [ST_05_CODE],
    );
    const st05Row = st05.rows[0];
    if (!st05Row) throw new Error('catalog.services ST-05 row not found');
    st05Id = st05Row.id;
    const svc: QueryResult<{ id: string }> = await pool.query(
      `insert into catalog.services
         (code, category_id, name_ar, name_en, uom, billing_basis, entity_id, min_price, requires_contract_clause, standard_cost)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [
        `_s9_ST-05_${correlationTracker.next()}`,
        st05Row.category_id,
        'تخزين مبرد اختبار',
        '_s9_ chilled storage',
        st05Row.uom,
        st05Row.billing_basis,
        st05Row.entity_id,
        st05Row.min_price,
        st05Row.requires_contract_clause,
        LINE_STANDARD_COST,
      ],
    );
    serviceId = (svc.rows[0] as { id: string }).id;
  });

  test.afterAll(async () => {
    try {
      await runCleanupSteps([
        ['platform.outbox', () => pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [correlationTracker.all()])],
        ['platform.decisions (captured new ids only)', () => (newDecisionIds.length > 0 ? pool.query(`delete from platform.decisions where id = any($1::uuid[])`, [newDecisionIds]) : Promise.resolve())],
        ['sales.quote_lines', () => (quoteId ? pool.query(`delete from sales.quote_lines where quote_id = $1`, [quoteId]) : Promise.resolve())],
        ['sales.quotes', () => (quoteId ? pool.query(`delete from sales.quotes where id = $1`, [quoteId]) : Promise.resolve())],
        ['sales.opportunities', () => (opportunityId ? pool.query(`delete from sales.opportunities where id = $1`, [opportunityId]) : Promise.resolve())],
        ['wms.space_reservations', () => (coldBlockId ? pool.query(`delete from wms.space_reservations where block_id = $1`, [coldBlockId]) : Promise.resolve())],
        ['wms.space_blocks', () => (coldBlockId ? pool.query(`delete from wms.space_blocks where id = $1`, [coldBlockId]) : Promise.resolve())],
        ['catalog.services', () => (serviceId ? pool.query(`delete from catalog.services where id = $1`, [serviceId]) : Promise.resolve())],
        ['sales.accounts', () => (clientId ? deleteClient(pool, clientId) : Promise.resolve())],
        ['actor', () => (actorId ? teardownActor(pool, actorId) : Promise.resolve())],
      ]);
    } finally {
      await pool.end();
    }
  });

  let decisionsBefore: readonly string[] = [];
  async function readPartnerOrDeclineIds(): Promise<string[]> {
    const result: QueryResult<{ id: string }> = await pool.query(
      `select id from platform.decisions where kind = $1 and assigned_role = $2`,
      [DECISION_KIND_PARTNER_OR_DECLINE, GM_ROLE_CODE],
    );
    return result.rows.map((row) => row.id);
  }

  test('Below-margin warning and partner requirement', async () => {
    await test.step('Given cold storage capacity is insufficient', async () => {
      const block: QueryResult<{ id: string }> = await pool.query(
        `insert into wms.space_blocks (entity_id, warehouse_id, code, block_type, temp_min, temp_max)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [entityId, warehouseId, `_s9_cold_${correlationTracker.next()}`, COLD_BLOCK_TYPE, COLD_TEMP_MIN_C, COLD_TEMP_MAX_C],
      );
      coldBlockId = (block.rows[0] as { id: string }).id;

      const reserve = await handleReserveSpace(
        requestWithKey(
          {
            blockId: coldBlockId,
            qty: COLD_PALLETS_REQUESTED,
            uom: PALLET_UOM,
            reservedFrom: daysAfterClock(0),
            expiresAt: daysAfterClock(RESERVATION_DAYS),
            reason: RESERVATION_REASON_QUOTE_PENDING,
            correlationId: correlationTracker.next(),
          },
          ctxFor(actorId),
        ),
        manageSpaceDeps,
      );
      // the real wms.check_space_available() guard rejects: capacity is insufficient.
      expect(reserve.status).toBe(PROBLEM_STATUS.UNPROCESSABLE_ENTITY);
      expect('title' in reserve.body ? reserve.body.title : undefined).toBe('SpaceNotAvailableError');
      const reservations = await pool.query(`select 1 from wms.space_reservations where block_id = $1`, [coldBlockId]);
      expect(reservations.rowCount).toBe(0);

      // real data: every OTHER cold block in the scenario warehouse (fixture excluded by id) cannot
      // hold the request either.
      const otherCold = await pool.query<{ total: string }>(
        `select coalesce(sum(capacity_pallets), 0)::text as total from wms.space_blocks
          where block_type = $1 and warehouse_id = $2 and id <> $3`,
        [COLD_BLOCK_TYPE, warehouseId, coldBlockId],
      );
      expect(Number(otherCold.rows[0]?.total)).toBeLessThan(COLD_PALLETS_REQUESTED);
    });

    await test.step('When an opportunity for 200 cold pallets is created', async () => {
      // snapshot BEFORE the trigger: ids of partner_or_decline decisions already assigned to GM.
      decisionsBefore = await readPartnerOrDeclineIds();
      // raw `_s9_` row is the trigger stand-in only; the creation itself is not built. The table has no
      // column for the pallet quantity ("200 cold pallets" has nowhere to live, G-01).
      const opp: QueryResult<{ id: string }> = await pool.query(
        `insert into sales.opportunities (doc_no, account_id, entity_id, name, services_scope)
         values ($1, $2, $3, $4, $5::uuid[]) returning id`,
        [`_s9_opp_${correlationTracker.next()}`, clientId, entityId, `_s9_ ${COLD_PALLETS_REQUESTED} cold pallets`, [st05Id]],
      );
      opportunityId = (opp.rows[0] as { id: string }).id;
      expect.soft(false, NOT_BUILT_OPPORTUNITY).toBe(true);
    });

    await test.step('Then a decision item "partner_or_decline" is created for GM', async () => {
      const after = await readPartnerOrDeclineIds();
      const before = new Set(decisionsBefore);
      newDecisionIds = after.filter((id) => !before.has(id));
      expect.soft(newDecisionIds.length, NOT_BUILT_DECISION).toBe(1);
    });

    await test.step('And a quote line for ST-05 at margin 12% shows a warning against threshold 15%', async () => {
      const st05 = await pool.query<{ standard_cost: string | null }>(
        `select standard_cost::text as standard_cost from catalog.services where id = $1`,
        [await getServiceIdByCode(pool, ST_05_CODE)],
      );
      expect.soft(
        st05.rows[0]?.standard_cost,
        `${ST05_DATA_GAP}; this run quotes a _s9_ clone of ST-05 with standard_cost ${LINE_STANDARD_COST}`,
      ).not.toBeNull();

      const threshold = await pool.query<{ value: string }>(`select value::text as value from platform.thresholds where key = $1`, [THRESHOLD_KEY_MIN_MARGIN]);
      expect(Number(threshold.rows[0]?.value)).toBe(THRESHOLD_MIN_MARGIN_PCT);

      const created = await handleCreateQuote(
        requestWithKey(
          {
            entityId,
            accountId: clientId,
            opportunityId,
            validUntil: daysAfterClock(QUOTE_VALIDITY_DAYS),
            termsAr: null,
            termsEn: null,
            correlationId: correlationTracker.next(),
          },
          ctxFor(actorId),
        ),
        manageQuoteDeps,
      );
      expect(created.status).toBe(HTTP_STATUS_OK);
      if (!('quoteId' in created.body)) throw new Error('handleCreateQuote returned no quoteId');
      quoteId = created.body.quoteId;

      const line = await handleUpsertQuoteLine(
        requestWithKey(
          {
            quoteId,
            serviceId,
            qty: String(COLD_PALLETS_REQUESTED),
            unitPrice: LINE_UNIT_PRICE,
            exceptionId: null,
            expectedVersion: created.body.version,
            correlationId: correlationTracker.next(),
          },
          ctxFor(actorId),
        ),
        manageQuoteDeps,
      );
      expect(line.status).toBe(HTTP_STATUS_OK);
      if (!('marginWarning' in line.body)) throw new Error('handleUpsertQuoteLine returned no marginWarning');
      expect(line.body.estimatedMarginPct).toBe(MARGIN_PCT_EXPECTED);
      expect(line.body.marginWarning).toBe(true);
    });
  });
});
