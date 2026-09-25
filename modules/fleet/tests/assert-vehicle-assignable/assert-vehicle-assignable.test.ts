// modules/fleet/tests/assert-vehicle-assignable/assert-vehicle-assignable.test.ts — WBS 3.1.
//
// Integration tests, one per scenario in ./assert-vehicle-assignable.feature, against the real
// database (RLS genuinely enforced — every command call goes through withContext, same discipline
// as ../register-vehicle/register-vehicle.test.ts's own precedent). Sources:
// docs/notes/slice-briefs/_slice-3.1.brief.md "Master design correction" section, second Gherkin
// Feature block and second Contract section (verbatim); database/schema/01-Data-Model.sql:843-866
// (tms.vehicles, tms.vehicle_documents).
//
// Fixture strategy: a vehicle + its documents must already exist before AssertVehicleAssignable can
// read them — either via direct SQL fixture setup, or by calling the already-built RegisterVehicle
// command to create the fixture. pg-tester's own choice, made here: this file calls the
// already-built, already-green `registerVehicle` command — registration itself never blocks on an
// expired document (../register-vehicle/register-vehicle.test.ts), so it is the cleanest way to get
// a real tms.vehicles row with real tms.vehicle_documents rows, exactly as AssertVehicleAssignable
// will read them back.
//
// `expiredDocumentsOf` (modules/fleet/domain/register-vehicle/invariants.ts) is reused by the
// command under test, not re-verified here — its own property tests already exhaustively cover the
// Kuwait-local date-comparison predicate (../register-vehicle/invariants.property.test.ts). This
// file only pins AssertVehicleAssignable's OWN behaviour: reading a vehicle's current documents and
// throwing (or not) based on the caller-supplied `at`.
//
// D-183: DELETE only in afterAll; beforeAll fixture upserts use INSERT ... ON CONFLICT DO
// UPDATE/NOTHING.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { AssertVehicleAssignableInputSchema } from '@pg-eos/contracts/fleet/assert-vehicle-assignable';

// The fixture-creation command — already built, already green (../register-vehicle/*).
import { registerVehicle } from '../../application/register-vehicle/index.js';
import { createRegisterVehicleDeps } from '../../api/register-vehicle/composition.js';

// The modules under test — do not yet exist with this behaviour (RED).
import { assertVehicleAssignable } from '../../application/assert-vehicle-assignable/index.js';
import { createAssertVehicleAssignableDeps } from '../../api/assert-vehicle-assignable/composition.js';
import { VehicleNotAssignableError, VehicleNotFoundError } from '../../domain/assert-vehicle-assignable/errors.js';
// Finding 1 (round 2): the fail-closed security fix reuses register-vehicle's own
// VehicleDocumentAccessDeniedError for a non-internal caller — same class the brief's own
// "Master design correction" section names (never a second error class for the same refusal).
import { VehicleDocumentAccessDeniedError } from '../../domain/register-vehicle/errors.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

// --- literals, each cited to the schema fact or the brief line they come from -------------------

const ALERT_DAYS_BEFORE_DEFAULT = 30; // 01-Data-Model.sql:865 default.
const VEHICLE_TYPE = 'van'; // 01-Data-Model.sql:848 comment.
const OWNERSHIP = 'owned'; // 01-Data-Model.sql:851 comment.
const DOC_TYPE_REGISTRATION = 'registration'; // 01-Data-Model.sql:861 comment.
const DOC_TYPE_INSURANCE = 'insurance';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FAR_FUTURE_DAYS = 365;
const NEAR_FUTURE_DAYS = 30;
const PAST_DAYS = 5;

// Fixture "current time" — used both as registerVehicle's own injected clock (so canBeAssigned on
// the fixture is computed against a known instant) AND as the "current time" the feature's own
// Scenario wording refers to ("at the current time").
const FIXTURE_NOW = new Date('2026-09-25T00:00:00.000Z');
const clock = new FixedClock(FIXTURE_NOW);
const ids = new SequentialIdGenerator(3201);
const registerDeps = createRegisterVehicleDeps({ clock, ids });
const assertDeps = createAssertVehicleAssignableDeps();

