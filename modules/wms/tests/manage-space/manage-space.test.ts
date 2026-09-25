// modules/wms/tests/manage-space/manage-space.test.ts — WBS 2.15 (lane 2).
//
// Integration tests, one per scenario in ./manage-space.feature, against the real database as
// pgeos_app. Sources: docs/notes/slice-briefs/_slice-2.15.brief.md (Facts/D1-D7, verbatim), doc 40
// INV-C3-8 (line 251), .claude/briefs/wms.brief.md.
//
// Binding behaviour this suite asserts (RED until pg-backend builds
// modules/wms/{domain,application,infrastructure,api}/manage-space/**):
//   - AllocateSpace(ctx, { contractId, clientId, blockId, allocType?, qty, uom, serviceId?,
//     validFrom, validTo?, minChargeApplies?, correlationId }, deps) resolves entityId THROUGH the
//     request's own blockId (`select entity_id from wms.space_blocks where id = $1 for update` —
//     NEVER ctx.entityId, and the read LOCKS the block row for the rest of the transaction so two
//     concurrent calls on the same block serialize — round-1 review finding 1), throwing
//     EntityScopeAmbiguousError when no such block is visible to the caller (SALES_MGR is
//     all-scope — see the brief's CORRECTED Facts section, superseding the caller-cardinality rule
//     used by every prior slice). It then pre-checks qty > 0 and calls
//     wms.check_space_available(blockId, qty, validFrom, validTo) BEFORE the INSERT; a P0001 raise
//     is caught and re-thrown as SpaceNotAvailableError (422) carrying the function's own message
//     (which states the exact sellable qty — D3). createdBy = ctx.userId. No version column (D1)
//     — a plain INSERT at status='active'.
//   - ReserveSpace(ctx, { blockId, clientId?, quoteId?, opportunityId?, qty, uom, reservedFrom,
//     expiresAt, reason, correlationId }, deps) resolves entityId THROUGH the block the same way
//     (same FOR UPDATE lock, same EntityScopeAmbiguousError reuse for "no such block visible").
//     It then pre-checks qty > 0, `expiresAt > reservedFrom` (a zero/negative duration throws the
//     DISTINCT typed ReservationDateRangeInvalidError, round-1 review finding 3 — never
//     ReservationTooLongError, which is reserved solely for the 30-day threshold), the 30-day
//     max-duration threshold (platform.thresholds key space.reservation_max_days, never
//     hardcoded), and calls wms.check_space_available BEFORE the INSERT — same P0001 catch/re-throw
//     as AllocateSpace, plus ReservationTooLongError (422) for the duration check. reservedBy =
//     ctx.userId; approvedBy left null.
//   - INV-C3-8's "reservations expire automatically" half is already satisfied by
//     wms.space_availability()'s own `resv` CTE (`expires_at >= p_from`) — an expired reservation
//     (status still 'active', never flipped by any job) stops counting toward sellable the moment
//     its date passes. No job exists in this slice to flip the status column (Facts, out of scope).
//   - Role gate: SALES_MGR only, both commands (D5).
//   - Audit only, no outbox event (D6) — one platform.audit_log row per command.
//   - Idempotency-Key: a replay with the same key + body returns the first result without a second
//     INSERT.
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only) plus real
// identity.users/user_entities/user_roles rows, same as
// modules/wms/tests/count-inventory/count-inventory.test.ts and
// modules/wms/tests/take-occupancy-snapshot/take-occupancy-snapshot.test.ts. PG_APP_USER=pgeos_app
// is REQUIRED to run this suite (every command call goes through withContext(ctx, fn) as
// pgeos_app, genuinely subject to RLS). platform.audit_log rows are NEVER deleted.
//
// SoD (brief Facts / 13B:633): SALES_MGR and CFO are an SoD pair ("من يبيع لا يحدّد الحد الأدنى")
// — no fixture identity in this file is EVER granted both roles.
//
// The "expired reservation" fixture (brief CRITICAL note) is seeded directly via the admin pool —
// ReserveSpace's own domain pre-check (expiresAt > reservedFrom, satisfied; but a NEW reservation
// would never be created with an already-past expiresAt through normal validation in the first
// place is not itself blocked by that check) is bypassed entirely: this row represents historical
// data whose expiry has since passed, not something the command under test can produce today.

import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IdempotencyConflictError, type IdempotencyInput, withContext } from '@pg-eos/db';

// The modules under test — do not exist yet (RED).
import { allocateSpace, reserveSpace } from '../../application/manage-space/index.js';
import { createManageSpaceDeps } from '../../api/manage-space/composition.js';
import {
  EntityScopeAmbiguousError,
  NonPositiveQtyError,
  ReservationDateRangeInvalidError,
  ReservationTooLongError,
  RoleRequiredError,
  SpaceNotAvailableError,
} from '../../domain/manage-space/errors.js';
// the package subpath export (@pg-eos/contracts/wms/manage-space), not a deep relative path —
// packages/contracts/package.json's own `exports` map already carries this entry.
import { AllocateSpaceInputSchema, ReserveSpaceInputSchema } from '@pg-eos/contracts/wms/manage-space';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

const appPool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PG_APP_USER'] ?? 'pgeos_app',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

// --- literals --------------------------------------------------------------------------------

const SALES_MGR_ROLE_CODE = 'SALES_MGR';
const WH_MGR_ROLE_CODE = 'WH_MGR';
const BLOCK_TYPE_PALLET_RACK = 'pallet_rack';
const PALLET_UOM = 'pallet';
const ALLOC_TYPE_DEDICATED = 'dedicated';
const ALLOC_STATUS_ACTIVE = 'active';
const RESV_STATUS_ACTIVE = 'active';
const RESV_REASON_QUOTE_PENDING = 'quote_pending';
const CAPACITY_100 = '100.000';
const MAX_RESERVATION_DAYS = 30; // platform.thresholds key space.reservation_max_days, seeded 30 (Facts).

const SALES_MGR_ACTOR_UUID = '00000000-0000-4000-8000-0000000215a1'; // SALES_MGR only.
const WH_MGR_ONLY_ACTOR_UUID = '00000000-0000-4000-8000-0000000215a2'; // no SALES_MGR (role-gate scenario).
// Finding 5: an OUTSIDER holding SALES_MGR but scoped ONLY to an entity OTHER than `entityId` —
// never granted `entityId` itself. Used to prove a block belonging to an entity the caller isn't
// linked to resolves as "invisible" (EntityScopeAmbiguousError), not as a readable-but-wrong row.
const OUTSIDER_SALES_MGR_ACTOR_UUID = '00000000-0000-4000-8000-0000000215a3';

const clock = new FixedClock(new Date('2026-09-25T00:00:00.000Z'));
const ids = new SequentialIdGenerator(215);
const deps = createManageSpaceDeps({ clock, ids });

