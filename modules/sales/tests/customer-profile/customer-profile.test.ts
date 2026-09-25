// modules/sales/tests/customer-profile/customer-profile.test.ts — WBS 1.9, M02 sales.
//
// Integration tests, one `it` per scenario in ./customer-profile.feature (9 scenarios), against the
// real database as pgeos_app (PG_APP_USER=pgeos_app REQUIRED). Sources:
// docs/notes/slice-briefs/_slice-1.9.brief.md ("Master decisions" 1-6), database/schema/01-Data-
// Model.sql:420-444 (sales.accounts), :553-579 (sales.contracts), :1486-1489 (sales.accounts RLS —
// client_portal_scope, "for select using (platform.is_internal() or id = platform.current_client_id())").
//
// CHOSEN RESULT SHAPE (pg-backend implements exactly this — brief's Master decision 1, literal):
//   getCustomerProfile(ctx, { accountId }, deps) -> Promise<{
//     identity: { accountId, code, nameAr, nameEn: string|null, segmentCode: string|null,
//                 segmentNameAr: string|null, ownerUserId: string|null, ownerNameAr: string|null },
//     contracts: [{ contractId, entityCode, status, startDate, endDate: string|null, hasPriceList: boolean }],
//     readiness: [{ item: 'cr_number'|'credit_limit'|'segment'|'payment_terms'|'priced_contract',
//                    present: boolean, owner: 'CFO' }],
//     finance: { creditLimit: string|null, creditHold: boolean, holdReason: string|null },
//     profitability: { available: false }
//   }>
// Read-only, no lock, no version, no Idempotency-Key — mirrors getContractForOrder's shape exactly
// (Master decision 1). Throws AccountNotFoundError when the account doesn't resolve under RLS
// (Master decision 6).
//
// `createCustomerProfileDeps()` [DEFAULT, reported as an open question below]: this slice is a pure
// read with nothing computed from time or randomness, so — unlike manage-contract/manage-account-
// credit's `createManageContractDeps({ clock, ids })` — it takes no clock/ids. Declared here as
// `createCustomerProfileDeps(overrides?: { readonly logger?: Logger }): CustomerProfileDeps`,
// mirroring the composition-root pattern (repo + logger, pino default) with clock/ids simply
// omitted since nothing in Master decisions 1-6 needs them.
//
// ERROR CLASSES this suite imports and asserts `instanceof` on:
//   AccountNotFoundError.
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only) plus real
// identity.users/user_entities rows, same shape as
// modules/sales/tests/manage-account-credit/manage-account-credit.test.ts (the nearest precedent
// for group-level, no-entityId account RLS: sales.accounts carries no entity_id column at all;
// client_portal_scope is the only SELECT policy). Reuses the real seeded segment code SEG-A
// (database/schema/01-Data-Model.sql:1612-1619) and the real seeded entity codes PST/PDL
// (:1567-1572). Creates a minimal catalog.price_lists row per contract that needs
// hasPriceList=true, reusing the insertPriceList pattern from
// modules/sales/tests/manage-contract/manage-contract.test.ts. Cleanup in FK-safe order:
// sales.contracts before sales.accounts/catalog.price_lists (the exact bug class WBS 1.6/1.7's
// reviews already fixed twice in this module) — catalog.segments is a shared seed row, never
// deleted. platform.audit_log rows are NEVER deleted (none expected — read-only). No outbox
// assertions — nothing is written anywhere this slice (brief: "No migration this slice — every
// command is read-only").

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getCustomerProfile } from '../../application/customer-profile/index.js';
import { createCustomerProfileDeps } from '../../api/customer-profile/composition.js';
import { AccountNotFoundError } from '../../domain/customer-profile/errors.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

// --- literals, each cited to the schema fact, decision or brief line they come from -------------

const SEGMENT_CODE_SEG_A = 'SEG-A'; // database/schema/01-Data-Model.sql:1613 — real seeded segment.
const ENTITY_CODE_PST = 'PST';
const ENTITY_CODE_PDL = 'PDL';
const ROLE_CFO = 'CFO';

