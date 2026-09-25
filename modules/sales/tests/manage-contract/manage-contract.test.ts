// modules/sales/tests/manage-contract/manage-contract.test.ts — WBS 1.7, M02 sales.
//
// Integration tests, one `it` per scenario in ./manage-contract.feature (18 scenarios), against the
// real database as pgeos_app. Sources: docs/package/40-Build-Specification-EN.md §C2/§C4,
// docs/notes/slice-briefs/_slice-1.7.brief.md ("Master decisions" 1-15).
//
// CHOSEN RESULT SHAPES (pg-backend implements exactly these — brief instruction; fields not pinned
// literally by the brief are this file's own DEFAULT, reported as an open question below):
//   createContract(ctx, input, deps)         -> Promise<{ contractId: string; docNo: string; version: number }>
//   signContract(ctx, input, deps)            -> Promise<{ version: number }>                       [DEFAULT]
//   setContractPriceList(ctx, input, deps)     -> Promise<{ version: number }>                       [DEFAULT]
//   activateContract(ctx, input, deps)         -> Promise<{ version: number }>                       [DEFAULT]
//   suspendContract(ctx, input, deps)          -> Promise<{ version: number }>                       [DEFAULT]
//   resumeContract(ctx, input, deps)           -> Promise<{ version: number }>                       [DEFAULT]
//   expireContract(ctx, input, deps)           -> Promise<{ version: number }>                       [DEFAULT]
//   addContractSla(ctx, input, deps)           -> Promise<{ slaId: string; version: number }>        [DEFAULT —
//                                                 `version` is the CONTRACT's own version, UNCHANGED by this
//                                                 call (Master decision 9: "no version bump on the contract row
//                                                 for this"), echoed back for the caller's convenience.]
//   getContractForOrder(ctx, input, deps)      -> Promise<{ contractId: string; status: string; priceListId: string | null }>
//                                                 (Master decision 10, literal)
// Every command input carries `correlationId`; every contract-mutating command except CreateContract
// carries `expectedVersion` — the optimistic-lock token the caller read most recently; a stale one ->
// StaleVersionError (409). `idem?: IdempotencyInput` is an optional extra field on every write
// command's input (golden pattern, reused from manage-quote).
//
// ERROR CLASSES this suite imports and asserts `instanceof` on — the brief's literal list (slice
// brief, "Declare in file-top comments" instruction):
//   AccountNotFoundError, AccountNotQualifiedError, ContractNotFoundError, ContractNotPriceableError,
//   PriceListNotApplicableError, ContractNotActiveError{status}, ContractNotYetExpirableError,
//   SlaNotEnabledError, StaleVersionError, IllegalTransitionError, MissingActorError,
//   InvalidStartDateError, InvalidEndDateError.
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only) plus real
// identity.users/user_entities/user_roles rows, same as
// modules/sales/tests/manage-quote/manage-quote.test.ts. PG_APP_USER=pgeos_app is REQUIRED to run
// this suite. catalog.segments/catalog.price_lists rows this suite needs are inserted directly via
// the admin pool (brief instruction: "this brief doesn't have a live 1.2 fixture to import") —
// cleaned up in afterAll, in FK-respecting order (sales.contract_sla before sales.contracts before
// catalog.price_lists/catalog.segments/sales.accounts — the exact bug class WBS 1.6's review fixed).
// platform.audit_log rows are NEVER deleted. No outbox assertions — Master decision 14: "No outbox
// event this slice."

import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IdempotencyConflictError, type IdempotencyInput } from '@pg-eos/db';

import {
  activateContract,
  addContractSla,
  createContract,
  expireContract,
  getContractForOrder,
  resumeContract,
  setContractPriceList,
  signContract,
  suspendContract,
} from '../../application/manage-contract/index.js';
import { createManageContractDeps } from '../../api/manage-contract/composition.js';
import {
  AccountNotFoundError,
  AccountNotQualifiedError,
  ContractExpiredByDateError,
  ContractNotActiveError,
  ContractNotFoundError,
  ContractNotPriceableError,
  ContractNotYetExpirableError,
  IllegalTransitionError,
  InvalidEndDateError,
  InvalidStartDateError,
  MissingActorError,
  PriceListNotApplicableError,
  SlaNotEnabledError,
  StaleVersionError,
} from '../../domain/manage-contract/errors.js';
// The package subpath export (@pg-eos/contracts/sales/manage-contract) — used ONLY for the
// contract-boundary (Zod) assertion below (Scenario: an unrecognised SLA metric is rejected at the
// contract boundary), mirroring the golden slice's own "@pg-eos/contracts/... — schemas" describe
// block precedent.
import { AddContractSlaInputSchema } from '@pg-eos/contracts/sales/manage-contract';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

// --- literals, each cited to the schema fact, decision or brief line they come from -------------

const ENTITY_CODE_PST = 'PST';
const ROLE_CFO = 'CFO';

const CFO_ACTOR_UUID = '00000000-0000-4000-8000-000000017001';
const OUTSIDER_ACTOR_UUID = '00000000-0000-4000-8000-000000017002'; // RLS: no user_entities row for PST.