const roleCtx = { userId: SALES_MGR_ACTOR_UUID, clientId: null, isInternal: true };
const whMgrOnlyCtx = { userId: WH_MGR_ONLY_ACTOR_UUID, clientId: null, isInternal: true };
const outsiderCtx = { userId: OUTSIDER_SALES_MGR_ACTOR_UUID, clientId: null, isInternal: true };

// Every fixture date in this suite is derived from `TODAY`, never `new Date()` directly (CLAUDE.md
// forbids `new Date()` in domain/; this is a test literal driving fixture dates only).
const TODAY = '2026-09-25';

function daysFrom(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

let entityId: string;
let outsiderEntityId: string; // Finding 5 — an entity OTHER than `entityId`.
let fixtureClientId: string;
let fixtureContractId: string;
const fixtureWarehouseIds: string[] = [];
const fixtureZoneIds: string[] = [];
const fixtureBlockIds: string[] = [];
const fixtureAllocationIds: string[] = [];
const fixtureReservationIds: string[] = [];
const usedCorrelationIds = new Set<string>();

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

function idemFor(endpoint: string, key: string, body: unknown): IdempotencyInput {
  return {
    key,
    endpoint: `wms.manage-space.${endpoint}`,
    requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    entityId: null,
    successStatus: 200,
  };
}

async function grantRole(userId: string, roleCode: string): Promise<void> {
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [
    roleCode,
  ]);
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
    [userId, `_mgspace_fixture_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار إدارة المساحة — WBS 2.15'],
  );
  for (const eid of entityIds) {
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, eid]);
  }
}

async function createFixtureWarehouse(): Promise<{ warehouseId: string; zoneId: string }> {
  const whResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.warehouses (entity_id, code, name_ar) values ($1, $2, $3) returning id`,
    [entityId, `_MGSPACE_WH_${randomUUID()}`, 'مستودع اختبار إدارة المساحة'],
  );
  const warehouseId = (whResult.rows[0] as { id: string }).id;
  fixtureWarehouseIds.push(warehouseId);

  const zoneResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.zones (warehouse_id, code, name_ar, zone_type) values ($1, $2, $3, 'storage') returning id`,
    [warehouseId, 'A', 'منطقة اختبار'],
  );
  const zoneId = (zoneResult.rows[0] as { id: string }).id;
  fixtureZoneIds.push(zoneId);

  return { warehouseId, zoneId };
}

/** a fresh space_blocks row with the given capacity (pallets), no allocations/reservations yet. */
async function insertSpaceBlock(warehouseId: string, zoneId: string, capacityPallets: string = CAPACITY_100): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.space_blocks (entity_id, warehouse_id, zone_id, code, block_type, capacity_pallets)
     values ($1, $2, $3, $4, $5, $6::numeric) returning id`,
    [entityId, warehouseId, zoneId, `_MGSPACE-BLK-${randomUUID()}`, BLOCK_TYPE_PALLET_RACK, capacityPallets],
  );
  const id = (result.rows[0] as { id: string }).id;
  fixtureBlockIds.push(id);
  return id;
}

async function insertClient(): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [`_mgspace_fixture_${randomUUID()}`, 'عميل اختبار إدارة المساحة'],
  );
  const id = (result.rows[0] as { id: string }).id;
  return id;
}

async function insertContract(clientId: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.contracts (entity_id, doc_no, account_id, title, start_date)
     values ($1, $2, $3, $4, $5::date) returning id`,
    [entityId, `_MGSPACE-CT-${randomUUID()}`, clientId, 'عقد اختبار إدارة المساحة', TODAY],
  );
  const id = (result.rows[0] as { id: string }).id;
  return id;
}

/** a pre-existing active allocation, inserted DIRECTLY (bypassing the command under test) to
 *  pre-fill sellable capacity for a scenario — same discipline as
 *  modules/wms/tests/take-occupancy-snapshot/take-occupancy-snapshot.test.ts's own
 *  insertActiveAllocation helper. */
async function insertExistingAllocation(
  contractId: string,
  clientId: string,
  blockId: string,
  qty: string,
  validFrom: string = TODAY,
): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.space_allocations
       (entity_id, contract_id, client_id, block_id, alloc_type, qty, uom, valid_from, valid_to, status, created_by)
     values ($1, $2, $3, $4, $5, $6::numeric, $7, $8::date, null, $9, $10)
     returning id`,
    [entityId, contractId, clientId, blockId, ALLOC_TYPE_DEDICATED, qty, PALLET_UOM, validFrom, ALLOC_STATUS_ACTIVE, SALES_MGR_ACTOR_UUID],
  );
  const id = (result.rows[0] as { id: string }).id;
  fixtureAllocationIds.push(id);
  return id;
}

/** a pre-existing active reservation, inserted DIRECTLY via the admin pool — used both for
 *  "existing reservation reduces sellable" fixtures and (brief CRITICAL note) for the ALREADY-
 *  EXPIRED historical fixture that ReserveSpace itself could never produce today. The admin pool
 *  is a superuser/db-owner role — the DB trigger (trg_space_reservation_guard) still fires
 *  regardless of role, so every fixture inserted here must itself satisfy the trigger's own
 *  duration/availability checks AT THE TIME OF INSERT (never bypassable, by design). */