const CREDIT_LIMIT_5000 = '5000.000'; // brief Background.
const CREDIT_LIMIT_ZERO = '0.000'; // S7 — a legal value that is still an outstanding gap here.
const CREDIT_LIMIT_NEGATIVE = '-5.000'; // pg-reviewer fix round 1, finding 1: never "present".
const PAYMENT_TERMS_DAYS_30 = 30;
const HOLD_REASON_OVERDUE = 'overdue';

const CFO_ACTOR_UUID = '00000000-0000-4000-8000-000000019001';
// RLS: no identity.user_entities row anywhere for this actor, and clientId points at a DIFFERENT
// account than the fixture — the client_portal_scope SELECT policy denies visibility.
const OUTSIDER_ACTOR_UUID = '00000000-0000-4000-8000-000000019099';
// Internal actor granted visibility into entityIdPdl ONLY (never entityIdPst) — pins the accepted
// behaviour (pg-reviewer fix round 1, finding 4): sales.contracts has its OWN entity_scope RLS
// policy (entity_id = any(platform.allowed_entities())), separate from sales.accounts's
// account-level client_portal_scope — so readiness is computed only over what the caller can
// actually see, not the whole account. This is documented, accepted behaviour, not a bug.
const PARTIAL_VISIBILITY_ACTOR_UUID = '00000000-0000-4000-8000-000000019098';

const cfoCtx = { userId: CFO_ACTOR_UUID, clientId: null, isInternal: true };

const deps = createCustomerProfileDeps();

const fixtureAccountIds: string[] = [];
const fixtureContractIds: string[] = [];
const fixturePriceListIds: string[] = [];

let segmentIdSegA: string;
let entityIdPst: string;
let entityIdPdl: string;

