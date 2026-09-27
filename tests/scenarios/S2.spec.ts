// tests/scenarios/S2.spec.ts — doc 40 Part E, Feature S2 (lines 448-454), enablement item 3a.
//
// HONEST STATE (docs/notes/slice-briefs/_slice-X-scenarios.brief.md): the Given is backed (a real
// contract whose price list carries exactly the six listed services and no VA-08 line — asserted
// HARD, it is this test's own fixture correctness). The When calls NO command — no value-added-
// service (VAS) use case exists among doc 38's built rows (stream B) — and is reported FAILED via a
// named `expect.soft`. The two Then/And lines are NOT BUILT observations, `expect.soft` as well.

import { expect, test } from '@playwright/test';
import type { Pool, QueryResult } from 'pg';

import { runCleanupSteps } from './fixtures/cleanup.js';
import { SCENARIO_ENTITY_CODE, getEntityIdByCode, getServiceIdByCode } from './fixtures/lookups.js';
import { createPool } from './fixtures/pool.js';
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
const ST_11_SERVICE_CODE = 'ST-11';
const HD_03_SERVICE_CODE = 'HD-03';
const HD_04_SERVICE_CODE = 'HD-04';
const HD_08_SERVICE_CODE = 'HD-08';
const OF_10_SERVICE_CODE = 'OF-10';
const VA_08_SERVICE_CODE = 'VA-08';
const S2_CONTRACT_SERVICE_CODES = [
  ST_01_SERVICE_CODE,
  ST_11_SERVICE_CODE,
  HD_03_SERVICE_CODE,
  HD_04_SERVICE_CODE,
  HD_08_SERVICE_CODE,
  OF_10_SERVICE_CODE,
] as const;
const S2_CONTRACT_SERVICE_COUNT = S2_CONTRACT_SERVICE_CODES.length;
const S2_PRICE_LIST_LINE_PRICE = '10.000';
const LOST_REVENUE_OBJECT_NAME_PATTERN = '%lost%revenue%';

