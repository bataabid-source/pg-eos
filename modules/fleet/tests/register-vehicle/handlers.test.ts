// modules/fleet/tests/register-vehicle/handlers.test.ts — WBS 3.1.
//
// The api layer's contract (../../api/register-vehicle/handlers.ts), one test per mapping:
//   - a missing Idempotency-Key header -> 400 (CLAUDE.md · ARCHITECTURE: "Every write endpoint
//     requires an Idempotency-Key");
//   - a body that fails the Zod contract -> 400;
//   - a replayed call with the same key but a DIFFERENT body -> 409 IdempotencyConflictError;
//   - a same key / same body replay -> 200, identical response, no second row written;
//   - an unexpected thrown error (an FK violation on assignedClientId — a raw, untyped error, not
//     a typed domain error) -> 500, generic detail, logged through deps.logger.error (pino, no
//     console.log — CLAUDE.md · AGENT CONSTRAINTS).
//
// Shape based on this slice's own api/register-vehicle/handlers.ts (built earlier in this same
// slice, not an earlier fleet slice — fleet has no earlier slice of its own), following the same
// 400/409/200/500 Problem-envelope discipline as every prior module's own handlers.test.ts
// (cross-module precedent).
// Fixture/RLS pattern: admin pool, one real identity.users/user_entities row for the internal
// actor — same as ./register-vehicle.test.ts.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';

import { createRegisterVehicleDeps } from '../../api/register-vehicle/composition.js';
import type { Logger } from '../../application/register-vehicle/ports.js';

// The module under test — does not exist yet with this error-mapping behaviour (RED).
import { handleRegisterVehicle, type ApiRequest } from '../../api/register-vehicle/handlers.js';

/** Narrows a `result.body` (typed `RegisterVehicleResult | Problem`, since `ApiResult<TBody>`'s own
 *  `status` field is not a literal `200` on both union members and so does not discriminate for
 *  TypeScript) down to the Problem shape — mechanical typecheck fix only, asserts nothing new:
 *  `RegisterVehicleResult` structurally never declares `title`, so the `in` check below already
 *  eliminates it from the union for every caller. */
function asProblemBody(body: unknown): { readonly title: string; readonly detail: string } {
  if (typeof body !== 'object' || body === null || !('title' in body) || !('detail' in body)) {
    throw new Error('expected a Problem body with title/detail, got: ' + JSON.stringify(body));
  }
  return body as { readonly title: string; readonly detail: string };
}

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const FIXTURE_ACTOR_UUID = '00000000-0000-4000-8000-0000000031c1';
const NON_INTERNAL_ACTOR_UUID = '00000000-0000-4000-8000-0000000031c2';
// 01-Data-Model.sql:848 comment: van · pickup · truck_3t · truck_7t · refrigerated · motorcycle.
const VEHICLE_TYPE = 'van';
// 01-Data-Model.sql:851 comment: owned · leased · subcontracted.
const OWNERSHIP = 'owned';

const clock = new FixedClock(new Date('2026-09-25T03:00:00.000Z'));
const ids = new SequentialIdGenerator(3101);
const ctx = { userId: FIXTURE_ACTOR_UUID, clientId: null, isInternal: true };
// pg-reviewer round 1, Finding 3: the non-internal actor whose write tms.vehicle_documents' own
// internal_only RLS policy rejects, mapped by handlers.ts to a 422 Problem.
const nonInternalCtx = { userId: NON_INTERNAL_ACTOR_UUID, clientId: null, isInternal: false };

let entityId: string;
const usedPlateNos: string[] = [];

function requestWithKey<TBody>(
  body: TBody,
  idempotencyKey?: string,
  requestCtx: typeof ctx = ctx,
): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx: requestCtx };
}

function requestWithoutKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: {}, body, ctx };
}

