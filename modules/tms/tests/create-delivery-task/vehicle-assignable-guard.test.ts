// modules/tms/tests/create-delivery-task/vehicle-assignable-guard.test.ts — WBS 3.4 part 1,
// migration 0046 (tasks/backlog/MIGRATION-REQUEST-B.md).
//
// INV-C4-1, vehicle half (doc 40 line 273: "driver with expired residency/licence, or vehicle with
// expired document, cannot be assigned"), as a DB-level guard: trigger `trg_guard_vehicle_assignable`
// (function tms.guard_vehicle_assignable(), BEFORE INSERT OR UPDATE OF vehicle_id) on BOTH
// tms.delivery_tasks and tms.routes. Rule (brief Decision 1, fleet's own): a document is expired iff
// expiry_date < the Asia/Kuwait calendar date; ANY doc_type; refusal = SQLSTATE 23514 (check_violation)
// with constraint name `inv_c4_1_vehicle_assignable`. Fires only when NEW.vehicle_id is not null and
// (INSERT, or vehicle_id changes). This is the ONLY place the guard behaviour is asserted (D-208).
//
// Raw SQL on the admin pool, except the app-role case, which runs through withContext as pgeos_app (the guard is `security definer`, so RLS on tms.vehicle_documents cannot
// hide an expired row). "Today" and "yesterday" are read from the database in Asia/Kuwait, never from
// the JS clock. D-183: DELETE only in afterAll, only ids this file created.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withContext } from '@pg-eos/db';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

const CHECK_VIOLATION_SQLSTATE = '23514';
const GUARD_CONSTRAINT = 'inv_c4_1_vehicle_assignable';
const FIXTURE_AREA = 'Salmiya';
const FIXTURE_BLOCK = '5';
const FIXTURE_STREET = 'Salem Al-Mubarak';
const FIXTURE_PHONE = '+96550000000';
const BUSINESS_TIME_ZONE = 'Asia/Kuwait'; // brief Decision 1; modules/fleet BUSINESS_TIME_ZONE.
const VEHICLE_TYPE = 'van'; // 01-Data-Model.sql:848 comment.
const DOC_TYPE_REGISTRATION = 'registration'; // 01-Data-Model.sql:861 comment.
const DOC_TYPE_INSURANCE = 'insurance';
const PLANNED_STOPS_AFTER = 3;

let entityId: string;
let clientId: string;
let kuwaitToday: string;
let kuwaitYesterday: string;
let kuwaitTomorrow: string;
const actorId = randomUUID(); // internal user, member of PDL only; the app-role case runs as this user.
const vehicleIds: string[] = [];
const taskIds: string[] = [];
const routeIds: string[] = [];

interface TargetTable {
  readonly label: string;
  readonly table: 'tms.delivery_tasks' | 'tms.routes';
  readonly ids: string[];
  readonly insert: (vehicleId: string | null) => Promise<string>;
  /** A SET clause touching a column other than vehicle_id. */
  readonly otherColumnSet: string;
}

async function insertVehicle(documents: ReadonlyArray<{ readonly docType: string; readonly expiry: string }>): Promise<string> {
  const vehicle: QueryResult<{ id: string }> = await pool.query(
    `insert into tms.vehicles (entity_id, plate_no, vehicle_type) values ($1, $2, $3) returning id`,
    [entityId, `_guard-${randomUUID()}`, VEHICLE_TYPE],
  );
  const id = (vehicle.rows[0] as { id: string }).id;
  vehicleIds.push(id);
  for (const doc of documents) {
    await pool.query(`insert into tms.vehicle_documents (vehicle_id, doc_type, expiry_date) values ($1, $2, $3::date)`, [
      id,
      doc.docType,
      doc.expiry,
    ]);
  }
  return id;
}

