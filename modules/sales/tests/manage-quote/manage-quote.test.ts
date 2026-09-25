// modules/sales/tests/manage-quote/manage-quote.test.ts — WBS 1.6, M02 sales.
//
// Integration tests, one `it` per scenario in ./manage-quote.feature (18 scenarios — the brief's
// prose says "17" but the pasted Gherkin itself names 18; every one of the 18 is executed here),
// against the real database as pgeos_app. Sources: docs/package/40-Build-Specification-EN.md §C2,
// docs/package/D-blueprints/02-Financial-Accounting.md 160-165/200-204,
// docs/notes/slice-briefs/_slice-1.6.brief.md.
//
// CHOSEN RESULT SHAPES (pg-backend implements exactly these — brief instruction; fields NOT pinned
// literally by the brief are this file's own default, reported as an open question below):
//   createQuote(ctx, input, deps)         -> Promise<{ quoteId: string; docNo: string; version: number }>
//   upsertQuoteLine(ctx, input, deps)     -> Promise<{ version: number; lineId: string; subtotal: string;
//                                             total: string; estimatedMarginPct: number | null;
//                                             marginWarning: boolean }>
//   submitForReview(ctx, input, deps)     -> Promise<{ version: number }>            [DEFAULT]
//   approveCommercial(ctx, input, deps)   -> Promise<{ version: number }>            [DEFAULT]
//   approveFinance(ctx, input, deps)      -> Promise<{ version: number }>            [DEFAULT]
//   returnToDraft(ctx, input, deps)       -> Promise<{ version: number }>            [DEFAULT]
//   sendQuote(ctx, input, deps)           -> Promise<{ version: number }>            [DEFAULT]
//   recordDecision(ctx, input, deps)      -> Promise<{ version: number }>            [DEFAULT]
//   reviseQuote(ctx, input, deps)         -> Promise<{ newQuoteId: string; newDocNo: string }>  (brief
//                                             decision 12, literal)
// Every command input carries `correlationId`; every quote-mutating command except CreateQuote/
// ReviseQuote carries `expectedVersion` (Contract section). `idem?: IdempotencyInput` is an
// optional extra field on every write command's input (golden pattern).
//
// ERROR CLASSES this suite imports and asserts `instanceof` on — the brief's literal list
// (AccountNotQualifiedError, QuoteFrozenError, StaleVersionError, EmptyQuoteError,
// RoleRequiredError, InvalidPriceExceptionError, InvalidDiscountError, ServiceNotFoundError,
// IllegalTransitionError, MissingActorError) PLUS two the brief's Master decision 2 prose requires
// but does not repeat in that final list — this file's own DEFAULT names, reported as open
// questions:
//   - `AccountNotFoundError` — decision 2: "a cross-entity account is invisible, surfaces as
//     AccountNotFoundError, never leaked" (verbatim from the brief, just not repeated in the
//     closing enumeration).
//   - `QuoteNotFoundError` — no quote row is visible for the given id (missing, or RLS entity_scope
//     hides it) — mirrors catalog's `PriceListNotFoundError` (modules/catalog/domain/
//     maintain-price-list/errors.ts), the nearer precedent the brief pre-authorises reusing.
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only) plus real
// identity.users/user_entities/user_roles rows, same as
// modules/catalog/tests/maintain-price-list/maintain-price-list.test.ts. PG_APP_USER=pgeos_app is
// REQUIRED to run this suite. `catalog.price_exceptions` rows this suite needs are inserted
// directly via the admin pool (brief instruction) — cleaned up in afterAll. ST-01's
// min_price/standard_cost are set here via the admin pool and restored to NULL in afterAll (1.2's
// precedent). platform.audit_log rows are NEVER deleted.

import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IdempotencyConflictError, type IdempotencyInput } from '@pg-eos/db';

import {
  approveCommercial,
  approveFinance,
  createQuote,
  recordDecision,
  returnToDraft,
  reviseQuote,
  sendQuote,
  submitForReview,
  upsertQuoteLine,
} from '../../application/manage-quote/index.js';
import { createManageQuoteDeps } from '../../api/manage-quote/composition.js';
import {
  AccountNotFoundError,
  AccountNotQualifiedError,
  EmptyQuoteError,
  IllegalTransitionError,
  InvalidDiscountError,
  InvalidPriceExceptionError,
  // `MarginOutOfRangeError` — fix round 1 (pg-reviewer FAIL) item (c)/finding 10: a margin that
  // would overflow numeric(6,3) throws this instead of a raw DB error.
  MarginOutOfRangeError,
  MissingActorError,
  QuoteFrozenError,
  QuoteNotFoundError,
  RoleRequiredError,
  ServiceNotFoundError,
  StaleVersionError,
  // `InvalidValidUntilError` — pg-backend's actual exported name (confirmed against
  // domain/manage-quote/errors.ts) for a validUntil-in-the-past rejection (fix round 1, finding
  // 4/5) — not pinned literally by the brief; this file originally defaulted to
  // `InvalidValidityError` (catalog's naming convention) before coordinating with pg-backend.
  InvalidValidUntilError,
} from '../../domain/manage-quote/errors.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

// --- literals, each cited to the schema fact, decision or brief line they come from -------------

const ENTITY_CODE_PST = 'PST';
const SERVICE_CODE_ST01 = 'ST-01';
const SERVICE_CODE_HD04 = 'HD-04';

// Fixture-only floors — deliberately NOT the real 15%-markup convention (13B:2815) other slices'
// fixtures use, so a price ABOVE the floor can still yield an estimated margin under 10% (D-blueprint
// 02 §165) without needing a price_exception — decision 8's second gate needs exactly that case.
const ST01_STANDARD_COST = '100.000';
const ST01_MIN_PRICE = '110.000';
const HD04_STANDARD_COST = '50.000';
const HD04_MIN_PRICE = '57.500';

const HEALTHY_PRICE = '150.000'; // margin (150-100)/150*100 = 33.333% — no warning, no GM gate.
const THIN_MARGIN_PRICE = '111.000'; // margin (111-100)/111*100 = 9.910% — under 10%, GM gate.
const BELOW_FLOOR_PRICE = '90.000'; // below ST01_MIN_PRICE, needs a valid exception.
const BELOW_FLOOR_NO_EXCEPTION_PRICE = '50.000';

// Fix round 1 (pg-reviewer FAIL, finding 1) — HD-04's own floor/cost pair, chosen so a
// below-floor exception line's OWN margin is >= 10% (isolating "exception present" from "margin
// below 10%" as two INDEPENDENT gates on ApproveFinance, decision 8): margin
// (56.000-50.000)/56.000*100 = 10.714%.
const HD04_EXCEPTION_APPROVED_PRICE = '56.000';
// Fix round 1, finding 7/item (b): a unitPrice below the cited exception's own approved_price
// (BELOW_FLOOR_PRICE = '90.000' is the approved_price every insertPriceException call below uses
// for the ST-01 exceptions) — `unitPrice >= approved_price` is decision (b)'s new check.
const BELOW_EXCEPTION_APPROVED_PRICE = '80.000';
// Fix round 1, finding 10/item (c): a standard_cost large enough that the margin formula's own
// numeric(6,3) result (max magnitude 999.999) overflows — (150 - 99999999)/150*100 is enormously
// negative.
const MARGIN_OVERFLOW_STANDARD_COST = '99999999.000';

