// modules/platform/tests/maintain-site/maintain-site.test.ts — WBS 5.5a part 1 (lane 2).
//
// Integration tests, one per scenario in ./maintain-site.feature (except "An invalid kind is
// rejected at the contract", which is an API-layer test — see ./handlers.test.ts), against the
// real database as pgeos_app. Sources: docs/notes/slice-briefs/_slice-5.5a-part1.brief.md,
// .claude/briefs/platform.brief.md.
//
// This suite imports application/maintain-site/index.js, domain/maintain-site/errors.js,
// api/maintain-site/composition.js, and @pg-eos/contracts/platform/maintain-site. Migration 0015
// (database/migrations/0015_2_platform-sites.sql) is already applied locally: platform.sites
// carries `id, entity_id, kind, account_id, warehouse_id, name_ar, name_en, address, geo_lat,
// geo_lng, radius_m, contact_phone, is_active, version` (RLS entity_scope active).
//
// Expected application surface (brief D2, "Suggested" names):
//   createSite(ctx, CreateSiteInput, deps) -> { id, version, radiusM }
//   updateSite(ctx, UpdateSiteInput, deps) -> { id, version, isActive }
//
// CreateSiteInput (camelCase, no entityId, no performedBy):
//   { kind, accountId?, warehouseId?, nameAr, nameEn?, address?, geoLat?, geoLng?, radiusM?,
//     contactPhone?, correlationId, idem? }
// UpdateSiteInput:
//   { siteId, nameAr?, nameEn?, address?, geoLat?, geoLng?, radiusM?, contactPhone?, isActive?,
//     accountId?, warehouseId?, expectedVersion, correlationId, idem? }
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only) plus real
// identity.users/user_entities/user_roles rows, same as modules/hr/tests/register-employee/
// register-employee.test.ts and modules/wms/tests/receive-inbound/receive-inbound.test.ts.
// PG_APP_USER=pgeos_app is REQUIRED to run this suite (every command call goes through
// withContext(ctx, fn) as pgeos_app, genuinely subject to RLS). platform.audit_log rows are NEVER
// deleted.

import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IdempotencyConflictError, type IdempotencyInput } from '@pg-eos/db';

// The modules under test.
import { createSite, updateSite } from '../../application/maintain-site/index.js';
import { createMaintainSiteDeps } from '../../api/maintain-site/composition.js';
import {
  RoleRequiredError,
  SiteAccountRequiredError,
  SiteKindInvalidError,
  SiteNotFoundError,
  SiteRadiusInvalidError,
  StaleVersionError,
} from '../../domain/maintain-site/errors.js';
// the package subpath export (@pg-eos/contracts/platform/maintain-site), not a deep relative path.
import { CreateSiteInputSchema } from '@pg-eos/contracts/platform/maintain-site';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

// --- literals ------------------------------------------------------------------------------------

const OPS_DIR_ROLE_CODE = 'OPS_DIR';
const HR_MGR_ROLE_CODE = 'HR_MGR';
const WH_OP_ROLE_CODE = 'WH_OP';

const SITE_CREATED_EVENT_TYPE = 'platform.site.created';
const SITE_UPDATED_EVENT_TYPE = 'platform.site.updated';

const GEOFENCE_RADIUS_DEFAULT_M = 500; // platform.thresholds key att.geofence_radius_m (migration 0015).

const OPS_DIR_ACTOR_UUID = '00000000-0000-4000-8000-0000000505a1';
const HR_MGR_ACTOR_UUID = '00000000-0000-4000-8000-0000000505a2';
const NO_ROLE_ACTOR_UUID = '00000000-0000-4000-8000-0000000505a3';

const clock = new FixedClock(new Date('2026-09-24T00:00:00.000Z'));
const ids = new SequentialIdGenerator(505);
const deps = createMaintainSiteDeps({ clock, ids });