async function insertExistingReservation(
  blockId: string,
  clientId: string,
  qty: string,
  reservedFrom: string,
  expiresAt: string,
): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.space_reservations
       (entity_id, block_id, client_id, qty, uom, reserved_from, expires_at, reason, status, reserved_by)
     values ($1, $2, $3, $4::numeric, $5, $6::date, $7::date, $8, $9, $10)
     returning id`,
    [entityId, blockId, clientId, qty, PALLET_UOM, reservedFrom, expiresAt, RESV_REASON_QUOTE_PENDING, RESV_STATUS_ACTIVE, SALES_MGR_ACTOR_UUID],
  );
  const id = (result.rows[0] as { id: string }).id;
  fixtureReservationIds.push(id);
  return id;
}

async function getAllocations(blockId: string): Promise<Array<{ id: string; status: string; qty: string }>> {
  const result: QueryResult<{ id: string; status: string; qty: string }> = await pool.query(
    `select id::text as id, status, qty::text as qty from wms.space_allocations where block_id = $1 and client_id = $2 order by qty`,
    [blockId, fixtureClientId],
  );
  return result.rows;
}

async function countAllocationsForBlock(blockId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from wms.space_allocations where block_id = $1 and client_id = $2`,
    [blockId, fixtureClientId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function getReservations(blockId: string, clientId: string): Promise<Array<{ id: string; status: string; qty: string }>> {
  const result: QueryResult<{ id: string; status: string; qty: string }> = await pool.query(
    `select id::text as id, status, qty::text as qty from wms.space_reservations where block_id = $1 and client_id = $2 order by qty`,
    [blockId, clientId],
  );
  return result.rows;
}

async function countReservationsCreatedByCommand(blockId: string, clientId: string, excludeIds: readonly string[]): Promise<number> {
  if (excludeIds.length === 0) {
    const result: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from wms.space_reservations where block_id = $1 and client_id = $2`,
      [blockId, clientId],
    );
    return Number(result.rows[0]?.n ?? '0');
  }
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from wms.space_reservations where block_id = $1 and client_id = $2 and not (id = any($3::uuid[]))`,
    [blockId, clientId, excludeIds],
  );
  return Number(result.rows[0]?.n ?? '0');
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  entityId = (entityResult.rows[0] as { id: string }).id;

  // Finding 5: an entity OTHER than `entityId`, for the cross-entity isolation scenario — same
  // pattern as modules/wms/tests/count-inventory/count-inventory.test.ts's own finding 6 fixture.
  const outsiderEntityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where id <> $1 limit 1`,
    [entityId],
  );
  const outsiderEntityRow = outsiderEntityResult.rows[0];
  if (!outsiderEntityRow) throw new Error('expected at least 2 rows in platform.entities (finding 5 fixture)');
  outsiderEntityId = outsiderEntityRow.id;

  await createFixtureActor(SALES_MGR_ACTOR_UUID, [entityId]);
  await createFixtureActor(WH_MGR_ONLY_ACTOR_UUID, [entityId]);
  await createFixtureActor(OUTSIDER_SALES_MGR_ACTOR_UUID, [outsiderEntityId]); // NEVER granted `entityId`.
  await grantRole(SALES_MGR_ACTOR_UUID, SALES_MGR_ROLE_CODE);
  await grantRole(WH_MGR_ONLY_ACTOR_UUID, WH_MGR_ROLE_CODE); // deliberately NOT SALES_MGR (role-gate scenario).
  // Finding 5: OUTSIDER holds SALES_MGR too, so every rejection it triggers below is genuinely
  // about entity scoping (block visibility), never about a missing role.
  await grantRole(OUTSIDER_SALES_MGR_ACTOR_UUID, SALES_MGR_ROLE_CODE);

  fixtureClientId = await insertClient();
  fixtureContractId = await insertContract(fixtureClientId);
});

afterAll(async () => {
  if (usedCorrelationIds.size > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [[...usedCorrelationIds]]);
  }
  if (fixtureReservationIds.length > 0) {
    await pool.query(`delete from wms.space_reservations where id = any($1::uuid[])`, [fixtureReservationIds]);
  }
  // any reservation/allocation the COMMAND UNDER TEST wrote (not tracked by the fixture arrays
  // above) must also be cleaned up — scoped by block, since every block in this suite is unique.
  if (fixtureBlockIds.length > 0) {
    await pool.query(`delete from wms.space_reservations where block_id = any($1::uuid[])`, [fixtureBlockIds]);
    await pool.query(`delete from wms.space_allocations where block_id = any($1::uuid[])`, [fixtureBlockIds]);
    await pool.query(`delete from wms.space_blocks where id = any($1::uuid[])`, [fixtureBlockIds]);
  }
  if (fixtureZoneIds.length > 0) await pool.query(`delete from wms.zones where id = any($1::uuid[])`, [fixtureZoneIds]);
  if (fixtureWarehouseIds.length > 0) {
    await pool.query(`delete from wms.warehouses where id = any($1::uuid[])`, [fixtureWarehouseIds]);
  }
  if (fixtureContractId) await pool.query(`delete from sales.contracts where id = $1`, [fixtureContractId]);
  if (fixtureClientId) await pool.query(`delete from sales.accounts where id = $1`, [fixtureClientId]);
  for (const userId of [SALES_MGR_ACTOR_UUID, WH_MGR_ONLY_ACTOR_UUID, OUTSIDER_SALES_MGR_ACTOR_UUID]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
  await appPool.end();
});

// --- contract stub (package subpath import) ----------------------------------------------------

describe('@pg-eos/contracts/wms/manage-space — AllocateSpaceInputSchema/ReserveSpaceInputSchema have no performedBy/expectedVersion', () => {
  it('AllocateSpaceInputSchema accepts a valid body with no performedBy/expectedVersion field', () => {
    const parsed = AllocateSpaceInputSchema.parse({
      contractId: randomUUID(),
      clientId: randomUUID(),
      blockId: randomUUID(),
      qty: 40,
      uom: PALLET_UOM,
      validFrom: TODAY,
      correlationId: randomUUID(),
    });
    expect(parsed.qty).toBe(40);
    expect('performedBy' in parsed).toBe(false);
    expect('expectedVersion' in parsed).toBe(false);
  });

  it('ReserveSpaceInputSchema accepts a valid body with no performedBy/expectedVersion field', () => {
    const parsed = ReserveSpaceInputSchema.parse({
      blockId: randomUUID(),
      qty: 25,
      uom: PALLET_UOM,
      reservedFrom: TODAY,
      expiresAt: daysFrom(TODAY, 10),
      reason: RESV_REASON_QUOTE_PENDING,
      correlationId: randomUUID(),
    });
    expect(parsed.qty).toBe(25);
    expect('performedBy' in parsed).toBe(false);
    expect('expectedVersion' in parsed).toBe(false);
  });
});

// --- Scenario: Allocate space within sellable capacity --------------------------------------------

describe('Scenario: Allocate space within sellable capacity', () => {
  it('one wms.space_allocations row exists with status "active", qty 40', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);

    await allocateSpace(
      roleCtx,
      {
        contractId: fixtureContractId,
        clientId: fixtureClientId,
        blockId,
        qty: 40,
        uom: PALLET_UOM,
        validFrom: TODAY,
        correlationId: nextCorrelationId(),
      },
      deps,
    );

    const rows = await getAllocations(blockId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('active');
    expect(rows[0]?.qty).toBe('40.000');
  });
});

// --- Scenario: Allocating beyond sellable capacity is rejected with the exact available qty --------

describe('Scenario: Allocating beyond sellable capacity is rejected with the exact available qty', () => {
  it('SpaceNotAvailableError (422) whose message states the EXACT sellable qty (30.000) and the ' +
    'EXACT requested qty (40) — round-1 review finding 4: a bare toContain(\'30\') is fragile since ' +
    'the block code (_MGSPACE-BLK-<uuid>) also contains digits; anchor on the fixed Arabic wording ' +
    'that surrounds each number in wms.check_space_available()\'s own RAISE text (13B:1093-1106: ' +
    '\'... هي % فقط، والمطلوب %.\') so a coincidental digit match in the block code can never pass ' +
    'this assertion. no row written.', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    await insertExistingAllocation(fixtureContractId, fixtureClientId, blockId, '70.000');

    let caught: unknown;
    try {
      await allocateSpace(
        roleCtx,
        {
          contractId: fixtureContractId,
          clientId: fixtureClientId,
          blockId,
          qty: 40,
          uom: PALLET_UOM,
          validFrom: TODAY,
          correlationId: nextCorrelationId(),
        },
        deps,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SpaceNotAvailableError);
    const message = (caught as Error).message;
    // capacity_pallets is numeric(10,3): 100.000 - 70.000 (existing allocation) - 0 (no reservation)
    // = sellable 30.000 (13B: wms.space_availability's own subtraction, scale-3 preserved). The
    // requested qty is bound as a plain JS number (40) cast ::numeric with no typmod, so Postgres
    // renders it with no trailing zeros — exactly '40', never '40.000'.
    expect(message).toContain('30.000 فقط'); // sellable, anchored to the fixed word immediately after it.
    expect(message).toContain('والمطلوب 40.'); // requested qty, anchored to the fixed word before it.
    expect(await countAllocationsForBlock(blockId)).toBe(1); // the pre-existing 70 only.
  });
});

// --- Scenario: Reserve space within sellable capacity ----------------------------------------------

describe('Scenario: Reserve space within sellable capacity', () => {
  it('one wms.space_reservations row exists with status "active", qty 25', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);

    const result = await reserveSpace(
      roleCtx,
      {
        blockId,
        clientId: fixtureClientId,
        qty: 25,
        uom: PALLET_UOM,
        reservedFrom: TODAY,
        expiresAt: daysFrom(TODAY, 10),
        reason: RESV_REASON_QUOTE_PENDING,
        correlationId: nextCorrelationId(),
      },
      deps,
    );
    fixtureReservationIds.push((result as { id: string }).id);

    const rows = await getReservations(blockId, fixtureClientId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('active');
    expect(rows[0]?.qty).toBe('25.000');
  });
});

// --- Scenario: Reserving beyond sellable capacity is rejected --------------------------------------

describe('Scenario: Reserving beyond sellable capacity is rejected', () => {
  it('SpaceNotAvailableError (422); no wms.space_reservations row is written by the command', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    const existingId = await insertExistingReservation(blockId, fixtureClientId, '80.000', TODAY, daysFrom(TODAY, 20));

    let caught: unknown;
    try {
      await reserveSpace(
        roleCtx,
        {
          blockId,
          clientId: fixtureClientId,
          qty: 30,
          uom: PALLET_UOM,
          reservedFrom: TODAY,
          expiresAt: daysFrom(TODAY, 10),
          reason: RESV_REASON_QUOTE_PENDING,
          correlationId: nextCorrelationId(),
        },
        deps,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SpaceNotAvailableError);
    expect(await countReservationsCreatedByCommand(blockId, fixtureClientId, [existingId])).toBe(0);
  });
});

// --- Scenario: A reservation longer than the threshold is rejected ---------------------------------

describe('Scenario: A reservation longer than the threshold is rejected', () => {
  it('ReservationTooLongError (422) for a 45-day reservation (threshold 30 days); no row written', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);

    await expect(
      reserveSpace(
        roleCtx,
        {
          blockId,
          clientId: fixtureClientId,
          qty: 10,
          uom: PALLET_UOM,
          reservedFrom: TODAY,
          expiresAt: daysFrom(TODAY, MAX_RESERVATION_DAYS + 15), // > MAX_RESERVATION_DAYS (30).
          reason: RESV_REASON_QUOTE_PENDING,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ReservationTooLongError);

    expect(await countReservationsCreatedByCommand(blockId, fixtureClientId, [])).toBe(0);
  });
});

// --- Scenario: An expired reservation no longer counts against sellable capacity -------------------

describe('Scenario: An expired reservation no longer counts against sellable capacity', () => {
  it('the allocation succeeds — the expired reservation qty does not reduce sellable capacity', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    // brief CRITICAL note: a reservation whose expires_at is YESTERDAY, status still 'active' —
    // historical data no command under test can produce today, seeded directly via the admin pool.
    // reserved_from is far enough in the past to satisfy both the DB CHECK (expires_at >
    // reserved_from) and the trigger's own duration/availability checks AT THE TIME OF INSERT.
    await insertExistingReservation(blockId, fixtureClientId, '80.000', daysFrom(TODAY, -10), daysFrom(TODAY, -1));

    await allocateSpace(
      roleCtx,
      {
        contractId: fixtureContractId,
        clientId: fixtureClientId,
        blockId,
        qty: 90,
        uom: PALLET_UOM,
        validFrom: TODAY,
        correlationId: nextCorrelationId(),
      },
      deps,
    );

    const rows = await getAllocations(blockId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('active');
    expect(rows[0]?.qty).toBe('90.000');
  });
});

// --- Scenario: Allocating with a non-positive qty is rejected at the contract ----------------------

describe('Scenario: Allocating with a non-positive qty is rejected at the contract', () => {
  it('AllocateSpaceInputSchema rejects qty 0 — the command under test is never reached, nothing is written', () => {
    const parsed = AllocateSpaceInputSchema.safeParse({
      contractId: fixtureContractId,
      clientId: fixtureClientId,
      blockId: randomUUID(),
      qty: 0,
      uom: PALLET_UOM,
      validFrom: TODAY,
      correlationId: randomUUID(),
    });
    expect(parsed.success).toBe(false);
  });
});

// --- Scenario: Reserving with a non-positive qty is rejected by the domain -------------------------

describe('Scenario: Reserving with a non-positive qty is rejected by the domain', () => {
  it('NonPositiveQtyError (422) for qty -5, called directly against the application command (bypassing the contract, D7 — the domain check is the ONLY enforcement since space_reservations has no DB-level positive-qty CHECK); nothing is written', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);

    await expect(
      reserveSpace(
        roleCtx,
        {
          blockId,
          clientId: fixtureClientId,
          qty: -5,
          uom: PALLET_UOM,
          reservedFrom: TODAY,
          expiresAt: daysFrom(TODAY, 10),
          reason: RESV_REASON_QUOTE_PENDING,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(NonPositiveQtyError);

    expect(await countReservationsCreatedByCommand(blockId, fixtureClientId, [])).toBe(0);
  });
});

// --- Scenario: Role gates --------------------------------------------------------------------------

describe('Scenario: Role gates', () => {
  it('AllocateSpace: RoleRequiredError (422) for a caller holding only WH_MGR; nothing is written', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);

    await expect(
      allocateSpace(
        whMgrOnlyCtx,
        {
          contractId: fixtureContractId,
          clientId: fixtureClientId,
          blockId,
          qty: 10,
          uom: PALLET_UOM,
          validFrom: TODAY,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    expect(await countAllocationsForBlock(blockId)).toBe(0);
  });

  it('ReserveSpace: RoleRequiredError (422) for a caller holding only WH_MGR; nothing is written', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);

    await expect(
      reserveSpace(
        whMgrOnlyCtx,
        {
          blockId,
          clientId: fixtureClientId,
          qty: 10,
          uom: PALLET_UOM,
          reservedFrom: TODAY,
          expiresAt: daysFrom(TODAY, 10),
          reason: RESV_REASON_QUOTE_PENDING,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    expect(await countReservationsCreatedByCommand(blockId, fixtureClientId, [])).toBe(0);
  });
});

// --- Scenario: Idempotent replay -------------------------------------------------------------------

describe('Scenario: Idempotent replay', () => {
  it('AllocateSpace twice with the same Idempotency-Key and body: one allocation exists, the second call returns the first result', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    const idempotencyKey = randomUUID();
    const body = {
      contractId: fixtureContractId,
      clientId: fixtureClientId,
      blockId,
      qty: 40,
      uom: PALLET_UOM,
      validFrom: TODAY,
      correlationId: nextCorrelationId(),
    };
    const idem = idemFor('allocate-space', idempotencyKey, body);

    const first = await allocateSpace(roleCtx, { ...body, idem }, deps);
    const second = await allocateSpace(roleCtx, { ...body, idem }, deps);

    expect(second).toEqual(first);
    expect(await countAllocationsForBlock(blockId)).toBe(1);
  });

  it('the same Idempotency-Key with a DIFFERENT body -> IdempotencyConflictError', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    const idempotencyKey = randomUUID();
    const body = {
      contractId: fixtureContractId,
      clientId: fixtureClientId,
      blockId,
      qty: 40,
      uom: PALLET_UOM,
      validFrom: TODAY,
      correlationId: nextCorrelationId(),
    };
    const idem = idemFor('allocate-space', idempotencyKey, body);
    await allocateSpace(roleCtx, { ...body, idem }, deps);

    const differentBody = { ...body, correlationId: nextCorrelationId() };
    const differentIdem = idemFor('allocate-space', idempotencyKey, differentBody);
    await expect(
      allocateSpace(roleCtx, { ...differentBody, idem: differentIdem }, deps),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

// --- D6: audit only, no outbox event -----------------------------------------------------------

describe('D6: AllocateSpace/ReserveSpace write an audit_log row and no outbox event', () => {
  it('AllocateSpace writes a platform.audit_log row for wms.space_allocations and no platform.outbox row for its own correlationId', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    const correlationId = nextCorrelationId();

    await allocateSpace(
      roleCtx,
      {
        contractId: fixtureContractId,
        clientId: fixtureClientId,
        blockId,
        qty: 15,
        uom: PALLET_UOM,
        validFrom: TODAY,
        correlationId,
      },
      deps,
    );

    const auditResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from platform.audit_log
        where correlation_id = $1 and schema_name = 'wms' and table_name = 'space_allocations'`,
      [correlationId],
    );
    expect(Number(auditResult.rows[0]?.n ?? '0')).toBe(1);

    const outboxResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from platform.outbox where correlation_id = $1`,
      [correlationId],
    );
    expect(Number(outboxResult.rows[0]?.n ?? '0')).toBe(0);
  });

  // Round-3 review finding 1: regression test for the round-2 fix to allocate-space.ts — the audit
  // row's newValue.allocType / newValue.minChargeApplies must be the values the INSERT actually
  // stored (RETURNING, after the column DEFAULT fired), never `input` (undefined when omitted, so
  // JSON.stringify would drop the key) and never an application-side constant. Expected values come
  // from 13B:1004 (`alloc_type text not null default 'dedicated'`) and 13B:1010
  // (`min_charge_applies ... default true`), and are additionally cross-checked against the stored
  // wms.space_allocations row itself.
  it('AllocateSpace with allocType/minChargeApplies OMITTED: the audit_log new_value carries the DB column defaults actually stored (allocType "dedicated", minChargeApplies true), matching the stored wms.space_allocations row', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    const correlationId = nextCorrelationId();

    const result = await allocateSpace(
      roleCtx,
      {
        contractId: fixtureContractId,
        clientId: fixtureClientId,
        blockId,
        qty: 15,
        uom: PALLET_UOM,
        validFrom: TODAY,
        correlationId,
      },
      deps,
    );
    const allocationId = (result as { id: string }).id;

    const storedResult: QueryResult<{ alloc_type: string; min_charge_applies: boolean }> = await pool.query(
      `select alloc_type, min_charge_applies from wms.space_allocations where id = $1`,
      [allocationId],
    );
    expect(storedResult.rows).toHaveLength(1);
    const stored = storedResult.rows[0] as { alloc_type: string; min_charge_applies: boolean };
    expect(stored.alloc_type).toBe(ALLOC_TYPE_DEDICATED);
    expect(stored.min_charge_applies).toBe(true);

    const auditResult: QueryResult<{ record_id: string; alloc_type: string | null; min_charge_applies: string | null }> =
      await pool.query(
        `select record_id::text as record_id,
                new_value->>'allocType' as alloc_type,
                new_value->>'minChargeApplies' as min_charge_applies
           from platform.audit_log
          where correlation_id = $1 and schema_name = 'wms' and table_name = 'space_allocations'`,
        [correlationId],
      );
    expect(auditResult.rows).toHaveLength(1);
    const audit = auditResult.rows[0] as { record_id: string; alloc_type: string | null; min_charge_applies: string | null };
    expect(audit.record_id).toBe(allocationId);
    expect(audit.alloc_type).toBe(ALLOC_TYPE_DEDICATED);
    expect(audit.min_charge_applies).toBe('true');
    // and exactly what the DB stored, not merely a coincidentally-equal literal.
    expect(audit.alloc_type).toBe(stored.alloc_type);
    expect(audit.min_charge_applies).toBe(String(stored.min_charge_applies));
  });

  // Round-3 review finding 1 (companion): with NON-default values supplied explicitly, the audit
  // row must carry those stored values — this is what catches a regression to a hardcoded
  // application-side default constant (which would coincide with the DB default in the omitted case
  // above). 'shared' is a member of the alloc_type check list (13B:3574).
  it('AllocateSpace with allocType "shared" and minChargeApplies false supplied: the audit_log new_value carries the stored non-default values, never a hardcoded default', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    const correlationId = nextCorrelationId();

    const result = await allocateSpace(
      roleCtx,
      {
        contractId: fixtureContractId,
        clientId: fixtureClientId,
        blockId,
        allocType: 'shared',
        qty: 15,
        uom: PALLET_UOM,
        validFrom: TODAY,
        minChargeApplies: false,
        correlationId,
      },
      deps,
    );
    const allocationId = (result as { id: string }).id;

    const storedResult: QueryResult<{ alloc_type: string; min_charge_applies: boolean }> = await pool.query(
      `select alloc_type, min_charge_applies from wms.space_allocations where id = $1`,
      [allocationId],
    );
    expect(storedResult.rows).toHaveLength(1);
    const stored = storedResult.rows[0] as { alloc_type: string; min_charge_applies: boolean };
    expect(stored.alloc_type).toBe('shared');
    expect(stored.min_charge_applies).toBe(false);

    const auditResult: QueryResult<{ alloc_type: string | null; min_charge_applies: string | null }> = await pool.query(
      `select new_value->>'allocType' as alloc_type,
              new_value->>'minChargeApplies' as min_charge_applies
         from platform.audit_log
        where correlation_id = $1 and schema_name = 'wms' and table_name = 'space_allocations'`,
      [correlationId],
    );
    expect(auditResult.rows).toHaveLength(1);
    expect(auditResult.rows[0]?.alloc_type).toBe('shared');
    expect(auditResult.rows[0]?.min_charge_applies).toBe('false');
  });

  // Round-3 review finding 2: ReserveSpace's audit-log write was never tested — the describe title
  // claimed both commands but only AllocateSpace was exercised. writeAuditRow
  // (infrastructure/manage-space/repository.ts) writes schema_name 'wms', table_name
  // 'space_reservations', record_id = the new reservation id; D6 — no outbox row.
  it('ReserveSpace writes exactly one platform.audit_log row for wms.space_reservations (record_id = the new reservation) and no platform.outbox row for its own correlationId', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    const correlationId = nextCorrelationId();

    const result = await reserveSpace(
      roleCtx,
      {
        blockId,
        clientId: fixtureClientId,
        qty: 20,
        uom: PALLET_UOM,
        reservedFrom: TODAY,
        expiresAt: daysFrom(TODAY, 10),
        reason: RESV_REASON_QUOTE_PENDING,
        correlationId,
      },
      deps,
    );
    const reservationId = (result as { id: string }).id;
    fixtureReservationIds.push(reservationId);

    const auditResult: QueryResult<{ schema_name: string; table_name: string; record_id: string; user_id: string }> =
      await pool.query(
        `select schema_name, table_name, record_id::text as record_id, user_id::text as user_id
           from platform.audit_log
          where correlation_id = $1`,
        [correlationId],
      );
    expect(auditResult.rows).toHaveLength(1);
    const audit = auditResult.rows[0] as { schema_name: string; table_name: string; record_id: string; user_id: string };
    expect(audit.schema_name).toBe('wms');
    expect(audit.table_name).toBe('space_reservations');
    expect(audit.record_id).toBe(reservationId);
    expect(audit.user_id).toBe(SALES_MGR_ACTOR_UUID);

    const outboxResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from platform.outbox where correlation_id = $1`,
      [correlationId],
    );
    expect(Number(outboxResult.rows[0]?.n ?? '0')).toBe(0);
  });
});

