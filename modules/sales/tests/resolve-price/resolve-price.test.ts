// modules/sales/tests/resolve-price/resolve-price.test.ts — WBS 1.4, pricing engine.
//
// Integration tests, one per scenario in ./resolve-price.feature, against the real database as
// pgeos_app. Sources: docs/package/40-Build-Specification-EN.md §C1/§C2 (quoted in the slice
// brief), docs/notes/slice-briefs/_slice-1.4.brief.md.
//
// SCOPE (brief "Scope taken by the lane"): resolvePrice is a READ-ONLY resolution engine — no
// writes, no API endpoint, no state machine. It never mutates catalog.*/sales.* rows; every
// fixture here is created/removed by this suite itself via the admin pool.
//
// Binding surface this file asserts (RED until pg-backend implements it — brief "Master decisions"
// 1/2/3/5, pg-tester's own naming choice where the brief does not fix an export name):
//   modules/sales/application/resolve-price/resolve-price.ts
//     - `resolvePrice(ctx: { userId: string; clientId: string | null; isInternal: boolean },
//        input: ResolvePriceInput, deps: ResolvePriceDeps): Promise<ResolvePriceResult>` — every
//        read goes through withContext(ctx, fn) as pgeos_app (brief decision 7); ctx is the same
//        shape the golden slice's roleCtx/noRoleCtx/outsiderCtx use.
//     - `ResolvePriceInput = { accountId: string; serviceId: string; entityId: string; qty: string;
//        asOfDate: string }` (matches packages/contracts/sales/resolve-price.ts's
//        ResolvePriceInputSchema exactly — qty a positive numeric(14,3) string, asOfDate an ISO
//        date string).
//     - `ResolvePriceResult` — discriminated union on `status`: `{ status: 'priced'; unitPriceSource:
//        'exception' | 'contract' | 'segment_list' | 'standard_list'; totalPrice: string;
//        priceListId?: string; priceExceptionId?: string; contractId?: string }` or
//        `{ status: 'pending'; reason: string }` — NEVER a zero price, NEVER a thrown error for a
//        legitimate "no match" business case (brief decision 5).
//   modules/sales/application/resolve-price/index.ts — barrel: exports `resolvePrice` (and its
//     input/result types) plus `ResolvePriceDeps` from ./ports.ts. This file imports resolvePrice
//     from the barrel (../../application/resolve-price/index.js) — if pg-backend's index.ts is a
//     bare re-export of resolve-price.ts, that satisfies this import unchanged.
//   modules/sales/api/resolve-price/composition.ts
//     - `createResolvePriceDeps(): ResolvePriceDeps` — wires the real catalog/sales repository
//       adapter; takes no clock/id args (asOfDate is always supplied explicitly by the caller —
//       brief decision 1 — and this engine performs no writes, so no IdGenerator is needed either).
//   modules/sales/domain/resolve-price/errors.ts
//     - `ServiceNotFoundError` (unknown serviceId), `AccountNotFoundError` (unknown accountId) —
//       both typed errors, never a generic Error (brief decision 5). `MalformedTierLadderError` is
//       exercised in ./tiered-pricing.property.test.ts instead (it is raised by the pure tier-walk,
//       not by this integration path, since 1.2 already validates every ladder on write).
//
// Fix round 1 (pg-reviewer FAIL, same brief) additions: resolvePrice calls
// ResolvePriceInputSchema.parse ITSELF at its own entry point (not merely something a caller may
// choose to do) — the qty "0.000" test below calls resolvePrice directly, not the schema in
// isolation. Every list branch filters `is_internal = false` (brief "Scope" — transfer pricing is
// out of scope) and `currency = 'KWD'` (brief decision 6) — both are exercised below. The RLS
// scenario (brief decision 7) asserts an outsider ctx gets AccountNotFoundError, never a leaked
// error. Two tie-break scenarios (brief decision 2b/"Scope" tie-break bullet) cover: a contract row
// with `price_list_id is null` never shadows an older contract that has a real list, and two active
// standard lists resolve to the one with the LATER `valid_from`.
//
// Fixture pattern — the brief's own "fixture precedent" line names ONLY
// modules/wms/tests/receive-inbound/receive-inbound.test.ts lines 1-40 (admin pool, PGUSER,
// bypasses RLS — fixture setup/teardown only, plus a real identity.users/user_entities row). The
// min_price/standard_cost set-then-restore convention below is pg-tester's own reading of
// modules/catalog/tests/maintain-price-list/maintain-price-list.test.ts as a SEPARATE, informational
// precedent (read outside the brief's Read ONLY list — reported to the Master, not itself a brief
// citation). Every resolvePrice call under test genuinely runs through withContext as pgeos_app,
// subject to RLS. platform.audit_log is never touched (this engine writes nothing).
//
// Every price list / price list line / price exception / contract is created by the individual
// `it` that needs it and deleted in `afterEach` — scenarios intentionally reuse the SAME two
// accounts (ACC-1/ACC-2) and the SAME five seeded services across many tests, so per-test cleanup
// (not a single shared beforeAll fixture) is what keeps the scenarios independent of run order.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, Money } from '@pg-eos/domain-kit';

