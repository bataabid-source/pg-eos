// modules/fleet/tests/register-vehicle/register-vehicle.test.ts — WBS 3.1.
//
// Integration tests, one per scenario in ./register-vehicle.feature, against the real database as
// pgeos_app (RLS genuinely enforced — every command call goes through withContext/
// withIdempotentContext). `fleet` has no earlier slice of its own; this fixture/RLS discipline
// replicates the cross-module pattern every prior module's own precedent already established
// (brief Read ONLY: modules/hr/domain/register-employee, .../infrastructure/register-employee). Sources:
// docs/notes/slice-briefs/_slice-3.1.brief.md "Scenario"/"Contract" blocks (verbatim);
// database/schema/01-Data-Model.sql:843-866 (tms.vehicles, tms.vehicle_documents);
// database/schema/13B-Schema-Reference-Consolidation.sql:2340-2344 (chk_vehicles_status),
// 1646-1656 (platform.outbox.entity_id + outbox_business_needs_entity CHECK).
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only) plus real
// identity.users/user_entities rows — a cross-module discipline (fleet has no earlier slice of its
// own; this replicates the same fixture/RLS pattern modules/hr/register-employee's own precedent
// already established, per the brief's now-updated Read ONLY list). D-183:
// DELETE only in afterAll; beforeAll fixture upserts use INSERT ... ON CONFLICT DO UPDATE/NOTHING.
// `entityId` is resolved from ctx by the command itself (the caller's own single entity via
// platform.allowed_entities()) — never supplied by the test input, same discipline as every
// prior slice's own entity-scoped insert command.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { RegisterVehicleInputSchema } from '@pg-eos/contracts/fleet/register-vehicle';

// The modules under test — do not yet exist with this behaviour (RED).
import { registerVehicle } from '../../application/register-vehicle/index.js';
import { createRegisterVehicleDeps } from '../../api/register-vehicle/composition.js';
import { DuplicatePlateNoError, VehicleDocumentAccessDeniedError } from '../../domain/register-vehicle/errors.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

// --- literals, each cited to the schema fact or the brief line they come from -------------------

// 01-Data-Model.sql:865 tms.vehicle_documents.alert_days_before int not null default 30 — reused
// as the fixture literal, not an invented business number.
const ALERT_DAYS_BEFORE_DEFAULT = 30;
// 01-Data-Model.sql:848 comment: van · pickup · truck_3t · truck_7t · refrigerated · motorcycle.
const VEHICLE_TYPE = 'van';
// 01-Data-Model.sql:851 comment: owned · leased · subcontracted.
const OWNERSHIP = 'owned';
// 01-Data-Model.sql:852 tms.vehicles.status not null default 'active'.
const VEHICLE_STATUS_DEFAULT = 'active';
// 01-Data-Model.sql:861 comment: registration · insurance · permit · inspection.
const DOC_TYPE_REGISTRATION = 'registration';
const DOC_TYPE_INSURANCE = 'insurance';
// brief "Event" line.
const VEHICLE_REGISTERED_EVENT_TYPE = 'fleet.vehicle.registered';
const VEHICLES_AGGREGATE_TYPE = 'fleet.vehicles';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FAR_FUTURE_DAYS = 365;
const NEAR_FUTURE_DAYS = 30;
const PAST_DAYS = 5;

const clock = new FixedClock(new Date('2026-09-25T00:00:00.000Z'));
const ids = new SequentialIdGenerator(31);
const deps = createRegisterVehicleDeps({ clock, ids });

const INTERNAL_ACTOR_UUID = '00000000-0000-4000-8000-0000000031a1';
const NON_INTERNAL_ACTOR_UUID = '00000000-0000-4000-8000-0000000031a2';

const internalCtx = { userId: INTERNAL_ACTOR_UUID, clientId: null, isInternal: true };
// RLS scenario: the DB-session-level "not internal" flag, same discipline as every prior slice's
// own `isInternal: false` fixture (the session var withContext sets from this field is what
// tms.vehicle_documents' `internal_only` policy actually reads via platform.is_internal()).
const nonInternalCtx = { userId: NON_INTERNAL_ACTOR_UUID, clientId: null, isInternal: false };

let entityId: string;
const fixtureVehicleIds: string[] = [];
const usedCorrelationIds = new Set<string>();

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

function futureExpiry(daysFromClock: number): string {
  return new Date(clock.now().getTime() + daysFromClock * ONE_DAY_MS).toISOString().slice(0, 10);
}

