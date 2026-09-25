// modules/fleet/tests/assert-vehicle-assignable/handlers.test.ts — WBS 3.1.
//
// The api layer's contract (../../api/assert-vehicle-assignable/handlers.ts), mirroring
// ../register-vehicle/handlers.test.ts's own request/response shape (ApiRequest/ApiResult), with
// ONE deliberate difference the brief calls out: this endpoint is a pure read-and-assert (no
// write, no side effect), so it does NOT require an Idempotency-Key header — brief, verbatim:
// "No Idempotency-Key — this is a pure read-and-assert, no write, no side effect."
//
// Response-shape decisions this file PINS (pg-tester's own choice — the brief does not dictate a
// status code here, since no existing handlers.ts in this module returned a void success yet):
//   - success -> HTTP 200, `body: undefined` (no return value — same `ApiSuccess<TBody>` envelope
//     shape as every other handler in this module, just with TBody = void);
//   - the gate itself failing (VehicleNotAssignableError) -> HTTP 422, same status class as this
//     module's OWN already-established convention for a typed business-rule rejection
//     (VehicleDocumentAccessDeniedError -> 422 in ../register-vehicle/handlers.ts);
//   - a vehicleId with no readable tms.vehicles row (VehicleNotFoundError) -> HTTP 404.
// If pg-reviewer / the Master prefers 204 for the success case, that is a legitimate finding to
// fix — a status-code preference, not a contract or invariant.
//
// Fixture/RLS pattern: admin pool, one real identity.users/user_entities row for the internal
// actor — same as ../register-vehicle/handlers.test.ts and ./assert-vehicle-assignable.test.ts.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';

import { registerVehicle } from '../../application/register-vehicle/index.js';
import { createRegisterVehicleDeps } from '../../api/register-vehicle/composition.js';
import { createAssertVehicleAssignableDeps } from '../../api/assert-vehicle-assignable/composition.js';

// The module under test — does not exist yet with this behaviour (RED).
import { handleAssertVehicleAssignable, type ApiRequest } from '../../api/assert-vehicle-assignable/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const FIXTURE_ACTOR_UUID = '00000000-0000-4000-8000-0000000032c1';
const VEHICLE_TYPE = 'van'; // 01-Data-Model.sql:848 comment.
const OWNERSHIP = 'owned'; // 01-Data-Model.sql:851 comment.
const DOC_TYPE_REGISTRATION = 'registration'; // 01-Data-Model.sql:861 comment.
// 01-Data-Model.sql:865 tms.vehicle_documents.alert_days_before int not null default 30 — reused as
// the fixture literal (Finding 10, round 2), same constant name as ./assert-vehicle-assignable.test.ts
// and ../register-vehicle/register-vehicle.test.ts.
const ALERT_DAYS_BEFORE_DEFAULT = 30;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FAR_FUTURE_DAYS = 365;
const PAST_DAYS = 5;