const TARGETS: readonly TargetTable[] = [
  {
    label: 'tms.delivery_tasks',
    table: 'tms.delivery_tasks',
    ids: taskIds,
    insert: async (vehicleId) => {
      const result: QueryResult<{ id: string }> = await pool.query(
        `insert into tms.delivery_tasks (entity_id, doc_no, client_id, vehicle_id, area, block, street, recipient_phone)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [entityId, `_GUARD-${randomUUID()}`, clientId, vehicleId, FIXTURE_AREA, FIXTURE_BLOCK, FIXTURE_STREET, FIXTURE_PHONE],
      );
      const id = (result.rows[0] as { id: string }).id;
      taskIds.push(id);
      return id;
    },
    otherColumnSet: `recipient_name = 'guard-other-column'`,
  },
  {
    label: 'tms.routes',
    table: 'tms.routes',
    ids: routeIds,
    insert: async (vehicleId) => {
      const result: QueryResult<{ id: string }> = await pool.query(
        `insert into tms.routes (entity_id, doc_no, route_date, vehicle_id) values ($1, $2, $3::date, $4) returning id`,
        [entityId, `_GUARD-${randomUUID()}`, kuwaitToday, vehicleId],
      );
      const id = (result.rows[0] as { id: string }).id;
      routeIds.push(id);
      return id;
    },
    otherColumnSet: `planned_stops = ${PLANNED_STOPS_AFTER}`,
  },
];

async function sqlFailure(run: () => Promise<unknown>): Promise<{ code?: string; constraint?: string } | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const failure = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
    return failure.code === undefined && failure.cause ? failure.cause : failure; // drizzle wraps the pg error in `cause`.
  }
}

async function kuwaitDate(offsetDays: number): Promise<string> {
  const result: QueryResult<{ d: string }> = await pool.query(
    `select ((now() at time zone $1)::date + $2::int)::text as d`,
    [BUSINESS_TIME_ZONE, offsetDays],
  );
  return (result.rows[0] as { d: string }).d;
}

beforeAll(async () => {
  const entity: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = 'PDL'`);
  entityId = (entity.rows[0] as { id: string }).id;
  const client: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type, status) values ($1, $2, 'client', 'active') returning id`,
    [`_vguard_${randomUUID()}`, 'عميل اختبار حارس المركبة'],
  );
  clientId = (client.rows[0] as { id: string }).id;
  await pool.query(`insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`, [
    actorId,
    `_vguard_${randomUUID()}@test.invalid`,
    'ممثل اختبار حارس المركبة',
  ]);
  await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [actorId, entityId]);
  kuwaitToday = await kuwaitDate(0);
  kuwaitYesterday = await kuwaitDate(-1);
  kuwaitTomorrow = await kuwaitDate(1);
});

afterAll(async () => {
  await pool.query(`delete from tms.delivery_tasks where id = any($1::uuid[])`, [taskIds]);
  await pool.query(`delete from tms.routes where id = any($1::uuid[])`, [routeIds]);
  await pool.query(`delete from tms.vehicles where id = any($1::uuid[])`, [vehicleIds]); // documents cascade.
  if (clientId) await pool.query(`delete from sales.accounts where id = $1`, [clientId]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [actorId]);
  await pool.query(`delete from identity.users where id = $1`, [actorId]);
  await pool.end();
});

describe.each(TARGETS)('INV-C4-1 vehicle guard on $label', (target) => {
  it('INSERT with a vehicle that has a document expired yesterday (Asia/Kuwait) -> 23514, constraint inv_c4_1_vehicle_assignable', async () => {
    const vehicleId = await insertVehicle([{ docType: DOC_TYPE_REGISTRATION, expiry: kuwaitYesterday }]);
    const failure = await sqlFailure(() => target.insert(vehicleId));
    expect(failure?.code).toBe(CHECK_VIOLATION_SQLSTATE);
    expect(failure?.constraint).toBe(GUARD_CONSTRAINT);
  });

  it('as pgeos_app under RLS (withContext, internal, entity PDL): UPDATE vehicle_id to an expired vehicle -> 23514, constraint inv_c4_1_vehicle_assignable (security definer reads the documents RLS-blind)', async () => {
    const rowId = await target.insert(null);
    const vehicleId = await insertVehicle([{ docType: DOC_TYPE_REGISTRATION, expiry: kuwaitYesterday }]);
    const failure = await sqlFailure(() =>
      withContext({ userId: actorId, clientId: null, isInternal: true, entityId }, (tx) =>
        tx.execute(sql`update ${sql.raw(target.table)} set vehicle_id = ${vehicleId} where id = ${rowId}`),
      ),
    );
    expect(failure?.code).toBe(CHECK_VIOLATION_SQLSTATE);
    expect(failure?.constraint).toBe(GUARD_CONSTRAINT);
  });

  it('INSERT with one expired document among otherwise valid ones (any doc_type) -> 23514', async () => {
    const vehicleId = await insertVehicle([
      { docType: DOC_TYPE_REGISTRATION, expiry: kuwaitTomorrow },
      { docType: DOC_TYPE_INSURANCE, expiry: kuwaitYesterday },
    ]);
    const failure = await sqlFailure(() => target.insert(vehicleId));
    expect(failure?.code).toBe(CHECK_VIOLATION_SQLSTATE);
    expect(failure?.constraint).toBe(GUARD_CONSTRAINT);
  });

  it('UPDATE of vehicle_id (null -> expired vehicle) -> 23514, and the row keeps its null vehicle_id', async () => {
    const rowId = await target.insert(null);
    const vehicleId = await insertVehicle([{ docType: DOC_TYPE_REGISTRATION, expiry: kuwaitYesterday }]);
    const failure = await sqlFailure(() => pool.query(`update ${target.table} set vehicle_id = $1 where id = $2`, [vehicleId, rowId]));
    expect(failure?.code).toBe(CHECK_VIOLATION_SQLSTATE);
    expect(failure?.constraint).toBe(GUARD_CONSTRAINT);
    const after: QueryResult<{ vehicle_id: string | null }> = await pool.query(
      `select vehicle_id from ${target.table} where id = $1`,
      [rowId],
    );
    expect(after.rows[0]?.vehicle_id).toBeNull();
  });

  it('UPDATE of vehicle_id from a valid vehicle to an expired one -> 23514', async () => {
    const validVehicleId = await insertVehicle([{ docType: DOC_TYPE_REGISTRATION, expiry: kuwaitTomorrow }]);
    const rowId = await target.insert(validVehicleId);
    const expiredVehicleId = await insertVehicle([{ docType: DOC_TYPE_INSURANCE, expiry: kuwaitYesterday }]);
    const failure = await sqlFailure(() =>
      pool.query(`update ${target.table} set vehicle_id = $1 where id = $2`, [expiredVehicleId, rowId]),
    );
    expect(failure?.code).toBe(CHECK_VIOLATION_SQLSTATE);
    expect(failure?.constraint).toBe(GUARD_CONSTRAINT);
  });

  it('a vehicle whose documents all expire today (Asia/Kuwait) or later is accepted on INSERT and on UPDATE', async () => {
    const vehicleId = await insertVehicle([
      { docType: DOC_TYPE_REGISTRATION, expiry: kuwaitToday },
      { docType: DOC_TYPE_INSURANCE, expiry: kuwaitTomorrow },
    ]);
    const insertedId = await target.insert(vehicleId);
    const rowIdToUpdate = await target.insert(null);
    await pool.query(`update ${target.table} set vehicle_id = $1 where id = $2`, [vehicleId, rowIdToUpdate]);
    const after: QueryResult<{ id: string; vehicle_id: string }> = await pool.query(
      `select id, vehicle_id from ${target.table} where id = any($1::uuid[]) order by id`,
      [[insertedId, rowIdToUpdate]],
    );
    expect(after.rows.map((row) => row.vehicle_id)).toEqual([vehicleId, vehicleId]);
  });

  it('a vehicle with no documents at all is accepted (nothing is expired)', async () => {
    const vehicleId = await insertVehicle([]);
    const rowId = await target.insert(vehicleId);
    expect(rowId).toBeTruthy();
  });

  it('a null vehicle_id is never checked: INSERT null and UPDATE to null both succeed', async () => {
    const insertedId = await target.insert(null);
    const validVehicleId = await insertVehicle([{ docType: DOC_TYPE_REGISTRATION, expiry: kuwaitTomorrow }]);
    const rowId = await target.insert(validVehicleId);
    await pool.query(`update ${target.table} set vehicle_id = null where id = $1`, [rowId]);
    const after: QueryResult<{ vehicle_id: string | null }> = await pool.query(
      `select vehicle_id from ${target.table} where id = any($1::uuid[])`,
      [[insertedId, rowId]],
    );
    expect(after.rows.every((row) => row.vehicle_id === null)).toBe(true);
  });

  it('UPDATE OF another column on a row whose vehicle document expired AFTER assignment does not fire the guard', async () => {
    const vehicleId = await insertVehicle([{ docType: DOC_TYPE_REGISTRATION, expiry: kuwaitTomorrow }]);
    const rowId = await target.insert(vehicleId);
    await pool.query(`update tms.vehicle_documents set expiry_date = $1::date where vehicle_id = $2`, [kuwaitYesterday, vehicleId]);
    const failure = await sqlFailure(() => pool.query(`update ${target.table} set ${target.otherColumnSet} where id = $1`, [rowId]));
    expect(failure).toBeNull();
  });

  it('UPDATE that sets vehicle_id to its own current value is not re-checked (vehicle_id is not distinct from old)', async () => {
    const vehicleId = await insertVehicle([{ docType: DOC_TYPE_REGISTRATION, expiry: kuwaitTomorrow }]);
    const rowId = await target.insert(vehicleId);
    await pool.query(`update tms.vehicle_documents set expiry_date = $1::date where vehicle_id = $2`, [kuwaitYesterday, vehicleId]);
    const failure = await sqlFailure(() => pool.query(`update ${target.table} set vehicle_id = $1 where id = $2`, [vehicleId, rowId]));
    expect(failure).toBeNull();
  });
});
