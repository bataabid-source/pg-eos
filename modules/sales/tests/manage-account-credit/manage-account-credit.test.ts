// modules/sales/tests/manage-account-credit/manage-account-credit.test.ts — WBS 1.8, M02 sales.
//
// Integration tests, one `it` per scenario in ./manage-account-credit.feature (17 scenarios),
// against the real database as pgeos_app (PG_APP_USER=pgeos_app REQUIRED). Sources:
// docs/notes/slice-briefs/_slice-1.8.brief.md ("Master decisions" 1-10), database/schema/01-Data-
// Model.sql:420-444 (sales.accounts — the ONLY columns that exist: credit_limit, credit_hold,
// hold_reason, hold_set_by, hold_set_at, version — no entity_id).
//
// CHOSEN RESULT SHAPES (pg-backend implements exactly these — brief instruction; every field not
// pinned literally by the brief is this file's own DEFAULT, reported as an open question below):
//   setCreditLimit(ctx, input, deps)          -> Promise<{ version: number }>                 [DEFAULT]
//   setCreditHold(ctx, input, deps)            -> Promise<{ version: number }>                 [DEFAULT]
//   releaseCreditHold(ctx, input, deps)        -> Promise<{ version: number }>                 [DEFAULT]
//   getAccountCreditStatus(ctx, input, deps)   -> Promise<{ accountId: string; creditLimit: string;
//                                                 creditHold: false }> when NOT on hold (Master
//                                                 decision 5, literal); throws
//                                                 AccountOnCreditHoldError{accountId, reason} when
//                                                 on hold; AccountNotFoundError when not visible.
// Every write command's input carries `accountId`, `expectedVersion`, `correlationId`;
// `idem?: IdempotencyInput` is an optional extra field (golden pattern, reused from
// manage-contract/manage-quote). `getAccountCreditStatus`'s input is `{ accountId }` ONLY — no
// `entityId` parameter anywhere in this slice (Scope: "genuinely group-level, not entity-scoped").
//
// ERROR CLASSES this suite imports and asserts `instanceof` on (brief's literal "Declare in
// file-top comments" list):
//   AccountNotFoundError, AccountOnCreditHoldError{accountId, reason}, NotOnHoldError,
//   RoleRequiredError, StaleVersionError, IdempotencyConflictError, MissingActorError.
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only) plus real
// identity.users/user_entities/user_roles rows, same shape as
// modules/sales/tests/manage-contract/manage-contract.test.ts. sales.accounts carries no
// entity_id column at all (RLS: 01-Data-Model.sql:1486-1489 — `client_portal_scope` `for select`
// using `platform.is_internal() or id = platform.current_client_id()`) — the "four entity
// contexts" scenario (S6) is proven by four DIFFERENT internal actors, each scoped via
// identity.user_entities to exactly ONE of PST/PDL/PCC/POR, all seeing the SAME rejection — the
// guard itself never reads `entity_id` (there is none). afterAll deletes respect FK order:
// platform.idempotency_keys (FKs identity.users) -> identity.user_roles -> identity.user_entities
// -> identity.users, then sales.accounts (the fixture account is scoped narrowly — no other
// fixture in this file references it via FK) — the exact bug class WBS 1.6/1.7's reviews caught.
// platform.audit_log rows are NEVER deleted. No outbox assertions — Master decision 9: "No outbox
// event this slice."

import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import type { IdempotencyInput } from '@pg-eos/db';
import { IdempotencyConflictError } from '@pg-eos/db';

import {
  getAccountCreditStatus,
  releaseCreditHold,
  setCreditHold,
  setCreditLimit,
} from '../../application/manage-account-credit/index.js';
import { createManageAccountCreditDeps } from '../../api/manage-account-credit/composition.js';
import {
  AccountNotFoundError,
  AccountOnCreditHoldError,
  MissingActorError,
  NotOnHoldError,
  RoleRequiredError,
  StaleVersionError,
} from '../../domain/manage-account-credit/errors.js';
// The package subpath export (@pg-eos/contracts/sales/manage-account-credit) — used ONLY for the
// contract-boundary (Zod) assertions below (negative creditLimit / empty reason "rejected at the
// contract (400)" scenarios), mirroring manage-contract's own precedent.
import { SetCreditHoldInputSchema, SetCreditLimitInputSchema } from '@pg-eos/contracts/sales/manage-account-credit';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

