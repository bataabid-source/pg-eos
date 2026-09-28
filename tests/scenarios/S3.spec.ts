// tests/scenarios/S3.spec.ts — doc 40 Part E, Feature S3 (lines 455-466), integration lane 3.
//
// Every Gherkin line is its own `test.step`, verbatim. BACKED Givens are asserted hard: the SHOP
// contract's `sales.contracts.bills_failed_attempt = true` and a `tms.delivery_tasks` row with two
// `tms.contact_log` attempts (fixtures/delivery.ts).
//
// NOT BUILT, each a named `expect.soft` failure:
//   - When the driver records failure "no_answer.no_response" — rows 3.4 + 3.5 (doc 40 line 459)
//   - Then a billable event DL-11 is created — row 4.3 (line 460)
//   - And failure counts_against_driver = false — row 3.5 (line 461)
//   - When a task is created with area "Salmiya" and no block or street — row 3.4 (line 464)
//   - Then the API returns 422 listing the missing fields — row 3.4 (line 465)
// The Thens already query the real columns (`billing.billable_events` by source_table/source_id/
// DL-11; `tms.delivery_tasks.failure_reason` joined to `tms.failure_reasons`). The When stubs and
// Scenario 2's Then are placeholders: each is replaced by the real handler/HTTP call and its
// assertion when its row lands.

import { expect, test } from '@playwright/test';
import type { Pool, QueryResult } from 'pg';

import { SCENARIO_CLOCK_DATE, SCENARIO_CLOCK_ISO } from './fixtures/clock.js';
import { runCleanupSteps } from './fixtures/cleanup.js';
import {
  deleteContactAttemptsForTask,
  deleteDeliveryTask,
  deleteDriverEmployee,
  insertContactAttempt,
  insertDeliveryTask,
  insertDriverEmployee,
  setContractBillsFailedAttempt,
} from './fixtures/delivery.js';
import { SCENARIO_ENTITY_CODE, getEntityIdByCode } from './fixtures/lookups.js';
import { createPool } from './fixtures/pool.js';
import { deleteClient, deleteContract, insertClient, insertContract } from './fixtures/seed.js';

// --- named constants (CLAUDE.md — no magic numbers) -----------------------------------------------

const FAILURE_REASON_CODE = 'no_answer.no_response'; // doc 40 line 459, verbatim.
const DL_11_SERVICE_CODE = 'DL-11'; // doc 40 line 460, verbatim ("billable event DL-11").
const DELIVERY_TASK_SOURCE_TABLE = 'tms.delivery_tasks'; // schema-qualified, same convention as
// billing.billable_events.source_table 'wms.outbound_orders' / 'wms.occupancy_snapshots' elsewhere.
const CONTACT_ATTEMPT_COUNT = 2; // "two logged contact attempts" (doc 40 line 458).
const CONTACT_LOG_CHANNEL_CALL = 'call'; // 13B:1247 vocabulary (call · whatsapp · sms).
const CLIENT_CODE_PREFIX = '_s3_';
// '_s3_' prefix: the per-run test naming of the other scenario fixtures (seed.ts insertClient),
// so a run never collides with a real client called SHOP.
const CLIENT_NAME_EN = '_s3_SHOP';
const CLIENT_NAME_AR = 'عميل اختبار شوب';
const CONTRACT_TITLE_AR = 'عقد اختبار شوب توصيل';
const DRIVER_NAME_AR = 'سائق اختبار سيناريو التوصيل';
const TASK_AREA_SALMIYA = 'Salmiya'; // doc 40 line 464, verbatim.
// Clock ordering (never DB now()): task created before attempt 1, attempt 1 before attempt 2,
// attempt 2 before the fixed clock instant — each an interval subtracted from SCENARIO_CLOCK_ISO.
const TASK_CREATED_OFFSET_INTERVAL = '3 hours';
const CONTACT_ATTEMPT_1_OFFSET_INTERVAL = '2 hours';
const CONTACT_ATTEMPT_2_OFFSET_INTERVAL = '1 hour';