const clock = new FixedClock(new Date('2026-09-24T00:00:00.000Z'));
const TODAY_ISO = '2026-09-24';
const YESTERDAY_ISO = '2026-09-23';
const TOMORROW_ISO = '2026-09-25';
const PAST_DATE_ISO = '2026-01-01'; // strictly before TODAY_ISO — Master decision 2's InvalidStartDateError.
const ids = new SequentialIdGenerator(1700);
const deps = createManageContractDeps({ clock, ids });

const cfoCtx = { userId: CFO_ACTOR_UUID, clientId: null, isInternal: true };
const outsiderCtx = { userId: OUTSIDER_ACTOR_UUID, clientId: null, isInternal: true };

const SLA_METRIC_OTD_PCT = 'otd_pct';
const SLA_TARGET_VALUE = '95.000';
const SLA_DIRECTION_MIN = 'min';
const SLA_UNRECOGNISED_METRIC = 'not_a_real_metric';

let entityId: string;
let otherEntityId: string;
let segmentId: string;
let otherSegmentId: string; // pg-reviewer fix round 3, finding 1 — a DIFFERENT segment than ACC-1's own.
let accountIdQualified: string; // ACC-1.
let accountIdUnqualified: string;
let accountIdOtherClient: string; // owns otherClientPriceListId.
let segmentPriceListId: string;
let otherClientPriceListId: string;

const fixtureAccountIds: string[] = [];
const fixturePriceListIds: string[] = [];
const fixtureSegmentIds: string[] = [];
const fixtureContractIds: string[] = [];

function nextCorrelationId(): string {
  return randomUUID();
}

/** sha256 hex of the JSON body — mirrors `withIdempotentContext`'s own hash (golden pattern). */
function idemFor(endpoint: string, key: string, body: unknown): IdempotencyInput {
  return {
    key,
    endpoint: `sales.manage-contract.${endpoint}`,
    requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    entityId: null,
    successStatus: 200,
  };
}

async function insertSegment(): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into catalog.segments (code, name_ar, rank, criteria) values ($1, $2, 1, '{}'::jsonb) returning id`,
    [`_contract_fixture_seg_${randomUUID()}`, 'شريحة اختبار العقود — WBS 1.7'],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture catalog.segments insert returned no row');
  fixtureSegmentIds.push(row.id);
  return row.id;
}

// pg-reviewer fix round 3, finding 1: `isInternal`/`status` are now settable — before this fix
// EVERY fixture price list was active and non-internal, so `assertPriceListApplicable`'s three new
// conditions (is_internal=false, status='active', segment empty-or-matching) had no way to vary and
// were vacuously green.
async function insertPriceList(opts: {
  readonly segmentId?: string | null;
  readonly clientId?: string | null;
  readonly entityId?: string;
  readonly isInternal?: boolean;
  readonly status?: string;
}): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into catalog.price_lists (entity_id, code, name_ar, segment_id, client_id, valid_from, is_internal, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      opts.entityId ?? entityId,
      `_contract_fixture_pl_${randomUUID()}`,
      'قائمة أسعار اختبار العقود — WBS 1.7',
      opts.segmentId ?? null,
      opts.clientId ?? null,
      '2026-01-01',
      opts.isInternal ?? false,
      opts.status ?? 'active',
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture catalog.price_lists insert returned no row');
  fixturePriceListIds.push(row.id);
  return row.id;
}

async function insertQualifiedAccount(opts?: { readonly segmentId?: string | null }): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type, cr_number, status, segment_id)
     values ($1, $2, 'client', $3, 'active', $4) returning id`,
    [`_contract_fixture_acc_${randomUUID()}`, 'حساب اختبار عقود مؤهَّل', `CR-${randomUUID().slice(0, 8)}`, opts?.segmentId ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture sales.accounts insert returned no row');
  fixtureAccountIds.push(row.id);
  return row.id;
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
    [userId, `_contract_fixture_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار العقود — WBS 1.7'],
  );
  for (const eid of entityIds) {
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, eid]);
  }
}

async function getContract(contractId: string): Promise<{
  status: string;
  version: number;
  signed_at: Date | null;
  price_list_id: string | null;
  sla_enabled: boolean;
  bills_failed_attempt: boolean;
  bills_return: boolean;
  bills_waiting: boolean;
  bills_reschedule: boolean;
  bills_partial_delivery: boolean;
  end_date: string | null;
  doc_no: string;
}> {
  const result: QueryResult<{
    status: string;
    version: number;
    signed_at: Date | null;
    price_list_id: string | null;
    sla_enabled: boolean;
    bills_failed_attempt: boolean;
    bills_return: boolean;
    bills_waiting: boolean;
    bills_reschedule: boolean;
    bills_partial_delivery: boolean;
    end_date: string | null;
    doc_no: string;
  }> = await pool.query(
    `select status, version, signed_at, price_list_id::text as price_list_id, sla_enabled,
            bills_failed_attempt, bills_return, bills_waiting, bills_reschedule, bills_partial_delivery,
            end_date::text as end_date, doc_no
       from sales.contracts where id = $1`,
    [contractId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no sales.contracts row for id ${contractId}`);
  return row;
}