// --- Finding 1: concurrent AllocateSpace calls on the same block serialize ------------------------
//
// Regression test for round-1 review finding 1: the block row must be locked (SELECT ... FOR
// UPDATE) before the capacity check, not just read, so two concurrent calls on the same block
// serialize instead of both reading a stale sellable figure and both passing. Two simultaneous
// AllocateSpace calls of 60 units each against a 100-pallet-capacity block (60 + 60 = 120 > 100):
// exactly one must succeed and the other must fail with SpaceNotAvailableError (422). Without the
// row lock, both calls could read sellable=100 concurrently and both pass, over-allocating to 120.

describe('Finding 1: concurrent AllocateSpace calls on the same block serialize (round-1 review finding 1 regression)', () => {
  it('two simultaneous 60-qty AllocateSpace calls on a 100-pallet block: exactly one succeeds, the other fails with SpaceNotAvailableError', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId); // capacity 100, no existing allocations/reservations.

    const callOnce = (): ReturnType<typeof allocateSpace> =>
      allocateSpace(
        roleCtx,
        {
          contractId: fixtureContractId,
          clientId: fixtureClientId,
          blockId,
          qty: 60,
          uom: PALLET_UOM,
          validFrom: TODAY,
          correlationId: nextCorrelationId(),
        },
        deps,
      );

    const outcomes = await Promise.allSettled([callOnce(), callOnce()]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejectedOutcome = rejected[0] as PromiseRejectedResult;
    expect(rejectedOutcome.reason).toBeInstanceOf(SpaceNotAvailableError);

    // exactly ONE allocation row (qty 60) was written — the SELECT...FOR UPDATE lock on the block
    // row serialized the two calls (the second one's check_space_available call sees the first
    // call's 60 already counted toward `contracted`, leaving sellable=40 < 60, and is rejected)
    // instead of both reading a stale sellable=100 and both passing.
    expect(await countAllocationsForBlock(blockId)).toBe(1);
    const rows = await getAllocations(blockId);
    expect(rows[0]?.qty).toBe('60.000');
  });
});

