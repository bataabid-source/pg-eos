// modules/catalog/tests/maintain-price-list/maintain-price-list.test.ts — WBS 1.2, M03 catalog.
//
// Integration tests, one `it` per scenario in ./maintain-price-list.feature, against the real
// database as pgeos_app. Sources: docs/package/40-Build-Specification-EN.md §C1,
// .claude/briefs/catalog.brief.md, docs/notes/slice-briefs/_slice-1.2.brief.md.
//
// CHOSEN RESULT SHAPES (pg-backend implements exactly these — brief instruction):
//   createPriceList(ctx, input, deps)        -> Promise<{ priceListId: string; version: number }>
//   upsertPriceListLine(ctx, input, deps)     -> Promise<{ version: number; lineId: string }>
//   importPriceListLines(ctx, input, deps)    -> Promise<{ version: number; lineCount: number }>
//   activatePriceList(ctx, input, deps)       -> Promise<{ version: number }>
//   expirePriceList(ctx, input, deps)         -> Promise<{ version: number }>
//   grantPriceException(ctx, input, deps)     -> Promise<{ exceptionId: string }>
// Every command input carries `correlationId`; every list-mutating command (all but
// CreatePriceList and GrantPriceException) carries `expectedVersion`. `idem?: IdempotencyInput` is
// an optional extra field on every write command's input (golden pattern — see
// modules/wms/application/receive-inbound/approve-inbound.ts's own `ApproveInboundInput.idem`).
//
// PriceBelowFloorError (Master decision 4) — public readonly fields this suite reads after
// `instanceof` narrowing: `serviceCode: string`, `price: string`, `minPrice: string`,
// `rowIndex?: number` (present only when thrown from ImportPriceListLines, one-based? NO —
// zero-based: "row 2" in the Gherkin is rowIndex 1, matching the rows array's own index).
//
// DEFAULT TAKEN (batched, not re-argued): GrantPriceExceptionInput identifies the service by
// `serviceId` (uuid), not `serviceCode` — the slice brief's "service by code" note is scoped
// explicitly to UpsertPriceListLine/ImportPriceListLines ("the import's natural key"); decision 9
// does not repeat that requirement for GrantPriceException, and the min_price read it describes
// ("services.min_price read in the same transaction") needs no code->id resolution pg-tester can
// see justified elsewhere. Reported as an open question in the closing report.
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only) plus real
// identity.users/user_entities/user_roles rows, same as modules/wms/tests/receive-inbound/
// receive-inbound.test.ts. PG_APP_USER=pgeos_app is REQUIRED to run this suite (every command call
// goes through withContext(ctx, fn) as pgeos_app, genuinely subject to RLS).
// platform.audit_log rows are NEVER deleted. ST-01/HD-04's min_price/standard_cost are set here via
// the admin pool and restored to NULL in afterAll — OF-01 is left NULL throughout (Background).

import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, Quantity, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IdempotencyConflictError, type IdempotencyInput } from '@pg-eos/db';

import {
  activatePriceList,
  createPriceList,
  expirePriceList,
  grantPriceException,
  importPriceListLines,
  upsertPriceListLine,
} from '../../application/maintain-price-list/index.js';
import { createMaintainPriceListDeps } from '../../api/maintain-price-list/composition.js';
import {
  CurrencyMismatchError,
  EmptyPriceListError,
  IllegalTransitionError,
  InvalidValidityError,
  PriceBelowFloorError,
  PriceListLockedError,
  PriceListNotFoundError,
  RoleRequiredError,
  SegmentAndClientError,
  ServiceNotFoundError,
  ServiceNotPriceableError,
  StaleVersionError,
  TierLadderError,
} from '../../domain/maintain-price-list/errors.js';
import { UpsertPriceListLineInputSchema } from '@pg-eos/contracts/catalog/maintain-price-list';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';
import { handleUpsertPriceListLine, type ApiRequest } from '../../api/maintain-price-list/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

// --- literals, each cited to the schema fact, decision or brief line they come from -------------

const ENTITY_CODE_PST = 'PST';
const SEGMENT_CODE_SEG_A = 'SEG-A';
const SERVICE_CODE_ST01 = 'ST-01';
const SERVICE_CODE_HD04 = 'HD-04';
const SERVICE_CODE_OF01 = 'OF-01'; // Background: min_price left NULL throughout (INV-C1-1 fixture).

