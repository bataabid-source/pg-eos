// modules/sales/tests/manage-contract/handlers.test.ts — WBS 1.7, M02 sales.
//
// The api layer's contract (modules/sales/api/manage-contract/handlers.ts), one test per mapping
// (slice brief Master decision 13, golden pattern):
//   - a missing Idempotency-Key -> 400 Problem;
//   - a Zod failure -> 400 (including AddContractSlaInputSchema's `metric` enum rejection — the
//     Gherkin "unrecognised SLA metric ... rejected at the contract (400)" scenario, asserted here
//     at the HTTP-status level);
//   - StaleVersionError/IdempotencyConflictError -> 409;
//   - every other typed domain error (ContractNotPriceableError, PriceListNotApplicableError,
//     ContractNotYetExpirableError, SlaNotEnabledError, IllegalTransitionError,
//     AccountNotQualifiedError, ContractNotFoundError, ...) -> 422;
//   - an unknown error -> 500, logged once via deps.logger.error, never leaked to the client;
//   - a success call -> 200 with the command's own result.
// `title` is always `error.name` (golden convention, unchanged here).
//
// HANDLER NAMES (mirrors the golden `handle<Command>` convention — this file's own default):
// handleCreateContract, handleSignContract, handleSetContractPriceList, handleActivateContract,
// handleSuspendContract, handleResumeContract, handleExpireContract, handleAddContractSla.
// `getContractForOrder` has NO handler — Master decision 10: "makes NO write", not a write endpoint,
// carries no Idempotency-Key.
//
// CHOSEN PORT NAME (pg-tester default, for the "unknown error" test's broken-deps override):
// `deps.repo.getContractForUpdate` — mirrors manage-quote's `deps.repo.getQuoteForUpdate` /
// the golden `deps.repo.getOrderForUpdate`.
//
// Fixture/RLS pattern: same admin-pool style as ./manage-contract.test.ts, deliberately minimal (one
// qualified account, one draft contract, one CFO actor) — this file only exercises the API-mapping
// LAYER. platform.audit_log is never deleted.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';

import { createManageContractDeps } from '../../api/manage-contract/composition.js';
import type { Logger } from '../../application/manage-contract/ports.js';
import {
  handleActivateContract,
  handleAddContractSla,
  handleCreateContract,
  handleSetContractPriceList,
  handleSignContract,
  type ApiRequest,
} from '../../api/manage-contract/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const ENTITY_CODE_PST = 'PST';
const ROLE_CFO = 'CFO';
const TODAY_ISO = '2026-09-24';
const SLA_TARGET_VALUE = '95.000';

const FIXTURE_CFO_ACTOR_UUID = '00000000-0000-4000-8000-000000017101';
const clock = new FixedClock(new Date('2026-09-24T00:00:00.000Z'));
const ids = new SequentialIdGenerator(17100);
const deps = createManageContractDeps({ clock, ids });
const ctx = { userId: FIXTURE_CFO_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
let accountId: string;
let draftContractId: string;
let draftContractVersion: number;
const extraContractIds: string[] = [];
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
    [`_contract_handlers_${randomUUID()}`, 'حساب اختبار معالجات العقود', `CR-${randomUUID().slice(0, 8)}`],
  );
  const row = result.rows[0] as { id: string };
  extraAccountIds.push(row.id);
  return row.id;
}

async function insertFreshDraftContract(): Promise<{ id: string; version: number }> {
  const acc = await insertFreshQualifiedAccount();
  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(`select platform.next_doc_no($1, 'CTR') as doc_no`, [entityId]);
  const result: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into sales.contracts (entity_id, doc_no, account_id, title, start_date, status)
     values ($1, $2, $3, $4, $5, 'draft') returning id, version`,
    [entityId, (docNoResult.rows[0] as { doc_no: string }).doc_no, acc, 'عقد اختبار معالجات', TODAY_ISO],
  );
  const row = result.rows[0] as { id: string; version: number };
  extraContractIds.push(row.id);
  return row;
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, [ENTITY_CODE_PST]);
  entityId = (entityResult.rows[0] as { id: string }).id;

  accountId = await insertFreshQualifiedAccount();

  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(`select platform.next_doc_no($1, 'CTR') as doc_no`, [entityId]);
  const contractResult: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into sales.contracts (entity_id, doc_no, account_id, title, start_date, status)
     values ($1, $2, $3, $4, $5, 'draft') returning id, version`,
    [entityId, (docNoResult.rows[0] as { doc_no: string }).doc_no, accountId, 'عقد اختبار معالجات — أساسي', TODAY_ISO],
  );
  draftContractId = (contractResult.rows[0] as { id: string; version: number }).id;
  draftContractVersion = (contractResult.rows[0] as { id: string; version: number }).version;

  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [FIXTURE_CFO_ACTOR_UUID, `_contract_handlers_actor_${randomUUID()}@test.invalid`, 'ممثل اختبار معالجات العقود'],
  );
  await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [FIXTURE_CFO_ACTOR_UUID, entityId]);
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [ROLE_CFO]);
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [
    FIXTURE_CFO_ACTOR_UUID,
    (roleResult.rows[0] as { id: string }).id,
  ]);
});