test.describe('S2 2PL storage-only client', () => {
  const pool: Pool = createPool();

  let entityId: string;
  let clientId: string;
  let priceListId: string;
  let contractId: string;

  test.beforeAll(async () => {
    entityId = await getEntityIdByCode(pool, SCENARIO_ENTITY_CODE);
    clientId = await insertClient(pool, { codePrefix: '_s2_', nameEn: 'PARTS', nameAr: 'عميل اختبار بارتس' });
    priceListId = await insertPriceList(pool, { entityId, codePrefix: '_s2_pl_', nameAr: 'قائمة تسعير اختبار بارتس' });
    for (const code of S2_CONTRACT_SERVICE_CODES) {
      const serviceId = await getServiceIdByCode(pool, code);
      await insertPriceListLine(pool, { priceListId, serviceId, price: S2_PRICE_LIST_LINE_PRICE });
    }
    contractId = await insertContract(pool, {
      entityId,
      accountId: clientId,
      titleAr: 'عقد اختبار بارتس تخزين فقط',
      priceListId,
    });
  });

  test.afterAll(async () => {
    // fix round finding 11: every step runs even if an earlier one throws; the pool always closes.
    try {
      await runCleanupSteps([
        ['sales.contracts', () => (contractId ? deleteContract(pool, contractId) : Promise.resolve())],
        ['catalog.price_lists', () => (priceListId ? deletePriceList(pool, priceListId) : Promise.resolve())],
        ['sales.accounts', () => (clientId ? deleteClient(pool, clientId) : Promise.resolve())],
      ]);
    } finally {
      await pool.end();
    }
  });

  test('Off-contract service is captured, not lost', async () => {
    await test.step('Given client "PARTS" contract includes only ST-01, ST-11, HD-03, HD-04, HD-08, OF-10', async () => {
      const contractResult: QueryResult<{ status: string; price_list_id: string | null }> = await pool.query(
        `select status, price_list_id from sales.contracts where id = $1`,
        [contractId],
      );
      expect(contractResult.rows[0]?.status).toBe('active');
      expect(contractResult.rows[0]?.price_list_id).toBe(priceListId);

      const lineResult: QueryResult<{ code: string }> = await pool.query(
        `select s.code from catalog.price_list_lines pll
           join catalog.services s on s.id = pll.service_id
          where pll.price_list_id = $1
          order by s.code`,
        [priceListId],
      );
      const codes = lineResult.rows.map((row) => row.code);
      expect(codes).toHaveLength(S2_CONTRACT_SERVICE_COUNT);
      expect(codes.sort()).toEqual([...S2_CONTRACT_SERVICE_CODES].sort());
      expect(codes).not.toContain(VA_08_SERVICE_CODE);
    });

    await test.step('When the warehouse performs VA-08 shrink wrap for "PARTS"', async () => {
      // No value-added-service (VAS) command exists among doc 38's built rows (stream B) — this
      // step calls nothing and writes nothing, and is reported FAILED by name (Master decision:
      // finding 4), so the later Then/And steps below still run and report on their own.
      expect.soft(
        false,
        'NOT BUILT: no VAS (value-added-service) command exists yet (stream B, doc 38) — cannot ' +
          'perform "VA-08 shrink wrap" for client PARTS through any real handler',
      ).toBe(true);
    });

    await test.step('Then a billable event VA-08 exists with status pending and no price', async () => {
      const billableResult: QueryResult<{ status: string; unit_price: string | null; amount: string | null }> = await pool.query(
        `select be.status, be.unit_price, be.amount
           from billing.billable_events be
           join catalog.services s on s.id = be.service_id
          where be.client_id = $1 and s.code = $2`,
        [clientId, VA_08_SERVICE_CODE],
      );
      const billableRow = billableResult.rows[0];
      expect.soft(
        billableRow,
        `NOT BUILT: no billing.billable_events row exists for client PARTS / service ${VA_08_SERVICE_CODE} — the VAS ` +
          'command that would create it does not exist yet (stream B)',
      ).toBeDefined();
      if (billableRow) {
        expect.soft(billableRow.status).toBe('pending');
        expect.soft(billableRow.unit_price).toBeNull();
        expect.soft(billableRow.amount).toBeNull();
      }
    });

    await test.step('And it appears in the Lost Revenue report', async () => {
      // fix round finding 4(a): a routine cannot be read with `select * from` — only
      // information_schema.views is a candidate for the selectability check below; both
      // table_schema and table_name are needed to build a safe schema-qualified identifier.
      const viewResult: QueryResult<{ table_schema: string; table_name: string }> = await pool.query(
        `select table_schema, table_name from information_schema.views where table_name ilike $1`,
        [LOST_REVENUE_OBJECT_NAME_PATTERN],
      );
      const view = viewResult.rows[0];
      expect.soft(
        view,
        'NOT BUILT: no Lost Revenue report VIEW exists yet (doc 40 §C1 line 202: "pending events surface in the ' +
          `Lost Revenue report ... after 7 days") — expected a view matching ${LOST_REVENUE_OBJECT_NAME_PATTERN} in ` +
          'information_schema.views',
      ).toBeDefined();

      if (view) {
        // fix round finding 4(b): filter for THIS client's VA-08 row specifically — never a bare
        // `limit 1` on any row. Column names (`client_id`, `service_code`) are a DEFAULT guess (the
        // report's real shape is not fixed by doc 40) — adjusted when the report lands.
        const qualifiedName = `"${view.table_schema}"."${view.table_name}"`;
        try {
          const selectResult = await pool.query(`select 1 from ${qualifiedName} where client_id = $1 and service_code = $2`, [
            clientId,
            VA_08_SERVICE_CODE,
          ]);
          expect.soft(
            selectResult.rowCount,
            `Lost Revenue report view ${qualifiedName} exists but does not surface the VA-08 event for client PARTS ` +
              '(client_id/service_code filter — DEFAULT column-name guess, adjust when the report lands)',
          ).toBeGreaterThan(0);
        } catch (error) {
          expect.soft(
            false,
            `Lost Revenue report view ${qualifiedName} exists but the client_id/service_code filter failed: ${(error as Error).message}`,
          ).toBe(true);
        }
      }
    });
  });
});