// 13B-Schema-Reference-Consolidation.sql:2815 — catalog.min_price_markup_pct = 15;
// min_price = standard_cost * 1.15 (EXEC §1.1). Fixture-only values, not the human data gate.
const ST01_STANDARD_COST = '100.000';
const ST01_MIN_PRICE = '115.000';
const HD04_STANDARD_COST = '50.000';
const HD04_MIN_PRICE = '57.500';

const PRICE_STEP = '0.001'; // numeric(14,3) smallest step.
const CURRENCY_KWD = 'KWD'; // Master decision 4 default currency.

const ROLE_CFO = 'CFO';
const ROLE_GM = 'GM';
const ROLE_SALES_MGR = 'SALES_MGR';

const CFO_ACTOR_UUID = '00000000-0000-4000-8000-000000012101';
const GM_ACTOR_UUID = '00000000-0000-4000-8000-000000012102';
const SALES_MGR_ACTOR_UUID = '00000000-0000-4000-8000-000000012103';
const OUTSIDER_CFO_ACTOR_UUID = '00000000-0000-4000-8000-000000012104'; // RLS: no user_entities row for PST.

const clock = new FixedClock(new Date('2026-09-24T00:00:00.000Z'));
const TODAY_ISO = '2026-09-24';
const FUTURE_VALID_FROM = '2026-10-24'; // TODAY_ISO + 30 days (fix round 1, F4).
const ids = new SequentialIdGenerator(1201);
const deps = createMaintainPriceListDeps({ clock, ids });

const cfoCtx = { userId: CFO_ACTOR_UUID, clientId: null, isInternal: true };
const gmCtx = { userId: GM_ACTOR_UUID, clientId: null, isInternal: true };
const salesMgrCtx = { userId: SALES_MGR_ACTOR_UUID, clientId: null, isInternal: true };
const outsiderCfoCtx = { userId: OUTSIDER_CFO_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
let otherEntityId: string;
let segmentIdSegA: string;
let serviceIdSt01: string;

const usedCorrelationIds = new Set<string>();
const fixtureListIds: string[] = [];

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

/** sha256 hex of the canonical JSON body — matches `idempotency_keys_request_hash_check
 *  (request_hash ~ '^[0-9a-f]{64}$')` (database schema CHECK). A different `body` (the conflicting
 *  replay scenario) hashes to a different digest, exactly as `withIdempotentContext`
 *  (packages/db/src/idempotency.ts) requires to distinguish a replay from a conflict. Golden
 *  pattern — modules/wms/tests/receive-inbound/receive-inbound.test.ts's own `idemFor`. */
function idemFor(endpoint: string, key: string, body: unknown): IdempotencyInput {
  return {
    key,
    endpoint: `catalog.maintain-price-list.${endpoint}`,
    requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    entityId: null,
    successStatus: 200,
  };
}

async function insertDraftPriceList(opts: {
  readonly code: string;
  readonly segmentId?: string | null;
  readonly clientId?: string | null;
  readonly validFrom?: string;
}): Promise<{ id: string; version: number }> {
  const result: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into catalog.price_lists (entity_id, code, name_ar, segment_id, client_id, valid_from, is_internal, status)
     values ($1, $2, $3, $4, $5, $6, false, 'draft') returning id, version`,
    [entityId, opts.code, `قائمة تسعير اختبار ${opts.code}`, opts.segmentId ?? null, opts.clientId ?? null, opts.validFrom ?? '2026-01-01'],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture catalog.price_lists insert returned no row');
  fixtureListIds.push(row.id);
  return row;
}

async function getPriceList(priceListId: string): Promise<{ status: string; version: number; valid_to: string | null }> {
  const result: QueryResult<{ status: string; version: number; valid_to: string | null }> = await pool.query(
    `select status, version, valid_to::text as valid_to from catalog.price_lists where id = $1`,
    [priceListId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no catalog.price_lists row for id ${priceListId}`);
  return row;
}