const opsDirCtx = { userId: OPS_DIR_ACTOR_UUID, clientId: null, isInternal: true };
const hrMgrCtx = { userId: HR_MGR_ACTOR_UUID, clientId: null, isInternal: true };
const noRoleCtx = { userId: NO_ROLE_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
const fixtureSiteIds: string[] = [];
const fixtureAccountIds: string[] = [];
const usedCorrelationIds = new Set<string>();
let nameCounter = 0;

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

function uniqueName(): string {
  nameCounter += 1;
  return `موقع اختبار 5.5a رقم ${nameCounter}`;
}

async function grantRole(userId: string, roleCode: string): Promise<void> {
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [
    roleCode,
  ]);
  const roleId = roleResult.rows[0]?.id;
  if (!roleId) throw new Error(`identity.roles row not found for code ${roleCode}`);
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [userId, roleId]);
}

async function createFixtureActor(userId: string, forEntityId: string): Promise<void> {
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
  await pool.query(`delete from identity.users where id = $1`, [userId]);
  await pool.query(`insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`, [
    userId,
    `_maintainsite_fixture_${userId}_${randomUUID()}@test.invalid`,
    'ممثل اختبار صيانة المواقع — WBS 5.5a',
  ]);
  await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, forEntityId]);
}

/** admin-pool direct insert of a sales.accounts row — used ONLY as fixture data for the
 *  client_pickup + account scenario (sales.accounts is not entity-scoped, 01-Data-Model.sql:420). */
async function insertAccountDirect(): Promise<string> {
  nameCounter += 1;
  const code = `ACCT-5.5a-${nameCounter}-${Date.now()}`;
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [code, 'حساب اختبار 5.5a'],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture sales.accounts insert returned no row');
  fixtureAccountIds.push(row.id);
  return row.id;
}

/** admin-pool direct insert of a platform.sites row, bypassing the command under test — used ONLY
 *  to set up a fixture site for a scenario that starts mid-flow (e.g. an update against an
 *  already-existing site). Selects `version` (platform.sites.version). */
async function insertSiteDirect(forEntityId: string, kind = 'warehouse'): Promise<{ id: string; version: number }> {
  const result: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into platform.sites (entity_id, kind, name_ar) values ($1, $2, $3) returning id, version`,
    [forEntityId, kind, uniqueName()],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture platform.sites insert returned no row');
  fixtureSiteIds.push(row.id);
  return row;
}

async function getSite(
  id: string,
): Promise<{
  version: number;
  name_en: string | null;
  is_active: boolean;
  radius_m: string;
  account_id: string | null;
  kind: string;
}> {
  const result: QueryResult<{
    version: number;
    name_en: string | null;
    is_active: boolean;
    radius_m: string;
    account_id: string | null;
    kind: string;
  }> = await pool.query(
    `select version, name_en, is_active, radius_m::text as radius_m, account_id, kind from platform.sites where id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no platform.sites row for id ${id}`);
  return row;
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

async function siteCountForEntity(forEntityId: string, nameAr: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.sites where entity_id = $1 and name_ar = $2`,
    [forEntityId, nameAr],
  );
  return Number(result.rows[0]?.n ?? '0');
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, [
    'PST',
  ]);
  entityId = (entityResult.rows[0] as { id: string }).id;

  await createFixtureActor(OPS_DIR_ACTOR_UUID, entityId);
  await createFixtureActor(HR_MGR_ACTOR_UUID, entityId);
  await createFixtureActor(NO_ROLE_ACTOR_UUID, entityId);

  await grantRole(OPS_DIR_ACTOR_UUID, OPS_DIR_ROLE_CODE);
  await grantRole(HR_MGR_ACTOR_UUID, HR_MGR_ROLE_CODE);
  await grantRole(NO_ROLE_ACTOR_UUID, WH_OP_ROLE_CODE); // holds a role, just not one this slice gates on.
});