afterAll(async () => {
  if (draftContractId) {
    await pool.query(`delete from sales.contract_sla where contract_id = $1`, [draftContractId]);
    await pool.query(`delete from sales.contracts where id = $1`, [draftContractId]);
  }
  if (extraContractIds.length > 0) {
    await pool.query(`delete from sales.contract_sla where contract_id = any($1::uuid[])`, [extraContractIds]);
    await pool.query(`delete from sales.contracts where id = any($1::uuid[])`, [extraContractIds]);
  }
  if (accountId) await pool.query(`delete from sales.accounts where id = $1`, [accountId]);
  if (extraAccountIds.length > 0) await pool.query(`delete from sales.accounts where id = any($1::uuid[])`, [extraAccountIds]);

  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.end();
});

describe('a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('handleCreateContract: no Idempotency-Key header -> 400', async () => {
    const result = await handleCreateContract(
      requestWithoutKey({
        entityId,
        accountId,
        quoteId: null,
        title: 'عقد اختبار',
        startDate: TODAY_ISO,
        endDate: null,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });
});

describe('an invalid body is rejected with a 400 Problem', () => {
  it('handleCreateContract: a body missing required fields -> 400, not a thrown exception', async () => {
    const result = await handleCreateContract(requestWithKey({}), deps);
    expect(result.status).toBe(400);
  });

  it('handleSetContractPriceList: a non-uuid priceListId -> 400', async () => {
    const result = await handleSetContractPriceList(
      requestWithKey({
        contractId: draftContractId,
        expectedVersion: draftContractVersion,
        priceListId: 'not-a-uuid',
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(400);
  });

  it('handleAddContractSla: an unrecognised metric -> 400 (Gherkin: "rejected at the contract (400)")', async () => {
    const contract = await insertFreshDraftContract();
    const result = await handleAddContractSla(
      requestWithKey({
        contractId: contract.id,
        expectedVersion: contract.version,
        metric: 'not_a_real_metric',
        targetValue: SLA_TARGET_VALUE,
        direction: 'min',
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(400);
  });
});

describe('a success call returns 200 with the command result', () => {
  it('handleCreateContract: a valid body -> 200, body has contractId and version 1', async () => {
    const freshAccountId = await insertFreshQualifiedAccount();
    const result = await handleCreateContract(
      requestWithKey({
        entityId,
        accountId: freshAccountId,
        quoteId: null,
        title: 'عقد اختبار — نجاح',
        startDate: TODAY_ISO,
        endDate: null,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect((result.body as { version: number }).version).toBe(1);
      const contractId = (result.body as { contractId: string }).contractId;
      extraContractIds.push(contractId);
    }
  });
});

describe('every other typed domain error maps to 422, title = error.name (decision 13)', () => {
  it('handleActivateContract: no price_list_id set -> 422, title "ContractNotPriceableError"', async () => {
    const contract = await insertFreshDraftContract();
    const signed = await handleSignContract(
      requestWithKey({ contractId: contract.id, expectedVersion: contract.version, signedByClient: 'x', correlationId: randomUUID() }),
      deps,
    );
    expect(signed.status).toBe(200);
    const signedVersion = signed.status === 200 ? (signed.body as { version: number }).version : contract.version;

    const result = await handleActivateContract(
      requestWithKey({ contractId: contract.id, expectedVersion: signedVersion, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'ContractNotPriceableError' });
  });

  it('handleCreateContract: an unqualified account (no cr_number) -> 422, title "AccountNotQualifiedError"', async () => {
    const unqualifiedResult: QueryResult<{ id: string }> = await pool.query(
      `insert into sales.accounts (code, name_ar, account_type, status) values ($1, $2, 'client', 'active') returning id`,
      [`_contract_handlers_unq_${randomUUID()}`, 'حساب اختبار غير مؤهَّل'],
    );
    const unqualifiedAccountId = (unqualifiedResult.rows[0] as { id: string }).id;
    extraAccountIds.push(unqualifiedAccountId);

    const result = await handleCreateContract(
      requestWithKey({
        entityId,
        accountId: unqualifiedAccountId,
        quoteId: null,
        title: 'عقد اختبار غير مؤهَّل',
        startDate: TODAY_ISO,
        endDate: null,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'AccountNotQualifiedError' });
  });

  it('handleActivateContract: an illegal transition (still draft, never signed) -> 422, title "IllegalTransitionError"', async () => {
    const contract = await insertFreshDraftContract();
    const result = await handleActivateContract(
      requestWithKey({ contractId: contract.id, expectedVersion: contract.version, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'IllegalTransitionError' });
  });
});

describe('StaleVersionError maps to 409, title = error.name', () => {
  it('handleSignContract: a stale expectedVersion -> 409, title "StaleVersionError"', async () => {
    const contract = await insertFreshDraftContract();

    const result = await handleSignContract(
      requestWithKey({
        contractId: contract.id,
        expectedVersion: contract.version + 999,
        signedByClient: 'x',
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
  it('handleCreateContract: identical key + body -> identical response, one row inserted', async () => {
    const freshAccountId = await insertFreshQualifiedAccount();
    const idempotencyKey = randomUUID();
    const body = {
      entityId,
      accountId: freshAccountId,
      quoteId: null,
      title: 'عقد اختبار — إعادة',
      startDate: TODAY_ISO,
      endDate: null,
      correlationId: randomUUID(),
    };

    const first = await handleCreateContract(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);
    if (first.status === 200) extraContractIds.push((first.body as { contractId: string }).contractId);

    const second = await handleCreateContract(requestWithKey(body, idempotencyKey), deps);
    expect(second).toEqual(first);

    const countResult: QueryResult<{ n: string }> = await pool.query(`select count(*)::text as n from sales.contracts where account_id = $1`, [
      freshAccountId,
    ]);
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(1);
  });

  it('handleCreateContract: the same key with a DIFFERENT body -> 409 IdempotencyConflictError', async () => {
    const freshAccountId = await insertFreshQualifiedAccount();
    const idempotencyKey = randomUUID();
    const body = {
      entityId,
      accountId: freshAccountId,
      quoteId: null,
      title: 'عقد اختبار — إعادة مختلفة',
      startDate: TODAY_ISO,
      endDate: null,
      correlationId: randomUUID(),
    };

    const first = await handleCreateContract(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);
    if (first.status === 200) extraContractIds.push((first.body as { contractId: string }).contractId);

    const differentBody = { ...body, correlationId: randomUUID(), title: 'عنوان مختلف تماماً' };
    const result = await handleCreateContract(requestWithKey(differentBody, idempotencyKey), deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'IdempotencyConflictError' });
  });
});

// --- Unknown (500) error is logged, never sent to the client ------------------------------------

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleSignContract: an unexpected repository failure -> 500, generic detail, logger.error called once', async () => {
    const contract = await insertFreshDraftContract();
    const logger = spyLogger();
    const depsWithSpyLogger = createManageContractDeps({ clock, ids, logger });
    const thrown = new TypeError('unexpected repository failure — never sent to the client');
    const brokenDeps = {
      ...depsWithSpyLogger,
      repo: {
        ...depsWithSpyLogger.repo,
        getContractForUpdate: async (): Promise<never> => {
          throw thrown;
        },
      },
    };
    const correlationId = randomUUID();

    const result = await handleSignContract(
      requestWithKey({ contractId: contract.id, expectedVersion: contract.version, signedByClient: 'x', correlationId }),
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

// --- createManageContractDeps({ clock, ids, logger }) --------------------------------------------

describe('createManageContractDeps accepts an injected logger', () => {
  it('deps.logger is the exact injected spy, not a default pino instance', () => {
    const logger = spyLogger();
    const injectedDeps = createManageContractDeps({ clock, ids, logger });
    expect(injectedDeps.logger).toBe(logger);
  });

  it('deps.logger defaults to a logger implementing the Logger port when none is injected', () => {
    const defaultDeps = createManageContractDeps({ clock, ids });
    expect(typeof defaultDeps.logger?.error).toBe('function');
    expect(typeof defaultDeps.logger?.info).toBe('function');
  });
});