// --- literals, each cited to the schema fact, decision or brief line they come from -------------

const ROLE_CFO = 'CFO';
const ROLE_GM = 'GM';
const ROLE_SALES_REP = 'SALES_REP';

const CFO_ACTOR_UUID = '00000000-0000-4000-8000-000000018001';
const GM_ACTOR_UUID = '00000000-0000-4000-8000-000000018002';
const SALES_REP_ACTOR_UUID = '00000000-0000-4000-8000-000000018003';
const PST_ACTOR_UUID = '00000000-0000-4000-8000-000000018011';
const PDL_ACTOR_UUID = '00000000-0000-4000-8000-000000018012';
const PCC_ACTOR_UUID = '00000000-0000-4000-8000-000000018013';
const POR_ACTOR_UUID = '00000000-0000-4000-8000-000000018014';
// RLS: no identity.user_entities/user_roles row anywhere for this actor, and clientId points at a
// DIFFERENT account than the fixture — the client_portal_scope SELECT policy denies visibility.
const OUTSIDER_ACTOR_UUID = '00000000-0000-4000-8000-000000018099';
// RLS boundary (migration 0021): this actor's own clientId IS the fixture account's own id — the
// client_portal_scope SELECT policy grants READ visibility, but the write path's own internal_only
// policy still denies WRITE (isInternal: false) — distinct from OUTSIDER_ACTOR_UUID above, which
// cannot see the row AT ALL.
const PORTAL_CLIENT_ACTOR_UUID = '00000000-0000-4000-8000-000000018098';

const clock = new FixedClock(new Date('2026-09-24T00:00:00.000Z'));
const ids = new SequentialIdGenerator(1800);
const deps = createManageAccountCreditDeps({ clock, ids });

const cfoCtx = { userId: CFO_ACTOR_UUID, clientId: null, isInternal: true };
const gmCtx = { userId: GM_ACTOR_UUID, clientId: null, isInternal: true };
const salesRepCtx = { userId: SALES_REP_ACTOR_UUID, clientId: null, isInternal: true };

const CREDIT_LIMIT_15000 = '15000.000';
const CREDIT_LIMIT_ZERO = '0.000'; // S7 trial-client case (Master decision 5).
const HOLD_REASON_OVERDUE = 'overdue PST invoice above limit';
const HOLD_REASON_A = 'A';
const HOLD_REASON_B = 'B';
const RELEASE_REASON_GM = 'payment received, exposure cleared';

const fixtureAccountIds: string[] = [];
const fixtureActorIds: string[] = [
  CFO_ACTOR_UUID,
  GM_ACTOR_UUID,
  SALES_REP_ACTOR_UUID,
  PST_ACTOR_UUID,
  PDL_ACTOR_UUID,
  PCC_ACTOR_UUID,
  POR_ACTOR_UUID,
  OUTSIDER_ACTOR_UUID,
  PORTAL_CLIENT_ACTOR_UUID,
];

function nextCorrelationId(): string {
  return randomUUID();
}

/** sha256 hex of the JSON body — mirrors `withIdempotentContext`'s own hash (golden pattern). */
function idemFor(endpoint: string, key: string, body: unknown): IdempotencyInput {
  return {
    key,
    endpoint: `sales.manage-account-credit.${endpoint}`,
    requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    entityId: null,
    successStatus: 200,
  };
}

async function insertFixtureAccount(): Promise<{ id: string; version: number }> {
  const result: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id, version`,
    [`_credit_fixture_acc_${randomUUID()}`, 'حساب اختبار الائتمان — WBS 1.8'],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture sales.accounts insert returned no row');
  fixtureAccountIds.push(row.id);
  return row;
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
    [userId, `_credit_fixture_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار الائتمان — WBS 1.8'],
  );
  for (const eid of entityIds) {
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, eid]);
  }
}