const CURRENCY_KWD = 'KWD';
const QTY_ONE = '1.000';
const QTY_THREE = '3.000';

const ROLE_SALES_REP = 'SALES_REP';
const ROLE_SALES_MGR = 'SALES_MGR';
const ROLE_CFO = 'CFO';
const ROLE_GM = 'GM';

const SALES_REP_ACTOR_UUID = '00000000-0000-4000-8000-000000016101';
const SALES_MGR_ACTOR_UUID = '00000000-0000-4000-8000-000000016102';
const CFO_ACTOR_UUID = '00000000-0000-4000-8000-000000016103';
const GM_ACTOR_UUID = '00000000-0000-4000-8000-000000016104';
const OUTSIDER_ACTOR_UUID = '00000000-0000-4000-8000-000000016105'; // RLS: no user_entities row for PST.

const clock = new FixedClock(new Date('2026-09-24T00:00:00.000Z'));
const YESTERDAY_ISO = '2026-09-23';
const VALID_UNTIL = '2026-12-31';
const ids = new SequentialIdGenerator(1610);
const deps = createManageQuoteDeps({ clock, ids });

const salesRepCtx = { userId: SALES_REP_ACTOR_UUID, clientId: null, isInternal: true };
const salesMgrCtx = { userId: SALES_MGR_ACTOR_UUID, clientId: null, isInternal: true };
const cfoCtx = { userId: CFO_ACTOR_UUID, clientId: null, isInternal: true };
const gmCtx = { userId: GM_ACTOR_UUID, clientId: null, isInternal: true };
const outsiderCtx = { userId: OUTSIDER_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
let otherEntityId: string;
let accountIdQualified: string;
let accountIdUnqualified: string;
let serviceIdSt01: string;
let serviceIdHd04: string;

const accountCodeQualified = `_quote_fixture_acc1_${randomUUID()}`;
const accountCodeUnqualified = `_quote_fixture_unq_${randomUUID()}`;
const fixtureAccountIds: string[] = [];
const fixtureQuoteIds: string[] = [];
const fixtureExceptionIds: string[] = [];
const usedCorrelationIds = new Set<string>();

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

/** sha256 hex of the canonical JSON body — matches `withIdempotentContext`'s own hash. */
function idemFor(endpoint: string, key: string, body: unknown): IdempotencyInput {
  return {
    key,
    endpoint: `sales.manage-quote.${endpoint}`,
    requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    entityId: null,
    successStatus: 200,
  };
}

async function insertPriceException(opts: {
  readonly clientId: string;
  readonly serviceId: string;
  readonly approvedPrice: string;
  readonly minPriceAtApproval: string;
  readonly validFrom: string;
  readonly validTo: string;
}): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into catalog.price_exceptions
       (entity_id, client_id, service_id, approved_price, min_price_at_approval, reason,
        valid_from, valid_to, approved_by, review_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8)
     returning id`,
    [
      entityId,
      opts.clientId,
      opts.serviceId,
      opts.approvedPrice,
      opts.minPriceAtApproval,
      'استثناء اختبار — WBS 1.6',
      opts.validFrom,
      opts.validTo,
      GM_ACTOR_UUID,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture catalog.price_exceptions insert returned no row');
  fixtureExceptionIds.push(row.id);
  return row.id;
}

async function getQuote(quoteId: string): Promise<{
  status: string;
  version: number;
  subtotal: string;
  discount_amt: string;
  total: string;
  estimated_margin_pct: string | null;
  frozen_snapshot: unknown;
  sent_at: Date | null;
  decided_at: Date | null;
  approved_by: string | null;
  doc_no: string;
}> {
  const result: QueryResult<{
    status: string;
    version: number;
    subtotal: string;
    discount_amt: string;
    total: string;
    estimated_margin_pct: string | null;
    frozen_snapshot: unknown;
    sent_at: Date | null;
    decided_at: Date | null;
    approved_by: string | null;
    doc_no: string;
  }> = await pool.query(
    `select status, version, subtotal::text as subtotal, discount_amt::text as discount_amt, total::text as total,
            estimated_margin_pct::text as estimated_margin_pct, frozen_snapshot, sent_at, decided_at, approved_by::text as approved_by,
            doc_no
       from sales.quotes where id = $1`,
    [quoteId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no sales.quotes row for id ${quoteId}`);
  return row;
}

async function getLines(
  quoteId: string,
): Promise<Array<{ id: string; service_id: string; unit_price: string; below_min: boolean; min_price_at_quote: string | null }>> {
  const result: QueryResult<{ id: string; service_id: string; unit_price: string; below_min: boolean; min_price_at_quote: string | null }> =
    await pool.query(
      `select id, service_id, unit_price::text as unit_price, below_min, min_price_at_quote::text as min_price_at_quote
       from sales.quote_lines where quote_id = $1 order by sort_order`,
      [quoteId],
    );
  return result.rows;
}

async function outboxRowsForCorrelationAndType(correlationId: string, eventType: string): Promise<Array<{ id: string }>> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `select id::text as id from platform.outbox where correlation_id = $1 and event_type = $2`,
    [correlationId, eventType],
  );
  return result.rows;
}

async function auditCountForCorrelation(correlationId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.audit_log where correlation_id = $1`,
    [correlationId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function grantRole(userId: string, roleCode: string): Promise<void> {
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [roleCode]);
  const roleId = roleResult.rows[0]?.id;
  if (!roleId) throw new Error(`identity.roles row not found for code ${roleCode}`);
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [userId, roleId]);
}

async function createFixtureActor(userId: string, entityIds: readonly string[]): Promise<void> {
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
  await pool.query(`delete from identity.users where id = $1`, [userId]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [userId, `_quote_fixture_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار عروض الأسعار — WBS 1.6'],
  );
  for (const eid of entityIds) {
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, eid]);
  }
}

/** Narrows `error` to `E` after asserting `instanceof`, so field access below stays type-safe. */
async function expectRejectsWith<E extends Error>(promise: Promise<unknown>, ctor: new (...args: never[]) => E): Promise<E> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ctor);
    if (error instanceof ctor) return error;
    throw error;
  }
  throw new Error(`expected ${ctor.name} to be thrown, but the promise resolved`);
}

async function createDraftQuote(accountId: string): Promise<{ quoteId: string; docNo: string; version: number }> {
  const result = await createQuote(
    salesRepCtx,
    {
      entityId,
      accountId,
      opportunityId: null,
      validUntil: VALID_UNTIL,
      currency: CURRENCY_KWD,
      termsAr: null,
      termsEn: null,
      correlationId: nextCorrelationId(),
    },
    deps,
  );
  fixtureQuoteIds.push(result.quoteId);
  return result;
}

/** Fix round 1, finding 14 — walks a FRESH quote (one healthy-margin ST-01 line, no exception,
 *  CFO-approvable) to `target` status via the REAL commands, never a shortcut/raw-SQL status
 *  write. Used only by the broadened stale-version coverage below. */
