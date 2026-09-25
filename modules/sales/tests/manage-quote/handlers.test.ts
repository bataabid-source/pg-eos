// modules/sales/tests/manage-quote/handlers.test.ts — WBS 1.6, M02 sales.
//
// The api layer's contract (modules/sales/api/manage-quote/handlers.ts), one test per mapping
// (slice brief Master decision 15, golden pattern):
//   - a missing Idempotency-Key -> 400 Problem;
//   - a Zod failure -> 400;
//   - StaleVersionError/IdempotencyConflictError -> 409;
//   - every other typed domain error (QuoteFrozenError, RoleRequiredError,
//     InvalidPriceExceptionError, AccountNotQualifiedError, IllegalTransitionError, ...) -> 422;
//   - an unknown error -> 500, logged once via deps.logger.error, never leaked to the client;
//   - a success call -> 200 with the command's own result.
// `title` is always `error.name` (golden convention, unchanged here).
//
// HANDLER NAMES (mirrors the golden `handle<Command>` convention, this file's own default —
// mirrors modules/catalog/api/maintain-price-list/handlers.ts's `handle<Command>` naming):
// handleCreateQuote, handleUpsertQuoteLine, handleSubmitForReview, handleApproveCommercial,
// handleApproveFinance, handleReturnToDraft, handleSendQuote, handleRecordDecision,
// handleReviseQuote.
//
// CHOSEN PORT NAME (pg-tester default, for the "unknown error" test's broken-deps override):
// `deps.repo.getQuoteForUpdate` — mirrors catalog's `deps.repo.getPriceListForUpdate` /
// the golden `deps.repo.getOrderForUpdate`.
//
// Fixture/RLS pattern: same admin-pool style as ./manage-quote.test.ts, deliberately minimal (one
// qualified account, one draft quote, one SALES_REP actor) — this file only exercises the
// API-mapping LAYER. platform.audit_log is never deleted; ST-01's min_price/standard_cost are set
// here via the admin pool and restored to NULL in afterAll.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';

import { createManageQuoteDeps } from '../../api/manage-quote/composition.js';
import type { Logger } from '../../application/manage-quote/ports.js';
import {
  handleApproveFinance,
  handleCreateQuote,
  handleSendQuote,
  handleSubmitForReview,
  handleUpsertQuoteLine,
  type ApiRequest,
} from '../../api/manage-quote/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const ENTITY_CODE_PST = 'PST';
const SERVICE_CODE_ST01 = 'ST-01';
const ST01_STANDARD_COST = '100.000';
const ST01_MIN_PRICE = '110.000';
const HEALTHY_PRICE = '150.000';
const CURRENCY_KWD = 'KWD';
const ROLE_SALES_REP = 'SALES_REP';
const VALID_UNTIL = '2026-12-31';

const FIXTURE_SALES_REP_ACTOR_UUID = '00000000-0000-4000-8000-000000016201';
const clock = new FixedClock(new Date('2026-09-24T00:00:00.000Z'));
const ids = new SequentialIdGenerator(16200);
const deps = createManageQuoteDeps({ clock, ids });
const ctx = { userId: FIXTURE_SALES_REP_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
let accountId: string;
let draftQuoteId: string;
let draftQuoteVersion: number;
const extraQuoteIds: string[] = [];
const extraAccountIds: string[] = [];

function requestWithKey<TBody>(body: TBody, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx };
}

function requestWithoutKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: {}, body, ctx };
}

function spyLogger(): Logger & { readonly errorCalls: Array<[Record<string, unknown>, string]> } {
  const errorCalls: Array<[Record<string, unknown>, string]> = [];
  return {
    errorCalls,
    error: (obj, msg) => {
      errorCalls.push([obj, msg]);
    },
    info: () => {
      // not asserted here.
    },
  };
}

