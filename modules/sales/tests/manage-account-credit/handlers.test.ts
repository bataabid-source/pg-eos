// modules/sales/tests/manage-account-credit/handlers.test.ts — WBS 1.8, M02 sales.
//
// The api layer's contract (modules/sales/api/manage-account-credit/handlers.ts), one test per
// mapping (slice brief Master decision 8, golden/manage-contract pattern):
//   - a missing Idempotency-Key -> 400 Problem;
//   - a Zod failure -> 400 (a negative creditLimit, an empty reason);
//   - StaleVersionError/IdempotencyConflictError -> 409;
//   - every other typed domain error (AccountNotFoundError, RoleRequiredError, NotOnHoldError,
//     MissingActorError) -> 422;
//   - an unknown error -> 500, logged once via deps.logger.error, never leaked to the client;
//   - a success call -> 200 with the command's own result.
// `title` is always `error.name` (golden convention).
//
// HANDLER NAMES (this file's own default, mirrors the golden `handle<Command>` convention):
//   handleSetCreditLimit, handleSetCreditHold, handleReleaseCreditHold.
// `getAccountCreditStatus` has NO handler — Master decision 5/brief: read-only, no Idempotency-Key
// (same as 1.7's `getContractForOrder`) — not tested here.
//
// CHOSEN RESULT SHAPES this suite binds to (pg-backend implements exactly these):
//   handleSetCreditLimit     -> 200 body { version: number }
//   handleSetCreditHold      -> 200 body { version: number }
//   handleReleaseCreditHold  -> 200 body { version: number }
//
// ERROR CLASSES this suite imports and asserts `instanceof`/`title` on (brief's literal list):
//   AccountNotFoundError, AccountOnCreditHoldError{accountId, reason}, NotOnHoldError,
//   RoleRequiredError, StaleVersionError, IdempotencyConflictError, MissingActorError.
//
// CHOSEN PORT NAME (pg-tester default, for the "unknown error" test's broken-deps override):
// `deps.repo.getAccountForUpdate` — mirrors manage-contract's `deps.repo.getContractForUpdate`.
//
// Fixture/RLS pattern: same admin-pool style as ./manage-account-credit.test.ts, deliberately
// minimal (one account, one CFO actor) — this file only exercises the API-mapping LAYER, not every
// business scenario (already covered by manage-account-credit.test.ts). platform.audit_log is
// never deleted. No outbox assertions — Master decision 9: "No outbox event this slice."

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';

import { createManageAccountCreditDeps } from '../../api/manage-account-credit/composition.js';
import type { Logger } from '../../application/manage-account-credit/ports.js';
// The module under test — does not exist yet (RED).
import {
  handleReleaseCreditHold,
  handleSetCreditHold,
  handleSetCreditLimit,
  type ApiRequest,
} from '../../api/manage-account-credit/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const ROLE_CFO = 'CFO';

const FIXTURE_CFO_ACTOR_UUID = '00000000-0000-4000-8000-000000018101';
const clock = new FixedClock(new Date('2026-09-24T00:00:00.000Z'));
const ids = new SequentialIdGenerator(18100);
const deps = createManageAccountCreditDeps({ clock, ids });
const ctx = { userId: FIXTURE_CFO_ACTOR_UUID, clientId: null, isInternal: true };

let accountId: string;
let accountVersion: number;
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

