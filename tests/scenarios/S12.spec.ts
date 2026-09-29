// tests/scenarios/S12.spec.ts — doc 40 Part E, Feature S12 (lines 531-535), integration lane 3.
//
// HONEST STATE: `sales.opportunities` exists (database/schema/01-Data-Model.sql:475, psql-checked) but
// NO handler creates or closes an opportunity (`modules/sales/api` carries customer-profile,
// manage-account-credit, manage-contract, manage-quote, resolve-price only; grep of modules/ for
// "opportunit" hits quote/space code, never an opportunity command). The fixture opportunity is a raw
// INSERT (no handler writes the table). Every Gherkin line below is a named NOT BUILT; the test fails
// honestly and no raw UPDATE ever fakes the close.
//
// Owner chain (close command): row 1.5 (proof only @ f790da7, full slice pending; no backlog row yet)
// -> 6.7 "Scenarios S7, S9, S12 pass" (tasks/MASTER_BACKLOG.md:249, TODO).
// Owner chain (funnel report): 5.13 (report R-18, docs/package/25-Alerts-Reports-NFR.md:343) -> 6.3 -> 6.7.
//
// Once the close command exists this scenario must assert THROUGH IT: closing as lost without a
// lost_reason -> rejected; with a reason outside the closed list -> rejected; with a reason inside the
// closed list (doc 01 line 489: price · service · timing · competitor · no_decision) -> accepted.

import { expect, test } from '@playwright/test';
import type { Pool, QueryResult } from 'pg';

import { runCleanupSteps } from './fixtures/cleanup.js';
import { getEntityIdByCode, SCENARIO_ENTITY_CODE } from './fixtures/lookups.js';
import { createPool } from './fixtures/pool.js';
import { deleteClient, insertClient } from './fixtures/seed.js';

const S12_PREFIX = '_s12_';
const CLIENT_NAME_EN = 'S12-LOST-CLIENT';
const CLIENT_NAME_AR = 'عميل اختبار الفرصة الخاسرة';
const OPPORTUNITY_NAME = '_s12_opportunity';
const OPPORTUNITY_DOC_NO = '_s12_opp_doc_1';
const STAGE_NEGOTIATION = 'negotiation'; // doc 40 line 210 — last open stage before won | lost.

const CLOSE_OWNER_CHAIN =
  'row 1.5 (proof only @ f790da7, full slice pending; no backlog row yet) → 6.7 "Scenarios S7, S9, S12 pass" (tasks/MASTER_BACKLOG.md:249, TODO)';
const FUNNEL_OWNER_CHAIN = '5.13 (R-18, docs/package/25-Alerts-Reports-NFR.md:343) → 6.3 → 6.7 (tasks/MASTER_BACKLOG.md:249, TODO)';

const WHEN_NOT_BUILT = `NOT BUILT: no command closes a sales opportunity as lost (modules/sales/api has no opportunity use case, grep-checked) — owner ${CLOSE_OWNER_CHAIN}`;
const LOST_REASON_NOT_BUILT =
  `NOT BUILT: the mandatory closed-list lost_reason rule lives in the missing close-opportunity command — owner ${CLOSE_OWNER_CHAIN}`;
const FUNNEL_NOT_BUILT = `NOT BUILT: quarterly funnel report grouping losses by reason (report R-18) — owner ${FUNNEL_OWNER_CHAIN}`;

test.describe('S12 Lost opportunity', () => {
  const pool: Pool = createPool();
  let clientId = '';
  let opportunityId = '';

  test.beforeAll(async () => {
    const entityId = await getEntityIdByCode(pool, SCENARIO_ENTITY_CODE);
    clientId = await insertClient(pool, { codePrefix: S12_PREFIX, nameEn: CLIENT_NAME_EN, nameAr: CLIENT_NAME_AR });
    const result: QueryResult<{ id: string }> = await pool.query(
      `insert into sales.opportunities (doc_no, account_id, entity_id, name, stage)
       values ($1, $2, $3, $4, $5) returning id`,
      [OPPORTUNITY_DOC_NO, clientId, entityId, OPPORTUNITY_NAME, STAGE_NEGOTIATION],
    );
    const row = result.rows[0];
    if (!row) throw new Error('fixture sales.opportunities insert returned no row');
    opportunityId = row.id;
  });

  test.afterAll(async () => {
    try {
      // by id, never LIKE: `_` is a LIKE wildcard.
      await runCleanupSteps([
        ['sales.opportunities', () => (opportunityId ? pool.query(`delete from sales.opportunities where id = $1`, [opportunityId]) : Promise.resolve())],
        ['sales.accounts', () => (clientId ? deleteClient(pool, clientId) : Promise.resolve())],
      ]);
    } finally {
      await pool.end();
    }
  });

  test('Closed reason list', async () => {
    await test.step('When an opportunity is closed as lost', async () => {
      const fixture: QueryResult<{ stage: string; lost_reason: string | null }> = await pool.query(
        `select stage, lost_reason from sales.opportunities where id = $1`,
        [opportunityId],
      );
      // Fixture is real and still open; the close command itself is NOT BUILT.
      expect(fixture.rows[0]?.stage).toBe(STAGE_NEGOTIATION);
      expect(fixture.rows[0]?.lost_reason).toBeNull();
      expect.soft(false, WHEN_NOT_BUILT).toBe(true);
    });

    await test.step('Then a lost_reason from the closed list is mandatory', async () => {
      // Observation only, never a pass condition: sales.opportunities has only chk_opportunities_stage —
      // no CHECK/FK on lost_reason (psql-checked).
      test.info().annotations.push({ type: 'schema-observation', description: 'sales.opportunities.lost_reason has no CHECK/FK' });
      expect.soft(false, LOST_REASON_NOT_BUILT).toBe(true);
    });

    await test.step('And the quarterly funnel report groups losses by reason', async () => {
      expect.soft(false, FUNNEL_NOT_BUILT).toBe(true);
    });
  });
});
