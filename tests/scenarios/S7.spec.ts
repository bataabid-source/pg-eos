// tests/scenarios/S7.spec.ts — doc 40 Part E, Feature S7 (lines 495-500), integration lane 3.
//
// HONEST STATE: every Gherkin line is its own `test.step`, verbatim.
// - Given client "TRIAL" in segment F with a 3-month contract: BACKED. "segment F" is the real seed
//   row catalog.segments code 'SEG-F' (name_en 'Trial', criteria {"trial": true}, psql-checked;
//   doc 05 line 323 maps "الشريحة F"). No handler assigns sales.accounts.segment_id (grep-checked),
//   so the fixture sets it with one UPDATE, like S6's raw contract insert. cr_number is set the same
//   way because the real CreateContract/CreateQuote handlers refuse an account without one
//   (INV-C2-1). The 3-month contract goes through the REAL handleCreateContract (CFO) with the
//   injected clock.
// - Then quotes use standard list prices with no discount: BACKED. Real resolvePrice answers via the active contract's annex (= the standard list, same id and price; activation requires a price list) instead of
//   'standard_list'; the REAL handleCreateQuote / handleUpsertQuoteLine store that price with
//   discount_amt 0; SEG-F carries discount_pct 0.
// - And credit_limit = 0: BACKED by the schema default (sales.accounts.credit_limit DEFAULT 0) —
//   handleSetCreditLimit is NOT needed and NOT called.
// - And an alert fires 14 days before contract end: NOT BUILT. Seeded rule N-06 fires on
//   notice_days (set to 14 here) against DB current_date and no scheduler runs it (row 6.7
//   owns it; 5.13 part 1 is only the evaluation mechanism). Named soft assertion, then it fails.

import { expect, test } from '@playwright/test';
import type { Pool, QueryResult } from 'pg';

import { HTTP_STATUS_OK } from '@pg-eos/api-kit';

import { createManageContractDeps } from '../../modules/sales/api/manage-contract/composition.js';
import { handleActivateContract, handleCreateContract, handleSetContractPriceList, handleSignContract } from '../../modules/sales/api/manage-contract/handlers.js';
import { createManageQuoteDeps } from '../../modules/sales/api/manage-quote/composition.js';
import { handleCreateQuote, handleUpsertQuoteLine } from '../../modules/sales/api/manage-quote/handlers.js';
import { createResolvePriceDeps } from '../../modules/sales/api/resolve-price/composition.js';
import { resolvePrice } from '../../modules/sales/application/resolve-price/resolve-price.js';

import { createActor, teardownActor } from './fixtures/actors.js';
import { clock, createIds, daysAfterClock, SCENARIO_CLOCK_DATE } from './fixtures/clock.js';
import { runCleanupSteps } from './fixtures/cleanup.js';
import { getEntityIdByCode, getServiceIdByCode, SCENARIO_ENTITY_CODE } from './fixtures/lookups.js';
import { createPool } from './fixtures/pool.js';
import { createCorrelationTracker, ctxFor, requestWithKey } from './fixtures/request.js';
import { deleteClient, deleteContract, deletePriceList, insertClient, insertPriceList, insertPriceListLine } from './fixtures/seed.js';

// --- named constants (CLAUDE.md — no magic numbers) -----------------------------------------------

const CLIENT_NAME_EN = 'TRIAL'; // doc 40 line 497 literal client name.
const CLIENT_NAME_AR = 'عميل تجريبي';
const SEGMENT_F_CODE = 'SEG-F'; // catalog.segments row named "Trial" (psql-checked, doc 05 line 323).
const CFO_ROLE_CODE = 'CFO'; // required by CreateContract (create-contract.ts:ROLE_CFO).
const SALES_REP_ROLE_CODE = 'SALES_REP'; // required by CreateQuote (create-quote.ts:ROLE_SALES_REP).
const ACTOR_ROLE_CODES = [CFO_ROLE_CODE, SALES_REP_ROLE_CODE] as const;

const CONTRACT_TERM_MONTHS = 3; // doc 40 line 497 "3-month contract".
const CONTRACT_TITLE = 'TRIAL 3-month contract';
const ALERT_LEAD_DAYS = 14; // doc 40 line 500; doc 05 L335 "تنبيه قبل الانتهاء بـ 14 يوماً" — also the contract notice_days.
const CONTRACT_STATUS_ACTIVE = 'active'; // N-06 (13B L2893-2898) matches only active contracts.
const CONTRACT_SIGNED_BY = 'TRIAL signatory'; // free-text signer; any non-empty string is legal.