async function insertFreshAccount(): Promise<{ id: string; version: number }> {
  const result: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id, version`,
    [`_credit_handlers_${randomUUID()}`, 'حساب اختبار معالجات الائتمان'],
  );
  const row = result.rows[0] as { id: string; version: number };
  extraAccountIds.push(row.id);
  return row;
}

beforeAll(async () => {
  const account = await insertFreshAccount();
  accountId = account.id;
  accountVersion = account.version;

  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [FIXTURE_CFO_ACTOR_UUID, `_credit_handlers_actor_${randomUUID()}@test.invalid`, 'ممثل اختبار معالجات الائتمان'],
  );
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [ROLE_CFO]);
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [
    FIXTURE_CFO_ACTOR_UUID,
    (roleResult.rows[0] as { id: string }).id,
  ]);
});

afterAll(async () => {
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  if (accountId) await pool.query(`delete from sales.accounts where id = $1`, [accountId]);
  if (extraAccountIds.length > 0) await pool.query(`delete from sales.accounts where id = any($1::uuid[])`, [extraAccountIds]);
  await pool.end();
});

describe('a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('handleSetCreditLimit: no Idempotency-Key header -> 400', async () => {
    const result = await handleSetCreditLimit(
      requestWithoutKey({ accountId, creditLimit: '15000.000', expectedVersion: accountVersion, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });

  it('handleSetCreditHold: no Idempotency-Key header -> 400', async () => {
    const result = await handleSetCreditHold(
      requestWithoutKey({ accountId, reason: 'overdue', expectedVersion: accountVersion, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
  });

  it('handleReleaseCreditHold: no Idempotency-Key header -> 400', async () => {
    const result = await handleReleaseCreditHold(
      requestWithoutKey({ accountId, reason: 'cleared', expectedVersion: accountVersion, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
  });
});

describe('an invalid body is rejected with a 400 Problem', () => {
  it('handleSetCreditLimit: a body missing required fields -> 400, not a thrown exception', async () => {
    const result = await handleSetCreditLimit(requestWithKey({}), deps);
    expect(result.status).toBe(400);
  });

  it('handleSetCreditLimit: a negative creditLimit -> 400', async () => {
    const result = await handleSetCreditLimit(
      requestWithKey({ accountId, creditLimit: '-1.000', expectedVersion: accountVersion, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
  });

  it('handleSetCreditHold: an empty reason -> 400', async () => {
    const result = await handleSetCreditHold(
      requestWithKey({ accountId, reason: '', expectedVersion: accountVersion, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
  });

  it('handleReleaseCreditHold: an empty reason -> 400', async () => {
    const result = await handleReleaseCreditHold(
      requestWithKey({ accountId, reason: '', expectedVersion: accountVersion, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
  });
});

describe('a success call returns 200 with the command result', () => {
  it('handleSetCreditLimit: a valid body -> 200, body has version bumped', async () => {
    const account = await insertFreshAccount();
    const result = await handleSetCreditLimit(
      requestWithKey({ accountId: account.id, creditLimit: '5000.000', expectedVersion: account.version, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect((result.body as { version: number }).version).toBe(account.version + 1);
    }
  });
});

describe('every other typed domain error maps to 422, title = error.name (decision 8)', () => {
  it('handleSetCreditHold: a caller without role CFO/GM -> 422, title "RoleRequiredError"', async () => {
    const nonPrivilegedActorUuid = '00000000-0000-4000-8000-000000018199';
    await pool.query(`delete from identity.user_roles where user_id = $1`, [nonPrivilegedActorUuid]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [nonPrivilegedActorUuid]);
    await pool.query(`delete from identity.users where id = $1`, [nonPrivilegedActorUuid]);
    await pool.query(
      `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
      [nonPrivilegedActorUuid, `_credit_handlers_norole_${randomUUID()}@test.invalid`, 'ممثل اختبار بلا صلاحية'],
    );
    const account = await insertFreshAccount();
    const noRoleCtx = { userId: nonPrivilegedActorUuid, clientId: null, isInternal: true };
    const result = await handleSetCreditHold(
      { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() }, body: { accountId: account.id, reason: 'x', expectedVersion: account.version, correlationId: randomUUID() }, ctx: noRoleCtx },
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'RoleRequiredError' });

    await pool.query(`delete from identity.user_roles where user_id = $1`, [nonPrivilegedActorUuid]);
    await pool.query(`delete from identity.users where id = $1`, [nonPrivilegedActorUuid]);
  });

  it('handleReleaseCreditHold: releasing an account that is NOT on hold -> 422, title "NotOnHoldError"', async () => {
    const account = await insertFreshAccount();
    const result = await handleReleaseCreditHold(
      requestWithKey({ accountId: account.id, reason: 'cleared', expectedVersion: account.version, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'NotOnHoldError' });
  });

  it('handleSetCreditLimit: an unknown accountId -> 422, title "AccountNotFoundError"', async () => {
    const result = await handleSetCreditLimit(
      requestWithKey({ accountId: randomUUID(), creditLimit: '100.000', expectedVersion: 1, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'AccountNotFoundError' });
  });
});

