// tests/scenarios/fixtures/delivery.ts — S3 (slice brief X-S3): the tms.delivery_tasks /
// tms.contact_log / hr.employees fixtures no existing fixture file covers, plus the
// sales.contracts.bills_failed_attempt flag setter (Master directive: never edit an existing,
// green fixture file — seed.ts's insertContract has no such param, so this scenario's Given sets the
// flag on the already-inserted active contract with a direct, targeted UPDATE, same "direct SQL,
// order lines are not part of either use case's own command surface" reasoning seed.ts's own header
// gives for wms.order_lines).
//
// hr.employees.code: never a hand-picked code. insertDriverEmployee takes the highest code of the
// schema's own format (CHECK code ~ '^PG-[0-9]{4}$') that no committed row uses, at insert time, so
// it never collides with a real employee. The row is torn down in the spec's afterAll (D-183
// carve-out, same as every other fixtures/*.ts file here).
//
// Clock: created_at / attempted_at are inserted EXPLICITLY from caller-supplied values — never DB
// now() — so the spec fully controls the created-before-attempt-1-before-attempt-2-before-clock
// ordering from SCENARIO_CLOCK_ISO.

import type { Pool, QueryResult } from 'pg';

const DELIVERY_TASK_DOC_TYPE = 'TSK'; // platform.counters doc_type for tms.delivery_tasks (psql lookup).
const DRIVER_EMPLOYMENT_TYPE = 'full_time';
const DRIVER_STATUS = 'active';
const CONTACT_LOG_DIRECTION = 'outbound';
// same "fixed clock date, never current_date" one-year-back convention as seed.ts's own
// START_DATE_OFFSET_INTERVAL_SQL — hr.employees.hire_date is NOT NULL with no default.
const HIRE_DATE_OFFSET_INTERVAL = '1 year';
// hr.employees.code format, from its CHECK constraint '^PG-[0-9]{4}$'.
const EMPLOYEE_CODE_PREFIX = 'PG-';
const EMPLOYEE_CODE_DIGITS = 4;
const EMPLOYEE_CODE_BASE = 10;
const EMPLOYEE_CODE_MAX = EMPLOYEE_CODE_BASE ** EMPLOYEE_CODE_DIGITS - 1;

export async function setContractBillsFailedAttempt(pool: Pool, contractId: string, value: boolean): Promise<void> {
  await pool.query(`update sales.contracts set bills_failed_attempt = $2 where id = $1`, [contractId, value]);
}

export interface InsertDriverEmployeeParams {
  readonly entityId: string;
  readonly nameAr: string;
  /** the fixed scenario clock date (yyyy-mm-dd) — hire_date is computed one year back from it. */
  readonly hireDateAnchor: string;
}

export async function insertDriverEmployee(pool: Pool, params: InsertDriverEmployeeParams): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `with free_code as (
       select $7::text || lpad(n::text, $8::int, '0') as code
         from generate_series($9::int, 0, -1) as n
        where not exists (select 1 from hr.employees e where e.code = $7::text || lpad(n::text, $8::int, '0'))
        limit 1
     )
     insert into hr.employees (entity_id, code, name_ar, hire_date, employment_type, status)
     select $1, free_code.code, $2, $3::date - $4::interval, $5, $6 from free_code
     returning id`,
    [
      params.entityId,
      params.nameAr,
      params.hireDateAnchor,
      HIRE_DATE_OFFSET_INTERVAL,
      DRIVER_EMPLOYMENT_TYPE,
      DRIVER_STATUS,
      EMPLOYEE_CODE_PREFIX,
      EMPLOYEE_CODE_DIGITS,
      EMPLOYEE_CODE_MAX,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture hr.employees insert returned no row (no free PG-NNNN code left)');
  return row.id;
}

export async function deleteDriverEmployee(pool: Pool, employeeId: string): Promise<void> {
  await pool.query(`delete from hr.employees where id = $1`, [employeeId]);
}

export interface InsertDeliveryTaskParams {
  readonly entityId: string;
  readonly clientId: string;
  readonly contractId: string;
  readonly driverId: string;
  /** ISO instant, inserted explicitly into created_at — never DB now() (caller computes it from
   *  SCENARIO_CLOCK_ISO minus a named offset). */
  readonly createdAt: string;
}

/** Every other tms.delivery_tasks column not listed here has a schema DEFAULT (psql \d
 *  tms.delivery_tasks): source_type 'internal', task_type 'b2c', status 'created' (left at its
 *  DEFAULT — the eventual "record delivery failure" state machine owns that transition, not this
 *  fixture), attempt_no 1, is_same_day/is_cod/entered_offline false, cod_amount/cod_collected 0. */
export async function insertDeliveryTask(pool: Pool, params: InsertDeliveryTaskParams): Promise<string> {
  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(`select platform.next_doc_no($1, $2) as doc_no`, [
    params.entityId,
    DELIVERY_TASK_DOC_TYPE,
  ]);
  const docNo = docNoResult.rows[0]?.doc_no;
  if (!docNo) throw new Error(`platform.next_doc_no returned no row for ${DELIVERY_TASK_DOC_TYPE}`);

  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into tms.delivery_tasks (entity_id, doc_no, client_id, contract_id, driver_id, created_at)
     values ($1, $2, $3, $4, $5, $6::timestamptz) returning id`,
    [params.entityId, docNo, params.clientId, params.contractId, params.driverId, params.createdAt],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture tms.delivery_tasks insert returned no row');
  return row.id;
}

export async function deleteDeliveryTask(pool: Pool, taskId: string): Promise<void> {
  await pool.query(`delete from tms.delivery_tasks where id = $1`, [taskId]);
}

export interface InsertContactAttemptParams {
  readonly taskId: string;
  readonly driverEmployeeId: string;
  readonly channel: string;
  readonly answered: boolean;
  /** ISO instant, inserted explicitly into attempted_at — never DB now() (caller computes it from
   *  SCENARIO_CLOCK_ISO minus a named offset). */
  readonly attemptedAt: string;
}

export async function insertContactAttempt(pool: Pool, params: InsertContactAttemptParams): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into tms.contact_log (task_id, driver_employee_id, channel, direction, answered, attempted_at)
     values ($1, $2, $3, $4, $5, $6::timestamptz) returning id`,
    [params.taskId, params.driverEmployeeId, params.channel, CONTACT_LOG_DIRECTION, params.answered, params.attemptedAt],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture tms.contact_log insert returned no row');
  return row.id;
}

export async function deleteContactAttemptsForTask(pool: Pool, taskId: string): Promise<void> {
  await pool.query(`delete from tms.contact_log where task_id = $1`, [taskId]);
}