afterAll(async () => {
  if (usedCorrelationIds.size > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [[...usedCorrelationIds]]);
  }
  if (fixtureSiteIds.length > 0) {
    await pool.query(`delete from hr.employees where default_site_id = any($1::uuid[])`, [fixtureSiteIds]);
    await pool.query(`delete from platform.sites where id = any($1::uuid[])`, [fixtureSiteIds]);
  }
  if (fixtureAccountIds.length > 0) {
    await pool.query(`delete from sales.accounts where id = any($1::uuid[])`, [fixtureAccountIds]);
  }
  for (const userId of [OPS_DIR_ACTOR_UUID, HR_MGR_ACTOR_UUID, NO_ROLE_ACTOR_UUID]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
});

// --- contract stub (package subpath import) -------------------------------------------------

describe('@pg-eos/contracts/platform/maintain-site — no entityId/performedBy field', () => {
  it('accepts a well-formed CreateSite body with no entityId/performedBy field', () => {
    const parsed = CreateSiteInputSchema.parse({
      kind: 'warehouse',
      nameAr: uniqueName(),
      correlationId: randomUUID(),
    });
    expect(parsed.kind).toBe('warehouse');
    expect('entityId' in parsed).toBe(false);
    expect('performedBy' in parsed).toBe(false);
  });
});

// --- Scenario: Create a warehouse site --------------------------------------------------------

describe('Scenario: Create a warehouse site', () => {
  it('creates one platform.sites row (version 1, entity_id = ctx.entityId, radius_m = 500 the threshold default), one platform.site.created outbox row, and a matching audit_log row', async () => {
    const nameAr = uniqueName();
    const correlationId = nextCorrelationId();
    const result = await createSite(opsDirCtx, { kind: 'warehouse', nameAr, correlationId }, deps);
    fixtureSiteIds.push(result.id);

    expect(result.version).toBe(1);

    const row = await getSite(result.id);
    expect(row.version).toBe(1);
    expect(Number(row.radius_m)).toBe(GEOFENCE_RADIUS_DEFAULT_M);
    expect(await siteCountForEntity(entityId, nameAr)).toBe(1);

    const createdRows = await outboxRowsForCorrelationAndType(correlationId, SITE_CREATED_EVENT_TYPE);
    expect(createdRows).toHaveLength(1);
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
  });
});

// --- Scenario: Create a client_pickup site without an account is rejected -----------------------