// The module under test — does not exist yet (RED).
import { resolvePrice } from '../../application/resolve-price/index.js';
import { createResolvePriceDeps } from '../../api/resolve-price/composition.js';
import { AccountNotFoundError, ServiceNotFoundError } from '../../domain/resolve-price/errors.js';
// the package subpath export (@pg-eos/contracts/sales/resolve-price), not a deep relative path —
// packages/contracts/package.json's own `exports` map already carries this entry (scaffolded by
// scripts/new-slice.sh, self-registering per the slice brief's use-case line).
import { ResolvePriceInputSchema, ResolvePriceResultSchema } from '@pg-eos/contracts/sales/resolve-price';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

// --- literals, each cited to the schema fact, decision or brief line they come from -------------

// FixedClock, never `new Date()` inline in an assertion path — pg-tester's own design choice (the
// brief asks for a FixedClock so the expired-exception/inactive-contract scenarios are
// deterministic, but does not itself supply this exact wording) so TODAY/YESTERDAY are fixed
// values, not the real wall clock. Only used here, in the TEST, to derive TODAY/YESTERDAY;
// resolvePrice itself never reads a clock (asOfDate is always an explicit input field per brief
// decision 1).
const clock = new FixedClock(new Date('2026-09-25T00:00:00.000Z'));
const TODAY = clock.now().toISOString().slice(0, 10);
const isoDateOffset = (isoDate: string, days: number): string => {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const YESTERDAY = isoDateOffset(TODAY, -1);
const LONG_AGO = '2020-01-01'; // any valid_from safely before TODAY.
const FAR_FUTURE = '2030-01-01'; // any valid_to/review_at safely after TODAY.

// Manual-calc fixtures — the exact three numbers the brief fixes verbatim (Master decisions /
// worked examples). pg-backend must reproduce these EXACTLY, not approximately.
const QTY_STANDARD_CASE = '120.000';
const TOTAL_STANDARD_LIST_CASE = '195.000'; // (50-5)*2.000 + (120-50)*1.500 = 90.000 + 105.000.
const QTY_SEGMENT_CASE = '80.000';
const TOTAL_SEGMENT_LIST_CASE = '300.000'; // 10*5.000 + 40*4.000 + 30*3.000 = 50+160+90.
const QTY_CONTRACT_CASE = '25.000';
const TOTAL_CONTRACT_CASE = '30.000'; // 25 * 1.200.
const QTY_EXCEPTION_CASE = '4.000';
const TOTAL_EXCEPTION_CASE = '38.000'; // 4 * 9.500.

const SERVICE_CODE_HD04 = 'HD-04';
const SERVICE_CODE_ST01 = 'ST-01';
const SERVICE_CODE_OF01 = 'OF-01';
const SERVICE_CODE_DL11 = 'DL-11';
const SERVICE_CODE_IT01 = 'IT-01';
const SEGMENT_CODE_SEG_A = 'SEG-A';

const FIXTURE_MIN_PRICE = '5.000';
const FIXTURE_STANDARD_COST = '4.000';

const GM_ACTOR_UUID = '00000000-0000-4000-8000-0000000140a1'; // catalog.price_exceptions.approved_by has no FK — any uuid is valid.
const ROLE_ACTOR_UUID = '00000000-0000-4000-8000-0000000140a2';
// RLS scenario (fix round 1, finding 7/8) — an actor with NO identity.user_entities row for
// entityId (PST): the same "outsider" convention the golden slice uses for its own RLS scenario.
const OUTSIDER_ACTOR_UUID = '00000000-0000-4000-8000-0000000140a3';

const roleCtx = { userId: ROLE_ACTOR_UUID, clientId: null, isInternal: true };
const outsiderCtx = { userId: OUTSIDER_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
let accountIdAcc1: string;
let accountIdAcc2: string;
let hd04Id: string;
let st01Id: string;
let of01Id: string;
let dl11Id: string;
let it01Id: string;
let segmentIdSegA: string;

const fixtureAccountCodeAcc1 = `_resolveprice_acc1_${randomUUID()}`;
const fixtureAccountCodeAcc2 = `_resolveprice_acc2_${randomUUID()}`;

const deps = createResolvePriceDeps();

// Rows created by the CURRENTLY RUNNING test — cleaned up in afterEach so scenarios never leak
// into one another even though they share the same two accounts/five services.
const contractIdsThisTest: string[] = [];
const priceListIdsThisTest: string[] = []; // catalog.price_list_lines cascade-deletes with the list.
const exceptionIdsThisTest: string[] = [];

// --- fixture helpers --------------------------------------------------------------------------

async function getServiceId(code: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(`select id from catalog.services where code = $1`, [code]);
  const row = result.rows[0];
  if (!row) throw new Error(`expected a seeded catalog.services row for code ${code}`);
  return row.id;
}

async function getSegmentId(code: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(`select id from catalog.segments where code = $1`, [code]);
  const row = result.rows[0];
  if (!row) throw new Error(`expected a seeded catalog.segments row for code ${code}`);
  return row.id;
}

async function createPriceList(params: {
  readonly segmentId: string | null;
  readonly clientId: string | null;
  readonly status: string;
  readonly validFrom: string;
  readonly validTo?: string | null;
  /** Fix round 1 (pg-reviewer finding 1/7) — defaults to false (client-facing); a caller sets true
   *  to build the "internal list must never resolve a client price" fixture. */
  readonly isInternal?: boolean;
}): Promise<string> {
  const code = `_resolveprice_list_${randomUUID()}`;
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into catalog.price_lists (entity_id, code, name_ar, segment_id, client_id, valid_from, valid_to, is_internal, status)
     values ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9) returning id`,
    [
      entityId,
      code,
      'قائمة اختبار تسعير — WBS 1.4',
      params.segmentId,
      params.clientId,
      params.validFrom,
      params.validTo ?? null,
      params.isInternal ?? false,
      params.status,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture catalog.price_lists insert returned no row');
  priceListIdsThisTest.push(row.id);
  return row.id;
}

async function createPriceListLine(
  priceListId: string,
  serviceId: string,
  price: string,
  tierFrom: string | null,
  tierTo: string | null,
  freeUnits = '0.000',
  // Fix round 1 (pg-reviewer finding 7) — defaults to 'KWD'; a caller sets a non-KWD currency to
  // build the "a non-KWD-only line counts as no line" fixture (brief decision 6).
  currency = 'KWD',
): Promise<void> {
  await pool.query(
    `insert into catalog.price_list_lines (price_list_id, service_id, price, currency, tier_from, tier_to, free_units)
     values ($1, $2, $3::numeric, $4, $5::numeric, $6::numeric, $7::numeric)`,
    [priceListId, serviceId, price, currency, tierFrom, tierTo, freeUnits],
  );
}

async function createPriceException(params: {
  readonly clientId: string;
  readonly serviceId: string;
  readonly approvedPrice: string;
  readonly validFrom: string;
  readonly validTo: string;
}): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into catalog.price_exceptions
       (entity_id, client_id, service_id, approved_price, min_price_at_approval, reason, valid_from, valid_to, approved_by, review_at)
     values ($1, $2, $3, $4::numeric, $4::numeric, $5, $6::date, $7::date, $8, $7::date)
     returning id`,
    [entityId, params.clientId, params.serviceId, params.approvedPrice, 'fixture — WBS 1.4 resolve-price', params.validFrom, params.validTo, GM_ACTOR_UUID],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture catalog.price_exceptions insert returned no row');
  exceptionIdsThisTest.push(row.id);
  return row.id;
}

async function createContract(params: {
  readonly accountId: string;
  readonly status: string;
  readonly startDate: string;
  readonly endDate?: string | null;
  readonly priceListId: string | null;
}): Promise<string> {
  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(`select platform.next_doc_no($1, 'CTR') as doc_no`, [entityId]);
  const docNo = docNoResult.rows[0]?.doc_no;
  if (!docNo) throw new Error('platform.next_doc_no returned no row for CTR');
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.contracts (entity_id, doc_no, account_id, title, status, start_date, end_date, price_list_id)
     values ($1, $2, $3, $4, $5, $6::date, $7::date, $8)
     returning id`,
    [entityId, docNo, params.accountId, 'عقد اختبار تسعير — WBS 1.4', params.status, params.startDate, params.endDate ?? null, params.priceListId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture sales.contracts insert returned no row');
  contractIdsThisTest.push(row.id);
  return row.id;
}

// service_id -> its original min_price/standard_cost, restored verbatim in afterAll (informational
// precedent read outside the brief's Read ONLY list:
// modules/catalog/tests/maintain-price-list/maintain-price-list.test.ts's ST-01/HD-04 set/restore).
const originalServicePricing = new Map<string, { readonly minPrice: string | null; readonly standardCost: string | null }>();

async function ensureServicePricingIsSet(serviceId: string): Promise<void> {
  const result: QueryResult<{ min_price: string | null; standard_cost: string | null }> = await pool.query(
    `select min_price::text as min_price, standard_cost::text as standard_cost from catalog.services where id = $1`,
    [serviceId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`expected a catalog.services row for id ${serviceId}`);
  originalServicePricing.set(serviceId, { minPrice: row.min_price, standardCost: row.standard_cost });
  await pool.query(
    `update catalog.services set min_price = coalesce(min_price, $2::numeric), standard_cost = coalesce(standard_cost, $3::numeric) where id = $1`,
    [serviceId, FIXTURE_MIN_PRICE, FIXTURE_STANDARD_COST],
  );
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, ['PST']);
  entityId = (entityResult.rows[0] as { id: string }).id;

  segmentIdSegA = await getSegmentId(SEGMENT_CODE_SEG_A);
  hd04Id = await getServiceId(SERVICE_CODE_HD04);
  st01Id = await getServiceId(SERVICE_CODE_ST01);
  of01Id = await getServiceId(SERVICE_CODE_OF01);
  dl11Id = await getServiceId(SERVICE_CODE_DL11);
  it01Id = await getServiceId(SERVICE_CODE_IT01);

  for (const serviceId of [hd04Id, st01Id, of01Id, dl11Id, it01Id]) {
    await ensureServicePricingIsSet(serviceId);
  }

  await pool.query(`delete from identity.user_entities where user_id = $1`, [ROLE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [ROLE_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [ROLE_ACTOR_UUID, `_resolveprice_fixture_${ROLE_ACTOR_UUID}_${randomUUID()}@test.invalid`, 'ممثل اختبار تسعير — WBS 1.4'],
  );
  await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [ROLE_ACTOR_UUID, entityId]);

  // OUTSIDER_ACTOR_UUID: a real identity.users row, deliberately granted NO identity.user_entities
  // row for `entityId` (PST) — the RLS scenario (fix round 1, finding 7/8).
  await pool.query(`delete from identity.user_entities where user_id = $1`, [OUTSIDER_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [OUTSIDER_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [OUTSIDER_ACTOR_UUID, `_resolveprice_outsider_${OUTSIDER_ACTOR_UUID}_${randomUUID()}@test.invalid`, 'ممثل خارج الكيان — WBS 1.4'],
  );

  const accountResult1: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type, segment_id) values ($1, $2, 'client', $3) returning id`,
    [fixtureAccountCodeAcc1, 'عميل اختبار تسعير ACC-1', segmentIdSegA],
  );
  accountIdAcc1 = (accountResult1.rows[0] as { id: string }).id;

  const accountResult2: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type, segment_id) values ($1, $2, 'client', null) returning id`,
    [fixtureAccountCodeAcc2, 'عميل اختبار تسعير ACC-2'],
  );
  accountIdAcc2 = (accountResult2.rows[0] as { id: string }).id;
});

afterEach(async () => {
  if (contractIdsThisTest.length > 0) {
    await pool.query(`delete from sales.contracts where id = any($1::uuid[])`, [contractIdsThisTest]);
    contractIdsThisTest.length = 0;
  }
  if (priceListIdsThisTest.length > 0) {
    await pool.query(`delete from catalog.price_lists where id = any($1::uuid[])`, [priceListIdsThisTest]); // cascades lines.
    priceListIdsThisTest.length = 0;
  }
  if (exceptionIdsThisTest.length > 0) {
    await pool.query(`delete from catalog.price_exceptions where id = any($1::uuid[])`, [exceptionIdsThisTest]);
    exceptionIdsThisTest.length = 0;
  }
});

afterAll(async () => {
  for (const [serviceId, original] of originalServicePricing) {
    await pool.query(`update catalog.services set min_price = $2::numeric, standard_cost = $3::numeric where id = $1`, [
      serviceId,
      original.minPrice,
      original.standardCost,
    ]);
  }
  if (accountIdAcc1) await pool.query(`delete from sales.accounts where id = $1`, [accountIdAcc1]);
  if (accountIdAcc2) await pool.query(`delete from sales.accounts where id = $1`, [accountIdAcc2]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [ROLE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [ROLE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [OUTSIDER_ACTOR_UUID]);
  await pool.end();
});

// --- contract stub (package subpath import) -----------------------------------------------------

describe('@pg-eos/contracts/sales/resolve-price — schemas match Master decision 1 exactly', () => {
  it('ResolvePriceInputSchema accepts { accountId, serviceId, entityId, qty, asOfDate }', () => {
    const parsed = ResolvePriceInputSchema.parse({
      accountId: randomUUID(),
      serviceId: randomUUID(),
      entityId: randomUUID(),
      qty: '1.000',
      asOfDate: TODAY,
    });
    expect(parsed.qty).toBe('1.000');
    expect(parsed.asOfDate).toBe(TODAY);
  });

  it('ResolvePriceInputSchema rejects a non-positive qty', () => {
    expect(() =>
      ResolvePriceInputSchema.parse({ accountId: randomUUID(), serviceId: randomUUID(), entityId: randomUUID(), qty: '0.000', asOfDate: TODAY }),
    ).toThrow();
    expect(() =>
      ResolvePriceInputSchema.parse({ accountId: randomUUID(), serviceId: randomUUID(), entityId: randomUUID(), qty: '0', asOfDate: TODAY }),
    ).toThrow();
  });

  it('ResolvePriceResultSchema discriminates on status — a priced result and a pending result both parse', () => {
    const priced = ResolvePriceResultSchema.parse({
      status: 'priced',
      unitPriceSource: 'standard_list',
      totalPrice: '195.000',
    });
    expect(priced.status).toBe('priced');
    const pending = ResolvePriceResultSchema.parse({ status: 'pending', reason: 'no-exception-no-list' });
    expect(pending.status).toBe('pending');
  });
});

// --- Scenario: standard list, two-tier ladder with free_units (manual calc case 1) --------------

describe('Scenario: standard list, two-tier ladder with free_units (manual calc case 1)', () => {
  it('resolves ACC-2 / HD-04 / qty 120 to 195.000 via standard_list', async () => {
    const standardListId = await createPriceList({ segmentId: null, clientId: null, status: 'active', validFrom: LONG_AGO });
    await createPriceListLine(standardListId, hd04Id, '2.000', '0.000', '50.000', '5.000');
    await createPriceListLine(standardListId, hd04Id, '1.500', '50.000', null);

    const result = await resolvePrice(
      roleCtx,
      { accountId: accountIdAcc2, serviceId: hd04Id, entityId, qty: QTY_STANDARD_CASE, asOfDate: TODAY },
      deps,
    );

    expect(result.status).toBe('priced');
    if (result.status !== 'priced') throw new Error('unreachable');
    expect(result.unitPriceSource).toBe('standard_list');
    expect(result.totalPrice).toBe(TOTAL_STANDARD_LIST_CASE);
    expect(result.priceListId).toBe(standardListId);
  });
});

// --- Scenario: segment list, three-tier ladder, no free_units (manual calc case 2) ---------------

describe('Scenario: segment list, three-tier ladder, no free_units (manual calc case 2)', () => {
  it('resolves ACC-1 / ST-01 / qty 80 to 300.000 via segment_list', async () => {
    const segmentListId = await createPriceList({ segmentId: segmentIdSegA, clientId: null, status: 'active', validFrom: LONG_AGO });
    await createPriceListLine(segmentListId, st01Id, '5.000', '0.000', '10.000');
    await createPriceListLine(segmentListId, st01Id, '4.000', '10.000', '50.000');
    await createPriceListLine(segmentListId, st01Id, '3.000', '50.000', null);

    const result = await resolvePrice(
      roleCtx,
      { accountId: accountIdAcc1, serviceId: st01Id, entityId, qty: QTY_SEGMENT_CASE, asOfDate: TODAY },
      deps,
    );

    expect(result.status).toBe('priced');
    if (result.status !== 'priced') throw new Error('unreachable');
    expect(result.unitPriceSource).toBe('segment_list');
    expect(result.totalPrice).toBe(TOTAL_SEGMENT_LIST_CASE);
    expect(result.priceListId).toBe(segmentListId);
  });
});

// --- Scenario: contract annex, flat line (manual calc case 3) -----------------------------------

describe('Scenario: contract annex, flat line (manual calc case 3) — the contract wins over a cheaper segment line', () => {
  it('resolves ACC-1 / OF-01 / qty 25 to 30.000 via the contract, not the segment list', async () => {
    const contractListId = await createPriceList({ segmentId: null, clientId: null, status: 'active', validFrom: LONG_AGO });
    await createPriceListLine(contractListId, of01Id, '1.200', null, null);

    // ACC-1's OWN segment list ALSO has an OF-01 line, at a different (cheaper) price — proves the
    // contract branch is tried and wins BEFORE the segment branch, per the waterfall order.
    const segmentListId = await createPriceList({ segmentId: segmentIdSegA, clientId: null, status: 'active', validFrom: LONG_AGO });
    await createPriceListLine(segmentListId, of01Id, '0.500', null, null);

    const contractId = await createContract({ accountId: accountIdAcc1, status: 'active', startDate: LONG_AGO, priceListId: contractListId });

    const result = await resolvePrice(
      roleCtx,
      { accountId: accountIdAcc1, serviceId: of01Id, entityId, qty: QTY_CONTRACT_CASE, asOfDate: TODAY },
      deps,
    );

    expect(result.status).toBe('priced');
    if (result.status !== 'priced') throw new Error('unreachable');
    expect(result.unitPriceSource).toBe('contract');
    expect(result.totalPrice).toBe(TOTAL_CONTRACT_CASE);
    expect(result.contractId).toBe(contractId);
  });
});

// --- Scenario: exception overrides everything -----------------------------------------------------

describe('Scenario: exception overrides everything, including a cheaper contract/segment/standard line', () => {
  it('resolves ACC-1 / DL-11 / qty 4 to 38.000 via the exception, even with a cheaper standard-list line present', async () => {
    const exceptionId = await createPriceException({
      clientId: accountIdAcc1,
      serviceId: dl11Id,
      approvedPrice: '9.500',
      validFrom: LONG_AGO,
      validTo: FAR_FUTURE,
    });

    // A cheaper standard-list line for the SAME service — the exception must still win.
    const standardListId = await createPriceList({ segmentId: null, clientId: null, status: 'active', validFrom: LONG_AGO });
    await createPriceListLine(standardListId, dl11Id, '3.000', null, null);

    const result = await resolvePrice(
      roleCtx,
      { accountId: accountIdAcc1, serviceId: dl11Id, entityId, qty: QTY_EXCEPTION_CASE, asOfDate: TODAY },
      deps,
    );

    expect(result.status).toBe('priced');
    if (result.status !== 'priced') throw new Error('unreachable');
    expect(result.unitPriceSource).toBe('exception');
    expect(result.totalPrice).toBe(TOTAL_EXCEPTION_CASE);
    expect(result.priceExceptionId).toBe(exceptionId);
  });
});

// --- Scenario: an expired exception is ignored, falling through -----------------------------------

describe('Scenario: an expired exception is ignored, falling through to the next branch', () => {
  it('an exception whose valid_to is yesterday is skipped — resolves via standard_list instead', async () => {
    await createPriceException({
      clientId: accountIdAcc1,
      serviceId: dl11Id,
      approvedPrice: '9.500',
      validFrom: LONG_AGO,
      validTo: YESTERDAY, // expired as of TODAY.
    });

    const standardListId = await createPriceList({ segmentId: null, clientId: null, status: 'active', validFrom: LONG_AGO });
    await createPriceListLine(standardListId, dl11Id, '8.000', null, null);

    const result = await resolvePrice(
      roleCtx,
      { accountId: accountIdAcc1, serviceId: dl11Id, entityId, qty: QTY_EXCEPTION_CASE, asOfDate: TODAY },
      deps,
    );

    expect(result.status).toBe('priced');
    if (result.status !== 'priced') throw new Error('unreachable');
    expect(result.unitPriceSource).not.toBe('exception');
    expect(result.unitPriceSource).toBe('standard_list');
    expect(result.totalPrice).toBe(Money.of('8.000').multiply(QTY_EXCEPTION_CASE).toString());
  });
});

// --- Scenario: a contract's list has no line for the service — falls through, not pending --------

describe('Scenario: a contract exists but its list has no line for the service — falls through, not pending', () => {
  it('ACC-1 / ST-01 / qty 80 falls through the contract branch to segment_list (300.000)', async () => {
    const contractListId = await createPriceList({ segmentId: null, clientId: null, status: 'active', validFrom: LONG_AGO });
    await createPriceListLine(contractListId, of01Id, '1.200', null, null); // no ST-01 line on this list.
    await createContract({ accountId: accountIdAcc1, status: 'active', startDate: LONG_AGO, priceListId: contractListId });

    const segmentListId = await createPriceList({ segmentId: segmentIdSegA, clientId: null, status: 'active', validFrom: LONG_AGO });
    await createPriceListLine(segmentListId, st01Id, '5.000', '0.000', '10.000');
    await createPriceListLine(segmentListId, st01Id, '4.000', '10.000', '50.000');
    await createPriceListLine(segmentListId, st01Id, '3.000', '50.000', null);

    const result = await resolvePrice(
      roleCtx,
      { accountId: accountIdAcc1, serviceId: st01Id, entityId, qty: QTY_SEGMENT_CASE, asOfDate: TODAY },
      deps,
    );

    expect(result.status).toBe('priced');
    if (result.status !== 'priced') throw new Error('unreachable');
    expect(result.unitPriceSource).toBe('segment_list');
    expect(result.totalPrice).toBe(TOTAL_SEGMENT_LIST_CASE);
  });
});

// --- Scenario: no account segment, no matching list anywhere — pending, never zero ----------------

describe('Scenario: no account segment, no matching list anywhere — pending, never zero', () => {
  it('ACC-2 / IT-01 / qty 1 resolves to pending — the standard list exists but has no IT-01 line', async () => {
    const standardListId = await createPriceList({ segmentId: null, clientId: null, status: 'active', validFrom: LONG_AGO });
    await createPriceListLine(standardListId, of01Id, '1.000', null, null); // an UNRELATED service — no IT-01 line.

    const result = await resolvePrice(roleCtx, { accountId: accountIdAcc2, serviceId: it01Id, entityId, qty: '1.000', asOfDate: TODAY }, deps);

    expect(result.status).toBe('pending');
    if (result.status !== 'pending') throw new Error('unreachable');
    expect(result.reason).toBe('resolved-list-has-no-line-for-service');
    expect('totalPrice' in result).toBe(false);
  });
});

// --- Scenario: an inactive (draft) contract's list is ignored --------------------------------------

describe("Scenario: an inactive (draft) contract's list is ignored", () => {
  it('a DRAFT contract is never tried — ACC-1 / OF-01 / qty 25 falls through to segment_list', async () => {
    const draftContractListId = await createPriceList({ segmentId: null, clientId: null, status: 'active', validFrom: LONG_AGO });
    await createPriceListLine(draftContractListId, of01Id, '99.000', null, null);
    await createContract({ accountId: accountIdAcc1, status: 'draft', startDate: LONG_AGO, priceListId: draftContractListId });

    const segmentListId = await createPriceList({ segmentId: segmentIdSegA, clientId: null, status: 'active', validFrom: LONG_AGO });
    await createPriceListLine(segmentListId, of01Id, '5.000', null, null);

    const result = await resolvePrice(
      roleCtx,
      { accountId: accountIdAcc1, serviceId: of01Id, entityId, qty: QTY_CONTRACT_CASE, asOfDate: TODAY },
      deps,
    );

    expect(result.status).toBe('priced');
    if (result.status !== 'priced') throw new Error('unreachable');
    expect(result.unitPriceSource).not.toBe('contract');
    expect(result.unitPriceSource).toBe('segment_list');
    expect(result.totalPrice).toBe(Money.of('5.000').multiply(QTY_CONTRACT_CASE).toString());
  });
});

// --- Fix round 1 (pg-reviewer finding 1) — an internal contract price list is never tried --------

describe('Scenario: an active contract whose price_list_id points at an INTERNAL (is_internal=true) price list is ignored', () => {
  it('the contract branch never resolves via an internal list — falls through to segment_list', async () => {
    const internalContractListId = await createPriceList({
      segmentId: null,
      clientId: null,
      status: 'active',
      validFrom: LONG_AGO,
      isInternal: true,
    });
    await createPriceListLine(internalContractListId, of01Id, '0.100', null, null); // deliberately far cheaper — must NOT win.
    await createContract({ accountId: accountIdAcc1, status: 'active', startDate: LONG_AGO, priceListId: internalContractListId });

    const segmentListId = await createPriceList({ segmentId: segmentIdSegA, clientId: null, status: 'active', validFrom: LONG_AGO });
    await createPriceListLine(segmentListId, of01Id, '5.000', null, null);

    const result = await resolvePrice(
      roleCtx,
      { accountId: accountIdAcc1, serviceId: of01Id, entityId, qty: QTY_CONTRACT_CASE, asOfDate: TODAY },
      deps,
    );

    expect(result.status).toBe('priced');
    if (result.status !== 'priced') throw new Error('unreachable');
    expect(result.unitPriceSource).not.toBe('contract');
    expect(result.unitPriceSource).toBe('segment_list');
    expect(result.totalPrice).toBe(Money.of('5.000').multiply(QTY_CONTRACT_CASE).toString());
    expect(result.priceListId).toBe(segmentListId);
  });
});

// --- Fix round 1 (pg-reviewer finding 7) — an internal list is skipped even in the standard branch

describe('Scenario: an internal (is_internal=true) list is skipped even when it would otherwise match the standard-list branch', () => {
  it('an internal standard list for IT-01 is ignored — resolves to pending, not to the internal price', async () => {
    const internalStandardListId = await createPriceList({
      segmentId: null,
      clientId: null,
      status: 'active',
      validFrom: LONG_AGO,
      isInternal: true,
    });
    await createPriceListLine(internalStandardListId, it01Id, '2.000', null, null);

    const result = await resolvePrice(roleCtx, { accountId: accountIdAcc2, serviceId: it01Id, entityId, qty: '1.000', asOfDate: TODAY }, deps);

    expect(result.status).toBe('pending');
    if (result.status !== 'pending') throw new Error('unreachable');
    // The price list itself DOES match the standard-list scope (entity/segment/client), so it
    // counts as "resolved" — its is_internal=true line is then filtered out at the line-selection
    // step, the same "resolved list, no line survives" reason the USD-only-currency scenario below
    // exercises (decision 2e: only a total absence of any matching active list is
    // 'no-exception-no-list').
    expect(result.reason).toBe('resolved-list-has-no-line-for-service');
  });
});

// --- Fix round 1 (pg-reviewer finding 7) — a non-KWD-only line counts as no line (brief decision 6)

describe('Scenario: a list whose only line for the service is a non-KWD currency is treated as no-line', () => {
  it('a USD standard-list line for IT-01 does not count — resolves to pending', async () => {
    const standardListId = await createPriceList({ segmentId: null, clientId: null, status: 'active', validFrom: LONG_AGO });
    await createPriceListLine(standardListId, it01Id, '2.000', null, null, '0.000', 'USD');

    const result = await resolvePrice(roleCtx, { accountId: accountIdAcc2, serviceId: it01Id, entityId, qty: '1.000', asOfDate: TODAY }, deps);

    expect(result.status).toBe('pending');
    if (result.status !== 'pending') throw new Error('unreachable');
    expect(result.reason).toBe('resolved-list-has-no-line-for-service');
  });
});

// --- Fix round 1 (pg-reviewer finding 8) — RLS: an outsider ctx gets a not-found result -----------

describe("Scenario: RLS — a caller whose context does not cover entityId gets a not-found result, never a leaked error", () => {
  it('an outsider ctx (no identity.user_entities row for entityId) is rejected with AccountNotFoundError, not a raw/leaked RLS error', async () => {
    const standardListId = await createPriceList({ segmentId: null, clientId: null, status: 'active', validFrom: LONG_AGO });
    await createPriceListLine(standardListId, hd04Id, '2.000', null, null);

    await expect(
      resolvePrice(outsiderCtx, { accountId: accountIdAcc1, serviceId: hd04Id, entityId, qty: '1.000', asOfDate: TODAY }, deps),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
  });
});

// --- Fix round 1 (pg-reviewer finding 2) — tie-break: a null-price_list_id contract never shadows -

describe('Scenario: tie-break — a newer active contract with NO price_list_id does not shadow an older one that has a real list', () => {
  it("the resolver finds the OLDER contract's list — the newer null-list contract is not even a candidate (brief decision 2b: price_list_id is not null)", async () => {
    const olderListId = await createPriceList({ segmentId: null, clientId: null, status: 'active', validFrom: LONG_AGO });
    await createPriceListLine(olderListId, of01Id, '1.200', null, null);
    const olderContractId = await createContract({ accountId: accountIdAcc1, status: 'active', startDate: LONG_AGO, priceListId: olderListId });
    // A NEWER active contract (later start_date) with price_list_id = null — must never be picked,
    // regardless of any "latest start_date" tie-break, because it fails decision 2b's own
    // precondition (price_list_id is not null) before tie-break is ever considered.
    await createContract({
      accountId: accountIdAcc1,
      status: 'active',
      startDate: isoDateOffset(LONG_AGO, 30),
      priceListId: null,
    });

    const result = await resolvePrice(
      roleCtx,
      { accountId: accountIdAcc1, serviceId: of01Id, entityId, qty: QTY_CONTRACT_CASE, asOfDate: TODAY },
      deps,
    );

    expect(result.status).toBe('priced');
    if (result.status !== 'priced') throw new Error('unreachable');
    expect(result.unitPriceSource).toBe('contract');
    expect(result.contractId).toBe(olderContractId);
    expect(result.totalPrice).toBe(TOTAL_CONTRACT_CASE);
  });
});

// --- Fix round 1 (pg-reviewer finding 2) — tie-break: later valid_from wins among two active lists

describe('Scenario: tie-break — when two active standard lists both match, the one with the LATER valid_from wins', () => {
  it("two of THIS TEST's own active standard lists for HD-04 (fixture-only dates, cleaned up in afterEach — cannot collide with any pre-existing PST data, since no seed migration inserts catalog.price_lists rows): the later valid_from wins", async () => {
    const earlierValidFrom = '2021-06-01';
    const laterValidFrom = '2022-06-01';
    const earlierListId = await createPriceList({ segmentId: null, clientId: null, status: 'active', validFrom: earlierValidFrom });
    await createPriceListLine(earlierListId, hd04Id, '1.000', null, null);
    const laterListId = await createPriceList({ segmentId: null, clientId: null, status: 'active', validFrom: laterValidFrom });
    await createPriceListLine(laterListId, hd04Id, '9.000', null, null);

    const result = await resolvePrice(roleCtx, { accountId: accountIdAcc2, serviceId: hd04Id, entityId, qty: '1.000', asOfDate: TODAY }, deps);

    expect(result.status).toBe('priced');
    if (result.status !== 'priced') throw new Error('unreachable');
    expect(result.unitPriceSource).toBe('standard_list');
    expect(result.priceListId).toBe(laterListId);
    expect(result.totalPrice).toBe('9.000');
  });
});

// --- Scenario: unknown service / unknown account are rejected -------------------------------------

describe('Scenario: unknown service is rejected', () => {
  it('rejects with ServiceNotFoundError', async () => {
    await expect(
      resolvePrice(roleCtx, { accountId: accountIdAcc1, serviceId: randomUUID(), entityId, qty: '1.000', asOfDate: TODAY }, deps),
    ).rejects.toBeInstanceOf(ServiceNotFoundError);
  });
});

describe('Scenario: unknown account is rejected', () => {
  it('rejects with AccountNotFoundError', async () => {
    await expect(
      resolvePrice(roleCtx, { accountId: randomUUID(), serviceId: hd04Id, entityId, qty: '1.000', asOfDate: TODAY }, deps),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
  });
});

// --- Scenario: zero quantity is rejected at the contract boundary ---------------------------------

describe('Scenario: zero quantity is rejected at the contract boundary (same convention as 1.2)', () => {
  it('ResolvePriceInputSchema rejects qty "0"/"0.000" before resolvePrice is ever called', () => {
    expect(() =>
      ResolvePriceInputSchema.parse({ accountId: accountIdAcc1, serviceId: hd04Id, entityId, qty: '0', asOfDate: TODAY }),
    ).toThrow();
    expect(() =>
      ResolvePriceInputSchema.parse({ accountId: accountIdAcc1, serviceId: hd04Id, entityId, qty: '0.000', asOfDate: TODAY }),
    ).toThrow();
  });

  // Fix round 1 (pg-reviewer finding 4) — the real entry point calls ResolvePriceInputSchema.parse
  // itself; this proves resolvePrice validates its OWN input, not merely that the schema can be
  // used in isolation by a well-behaved caller.
  it('the real resolvePrice entry point itself rejects qty "0.000" — it validates input, not just the schema in isolation', async () => {
    await expect(
      resolvePrice(roleCtx, { accountId: accountIdAcc1, serviceId: hd04Id, entityId, qty: '0.000', asOfDate: TODAY }, deps),
    ).rejects.toThrow();
  });
});