const FIXTURE_NOW = new Date('2026-09-25T03:00:00.000Z');
const clock = new FixedClock(FIXTURE_NOW);
const ids = new SequentialIdGenerator(3301);
const registerDeps = createRegisterVehicleDeps({ clock, ids });
const ctx = { userId: FIXTURE_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
const fixtureVehicleIds: string[] = [];

function requestWithHeaders<TBody>(body: TBody, headers: Record<string, string> = {}): ApiRequest<TBody> {
  return { headers, body, ctx };
}

function futureExpiry(days: number): string {
  return new Date(FIXTURE_NOW.getTime() + days * ONE_DAY_MS).toISOString().slice(0, 10);
}

function pastExpiry(days: number): string {
  return new Date(FIXTURE_NOW.getTime() - days * ONE_DAY_MS).toISOString().slice(0, 10);
}

/** Finding 5 (round 2): the i18nKey/params assertion needs the fixture's own plateNo to compare
 *  against, so this variant returns both instead of just the vehicleId. */
async function registerFixtureVehicleWithPlateNo(
  plateNoPrefix: string,
  expiryDate: string | null,
): Promise<{ readonly vehicleId: string; readonly plateNo: string }> {
  const plateNo = `${plateNoPrefix}-${randomUUID()}`;
  const vehicleId = await registerFixtureVehicleForPlateNo(plateNo, expiryDate);
  return { vehicleId, plateNo };
}

async function registerFixtureVehicle(plateNoPrefix: string, expiryDate: string | null): Promise<string> {
  const plateNo = `${plateNoPrefix}-${randomUUID()}`;
  return registerFixtureVehicleForPlateNo(plateNo, expiryDate);
}

async function registerFixtureVehicleForPlateNo(plateNo: string, expiryDate: string | null): Promise<string> {
  const documents = expiryDate
    ? [
        {
          docType: DOC_TYPE_REGISTRATION,
          docNo: null,
          issueDate: null,
          expiryDate,
          fileUrl: null,
          alertDaysBefore: ALERT_DAYS_BEFORE_DEFAULT,
        },
      ]
    : [];
  const result = await registerVehicle(
    ctx,
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
  const row = entityResult.rows[0];
  if (!row) throw new Error(`fixture platform.entities row not found for code 'PST'`);
  entityId = row.id;

  // D-183: no DELETE here — beforeAll only upserts (ON CONFLICT DO UPDATE/NOTHING below); the
  // afterAll block below is the only place this file deletes rows.
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type)
     values ($1, $2, $3, 'internal')
     on conflict (id) do update set email = excluded.email`,
    [FIXTURE_ACTOR_UUID, `_fleet_assertveh_handlers_${FIXTURE_ACTOR_UUID}_${randomUUID()}@test.invalid`, 'ممثل اختبار معالجات بوابة إسناد مركبة'],
  );
  await pool.query(
    `insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict (user_id, entity_id) do nothing`,
    [FIXTURE_ACTOR_UUID, entityId],
  );
});

afterAll(async () => {
  if (fixtureVehicleIds.length > 0) {
    await pool.query(`delete from tms.vehicle_documents where vehicle_id = any($1::uuid[])`, [fixtureVehicleIds]);
    await pool.query(`delete from tms.vehicles where id = any($1::uuid[])`, [fixtureVehicleIds]);
  }
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.end();
});

describe('no Idempotency-Key header is required — this is a read-and-assert, not a write command', () => {
  it('handleAssertVehicleAssignable: a request with NO Idempotency-Key header does NOT get a 400 the way a write command would', async () => {
    const deps = createAssertVehicleAssignableDeps();
    const vehicleId = await registerFixtureVehicle('KWT-H-NOKEY', futureExpiry(FAR_FUTURE_DAYS));

    const result = await handleAssertVehicleAssignable(
      requestWithHeaders({ vehicleId, at: FIXTURE_NOW.toISOString(), correlationId: randomUUID() }),
      deps,
    );

    expect(result.status).not.toBe(400);
  });
});

describe('a body that fails the Zod contract is rejected with a 400 Problem', () => {
  it('handleAssertVehicleAssignable: a body with a non-uuid vehicleId -> 400', async () => {
    const deps = createAssertVehicleAssignableDeps();
    const result = await handleAssertVehicleAssignable(
      requestWithHeaders({ vehicleId: 'not-a-uuid', at: FIXTURE_NOW.toISOString(), correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
  });

  it('handleAssertVehicleAssignable: a body missing `at` -> 400', async () => {
    const deps = createAssertVehicleAssignableDeps();
    const result = await handleAssertVehicleAssignable(
      requestWithHeaders({ vehicleId: randomUUID(), correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
  });
});

describe('a vehicle whose gate passes -> success, no body', () => {
  it('handleAssertVehicleAssignable: no expired documents -> status 200, body undefined (pg-tester\'s own convention, see file header)', async () => {
    const deps = createAssertVehicleAssignableDeps();
    const vehicleId = await registerFixtureVehicle('KWT-H-OK', futureExpiry(FAR_FUTURE_DAYS));

    const result = await handleAssertVehicleAssignable(
      requestWithHeaders({ vehicleId, at: FIXTURE_NOW.toISOString(), correlationId: randomUUID() }),
      deps,
    );

    expect(result.status).toBe(200);
    expect(result.body).toBeUndefined();
  });
});

describe('a vehicle whose gate fails -> 422 Problem (same class as this module\'s own established business-rule-rejection status)', () => {
  it('handleAssertVehicleAssignable: an expired document -> status 422, title "VehicleNotAssignableError"', async () => {
    const deps = createAssertVehicleAssignableDeps();
    const expiredExpiryDate = pastExpiry(PAST_DAYS);
    const { vehicleId, plateNo } = await registerFixtureVehicleWithPlateNo('KWT-H-422', expiredExpiryDate);

    const result = await handleAssertVehicleAssignable(
      requestWithHeaders({ vehicleId, at: FIXTURE_NOW.toISOString(), correlationId: randomUUID() }),
      deps,
    );

    expect(result.status).toBe(422);
    // Narrows `result.body` (typed as a union across ApiResult's two members, same discriminant
    // limitation documented in ../register-vehicle/handlers.test.ts's own `asProblemBody` helper —
    // `status` alone is not a TS literal discriminant here) via an `in` check instead of `status`.
    if (typeof result.body !== 'object' || result.body === null || !('title' in result.body)) {
      throw new Error('expected a Problem body with a title, got: ' + JSON.stringify(result.body));
    }
    expect(result.body.title).toBe('VehicleNotAssignableError');

    // Finding 5 (round 2): the i18n key/params must reach the API response, not stay comment-only —
    // pg-reviewer round 1 (final scope) finding 5.
    expect(result.body).toMatchObject({
      i18nKey: 'fleet.vehicle.notAssignable',
      params: {
        plateNo,
        expiredDocuments: [{ docType: DOC_TYPE_REGISTRATION, expiryDate: expiredExpiryDate }],
      },
    });
  });
});

// --- Finding 4 (round 2): a vehicleId with no readable tms.vehicles row -> 404 ---------------------

describe('a vehicleId with no readable tms.vehicles row -> 404 Problem', () => {
  it('handleAssertVehicleAssignable: a random uuid that was never registered -> status 404, title "VehicleNotFoundError"', async () => {
    const deps = createAssertVehicleAssignableDeps();

    const result = await handleAssertVehicleAssignable(
      requestWithHeaders({ vehicleId: randomUUID(), at: FIXTURE_NOW.toISOString(), correlationId: randomUUID() }),
      deps,
    );

    expect(result.status).toBe(404);
    if (typeof result.body !== 'object' || result.body === null || !('title' in result.body)) {
      throw new Error('expected a Problem body with a title, got: ' + JSON.stringify(result.body));
    }
    expect(result.body.title).toBe('VehicleNotFoundError');
  });
});