async function insertFreshQualifiedAccount(): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type, cr_number, status) values ($1, $2, 'client', $3, 'active') returning id`,
    [`_quote_handlers_${randomUUID()}`, 'حساب اختبار معالجات عروض الأسعار', `CR-${randomUUID().slice(0, 8)}`],
  );
  const row = result.rows[0] as { id: string };
  extraAccountIds.push(row.id);
  return row.id;
}

async function insertFreshDraftQuote(): Promise<{ id: string; version: number }> {
  const acc = await insertFreshQualifiedAccount();
  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(`select platform.next_doc_no($1, 'QTE') as doc_no`, [entityId]);
  const result: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into sales.quotes (entity_id, doc_no, account_id, valid_until, currency, status)
     values ($1, $2, $3, $4, $5, 'draft') returning id, version`,
    [entityId, (docNoResult.rows[0] as { doc_no: string }).doc_no, acc, VALID_UNTIL, CURRENCY_KWD],
  );
  const row = result.rows[0] as { id: string; version: number };
  extraQuoteIds.push(row.id);
  return row;
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, [ENTITY_CODE_PST]);
  entityId = (entityResult.rows[0] as { id: string }).id;

  await pool.query(`update catalog.services set min_price = $1, standard_cost = $2 where code = $3`, [
    ST01_MIN_PRICE,
    ST01_STANDARD_COST,
    SERVICE_CODE_ST01,
  ]);

  accountId = await insertFreshQualifiedAccount();

  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(`select platform.next_doc_no($1, 'QTE') as doc_no`, [entityId]);
  const quoteResult: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into sales.quotes (entity_id, doc_no, account_id, valid_until, currency, status)
     values ($1, $2, $3, $4, $5, 'draft') returning id, version`,
    [entityId, (docNoResult.rows[0] as { doc_no: string }).doc_no, accountId, VALID_UNTIL, CURRENCY_KWD],
  );
  draftQuoteId = (quoteResult.rows[0] as { id: string; version: number }).id;
  draftQuoteVersion = (quoteResult.rows[0] as { id: string; version: number }).version;

  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_SALES_REP_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_SALES_REP_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_SALES_REP_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [FIXTURE_SALES_REP_ACTOR_UUID, `_quote_handlers_actor_${randomUUID()}@test.invalid`, 'ممثل اختبار معالجات عروض الأسعار'],
  );
  await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [FIXTURE_SALES_REP_ACTOR_UUID, entityId]);
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [ROLE_SALES_REP]);
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [
    FIXTURE_SALES_REP_ACTOR_UUID,
    (roleResult.rows[0] as { id: string }).id,
  ]);
});

afterAll(async () => {
  await pool.query(`update catalog.services set min_price = null, standard_cost = null where code = $1`, [SERVICE_CODE_ST01]);

  if (draftQuoteId) {
    await pool.query(`delete from sales.quote_lines where quote_id = $1`, [draftQuoteId]);
    await pool.query(`delete from sales.quotes where id = $1`, [draftQuoteId]);
  }
  if (extraQuoteIds.length > 0) {
    await pool.query(`delete from sales.quote_lines where quote_id = any($1::uuid[])`, [extraQuoteIds]);
    await pool.query(`delete from sales.quotes where id = any($1::uuid[])`, [extraQuoteIds]);
  }
  if (accountId) await pool.query(`delete from sales.accounts where id = $1`, [accountId]);
  if (extraAccountIds.length > 0) await pool.query(`delete from sales.accounts where id = any($1::uuid[])`, [extraAccountIds]);

  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_SALES_REP_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [FIXTURE_SALES_REP_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_SALES_REP_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_SALES_REP_ACTOR_UUID]);
  await pool.end();
});

describe('a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('handleCreateQuote: no Idempotency-Key header -> 400', async () => {
    const result = await handleCreateQuote(
      requestWithoutKey({
        entityId,
        accountId,
        opportunityId: null,
        validUntil: VALID_UNTIL,
        currency: CURRENCY_KWD,
        termsAr: null,
        termsEn: null,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });
});

describe('an invalid body is rejected with a 400 Problem', () => {
  it('handleCreateQuote: a body missing required fields -> 400, not a thrown exception', async () => {
    const result = await handleCreateQuote(requestWithKey({}), deps);
    expect(result.status).toBe(400);
  });

  it('handleUpsertQuoteLine: qty "0" -> 400 (contract-level positivity)', async () => {
    const result = await handleUpsertQuoteLine(
      requestWithKey({
        quoteId: draftQuoteId,
        serviceId: randomUUID(),
        qty: '0',
        unitPrice: HEALTHY_PRICE,
        exceptionId: null,
        discountAmt: '0.000',
        expectedVersion: draftQuoteVersion,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(400);
  });

  it('handleUpsertQuoteLine: a non-uuid quoteId -> 400', async () => {
    const result = await handleUpsertQuoteLine(
      requestWithKey({
        quoteId: 'not-a-uuid',
        serviceId: randomUUID(),
        qty: '1.000',
        unitPrice: HEALTHY_PRICE,
        exceptionId: null,
        discountAmt: '0.000',
        expectedVersion: 1,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(400);
  });
});

describe('a success call returns 200 with the command result', () => {
  it('handleCreateQuote: a valid body -> 200, body has quoteId and version 1', async () => {
    const freshAccountId = await insertFreshQualifiedAccount();
    const result = await handleCreateQuote(
      requestWithKey({
        entityId,
        accountId: freshAccountId,
        opportunityId: null,
        validUntil: VALID_UNTIL,
        currency: CURRENCY_KWD,
        termsAr: null,
        termsEn: null,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect((result.body as { version: number }).version).toBe(1);
      const quoteId = (result.body as { quoteId: string }).quoteId;
      extraQuoteIds.push(quoteId);
    }
  });
});

describe('every other typed domain error maps to 422, title = error.name (decision 15)', () => {
  it('handleUpsertQuoteLine: a below-floor price with no exceptionId -> 422, title "InvalidPriceExceptionError"', async () => {
    const quote = await insertFreshDraftQuote();
    const serviceResult: QueryResult<{ id: string }> = await pool.query(`select id from catalog.services where code = $1`, [SERVICE_CODE_ST01]);
    const serviceId = (serviceResult.rows[0] as { id: string }).id;

    const result = await handleUpsertQuoteLine(
      requestWithKey({
        quoteId: quote.id,
        serviceId,
        qty: '1.000',
        unitPrice: '1.000',
        exceptionId: null,
        discountAmt: '0.000',
        expectedVersion: quote.version,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'InvalidPriceExceptionError' });
  });

  it('handleCreateQuote: an unqualified account (no cr_number) -> 422, title "AccountNotQualifiedError"', async () => {
    const unqualifiedResult: QueryResult<{ id: string }> = await pool.query(
      `insert into sales.accounts (code, name_ar, account_type, status) values ($1, $2, 'client', 'active') returning id`,
      [`_quote_handlers_unq_${randomUUID()}`, 'حساب اختبار غير مؤهَّل'],
    );
    const unqualifiedAccountId = (unqualifiedResult.rows[0] as { id: string }).id;
    extraAccountIds.push(unqualifiedAccountId);

    const result = await handleCreateQuote(
      requestWithKey({
        entityId,
        accountId: unqualifiedAccountId,
        opportunityId: null,
        validUntil: VALID_UNTIL,
        currency: CURRENCY_KWD,
        termsAr: null,
        termsEn: null,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'AccountNotQualifiedError' });
  });

  it('handleSubmitForReview: an illegal transition (e.g. already past draft) -> 422, title "IllegalTransitionError"', async () => {
    const quote = await insertFreshDraftQuote();
    // Force the quote past draft directly (admin pool) so SubmitForReview is illegal from here.
    await pool.query(`update sales.quotes set status = 'commercial_review' where id = $1`, [quote.id]);

    const result = await handleSubmitForReview(
      requestWithKey({ quoteId: quote.id, expectedVersion: quote.version, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'IllegalTransitionError' });
  });

  // Fix round 1 (pg-reviewer FAIL, finding 15): this fixture calls SendQuote on a still-DRAFT
  // quote. The machine (slice brief Master decision 1) has only ONE edge producing "sent" —
  // `approved --SEND_QUOTE--> sent` — draft has no SEND_QUOTE edge at all, so this is a plain
  // illegal transition, never the "already-frozen, steer to revise" QuoteFrozenError (that error is
  // reserved for a mutating command on an ALREADY sent/accepted/rejected/expired quote — decision
  // 10). Asserting the SPECIFIC error, not an either/or.
  it('handleSendQuote: a still-draft quote -> 422, title "IllegalTransitionError" (draft has no SEND_QUOTE edge)', async () => {
    const quote = await insertFreshDraftQuote();
    const result = await handleSendQuote(
      requestWithKey({ quoteId: quote.id, expectedVersion: quote.version, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'IllegalTransitionError' });
  });
});

describe('StaleVersionError maps to 409, title = error.name', () => {
  it('handleUpsertQuoteLine: a stale expectedVersion -> 409, title "StaleVersionError"', async () => {
    const quote = await insertFreshDraftQuote();
    const serviceResult: QueryResult<{ id: string }> = await pool.query(`select id from catalog.services where code = $1`, [SERVICE_CODE_ST01]);
    const serviceId = (serviceResult.rows[0] as { id: string }).id;

    const result = await handleUpsertQuoteLine(
      requestWithKey({
        quoteId: quote.id,
        serviceId,
        qty: '1.000',
        unitPrice: HEALTHY_PRICE,
        exceptionId: null,
        discountAmt: '0.000',
        expectedVersion: quote.version + 999,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'StaleVersionError' });
  });
});

// --- Idempotency-Key REPLAY --------------------------------------------------------------------

describe('the same Idempotency-Key and body twice: the second response equals the first', () => {
  it('handleCreateQuote: identical key + body -> identical response, one row inserted', async () => {
    const freshAccountId = await insertFreshQualifiedAccount();
    const idempotencyKey = randomUUID();
    const body = {
      entityId,
      accountId: freshAccountId,
      opportunityId: null,
      validUntil: VALID_UNTIL,
      currency: CURRENCY_KWD,
      termsAr: null,
      termsEn: null,
      correlationId: randomUUID(),
    };

    const first = await handleCreateQuote(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);
    if (first.status === 200) extraQuoteIds.push((first.body as { quoteId: string }).quoteId);

    const second = await handleCreateQuote(requestWithKey(body, idempotencyKey), deps);
    expect(second).toEqual(first);

    const countResult: QueryResult<{ n: string }> = await pool.query(`select count(*)::text as n from sales.quotes where account_id = $1`, [
      freshAccountId,
    ]);
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(1);
  });

  it('handleCreateQuote: the same key with a DIFFERENT body -> 409 IdempotencyConflictError', async () => {
    const freshAccountId = await insertFreshQualifiedAccount();
    const idempotencyKey = randomUUID();
    const body = {
      entityId,
      accountId: freshAccountId,
      opportunityId: null,
      validUntil: VALID_UNTIL,
      currency: CURRENCY_KWD,
      termsAr: null,
      termsEn: null,
      correlationId: randomUUID(),
    };

    const first = await handleCreateQuote(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);
    if (first.status === 200) extraQuoteIds.push((first.body as { quoteId: string }).quoteId);

    const differentBody = { ...body, correlationId: randomUUID(), validUntil: '2027-01-01' };
    const result = await handleCreateQuote(requestWithKey(differentBody, idempotencyKey), deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'IdempotencyConflictError' });
  });
});

// --- Unknown (500) error is logged, never sent to the client ------------------------------------

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleApproveFinance: an unexpected repository failure -> 500, generic detail, logger.error called once', async () => {
    const quote = await insertFreshDraftQuote();
    const logger = spyLogger();
    const depsWithSpyLogger = createManageQuoteDeps({ clock, ids, logger });
    const thrown = new TypeError('unexpected repository failure — never sent to the client');
    const brokenDeps = {
      ...depsWithSpyLogger,
      repo: {
        ...depsWithSpyLogger.repo,
        getQuoteForUpdate: async (): Promise<never> => {
          throw thrown;
        },
      },
    };
    const correlationId = randomUUID();

    const result = await handleApproveFinance(
      requestWithKey({ quoteId: quote.id, expectedVersion: quote.version, correlationId }),
      brokenDeps,
    );

    expect(result.status).toBe(500);
    expect('body' in result ? JSON.stringify(result.body) : '').not.toMatch(/unexpected repository failure/);

    expect(logger.errorCalls).toHaveLength(1);
    const [loggedObj] = logger.errorCalls[0] as [Record<string, unknown>, string];
    expect(loggedObj['correlationId']).toBe(correlationId);
    expect(loggedObj['err']).toBeInstanceOf(Error);
    expect(loggedObj['err']).toBe(thrown);
  });
});

// --- createManageQuoteDeps({ clock, ids, logger }) -----------------------------------------------

describe('createManageQuoteDeps accepts an injected logger', () => {
  it('deps.logger is the exact injected spy, not a default pino instance', () => {
    const logger = spyLogger();
    const injectedDeps = createManageQuoteDeps({ clock, ids, logger });
    expect(injectedDeps.logger).toBe(logger);
  });

  it('deps.logger defaults to a logger implementing the Logger port when none is injected', () => {
    const defaultDeps = createManageQuoteDeps({ clock, ids });
    expect(typeof defaultDeps.logger?.error).toBe('function');
    expect(typeof defaultDeps.logger?.info).toBe('function');
  });
});