const INTERNAL_ACTOR_UUID = '00000000-0000-4000-8000-0000000032a1';
const internalCtx = { userId: INTERNAL_ACTOR_UUID, clientId: null, isInternal: true };
// Finding 5 (round 2, this fix round): a non-internal session — gets a real identity.user_entities
// row for the fixture vehicle's own entity (same pattern as ../register-vehicle/register-vehicle.test.ts
// lines 222-236's own non-internal-actor fixture), so tms.vehicles' own entity_scope RLS lets this
// actor SEE the vehicle. Only tms.vehicle_documents' internal_only RLS silently empties its SELECT —
// this is exactly the fixture the "non-internal caller with an expired document" test below needs to
// reach the real vulnerability path (see that describe block for the full reasoning).
const NON_INTERNAL_ACTOR_UUID = '00000000-0000-4000-8000-0000000032a2';
const nonInternalCtx = { userId: NON_INTERNAL_ACTOR_UUID, clientId: null, isInternal: false };

let entityId: string;
const fixtureVehicleIds: string[] = [];

function futureExpiry(daysFromFixtureNow: number): string {
  return new Date(FIXTURE_NOW.getTime() + daysFromFixtureNow * ONE_DAY_MS).toISOString().slice(0, 10);
}

function pastExpiry(daysBeforeFixtureNow: number): string {
  return new Date(FIXTURE_NOW.getTime() - daysBeforeFixtureNow * ONE_DAY_MS).toISOString().slice(0, 10);
}

// Finding 3 (round 2): the Kuwait-local "today" of FIXTURE_NOW, plain `YYYY-MM-DD` — same technique
// as ../register-vehicle/register-vehicle.test.ts's own `kuwaitTodayExpiry` (pg-reviewer round 1,
// Finding 1's Kuwait-local-date comparison), so a fixture document expiring "today" matches exactly
// what the gate itself computes.
const BUSINESS_TIME_ZONE = 'Asia/Kuwait';
function kuwaitTodayExpiry(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(FIXTURE_NOW);
}

interface DocumentInput {
  readonly docType: string;
  readonly docNo: string | null;
  readonly issueDate: string | null;
  readonly expiryDate: string;
  readonly fileUrl: string | null;
  readonly alertDaysBefore: number;
}

function document(docType: string, expiryDate: string): DocumentInput {
  return {
    docType,
    docNo: null,
    issueDate: null,
    expiryDate,
    fileUrl: null,
    alertDaysBefore: ALERT_DAYS_BEFORE_DEFAULT,
  };
}

/** Registers a fixture vehicle (via the already-built, already-green RegisterVehicle command) and
 *  returns its id. Registration itself never blocks on an expired document, so this works for
 *  every scenario below, including the "one expired document" ones. */