async function getSlaRows(contractId: string): Promise<Array<{ id: string; metric: string; target_value: string }>> {
  const result: QueryResult<{ id: string; metric: string; target_value: string }> = await pool.query(
    `select id, metric, target_value::text as target_value from sales.contract_sla where contract_id = $1`,
    [contractId],
  );
  return result.rows;
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

interface CreateOpts {
  readonly accountId: string;
  readonly startDate?: string | undefined;
  readonly endDate?: string | null | undefined;
  readonly slaEnabled?: boolean | undefined;
  readonly billsFailedAttempt?: boolean | undefined;
}

async function createDraftContract(opts: CreateOpts): Promise<{ contractId: string; docNo: string; version: number }> {
  const result = await createContract(
    cfoCtx,
    {
      entityId,
      accountId: opts.accountId,
      quoteId: null,
      title: 'عقد اختبار — WBS 1.7',
      startDate: opts.startDate ?? TODAY_ISO,
      endDate: opts.endDate ?? null,
      slaEnabled: opts.slaEnabled ?? false,
      billsFailedAttempt: opts.billsFailedAttempt ?? false,
      correlationId: nextCorrelationId(),
    },
    deps,
  );
  fixtureContractIds.push(result.contractId);
  return result;
}

/** Fixture-only bypass of CreateContract's own validation (Master decision 2: `startDate >= today`,
 *  `endDate >= startDate`) — inserted directly via the admin pool, status 'draft'. With a
 *  `FixedClock` that never advances, no single CreateContract call can ever produce a contract that
 *  is BOTH validly created AND already past its end date (that would require `startDate < today`,
 *  which CreateContract itself correctly rejects — see "an endDate before startDate throws
 *  InvalidEndDateError" below, NOT weakened). The scenarios under test here (ExpireContract,
 *  getContractForOrder on an aged contract) are about behaviour AFTER a contract legitimately
 *  reached 'active' in the past, not about CreateContract's own validation — so this ONE fixture
 *  legitimately bypasses the command layer for contract creation only; every status transition
 *  from 'draft' onward below still runs through the REAL commands. */
async function insertRawDraftContract(accountId: string, startDate: string, endDate: string | null): Promise<{ contractId: string; docNo: string; version: number }> {
  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(`select platform.next_doc_no($1, 'CTR') as doc_no`, [entityId]);
  const docNo = docNoResult.rows[0]?.doc_no;
  if (!docNo) throw new Error('platform.next_doc_no returned no row for CTR');
  const result: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into sales.contracts (entity_id, doc_no, account_id, title, start_date, end_date, status)
     values ($1, $2, $3, $4, $5, $6, 'draft') returning id, version`,
    [entityId, docNo, accountId, 'عقد اختبار (منتهي الصلاحية) — WBS 1.7', startDate, endDate],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture sales.contracts raw insert returned no row');
  fixtureContractIds.push(row.id);
  return { contractId: row.id, docNo, version: row.version };
}

// Safely in the past relative to TODAY_ISO/YESTERDAY_ISO — used ONLY by insertRawDraftContract's
// bypass path, never by a CreateContract call (which would correctly reject it).
const AGED_FIXTURE_START_DATE_ISO = PAST_DATE_ISO;

/** pg-reviewer fix round 2, findings 5/finding-2: a further admin-pool bypass, same legitimacy as
 *  `insertRawDraftContract` above — `terminated` has NO producing edge in this slice (brief Scope
 *  defaults: RenewContract/TerminateContract deferred), so there is no command sequence that can
 *  ever reach it; and an 'active' row whose `end_date` has ALREADY passed asOfDate without ever
 *  having been run through ExpireContract (the exact "functionally expired but not yet
 *  transitioned" case `assertContractNotExpiredByDate`/`ContractExpiredByDateError` exists for) can
 *  only be produced by inserting the row directly at the status under test. Both are fixture setup
 *  for a status the command layer cannot produce, not a shortcut around anything under test. */
async function insertRawContractAtStatus(
  accountId: string,
  status: string,
  opts: { readonly startDate: string; readonly endDate: string | null; readonly priceListId?: string | null; readonly slaEnabled?: boolean },
): Promise<{ contractId: string; docNo: string; version: number }> {
  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(`select platform.next_doc_no($1, 'CTR') as doc_no`, [entityId]);
  const docNo = docNoResult.rows[0]?.doc_no;
  if (!docNo) throw new Error('platform.next_doc_no returned no row for CTR');
  const result: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into sales.contracts (entity_id, doc_no, account_id, title, start_date, end_date, status, price_list_id, sla_enabled)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id, version`,
    [
      entityId,
      docNo,
      accountId,
      `عقد اختبار (${status}) — WBS 1.7 fix round 2`,
      opts.startDate,
      opts.endDate,
      status,
      opts.priceListId ?? null,
      opts.slaEnabled ?? false,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture sales.contracts raw insert (at status) returned no row');
  fixtureContractIds.push(row.id);
  return { contractId: row.id, docNo, version: row.version };
}

type ContractTarget = 'draft' | 'signed' | 'active' | 'suspended' | 'expired';

/** Walks a FRESH contract (own qualified account) to `target` status through the REAL commands
 *  (never a shortcut/raw-SQL status write) — mirrors manage-quote's `buildQuoteToStatus`. Attaches
 *  `segmentPriceListId` before activation, per INV-C2-2. When `opts.endDate` is already in the past
 *  (relative to `TODAY_ISO`), the fixture is created via `insertRawDraftContract` instead of the
 *  `createContract` command (see that function's own comment) — every subsequent transition still
 *  runs through the real commands. */
async function buildContractToStatus(
  target: ContractTarget,
  opts?: { readonly endDate?: string | null; readonly startDate?: string },
): Promise<{ contractId: string; version: number; accountId: string }> {
  const accountId = await insertQualifiedAccount({ segmentId });
  const endDateIsAlreadyPast = opts?.endDate != null && opts.endDate < TODAY_ISO;
  const created = endDateIsAlreadyPast
    ? await insertRawDraftContract(accountId, opts?.startDate ?? AGED_FIXTURE_START_DATE_ISO, opts?.endDate ?? null)
    : await createDraftContract({ accountId, startDate: opts?.startDate, endDate: opts?.endDate });
  let version = created.version;
  if (target === 'draft') return { contractId: created.contractId, version, accountId };

  const signed = await signContract(
    cfoCtx,
    { contractId: created.contractId, expectedVersion: version, signedByClient: 'Ahmed Al-Sabah', correlationId: nextCorrelationId() },
    deps,
  );
  version = signed.version;
  if (target === 'signed') return { contractId: created.contractId, version, accountId };

  const priced = await setContractPriceList(
    cfoCtx,
    { contractId: created.contractId, expectedVersion: version, priceListId: segmentPriceListId, correlationId: nextCorrelationId() },
    deps,
  );
  version = priced.version;

  const activated = await activateContract(
    cfoCtx,
    { contractId: created.contractId, expectedVersion: version, correlationId: nextCorrelationId() },
    deps,
  );
  version = activated.version;
  if (target === 'active') return { contractId: created.contractId, version, accountId };

  if (target === 'suspended') {
    const suspended = await suspendContract(
      cfoCtx,
      { contractId: created.contractId, expectedVersion: version, correlationId: nextCorrelationId() },
      deps,
    );
    version = suspended.version;
    return { contractId: created.contractId, version, accountId };
  }

  // target === 'expired': end_date must already be in the past (set at creation via opts.endDate).
  const expired = await expireContract(
    cfoCtx,
    { contractId: created.contractId, expectedVersion: version, correlationId: nextCorrelationId() },
    deps,
  );
  version = expired.version;
  return { contractId: created.contractId, version, accountId };
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, [ENTITY_CODE_PST]);
  entityId = (entityResult.rows[0] as { id: string }).id;

  const otherEntityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code <> $1 limit 1`,
    [ENTITY_CODE_PST],
  );
  otherEntityId = (otherEntityResult.rows[0] as { id: string }).id;

  segmentId = await insertSegment();
  otherSegmentId = await insertSegment();

  accountIdQualified = await insertQualifiedAccount({ segmentId });
  const unqualifiedResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type, cr_number, status) values ($1, $2, 'client', null, 'active') returning id`,
    [`_contract_fixture_unq_${randomUUID()}`, 'حساب اختبار غير مؤهَّل'],
  );
  accountIdUnqualified = (unqualifiedResult.rows[0] as { id: string }).id;
  fixtureAccountIds.push(accountIdUnqualified);

  accountIdOtherClient = await insertQualifiedAccount();

  await insertPriceList({}); // the standard active PST list (Background) — not directly asserted on.
  segmentPriceListId = await insertPriceList({ segmentId });
  otherClientPriceListId = await insertPriceList({ clientId: accountIdOtherClient });

  await createFixtureActor(CFO_ACTOR_UUID, [entityId]);
  await createFixtureActor(OUTSIDER_ACTOR_UUID, [otherEntityId]); // deliberately NOT entityId (PST).
  await grantRole(CFO_ACTOR_UUID, ROLE_CFO);
});