function pastExpiry(daysBeforeClock: number): string {
  return new Date(clock.now().getTime() - daysBeforeClock * ONE_DAY_MS).toISOString().slice(0, 10);
}

// Same technique as modules/fleet/domain/register-vehicle/invariants.ts's own `businessDateOf`
// (pg-reviewer round 1, Finding 1) — the Kuwait-local calendar date of the clock's own instant, as
// a plain `YYYY-MM-DD` string, so a fixture "today" expiry matches what the gate itself computes.
const BUSINESS_TIME_ZONE = 'Asia/Kuwait';
function kuwaitTodayExpiry(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(clock.now());
}

interface DocumentInput {
  readonly docType: string;
  readonly docNo: string | null;
  readonly issueDate: string | null;
  readonly expiryDate: string;
  readonly fileUrl: string | null;
  readonly alertDaysBefore: number;
}

interface RegisterVehicleTestInput {
  readonly plateNo: string;
  readonly make: string | null;
  readonly model: string | null;
  readonly year: number | null;
  readonly vehicleType: string;
  readonly capacityKg: number | null;
  readonly capacityCbm: number | null;
  readonly isRefrigerated: boolean;
  readonly ownership: string;
  readonly assignedClientId: string | null;
  readonly documents: readonly DocumentInput[];
  readonly correlationId: string;
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

function baseInput(plateNo: string, documents: readonly DocumentInput[]): RegisterVehicleTestInput {
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
    assignedClientId: null,
    documents,
    correlationId: nextCorrelationId(),
  };
}