async function registerFixtureVehicle(plateNoPrefix: string, documents: readonly DocumentInput[]): Promise<string> {
  const plateNo = `${plateNoPrefix}-${randomUUID()}`;
  const result = await registerVehicle(
    internalCtx,
    {
      plateNo,
      make: null,
      model: null,
      year: null,
      vehicleType: VEHICLE_TYPE,
      capacityKg: null,
      capacityCbm: null,
      isRefrigerated: false,
      ownership: OWNERSHIP,
      assignedClientId: null,
      documents,
      correlationId: randomUUID(),
    },
    registerDeps,
  );
  fixtureVehicleIds.push(result.id);
  return result.id;
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow) throw new Error(`fixture platform.entities row not found for code 'PST'`);
  entityId = entityRow.id;

  // D-183: no DELETE here — beforeAll only upserts (ON CONFLICT DO UPDATE/NOTHING below); the
  // afterAll block below is the only place this file deletes rows.
  // Finding 5 (round 2, this fix round): both actors get a real identity.user_entities row for the
  // same fixture entity — same loop pattern as ../register-vehicle/register-vehicle.test.ts lines
  // 222-236 — so the non-internal actor's vehicle-visibility comes from genuine RLS, not from an
  // absent-actor 404 shortcut.
  for (const userId of [INTERNAL_ACTOR_UUID, NON_INTERNAL_ACTOR_UUID]) {
    await pool.query(
      `insert into identity.users (id, email, full_name_ar, user_type)
       values ($1, $2, $3, 'internal')
       on conflict (id) do update set email = excluded.email`,
      [userId, `_fleet_assertveh_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار بوابة إسناد مركبة — WBS 3.1'],
    );
    await pool.query(
      `insert into identity.user_entities (user_id, entity_id) values ($1, $2)
       on conflict (user_id, entity_id) do nothing`,
      [userId, entityId],
    );
  }
});

afterAll(async () => {
  if (fixtureVehicleIds.length > 0) {
    await pool.query(`delete from tms.vehicle_documents where vehicle_id = any($1::uuid[])`, [fixtureVehicleIds]);
    await pool.query(`delete from tms.vehicles where id = any($1::uuid[])`, [fixtureVehicleIds]);
  }
  for (const userId of [INTERNAL_ACTOR_UUID, NON_INTERNAL_ACTOR_UUID]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
});

// --- contract shape (pins the CORRECT contract, brief second Contract section) -------------------

describe('@pg-eos/contracts/fleet/assert-vehicle-assignable — AssertVehicleAssignableInputSchema (brief Contract line)', () => {
  it('accepts { vehicleId, at, correlationId } and carries no caller-supplied entityId/actorId field', () => {
    const parsed = AssertVehicleAssignableInputSchema.parse({
      vehicleId: randomUUID(),
      at: FIXTURE_NOW.toISOString(),
      correlationId: randomUUID(),
    });
    expect('entityId' in parsed).toBe(false);
    expect('actorId' in parsed).toBe(false);
  });

  it('rejects a non-uuid vehicleId', () => {
    expect(() =>
      AssertVehicleAssignableInputSchema.parse({
        vehicleId: 'not-a-uuid',
        at: FIXTURE_NOW.toISOString(),
        correlationId: randomUUID(),
      }),
    ).toThrow();
  });

  it('rejects a non-ISO-datetime `at`', () => {
    expect(() =>
      AssertVehicleAssignableInputSchema.parse({
        vehicleId: randomUUID(),
        at: 'not-a-date',
        correlationId: randomUUID(),
      }),
    ).toThrow();
  });
});

// --- Scenario: A vehicle with no expired documents passes the gate -------------------------------

describe('Scenario: A vehicle with no expired documents passes the gate', () => {
  it('resolves with no value — no error is thrown', async () => {
    const vehicleId = await registerFixtureVehicle('KWT-ASSERT-OK', [
      document(DOC_TYPE_REGISTRATION, futureExpiry(FAR_FUTURE_DAYS)),
      document(DOC_TYPE_INSURANCE, futureExpiry(NEAR_FUTURE_DAYS)),
    ]);

    await expect(
      assertVehicleAssignable(internalCtx, { vehicleId, at: FIXTURE_NOW, correlationId: randomUUID() }, assertDeps),
    ).resolves.toBeUndefined();
  });
});

// --- Scenario: A vehicle with any expired document fails the gate --------------------------------

describe('Scenario: A vehicle with any expired document fails the gate', () => {
  it('throws VehicleNotAssignableError carrying the vehicle plateNo and the expired document docType/expiryDate as structured params', async () => {
    const expiredExpiryDate = pastExpiry(PAST_DAYS);
    const plateNo = `KWT-ASSERT-EXPIRED-${randomUUID()}`;
    const result = await registerVehicle(
      internalCtx,
      {
        plateNo,
        make: null,
        model: null,
        year: null,
        vehicleType: VEHICLE_TYPE,
        capacityKg: null,
        capacityCbm: null,
        isRefrigerated: false,
        ownership: OWNERSHIP,
        assignedClientId: null,
        documents: [document(DOC_TYPE_REGISTRATION, expiredExpiryDate)],
        correlationId: randomUUID(),
      },
      registerDeps,
    );
    fixtureVehicleIds.push(result.id);

    const call = assertVehicleAssignable(
      internalCtx,
      { vehicleId: result.id, at: FIXTURE_NOW, correlationId: randomUUID() },
      assertDeps,
    );

    await expect(call).rejects.toBeInstanceOf(VehicleNotAssignableError);
    let caught: unknown;
    await call.catch((c) => {
      caught = c;
    });
    const error = caught as VehicleNotAssignableError;
    expect(error.plateNo).toBe(plateNo);
    expect(error.expiredDocuments).toEqual([{ docType: DOC_TYPE_REGISTRATION, expiryDate: expiredExpiryDate }]);
    // brief (Scenario, verbatim): "never a hardcoded message" — the params carry the data, the message itself is never
    // asserted on here (no i18n package bootstrap yet — brief, "same ... precedent 2.11/2.9b").
  });
});

// --- Finding 3 (round 2): a MIXED fixture — a mutant returning every document as "expired" must ---
// --- fail this test; only the one truly-expired document may appear in expiredDocuments. ----------

describe('Finding 3 (round 2): a mixed-fixture vehicle reports EXACTLY the truly-expired documents, not every document', () => {
  it('one expired, one future, one expiring exactly "today" (Kuwait-local) — expiredDocuments equals exactly the one expired document', async () => {
    const expiredExpiryDate = pastExpiry(PAST_DAYS);
    const futureExpiryDate = futureExpiry(FAR_FUTURE_DAYS);
    const todayExpiryDate = kuwaitTodayExpiry();
    const plateNo = `KWT-ASSERT-MIXED-${randomUUID()}`;

    const result = await registerVehicle(
      internalCtx,
      {
        plateNo,
        make: null,
        model: null,
        year: null,
        vehicleType: VEHICLE_TYPE,
        capacityKg: null,
        capacityCbm: null,
        isRefrigerated: false,
        ownership: OWNERSHIP,
        assignedClientId: null,
        documents: [
          document(DOC_TYPE_REGISTRATION, expiredExpiryDate),
          document(DOC_TYPE_INSURANCE, futureExpiryDate),
          document('permit', todayExpiryDate),
        ],
        correlationId: randomUUID(),
      },
      registerDeps,
    );
    fixtureVehicleIds.push(result.id);

    const call = assertVehicleAssignable(
      internalCtx,
      { vehicleId: result.id, at: FIXTURE_NOW, correlationId: randomUUID() },
      assertDeps,
    );

    await expect(call).rejects.toBeInstanceOf(VehicleNotAssignableError);
    let caught: unknown;
    await call.catch((c) => {
      caught = c;
    });
    const error = caught as VehicleNotAssignableError;
    // EXACTLY the one truly-expired document — a mutant that treated every document as expired
    // (or the future/today ones as expired) would fail this assertion.
    expect(error.expiredDocuments).toEqual([{ docType: DOC_TYPE_REGISTRATION, expiryDate: expiredExpiryDate }]);
  });
});

// --- Finding 1 (round 2, most important): the fail-closed security fix — a non-internal caller ----
// --- must NOT be able to resolve successfully just because RLS silently hid the documents. --------

describe('Finding 1 (round 2): a non-internal caller on a vehicle with an expired document does not resolve successfully', () => {
  it('throws VehicleDocumentAccessDeniedError — never resolves, even though the vehicle genuinely has an expired document', async () => {
    const expiredExpiryDate = pastExpiry(PAST_DAYS);
    const vehicleId = await registerFixtureVehicle('KWT-ASSERT-SECURITY', [
      document(DOC_TYPE_REGISTRATION, expiredExpiryDate),
    ]);

    // Finding 5 (round 2, this fix round): nonInternalCtx's actor now has a real
    // identity.user_entities row for the fixture vehicle's own entity (beforeAll above), so
    // tms.vehicles' own entity_scope RLS genuinely lets this actor SEE the vehicle row — the
    // command reaches the real read path instead of stopping at a 404. The regression this test
    // guards against: without the ctx.isInternal fail-closed check, this non-internal session's
    // SELECT on tms.vehicle_documents (internal_only RLS) would silently return ZERO rows even
    // though the vehicle itself is visible; expiredDocumentsOf([], at) would then be empty and
    // this call would wrongly RESOLVE — exactly what "hard gate" must never do. Deleting the
    // ctx.isInternal check would make this exact fixture (vehicle visible, documents silently
    // emptied by RLS) resolve successfully instead of throwing, which is what proves this test
    // exercises the fail-closed check and not an unrelated VehicleNotFoundError 404.
    const call = assertVehicleAssignable(
      nonInternalCtx,
      { vehicleId, at: FIXTURE_NOW, correlationId: randomUUID() },
      assertDeps,
    );

    await expect(call).rejects.toBeInstanceOf(VehicleDocumentAccessDeniedError);
    await expect(call).rejects.not.toBeInstanceOf(VehicleNotAssignableError);
    await expect(call).rejects.not.toBeInstanceOf(VehicleNotFoundError);
  });
});

// --- Scenario: A vehicle with zero documents passes the gate -------------------------------------

describe('Scenario: A vehicle with zero documents passes the gate', () => {
  it('resolves with no value — vacuously true, same as registration\'s own canBeAssigned', async () => {
    const vehicleId = await registerFixtureVehicle('KWT-ASSERT-NODOCS', []);

    await expect(
      assertVehicleAssignable(internalCtx, { vehicleId, at: FIXTURE_NOW, correlationId: randomUUID() }, assertDeps),
    ).resolves.toBeUndefined();
  });
});

// --- Scenario: The gate is evaluated at the given instant, not "now" implicitly ------------------

describe('Scenario: The gate is evaluated at the given instant, not "now" implicitly', () => {
  it('passes when `at` is BEFORE the document\'s expiry, and throws when `at` is AFTER it — the caller\'s own `at` governs', async () => {
    const documentExpiryDate = futureExpiry(NEAR_FUTURE_DAYS);
    const vehicleId = await registerFixtureVehicle('KWT-ASSERT-ATPARAM', [
      document(DOC_TYPE_REGISTRATION, documentExpiryDate),
    ]);

    // BEFORE the document's own expiry — resolves.
    const beforeExpiry = new Date(FIXTURE_NOW.getTime() + (NEAR_FUTURE_DAYS - 1) * ONE_DAY_MS);
    await expect(
      assertVehicleAssignable(internalCtx, { vehicleId, at: beforeExpiry, correlationId: randomUUID() }, assertDeps),
    ).resolves.toBeUndefined();

    // AFTER the document's own expiry — throws, even though the real wall clock at the moment this
    // test itself runs has not reached `documentExpiryDate` (it is `NEAR_FUTURE_DAYS` in the
    // future) — proof that the command reads ONLY the caller-supplied `at`, never a wall clock.
    const afterExpiry = new Date(FIXTURE_NOW.getTime() + (NEAR_FUTURE_DAYS + 10) * ONE_DAY_MS);
    await expect(
      assertVehicleAssignable(internalCtx, { vehicleId, at: afterExpiry, correlationId: randomUUID() }, assertDeps),
    ).rejects.toBeInstanceOf(VehicleNotAssignableError);
  });
});

// --- Finding 4 (round 2): a vehicleId that resolves to no readable tms.vehicles row -----------------

describe('Finding 4 (round 2): a vehicleId with no readable tms.vehicles row', () => {
  it('throws VehicleNotFoundError — a random uuid that was never registered', async () => {
    const nonExistentVehicleId = randomUUID();

    await expect(
      assertVehicleAssignable(
        internalCtx,
        { vehicleId: nonExistentVehicleId, at: FIXTURE_NOW, correlationId: randomUUID() },
        assertDeps,
      ),
    ).rejects.toBeInstanceOf(VehicleNotFoundError);
  });
});