afterAll(async () => {
  if (fixtureContractIds.length > 0) {
    await pool.query(`delete from sales.contract_sla where contract_id = any($1::uuid[])`, [fixtureContractIds]);
    await pool.query(`delete from sales.contracts where id = any($1::uuid[])`, [fixtureContractIds]);
  }
  if (fixturePriceListIds.length > 0) {
    await pool.query(`delete from catalog.price_lists where id = any($1::uuid[])`, [fixturePriceListIds]);
  }
  if (fixtureAccountIds.length > 0) {
    await pool.query(`delete from sales.accounts where id = any($1::uuid[])`, [fixtureAccountIds]);
  }
  if (fixtureSegmentIds.length > 0) {
    await pool.query(`delete from catalog.segments where id = any($1::uuid[])`, [fixtureSegmentIds]);
  }
  for (const userId of [CFO_ACTOR_UUID, OUTSIDER_ACTOR_UUID]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
});

describe('Feature: Manage contract (WBS 1.7, M02 sales)', () => {
  let narrativeContractId: string;
  let narrativeVersion: number;

  it('Scenario: Create a draft contract', async () => {
    const created = await createDraftContract({ accountId: accountIdQualified });
    expect(created.version).toBe(1);
    narrativeContractId = created.contractId;

    const row = await getContract(narrativeContractId);
    expect(row.status).toBe('draft');
    expect(row.version).toBe(1);
  });

  it('Scenario: Sign the contract', async () => {
    const signed = await signContract(
      cfoCtx,
      { contractId: narrativeContractId, expectedVersion: 1, signedByClient: 'Ahmed Al-Sabah', correlationId: nextCorrelationId() },
      deps,
    );
    narrativeVersion = signed.version;
    const row = await getContract(narrativeContractId);
    expect(row.status).toBe('signed');
    expect(row.signed_at).not.toBeNull();
  });

  it('Scenario: Cannot activate without a price list (INV-C2-2)', async () => {
    await expectRejectsWith(
      activateContract(cfoCtx, { contractId: narrativeContractId, expectedVersion: narrativeVersion, correlationId: nextCorrelationId() }, deps),
      ContractNotPriceableError,
    );
    expect((await getContract(narrativeContractId)).status).toBe('signed');
  });

  it("Scenario: Attach a price annex belonging to another client is rejected", async () => {
    await expectRejectsWith(
      setContractPriceList(
        cfoCtx,
        { contractId: narrativeContractId, expectedVersion: narrativeVersion, priceListId: otherClientPriceListId, correlationId: nextCorrelationId() },
        deps,
      ),
      PriceListNotApplicableError,
    );
    expect((await getContract(narrativeContractId)).price_list_id).toBeNull();
  });

  it('Scenario: Attach a valid price annex and activate', async () => {
    const priced = await setContractPriceList(
      cfoCtx,
      { contractId: narrativeContractId, expectedVersion: narrativeVersion, priceListId: segmentPriceListId, correlationId: nextCorrelationId() },
      deps,
    );
    narrativeVersion = priced.version;
    expect((await getContract(narrativeContractId)).price_list_id).toBe(segmentPriceListId);

    const activated = await activateContract(
      cfoCtx,
      { contractId: narrativeContractId, expectedVersion: narrativeVersion, correlationId: nextCorrelationId() },
      deps,
    );
    narrativeVersion = activated.version;
    expect((await getContract(narrativeContractId)).status).toBe('active');
  });

  it('Scenario: A qualifying order succeeds against an active contract', async () => {
    const result = await getContractForOrder(cfoCtx, { accountId: accountIdQualified, entityId, asOfDate: TODAY_ISO }, deps);
    expect(result.contractId).toBe(narrativeContractId);
    expect(result.status).toBe('active');
    expect(result.priceListId).toBe(segmentPriceListId);
  });

  it('Scenario: An order against an expired contract is rejected (the acceptance line)', async () => {
    const built = await buildContractToStatus('active', { endDate: YESTERDAY_ISO });
    const expired = await expireContract(
      cfoCtx,
      { contractId: built.contractId, expectedVersion: built.version, correlationId: nextCorrelationId() },
      deps,
    );
    expect(expired.version).toBeGreaterThan(built.version);
    expect((await getContract(built.contractId)).status).toBe('expired');

    const error = await expectRejectsWith(
      getContractForOrder(cfoCtx, { accountId: built.accountId, entityId, asOfDate: TODAY_ISO }, deps),
      ContractNotActiveError,
    );
    expect((error as unknown as { status: string }).status).toBe('expired');
  });

  it.each(['draft', 'signed', 'suspended'] as const)(
    'Scenario: An order against a %s contract is rejected the same way',
    async (target) => {
      const built = await buildContractToStatus(target);
      const error = await expectRejectsWith(
        getContractForOrder(cfoCtx, { accountId: built.accountId, entityId, asOfDate: TODAY_ISO }, deps),
        ContractNotActiveError,
      );
      expect((error as unknown as { status: string }).status).toBe(target);
    },
  );

  it('Scenario: A contract cannot expire before its end date', async () => {
    const built = await buildContractToStatus('active', { endDate: TOMORROW_ISO });
    await expectRejectsWith(
      expireContract(cfoCtx, { contractId: built.contractId, expectedVersion: built.version, correlationId: nextCorrelationId() }, deps),
      ContractNotYetExpirableError,
    );
    expect((await getContract(built.contractId)).status).toBe('active');
  });

  it('Scenario: Suspend and resume', async () => {
    const built = await buildContractToStatus('active');
    const suspended = await suspendContract(
      cfoCtx,
      { contractId: built.contractId, expectedVersion: built.version, correlationId: nextCorrelationId() },
      deps,
    );
    // pg-reviewer fix round 2, finding 7: tightened from `toBeGreaterThan` to the EXACT expected
    // value — every mutating command bumps the version by exactly 1 (never more, never a gap).
    expect(suspended.version).toBe(built.version + 1);
    expect((await getContract(built.contractId)).status).toBe('suspended');

    const resumed = await resumeContract(
      cfoCtx,
      { contractId: built.contractId, expectedVersion: suspended.version, correlationId: nextCorrelationId() },
      deps,
    );
    expect(resumed.version).toBe(built.version + 2);
    expect((await getContract(built.contractId)).status).toBe('active');
  });

  it('Scenario: Adding an SLA line requires sla_enabled', async () => {
    const built = await buildContractToStatus('draft'); // slaEnabled defaults false.
    await expectRejectsWith(
      addContractSla(
        cfoCtx,
        {
          contractId: built.contractId,
          expectedVersion: built.version,
          metric: SLA_METRIC_OTD_PCT,
          targetValue: SLA_TARGET_VALUE,
          direction: SLA_DIRECTION_MIN,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      SlaNotEnabledError,
    );
    expect(await getSlaRows(built.contractId)).toHaveLength(0);
  });

  it('Scenario: Adding a valid SLA line', async () => {
    const accountId = await insertQualifiedAccount({ segmentId });
    const created = await createDraftContract({ accountId, slaEnabled: true });
    const added = await addContractSla(
      cfoCtx,
      {
        contractId: created.contractId,
        expectedVersion: created.version,
        metric: SLA_METRIC_OTD_PCT,
        targetValue: SLA_TARGET_VALUE,
        direction: SLA_DIRECTION_MIN,
        correlationId: nextCorrelationId(),
      },
      deps,
    );
    expect(added.slaId).toBeTruthy();
    const rows = await getSlaRows(created.contractId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metric).toBe(SLA_METRIC_OTD_PCT);
  });

  it('Scenario: An unrecognised SLA metric is rejected at the contract boundary', () => {
    expect(() =>
      AddContractSlaInputSchema.parse({
        contractId: randomUUID(),
        expectedVersion: 1,
        metric: SLA_UNRECOGNISED_METRIC,
        targetValue: SLA_TARGET_VALUE,
        direction: SLA_DIRECTION_MIN,
        correlationId: randomUUID(),
      }),
    ).toThrow();
  });

  it('Scenario: Billing flags default OFF and are settable at creation', async () => {
    const accountId = await insertQualifiedAccount({ segmentId });
    const created = await createDraftContract({ accountId, billsFailedAttempt: true });
    const row = await getContract(created.contractId);
    expect(row.bills_failed_attempt).toBe(true);
    expect(row.bills_return).toBe(false);
    expect(row.bills_waiting).toBe(false);
    expect(row.bills_reschedule).toBe(false);
    expect(row.bills_partial_delivery).toBe(false);
  });

  it('Scenario: Stale version is rejected on every mutating command', async () => {
    const accountId = await insertQualifiedAccount({ segmentId });
    const created = await createDraftContract({ accountId });
    const staleVersion = created.version + 5;

    await expectRejectsWith(
      signContract(
        cfoCtx,
        { contractId: created.contractId, expectedVersion: staleVersion, signedByClient: 'x', correlationId: nextCorrelationId() },
        deps,
      ),
      StaleVersionError,
    );
    expect((await getContract(created.contractId)).status).toBe('draft');
    expect((await getContract(created.contractId)).version).toBe(created.version);

    await expectRejectsWith(
      setContractPriceList(
        cfoCtx,
        { contractId: created.contractId, expectedVersion: staleVersion, priceListId: segmentPriceListId, correlationId: nextCorrelationId() },
        deps,
      ),
      StaleVersionError,
    );
    expect((await getContract(created.contractId)).price_list_id).toBeNull();
  });

  it('Scenario (broadened, mirrors WBS 1.6 finding 14): a stale expectedVersion on ActivateContract/SuspendContract/ResumeContract/ExpireContract/AddContractSla is rejected, status unchanged', async () => {
    const signedContract = await buildContractToStatus('signed');
    const pricedForActivate = await setContractPriceList(
      cfoCtx,
      { contractId: signedContract.contractId, expectedVersion: signedContract.version, priceListId: segmentPriceListId, correlationId: nextCorrelationId() },
      deps,
    );
    await expectRejectsWith(
      activateContract(cfoCtx, { contractId: signedContract.contractId, expectedVersion: pricedForActivate.version + 5, correlationId: nextCorrelationId() }, deps),
      StaleVersionError,
    );
    expect((await getContract(signedContract.contractId)).status).toBe('signed');

    const activeContract = await buildContractToStatus('active');
    await expectRejectsWith(
      suspendContract(cfoCtx, { contractId: activeContract.contractId, expectedVersion: activeContract.version + 5, correlationId: nextCorrelationId() }, deps),
      StaleVersionError,
    );
    expect((await getContract(activeContract.contractId)).status).toBe('active');

    const suspendedContract = await buildContractToStatus('suspended');
    await expectRejectsWith(
      resumeContract(cfoCtx, { contractId: suspendedContract.contractId, expectedVersion: suspendedContract.version + 5, correlationId: nextCorrelationId() }, deps),
      StaleVersionError,
    );
    expect((await getContract(suspendedContract.contractId)).status).toBe('suspended');

    const expirableContract = await buildContractToStatus('active', { endDate: YESTERDAY_ISO });
    await expectRejectsWith(
      expireContract(cfoCtx, { contractId: expirableContract.contractId, expectedVersion: expirableContract.version + 5, correlationId: nextCorrelationId() }, deps),
      StaleVersionError,
    );
    expect((await getContract(expirableContract.contractId)).status).toBe('active');

    const slaContractAccount = await insertQualifiedAccount({ segmentId });
    const slaContract = await createDraftContract({ accountId: slaContractAccount, slaEnabled: true });
    await expectRejectsWith(
      addContractSla(
        cfoCtx,
        {
          contractId: slaContract.contractId,
          expectedVersion: slaContract.version + 5,
          metric: SLA_METRIC_OTD_PCT,
          targetValue: SLA_TARGET_VALUE,
          direction: SLA_DIRECTION_MIN,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      StaleVersionError,
    );
    expect(await getSlaRows(slaContract.contractId)).toHaveLength(0);
  });

  it('Scenario: An unqualified account is rejected at creation', async () => {
    await expectRejectsWith(createDraftContract({ accountId: accountIdUnqualified }), AccountNotQualifiedError);
  });

  it('Scenario: Idempotent replay and conflicting replay', async () => {
    const accountId = await insertQualifiedAccount({ segmentId });
    const idempotencyKey = randomUUID();
    const body = {
      entityId,
      accountId,
      quoteId: null,
      title: 'عقد اختبار الإعادة — WBS 1.7',
      startDate: TODAY_ISO,
      endDate: null,
      correlationId: randomUUID(),
    };
    const idem = idemFor('create-contract', idempotencyKey, body);

    const first = await createContract(cfoCtx, { ...body, idem }, deps);
    fixtureContractIds.push(first.contractId);
    const second = await createContract(cfoCtx, { ...body, idem }, deps);
    expect(second).toEqual(first);

    const countResult: QueryResult<{ n: string }> = await pool.query(`select count(*)::text as n from sales.contracts where id = $1`, [first.contractId]);
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(1);

    const differentBody = { ...body, correlationId: randomUUID(), title: 'عنوان مختلف' };
    await expectRejectsWith(
      createContract(cfoCtx, { ...differentBody, idem: idemFor('create-contract', idempotencyKey, differentBody) }, deps),
      IdempotencyConflictError,
    );
  });

  it('Scenario: RLS — a caller scoped to another entity cannot see or write the contract', async () => {
    const accountId = await insertQualifiedAccount({ segmentId });
    const created = await createDraftContract({ accountId });
    await expectRejectsWith(
      signContract(
        outsiderCtx,
        { contractId: created.contractId, expectedVersion: created.version, signedByClient: 'x', correlationId: nextCorrelationId() },
        deps,
      ),
      ContractNotFoundError,
    );
    expect((await getContract(created.contractId)).version).toBe(created.version);
    expect((await getContract(created.contractId)).status).toBe('draft');
  });
});

// --- additional Master-decision assertions not already covered by a named Gherkin scenario --------

describe('Master decision 2 — a cross-entity/missing account is invisible at creation (AccountNotFoundError)', () => {
  it('CreateContract for an accountId that does not exist throws AccountNotFoundError, never leaked as AccountNotQualifiedError', async () => {
    await expectRejectsWith(createDraftContract({ accountId: randomUUID() }), AccountNotFoundError);
  });
});

describe('Master decision 2 — startDate/endDate validation', () => {
  it('a startDate before today throws InvalidStartDateError', async () => {
    const accountId = await insertQualifiedAccount({ segmentId });
    await expectRejectsWith(createDraftContract({ accountId, startDate: PAST_DATE_ISO }), InvalidStartDateError);
  });

  it('an endDate before startDate throws InvalidEndDateError', async () => {
    const accountId = await insertQualifiedAccount({ segmentId });
    await expectRejectsWith(createDraftContract({ accountId, startDate: TODAY_ISO, endDate: YESTERDAY_ISO }), InvalidEndDateError);
  });
});

describe('Master decision 11 — a missing ctx.userId throws MissingActorError, never writes a null actor', () => {
  it('CreateContract with ctx.userId null throws MissingActorError', async () => {
    const noActorCtx = { userId: null as unknown as string, clientId: null, isInternal: true };
    const accountId = await insertQualifiedAccount({ segmentId });
    await expectRejectsWith(
      createContract(
        noActorCtx,
        {
          entityId,
          accountId,
          quoteId: null,
          title: 'عقد اختبار — بلا ممثل',
          startDate: TODAY_ISO,
          endDate: null,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      MissingActorError,
    );
  });
});

describe('a missing contractId throws ContractNotFoundError (not RLS-related)', () => {
  it('SignContract on a random, never-existing contractId throws ContractNotFoundError', async () => {
    await expectRejectsWith(
      signContract(cfoCtx, { contractId: randomUUID(), expectedVersion: 1, signedByClient: 'x', correlationId: nextCorrelationId() }, deps),
      ContractNotFoundError,
    );
  });
});

describe('Master decision 4 — an illegal transition is a typed IllegalTransitionError', () => {
  it('ActivateContract on a still-draft contract (never signed) throws IllegalTransitionError', async () => {
    const accountId = await insertQualifiedAccount({ segmentId });
    const created = await createDraftContract({ accountId });
    await setContractPriceList(
      cfoCtx,
      { contractId: created.contractId, expectedVersion: created.version, priceListId: segmentPriceListId, correlationId: nextCorrelationId() },
      deps,
    );
    await expectRejectsWith(
      activateContract(cfoCtx, { contractId: created.contractId, expectedVersion: created.version + 1, correlationId: nextCorrelationId() }, deps),
      IllegalTransitionError,
    );
  });
});

// --- pg-reviewer fix round 2 — new coverage (findings 2/5) -----------------------------------------

describe('pg-reviewer fix round 2, finding 2 — an active contract past its own end_date is ContractExpiredByDateError, not silently usable', () => {
  it('getContractForOrder on a status="active" row whose end_date already passed asOfDate (never run through ExpireContract) rejects with ContractExpiredByDateError, not ContractNotActiveError', async () => {
    const accountId = await insertQualifiedAccount({ segmentId });
    const aged = await insertRawContractAtStatus(accountId, 'active', {
      startDate: AGED_FIXTURE_START_DATE_ISO,
      endDate: YESTERDAY_ISO,
      priceListId: segmentPriceListId,
    });

    const error = await expectRejectsWith(
      getContractForOrder(cfoCtx, { accountId, entityId, asOfDate: TODAY_ISO }, deps),
      ContractExpiredByDateError,
    );
    expect(error.contractId).toBe(aged.contractId);
    expect(error.endDate).toBe(YESTERDAY_ISO);
    // The row itself is untouched — this is a READ-time check, not a status transition.
    expect((await getContract(aged.contractId)).status).toBe('active');
  });
});

describe('pg-reviewer fix round 2, finding 5 — AddContractSla on a terminated contract is rejected', () => {
  it('AddContractSla on a status="terminated" row (fixture-only — no command reaches this status) throws IllegalTransitionError, no sales.contract_sla row written', async () => {
    const accountId = await insertQualifiedAccount({ segmentId });
    const terminated = await insertRawContractAtStatus(accountId, 'terminated', {
      startDate: AGED_FIXTURE_START_DATE_ISO,
      endDate: null,
      slaEnabled: true,
    });

    await expectRejectsWith(
      addContractSla(
        cfoCtx,
        {
          contractId: terminated.contractId,
          expectedVersion: terminated.version,
          metric: SLA_METRIC_OTD_PCT,
          targetValue: SLA_TARGET_VALUE,
          direction: SLA_DIRECTION_MIN,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      IllegalTransitionError,
    );
    expect(await getSlaRows(terminated.contractId)).toHaveLength(0);
  });
});

describe('pg-reviewer fix round 2, finding 5 — SetContractPriceList on an expired contract is rejected', () => {
  it('SetContractPriceList on an already-expired contract throws IllegalTransitionError, price_list_id unchanged', async () => {
    const expiredContract = await buildContractToStatus('expired', { endDate: YESTERDAY_ISO });
    await expectRejectsWith(
      setContractPriceList(
        cfoCtx,
        { contractId: expiredContract.contractId, expectedVersion: expiredContract.version, priceListId: segmentPriceListId, correlationId: nextCorrelationId() },
        deps,
      ),
      IllegalTransitionError,
    );
    expect((await getContract(expiredContract.contractId)).price_list_id).toBe(segmentPriceListId);
  });
});

// --- pg-reviewer fix round 3, finding 1 — assertPriceListApplicable's three NEW conditions were
// previously untestable (every fixture price list was active + non-internal, with no varying
// segment) — `insertPriceList` now accepts `isInternal`/`status`, and each condition below is
// exercised on its own, confirming price_list_id is left unchanged (the write never happened). ----

describe("pg-reviewer fix round 3, finding 1 — SetContractPriceList's scoping check rejects internal / wrong-segment / non-active price lists", () => {
  it('an internal (transfer-pricing) price list is rejected with PriceListNotApplicableError', async () => {
    const accountId = await insertQualifiedAccount({ segmentId });
    const created = await createDraftContract({ accountId });
    const internalPriceListId = await insertPriceList({ segmentId, isInternal: true });

    await expectRejectsWith(
      setContractPriceList(
        cfoCtx,
        { contractId: created.contractId, expectedVersion: created.version, priceListId: internalPriceListId, correlationId: nextCorrelationId() },
        deps,
      ),
      PriceListNotApplicableError,
    );
    expect((await getContract(created.contractId)).price_list_id).toBeNull();
  });

  it("a price list scoped to a DIFFERENT segment than the account's own is rejected with PriceListNotApplicableError", async () => {
    const accountId = await insertQualifiedAccount({ segmentId });
    const created = await createDraftContract({ accountId });
    const differentSegmentPriceListId = await insertPriceList({ segmentId: otherSegmentId });

    await expectRejectsWith(
      setContractPriceList(
        cfoCtx,
        { contractId: created.contractId, expectedVersion: created.version, priceListId: differentSegmentPriceListId, correlationId: nextCorrelationId() },
        deps,
      ),
      PriceListNotApplicableError,
    );
    expect((await getContract(created.contractId)).price_list_id).toBeNull();
  });

  it.each(['draft', 'expired'])('a price list with status="%s" (not active) is rejected with PriceListNotApplicableError', async (status) => {
    const accountId = await insertQualifiedAccount({ segmentId });
    const created = await createDraftContract({ accountId });
    const notActivePriceListId = await insertPriceList({ segmentId, status });

    await expectRejectsWith(
      setContractPriceList(
        cfoCtx,
        { contractId: created.contractId, expectedVersion: created.version, priceListId: notActivePriceListId, correlationId: nextCorrelationId() },
        deps,
      ),
      PriceListNotApplicableError,
    );
    expect((await getContract(created.contractId)).price_list_id).toBeNull();
  });
});