describe('Scenario: Create a client_pickup site without an account is rejected', () => {
  it('SiteAccountRequiredError (422), no row written', async () => {
    const nameAr = uniqueName();
    await expect(
      createSite(hrMgrCtx, { kind: 'client_pickup', nameAr, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(SiteAccountRequiredError);

    expect(await siteCountForEntity(entityId, nameAr)).toBe(0);
  });
});

// --- Scenario: Create a client_pickup site with an account succeeds ------------------------------

describe('Scenario: Create a client_pickup site with an account succeeds', () => {
  it('one platform.sites row exists with account_id set', async () => {
    const accountId = await insertAccountDirect();
    const nameAr = uniqueName();
    const result = await createSite(
      hrMgrCtx,
      { kind: 'client_pickup', accountId, nameAr, correlationId: nextCorrelationId() },
      deps,
    );
    fixtureSiteIds.push(result.id);

    const row = await getSite(result.id);
    expect(row.account_id).toBe(accountId);
  });
});

// --- Scenario: A caller-supplied radius must be positive ------------------------------------------

describe('Scenario: A caller-supplied radius must be positive', () => {
  it('SiteRadiusInvalidError (422), no row written', async () => {
    const nameAr = uniqueName();
    await expect(
      createSite(opsDirCtx, { kind: 'warehouse', nameAr, radiusM: -5, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(SiteRadiusInvalidError);

    expect(await siteCountForEntity(entityId, nameAr)).toBe(0);
  });
});

// --- Scenario: An invalid kind is rejected by the application layer, not just the contract ---------
//
// The HTTP handler test (handlers.test.ts, "An invalid kind is rejected at the contract") never
// reaches the application layer — the Zod contract rejects an invalid kind at 400 first. This
// scenario calls createSite directly (bypassing the parsed-and-validated HTTP path) to prove the
// application layer's own re-validation (create-site.ts's isValidKind check, round-1 review fix)
// actually runs and is not silently dead code.

describe('Scenario: An invalid kind is rejected by the application layer', () => {
  it('createSite with an invalid kind throws SiteKindInvalidError, no row written', async () => {
    const nameAr = uniqueName();
    await expect(
      createSite(opsDirCtx, { kind: 'not_a_real_kind', nameAr, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(SiteKindInvalidError);

    expect(await siteCountForEntity(entityId, nameAr)).toBe(0);
  });
});

// --- Scenario: Update a site's fields -------------------------------------------------------------

describe("Scenario: Update a site's fields", () => {
  it("the row's version becomes 2, name_en is updated, and exactly one platform.site.updated outbox + audit row are written", async () => {
    const site = await insertSiteDirect(entityId);
    const correlationId = nextCorrelationId();
    const newNameEn = 'Updated Site Name';

    const result = await updateSite(
      opsDirCtx,
      { siteId: site.id, nameEn: newNameEn, expectedVersion: site.version, correlationId },
      deps,
    );
    expect(result.version).toBe(2);

    const row = await getSite(site.id);
    expect(row.version).toBe(2);
    expect(row.name_en).toBe(newNameEn);

    const updatedRows = await outboxRowsForCorrelationAndType(correlationId, SITE_UPDATED_EVENT_TYPE);
    expect(updatedRows).toHaveLength(1);
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
  });
});

// --- Scenario: A stale expectedVersion is rejected -------------------------------------------------

describe('Scenario: A stale expectedVersion is rejected', () => {
  it('StaleVersionError (409), no column written', async () => {
    const site = await insertSiteDirect(entityId);
    await updateSite(
      opsDirCtx,
      { siteId: site.id, nameEn: 'first update', expectedVersion: site.version, correlationId: nextCorrelationId() },
      deps,
    ); // site now at version 2.

    await expect(
      updateSite(
        opsDirCtx,
        { siteId: site.id, nameEn: 'stale update', expectedVersion: site.version, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(StaleVersionError);

    const row = await getSite(site.id);
    expect(row.name_en).toBe('first update');
  });
});

// --- Scenario: UpdateSite kind-change to client_pickup without an account is rejected ---------------
//
// Proves the update-site.ts effective-kind/effective-account check (round-1 review fix) — the
// domain re-validation must catch this BEFORE the DB write, raising SiteAccountRequiredError (422),
// never a raw 23514 CHECK-constraint violation surfacing as a 500.

describe('Scenario: UpdateSite kind-change to client_pickup without an account is rejected', () => {
  it('SiteAccountRequiredError (422), not a raw DB constraint error; row kind/version unchanged', async () => {
    const site = await insertSiteDirect(entityId, 'warehouse'); // kind other than client_pickup, no account_id.

    await expect(
      updateSite(
        opsDirCtx,
        { siteId: site.id, kind: 'client_pickup', expectedVersion: site.version, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(SiteAccountRequiredError);

    const row = await getSite(site.id);
    expect(row.kind).toBe('warehouse');
    expect(row.version).toBe(site.version);
  });
});

// --- Scenario: Deactivating a site via UpdateSite ---------------------------------------------------

describe('Scenario: Deactivating a site via UpdateSite', () => {
  it("the row's is_active becomes false and version becomes 2", async () => {
    const site = await insertSiteDirect(entityId);

    const result = await updateSite(
      opsDirCtx,
      { siteId: site.id, isActive: false, expectedVersion: site.version, correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.version).toBe(2);

    const row = await getSite(site.id);
    expect(row.is_active).toBe(false);
    expect(row.version).toBe(2);
  });
});

// --- Scenario: Role gates ---------------------------------------------------------------------------

describe('Scenario: Role gates', () => {
  it('CreateSite and UpdateSite each throw RoleRequiredError for a caller holding only WH_OP; nothing written', async () => {
    const site = await insertSiteDirect(entityId);
    const nameAr = uniqueName();

    await expect(
      createSite(noRoleCtx, { kind: 'warehouse', nameAr, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    await expect(
      updateSite(
        noRoleCtx,
        { siteId: site.id, nameEn: 'should not apply', expectedVersion: site.version, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    expect(await siteCountForEntity(entityId, nameAr)).toBe(0);
    const row = await getSite(site.id);
    expect(row.version).toBe(site.version); // unchanged.
  });
});

// --- Scenario: Idempotent replay ----------------------------------------------------------------------

describe('Scenario: Idempotent replay', () => {
  it('CreateSite twice with the same Idempotency-Key and body: one row exists, second call returns the first result; a different body with the same key -> IdempotencyConflictError', async () => {
    const idempotencyKey = randomUUID();
    const nameAr = uniqueName();
    const body = { kind: 'warehouse' as const, nameAr, correlationId: nextCorrelationId() };
    const idem: IdempotencyInput = {
      key: idempotencyKey,
      endpoint: 'platform.maintain-site.create-site',
      requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
      entityId: null,
      successStatus: 200,
    };

    const first = await createSite(opsDirCtx, { ...body, idem }, deps);
    fixtureSiteIds.push(first.id);
    const second = await createSite(opsDirCtx, { ...body, idem }, deps);
    expect(second).toEqual(first);
    expect(await siteCountForEntity(entityId, nameAr)).toBe(1);

    const differentBody = { ...body, nameAr: uniqueName() };
    const differentIdem: IdempotencyInput = {
      ...idem,
      requestHash: createHash('sha256').update(JSON.stringify(differentBody)).digest('hex'),
    };
    await expect(
      createSite(opsDirCtx, { ...differentBody, idem: differentIdem }, deps),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

// --- Scenario: A site outside the caller's entity is invisible ------------------------------------------

describe("Scenario: A site outside the caller's entity is invisible", () => {
  const OTHER_ENTITY_ACTOR_UUID = '00000000-0000-4000-8000-0000000505b1';

  afterEach(async () => {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [OTHER_ENTITY_ACTOR_UUID]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [OTHER_ENTITY_ACTOR_UUID]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [OTHER_ENTITY_ACTOR_UUID]);
    await pool.query(`delete from identity.users where id = $1`, [OTHER_ENTITY_ACTOR_UUID]);
  });

  it('UpdateSite against a site registered under a different entity (PST) -> SiteNotFoundError for a caller scoped only to PCC', async () => {
    const site = await insertSiteDirect(entityId); // entity A = the module-level `entityId` (PST).

    await pool.query(`insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`, [
      OTHER_ENTITY_ACTOR_UUID,
      `_maintainsite_fixture_${OTHER_ENTITY_ACTOR_UUID}_${randomUUID()}@test.invalid`,
      'ممثل اختبار — كيان آخر',
    ]);
    const otherEntity: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, [
      'PCC',
    ]);
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [
      OTHER_ENTITY_ACTOR_UUID,
      (otherEntity.rows[0] as { id: string }).id,
    ]);
    await grantRole(OTHER_ENTITY_ACTOR_UUID, OPS_DIR_ROLE_CODE);
    const otherEntityCtx = { userId: OTHER_ENTITY_ACTOR_UUID, clientId: null, isInternal: true };

    await expect(
      updateSite(
        otherEntityCtx,
        { siteId: site.id, nameEn: 'should not apply', expectedVersion: site.version, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(SiteNotFoundError);
  });
});