async function getVehicle(id: string): Promise<{ status: string; plate_no: string; entity_id: string } | null> {
  const result: QueryResult<{ status: string; plate_no: string; entity_id: string }> = await pool.query(
    `select status, plate_no, entity_id::text as entity_id from tms.vehicles where id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function countVehiclesByPlate(plateNo: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from tms.vehicles where plate_no = $1`,
    [plateNo],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function documentsForVehicle(
  vehicleId: string,
): Promise<Array<{ id: string; doc_type: string; expiry_date: string }>> {
  const result: QueryResult<{ id: string; doc_type: string; expiry_date: string }> = await pool.query(
    `select id::text as id, doc_type, expiry_date::text as expiry_date
       from tms.vehicle_documents where vehicle_id = $1 order by doc_type`,
    [vehicleId],
  );
  return result.rows;
}

async function outboxRowsFor(
  correlationId: string,
  eventType: string,
): Promise<Array<{ id: string; aggregate_id: string; entity_id: string; aggregate_type: string }>> {
  const result: QueryResult<{ id: string; aggregate_id: string; entity_id: string; aggregate_type: string }> =
    await pool.query(
      `select id::text as id, aggregate_id::text as aggregate_id, entity_id::text as entity_id, aggregate_type
         from platform.outbox where correlation_id = $1 and event_type = $2`,
      [correlationId, eventType],
    );
  return result.rows;
}

async function auditRowsFor(correlationId: string): Promise<Array<{ new_value: unknown; record_id: string }>> {
  const result: QueryResult<{ new_value: unknown; record_id: string }> = await pool.query(
    `select new_value, record_id::text as record_id
       from platform.audit_log
      where correlation_id = $1 and schema_name = 'tms' and table_name = 'vehicles'`,
    [correlationId],
  );
  return result.rows;
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow) throw new Error(`fixture platform.entities row not found for code 'PST'`);
  entityId = entityRow.id;

  for (const userId of [INTERNAL_ACTOR_UUID, NON_INTERNAL_ACTOR_UUID]) {
    // D-183: no DELETE here — beforeAll only upserts (ON CONFLICT DO UPDATE/NOTHING below); the
    // afterAll block below is the only place this file deletes rows.
    await pool.query(
      `insert into identity.users (id, email, full_name_ar, user_type)
       values ($1, $2, $3, 'internal')
       on conflict (id) do update set email = excluded.email`,
      [userId, `_fleet_regveh_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار تسجيل مركبة — WBS 3.1'],
    );
    await pool.query(
      `insert into identity.user_entities (user_id, entity_id) values ($1, $2)
       on conflict (user_id, entity_id) do nothing`,
      [userId, entityId],
    );
  }
});

afterAll(async () => {
  if (usedCorrelationIds.size > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [[...usedCorrelationIds]]);
  }
  if (fixtureVehicleIds.length > 0) {
    await pool.query(`delete from tms.vehicle_documents where vehicle_id = any($1::uuid[])`, [fixtureVehicleIds]);
    await pool.query(`delete from tms.vehicles where id = any($1::uuid[])`, [fixtureVehicleIds]);
  }
  for (const userId of [INTERNAL_ACTOR_UUID, NON_INTERNAL_ACTOR_UUID]) {
    // platform.audit_log is NEVER deleted (CLAUDE.md-wide discipline, every prior slice).
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
});

// --- contract shape (pins the CORRECT contract, brief "Contract" line) --------------------------

describe('@pg-eos/contracts/fleet/register-vehicle — RegisterVehicleInputSchema (brief Contract line)', () => {
  it('accepts the full input shape and carries no caller-supplied entityId/actorId field', () => {
    const parsed = RegisterVehicleInputSchema.parse(baseInput(`KWT-CONTRACT-${randomUUID()}`, []));
    expect('entityId' in parsed).toBe(false);
    expect('actorId' in parsed).toBe(false);
  });

  it('rejects an empty plateNo', () => {
    expect(() => RegisterVehicleInputSchema.parse(baseInput('', []))).toThrow();
  });

  it('rejects a document with no expiryDate', () => {
    const input = {
      ...baseInput(`KWT-CONTRACT2-${randomUUID()}`, []),
      documents: [
        {
          docType: DOC_TYPE_REGISTRATION,
          docNo: null,
          issueDate: null,
          fileUrl: null,
          alertDaysBefore: ALERT_DAYS_BEFORE_DEFAULT,
        },
      ],
    };
    expect(() => RegisterVehicleInputSchema.parse(input)).toThrow();
  });
});

// --- Scenario: no expired documents -> canBeAssigned true ---------------------------------------

describe('Scenario: A vehicle registered with no expired documents can be assigned', () => {
  it('inserts tms.vehicles at its own status default, inserts both documents, canBeAssigned is true', async () => {
    const plateNo = `KWT-12345-${randomUUID()}`;
    const input = baseInput(plateNo, [
      document(DOC_TYPE_REGISTRATION, futureExpiry(FAR_FUTURE_DAYS)),
      document(DOC_TYPE_INSURANCE, futureExpiry(NEAR_FUTURE_DAYS)),
    ]);

    const result = await registerVehicle(internalCtx, input, deps);
    fixtureVehicleIds.push(result.id);

    expect(result.canBeAssigned).toBe(true);
    expect(result.documentIds).toHaveLength(2);

    const vehicle = await getVehicle(result.id);
    expect(vehicle?.status).toBe(VEHICLE_STATUS_DEFAULT);
    expect(vehicle?.plate_no).toBe(plateNo);
    expect(vehicle?.entity_id).toBe(entityId);

    const docs = await documentsForVehicle(result.id);
    expect(docs).toHaveLength(2);
  });
});

// --- boundary: a document expiring exactly today (Kuwait-local) is NOT expired ------------------

describe('Boundary: a document expiring on the exact current (Kuwait) date can be assigned', () => {
  it('canBeAssigned is true when a document expiryDate equals today\'s Kuwait-local calendar date', async () => {
    const plateNo = `KWT-TODAY-${randomUUID()}`;
    const input = baseInput(plateNo, [document(DOC_TYPE_REGISTRATION, kuwaitTodayExpiry())]);

    const result = await registerVehicle(internalCtx, input, deps);
    fixtureVehicleIds.push(result.id);

    expect(result.canBeAssigned).toBe(true);
  });
});

// --- Scenario: one expired document -> canBeAssigned false, still inserted ----------------------

describe('Scenario: A vehicle registered with one expired document cannot be assigned', () => {
  it('inserts both documents as given (registration is never blocked) but canBeAssigned is false', async () => {
    const plateNo = `KWT-67890-${randomUUID()}`;
    const pastExpiryDate = pastExpiry(PAST_DAYS);
    const futureExpiryDate = futureExpiry(NEAR_FUTURE_DAYS);
    const input = baseInput(plateNo, [
      document(DOC_TYPE_REGISTRATION, pastExpiryDate),
      document(DOC_TYPE_INSURANCE, futureExpiryDate),
    ]);

    const result = await registerVehicle(internalCtx, input, deps);
    fixtureVehicleIds.push(result.id);

    expect(result.canBeAssigned).toBe(false);
    expect(result.documentIds).toHaveLength(2);

    // scenario wording: "both documents are still inserted as given" — confirm the past
    // expiry_date was actually stored as submitted, not silently clamped or rejected.
    const docs = await documentsForVehicle(result.id);
    expect(docs).toHaveLength(2);
    const insuranceDoc = docs.find((doc) => doc.doc_type === DOC_TYPE_INSURANCE);
    const registrationDoc = docs.find((doc) => doc.doc_type === DOC_TYPE_REGISTRATION);
    expect(insuranceDoc?.expiry_date).toBe(futureExpiryDate);
    expect(registrationDoc?.expiry_date).toBe(pastExpiryDate);
  });
});

// --- Scenario: zero documents -> canBeAssigned true, vacuously -----------------------------------

describe('Scenario: A vehicle registered with zero documents can be assigned', () => {
  it('inserts the vehicle with no tms.vehicle_documents rows, canBeAssigned is true', async () => {
    const plateNo = `KWT-00000-${randomUUID()}`;
    const input = baseInput(plateNo, []);

    const result = await registerVehicle(internalCtx, input, deps);
    fixtureVehicleIds.push(result.id);

    expect(result.canBeAssigned).toBe(true);
    expect(result.documentIds).toHaveLength(0);

    const docs = await documentsForVehicle(result.id);
    expect(docs).toHaveLength(0);
  });
});

// --- Scenario: outbox event + audit row ----------------------------------------------------------

describe("Scenario: Registration publishes one domain event carrying the vehicle's entity", () => {
  it('writes exactly one platform.outbox row (fleet.vehicle.registered) and one platform.audit_log row carrying every field actually written', async () => {
    const plateNo = `KWT-EVENT-${randomUUID()}`;
    const input = baseInput(plateNo, [document(DOC_TYPE_REGISTRATION, futureExpiry(FAR_FUTURE_DAYS))]);
    const correlationId = input.correlationId;

    const result = await registerVehicle(internalCtx, input, deps);
    fixtureVehicleIds.push(result.id);

    const outboxRows = await outboxRowsFor(correlationId, VEHICLE_REGISTERED_EVENT_TYPE);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.aggregate_type).toBe(VEHICLES_AGGREGATE_TYPE);
    expect(outboxRows[0]?.aggregate_id).toBe(result.id);
    expect(outboxRows[0]?.entity_id).toBe(entityId);

    const auditRows = await auditRowsFor(correlationId);
    expect(auditRows).toHaveLength(1);
    const vehicleAuditRow = auditRows[0];
    expect(vehicleAuditRow?.record_id).toBe(result.id);
    const newValue = vehicleAuditRow?.new_value as Record<string, unknown>;
    expect(newValue['entityId']).toBe(entityId);
    expect(newValue['plateNo']).toBe(plateNo);
    expect(newValue['vehicleType']).toBe(VEHICLE_TYPE);
    expect(newValue['ownership']).toBe(OWNERSHIP);
    expect(newValue['isRefrigerated']).toBe(false);
    expect(newValue['make']).toBeNull();
    expect(newValue['model']).toBeNull();
    expect(newValue['year']).toBeNull();
    expect(newValue['capacityKg']).toBeNull();
    expect(newValue['capacityCbm']).toBeNull();
    expect(newValue['assignedClientId']).toBeNull();
  });
});

// --- Scenario: duplicate plate_no rejected --------------------------------------------------------

describe('Scenario: A duplicate plate number is rejected', () => {
  it('the second registration with the same plate_no fails with a mapped DuplicatePlateNoError (not a raw Postgres unique-violation), and writes no row', async () => {
    const plateNo = `KWT-DUP-${randomUUID()}`;
    const first = await registerVehicle(internalCtx, baseInput(plateNo, []), deps);
    fixtureVehicleIds.push(first.id);

    await expect(registerVehicle(internalCtx, baseInput(plateNo, []), deps)).rejects.toBeInstanceOf(
      DuplicatePlateNoError,
    );

    expect(await countVehiclesByPlate(plateNo)).toBe(1);
  });
});

// --- Scenario: non-internal actor cannot write vehicle_documents (RLS) ---------------------------

describe('Scenario: A non-internal actor cannot write vehicle_documents (RLS, not application logic)', () => {
  it('the whole call is rejected and rolled back atomically — NO tms.vehicles row is written either, even though tms.vehicles entity_scope has no is_internal() guard of its own', async () => {
    const plateNo = `KWT-NONINTERNAL-${randomUUID()}`;
    const input = baseInput(plateNo, [document(DOC_TYPE_REGISTRATION, futureExpiry(FAR_FUTURE_DAYS))]);

    await expect(registerVehicle(nonInternalCtx, input, deps)).rejects.toBeInstanceOf(
      VehicleDocumentAccessDeniedError,
    );

    expect(await countVehiclesByPlate(plateNo)).toBe(0);
  });
});