/** SCENARIO_CLOCK_ISO minus an interval, computed in Postgres with both values bound as
 *  parameters (never `new Date()` / DB `now()`). */
async function clockOffset(pool: Pool, interval: string): Promise<string> {
  const result: QueryResult<{ ts: string }> = await pool.query(
    `select ($1::timestamptz - $2::interval)::text as ts`,
    [SCENARIO_CLOCK_ISO, interval],
  );
  const ts = result.rows[0]?.ts;
  if (!ts) throw new Error(`failed to compute clock offset for ${interval}`);
  return ts;
}

test.describe('S3 B2C delivery with SLA', () => {
  const pool: Pool = createPool();

  let entityId: string;
  let clientId: string;
  let contractId: string;
  let driverEmployeeId: string;
  let taskId: string;

  test.beforeAll(async () => {
    entityId = await getEntityIdByCode(pool, SCENARIO_ENTITY_CODE);

    clientId = await insertClient(pool, { codePrefix: CLIENT_CODE_PREFIX, nameEn: CLIENT_NAME_EN, nameAr: CLIENT_NAME_AR });
    contractId = await insertContract(pool, { entityId, accountId: clientId, titleAr: CONTRACT_TITLE_AR });
    await setContractBillsFailedAttempt(pool, contractId, true);

    driverEmployeeId = await insertDriverEmployee(pool, {
      entityId,
      nameAr: DRIVER_NAME_AR,
      hireDateAnchor: SCENARIO_CLOCK_DATE,
    });

    const taskCreatedAt = await clockOffset(pool, TASK_CREATED_OFFSET_INTERVAL);
    const contactAttempt1At = await clockOffset(pool, CONTACT_ATTEMPT_1_OFFSET_INTERVAL);
    const contactAttempt2At = await clockOffset(pool, CONTACT_ATTEMPT_2_OFFSET_INTERVAL);

    taskId = await insertDeliveryTask(pool, {
      entityId,
      clientId,
      contractId,
      driverId: driverEmployeeId,
      createdAt: taskCreatedAt,
    });
    await insertContactAttempt(pool, {
      taskId,
      driverEmployeeId,
      channel: CONTACT_LOG_CHANNEL_CALL,
      answered: false,
      attemptedAt: contactAttempt1At,
    });
    await insertContactAttempt(pool, {
      taskId,
      driverEmployeeId,
      channel: CONTACT_LOG_CHANNEL_CALL,
      answered: false,
      attemptedAt: contactAttempt2At,
    });
  });

  test.afterAll(async () => {
    // fix round precedent (S1/S2/S18): every cleanup step runs even if an earlier one throws, and
    // the pool always closes — FK order: contact_log before delivery_tasks/employees, delivery_tasks
    // before contract/client (contract_id/client_id FKs), employee has no FK dependency on either.
    try {
      await runCleanupSteps([
        ['tms.contact_log', () => (taskId ? deleteContactAttemptsForTask(pool, taskId) : Promise.resolve())],
        ['tms.delivery_tasks', () => (taskId ? deleteDeliveryTask(pool, taskId) : Promise.resolve())],
        ['hr.employees', () => (driverEmployeeId ? deleteDriverEmployee(pool, driverEmployeeId) : Promise.resolve())],
        ['sales.contracts', () => (contractId ? deleteContract(pool, contractId) : Promise.resolve())],
        ['sales.accounts', () => (clientId ? deleteClient(pool, clientId) : Promise.resolve())],
      ]);
    } finally {
      await pool.end();
    }
  });

  test('Failed attempt billed only with contract flag', async () => {
    await test.step('Given client "SHOP" contract has bills_failed_attempt = true', async () => {
      const contractResult: QueryResult<{ bills_failed_attempt: boolean }> = await pool.query(
        `select bills_failed_attempt from sales.contracts where id = $1`,
        [contractId],
      );
      expect(contractResult.rows[0]?.bills_failed_attempt).toBe(true);
    });

    await test.step('And a task with two logged contact attempts', async () => {
      const taskResult: QueryResult<{ client_id: string }> = await pool.query(
        `select client_id from tms.delivery_tasks where id = $1`,
        [taskId],
      );
      expect(taskResult.rows[0]?.client_id).toBe(clientId);

      const contactResult: QueryResult<{ count: string }> = await pool.query(
        `select count(*)::text as count from tms.contact_log where task_id = $1`,
        [taskId],
      );
      expect(Number(contactResult.rows[0]?.count)).toBe(CONTACT_ATTEMPT_COUNT);
    });

    await test.step('When the driver records failure "no_answer.no_response"', async () => {
      // No "record delivery failure" command/handler exists yet (rows 3.4 exceptions + 3.5
      // failure-reason tree, streams B→C; doc 40 line 459) — calls nothing, writes nothing; the
      // later Then/And steps below still run and report on their own.
      expect.soft(
        false,
        'NOT BUILT: no "record delivery failure" command exists yet (rows 3.4 exceptions + 3.5 failure-reason ' +
          `tree, streams B→C; doc 40 line 459) — cannot record failure ${FAILURE_REASON_CODE} for task ${taskId} ` +
          'through any real handler',
      ).toBe(true);
    });

    await test.step('Then a billable event DL-11 is created', async () => {
      const billableResult: QueryResult<{ id: string }> = await pool.query(
        `select be.id
           from billing.billable_events be
           join catalog.services s on s.id = be.service_id
          where be.source_table = $1 and be.source_id = $2 and s.code = $3`,
        [DELIVERY_TASK_SOURCE_TABLE, taskId, DL_11_SERVICE_CODE],
      );
      expect.soft(
        billableResult.rows[0],
        `NOT BUILT: no billing.billable_events row exists for source_table=${DELIVERY_TASK_SOURCE_TABLE}, ` +
          `source_id=${taskId}, service ${DL_11_SERVICE_CODE} — the billing subscriber TMS→billable events (row ` +
          '4.3, stream B, on rows 3.4/3.5; doc 40 line 460) does not exist yet',
      ).toBeDefined();
    });

    await test.step('And failure counts_against_driver = false', async () => {
      const taskResult: QueryResult<{ failure_reason: string | null; counts_against_driver: boolean | null }> = await pool.query(
        `select dt.failure_reason, fr.counts_against_driver
           from tms.delivery_tasks dt
           left join tms.failure_reasons fr on fr.code = dt.failure_reason
          where dt.id = $1`,
        [taskId],
      );
      const row = taskResult.rows[0];
      const missingMessage =
        `NOT BUILT: tms.delivery_tasks.failure_reason for task ${taskId} is still NULL — no failure is recorded ` +
        `(rows 3.4 + 3.5), so ${FAILURE_REASON_CODE} and its counts_against_driver attribution (row 3.5; doc 40 ` +
        'line 461) cannot be read yet';
      expect.soft(row?.failure_reason ?? null, missingMessage).toBe(FAILURE_REASON_CODE);
      expect.soft(row?.counts_against_driver ?? null, missingMessage).toBe(false);
    });
  });

  test('Task without complete address is rejected', async () => {
    await test.step(`When a task is created with area "${TASK_AREA_SALMIYA}" and no block or street`, async () => {
      // No HTTP endpoint/handler for task creation exists at all (row 3.4 delivery tasks, stream B;
      // doc 40 line 464) — calls nothing, writes nothing, never seeds a task row for this scenario.
      expect.soft(
        false,
        'NOT BUILT: no "create delivery task" command/HTTP endpoint exists yet (row 3.4 delivery tasks, stream B; ' +
          `doc 40 line 464) — cannot create a task with area "${TASK_AREA_SALMIYA}" and no block or street through ` +
          'any real handler',
      ).toBe(true);
    });

    await test.step('Then the API returns 422 listing the missing fields', async () => {
      // Never fake a response object — there is no handler call above that ever returned one.
      expect.soft(
        false,
        'NOT BUILT: no "create delivery task" command/HTTP endpoint exists yet (row 3.4, stream B; doc 40 line ' +
          '465) — no 422 response (or any response) was ever produced to assert against',
      ).toBe(true);
    });
  });
});