const OF_01_SERVICE_CODE = 'OF-01'; // service S1/S6 already price against (catalog.services, min_price null).
const STANDARD_LIST_PRICE = '25.000'; // same OF-01 list price S1/S6 seed — the "standard list price".
const QUOTE_QTY = '10.000';
const QUOTE_LINE_QTY_ONE = '1.000'; // resolvePrice with qty 1 => totalPrice is the unit price.
const ZERO_AMOUNT = '0.000'; // "no discount" and "credit_limit = 0" at numeric(14,3) scale.
const QUOTE_VALID_DAYS = 30; // arbitrary validity window, only has to be >= the clock date.
const QUOTE_CURRENCY = 'KWD';
const PRICE_SOURCE_CONTRACT_ANNEX = 'contract'; // resolve-price.ts unitPriceSource for an active contract's own list.
const EXPECTED_QUOTE_TOTAL = '250.000'; // QUOTE_QTY x STANDARD_LIST_PRICE = 10 x 25.000.
const N06_RULE_CODE = 'N-06'; // seeded contract-expiry alert rule (psql-checked).
const CR_NUMBER_PREFIX = '_s7_cr_';

const MANAGE_CONTRACT_IDS_SEED = 90701;
const MANAGE_QUOTE_IDS_SEED = 90702;

const ALERT_NOT_BUILT_MESSAGE =
  'NOT BUILT: evaluateAlertRules (5.13 part 1) exists but no scheduler runs N-06 and N-06 evaluates ' +
  'against DB current_date, not the scenario clock — owner row 6.7 (depends on 6.3 → 0.19, 5.13 part 2)';