function validBody(plateNo: string, assignedClientId: string | null = null): Record<string, unknown> {
  usedPlateNos.push(plateNo);
  return {
    plateNo,
    make: null,
    model: null,
    year: null,
    vehicleType: VEHICLE_TYPE,
    capacityKg: null,
    capacityCbm: null,
    isRefrigerated: false,
    ownership: OWNERSHIP,
    assignedClientId,
    documents: [],
    correlationId: randomUUID(),
  };
}

// 01-Data-Model.sql:861 comment: registration · insurance · permit · inspection.
const DOC_TYPE_REGISTRATION = 'registration';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FAR_FUTURE_DAYS = 365;
// 01-Data-Model.sql:865 tms.vehicle_documents.alert_days_before int not null default 30 — reused as
// the fixture literal (Finding 10, round 2), same constant name as ./register-vehicle.test.ts.
const ALERT_DAYS_BEFORE_DEFAULT = 30;

/** pg-reviewer round 1, Finding 3: a body carrying at least one document — required for the RLS
 *  denial scenario (tms.vehicle_documents' own internal_only policy only fires on a document
 *  insert). */
function validBodyWithDocument(plateNo: string): Record<string, unknown> {
  const body = validBody(plateNo);
  return {
    ...body,
    documents: [
      {
        docType: DOC_TYPE_REGISTRATION,
        docNo: null,
        issueDate: null,
        expiryDate: new Date(clock.now().getTime() + FAR_FUTURE_DAYS * ONE_DAY_MS).toISOString().slice(0, 10),
        fileUrl: null,
        alertDaysBefore: ALERT_DAYS_BEFORE_DEFAULT,
      },
    ],
  };
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

async function countVehiclesByPlate(plateNo: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from tms.vehicles where plate_no = $1`,
    [plateNo],
  );
  return Number(result.rows[0]?.n ?? '0');
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
  for (const userId of [FIXTURE_ACTOR_UUID, NON_INTERNAL_ACTOR_UUID]) {
    await pool.query(
      `insert into identity.users (id, email, full_name_ar, user_type)
       values ($1, $2, $3, 'internal')
       on conflict (id) do update set email = excluded.email`,
      [userId, `_fleet_regveh_handlers_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار معالجات تسجيل مركبة'],
    );
    await pool.query(
      `insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict (user_id, entity_id) do nothing`,
      [userId, entityId],
    );
  }
});

afterAll(async () => {
  if (usedPlateNos.length > 0) {
    await pool.query(
      `delete from tms.vehicle_documents where vehicle_id in (select id from tms.vehicles where plate_no = any($1::text[]))`,
      [usedPlateNos],
    );
    await pool.query(`delete from tms.vehicles where plate_no = any($1::text[])`, [usedPlateNos]);
  }
  for (const userId of [FIXTURE_ACTOR_UUID, NON_INTERNAL_ACTOR_UUID]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
});

describe('a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('handleRegisterVehicle: no Idempotency-Key header -> 400, title reflects the rejection', async () => {
    const deps = createRegisterVehicleDeps({ clock, ids });
    const result = await handleRegisterVehicle(requestWithoutKey(validBody(`KWT-H-NOKEY-${randomUUID()}`)), deps);
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });
});

describe('a body that fails the Zod contract is rejected with a 400 Problem', () => {
  it('handleRegisterVehicle: a body with an empty plateNo -> 400', async () => {
    const deps = createRegisterVehicleDeps({ clock, ids });
    const badBody = { ...validBody(''), plateNo: '' };
    const result = await handleRegisterVehicle(requestWithKey(badBody), deps);
    expect(result.status).toBe(400);
  });

  it('handleRegisterVehicle: a body missing correlationId -> 400', async () => {
    const deps = createRegisterVehicleDeps({ clock, ids });
    const withoutCorrelationId = validBody(`KWT-H-NOCORR-${randomUUID()}`);
    delete withoutCorrelationId['correlationId'];
    const result = await handleRegisterVehicle(requestWithKey(withoutCorrelationId), deps);
    expect(result.status).toBe(400);
  });
});