async function getLines(priceListId: string): Promise<Array<{ id: string; service_id: string; price: string }>> {
  const result: QueryResult<{ id: string; service_id: string; price: string }> = await pool.query(
    `select id, service_id, price::text as price from catalog.price_list_lines where price_list_id = $1 order by tier_from nulls first`,
    [priceListId],
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
    [userId, `_pricelist_fixture_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار قوائم الأسعار — WBS 1.2'],
  );
  for (const eid of entityIds) {
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, eid]);
  }
}

/** Narrows `error` to `E` after asserting `instanceof`, so field access below stays type-safe
 *  (no `any`/cast) — mirrors the golden suites' `.rejects.toBeInstanceOf` but returns the error for
 *  field inspection (PriceBelowFloorError.rowIndex etc). */
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
  const entityResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, [ENTITY_CODE_PST]);
  entityId = (entityResult.rows[0] as { id: string }).id;

  const otherEntityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code <> $1 limit 1`,
    [ENTITY_CODE_PST],
  );
  otherEntityId = (otherEntityResult.rows[0] as { id: string }).id;

  const segmentResult: QueryResult<{ id: string }> = await pool.query(`select id from catalog.segments where code = $1`, [SEGMENT_CODE_SEG_A]);
  segmentIdSegA = (segmentResult.rows[0] as { id: string }).id;

  const serviceStResult: QueryResult<{ id: string }> = await pool.query(`select id from catalog.services where code = $1`, [SERVICE_CODE_ST01]);
  serviceIdSt01 = (serviceStResult.rows[0] as { id: string }).id;

  // Background: seed ST-01/HD-04 floors via the admin pool (human data gate 1.3 stand-in for this
  // slice's fixture) — OF-01 is left untouched (min_price stays NULL, seeded that way).
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

  await createFixtureActor(CFO_ACTOR_UUID, [entityId]);
  await createFixtureActor(GM_ACTOR_UUID, [entityId]);
  await createFixtureActor(SALES_MGR_ACTOR_UUID, [entityId]);
  await createFixtureActor(OUTSIDER_CFO_ACTOR_UUID, [otherEntityId]); // deliberately NOT entityId (PST).

  await grantRole(CFO_ACTOR_UUID, ROLE_CFO);
  await grantRole(GM_ACTOR_UUID, ROLE_GM);
  await grantRole(SALES_MGR_ACTOR_UUID, ROLE_SALES_MGR);
  await grantRole(OUTSIDER_CFO_ACTOR_UUID, ROLE_CFO);
});

afterAll(async () => {
  // OF-01 was never touched; ST-01/HD-04 restored to NULL (Background — never leave fixture data
  // behind that a later slice might mistake for the real data-gate 1.3 floors).
  await pool.query(`update catalog.services set min_price = null, standard_cost = null where code in ($1, $2)`, [
    SERVICE_CODE_ST01,
    SERVICE_CODE_HD04,
  ]);

  if (usedCorrelationIds.size > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [[...usedCorrelationIds]]);
  }
  if (fixtureListIds.length > 0) {
    await pool.query(`delete from catalog.price_list_lines where price_list_id = any($1::uuid[])`, [fixtureListIds]);
    await pool.query(`delete from catalog.price_lists where id = any($1::uuid[])`, [fixtureListIds]);
  }
  await pool.query(`delete from catalog.price_exceptions where entity_id = $1 and approved_by = $2`, [entityId, GM_ACTOR_UUID]);

  for (const userId of [CFO_ACTOR_UUID, GM_ACTOR_UUID, SALES_MGR_ACTOR_UUID, OUTSIDER_CFO_ACTOR_UUID]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
});

// --- contract stub: A3 "never price at zero" is enforced at the contract, not the domain --------

describe('@pg-eos/contracts/catalog/maintain-price-list — A3 "never price at zero"', () => {
  it('UpsertPriceListLineInputSchema rejects price "0" and "-1" (never reaches the domain)', () => {
    const base = {
      priceListId: randomUUID(),
      serviceCode: SERVICE_CODE_ST01,
      expectedVersion: 1,
      correlationId: randomUUID(),
    };
    expect(() => UpsertPriceListLineInputSchema.parse({ ...base, price: '0' })).toThrow();
    expect(() => UpsertPriceListLineInputSchema.parse({ ...base, price: '-1' })).toThrow();
    expect(() => UpsertPriceListLineInputSchema.parse({ ...base, price: '1.000' })).not.toThrow();
  });
});

// --- the Gherkin scenarios, in the feature file's order — a continuing narrative on ONE list -----