// --- Finding 4 (round-2 review): concurrent ReserveSpace calls on the same block serialize --------
//
// Round-1's concurrency regression test (Finding 1, above) only exercises AllocateSpace racing
// against AllocateSpace. ReserveSpace takes the IDENTICAL `SELECT ... FOR UPDATE` block lock (brief
// D4) but nothing in the round-1 suite would fail if that lock were accidentally removed from
// reserve-space.ts — this is that missing regression test. Two simultaneous 60-qty ReserveSpace
// calls against a 100-pallet-capacity block (60 + 60 = 120 > 100): exactly one must succeed and the
// other must fail with SpaceNotAvailableError (422). Without the row lock, both calls could read
// sellable=100 concurrently and both pass, over-reserving to 120.

describe('Finding 4: concurrent ReserveSpace calls on the same block serialize (round-2 review finding 4 regression)', () => {
  it('two simultaneous 60-qty ReserveSpace calls on a 100-pallet block: exactly one succeeds, the other fails with SpaceNotAvailableError, and only one row total was written', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId); // capacity 100, no existing allocations/reservations.

    const callOnce = (): ReturnType<typeof reserveSpace> =>
      reserveSpace(
        roleCtx,
        {
          blockId,
          clientId: fixtureClientId,
          qty: 60,
          uom: PALLET_UOM,
          reservedFrom: TODAY,
          expiresAt: daysFrom(TODAY, 10),
          reason: RESV_REASON_QUOTE_PENDING,
          correlationId: nextCorrelationId(),
        },
        deps,
      );

    const outcomes = await Promise.allSettled([callOnce(), callOnce()]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejectedOutcome = rejected[0] as PromiseRejectedResult;
    expect(rejectedOutcome.reason).toBeInstanceOf(SpaceNotAvailableError);

    // track the successful call's row for cleanup (afterAll also sweeps by block, but keep the
    // array-based bookkeeping consistent with the rest of the suite).
    const fulfilledOutcome = fulfilled[0] as PromiseFulfilledResult<{ id: string }>;
    fixtureReservationIds.push(fulfilledOutcome.value.id);

    // exactly ONE reservation row total (qty 60) was written across the two racing calls — the
    // SELECT...FOR UPDATE lock on the block row serialized them (the second call's
    // check_space_available call sees the first call's 60 already counted, leaving sellable=40 <
    // 60, and is rejected) instead of both reading a stale sellable=100 and both passing.
    expect(await countReservationsCreatedByCommand(blockId, fixtureClientId, [])).toBe(1);
    const rows = await getReservations(blockId, fixtureClientId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.qty).toBe('60.000');

    // and no wms.space_allocations row was written by this scenario either (ReserveSpace never
    // touches that table) — "only one row total was written across both tables' relevant rows".
    expect(await countAllocationsForBlock(blockId)).toBe(0);
  });
});