describe('a replayed call with the same Idempotency-Key but a DIFFERENT body -> 409 IdempotencyConflictError', () => {
  it('handleRegisterVehicle: same key, different body on the second call -> 409, title "IdempotencyConflictError"', async () => {
    const deps = createRegisterVehicleDeps({ clock, ids });
    const idempotencyKey = randomUUID();
    const firstBody = validBody(`KWT-H-CONFLICT-A-${randomUUID()}`);

    const first = await handleRegisterVehicle(requestWithKey(firstBody, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const differentBody = validBody(`KWT-H-CONFLICT-B-${randomUUID()}`); // different plateNo -> different hash.
    const result = await handleRegisterVehicle(requestWithKey(differentBody, idempotencyKey), deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'IdempotencyConflictError' });
  });

  it('handleRegisterVehicle: same key, same body on the second call -> 200, byte-identical response, exactly one tms.vehicles row written (no second insert)', async () => {
    const plateNo = `KWT-H-REPLAY-${randomUUID()}`;
    const deps = createRegisterVehicleDeps({ clock, ids });
    const idempotencyKey = randomUUID();
    const body = validBody(plateNo);

    const first = await handleRegisterVehicle(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const second = await handleRegisterVehicle(requestWithKey(body, idempotencyKey), deps);
    expect(second.status).toBe(200);
    expect(second).toEqual(first);

    expect(await countVehiclesByPlate(plateNo)).toBe(1);
  });
});

describe('a non-internal actor with at least one document is rejected with a 422 Problem (pg-reviewer round 1, Finding 3)', () => {
  it('handleRegisterVehicle: tms.vehicle_documents\' internal_only RLS rejection maps to 422, title "VehicleDocumentAccessDeniedError", detail states what is allowed', async () => {
    const deps = createRegisterVehicleDeps({ clock, ids });
    const plateNo = `KWT-H-RLS422-${randomUUID()}`;
    const body = validBodyWithDocument(plateNo);

    const result = await handleRegisterVehicle(requestWithKey(body, undefined, nonInternalCtx), deps);

    expect(result.status).toBe(422);
    const problem = asProblemBody(result.body);
    expect(problem.title).toBe('VehicleDocumentAccessDeniedError');
    // pg-backend's own message text (domain/register-vehicle/errors.ts /
    // infrastructure/register-vehicle/repository.ts): states what IS allowed, not just what failed.
    expect(problem.detail).toMatch(/internal_only RLS policy rejected this insert/);
    expect(problem.detail).toMatch(/Allowed: an internal actor/);

    expect(await countVehiclesByPlate(plateNo)).toBe(0);
  });
});

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleRegisterVehicle: a foreign-key violation on assignedClientId (an untyped error, not a typed domain error) -> 500, generic detail, logger.error receives { correlationId, err: <the Error object> }', async () => {
    const logger = spyLogger();
    const deps = createRegisterVehicleDeps({ clock, ids, logger });
    const correlationId = randomUUID();
    const body = { ...validBody(`KWT-H-500-${randomUUID()}`), assignedClientId: randomUUID(), correlationId };

    const result = await handleRegisterVehicle(requestWithKey(body), deps);

    expect(result.status).toBe(500);
    expect('body' in result ? JSON.stringify(result.body) : '').not.toMatch(/violates foreign key/);

    expect(logger.errorCalls).toHaveLength(1);
    const [loggedObj] = logger.errorCalls[0] as [Record<string, unknown>, string];
    expect(loggedObj['correlationId']).toBe(correlationId);
    expect(loggedObj['err']).toBeInstanceOf(Error);
  });
});

describe('createRegisterVehicleDeps accepts an injected logger', () => {
  it('deps.logger is the exact injected spy, not a default pino instance', () => {
    const logger = spyLogger();
    const injectedDeps = createRegisterVehicleDeps({ clock, ids, logger });
    expect(injectedDeps.logger).toBe(logger);
  });
});