async function insertAccount(opts?: {
  readonly crNumber?: string | null;
  readonly creditLimit?: string;
  readonly segmentId?: string | null;
  readonly paymentTermsDays?: number | null;
  readonly creditHold?: boolean;
  readonly holdReason?: string | null;
}): Promise<{ id: string; code: string }> {
  const code = `_c360_fixture_acc_${randomUUID()}`;
  const result: QueryResult<{ id: string; code: string }> = await pool.query(
    `insert into sales.accounts
       (code, name_ar, account_type, cr_number, segment_id, credit_limit, payment_terms_days,
        credit_hold, hold_reason)
     values ($1, $2, 'client', $3, $4, $5, $6, $7, $8)
     returning id, code`,
    [
      code,
      'حساب اختبار الملف 360 — WBS 1.9',
      opts?.crNumber === undefined ? `CR-${randomUUID().slice(0, 8)}` : opts.crNumber,
      opts?.segmentId === undefined ? segmentIdSegA : opts.segmentId,
      opts?.creditLimit ?? CREDIT_LIMIT_5000,
      opts?.paymentTermsDays === undefined ? PAYMENT_TERMS_DAYS_30 : opts.paymentTermsDays,
      opts?.creditHold ?? false,
      opts?.holdReason ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture sales.accounts insert returned no row');
  fixtureAccountIds.push(row.id);
  return row;
}

async function insertPriceList(entityId: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into catalog.price_lists (entity_id, code, name_ar, valid_from, is_internal, status)
     values ($1, $2, $3, '2026-01-01', false, 'active') returning id`,
    [entityId, `_c360_fixture_pl_${randomUUID()}`, 'قائمة أسعار اختبار الملف 360 — WBS 1.9'],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture catalog.price_lists insert returned no row');
  fixturePriceListIds.push(row.id);
  return row.id;
}

async function insertContract(opts: {
  readonly accountId: string;
  readonly entityId: string;
  readonly startDate: string;
  readonly priceListId?: string | null;
}): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.contracts (entity_id, doc_no, account_id, title, start_date, price_list_id)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      opts.entityId,
      `_c360_fixture_ctr_${randomUUID()}`,
      opts.accountId,
      'عقد اختبار الملف 360 — WBS 1.9',
      opts.startDate,
      opts.priceListId ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture sales.contracts insert returned no row');
  fixtureContractIds.push(row.id);
  return row.id;
}

function readinessItem(
  profile: Awaited<ReturnType<typeof getCustomerProfile>>,
  item: 'cr_number' | 'credit_limit' | 'segment' | 'payment_terms' | 'priced_contract',
) {
  const found = profile.readiness.find((r) => r.item === item);
  if (!found) throw new Error(`readiness item "${item}" missing from result`);
  return found;
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

beforeAll(async () => {
  const segmentResult: QueryResult<{ id: string }> = await pool.query(
    `select id from catalog.segments where code = $1`,
    [SEGMENT_CODE_SEG_A],
  );
  segmentIdSegA = segmentResult.rows[0]?.id ?? (() => { throw new Error(`catalog.segments: ${SEGMENT_CODE_SEG_A} not found`); })();

  const entitiesResult: QueryResult<{ id: string; code: string }> = await pool.query(
    `select id, code from platform.entities where code in ($1, $2)`,
    [ENTITY_CODE_PST, ENTITY_CODE_PDL],
  );
  const byCode = new Map(entitiesResult.rows.map((r) => [r.code, r.id]));
  entityIdPst = byCode.get(ENTITY_CODE_PST) ?? (() => { throw new Error('platform.entities: PST not found'); })();
  entityIdPdl = byCode.get(ENTITY_CODE_PDL) ?? (() => { throw new Error('platform.entities: PDL not found'); })();

  // CFO actor — internal, sees every account regardless of entity (group-level, no entityId param).
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [CFO_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [CFO_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [CFO_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [CFO_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [CFO_ACTOR_UUID, `_c360_fixture_cfo_${randomUUID()}@test.invalid`, 'ممثل اختبار الملف 360 — WBS 1.9'],
  );
  // sales.contracts has its own entity_scope RLS policy (entity_id = any(platform.allowed_entities()),
  // no is_internal() OR-gate — verified live via pg_policy), separate from sales.accounts's
  // account-level client_portal_scope policy. The fixture Background inserts contracts at BOTH
  // PST and PDL, so the CFO actor needs visibility into both entities, not just PST.
  await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [CFO_ACTOR_UUID, entityIdPst]);
  await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [CFO_ACTOR_UUID, entityIdPdl]);
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [ROLE_CFO]);
  const roleId = roleResult.rows[0]?.id;
  if (!roleId) throw new Error(`identity.roles row not found for code ${ROLE_CFO}`);
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [CFO_ACTOR_UUID, roleId]);

  // Deliberately NO identity.user_entities row for OUTSIDER_ACTOR_UUID — RLS scenario.
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [OUTSIDER_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [OUTSIDER_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [OUTSIDER_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [OUTSIDER_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar) values ($1, $2, $3)`,
    [OUTSIDER_ACTOR_UUID, `_c360_fixture_outsider_${randomUUID()}@test.invalid`, 'ممثل اختبار بلا رؤية — WBS 1.9'],
  );

  // Internal actor, PDL visibility only — sees the account (internal, account-level policy) but
  // NOT any PST contract (entity_scope on sales.contracts).
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [PARTIAL_VISIBILITY_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [PARTIAL_VISIBILITY_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [PARTIAL_VISIBILITY_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [PARTIAL_VISIBILITY_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [PARTIAL_VISIBILITY_ACTOR_UUID, `_c360_fixture_partial_${randomUUID()}@test.invalid`, 'ممثل اختبار رؤية جزئية — WBS 1.9'],
  );
  await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [PARTIAL_VISIBILITY_ACTOR_UUID, entityIdPdl]);
});

afterAll(async () => {
  if (fixtureContractIds.length > 0) {
    await pool.query(`delete from sales.contracts where id = any($1::uuid[])`, [fixtureContractIds]);
  }
  if (fixtureAccountIds.length > 0) {
    await pool.query(`delete from sales.accounts where id = any($1::uuid[])`, [fixtureAccountIds]);
  }
  if (fixturePriceListIds.length > 0) {
    await pool.query(`delete from catalog.price_lists where id = any($1::uuid[])`, [fixturePriceListIds]);
  }
  const allFixtureActorIds = [CFO_ACTOR_UUID, OUTSIDER_ACTOR_UUID, PARTIAL_VISIBILITY_ACTOR_UUID];
  await pool.query(`delete from platform.idempotency_keys where user_id = any($1::uuid[])`, [allFixtureActorIds]);
  await pool.query(`delete from identity.user_roles where user_id = any($1::uuid[])`, [allFixtureActorIds]);
  await pool.query(`delete from identity.user_entities where user_id = any($1::uuid[])`, [allFixtureActorIds]);
  await pool.query(`delete from identity.users where id = any($1::uuid[])`, [allFixtureActorIds]);
  await pool.end();
});

describe('A fully-ready account shows no gaps', () => {
  it('getCustomerProfile: every readiness item present, both entities in contracts, finance and profitability as specified', async () => {
    const account = await insertAccount();
    const priceListPst = await insertPriceList(entityIdPst);
    await insertContract({ accountId: account.id, entityId: entityIdPst, startDate: '2026-01-01', priceListId: priceListPst });
    await insertContract({ accountId: account.id, entityId: entityIdPdl, startDate: '2026-02-01', priceListId: null });

    const profile = await getCustomerProfile(cfoCtx, { accountId: account.id }, deps);

    expect(profile.identity.accountId).toBe(account.id);
    expect(profile.identity.code).toBe(account.code);
    expect(profile.identity.segmentCode).toBe(SEGMENT_CODE_SEG_A);

    for (const item of profile.readiness) {
      expect(item.present).toBe(true);
      expect(item.owner).toBe(ROLE_CFO);
    }
    expect(profile.readiness).toHaveLength(5);

    const entityCodes = profile.contracts.map((c) => c.entityCode).sort();
    expect(entityCodes).toEqual([ENTITY_CODE_PDL, ENTITY_CODE_PST].sort());

    expect(profile.finance).toEqual({ creditLimit: CREDIT_LIMIT_5000, creditHold: false, holdReason: null });
    expect(profile.profitability).toEqual({ available: false });
  });
});

describe('Missing cr_number is a readiness gap owned by CFO', () => {
  it('getCustomerProfile: the "cr_number" readiness item is present:false, owner "CFO"', async () => {
    const account = await insertAccount({ crNumber: null });

    const profile = await getCustomerProfile(cfoCtx, { accountId: account.id }, deps);

    const gap = readinessItem(profile, 'cr_number');
    expect(gap.present).toBe(false);
    expect(gap.owner).toBe(ROLE_CFO);
  });
});

describe('A zero credit limit is a readiness gap even though it is a legal value (S7)', () => {
  it('getCustomerProfile: the "credit_limit" readiness item is present:false', async () => {
    const account = await insertAccount({ creditLimit: CREDIT_LIMIT_ZERO });

    const profile = await getCustomerProfile(cfoCtx, { accountId: account.id }, deps);

    expect(readinessItem(profile, 'credit_limit').present).toBe(false);
    expect(profile.finance.creditLimit).toBe(CREDIT_LIMIT_ZERO);
  });
});

describe('A negative credit limit is a readiness gap (pg-reviewer fix round 1, finding 1)', () => {
  it('getCustomerProfile: the "credit_limit" readiness item is present:false when credit_limit is negative', async () => {
    const account = await insertAccount({ creditLimit: CREDIT_LIMIT_NEGATIVE });

    const profile = await getCustomerProfile(cfoCtx, { accountId: account.id }, deps);

    expect(readinessItem(profile, 'credit_limit').present).toBe(false);
    expect(profile.finance.creditLimit).toBe(CREDIT_LIMIT_NEGATIVE);
  });
});

describe('Readiness is computed only over what the caller can actually see (accepted behaviour, pg-reviewer fix round 1, finding 4)', () => {
  it('a caller who can see the account but NOT the entity holding the only priced contract gets priced_contract:false', async () => {
    const account = await insertAccount();
    const priceListPst = await insertPriceList(entityIdPst);
    await insertContract({ accountId: account.id, entityId: entityIdPst, startDate: '2026-01-01', priceListId: priceListPst });
    await insertContract({ accountId: account.id, entityId: entityIdPdl, startDate: '2026-02-01', priceListId: null });

    // Sanity check: the CFO actor (full PST+PDL visibility) DOES see the priced contract.
    const fullProfile = await getCustomerProfile(cfoCtx, { accountId: account.id }, deps);
    expect(readinessItem(fullProfile, 'priced_contract').present).toBe(true);

    // The partial-visibility actor (PDL only) cannot see the PST contract at all — entity_scope on
    // sales.contracts, separate from sales.accounts's own account-level RLS policy — so from that
    // caller's point of view the account has no visible priced contract.
    const partialCtx = { userId: PARTIAL_VISIBILITY_ACTOR_UUID, clientId: null, isInternal: true };
    const partialProfile = await getCustomerProfile(partialCtx, { accountId: account.id }, deps);
    expect(readinessItem(partialProfile, 'priced_contract').present).toBe(false);
    expect(partialProfile.contracts.map((c) => c.entityCode)).toEqual([ENTITY_CODE_PDL]);
  });
});

describe('No priced contract anywhere is a readiness gap', () => {
  it('getCustomerProfile: the "priced_contract" readiness item is present:false when neither contract has a price_list_id', async () => {
    const account = await insertAccount();
    await insertContract({ accountId: account.id, entityId: entityIdPst, startDate: '2026-01-01', priceListId: null });
    await insertContract({ accountId: account.id, entityId: entityIdPdl, startDate: '2026-02-01', priceListId: null });

    const profile = await getCustomerProfile(cfoCtx, { accountId: account.id }, deps);

    expect(readinessItem(profile, 'priced_contract').present).toBe(false);
  });
});

describe('An account with one priced contract among several has that gap closed', () => {
  it('getCustomerProfile: the "priced_contract" readiness item is present:true when one contract has a price list and one does not', async () => {
    const account = await insertAccount();
    const priceListPst = await insertPriceList(entityIdPst);
    await insertContract({ accountId: account.id, entityId: entityIdPst, startDate: '2026-01-01', priceListId: priceListPst });
    await insertContract({ accountId: account.id, entityId: entityIdPdl, startDate: '2026-02-01', priceListId: null });

    const profile = await getCustomerProfile(cfoCtx, { accountId: account.id }, deps);

    expect(readinessItem(profile, 'priced_contract').present).toBe(true);
    const pstContract = profile.contracts.find((c) => c.entityCode === ENTITY_CODE_PST);
    const pdlContract = profile.contracts.find((c) => c.entityCode === ENTITY_CODE_PDL);
    expect(pstContract?.hasPriceList).toBe(true);
    expect(pdlContract?.hasPriceList).toBe(false);
  });
});

describe('Finance reflects an active hold', () => {
  it('getCustomerProfile: finance.creditHold is true and finance.holdReason is "overdue"', async () => {
    const account = await insertAccount({ creditHold: true, holdReason: HOLD_REASON_OVERDUE });

    const profile = await getCustomerProfile(cfoCtx, { accountId: account.id }, deps);

    expect(profile.finance.creditHold).toBe(true);
    expect(profile.finance.holdReason).toBe(HOLD_REASON_OVERDUE);
  });
});

describe('An unknown account is rejected', () => {
  it('getCustomerProfile with an accountId that does not exist -> AccountNotFoundError', async () => {
    await expectRejectsWith(getCustomerProfile(cfoCtx, { accountId: randomUUID() }, deps), AccountNotFoundError);
  });
});

describe('RLS — a caller who cannot see the account gets a not-found', () => {
  it('getCustomerProfile as an outsider (no identity.user_entities visibility, different clientId) -> AccountNotFoundError', async () => {
    const account = await insertAccount();
    const outsiderCtx = { userId: OUTSIDER_ACTOR_UUID, clientId: randomUUID(), isInternal: false };

    await expectRejectsWith(getCustomerProfile(outsiderCtx, { accountId: account.id }, deps), AccountNotFoundError);
  });
});

describe('Contracts are ordered newest start_date first', () => {
  it('getCustomerProfile: the contracts array is ordered by start_date descending', async () => {
    const account = await insertAccount();
    const oldest = await insertContract({ accountId: account.id, entityId: entityIdPst, startDate: '2025-01-01' });
    const middle = await insertContract({ accountId: account.id, entityId: entityIdPdl, startDate: '2025-06-01' });
    const newest = await insertContract({ accountId: account.id, entityId: entityIdPst, startDate: '2026-01-01' });

    const profile = await getCustomerProfile(cfoCtx, { accountId: account.id }, deps);

    expect(profile.contracts.map((c) => c.contractId)).toEqual([newest, middle, oldest]);
  });
});