async function buildQuoteToStatus(
  target: 'draft' | 'commercial_review' | 'finance_review' | 'approved' | 'sent',
): Promise<{ quoteId: string; version: number }> {
  const created = await createDraftQuote(accountIdQualified);
  const line = await upsertQuoteLine(
    salesRepCtx,
    {
      quoteId: created.quoteId,
      serviceId: serviceIdSt01,
      qty: QTY_ONE,
      unitPrice: HEALTHY_PRICE,
      exceptionId: null,
      discountAmt: '0.000',
      expectedVersion: created.version,
      correlationId: nextCorrelationId(),
    },
    deps,
  );
  let version = line.version;
  if (target === 'draft') return { quoteId: created.quoteId, version };

  const submitted = await submitForReview(salesRepCtx, { quoteId: created.quoteId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
  version = submitted.version;
  if (target === 'commercial_review') return { quoteId: created.quoteId, version };

  const commercial = await approveCommercial(salesMgrCtx, { quoteId: created.quoteId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
  version = commercial.version;
  if (target === 'finance_review') return { quoteId: created.quoteId, version };

  const approved = await approveFinance(cfoCtx, { quoteId: created.quoteId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
  version = approved.version;
  if (target === 'approved') return { quoteId: created.quoteId, version };

  const sent = await sendQuote(salesRepCtx, { quoteId: created.quoteId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
  version = sent.version;
  return { quoteId: created.quoteId, version };
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, [ENTITY_CODE_PST]);
  entityId = (entityResult.rows[0] as { id: string }).id;

  const otherEntityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code <> $1 limit 1`,
    [ENTITY_CODE_PST],
  );
  otherEntityId = (otherEntityResult.rows[0] as { id: string }).id;

  const serviceStResult: QueryResult<{ id: string }> = await pool.query(`select id from catalog.services where code = $1`, [SERVICE_CODE_ST01]);
  serviceIdSt01 = (serviceStResult.rows[0] as { id: string }).id;
  const serviceHdResult: QueryResult<{ id: string }> = await pool.query(`select id from catalog.services where code = $1`, [SERVICE_CODE_HD04]);
  serviceIdHd04 = (serviceHdResult.rows[0] as { id: string }).id;

  await pool.query(`update catalog.services set min_price = $1, standard_cost = $2 where code = $3`, [
    ST01_MIN_PRICE,
    ST01_STANDARD_COST,
    SERVICE_CODE_ST01,
  ]);
  await pool.query(`update catalog.services set min_price = $1, standard_cost = $2 where code = $3`, [
    HD04_MIN_PRICE,
    HD04_STANDARD_COST,
    SERVICE_CODE_HD04,
  ]);

  const qualifiedResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type, cr_number, status) values ($1, $2, 'client', $3, 'active') returning id`,
    [accountCodeQualified, 'حساب اختبار مؤهَّل — ACC-1', `CR-${randomUUID().slice(0, 8)}`],
  );
  accountIdQualified = (qualifiedResult.rows[0] as { id: string }).id;
  fixtureAccountIds.push(accountIdQualified);

  const unqualifiedResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type, cr_number, status) values ($1, $2, 'client', null, 'active') returning id`,
    [accountCodeUnqualified, 'حساب اختبار غير مؤهَّل'],
  );
  accountIdUnqualified = (unqualifiedResult.rows[0] as { id: string }).id;
  fixtureAccountIds.push(accountIdUnqualified);

  await createFixtureActor(SALES_REP_ACTOR_UUID, [entityId]);
  await createFixtureActor(SALES_MGR_ACTOR_UUID, [entityId]);
  await createFixtureActor(CFO_ACTOR_UUID, [entityId]);
  await createFixtureActor(GM_ACTOR_UUID, [entityId]);
  await createFixtureActor(OUTSIDER_ACTOR_UUID, [otherEntityId]); // deliberately NOT entityId (PST).

  await grantRole(SALES_REP_ACTOR_UUID, ROLE_SALES_REP);
  await grantRole(SALES_MGR_ACTOR_UUID, ROLE_SALES_MGR);
  await grantRole(CFO_ACTOR_UUID, ROLE_CFO);
  await grantRole(GM_ACTOR_UUID, ROLE_GM);
});

afterAll(async () => {
  await pool.query(`update catalog.services set min_price = null, standard_cost = null where code in ($1, $2)`, [
    SERVICE_CODE_ST01,
    SERVICE_CODE_HD04,
  ]);

  if (usedCorrelationIds.size > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [[...usedCorrelationIds]]);
  }
  // sales.quote_lines.exception_id references catalog.price_exceptions(id) — quote_lines (or the
  // quotes cascade, sales.quote_lines has `on delete cascade` from sales.quotes per the schema)
  // MUST go before price_exceptions, or the FK (quote_lines_exception_id_fkey) blocks the delete.
  if (fixtureQuoteIds.length > 0) {
    await pool.query(`delete from sales.quote_lines where quote_id = any($1::uuid[])`, [fixtureQuoteIds]);
    await pool.query(`delete from sales.quotes where id = any($1::uuid[])`, [fixtureQuoteIds]);
  }
  if (fixtureExceptionIds.length > 0) {
    await pool.query(`delete from catalog.price_exceptions where id = any($1::uuid[])`, [fixtureExceptionIds]);
  }
  if (fixtureAccountIds.length > 0) {
    await pool.query(`delete from sales.accounts where id = any($1::uuid[])`, [fixtureAccountIds]);
  }

  for (const userId of [SALES_REP_ACTOR_UUID, SALES_MGR_ACTOR_UUID, CFO_ACTOR_UUID, GM_ACTOR_UUID, OUTSIDER_ACTOR_UUID]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
});

// --- Scenario 1 & 2: create + line at floor, then a line below floor with no exception -----------

describe('Feature: Manage quote (WBS 1.6, M02 sales)', () => {
  let narrativeQuoteId: string;
  let narrativeVersion: number;

  it('Scenario: Create a draft quote and add a line at or above the floor', async () => {
    const created = await createDraftQuote(accountIdQualified);
    expect(created.version).toBe(1);
    narrativeQuoteId = created.quoteId;

    const row = await getQuote(narrativeQuoteId);
    expect(row.status).toBe('draft');
    expect(row.version).toBe(1);

    const upserted = await upsertQuoteLine(
      salesRepCtx,
      {
        quoteId: narrativeQuoteId,
        serviceId: serviceIdSt01,
        qty: QTY_THREE,
        unitPrice: ST01_MIN_PRICE,
        exceptionId: null,
        discountAmt: '0.000',
        expectedVersion: created.version,
        correlationId: nextCorrelationId(),
      },
      deps,
    );
    expect(upserted.version).toBe(2);
    narrativeVersion = upserted.version;
    expect(upserted.subtotal).toBe('330.000');
    expect(upserted.total).toBe('330.000');

    const lines = await getLines(narrativeQuoteId);
    expect(lines).toHaveLength(1);
    const quoteRow = await getQuote(narrativeQuoteId);
    expect(quoteRow.subtotal).toBe('330.000');
    expect(quoteRow.total).toBe('330.000');
    expect(quoteRow.version).toBe(2);
  });

  it('Scenario: A line below the floor is rejected without an exception', async () => {
    const linesBefore = await getLines(narrativeQuoteId);
    await expectRejectsWith(
      upsertQuoteLine(
        salesRepCtx,
        {
          quoteId: narrativeQuoteId,
          serviceId: serviceIdSt01,
          qty: QTY_ONE,
          unitPrice: BELOW_FLOOR_NO_EXCEPTION_PRICE,
          exceptionId: null,
          discountAmt: '0.000',
          expectedVersion: narrativeVersion,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      InvalidPriceExceptionError,
    );
    expect(await getLines(narrativeQuoteId)).toHaveLength(linesBefore.length);
    expect((await getQuote(narrativeQuoteId)).version).toBe(narrativeVersion);
  });

  // --- Scenario 3 & 4: exception accepted / expired exception rejected --------------------------

  it('Scenario: A line below the floor is accepted with a valid GM-granted exception', async () => {
    const created = await createDraftQuote(accountIdQualified);
    const exceptionId = await insertPriceException({
      clientId: accountIdQualified,
      serviceId: serviceIdSt01,
      approvedPrice: BELOW_FLOOR_PRICE,
      minPriceAtApproval: ST01_MIN_PRICE,
      validFrom: '2026-01-01',
      validTo: '2026-12-31',
    });

    const upserted = await upsertQuoteLine(
      salesRepCtx,
      {
        quoteId: created.quoteId,
        serviceId: serviceIdSt01,
        qty: QTY_ONE,
        unitPrice: BELOW_FLOOR_PRICE,
        exceptionId,
        discountAmt: '0.000',
        expectedVersion: created.version,
        correlationId: nextCorrelationId(),
      },
      deps,
    );
    expect(upserted.lineId).toBeTruthy();

    const lines = await getLines(created.quoteId);
    const line = lines.find((l) => l.id === upserted.lineId);
    expect(line?.below_min).toBe(true);
  });

  it('Scenario: An expired exception is rejected', async () => {
    const created = await createDraftQuote(accountIdQualified);
    const expiredExceptionId = await insertPriceException({
      clientId: accountIdQualified,
      serviceId: serviceIdSt01,
      approvedPrice: BELOW_FLOOR_PRICE,
      minPriceAtApproval: ST01_MIN_PRICE,
      validFrom: '2026-01-01',
      validTo: YESTERDAY_ISO,
    });

    await expectRejectsWith(
      upsertQuoteLine(
        salesRepCtx,
        {
          quoteId: created.quoteId,
          serviceId: serviceIdSt01,
          qty: QTY_ONE,
          unitPrice: BELOW_FLOOR_PRICE,
          exceptionId: expiredExceptionId,
          discountAmt: '0.000',
          expectedVersion: created.version,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      InvalidPriceExceptionError,
    );
    expect(await getLines(created.quoteId)).toHaveLength(0);
  });

  // --- Scenario 5: empty quote cannot be submitted -------------------------------------------------

  it('Scenario: Submit for review requires at least one line', async () => {
    const created = await createDraftQuote(accountIdQualified);
    await expectRejectsWith(
      submitForReview(salesRepCtx, { quoteId: created.quoteId, expectedVersion: created.version, correlationId: nextCorrelationId() }, deps),
      EmptyQuoteError,
    );
    expect((await getQuote(created.quoteId)).status).toBe('draft');
  });

  // --- Scenario 6: full happy path, healthy margin, no exception -----------------------------------

  it('Scenario: Full happy path to approved (no exception, healthy margin)', async () => {
    const created = await createDraftQuote(accountIdQualified);
    const line = await upsertQuoteLine(
      salesRepCtx,
      {
        quoteId: created.quoteId,
        serviceId: serviceIdSt01,
        qty: QTY_ONE,
        unitPrice: HEALTHY_PRICE,
        exceptionId: null,
        discountAmt: '0.000',
        expectedVersion: created.version,
        correlationId: nextCorrelationId(),
      },
      deps,
    );
    expect(line.marginWarning).toBe(false);

    const submitted = await submitForReview(salesRepCtx, { quoteId: created.quoteId, expectedVersion: line.version, correlationId: nextCorrelationId() }, deps);
    const commercial = await approveCommercial(salesMgrCtx, { quoteId: created.quoteId, expectedVersion: submitted.version, correlationId: nextCorrelationId() }, deps);

    const approveCorrelationId = nextCorrelationId();
    await approveFinance(cfoCtx, { quoteId: created.quoteId, expectedVersion: commercial.version, correlationId: approveCorrelationId }, deps);

    const finalRow = await getQuote(created.quoteId);
    expect(finalRow.status).toBe('approved');
    expect(finalRow.approved_by).toBe(CFO_ACTOR_UUID);

    const approvedRows = await outboxRowsForCorrelationAndType(approveCorrelationId, 'sales.quote.approved');
    expect(approvedRows).toHaveLength(1);
    expect(await auditCountForCorrelation(approveCorrelationId)).toBe(1);
  });

  // --- Scenario 7: exception line -> only GM may approve finance ------------------------------------
  //
  // Fix round 1 (pg-reviewer FAIL, finding 1): the ORIGINAL fixture here used a below-floor ST-01
  // line whose margin was ALSO below 10% — vacuous, because the RoleRequiredError would still fire
  // even if the exception-check condition were deleted from approve-finance.ts (the margin
  // condition alone would explain it). This rewrite uses HD-04 with an exception line whose OWN
  // margin is explicitly asserted >= 10% FIRST, isolating the exception condition.

  it('Scenario: CFO cannot approve a quote with a below-floor exception line — only GM can (margin >= 10%, isolating the exception gate)', async () => {
    const created = await createDraftQuote(accountIdQualified);
    const exceptionId = await insertPriceException({
      clientId: accountIdQualified,
      serviceId: serviceIdHd04,
      approvedPrice: HD04_EXCEPTION_APPROVED_PRICE,
      minPriceAtApproval: HD04_MIN_PRICE,
      validFrom: '2026-01-01',
      validTo: '2026-12-31',
    });
    const line = await upsertQuoteLine(
      salesRepCtx,
      {
        quoteId: created.quoteId,
        serviceId: serviceIdHd04,
        qty: QTY_ONE,
        unitPrice: HD04_EXCEPTION_APPROVED_PRICE,
        exceptionId,
        discountAmt: '0.000',
        expectedVersion: created.version,
        correlationId: nextCorrelationId(),
      },
      deps,
    );
    // Isolates the exception condition: this line's OWN margin is >= 10%, so if ApproveFinance's
    // exception-check were deleted, CFO would be legitimately allowed — proving this test actually
    // exercises the exception gate, not the margin gate.
    expect(line.estimatedMarginPct).not.toBeNull();
    expect(line.estimatedMarginPct as number).toBeGreaterThanOrEqual(10);

    const submitted = await submitForReview(salesRepCtx, { quoteId: created.quoteId, expectedVersion: line.version, correlationId: nextCorrelationId() }, deps);
    const commercial = await approveCommercial(salesMgrCtx, { quoteId: created.quoteId, expectedVersion: submitted.version, correlationId: nextCorrelationId() }, deps);

    await expectRejectsWith(
      approveFinance(cfoCtx, { quoteId: created.quoteId, expectedVersion: commercial.version, correlationId: nextCorrelationId() }, deps),
      RoleRequiredError,
    );
    expect((await getQuote(created.quoteId)).status).toBe('finance_review');

    await approveFinance(gmCtx, { quoteId: created.quoteId, expectedVersion: commercial.version, correlationId: nextCorrelationId() }, deps);
    expect((await getQuote(created.quoteId)).status).toBe('approved');
  });

  // --- Scenario 8: margin < 10% -> only GM may approve finance --------------------------------------

  it('Scenario: CFO cannot approve a quote whose estimated margin is below 10% — only GM can', async () => {
    const created = await createDraftQuote(accountIdQualified);
    const line = await upsertQuoteLine(
      salesRepCtx,
      {
        quoteId: created.quoteId,
        serviceId: serviceIdSt01,
        qty: QTY_ONE,
        unitPrice: THIN_MARGIN_PRICE,
        exceptionId: null,
        discountAmt: '0.000',
        expectedVersion: created.version,
        correlationId: nextCorrelationId(),
      },
      deps,
    );
    expect(line.estimatedMarginPct).not.toBeNull();
    expect(line.estimatedMarginPct as number).toBeLessThan(10);

    const submitted = await submitForReview(salesRepCtx, { quoteId: created.quoteId, expectedVersion: line.version, correlationId: nextCorrelationId() }, deps);
    const commercial = await approveCommercial(salesMgrCtx, { quoteId: created.quoteId, expectedVersion: submitted.version, correlationId: nextCorrelationId() }, deps);

    await expectRejectsWith(
      approveFinance(cfoCtx, { quoteId: created.quoteId, expectedVersion: commercial.version, correlationId: nextCorrelationId() }, deps),
      RoleRequiredError,
    );

    await approveFinance(gmCtx, { quoteId: created.quoteId, expectedVersion: commercial.version, correlationId: nextCorrelationId() }, deps);
    expect((await getQuote(created.quoteId)).status).toBe('approved');
  });

  // --- Scenario 9 & 10: return-to-draft / lines frozen outside draft --------------------------------

  it('Scenario: A sales manager returns a quote to draft for changes', async () => {
    const created = await createDraftQuote(accountIdQualified);
    const line = await upsertQuoteLine(
      salesRepCtx,
      {
        quoteId: created.quoteId,
        serviceId: serviceIdSt01,
        qty: QTY_ONE,
        unitPrice: HEALTHY_PRICE,
        exceptionId: null,
        discountAmt: '0.000',
        expectedVersion: created.version,
        correlationId: nextCorrelationId(),
      },
      deps,
    );
    const submitted = await submitForReview(salesRepCtx, { quoteId: created.quoteId, expectedVersion: line.version, correlationId: nextCorrelationId() }, deps);

    const returned = await returnToDraft(salesMgrCtx, { quoteId: created.quoteId, expectedVersion: submitted.version, correlationId: nextCorrelationId() }, deps);
    expect((await getQuote(created.quoteId)).status).toBe('draft');

    // lines are editable again — an upsert now succeeds where it would have been frozen a moment ago.
    const secondUpsert = await upsertQuoteLine(
      salesRepCtx,
      {
        quoteId: created.quoteId,
        serviceId: serviceIdSt01,
        qty: QTY_THREE,
        unitPrice: HEALTHY_PRICE,
        exceptionId: null,
        discountAmt: '0.000',
        expectedVersion: returned.version,
        correlationId: nextCorrelationId(),
      },
      deps,
    );
    expect(secondUpsert.version).toBeGreaterThan(returned.version);
  });

  it('Scenario: Lines are frozen outside draft', async () => {
    const created = await createDraftQuote(accountIdQualified);
    const line = await upsertQuoteLine(
      salesRepCtx,
      {
        quoteId: created.quoteId,
        serviceId: serviceIdSt01,
        qty: QTY_ONE,
        unitPrice: HEALTHY_PRICE,
        exceptionId: null,
        discountAmt: '0.000',
        expectedVersion: created.version,
        correlationId: nextCorrelationId(),
      },
      deps,
    );
    const submitted = await submitForReview(salesRepCtx, { quoteId: created.quoteId, expectedVersion: line.version, correlationId: nextCorrelationId() }, deps);

    await expectRejectsWith(
      upsertQuoteLine(
        salesRepCtx,
        {
          quoteId: created.quoteId,
          serviceId: serviceIdSt01,
          qty: QTY_ONE,
          unitPrice: HEALTHY_PRICE,
          exceptionId: null,
          discountAmt: '0.000',
          expectedVersion: submitted.version,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      QuoteFrozenError,
    );
  });

  // --- Scenario 11-14: send / edit-after-send / revise / record-decision ----------------------------

  describe('a quote walked to "sent"', () => {
    let sentQuoteId: string;
    let sentVersion: number;

    it('Scenario: Send freezes the quote', async () => {
      const created = await createDraftQuote(accountIdQualified);
      const line = await upsertQuoteLine(
        salesRepCtx,
        {
          quoteId: created.quoteId,
          serviceId: serviceIdSt01,
          qty: QTY_ONE,
          unitPrice: HEALTHY_PRICE,
          exceptionId: null,
          discountAmt: '0.000',
          expectedVersion: created.version,
          correlationId: nextCorrelationId(),
        },
        deps,
      );
      const submitted = await submitForReview(salesRepCtx, { quoteId: created.quoteId, expectedVersion: line.version, correlationId: nextCorrelationId() }, deps);
      const commercial = await approveCommercial(salesMgrCtx, { quoteId: created.quoteId, expectedVersion: submitted.version, correlationId: nextCorrelationId() }, deps);
      const approved = await approveFinance(cfoCtx, { quoteId: created.quoteId, expectedVersion: commercial.version, correlationId: nextCorrelationId() }, deps);

      const sent = await sendQuote(salesRepCtx, { quoteId: created.quoteId, expectedVersion: approved.version, correlationId: nextCorrelationId() }, deps);
      sentQuoteId = created.quoteId;
      sentVersion = sent.version;

      const row = await getQuote(sentQuoteId);
      expect(row.status).toBe('sent');
      expect(row.frozen_snapshot).not.toBeNull();
      expect(row.sent_at).not.toBeNull();
    });

    it('Scenario: Any edit after send is rejected and steered to revise', async () => {
      await expectRejectsWith(
        upsertQuoteLine(
          salesRepCtx,
          {
            quoteId: sentQuoteId,
            serviceId: serviceIdSt01,
            qty: QTY_ONE,
            unitPrice: HEALTHY_PRICE,
            exceptionId: null,
            discountAmt: '0.000',
            expectedVersion: sentVersion,
            correlationId: nextCorrelationId(),
          },
          deps,
        ),
        QuoteFrozenError,
      );
      await expectRejectsWith(
        approveFinance(cfoCtx, { quoteId: sentQuoteId, expectedVersion: sentVersion, correlationId: nextCorrelationId() }, deps),
        QuoteFrozenError,
      );
      await expectRejectsWith(
        submitForReview(salesRepCtx, { quoteId: sentQuoteId, expectedVersion: sentVersion, correlationId: nextCorrelationId() }, deps),
        QuoteFrozenError,
      );
    });

    it('Scenario: Revising a sent quote creates a brand-new quote, untouched original — min_price_at_quote is RE-READ fresh (fix round 1, finding 8)', async () => {
      const before = await getQuote(sentQuoteId);
      const originalLinesBeforeRevise = await getLines(sentQuoteId);
      const RAISED_ST01_MIN_PRICE = '140.000'; // still <= HEALTHY_PRICE ('150.000') — the line stays valid.
      expect(originalLinesBeforeRevise[0]?.min_price_at_quote).toBe(ST01_MIN_PRICE);

      // Raise the floor AFTER send, BEFORE revise — the only way to prove ReviseQuote's clone
      // re-reads catalog.services.min_price fresh rather than copying the source line's stale value.
      await pool.query(`update catalog.services set min_price = $1 where code = $2`, [RAISED_ST01_MIN_PRICE, SERVICE_CODE_ST01]);
      let revised: { newQuoteId: string; newDocNo: string };
      try {
        revised = await reviseQuote(salesRepCtx, { quoteId: sentQuoteId, correlationId: nextCorrelationId() }, deps);
      } finally {
        await pool.query(`update catalog.services set min_price = $1 where code = $2`, [ST01_MIN_PRICE, SERVICE_CODE_ST01]);
      }
      fixtureQuoteIds.push(revised.newQuoteId);

      const newRow = await getQuote(revised.newQuoteId);
      expect(newRow.status).toBe('draft');
      expect(newRow.doc_no).toBe(revised.newDocNo);
      expect(newRow.doc_no).not.toBe(before.doc_no);

      const newLines = await getLines(revised.newQuoteId);
      const originalLines = await getLines(sentQuoteId);
      expect(newLines).toHaveLength(originalLines.length);
      expect(newLines[0]?.service_id).toBe(originalLines[0]?.service_id);
      expect(newLines[0]?.unit_price).toBe(originalLines[0]?.unit_price);
      // The NEW quote's cloned line carries the min_price READ AT REVISE TIME (raised).
      expect(newLines[0]?.min_price_at_quote).toBe(RAISED_ST01_MIN_PRICE);
      // The ORIGINAL (frozen) quote's line is untouched — still the OLD value.
      expect(originalLines[0]?.min_price_at_quote).toBe(ST01_MIN_PRICE);

      const after = await getQuote(sentQuoteId);
      expect(after).toEqual(before);
    });

    it("Scenario: Recording the client's decision", async () => {
      const decided = await recordDecision(
        salesRepCtx,
        { quoteId: sentQuoteId, decision: 'accepted', expectedVersion: sentVersion, correlationId: nextCorrelationId() },
        deps,
      );
      expect(decided.version).toBeGreaterThan(sentVersion);
      const row = await getQuote(sentQuoteId);
      expect(row.status).toBe('accepted');
      expect(row.decided_at).not.toBeNull();
    });
  });

  // --- Scenario 15: stale version rejected on every mutating command --------------------------------

  it('Scenario: Stale version is rejected on every mutating command', async () => {
    const created = await createDraftQuote(accountIdQualified);
    const staleVersion = created.version + 5;

    await expectRejectsWith(
      upsertQuoteLine(
        salesRepCtx,
        {
          quoteId: created.quoteId,
          serviceId: serviceIdSt01,
          qty: QTY_ONE,
          unitPrice: HEALTHY_PRICE,
          exceptionId: null,
          discountAmt: '0.000',
          expectedVersion: staleVersion,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      StaleVersionError,
    );
    expect(await getLines(created.quoteId)).toHaveLength(0);
    expect((await getQuote(created.quoteId)).version).toBe(created.version);

    await expectRejectsWith(
      submitForReview(salesRepCtx, { quoteId: created.quoteId, expectedVersion: staleVersion, correlationId: nextCorrelationId() }, deps),
      StaleVersionError,
    );
    expect((await getQuote(created.quoteId)).status).toBe('draft');
    expect((await getQuote(created.quoteId)).version).toBe(created.version);
  });

  // Fix round 1, finding 14 — broaden stale-version coverage to ApproveCommercial, ApproveFinance,
  // ReturnToDraft, SendQuote and RecordDecision (previously only UpsertQuoteLine/SubmitForReview
  // were tested). Each builds a fresh quote to the status the command needs via the REAL commands
  // (never a shortcut), then attempts that one command with a stale expectedVersion.

  it('Scenario (finding 14): a stale expectedVersion on ApproveCommercial is rejected, status unchanged', async () => {
    const at = await buildQuoteToStatus('commercial_review');
    await expectRejectsWith(
      approveCommercial(salesMgrCtx, { quoteId: at.quoteId, expectedVersion: at.version + 5, correlationId: nextCorrelationId() }, deps),
      StaleVersionError,
    );
    const row = await getQuote(at.quoteId);
    expect(row.status).toBe('commercial_review');
    expect(row.version).toBe(at.version);
  });

  it('Scenario (finding 14): a stale expectedVersion on ApproveFinance is rejected, status unchanged', async () => {
    const at = await buildQuoteToStatus('finance_review');
    await expectRejectsWith(
      approveFinance(cfoCtx, { quoteId: at.quoteId, expectedVersion: at.version + 5, correlationId: nextCorrelationId() }, deps),
      StaleVersionError,
    );
    const row = await getQuote(at.quoteId);
    expect(row.status).toBe('finance_review');
    expect(row.version).toBe(at.version);
  });

  it('Scenario (finding 14): a stale expectedVersion on ReturnToDraft is rejected, status unchanged', async () => {
    const at = await buildQuoteToStatus('commercial_review');
    await expectRejectsWith(
      returnToDraft(salesMgrCtx, { quoteId: at.quoteId, expectedVersion: at.version + 5, correlationId: nextCorrelationId() }, deps),
      StaleVersionError,
    );
    const row = await getQuote(at.quoteId);
    expect(row.status).toBe('commercial_review');
    expect(row.version).toBe(at.version);
  });

  it('Scenario (finding 14): a stale expectedVersion on SendQuote is rejected, status unchanged', async () => {
    const at = await buildQuoteToStatus('approved');
    await expectRejectsWith(
      sendQuote(salesRepCtx, { quoteId: at.quoteId, expectedVersion: at.version + 5, correlationId: nextCorrelationId() }, deps),
      StaleVersionError,
    );
    const row = await getQuote(at.quoteId);
    expect(row.status).toBe('approved');
    expect(row.version).toBe(at.version);
  });

  it('Scenario (finding 14): a stale expectedVersion on RecordDecision is rejected, status unchanged', async () => {
    const at = await buildQuoteToStatus('sent');
    await expectRejectsWith(
      recordDecision(
        salesRepCtx,
        { quoteId: at.quoteId, decision: 'accepted', expectedVersion: at.version + 5, correlationId: nextCorrelationId() },
        deps,
      ),
      StaleVersionError,
    );
    const row = await getQuote(at.quoteId);
    expect(row.status).toBe('sent');
    expect(row.version).toBe(at.version);
  });

  // --- Scenario 16: unqualified account rejected at creation ----------------------------------------

  it('Scenario: An unqualified account is rejected at creation', async () => {
    await expectRejectsWith(
      createQuote(
        salesRepCtx,
        {
          entityId,
          accountId: accountIdUnqualified,
          opportunityId: null,
          validUntil: VALID_UNTIL,
          currency: CURRENCY_KWD,
          termsAr: null,
          termsEn: null,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      AccountNotQualifiedError,
    );
  });

  // --- Scenario 17: idempotent replay and conflicting replay ----------------------------------------

  it('Scenario: Idempotent replay and conflicting replay', async () => {
    const idempotencyKey = randomUUID();
    const body = {
      entityId,
      accountId: accountIdQualified,
      opportunityId: null,
      validUntil: VALID_UNTIL,
      currency: CURRENCY_KWD,
      termsAr: null,
      termsEn: null,
      correlationId: randomUUID(),
    };
    const idem = idemFor('create-quote', idempotencyKey, body);

    const first = await createQuote(salesRepCtx, { ...body, idem }, deps);
    fixtureQuoteIds.push(first.quoteId);
    const second = await createQuote(salesRepCtx, { ...body, idem }, deps);
    expect(second).toEqual(first);

    const countResult: QueryResult<{ n: string }> = await pool.query(`select count(*)::text as n from sales.quotes where id = $1`, [first.quoteId]);
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(1);

    const differentBody = { ...body, correlationId: randomUUID(), validUntil: '2027-01-01' };
    await expectRejectsWith(
      createQuote(salesRepCtx, { ...differentBody, idem: idemFor('create-quote', idempotencyKey, differentBody) }, deps),
      IdempotencyConflictError,
    );
  });

  // --- Scenario 18: RLS ------------------------------------------------------------------------------

  it('Scenario: RLS — a caller scoped to another entity cannot see or write the quote', async () => {
    const created = await createDraftQuote(accountIdQualified);
    await expectRejectsWith(
      upsertQuoteLine(
        outsiderCtx,
        {
          quoteId: created.quoteId,
          serviceId: serviceIdSt01,
          qty: QTY_ONE,
          unitPrice: HEALTHY_PRICE,
          exceptionId: null,
          discountAmt: '0.000',
          expectedVersion: created.version,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      QuoteNotFoundError,
    );
    expect((await getQuote(created.quoteId)).version).toBe(created.version);
    expect(await getLines(created.quoteId)).toHaveLength(0);
  });
});

// --- additional Master-decision assertions not already covered by a named Gherkin scenario --------

describe('Master decision 2 — a cross-entity/missing account is invisible at creation (AccountNotFoundError)', () => {
  it('CreateQuote for an accountId that does not exist throws AccountNotFoundError, never leaked as AccountNotQualifiedError', async () => {
    await expectRejectsWith(
      createQuote(
        salesRepCtx,
        {
          entityId,
          accountId: randomUUID(),
          opportunityId: null,
          validUntil: VALID_UNTIL,
          currency: CURRENCY_KWD,
          termsAr: null,
          termsEn: null,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      AccountNotFoundError,
    );
  });
});

describe('Master decision 3 — an unknown serviceId throws ServiceNotFoundError', () => {
  it('UpsertQuoteLine for a serviceId that does not exist throws ServiceNotFoundError, no line written', async () => {
    const created = await createDraftQuote(accountIdQualified);
    await expectRejectsWith(
      upsertQuoteLine(
        salesRepCtx,
        {
          quoteId: created.quoteId,
          serviceId: randomUUID(),
          qty: QTY_ONE,
          unitPrice: HEALTHY_PRICE,
          exceptionId: null,
          discountAmt: '0.000',
          expectedVersion: created.version,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      ServiceNotFoundError,
    );
    expect(await getLines(created.quoteId)).toHaveLength(0);
  });
});

describe('Master decision 4 — discountAmt must be >= 0 and <= subtotal', () => {
  it('a negative discountAmt throws InvalidDiscountError', async () => {
    const created = await createDraftQuote(accountIdQualified);
    await expectRejectsWith(
      upsertQuoteLine(
        salesRepCtx,
        {
          quoteId: created.quoteId,
          serviceId: serviceIdSt01,
          qty: QTY_ONE,
          unitPrice: HEALTHY_PRICE,
          exceptionId: null,
          discountAmt: '-1.000',
          expectedVersion: created.version,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      InvalidDiscountError,
    );
  });

  it('a discountAmt greater than the resulting subtotal throws InvalidDiscountError', async () => {
    const created = await createDraftQuote(accountIdQualified);
    await expectRejectsWith(
      upsertQuoteLine(
        salesRepCtx,
        {
          quoteId: created.quoteId,
          serviceId: serviceIdSt01,
          qty: QTY_ONE,
          unitPrice: HEALTHY_PRICE,
          exceptionId: null,
          discountAmt: '999999.000',
          expectedVersion: created.version,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      InvalidDiscountError,
    );
  });
});

describe('Master decision 13 — a missing ctx.userId throws MissingActorError, never writes a null actor', () => {
  it('CreateQuote with ctx.userId null throws MissingActorError', async () => {
    const noActorCtx = { userId: null as unknown as string, clientId: null, isInternal: true };
    await expectRejectsWith(
      createQuote(
        noActorCtx,
        {
          entityId,
          accountId: accountIdQualified,
          opportunityId: null,
          validUntil: VALID_UNTIL,
          currency: CURRENCY_KWD,
          termsAr: null,
          termsEn: null,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      MissingActorError,
    );
  });
});

describe('Master decision 1 — an illegal transition throws IllegalTransitionError', () => {
  it('ApproveCommercial on a still-draft quote throws IllegalTransitionError', async () => {
    const created = await createDraftQuote(accountIdQualified);
    await expectRejectsWith(
      approveCommercial(salesMgrCtx, { quoteId: created.quoteId, expectedVersion: created.version, correlationId: nextCorrelationId() }, deps),
      IllegalTransitionError,
    );
  });
});

// --- pg-reviewer round 2 (fix round 2): these 6 were titled "Scenario (new, finding N)" with no
// matching entry in manage-quote.feature (18 scenarios there, 24 its here) — retitled as plain
// Master-decision assertions, matching the style of the blocks above, rather than touching the
// feature file (less disruptive: these are all isolation/defect-fix tests for a decision, not new
// user-facing Gherkin scenarios).

describe('Master decision 8 — the exception gate and the margin gate are ISOLATED conditions on ApproveFinance', () => {
  it('a GM approves a perfectly healthy quote (no exception, margin well above 10%) and succeeds — item (a): GM is never refused', async () => {
    const created = await createDraftQuote(accountIdQualified);
    const line = await upsertQuoteLine(
      salesRepCtx,
      {
        quoteId: created.quoteId,
        serviceId: serviceIdSt01,
        qty: QTY_ONE,
        unitPrice: HEALTHY_PRICE,
        exceptionId: null,
        discountAmt: '0.000',
        expectedVersion: created.version,
        correlationId: nextCorrelationId(),
      },
      deps,
    );
    expect(line.estimatedMarginPct as number).toBeGreaterThanOrEqual(10);

    const submitted = await submitForReview(salesRepCtx, { quoteId: created.quoteId, expectedVersion: line.version, correlationId: nextCorrelationId() }, deps);
    const commercial = await approveCommercial(salesMgrCtx, { quoteId: created.quoteId, expectedVersion: submitted.version, correlationId: nextCorrelationId() }, deps);

    await approveFinance(gmCtx, { quoteId: created.quoteId, expectedVersion: commercial.version, correlationId: nextCorrelationId() }, deps);
    expect((await getQuote(created.quoteId)).status).toBe('approved');
  });
});

describe('Master decision 3 — a unitPrice below the cited exception\'s own approved_price is rejected (item b)', () => {
  it('citing a valid, non-expired exception but quoting below its approved_price throws InvalidPriceExceptionError', async () => {
    const created = await createDraftQuote(accountIdQualified);
    const exceptionId = await insertPriceException({
      clientId: accountIdQualified,
      serviceId: serviceIdSt01,
      approvedPrice: BELOW_FLOOR_PRICE, // '90.000'
      minPriceAtApproval: ST01_MIN_PRICE,
      validFrom: '2026-01-01',
      validTo: '2026-12-31',
    });

    await expectRejectsWith(
      upsertQuoteLine(
        salesRepCtx,
        {
          quoteId: created.quoteId,
          serviceId: serviceIdSt01,
          qty: QTY_ONE,
          unitPrice: BELOW_EXCEPTION_APPROVED_PRICE, // '80.000' < '90.000'
          exceptionId,
          discountAmt: '0.000',
          expectedVersion: created.version,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      InvalidPriceExceptionError,
    );
    expect(await getLines(created.quoteId)).toHaveLength(0);
  });
});

describe('Master decision 5 — a margin overflowing numeric(6,3) throws MarginOutOfRangeError (item c)', () => {
  it('a line whose cost/price combination overflows numeric(6,3) throws MarginOutOfRangeError, not a raw DB error, on UpsertQuoteLine', async () => {
    const created = await createDraftQuote(accountIdQualified);
    await pool.query(`update catalog.services set standard_cost = $1 where code = $2`, [MARGIN_OVERFLOW_STANDARD_COST, SERVICE_CODE_ST01]);
    try {
      await expectRejectsWith(
        upsertQuoteLine(
          salesRepCtx,
          {
            quoteId: created.quoteId,
            serviceId: serviceIdSt01,
            qty: QTY_ONE,
            unitPrice: HEALTHY_PRICE,
            exceptionId: null,
            discountAmt: '0.000',
            expectedVersion: created.version,
            correlationId: nextCorrelationId(),
          },
          deps,
        ),
        MarginOutOfRangeError,
      );
      expect(await getLines(created.quoteId)).toHaveLength(0);
    } finally {
      await pool.query(`update catalog.services set standard_cost = $1 where code = $2`, [ST01_STANDARD_COST, SERVICE_CODE_ST01]);
    }
  });

  // pg-reviewer round 2 — pg-backend's own finding-1 fix: ApproveFinance must also call
  // assertMarginInRange (a margin can drift out of numeric(6,3) range between the line write and
  // approval if a service's standard_cost changes in between). Coordinated with pg-backend on
  // timing — RED here is expected until their fix lands; once it does this proves ApproveFinance
  // itself re-validates the margin, not just UpsertQuoteLine.
  it('a standard_cost raised AFTER a healthy line was upserted, so the margin now overflows at ApproveFinance time, throws MarginOutOfRangeError on ApproveFinance', async () => {
    const created = await createDraftQuote(accountIdQualified);
    const line = await upsertQuoteLine(
      salesRepCtx,
      {
        quoteId: created.quoteId,
        serviceId: serviceIdSt01,
        qty: QTY_ONE,
        unitPrice: HEALTHY_PRICE,
        exceptionId: null,
        discountAmt: '0.000',
        expectedVersion: created.version,
        correlationId: nextCorrelationId(),
      },
      deps,
    );
    const submitted = await submitForReview(salesRepCtx, { quoteId: created.quoteId, expectedVersion: line.version, correlationId: nextCorrelationId() }, deps);
    const commercial = await approveCommercial(salesMgrCtx, { quoteId: created.quoteId, expectedVersion: submitted.version, correlationId: nextCorrelationId() }, deps);

    await pool.query(`update catalog.services set standard_cost = $1 where code = $2`, [MARGIN_OVERFLOW_STANDARD_COST, SERVICE_CODE_ST01]);
    try {
      await expectRejectsWith(
        approveFinance(gmCtx, { quoteId: created.quoteId, expectedVersion: commercial.version, correlationId: nextCorrelationId() }, deps),
        MarginOutOfRangeError,
      );
    } finally {
      await pool.query(`update catalog.services set standard_cost = $1 where code = $2`, [ST01_STANDARD_COST, SERVICE_CODE_ST01]);
    }
  });
});

describe('Master decision 2 — CreateQuote validUntil in the past, and non-SALES_REP role, are rejected', () => {
  it('CreateQuote with validUntil in the past throws InvalidValidUntilError', async () => {
    await expectRejectsWith(
      createQuote(
        salesRepCtx,
        {
          entityId,
          accountId: accountIdQualified,
          opportunityId: null,
          validUntil: YESTERDAY_ISO,
          currency: CURRENCY_KWD,
          termsAr: null,
          termsEn: null,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      InvalidValidUntilError,
    );
  });

  it('CreateQuote called by a non-SALES_REP role throws RoleRequiredError', async () => {
    await expectRejectsWith(
      createQuote(
        cfoCtx,
        {
          entityId,
          accountId: accountIdQualified,
          opportunityId: null,
          validUntil: VALID_UNTIL,
          currency: CURRENCY_KWD,
          termsAr: null,
          termsEn: null,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      RoleRequiredError,
    );
  });
});

describe('Master decision 12 — ReviseQuote re-checks account qualification, same as CreateQuote', () => {
  it('ReviseQuote for an account that has since lost its qualification (cr_number cleared) throws AccountNotQualifiedError', async () => {
    const revisableAccountResult: QueryResult<{ id: string }> = await pool.query(
      `insert into sales.accounts (code, name_ar, account_type, cr_number, status) values ($1, $2, 'client', $3, 'active') returning id`,
      [`_quote_fixture_revise_unq_${randomUUID()}`, 'حساب سيفقد التأهيل قبل إعادة العرض', `CR-${randomUUID().slice(0, 8)}`],
    );
    const revisableAccountId = (revisableAccountResult.rows[0] as { id: string }).id;
    fixtureAccountIds.push(revisableAccountId);

    const at = await (async () => {
      const created = await createDraftQuote(revisableAccountId);
      const line = await upsertQuoteLine(
        salesRepCtx,
        {
          quoteId: created.quoteId,
          serviceId: serviceIdSt01,
          qty: QTY_ONE,
          unitPrice: HEALTHY_PRICE,
          exceptionId: null,
          discountAmt: '0.000',
          expectedVersion: created.version,
          correlationId: nextCorrelationId(),
        },
        deps,
      );
      const submitted = await submitForReview(salesRepCtx, { quoteId: created.quoteId, expectedVersion: line.version, correlationId: nextCorrelationId() }, deps);
      const commercial = await approveCommercial(salesMgrCtx, { quoteId: created.quoteId, expectedVersion: submitted.version, correlationId: nextCorrelationId() }, deps);
      const approved = await approveFinance(cfoCtx, { quoteId: created.quoteId, expectedVersion: commercial.version, correlationId: nextCorrelationId() }, deps);
      const sent = await sendQuote(salesRepCtx, { quoteId: created.quoteId, expectedVersion: approved.version, correlationId: nextCorrelationId() }, deps);
      return { quoteId: created.quoteId, version: sent.version };
    })();

    // The account loses its qualification AFTER the quote was sent — only discoverable at revise time.
    await pool.query(`update sales.accounts set cr_number = null where id = $1`, [revisableAccountId]);

    await expectRejectsWith(
      reviseQuote(salesRepCtx, { quoteId: at.quoteId, correlationId: nextCorrelationId() }, deps),
      AccountNotQualifiedError,
    );
  });
});