test.describe('S7 Trial client', () => {
  const pool: Pool = createPool();
  const manageContractDeps = createManageContractDeps({ clock, ids: createIds(MANAGE_CONTRACT_IDS_SEED) });
  const manageQuoteDeps = createManageQuoteDeps({ clock, ids: createIds(MANAGE_QUOTE_IDS_SEED) });
  const resolvePriceDeps = createResolvePriceDeps();
  const correlationTracker = createCorrelationTracker();

  let entityId: string;
  let serviceId: string;
  let segmentFId: string;
  let clientId: string;
  let actorId: string;
  let priceListId = '';
  let contractId = '';
  let contractVersion = 0;
  let contractDocNo = '';
  let contractEndDate = '';
  let quoteId = '';

  test.beforeAll(async () => {
    entityId = await getEntityIdByCode(pool, SCENARIO_ENTITY_CODE);
    serviceId = await getServiceIdByCode(pool, OF_01_SERVICE_CODE);
    const segmentResult: QueryResult<{ id: string }> = await pool.query(`select id from catalog.segments where code = $1`, [SEGMENT_F_CODE]);
    const segmentRow = segmentResult.rows[0];
    if (!segmentRow) throw new Error(`catalog.segments row not found for ${SEGMENT_F_CODE}`);
    segmentFId = segmentRow.id;

    actorId = await createActor(pool, { namePrefix: '_s7_actor', roleCodes: ACTOR_ROLE_CODES });
    clientId = await insertClient(pool, { codePrefix: '_s7_', nameEn: CLIENT_NAME_EN, nameAr: CLIENT_NAME_AR });
    // no handler assigns segment_id or cr_number (grep-checked); credit_limit is deliberately NOT set.
    await pool.query(`update sales.accounts set segment_id = $1, cr_number = $2 where id = $3`, [
      segmentFId,
      `${CR_NUMBER_PREFIX}${clientId}`,
      clientId,
    ]);

    // the entity's standard (segment-less) list — the catalog seed carries none (psql-checked).
    priceListId = await insertPriceList(pool, { entityId, codePrefix: '_s7_pl_', nameAr: 'قائمة أسعار قياسية للتجربة' });
    await insertPriceListLine(pool, { priceListId, serviceId, price: STANDARD_LIST_PRICE });
  });

  test.afterAll(async () => {
    try {
      await runCleanupSteps([
        ['platform.outbox', () => pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [correlationTracker.all()])],
        ['sales.quote_lines', () => (quoteId ? pool.query(`delete from sales.quote_lines where quote_id = $1`, [quoteId]) : Promise.resolve())],
        ['sales.quotes', () => (quoteId ? pool.query(`delete from sales.quotes where id = $1`, [quoteId]) : Promise.resolve())],
        ['sales.contracts', () => (contractId ? deleteContract(pool, contractId) : Promise.resolve())],
        ['catalog.price_lists', () => (priceListId ? deletePriceList(pool, priceListId) : Promise.resolve())],
        ['sales.accounts', () => (clientId ? deleteClient(pool, clientId) : Promise.resolve())],
        ['actor', () => (actorId ? teardownActor(pool, actorId) : Promise.resolve())],
      ]);
    } finally {
      await pool.end();
    }
  });

  test('List prices, zero credit, expiry alert', async () => {
    await test.step('Given client "TRIAL" in segment F with a 3-month contract', async () => {
      const clientResult: QueryResult<{ name_en: string | null; segment_code: string | null }> = await pool.query(
        `select a.name_en, s.code as segment_code from sales.accounts a left join catalog.segments s on s.id = a.segment_id where a.id = $1`,
        [clientId],
      );
      expect(clientResult.rows[0]?.name_en).toBe(CLIENT_NAME_EN);
      expect(clientResult.rows[0]?.segment_code).toBe(SEGMENT_F_CODE);

      const endResult: QueryResult<{ end_date: string }> = await pool.query(
        `select (($1::date + make_interval(months => $2))::date)::text as end_date`,
        [SCENARIO_CLOCK_DATE, CONTRACT_TERM_MONTHS],
      );
      contractEndDate = endResult.rows[0]?.end_date ?? '';
      expect(contractEndDate).not.toBe('');

      const createResult = await handleCreateContract(
        requestWithKey(
          {
            entityId,
            accountId: clientId,
            quoteId: null,
            title: CONTRACT_TITLE,
            startDate: SCENARIO_CLOCK_DATE,
            endDate: contractEndDate,
            autoRenew: false,
            noticeDays: ALERT_LEAD_DAYS,
            correlationId: correlationTracker.next(),
          },
          ctxFor(actorId),
        ),
        manageContractDeps,
      );
      expect(createResult.status).toBe(HTTP_STATUS_OK);
      if (!('contractId' in createResult.body)) throw new Error(`handleCreateContract did not return ${HTTP_STATUS_OK}`);
      contractId = createResult.body.contractId;
      contractDocNo = createResult.body.docNo;
      contractVersion = createResult.body.version;

      const priceListResult = await handleSetContractPriceList(
        requestWithKey({ contractId, priceListId, expectedVersion: contractVersion, correlationId: correlationTracker.next() }, ctxFor(actorId)),
        manageContractDeps,
      );
      expect(priceListResult.status).toBe(HTTP_STATUS_OK);
      if (!('version' in priceListResult.body)) throw new Error('handleSetContractPriceList did not return a version');
      contractVersion = priceListResult.body.version;

      const signResult = await handleSignContract(
        requestWithKey(
          { contractId, signedByClient: CONTRACT_SIGNED_BY, expectedVersion: contractVersion, correlationId: correlationTracker.next() },
          ctxFor(actorId),
        ),
        manageContractDeps,
      );
      expect(signResult.status).toBe(HTTP_STATUS_OK);
      if (!('version' in signResult.body)) throw new Error('handleSignContract did not return a version');
      contractVersion = signResult.body.version;

      const activateResult = await handleActivateContract(
        requestWithKey({ contractId, expectedVersion: contractVersion, correlationId: correlationTracker.next() }, ctxFor(actorId)),
        manageContractDeps,
      );
      expect(activateResult.status).toBe(HTTP_STATUS_OK);

      const contractResult: QueryResult<{ status: string; start_date: string; end_date: string; notice_days: number; months: number }> = await pool.query(
        `select status, start_date::text, end_date::text, notice_days,
                (extract(year from age(end_date, start_date)) * 12 + extract(month from age(end_date, start_date)))::int as months
           from sales.contracts where id = $1`,
        [contractId],
      );
      const contractRow = contractResult.rows[0];
      expect(contractRow?.status).toBe(CONTRACT_STATUS_ACTIVE);
      expect(contractRow?.notice_days).toBe(ALERT_LEAD_DAYS);
      expect(contractRow?.start_date).toBe(SCENARIO_CLOCK_DATE);
      expect(contractRow?.end_date).toBe(contractEndDate);
      expect(contractRow?.months).toBe(CONTRACT_TERM_MONTHS);
    });

    await test.step('Then quotes use standard list prices with no discount', async () => {
      const priced = await resolvePrice(
        ctxFor(actorId),
        { accountId: clientId, serviceId, entityId, qty: QUOTE_LINE_QTY_ONE, asOfDate: SCENARIO_CLOCK_DATE },
        resolvePriceDeps,
      );
      expect(priced.status).toBe('priced');
      if (priced.status !== 'priced') throw new Error('resolvePrice did not price OF-01 for the TRIAL client');
      // ACTIVATE requires a contract price list (activate-contract.ts:51), so the contract's annex is the
      // standard list itself and resolvePrice answers via the contract branch: same list id, same price.
      expect(priced.unitPriceSource).toBe(PRICE_SOURCE_CONTRACT_ANNEX);
      if (!('priceListId' in priced)) throw new Error('resolvePrice returned no priceListId');
      expect(priced.priceListId).toBe(priceListId);
      expect(Number(priced.totalPrice)).toBe(Number(STANDARD_LIST_PRICE));

      const segmentResult: QueryResult<{ discount_pct: string }> = await pool.query(
        `select discount_pct::text as discount_pct from catalog.segments where id = $1`,
        [segmentFId],
      );
      expect(Number(segmentResult.rows[0]?.discount_pct)).toBe(Number(ZERO_AMOUNT));

      const createQuoteResult = await handleCreateQuote(
        requestWithKey(
          {
            entityId,
            accountId: clientId,
            opportunityId: null,
            validUntil: daysAfterClock(QUOTE_VALID_DAYS),
            currency: QUOTE_CURRENCY,
            termsAr: null,
            termsEn: null,
            correlationId: correlationTracker.next(),
          },
          ctxFor(actorId),
        ),
        manageQuoteDeps,
      );
      expect(createQuoteResult.status).toBe(HTTP_STATUS_OK);
      if (!('quoteId' in createQuoteResult.body)) throw new Error(`handleCreateQuote did not return ${HTTP_STATUS_OK}`);
      quoteId = createQuoteResult.body.quoteId;

      const upsertResult = await handleUpsertQuoteLine(
        requestWithKey(
          {
            quoteId,
            serviceId,
            qty: QUOTE_QTY,
            unitPrice: priced.totalPrice,
            exceptionId: null,
            discountAmt: ZERO_AMOUNT,
            expectedVersion: createQuoteResult.body.version,
            correlationId: correlationTracker.next(),
          },
          ctxFor(actorId),
        ),
        manageQuoteDeps,
      );
      expect(upsertResult.status).toBe(HTTP_STATUS_OK);

      const quoteResult: QueryResult<{ subtotal: string; discount_amt: string; total: string }> = await pool.query(
        `select subtotal::text, discount_amt::text, total::text from sales.quotes where id = $1`,
        [quoteId],
      );
      const quoteRow = quoteResult.rows[0];
      // discount_amt is only a round-trip of the input (0). The real backing of "no discount" is the
      // resolvePrice list-price answer above plus SEG-F discount_pct = 0.
      expect(Number(quoteRow?.discount_amt)).toBe(Number(ZERO_AMOUNT));
      expect(Number(quoteRow?.subtotal)).toBe(Number(EXPECTED_QUOTE_TOTAL));
      expect(Number(quoteRow?.total)).toBe(Number(EXPECTED_QUOTE_TOTAL));

      const lineResult: QueryResult<{ unit_price: string }> = await pool.query(
        `select unit_price::text from sales.quote_lines where quote_id = $1`,
        [quoteId],
      );
      expect(lineResult.rows).toHaveLength(1);
      expect(Number(lineResult.rows[0]?.unit_price)).toBe(Number(STANDARD_LIST_PRICE));
    });

    await test.step('And credit_limit = 0', async () => {
      // BACKED by the schema default: a new sales.accounts row carries credit_limit DEFAULT 0, the
      // fixture never calls handleSetCreditLimit.
      const creditResult: QueryResult<{ credit_limit: string | null }> = await pool.query(
        `select credit_limit::text as credit_limit from sales.accounts where id = $1`,
        [clientId],
      );
      expect(Number(creditResult.rows[0]?.credit_limit)).toBe(Number(ZERO_AMOUNT));
    });

    await test.step('And an alert fires 14 days before contract end', async () => {
      const alertDayResult: QueryResult<{ alert_date: string }> = await pool.query(
        `select (($1::date - $2::int))::text as alert_date`,
        [contractEndDate, ALERT_LEAD_DAYS],
      );
      const alertDate = alertDayResult.rows[0]?.alert_date ?? '';
      expect(alertDate).not.toBe('');
      const alertResult: QueryResult<{ fired: string }> = await pool.query(
        `select count(*)::text as fired from platform.alert_log where entity_ref = $1 and rule_code = $3 and fired_at::date = $2::date`,
        [contractDocNo, alertDate, N06_RULE_CODE],
      );
      expect.soft(Number(alertResult.rows[0]?.fired), ALERT_NOT_BUILT_MESSAGE).toBeGreaterThan(0);
    });
  });
});