// --- Finding 3: a zero/negative-duration reservation is a DISTINCT typed error ---------------------
//
// round-1 review finding 3: `expiresAt <= reservedFrom` must throw the new typed
// ReservationDateRangeInvalidError (422), distinct from ReservationTooLongError (reserved solely
// for the 30-day space.reservation_max_days threshold).

describe('Finding 3: expiresAt <= reservedFrom throws ReservationDateRangeInvalidError, distinct from ReservationTooLongError', () => {
  it('expiresAt === reservedFrom (zero duration) -> ReservationDateRangeInvalidError; no row written', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);

    let caught: unknown;
    try {
      await reserveSpace(
        roleCtx,
        {
          blockId,
          clientId: fixtureClientId,
          qty: 10,
          uom: PALLET_UOM,
          reservedFrom: TODAY,
          expiresAt: TODAY, // zero duration.
          reason: RESV_REASON_QUOTE_PENDING,
          correlationId: nextCorrelationId(),
        },
        deps,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ReservationDateRangeInvalidError);
    expect(caught).not.toBeInstanceOf(ReservationTooLongError);
    expect(await countReservationsCreatedByCommand(blockId, fixtureClientId, [])).toBe(0);
  });

  it('expiresAt before reservedFrom (negative duration) -> ReservationDateRangeInvalidError; no row written', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);

    let caught: unknown;
    try {
      await reserveSpace(
        roleCtx,
        {
          blockId,
          clientId: fixtureClientId,
          qty: 10,
          uom: PALLET_UOM,
          reservedFrom: TODAY,
          expiresAt: daysFrom(TODAY, -1), // negative duration.
          reason: RESV_REASON_QUOTE_PENDING,
          correlationId: nextCorrelationId(),
        },
        deps,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ReservationDateRangeInvalidError);
    expect(caught).not.toBeInstanceOf(ReservationTooLongError);
    expect(await countReservationsCreatedByCommand(blockId, fixtureClientId, [])).toBe(0);
  });
});