describe('StaleVersionError maps to 409, title = error.name', () => {
  it('handleSetCreditLimit: a stale expectedVersion -> 409, title "StaleVersionError"', async () => {
    const account = await insertFreshAccount();
    const result = await handleSetCreditLimit(
      requestWithKey({ accountId: account.id, creditLimit: '100.000', expectedVersion: account.version + 999, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'StaleVersionError' });
  });
});

// --- Idempotency-Key REPLAY --------------------------------------------------------------------

describe('the same Idempotency-Key and body twice: the second response equals the first', () => {
  it('handleSetCreditLimit: identical key + body -> identical response, version bumped exactly once', async () => {
    const account = await insertFreshAccount();
    const idempotencyKey = randomUUID();
    const body = { accountId: account.id, creditLimit: '2000.000', expectedVersion: account.version, correlationId: randomUUID() };

    const first = await handleSetCreditLimit(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const second = await handleSetCreditLimit(requestWithKey(body, idempotencyKey), deps);
    expect(second).toEqual(first);

    const versionResult: QueryResult<{ version: number }> = await pool.query(`select version from sales.accounts where id = $1`, [account.id]);
    expect(versionResult.rows[0]?.version).toBe(account.version + 1);
  });

  it('handleSetCreditLimit: the same key with a DIFFERENT body -> 409 IdempotencyConflictError', async () => {
    const account = await insertFreshAccount();
    const idempotencyKey = randomUUID();
    const body = { accountId: account.id, creditLimit: '2000.000', expectedVersion: account.version, correlationId: randomUUID() };

    const first = await handleSetCreditLimit(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const differentBody = { ...body, creditLimit: '3000.000', correlationId: randomUUID() };
    const result = await handleSetCreditLimit(requestWithKey(differentBody, idempotencyKey), deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'IdempotencyConflictError' });
  });
});

// --- Unknown (500) error is logged, never sent to the client ------------------------------------

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleSetCreditLimit: an unexpected repository failure -> 500, generic detail, logger.error called once', async () => {
    const account = await insertFreshAccount();
    const logger = spyLogger();
    const depsWithSpyLogger = createManageAccountCreditDeps({ clock, ids, logger });
    const thrown = new TypeError('unexpected repository failure — never sent to the client');
    const brokenDeps = {
      ...depsWithSpyLogger,
      repo: {
        ...depsWithSpyLogger.repo,
        getAccountForUpdate: async (): Promise<never> => {
          throw thrown;
        },
      },
    };
    const correlationId = randomUUID();

    const result = await handleSetCreditLimit(
      requestWithKey({ accountId: account.id, creditLimit: '100.000', expectedVersion: account.version, correlationId }),
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

// --- createManageAccountCreditDeps({ clock, ids, logger }) --------------------------------------

describe('createManageAccountCreditDeps accepts an injected logger', () => {
  it('deps.logger is the exact injected spy, not a default pino instance', () => {
    const logger = spyLogger();
    const injectedDeps = createManageAccountCreditDeps({ clock, ids, logger });
    expect(injectedDeps.logger).toBe(logger);
  });

  it('deps.logger defaults to a logger implementing the Logger port when none is injected', () => {
    const defaultDeps = createManageAccountCreditDeps({ clock, ids });
    expect(typeof defaultDeps.logger?.error).toBe('function');
    expect(typeof defaultDeps.logger?.info).toBe('function');
  });
});