describe('Feature: Maintain price list (WBS 1.2, M03 catalog)', () => {
  let mainListId: string;
  let mainListVersion: number;
  let mainLineId: string;

  it('Scenario: Create a draft segment price list', async () => {
    const correlationId = nextCorrelationId();
    const result = await createPriceList(
      cfoCtx,
      {
        entityId,
        code: 'PL-SEG-A-2026',
        nameAr: 'قائمة تسعير الشريحة أ 2026',
        segmentId: segmentIdSegA,
        validFrom: '2026-01-01',
        validTo: null,
        isInternal: false,
        correlationId,
      },
      deps,
    );
    expect(result.version).toBe(1);
    mainListId = result.priceListId;
    mainListVersion = result.version;
    fixtureListIds.push(mainListId);

    const row = await getPriceList(mainListId);
    expect(row.status).toBe('draft');
    expect(row.version).toBe(1);
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
  });

  it('Scenario: A line at or above the floor is accepted and bumps the list version', async () => {
    const correlationId = nextCorrelationId();
    const result = await upsertPriceListLine(
      cfoCtx,
      {
        priceListId: mainListId,
        serviceCode: SERVICE_CODE_ST01,
        price: ST01_MIN_PRICE,
        currency: CURRENCY_KWD,
        expectedVersion: mainListVersion,
        correlationId,
      },
      deps,
    );
    expect(result.version).toBe(mainListVersion + 1);
    mainListVersion = result.version;
    mainLineId = result.lineId;

    const lines = await getLines(mainListId);
    expect(lines.some((line) => line.id === mainLineId)).toBe(true);
    expect((await getPriceList(mainListId)).version).toBe(mainListVersion);
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
  });

  it('Scenario: A line below the floor is rejected from the API (acceptance)', async () => {
    const belowFloor = Quantity.of(ST01_MIN_PRICE).subtract(Quantity.of(PRICE_STEP)).toString();
    const versionBefore = mainListVersion;
    const linesBefore = await getLines(mainListId);

    const error = await expectRejectsWith(
      upsertPriceListLine(
        cfoCtx,
        {
          priceListId: mainListId,
          serviceCode: SERVICE_CODE_ST01,
          price: belowFloor,
          currency: CURRENCY_KWD,
          expectedVersion: mainListVersion,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      PriceBelowFloorError,
    );
    expect(error.minPrice).toBe(ST01_MIN_PRICE);
    expect(error.price).toBe(belowFloor);
    expect(error.serviceCode).toBe(SERVICE_CODE_ST01);

    expect((await getPriceList(mainListId)).version).toBe(versionBefore);
    expect(await getLines(mainListId)).toHaveLength(linesBefore.length);
  });

  it('Scenario: A zero price is rejected (A3 "never price at zero")', async () => {
    const list = await insertDraftPriceList({ code: `PL-ZEROPRICE-${randomUUID()}` });
    const request: ApiRequest<unknown> = {
      headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() },
      body: {
        priceListId: list.id,
        serviceCode: SERVICE_CODE_ST01,
        price: '0',
        currency: CURRENCY_KWD,
        expectedVersion: list.version,
        correlationId: nextCorrelationId(),
      },
      ctx: cfoCtx,
    };
    const result = await handleUpsertPriceListLine(request, deps);
    expect(result.status).toBe(400);
    expect(await getLines(list.id)).toHaveLength(0);
  });

  it('Scenario: A service without a floor cannot be priced (INV-C1-1)', async () => {
    const linesBefore = await getLines(mainListId);
    await expectRejectsWith(
      upsertPriceListLine(
        cfoCtx,
        {
          priceListId: mainListId,
          serviceCode: SERVICE_CODE_OF01,
          price: '10.000',
          currency: CURRENCY_KWD,
          expectedVersion: mainListVersion,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      ServiceNotPriceableError,
    );
    expect(await getLines(mainListId)).toHaveLength(linesBefore.length);
  });

  it('Scenario: Import — all rows at or above the floor succeed atomically', async () => {
    const importList = await insertDraftPriceList({ code: `PL-IMPORT-OK-${randomUUID()}` });
    const correlationId = nextCorrelationId();
    const result = await importPriceListLines(
      cfoCtx,
      {
        priceListId: importList.id,
        rows: [
          { serviceCode: SERVICE_CODE_ST01, price: ST01_MIN_PRICE, currency: CURRENCY_KWD },
          { serviceCode: SERVICE_CODE_HD04, price: HD04_MIN_PRICE, currency: CURRENCY_KWD, tierFrom: '0.000', tierTo: '100.000' },
          { serviceCode: SERVICE_CODE_HD04, price: HD04_MIN_PRICE, currency: CURRENCY_KWD, tierFrom: '100.000', tierTo: null },
        ],
        expectedVersion: importList.version,
        correlationId,
      },
      deps,
    );
    expect(result.lineCount).toBe(3);
    expect(result.version).toBe(importList.version + 1); // bumped exactly ONCE, not per row.
    expect(await getLines(importList.id)).toHaveLength(3);
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
  });

  it('Scenario: Import — one row below the floor rejects the whole import (acceptance)', async () => {
    const importList = await insertDraftPriceList({ code: `PL-IMPORT-BAD-${randomUUID()}` });
    const belowFloor = Quantity.of(HD04_MIN_PRICE).subtract(Quantity.of(PRICE_STEP)).toString();

    const error = await expectRejectsWith(
      importPriceListLines(
        cfoCtx,
        {
          priceListId: importList.id,
          rows: [
            { serviceCode: SERVICE_CODE_ST01, price: ST01_MIN_PRICE, currency: CURRENCY_KWD },
            { serviceCode: SERVICE_CODE_HD04, price: belowFloor, currency: CURRENCY_KWD, tierFrom: '0.000', tierTo: '100.000' },
            { serviceCode: SERVICE_CODE_HD04, price: HD04_MIN_PRICE, currency: CURRENCY_KWD, tierFrom: '100.000', tierTo: null },
          ],
          expectedVersion: importList.version,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      PriceBelowFloorError,
    );
    expect(error.rowIndex).toBe(1);
    expect(await getLines(importList.id)).toHaveLength(0);
    expect((await getPriceList(importList.id)).version).toBe(importList.version);
  });

  it('Scenario: A broken tier ladder is rejected (INV-C1-3)', async () => {
    const importList = await insertDraftPriceList({ code: `PL-IMPORT-GAP-${randomUUID()}` });
    await expectRejectsWith(
      importPriceListLines(
        cfoCtx,
        {
          priceListId: importList.id,
          rows: [
            { serviceCode: SERVICE_CODE_HD04, price: HD04_MIN_PRICE, currency: CURRENCY_KWD, tierFrom: '0.000', tierTo: '100.000' },
            { serviceCode: SERVICE_CODE_HD04, price: HD04_MIN_PRICE, currency: CURRENCY_KWD, tierFrom: '150.000', tierTo: null },
          ],
          expectedVersion: importList.version,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      TierLadderError,
    );
    expect(await getLines(importList.id)).toHaveLength(0);
  });

  it('Scenario: Re-upserting a flat line replaces it, never duplicates it', async () => {
    const list = await insertDraftPriceList({ code: `PL-REUPSERT-${randomUUID()}` });
    const priceP1 = ST01_MIN_PRICE;
    const priceP2 = Quantity.of(ST01_MIN_PRICE).add(Quantity.of('10.000')).toString();

    const first = await upsertPriceListLine(
      cfoCtx,
      {
        priceListId: list.id,
        serviceCode: SERVICE_CODE_ST01,
        price: priceP1,
        currency: CURRENCY_KWD,
        expectedVersion: list.version,
        correlationId: nextCorrelationId(),
      },
      deps,
    );

    const second = await upsertPriceListLine(
      cfoCtx,
      {
        priceListId: list.id,
        serviceCode: SERVICE_CODE_ST01,
        price: priceP2,
        currency: CURRENCY_KWD,
        expectedVersion: first.version,
        correlationId: nextCorrelationId(),
      },
      deps,
    );

    const st01Lines = (await getLines(list.id)).filter((line) => line.service_id === serviceIdSt01);
    expect(st01Lines).toHaveLength(1); // replaced in place, never duplicated.
    expect(st01Lines[0]?.price).toBe(priceP2);

    const activated = await activatePriceList(
      cfoCtx,
      { priceListId: list.id, expectedVersion: second.version, correlationId: nextCorrelationId() },
      deps,
    );
    expect(activated.version).toBeGreaterThan(second.version);
    expect((await getPriceList(list.id)).status).toBe('active');
  });

  it('Scenario: Activate a list with lines', async () => {
    const correlationId = nextCorrelationId();
    const result = await activatePriceList(
      cfoCtx,
      { priceListId: mainListId, expectedVersion: mainListVersion, correlationId },
      deps,
    );
    expect(result.version).toBe(mainListVersion + 1);
    mainListVersion = result.version;

    expect((await getPriceList(mainListId)).status).toBe('active');
    const activatedRows = await outboxRowsForCorrelationAndType(correlationId, 'catalog.price_list.activated');
    expect(activatedRows).toHaveLength(1);
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
  });

  it('Scenario: An empty list cannot be activated', async () => {
    const emptyList = await insertDraftPriceList({ code: `PL-EMPTY-${randomUUID()}` });
    await expectRejectsWith(
      activatePriceList(cfoCtx, { priceListId: emptyList.id, expectedVersion: emptyList.version, correlationId: nextCorrelationId() }, deps),
      EmptyPriceListError,
    );
    expect((await getPriceList(emptyList.id)).status).toBe('draft');
  });

  it('Scenario: Lines on an active list are refused', async () => {
    const linesBefore = await getLines(mainListId);
    await expectRejectsWith(
      upsertPriceListLine(
        cfoCtx,
        {
          priceListId: mainListId,
          serviceCode: SERVICE_CODE_HD04,
          price: HD04_MIN_PRICE,
          currency: CURRENCY_KWD,
          expectedVersion: mainListVersion,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      PriceListLockedError,
    );
    expect(await getLines(mainListId)).toHaveLength(linesBefore.length);
  });

  it('Scenario: Expire an active list', async () => {
    const result = await expirePriceList(
      cfoCtx,
      { priceListId: mainListId, expectedVersion: mainListVersion, correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.version).toBe(mainListVersion + 1);
    mainListVersion = result.version;

    const row = await getPriceList(mainListId);
    expect(row.status).toBe('expired');
    expect(row.valid_to).toBe(TODAY_ISO); // FixedClock — Master decision 8.
  });

  it('Scenario: Illegal transition', async () => {
    const draftList = await insertDraftPriceList({ code: `PL-ILLEGAL-${randomUUID()}` });
    await expectRejectsWith(
      expirePriceList(cfoCtx, { priceListId: draftList.id, expectedVersion: draftList.version, correlationId: nextCorrelationId() }, deps),
      IllegalTransitionError,
    );
    expect((await getPriceList(draftList.id)).status).toBe('draft');
  });

  it('Scenario: Expiring a list whose validFrom is after today is rejected', async () => {
    const futureList = await insertDraftPriceList({ code: `PL-FUTURE-${randomUUID()}`, validFrom: FUTURE_VALID_FROM });
    const withLine = await upsertPriceListLine(
      cfoCtx,
      {
        priceListId: futureList.id,
        serviceCode: SERVICE_CODE_ST01,
        price: ST01_MIN_PRICE,
        currency: CURRENCY_KWD,
        expectedVersion: futureList.version,
        correlationId: nextCorrelationId(),
      },
      deps,
    );
    const activated = await activatePriceList(
      cfoCtx,
      { priceListId: futureList.id, expectedVersion: withLine.version, correlationId: nextCorrelationId() },
      deps,
    );
    expect((await getPriceList(futureList.id)).status).toBe('active');

    await expectRejectsWith(
      expirePriceList(
        cfoCtx,
        { priceListId: futureList.id, expectedVersion: activated.version, correlationId: nextCorrelationId() },
        deps,
      ),
      InvalidValidityError,
    );
    expect((await getPriceList(futureList.id)).status).toBe('active');
  });

  it('Scenario: Stale version', async () => {
    const staleList = await insertDraftPriceList({ code: `PL-STALE-${randomUUID()}` });
    const staleVersion = staleList.version + 5; // deliberately stale for every mutating command below.

    await expectRejectsWith(
      upsertPriceListLine(
        cfoCtx,
        {
          priceListId: staleList.id,
          serviceCode: SERVICE_CODE_ST01,
          price: ST01_MIN_PRICE,
          currency: CURRENCY_KWD,
          expectedVersion: staleVersion,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      StaleVersionError,
    );
    expect((await getPriceList(staleList.id)).version).toBe(staleList.version);
    expect(await getLines(staleList.id)).toHaveLength(0);

    await expectRejectsWith(
      importPriceListLines(
        cfoCtx,
        {
          priceListId: staleList.id,
          rows: [{ serviceCode: SERVICE_CODE_ST01, price: ST01_MIN_PRICE, currency: CURRENCY_KWD }],
          expectedVersion: staleVersion,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      StaleVersionError,
    );
    expect((await getPriceList(staleList.id)).version).toBe(staleList.version);
    expect(await getLines(staleList.id)).toHaveLength(0);

    await expectRejectsWith(
      activatePriceList(
        cfoCtx,
        { priceListId: staleList.id, expectedVersion: staleVersion, correlationId: nextCorrelationId() },
        deps,
      ),
      StaleVersionError,
    );
    expect((await getPriceList(staleList.id)).status).toBe('draft');
    expect((await getPriceList(staleList.id)).version).toBe(staleList.version);

    await expectRejectsWith(
      expirePriceList(
        cfoCtx,
        { priceListId: staleList.id, expectedVersion: staleVersion, correlationId: nextCorrelationId() },
        deps,
      ),
      StaleVersionError,
    );
    expect((await getPriceList(staleList.id)).status).toBe('draft');
    expect((await getPriceList(staleList.id)).version).toBe(staleList.version);
  });

  it('Scenario: Role gate — SALES_MGR cannot write prices (INV-C1-4)', async () => {
    await expectRejectsWith(
      createPriceList(
        salesMgrCtx,
        {
          entityId,
          code: `PL-SALESMGR-${randomUUID()}`,
          nameAr: 'قائمة يرفضها مدير المبيعات',
          segmentId: null,
          clientId: null,
          validFrom: '2026-01-01',
          validTo: null,
          isInternal: false,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      RoleRequiredError,
    );

    const gateList = await insertDraftPriceList({ code: `PL-SALESMGR-LINE-${randomUUID()}` });
    await expectRejectsWith(
      upsertPriceListLine(
        salesMgrCtx,
        {
          priceListId: gateList.id,
          serviceCode: SERVICE_CODE_ST01,
          price: ST01_MIN_PRICE,
          currency: CURRENCY_KWD,
          expectedVersion: gateList.version,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      RoleRequiredError,
    );
    expect(await getLines(gateList.id)).toHaveLength(0);
  });

  it('Scenario: GM grants a price exception below the floor', async () => {
    const belowFloor = Quantity.of(ST01_MIN_PRICE).subtract(Quantity.of('1.000')).toString();
    const correlationId = nextCorrelationId();
    const clientId = randomUUID(); // bare uuid, no FK (Master decision 9).

    const result = await grantPriceException(
      gmCtx,
      {
        entityId,
        clientId,
        serviceId: serviceIdSt01,
        approvedPrice: belowFloor,
        reason: 'عميل استراتيجي — استثناء بموافقة المدير العام',
        validFrom: '2026-01-01',
        validTo: '2026-12-31',
        reviewAt: '2026-06-01',
        correlationId,
      },
      deps,
    );
    expect(result.exceptionId).toBeTruthy();

    const rowResult: QueryResult<{ min_price_at_approval: string; approved_by: string }> = await pool.query(
      `select min_price_at_approval::text as min_price_at_approval, approved_by::text as approved_by
         from catalog.price_exceptions where id = $1`,
      [result.exceptionId],
    );
    const row = rowResult.rows[0];
    expect(row?.min_price_at_approval).toBe(ST01_MIN_PRICE);
    expect(row?.approved_by).toBe(GM_ACTOR_UUID);

    const grantedRows = await outboxRowsForCorrelationAndType(correlationId, 'catalog.price_exception.granted');
    expect(grantedRows).toHaveLength(1);
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
  });

  it('Scenario: Only the GM grants exceptions', async () => {
    const clientId = randomUUID();
    await expectRejectsWith(
      grantPriceException(
        cfoCtx,
        {
          entityId,
          clientId,
          serviceId: serviceIdSt01,
          approvedPrice: '1.000',
          reason: 'محاولة رفضها الدور',
          validFrom: '2026-01-01',
          validTo: '2026-12-31',
          reviewAt: '2026-06-01',
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      RoleRequiredError,
    );
    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from catalog.price_exceptions where client_id = $1`,
      [clientId],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(0);
  });

  it('Scenario: Idempotent replay and conflicting replay', async () => {
    const idempotencyKey = randomUUID();
    const body = {
      entityId,
      code: `PL-IDEM-${randomUUID()}`,
      nameAr: 'قائمة اختبار المطابقة',
      segmentId: null,
      clientId: null,
      validFrom: '2026-01-01',
      validTo: null,
      isInternal: false,
      correlationId: randomUUID(),
    };
    const idem = idemFor('create-price-list', idempotencyKey, body);

    const first = await createPriceList(cfoCtx, { ...body, idem }, deps);
    fixtureListIds.push(first.priceListId);
    const second = await createPriceList(cfoCtx, { ...body, idem }, deps);
    expect(second).toEqual(first);

    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from catalog.price_lists where id = $1`,
      [first.priceListId],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(1); // exactly one row, one insert.

    const differentBody = { ...body, correlationId: randomUUID(), code: `PL-IDEM-DIFF-${randomUUID()}` };
    await expectRejectsWith(
      createPriceList(cfoCtx, { ...differentBody, idem: idemFor('create-price-list', idempotencyKey, differentBody) }, deps),
      IdempotencyConflictError,
    );
  });

  it('Scenario: RLS — a CFO scoped to another entity cannot see or write the PST list', async () => {
    const versionBefore = (await getPriceList(mainListId)).version;
    await expectRejectsWith(
      upsertPriceListLine(
        outsiderCfoCtx,
        {
          priceListId: mainListId,
          serviceCode: SERVICE_CODE_ST01,
          price: ST01_MIN_PRICE,
          currency: CURRENCY_KWD,
          expectedVersion: versionBefore,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      PriceListNotFoundError,
    );
    expect((await getPriceList(mainListId)).version).toBe(versionBefore);
  });
});

// --- additional Master-decision assertions not already covered by a named Gherkin scenario -------

describe('Master decision 4 — one currency per list, first line decides (default)', () => {
  it('a second line in a different currency throws CurrencyMismatchError', async () => {
    const list = await insertDraftPriceList({ code: `PL-CURRENCY-${randomUUID()}` });
    const first = await upsertPriceListLine(
      cfoCtx,
      {
        priceListId: list.id,
        serviceCode: SERVICE_CODE_ST01,
        price: ST01_MIN_PRICE,
        currency: CURRENCY_KWD,
        expectedVersion: list.version,
        correlationId: nextCorrelationId(),
      },
      deps,
    );
    await expectRejectsWith(
      upsertPriceListLine(
        cfoCtx,
        {
          priceListId: list.id,
          serviceCode: SERVICE_CODE_HD04,
          price: HD04_MIN_PRICE,
          currency: 'USD',
          expectedVersion: first.version,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      CurrencyMismatchError,
    );
  });
});

describe('Master decision 6 — at most one of segmentId/clientId, and an unknown service code', () => {
  it('CreatePriceList with both segmentId and clientId throws SegmentAndClientError', async () => {
    await expectRejectsWith(
      createPriceList(
        cfoCtx,
        {
          entityId,
          code: `PL-BOTH-${randomUUID()}`,
          nameAr: 'قائمة خاطئة',
          segmentId: segmentIdSegA,
          clientId: randomUUID(),
          validFrom: '2026-01-01',
          validTo: null,
          isInternal: false,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      SegmentAndClientError,
    );
  });

  it('CreatePriceList with validTo < validFrom throws InvalidValidityError', async () => {
    await expectRejectsWith(
      createPriceList(
        cfoCtx,
        {
          entityId,
          code: `PL-BADDATES-${randomUUID()}`,
          nameAr: 'قائمة تواريخ خاطئة',
          segmentId: null,
          clientId: null,
          validFrom: '2026-06-01',
          validTo: '2026-01-01',
          isInternal: false,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      InvalidValidityError,
    );
  });

  it('UpsertPriceListLine for an unknown serviceCode throws ServiceNotFoundError', async () => {
    const list = await insertDraftPriceList({ code: `PL-UNKNOWNSVC-${randomUUID()}` });
    await expectRejectsWith(
      upsertPriceListLine(
        cfoCtx,
        {
          priceListId: list.id,
          serviceCode: `NO-SUCH-SERVICE-${randomUUID()}`,
          price: '10.000',
          currency: CURRENCY_KWD,
          expectedVersion: list.version,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
      ServiceNotFoundError,
    );
  });
});