// --- Finding 5: cross-entity isolation — a block belonging to an entity the caller isn't linked to -

describe("Finding 5: cross-entity isolation — a block belonging to an entity the caller isn't linked to", () => {
  it('AllocateSpace with an OUTSIDER (SALES_MGR, but only linked to a DIFFERENT entity) -> EntityScopeAmbiguousError; nothing written', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse(); // block under `entityId`, not `outsiderEntityId`.
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    const correlationId = nextCorrelationId();

    await expect(
      allocateSpace(
        outsiderCtx,
        {
          contractId: fixtureContractId,
          clientId: fixtureClientId,
          blockId,
          qty: 10,
          uom: PALLET_UOM,
          validFrom: TODAY,
          correlationId,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(EntityScopeAmbiguousError);

    expect(await countAllocationsForBlock(blockId)).toBe(0);
    const auditResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from platform.audit_log where correlation_id = $1`,
      [correlationId],
    );
    expect(Number(auditResult.rows[0]?.n ?? '0')).toBe(0);
  });

  it('ReserveSpace with the same OUTSIDER -> EntityScopeAmbiguousError; nothing written', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    const correlationId = nextCorrelationId();

    await expect(
      reserveSpace(
        outsiderCtx,
        {
          blockId,
          clientId: fixtureClientId,
          qty: 10,
          uom: PALLET_UOM,
          reservedFrom: TODAY,
          expiresAt: daysFrom(TODAY, 10),
          reason: RESV_REASON_QUOTE_PENDING,
          correlationId,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(EntityScopeAmbiguousError);

    expect(await countReservationsCreatedByCommand(blockId, fixtureClientId, [])).toBe(0);
    const auditResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from platform.audit_log where correlation_id = $1`,
      [correlationId],
    );
    expect(Number(auditResult.rows[0]?.n ?? '0')).toBe(0);
  });
});

// --- Round-4 review finding: qty with more decimals than the column's numeric(14,3) scale ---------
//
// `wms.space_allocations.qty` and `wms.space_reservations.qty` are numeric(14,3) (13B). A JS qty
// with more than 3 decimals (0.0004) passed a bare `qty > 0` check but Postgres rounds it to 0.000
// on INSERT: for ReserveSpace (no DB-level positive-qty CHECK — D7, the domain check is the ONLY
// enforcement) that silently committed a zero-qty 'active' reservation; for AllocateSpace the DB's
// own `positive_qty` CHECK fired (SQLSTATE 23514) and nothing mapped it, so it surfaced as an
// unhandled 500. The fix (domain/manage-space/invariants.ts hasValidQtyScale, QTY_DB_SCALE = 3)
// rejects ANY qty the column would alter — the round-to-zero case and a round-to-non-zero case
// (40.0006 -> 40.001) alike — as NonPositiveQtyError, mapped to 422 by
// ../../api/manage-space/handlers.ts, with NO business row and NO audit row written. Two layers are
// proven separately:
//   - the command (domain pre-check), for both commands;
//   - the repository backstop directly (the domain pre-check makes it unreachable through the
//     command): insertAllocation maps the `positive_qty` CHECK's 23514 to NonPositiveQtyError, and
//     both inserts RETURN qty as STORED at scale 3 — the value the audit row is built from, never
//     the raw input.

const QTY_ROUNDS_TO_ZERO = 0.0004; // numeric(14,3): 0.000.
const QTY_ROUNDS_UP = 40.0006; // numeric(14,3): 40.001.
const QTY_ROUNDS_UP_STORED = 40.001;
const QTY_VALID_SCALE = 12.5; // within scale 3 — stored as 12.500.
const QTY_VALID_SCALE_STORED = '12.500';

async function countAuditRows(correlationId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.audit_log where correlation_id = $1`,
    [correlationId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('Round-4 finding: a qty with more decimals than numeric(14,3) is a typed 422, never a zero-qty row or a 500', () => {
  it('ReserveSpace with qty 0.0004 (rounds to 0.000) -> NonPositiveQtyError; no wms.space_reservations row and no platform.audit_log row for its correlationId', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    const correlationId = nextCorrelationId();

    const caught = await captureError(() =>
      reserveSpace(
        roleCtx,
        {
          blockId,
          clientId: fixtureClientId,
          qty: QTY_ROUNDS_TO_ZERO,
          uom: PALLET_UOM,
          reservedFrom: TODAY,
          expiresAt: daysFrom(TODAY, 10),
          reason: RESV_REASON_QUOTE_PENDING,
          correlationId,
        },
        deps,
      ),
    );

    expect(caught).toBeInstanceOf(NonPositiveQtyError);
    expect(await countReservationsCreatedByCommand(blockId, fixtureClientId, [])).toBe(0);
    expect(await countAuditRows(correlationId)).toBe(0);
  });

  it('AllocateSpace with qty 0.0004 (rounds to 0.000) -> NonPositiveQtyError (typed 422, not an unhandled positive_qty CHECK violation); no wms.space_allocations row and no platform.audit_log row for its correlationId', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    const correlationId = nextCorrelationId();

    const caught = await captureError(() =>
      allocateSpace(
        roleCtx,
        {
          contractId: fixtureContractId,
          clientId: fixtureClientId,
          blockId,
          qty: QTY_ROUNDS_TO_ZERO,
          uom: PALLET_UOM,
          validFrom: TODAY,
          correlationId,
        },
        deps,
      ),
    );

    expect(caught).toBeInstanceOf(NonPositiveQtyError);
    expect(await countAllocationsForBlock(blockId)).toBe(0);
    expect(await countAuditRows(correlationId)).toBe(0);
  });

  it('ReserveSpace with qty 40.0006 (would be silently stored as 40.001) -> NonPositiveQtyError; no row and no audit row', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    const correlationId = nextCorrelationId();

    const caught = await captureError(() =>
      reserveSpace(
        roleCtx,
        {
          blockId,
          clientId: fixtureClientId,
          qty: QTY_ROUNDS_UP,
          uom: PALLET_UOM,
          reservedFrom: TODAY,
          expiresAt: daysFrom(TODAY, 10),
          reason: RESV_REASON_QUOTE_PENDING,
          correlationId,
        },
        deps,
      ),
    );

    expect(caught).toBeInstanceOf(NonPositiveQtyError);
    expect(await countReservationsCreatedByCommand(blockId, fixtureClientId, [])).toBe(0);
    expect(await countAuditRows(correlationId)).toBe(0);
  });

  it('AllocateSpace with qty 40.0006 (would be silently stored as 40.001) -> NonPositiveQtyError; no row and no audit row', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    const correlationId = nextCorrelationId();

    const caught = await captureError(() =>
      allocateSpace(
        roleCtx,
        {
          contractId: fixtureContractId,
          clientId: fixtureClientId,
          blockId,
          qty: QTY_ROUNDS_UP,
          uom: PALLET_UOM,
          validFrom: TODAY,
          correlationId,
        },
        deps,
      ),
    );

    expect(caught).toBeInstanceOf(NonPositiveQtyError);
    expect(await countAllocationsForBlock(blockId)).toBe(0);
    expect(await countAuditRows(correlationId)).toBe(0);
  });

  it('ReserveSpace and AllocateSpace with qty 12.5 (within scale 3) succeed; stored qty 12.500 and each audit_log new_value qty equals the stored value', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    const resvCorrelationId = nextCorrelationId();
    const allocCorrelationId = nextCorrelationId();

    const reservation = await reserveSpace(
      roleCtx,
      {
        blockId,
        clientId: fixtureClientId,
        qty: QTY_VALID_SCALE,
        uom: PALLET_UOM,
        reservedFrom: TODAY,
        expiresAt: daysFrom(TODAY, 10),
        reason: RESV_REASON_QUOTE_PENDING,
        correlationId: resvCorrelationId,
      },
      deps,
    );
    fixtureReservationIds.push((reservation as { id: string }).id);
    await allocateSpace(
      roleCtx,
      {
        contractId: fixtureContractId,
        clientId: fixtureClientId,
        blockId,
        qty: QTY_VALID_SCALE,
        uom: PALLET_UOM,
        validFrom: TODAY,
        correlationId: allocCorrelationId,
      },
      deps,
    );

    const storedResv = await getReservations(blockId, fixtureClientId);
    const storedAlloc = await getAllocations(blockId);
    expect(storedResv).toHaveLength(1);
    expect(storedAlloc).toHaveLength(1);
    expect(storedResv[0]?.qty).toBe(QTY_VALID_SCALE_STORED);
    expect(storedAlloc[0]?.qty).toBe(QTY_VALID_SCALE_STORED);

    const auditChecks = [
      { correlationId: resvCorrelationId, tableName: 'space_reservations', stored: storedResv[0]?.qty },
      { correlationId: allocCorrelationId, tableName: 'space_allocations', stored: storedAlloc[0]?.qty },
    ];
    for (const check of auditChecks) {
      const auditResult: QueryResult<{ qty: string | null }> = await pool.query(
        `select new_value->>'qty' as qty from platform.audit_log
          where correlation_id = $1 and schema_name = 'wms' and table_name = $2`,
        [check.correlationId, check.tableName],
      );
      expect(auditResult.rows).toHaveLength(1);
      const auditQty = auditResult.rows[0]?.qty ?? null;
      expect(auditQty).not.toBeNull();
      expect(Number(auditQty)).toBe(Number(check.stored));
    }
  });
});

describe('Round-4 finding: repository backstop — 23514 positive_qty mapped to a typed error; inserts RETURN qty as stored at scale 3', () => {
  it('insertAllocation with qty 0.0004 (bypassing the domain pre-check) -> NonPositiveQtyError from the positive_qty CHECK (SQLSTATE 23514), never a raw DB error; no row written', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);

    const caught = await captureError(() =>
      withContext(roleCtx, (tx) =>
        deps.repo.insertAllocation(tx, {
          entityId,
          contractId: fixtureContractId,
          clientId: fixtureClientId,
          blockId,
          allocType: null,
          qty: QTY_ROUNDS_TO_ZERO,
          uom: PALLET_UOM,
          serviceId: null,
          validFrom: TODAY,
          validTo: null,
          minChargeApplies: null,
          createdBy: SALES_MGR_ACTOR_UUID,
        }),
      ),
    );

    expect(caught).toBeInstanceOf(NonPositiveQtyError);
    expect(await countAllocationsForBlock(blockId)).toBe(0);
  });

  it('insertAllocation with qty 40.0006 (bypassing the domain pre-check) RETURNS qty 40.001 — the value stored, not the raw input', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);

    const inserted = await withContext(roleCtx, (tx) =>
      deps.repo.insertAllocation(tx, {
        entityId,
        contractId: fixtureContractId,
        clientId: fixtureClientId,
        blockId,
        allocType: null,
        qty: QTY_ROUNDS_UP,
        uom: PALLET_UOM,
        serviceId: null,
        validFrom: TODAY,
        validTo: null,
        minChargeApplies: null,
        createdBy: SALES_MGR_ACTOR_UUID,
      }),
    );

    expect(inserted.qty).toBe(QTY_ROUNDS_UP_STORED);
    const rows = await getAllocations(blockId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.qty)).toBe(inserted.qty);
  });

  it('insertReservation with qty 40.0006 (bypassing the domain pre-check) RETURNS qty 40.001 — the value stored, not the raw input', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);

    const inserted = await withContext(roleCtx, (tx) =>
      deps.repo.insertReservation(tx, {
        entityId,
        blockId,
        clientId: fixtureClientId,
        quoteId: null,
        opportunityId: null,
        qty: QTY_ROUNDS_UP,
        uom: PALLET_UOM,
        reservedFrom: TODAY,
        expiresAt: daysFrom(TODAY, 10),
        reason: RESV_REASON_QUOTE_PENDING,
        reservedBy: SALES_MGR_ACTOR_UUID,
      }),
    );
    fixtureReservationIds.push(inserted.id);

    expect(inserted.qty).toBe(QTY_ROUNDS_UP_STORED);
    const rows = await getReservations(blockId, fixtureClientId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.qty)).toBe(inserted.qty);
  });
});