async function getAccount(accountId: string): Promise<{
  credit_limit: string;
  credit_hold: boolean;
  hold_reason: string | null;
  hold_set_by: string | null;
  hold_set_at: Date | null;
  version: number;
}> {
  const result: QueryResult<{
    credit_limit: string;
    credit_hold: boolean;
    hold_reason: string | null;
    hold_set_by: string | null;
    hold_set_at: Date | null;
    version: number;
  }> = await pool.query(
    `select credit_limit::text as credit_limit, credit_hold, hold_reason, hold_set_by::text as hold_set_by,
            hold_set_at, version
       from sales.accounts where id = $1`,
    [accountId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no sales.accounts row for id ${accountId}`);
  return row;
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

let entityIdPst: string;
let entityIdPdl: string;
let entityIdPcc: string;
let entityIdPor: string;

beforeAll(async () => {
  const entitiesResult: QueryResult<{ id: string; code: string }> = await pool.query(
    `select id, code from platform.entities where code in ('PST','PDL','PCC','POR')`,
  );
  const byCode = new Map(entitiesResult.rows.map((r) => [r.code, r.id]));
  entityIdPst = byCode.get('PST') ?? (() => { throw new Error('platform.entities: PST not found'); })();
  entityIdPdl = byCode.get('PDL') ?? (() => { throw new Error('platform.entities: PDL not found'); })();
  entityIdPcc = byCode.get('PCC') ?? (() => { throw new Error('platform.entities: PCC not found'); })();
  entityIdPor = byCode.get('POR') ?? (() => { throw new Error('platform.entities: POR not found'); })();

  await createFixtureActor(CFO_ACTOR_UUID, [entityIdPst]);
  await grantRole(CFO_ACTOR_UUID, ROLE_CFO);
  await createFixtureActor(GM_ACTOR_UUID, [entityIdPst]);
  await grantRole(GM_ACTOR_UUID, ROLE_GM);
  await createFixtureActor(SALES_REP_ACTOR_UUID, [entityIdPst]);
  await grantRole(SALES_REP_ACTOR_UUID, ROLE_SALES_REP);

  await createFixtureActor(PST_ACTOR_UUID, [entityIdPst]);
  await createFixtureActor(PDL_ACTOR_UUID, [entityIdPdl]);
  await createFixtureActor(PCC_ACTOR_UUID, [entityIdPcc]);
  await createFixtureActor(POR_ACTOR_UUID, [entityIdPor]);

  // Deliberately NO identity.user_entities row for OUTSIDER_ACTOR_UUID — RLS scenario.
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [OUTSIDER_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [OUTSIDER_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [OUTSIDER_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [OUTSIDER_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [OUTSIDER_ACTOR_UUID, `_credit_fixture_outsider_${randomUUID()}@test.invalid`, 'ممثل اختبار بلا رؤية — WBS 1.8'],
  );

  // Deliberately a portal (non-internal) user — used only with ctx.isInternal=false and
  // ctx.clientId set to a fixture account's own id per-test (see the RLS boundary describe block).
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [PORTAL_CLIENT_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [PORTAL_CLIENT_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [PORTAL_CLIENT_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [PORTAL_CLIENT_ACTOR_UUID]);
  // user_type stays the identity.users default ('internal') — platform.is_internal() reads ONLY
  // the ctx.isInternal session GUC (01-Data-Model.sql:39), never this column, so it is irrelevant
  // to the RLS boundary this actor exercises; ctx.isInternal=false is what governs below.
  await pool.query(
    `insert into identity.users (id, email, full_name_ar) values ($1, $2, $3)`,
    [PORTAL_CLIENT_ACTOR_UUID, `_credit_fixture_portal_${randomUUID()}@test.invalid`, 'عميل بوابة اختبار الائتمان — WBS 1.8'],
  );
});

afterAll(async () => {
  if (fixtureAccountIds.length > 0) {
    await pool.query(`delete from sales.accounts where id = any($1::uuid[])`, [fixtureAccountIds]);
  }
  for (const userId of fixtureActorIds) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
});

describe('Set the group-level credit limit', () => {
  it('SetCreditLimit for a fresh account with creditLimit 15000.000 -> credit_limit 15000.000, version bumped', async () => {
    const account = await insertFixtureAccount();
    const result = await setCreditLimit(
      cfoCtx,
      { accountId: account.id, creditLimit: CREDIT_LIMIT_15000, expectedVersion: account.version, correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.version).toBe(account.version + 1);
    const row = await getAccount(account.id);
    expect(row.credit_limit).toBe(CREDIT_LIMIT_15000);
    expect(row.version).toBe(account.version + 1);
  });
});

describe('A zero credit limit is legal (S7 trial-client case)', () => {
  it('SetCreditLimit with creditLimit 0 succeeds, credit_limit is 0.000', async () => {
    const account = await insertFixtureAccount();
    const result = await setCreditLimit(
      cfoCtx,
      { accountId: account.id, creditLimit: CREDIT_LIMIT_ZERO, expectedVersion: account.version, correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.version).toBe(account.version + 1);
    const row = await getAccount(account.id);
    expect(row.credit_limit).toBe(CREDIT_LIMIT_ZERO);
  });
});

describe('A negative credit limit is rejected', () => {
  it('SetCreditLimitInputSchema.parse rejects creditLimit -1 at the contract (400)', () => {
    expect(() =>
      SetCreditLimitInputSchema.parse({
        accountId: randomUUID(),
        creditLimit: '-1',
        expectedVersion: 1,
        correlationId: randomUUID(),
      }),
    ).toThrow();
  });
});

describe('CFO places a hold with a reason', () => {
  it('SetCreditHold by the CFO -> credit_hold true, hold_reason matches, hold_set_by is the CFO, hold_set_at set', async () => {
    const account = await insertFixtureAccount();
    const result = await setCreditHold(
      cfoCtx,
      { accountId: account.id, reason: HOLD_REASON_OVERDUE, expectedVersion: account.version, correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.version).toBe(account.version + 1);
    const row = await getAccount(account.id);
    expect(row.credit_hold).toBe(true);
    expect(row.hold_reason).toBe(HOLD_REASON_OVERDUE);
    expect(row.hold_set_by).toBe(CFO_ACTOR_UUID);
    expect(row.hold_set_at).not.toBeNull();
  });
});

describe('A non-CFO/GM cannot place a hold', () => {
  it('SetCreditHold by the SALES_REP is rejected with RoleRequiredError', async () => {
    const account = await insertFixtureAccount();
    await expectRejectsWith(
      setCreditHold(
        salesRepCtx,
        { accountId: account.id, reason: HOLD_REASON_OVERDUE, expectedVersion: account.version, correlationId: nextCorrelationId() },
        deps,
      ),
      RoleRequiredError,
    );
  });
});

describe('A hold reason is required', () => {
  it('SetCreditHoldInputSchema.parse rejects an empty reason at the contract (400)', () => {
    expect(() =>
      SetCreditHoldInputSchema.parse({
        accountId: randomUUID(),
        reason: '',
        expectedVersion: 1,
        correlationId: randomUUID(),
      }),
    ).toThrow();
  });
});

describe('The guard blocks the account the SAME way from all four entity contexts (S6, the acceptance line)', () => {
  it('getAccountCreditStatus rejects identically under PST, PDL, PCC and POR contexts — it never consults entity at all', async () => {
    const account = await insertFixtureAccount();
    await setCreditHold(
      cfoCtx,
      { accountId: account.id, reason: HOLD_REASON_OVERDUE, expectedVersion: account.version, correlationId: nextCorrelationId() },
      deps,
    );

    const contexts = [
      { userId: PST_ACTOR_UUID, clientId: null, isInternal: true },
      { userId: PDL_ACTOR_UUID, clientId: null, isInternal: true },
      { userId: PCC_ACTOR_UUID, clientId: null, isInternal: true },
      { userId: POR_ACTOR_UUID, clientId: null, isInternal: true },
    ];

    for (const entityCtx of contexts) {
      const error = await expectRejectsWith(
        getAccountCreditStatus(entityCtx, { accountId: account.id }, deps),
        AccountOnCreditHoldError,
      );
      expect(error.accountId).toBe(account.id);
      expect(error.reason).toBe(HOLD_REASON_OVERDUE);
    }
  });
});

describe('The guard passes when there is no hold', () => {
  it('getAccountCreditStatus returns { accountId, creditLimit, creditHold: false }', async () => {
    const account = await insertFixtureAccount();
    await setCreditLimit(
      cfoCtx,
      { accountId: account.id, creditLimit: CREDIT_LIMIT_15000, expectedVersion: account.version, correlationId: nextCorrelationId() },
      deps,
    );

    const result = await getAccountCreditStatus(cfoCtx, { accountId: account.id }, deps);
    expect(result).toEqual({ accountId: account.id, creditLimit: CREDIT_LIMIT_15000, creditHold: false });
  });
});

describe('Only GM or CFO can release a hold', () => {
  it('ReleaseCreditHold by the SALES_REP is rejected with RoleRequiredError', async () => {
    const account = await insertFixtureAccount();
    await setCreditHold(
      cfoCtx,
      { accountId: account.id, reason: HOLD_REASON_OVERDUE, expectedVersion: account.version, correlationId: nextCorrelationId() },
      deps,
    );
    const held = await getAccount(account.id);
    await expectRejectsWith(
      releaseCreditHold(
        salesRepCtx,
        { accountId: account.id, reason: RELEASE_REASON_GM, expectedVersion: held.version, correlationId: nextCorrelationId() },
        deps,
      ),
      RoleRequiredError,
    );
  });
});

describe('GM releases a hold with a reason', () => {
  it('ReleaseCreditHold by the GM -> credit_hold false, hold_reason matches the release reason, hold_set_by is the GM', async () => {
    const account = await insertFixtureAccount();
    await setCreditHold(
      cfoCtx,
      { accountId: account.id, reason: HOLD_REASON_OVERDUE, expectedVersion: account.version, correlationId: nextCorrelationId() },
      deps,
    );
    const held = await getAccount(account.id);

    const result = await releaseCreditHold(
      gmCtx,
      { accountId: account.id, reason: RELEASE_REASON_GM, expectedVersion: held.version, correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.version).toBe(held.version + 1);
    const row = await getAccount(account.id);
    expect(row.credit_hold).toBe(false);
    expect(row.hold_reason).toBe(RELEASE_REASON_GM);
    expect(row.hold_set_by).toBe(GM_ACTOR_UUID);
  });
});

describe('CFO can also release a hold', () => {
  it('ReleaseCreditHold by the CFO succeeds', async () => {
    const account = await insertFixtureAccount();
    await setCreditHold(
      cfoCtx,
      { accountId: account.id, reason: HOLD_REASON_OVERDUE, expectedVersion: account.version, correlationId: nextCorrelationId() },
      deps,
    );
    const held = await getAccount(account.id);

    const result = await releaseCreditHold(
      cfoCtx,
      { accountId: account.id, reason: RELEASE_REASON_GM, expectedVersion: held.version, correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.version).toBe(held.version + 1);
    const row = await getAccount(account.id);
    expect(row.credit_hold).toBe(false);
  });
});

describe("Releasing a hold that isn't there is rejected", () => {
  it('ReleaseCreditHold on an account NOT on hold is rejected with NotOnHoldError', async () => {
    const account = await insertFixtureAccount();
    await expectRejectsWith(
      releaseCreditHold(
        cfoCtx,
        { accountId: account.id, reason: RELEASE_REASON_GM, expectedVersion: account.version, correlationId: nextCorrelationId() },
        deps,
      ),
      NotOnHoldError,
    );
  });
});

describe('Re-placing a hold that is already active updates the reason', () => {
  it('SetCreditHold called again with a new reason: credit_hold still true, hold_reason updated, version bumped', async () => {
    const account = await insertFixtureAccount();
    const first = await setCreditHold(
      cfoCtx,
      { accountId: account.id, reason: HOLD_REASON_A, expectedVersion: account.version, correlationId: nextCorrelationId() },
      deps,
    );
    const second = await setCreditHold(
      cfoCtx,
      { accountId: account.id, reason: HOLD_REASON_B, expectedVersion: first.version, correlationId: nextCorrelationId() },
      deps,
    );
    expect(second.version).toBe(first.version + 1);
    const row = await getAccount(account.id);
    expect(row.credit_hold).toBe(true);
    expect(row.hold_reason).toBe(HOLD_REASON_B);
  });
});

describe('Stale version is rejected on every mutating command', () => {
  it('SetCreditLimit with a stale expectedVersion -> StaleVersionError (409), nothing changes', async () => {
    const account = await insertFixtureAccount();
    await expectRejectsWith(
      setCreditLimit(
        cfoCtx,
        { accountId: account.id, creditLimit: CREDIT_LIMIT_15000, expectedVersion: account.version + 999, correlationId: nextCorrelationId() },
        deps,
      ),
      StaleVersionError,
    );
    const row = await getAccount(account.id);
    expect(row.version).toBe(account.version);
  });

  it('SetCreditHold with a stale expectedVersion -> StaleVersionError (409), nothing changes', async () => {
    const account = await insertFixtureAccount();
    await expectRejectsWith(
      setCreditHold(
        cfoCtx,
        { accountId: account.id, reason: HOLD_REASON_A, expectedVersion: account.version + 999, correlationId: nextCorrelationId() },
        deps,
      ),
      StaleVersionError,
    );
    const row = await getAccount(account.id);
    expect(row.version).toBe(account.version);
    expect(row.credit_hold).toBe(false);
  });

  it('ReleaseCreditHold with a stale expectedVersion -> StaleVersionError (409), nothing changes', async () => {
    const account = await insertFixtureAccount();
    const held = await setCreditHold(
      cfoCtx,
      { accountId: account.id, reason: HOLD_REASON_A, expectedVersion: account.version, correlationId: nextCorrelationId() },
      deps,
    );
    await expectRejectsWith(
      releaseCreditHold(
        cfoCtx,
        { accountId: account.id, reason: RELEASE_REASON_GM, expectedVersion: held.version + 999, correlationId: nextCorrelationId() },
        deps,
      ),
      StaleVersionError,
    );
    const row = await getAccount(account.id);
    expect(row.version).toBe(held.version);
    expect(row.credit_hold).toBe(true);
  });
});

describe('An unknown account is rejected', () => {
  it('SetCreditLimit with a non-existent accountId -> AccountNotFoundError', async () => {
    await expectRejectsWith(
      setCreditLimit(
        cfoCtx,
        { accountId: randomUUID(), creditLimit: CREDIT_LIMIT_15000, expectedVersion: 1, correlationId: nextCorrelationId() },
        deps,
      ),
      AccountNotFoundError,
    );
  });

  it('SetCreditHold with a non-existent accountId -> AccountNotFoundError', async () => {
    await expectRejectsWith(
      setCreditHold(
        cfoCtx,
        { accountId: randomUUID(), reason: HOLD_REASON_A, expectedVersion: 1, correlationId: nextCorrelationId() },
        deps,
      ),
      AccountNotFoundError,
    );
  });

  it('ReleaseCreditHold with a non-existent accountId -> AccountNotFoundError', async () => {
    await expectRejectsWith(
      releaseCreditHold(
        cfoCtx,
        { accountId: randomUUID(), reason: RELEASE_REASON_GM, expectedVersion: 1, correlationId: nextCorrelationId() },
        deps,
      ),
      AccountNotFoundError,
    );
  });

  it('getAccountCreditStatus with a non-existent accountId -> AccountNotFoundError', async () => {
    await expectRejectsWith(getAccountCreditStatus(cfoCtx, { accountId: randomUUID() }, deps), AccountNotFoundError);
  });
});

describe('Idempotent replay and conflicting replay', () => {
  it('SetCreditLimit replayed with the same Idempotency-Key and body returns the stored response, no second write', async () => {
    const account = await insertFixtureAccount();
    const idempotencyKey = randomUUID();
    const body = { accountId: account.id, creditLimit: CREDIT_LIMIT_15000, expectedVersion: account.version, correlationId: nextCorrelationId() };
    const idem = idemFor('set-credit-limit', idempotencyKey, body);

    const first = await setCreditLimit(cfoCtx, { ...body, idem }, deps);
    const second = await setCreditLimit(cfoCtx, { ...body, idem }, deps);
    expect(second).toEqual(first);

    const row = await getAccount(account.id);
    expect(row.version).toBe(account.version + 1); // bumped exactly once.
  });

  it('SetCreditLimit replayed with the same key but a DIFFERENT body -> IdempotencyConflictError (409)', async () => {
    const account = await insertFixtureAccount();
    const idempotencyKey = randomUUID();
    const body = { accountId: account.id, creditLimit: CREDIT_LIMIT_15000, expectedVersion: account.version, correlationId: nextCorrelationId() };
    const idem = idemFor('set-credit-limit', idempotencyKey, body);

    await setCreditLimit(cfoCtx, { ...body, idem }, deps);

    const differentBody = { ...body, creditLimit: CREDIT_LIMIT_ZERO, correlationId: nextCorrelationId() };
    const differentIdem = idemFor('set-credit-limit', idempotencyKey, differentBody);
    await expectRejectsWith(setCreditLimit(cfoCtx, { ...differentBody, idem: differentIdem }, deps), IdempotencyConflictError);
  });
});

describe('RLS — a caller who cannot see the account gets a not-found, never a leaked artifact', () => {
  it('SetCreditLimit as an outsider (no identity.user_entities visibility, different clientId) -> AccountNotFoundError, nothing written', async () => {
    const account = await insertFixtureAccount();
    const outsiderCtx = { userId: OUTSIDER_ACTOR_UUID, clientId: randomUUID(), isInternal: false };
    await expectRejectsWith(
      setCreditLimit(
        outsiderCtx,
        { accountId: account.id, creditLimit: CREDIT_LIMIT_15000, expectedVersion: account.version, correlationId: nextCorrelationId() },
        deps,
      ),
      AccountNotFoundError,
    );
    const row = await getAccount(account.id);
    expect(row.version).toBe(account.version);
  });

  it('getAccountCreditStatus as an outsider -> AccountNotFoundError', async () => {
    const account = await insertFixtureAccount();
    const outsiderCtx = { userId: OUTSIDER_ACTOR_UUID, clientId: randomUUID(), isInternal: false };
    await expectRejectsWith(getAccountCreditStatus(outsiderCtx, { accountId: account.id }, deps), AccountNotFoundError);
  });

  it('SetCreditHold as an outsider -> AccountNotFoundError, nothing written', async () => {
    const account = await insertFixtureAccount();
    const outsiderCtx = { userId: OUTSIDER_ACTOR_UUID, clientId: randomUUID(), isInternal: false };
    await expectRejectsWith(
      setCreditHold(
        outsiderCtx,
        { accountId: account.id, reason: HOLD_REASON_A, expectedVersion: account.version, correlationId: nextCorrelationId() },
        deps,
      ),
      AccountNotFoundError,
    );
    const row = await getAccount(account.id);
    expect(row.version).toBe(account.version);
    expect(row.credit_hold).toBe(false);
  });

  it('ReleaseCreditHold as an outsider -> AccountNotFoundError, nothing written', async () => {
    const account = await insertFixtureAccount();
    const held = await setCreditHold(
      cfoCtx,
      { accountId: account.id, reason: HOLD_REASON_A, expectedVersion: account.version, correlationId: nextCorrelationId() },
      deps,
    );
    const outsiderCtx = { userId: OUTSIDER_ACTOR_UUID, clientId: randomUUID(), isInternal: false };
    await expectRejectsWith(
      releaseCreditHold(
        outsiderCtx,
        { accountId: account.id, reason: RELEASE_REASON_GM, expectedVersion: held.version, correlationId: nextCorrelationId() },
        deps,
      ),
      AccountNotFoundError,
    );
    const row = await getAccount(account.id);
    expect(row.version).toBe(held.version);
    expect(row.credit_hold).toBe(true);
  });
});

describe('RLS boundary (migration 0021) — a portal client can SEE the account but cannot WRITE it', () => {
  it("getAccountCreditStatus as the account's own portal client succeeds (client_portal_scope SELECT grants read visibility)", async () => {
    const account = await insertFixtureAccount();
    await setCreditLimit(
      cfoCtx,
      { accountId: account.id, creditLimit: CREDIT_LIMIT_15000, expectedVersion: account.version, correlationId: nextCorrelationId() },
      deps,
    );
    const portalCtx = { userId: PORTAL_CLIENT_ACTOR_UUID, clientId: account.id, isInternal: false };
    const result = await getAccountCreditStatus(portalCtx, { accountId: account.id }, deps);
    expect(result).toEqual({ accountId: account.id, creditLimit: CREDIT_LIMIT_15000, creditHold: false });
  });

  it("SetCreditHold as the account's own portal client -> AccountNotFoundError (write blocked despite read visibility), version unchanged", async () => {
    const account = await insertFixtureAccount();
    const portalCtx = { userId: PORTAL_CLIENT_ACTOR_UUID, clientId: account.id, isInternal: false };
    await expectRejectsWith(
      setCreditHold(
        portalCtx,
        { accountId: account.id, reason: HOLD_REASON_A, expectedVersion: account.version, correlationId: nextCorrelationId() },
        deps,
      ),
      AccountNotFoundError,
    );
    const row = await getAccount(account.id);
    expect(row.version).toBe(account.version);
    expect(row.credit_hold).toBe(false);
  });
});

describe('Every command requires ctx.userId (Master decision 6)', () => {
  it('SetCreditLimit with no ctx.userId -> MissingActorError', async () => {
    const account = await insertFixtureAccount();
    const noActorCtx = { userId: null, clientId: null, isInternal: true };
    await expectRejectsWith(
      setCreditLimit(
        noActorCtx,
        { accountId: account.id, creditLimit: CREDIT_LIMIT_15000, expectedVersion: account.version, correlationId: nextCorrelationId() },
        deps,
      ),
      MissingActorError,
    );
  });
});
