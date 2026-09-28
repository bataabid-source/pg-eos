// tests/scenarios/S4.spec.ts — doc 40 Part E, Feature S4 (lines 467-478), integration lane 3, wave 1
// (Master directive slice brief "_slice-X-s4.brief.md" — RED, before any WBS 3.15/3.16 build).
//
// HONEST STATE: every Gherkin line below is its own `test.step`, verbatim.
//
// Scenario 1 ("Scan-to-cage under one second") — the Given's tables (imile.sorting_plans,
// imile.plan_assignments) DO exist in the live schema, so the Given is seeded there and asserted
// HARD by name. No command creates a sorting plan — WBS 3.16 (dispatch plan engine, depends on 3.15)
// — not built. The Given below is direct fixture SQL, same discipline fixtures/seed.ts and
// fixtures/partners.ts already use for THEIR modules' Given rows; it also seeds one
// imile.shipments row (the PDA's own input, not yet sorted) so a future scan handler has a real row
// to read. The When (a PDA scan) and the 1000 ms Then are NOT BUILT — WBS 3.15 "Sorting engine:
// scan -> cage/zone/driver in < 1 s" depends on 3.14 and 2.16 (docs/package/38-WBS.md row 3.15),
// neither COMPLETE (3.14 "iMile station agent" already has built handlers under modules/imile/api/ —
// report-agent-health, pull-shipments — but no scan/sort handler; 2.16 "PDA app" has parts done and
// parts still in its own backlog — docs/PROJECT_STATE.md "Lane backlog: 2.16 1a-3c/1a-4b"). Reported
// via named `expect.soft` — never timed, per the brief ("never time a stub"); `SCAN_TO_CAGE_MAX_MS`
// is a named constant taken from the Gherkin line itself (platform.thresholds holds no
// `sorting`/`scan`/`cage` key — checked by name).
//
// Scenario 2 ("Shipment attributed through time-bounded assignment") — the Given goes through the
// REAL `handleAssignDriverId` (WBS 3.12, built) twice, one call per employee, each with its own
// fixed clock (`@pg-eos/domain-kit`'s `FixedClock`) standing in for the Gherkin's own instants.
// Reading the built command (modules/imile/application/assign-driver-id/assign-driver-id.ts,
// modules/imile/domain/assign-driver-id/invariants.ts — read outside the brief's list; see the
// pg-tester REPORT for why) shows it performs exactly ONE transition per driver ID
// (available -> assigned), guarded by `imile.driver_ids.status = 'available'` (isAssignableStatus).
// The Given below reports this as TWO separate, named gaps (S18/S2 rule: a missing capability is a
// named `expect.soft`, never a HARD stop, and every later step still runs and reports its own genuine
// result): (a) there is no driver-ID RELEASE path at the Gherkin's own closing instant (14/03 11:20)
// — row 3.12 (docs/package/38-WBS.md: "imile.driver_ids + time-bounded assignments + termination
// trigger") owns this; the row's own acceptance line "terminated driver's ID auto-released" names a
// DIFFERENT mechanism — `hr.close_driver_id_on_termination` / `trg_close_driver_id` on
// `hr.employees` (database/schema/13-Schema-Additions.sql:391-413, fires on employee
// termination/resignation) — a SEPARATE trigger from `imile.close_assignment_on_suspension` /
// `trg_close_on_suspension` on `imile.driver_ids` (13-Schema-Additions.sql:415-430, fires on driver-ID
// suspension/block); NEITHER is a manual release-and-reassign-to-a-different-employee path, and
// neither is exercised by this spec; (b) the real second `handleAssignDriverId` call (assigning
// "D-0451" to "PG-0245") is made for real — never faked by direct SQL — and is expected, genuinely, to
// be blocked by gap (a): with no release, `imile.driver_ids.status` is still 'assigned', so this call
// conflicts (DriverIdNotAvailableError, 409).
//
// Shipment attribution is DERIVED, never a hand join: `imile.shipments_attributed`
// (database/schema/13-Schema-Additions.sql:315-329) is "العرض الوحيد المسموح لنسب شحنات iMile لسائق
// بشري" — the ONLY permitted source (row 3.13 "Attribution through assignment table only"; a direct
// join on `imile.shipments.driver_code` elsewhere is a "خطأ حرجاً" per the view's own comment). The
// When step below is BACKED, not NOT BUILT: it inserts the two delivered shipment fixture rows, then
// reads the real, built `imile.shipments_attributed` view for those two ids and asserts HARD that it
// returns exactly two rows — the rows are kept in a describe-level variable and read again (named
// `expect.soft`) by the Then step. The And step calls the real, built `imile.verify_attribution()`
// function and reports its own genuine result (pass or fail) through a named `expect.soft`, never
// hidden — brief: "this may genuinely pass or fail — report which, never soften".
//
// DEFAULTs taken (recorded, never invented): the year for "14/03"/"15/03" is `S4_YEAR`, sliced from
// the scenario clock's own `SCENARIO_CLOCK_DATE` ('2026-09-27') — never a bare literal; the time zone
// is Asia/Kuwait (UTC+3, no DST) — the SAME zone `modules/imile/domain/assign-driver-id/
// invariants.ts`'s `businessDateOf` itself uses (`database/schema/01-Data-Model.sql:8`: timestamps
// stored UTC, business-computed Asia/Kuwait) — never UTC, since the schema names one. Employee codes
// are doc 40's own literal "PG-0231"/"PG-0245" (no collision — checked). The iMile driver code is
// doc 40's own literal "D-0451" (no collision — checked). `hr.employees.entity_id` uses
// `PDL_ENTITY_CODE` ("PDL", delivery) — doc 40 does not name an entity for this iMile/delivery
// scenario; PDL is the delivery entity code the fixtures already expose for exactly this kind of
// case. PG-0231's own assignment start instant, `hr.employees.hire_date` and
// `hr.employee_documents.expiry_date` are not given by doc 40 at all — arbitrary, clearly-
// earlier/-later literals, named below.

import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import type { Pool, QueryResult } from 'pg';

import { FixedClock } from '@pg-eos/domain-kit';
import { HTTP_STATUS_OK } from '@pg-eos/api-kit';

import { createAssignDriverIdDeps } from '../../modules/imile/api/assign-driver-id/composition.js';
import { handleAssignDriverId } from '../../modules/imile/api/assign-driver-id/handlers.js';

import { createActor, teardownActor } from './fixtures/actors.js';
import { createIds, SCENARIO_CLOCK_DATE } from './fixtures/clock.js';
import { runCleanupSteps } from './fixtures/cleanup.js';
import {
  deleteDriverId,
  deleteDriverIdAssignmentsForDriverId,
  deleteEmployeeDocumentsForEmployee,
  deleteHrEmployee,
  deletePlanAssignmentsForPlan,
  deleteShipment,
  deleteSortingPlan,
  insertDriverId,
  insertEmployeeResidencyDocument,
  insertHrEmployee,
  insertPlanAssignment,
  insertShipment,
  insertSortingPlan,
} from './fixtures/imile.js';
import { getEntityIdByCode, PDL_ENTITY_CODE } from './fixtures/lookups.js';
import { createPool } from './fixtures/pool.js';
import { createCorrelationTracker, ctxFor, requestWithKey } from './fixtures/request.js';

// --- named constants (CLAUDE.md — no magic numbers) -----------------------------------------------

const S4_YEAR = SCENARIO_CLOCK_DATE.slice(0, 4); // clock-anchored: doc 40's "14/03"/"15/03" carry no
// year of their own — SCENARIO_CLOCK_DATE's own year, never invented, never a bare literal.

// Scenario 1
const S4_ZONE_SABAH = 'SABAH'; // doc 40 line 469/471.
const S4_DRIVER_CODE = 'D-0451'; // doc 40 line 469/471/474.
const S4_CAGE_C07 = 'C-07'; // doc 40 line 469/471.
const PLAN_ASSIGNMENT_PLANNED_COUNT = 1; // DEFAULT: doc 40 does not give a count; NOT NULL column.
const SCAN_INPUT_SHIPMENT_INTERNAL_STATUS = 'arrived'; // DEFAULT: the PDA's own scan input — arrived,
// not yet sorted (chk_shipments_internal_status allows it); driver_code/cage_code stay unset since
// those are what the (unbuilt) scan itself would assign.
const SCAN_TO_CAGE_MAX_MS = 1000; // doc 40 line 471 ("within 1000 ms"); no platform.thresholds key
// named `sorting`/`scan`/`cage` exists (checked) — the Gherkin's own literal is the source.

// Scenario 2
const PG_0231_CODE = 'PG-0231'; // doc 40 line 474.
const PG_0245_CODE = 'PG-0245'; // doc 40 line 474.
const S4_ACTOR_ROLE_CODES = ['DEL_MGR'] as const; // docs/package/38-WBS.md row 3.12 Owner column.
const DOC_TYPE_RESIDENCY = 'residency'; // modules/imile/domain/assign-driver-id/invariants.ts's
// DOC_TYPE_RESIDENCY — the one doc_type INV-C4-1 gates on for the 'task' purpose.
const EMPLOYEE_HIRE_DATE = '2020-01-01'; // DEFAULT: doc 40 gives no hire date; any date clearly
// before both assignment instants below satisfies hr.employees.hire_date NOT NULL.
const EMPLOYEE_DOCUMENT_EXPIRY_DATE = '2030-01-01'; // DEFAULT: doc 40 gives no expiry; clearly after
// both assignment instants below satisfies INV-C4-1's "not expired" gate.
const DRIVER_ID_ALLOCATED_AT = `${S4_YEAR}-01-01`; // DEFAULT: doc 40 gives no allocation date for
// "D-0451" itself; imile.driver_ids.allocated_at is NOT NULL — clearly before both assignment
// instants below, same clock-anchored year.
const PG_0231_ASSIGNED_FROM_ISO = `${S4_YEAR}-03-01T05:00:00+03:00`; // DEFAULT: doc 40 gives no start
// instant for PG-0231's own assignment, only its end ("until 14/03 11:20") — an arbitrary earlier
// instant, Asia/Kuwait (UTC+3), same clock-anchored year.
const PG_0231_ASSIGNED_UNTIL_ISO = `${S4_YEAR}-03-14T11:20:00+03:00`; // doc 40 line 474 "until 14/03
// 11:20", Asia/Kuwait (UTC+3) — the instant this spec expects (never produced by the real command;
// see the HONEST STATE paragraph above).
const PG_0245_ASSIGNED_FROM_ISO = `${S4_YEAR}-03-15T08:00:00+03:00`; // doc 40 line 474 "from 15/03
// 08:00", Asia/Kuwait (UTC+3).
const SHIPMENT_1_OFD_AT_ISO = `${S4_YEAR}-03-14T10:00:00+03:00`; // doc 40 line 475 "delivered on
// 14/03 10:00", Asia/Kuwait (UTC+3).
const SHIPMENT_2_OFD_AT_ISO = `${S4_YEAR}-03-15T09:00:00+03:00`; // doc 40 line 475 "and 15/03 09:00",
// Asia/Kuwait (UTC+3).
const SHIPMENT_INTERNAL_STATUS_DELIVERED = 'delivered'; // imile.verify_attribution's own WHERE
// clause reads this exact status (chk_shipments_internal_status).
const VERIFY_ATTRIBUTION_FROM_DATE = `${S4_YEAR}-03-14`;
const VERIFY_ATTRIBUTION_TO_DATE = `${S4_YEAR}-03-15`; // covers both delivered instants above.
const ASSIGN_DRIVER_ID_1_IDS_SEED = 94021; // brief: "createIds(940xx)".
const ASSIGN_DRIVER_ID_2_IDS_SEED = 94022;

test.describe('S4 Station client (iMile)', () => {
  const pool: Pool = createPool();
  // fix round precedent (S1/S2, S18): every correlationId this file generates, so afterAll can
  // delete exactly (and only) the platform.outbox rows this run itself wrote.
  const correlationTracker = createCorrelationTracker();

  let pdlEntityId: string;
  let actorId: string;

  // Scenario 1
  let sortingPlanId = '';
  let scanInputShipmentId = '';

  // Scenario 2
  let driverIdRefId = '';
  let employeePg0231Id = '';
  let employeePg0245Id = '';
  let shipment1Id = '';
  let shipment2Id = '';
  // this run's two attributed shipments' tracking numbers — verify_attribution() is scoped to them.
  let attributedTrackingNos: string[] = [];
  // populated by the When step, read by the Then step (finding 2: "keep the rows in a describe-level
  // variable") — imile.shipments_attributed is the only permitted source (see header).
  let attributedShipmentRows: { shipment_id: string; employee_id: string | null }[] = [];

  test.beforeAll(async () => {
    pdlEntityId = await getEntityIdByCode(pool, PDL_ENTITY_CODE);
    actorId = await createActor(pool, { namePrefix: '_s4_actor', roleCodes: S4_ACTOR_ROLE_CODES });
  });

  test.afterAll(async () => {
    // every cleanup step runs even if an earlier one throws (precedent S1/S2/S18's own afterAll) —
    // a partial cleanup must never abort at the first failing DELETE and leak every later table's
    // rows.
    try {
      await runCleanupSteps([
        ['platform.outbox', () => pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [correlationTracker.all()])],
        ['imile.shipments', () => (shipment1Id ? deleteShipment(pool, shipment1Id) : Promise.resolve())],
        ['imile.shipments (2)', () => (shipment2Id ? deleteShipment(pool, shipment2Id) : Promise.resolve())],
        ['imile.driver_id_assignments', () => (driverIdRefId ? deleteDriverIdAssignmentsForDriverId(pool, driverIdRefId) : Promise.resolve())],
        ['imile.driver_ids', () => (driverIdRefId ? deleteDriverId(pool, driverIdRefId) : Promise.resolve())],
        ['hr.employee_documents (PG-0231)', () => (employeePg0231Id ? deleteEmployeeDocumentsForEmployee(pool, employeePg0231Id) : Promise.resolve())],
        ['hr.employee_documents (PG-0245)', () => (employeePg0245Id ? deleteEmployeeDocumentsForEmployee(pool, employeePg0245Id) : Promise.resolve())],
        ['hr.employees (PG-0231)', () => (employeePg0231Id ? deleteHrEmployee(pool, employeePg0231Id) : Promise.resolve())],
        ['hr.employees (PG-0245)', () => (employeePg0245Id ? deleteHrEmployee(pool, employeePg0245Id) : Promise.resolve())],
        ['imile.shipments (scan input)', () => (scanInputShipmentId ? deleteShipment(pool, scanInputShipmentId) : Promise.resolve())],
        ['imile.plan_assignments', () => (sortingPlanId ? deletePlanAssignmentsForPlan(pool, sortingPlanId) : Promise.resolve())],
        ['imile.sorting_plans', () => (sortingPlanId ? deleteSortingPlan(pool, sortingPlanId) : Promise.resolve())],
        ['actor', () => (actorId ? teardownActor(pool, actorId) : Promise.resolve())],
      ]);
    } finally {
      await pool.end();
    }
  });

  test('Scan-to-cage under one second', async () => {
    await test.step('Given today\'s sorting plan assigns zone "SABAH" to driver "D-0451" cage "C-07"', async () => {
      sortingPlanId = await insertSortingPlan(pool, { planDate: SCENARIO_CLOCK_DATE });
      await insertPlanAssignment(pool, {
        planId: sortingPlanId,
        driverCode: S4_DRIVER_CODE,
        zones: [S4_ZONE_SABAH],
        cageCode: S4_CAGE_C07,
        plannedCount: PLAN_ASSIGNMENT_PLANNED_COUNT,
      });

      const planAssignmentResult: QueryResult<{ zones: string[]; cage_code: string; driver_code: string }> = await pool.query(
        `select zones, cage_code, driver_code from imile.plan_assignments where plan_id = $1`,
        [sortingPlanId],
      );
      const row = planAssignmentResult.rows[0];
      expect(row, 'the seeded imile.plan_assignments row must exist').toBeDefined();
      expect(row?.zones).toEqual([S4_ZONE_SABAH]);
      expect(row?.cage_code).toBe(S4_CAGE_C07);
      expect(row?.driver_code).toBe(S4_DRIVER_CODE);

      // finding 10: a real imile.shipments row for the PDA to (eventually) scan — zone_code SABAH,
      // internal_status 'arrived' (not yet sorted, so driver_code/cage_code stay unset — those are
      // what the unbuilt scan step itself would assign).
      scanInputShipmentId = await insertShipment(pool, {
        trackingNo: `_s4_${randomUUID()}_scan`,
        zoneCode: S4_ZONE_SABAH,
        internalStatus: SCAN_INPUT_SHIPMENT_INTERNAL_STATUS,
      });
      const shipmentResult: QueryResult<{ zone_code: string | null; internal_status: string }> = await pool.query(
        `select zone_code, internal_status from imile.shipments where id = $1`,
        [scanInputShipmentId],
      );
      expect(shipmentResult.rows[0]?.zone_code).toBe(S4_ZONE_SABAH);
      expect(shipmentResult.rows[0]?.internal_status).toBe(SCAN_INPUT_SHIPMENT_INTERNAL_STATUS);
    });

    await test.step('When a shipment for "SABAH" is scanned on the PDA', async () => {
      // NOT BUILT: no scan-to-cage handler exists anywhere under modules/imile/api/ (checked:
      // assign-driver-id, evaluate-dtl-problem, pull-shipments, report-agent-health only) — WBS 3.15
      // "Sorting engine: scan -> cage/zone/driver in < 1 s" depends on 3.14 and 2.16
      // (docs/package/38-WBS.md row 3.15), neither COMPLETE (see header). Never a stub call, never
      // timed.
      expect.soft(
        false,
        'NOT BUILT: no PDA scan-to-cage handler exists (row 3.15, doc 40 lines 467-471) — depends on ' +
          'rows 3.14 and 2.16, neither complete',
      ).toBe(true);
    });

    await test.step('Then the response within 1000 ms shows cage "C-07", zone "SABAH", driver "D-0451"', async () => {
      // NOT BUILT — same gap as the When step above; never timed against SCAN_TO_CAGE_MAX_MS since
      // there is no real response to time (brief: "never time a stub").
      expect.soft(
        false,
        `NOT BUILT: no scan response exists to assert cage/zone/driver on, or to time against the ` +
          `${SCAN_TO_CAGE_MAX_MS} ms bound (row 3.15, doc 40 line 471) — depends on rows 3.14 and 2.16, ` +
          'neither complete',
      ).toBe(true);
    });
  });

  test('Shipment attributed through time-bounded assignment', async () => {
    await test.step(
      'Given ID "D-0451" was assigned to employee "PG-0231" until 14/03 11:20 and to "PG-0245" from 15/03 08:00',
      async () => {
        employeePg0231Id = await insertHrEmployee(pool, {
          entityId: pdlEntityId,
          code: PG_0231_CODE,
          nameAr: `_s4_${randomUUID()}`,
          hireDate: EMPLOYEE_HIRE_DATE,
        });
        await insertEmployeeResidencyDocument(pool, {
          employeeId: employeePg0231Id,
          docType: DOC_TYPE_RESIDENCY,
          expiryDate: EMPLOYEE_DOCUMENT_EXPIRY_DATE,
        });

        employeePg0245Id = await insertHrEmployee(pool, {
          entityId: pdlEntityId,
          code: PG_0245_CODE,
          nameAr: `_s4_${randomUUID()}`,
          hireDate: EMPLOYEE_HIRE_DATE,
        });
        await insertEmployeeResidencyDocument(pool, {
          employeeId: employeePg0245Id,
          docType: DOC_TYPE_RESIDENCY,
          expiryDate: EMPLOYEE_DOCUMENT_EXPIRY_DATE,
        });

        driverIdRefId = await insertDriverId(pool, { imileCode: S4_DRIVER_CODE, allocatedAt: DRIVER_ID_ALLOCATED_AT });

        // The ONE real, built transition: available -> assigned, to PG-0231.
        const deps1 = createAssignDriverIdDeps({
          clock: new FixedClock(new Date(PG_0231_ASSIGNED_FROM_ISO)),
          ids: createIds(ASSIGN_DRIVER_ID_1_IDS_SEED),
        });
        const assignResult1 = await handleAssignDriverId(
          requestWithKey(
            { driverIdRef: driverIdRefId, employeeId: employeePg0231Id, correlationId: correlationTracker.next() },
            ctxFor(actorId),
          ),
          deps1,
        );
        expect(assignResult1.status, 'assigning "D-0451" to PG-0231 (available -> assigned) is the ONE real transition this command supports').toBe(
          HTTP_STATUS_OK,
        );

        // (a) NOT BUILT — no driver-ID release path exists to close PG-0231's assignment at the
        // Gherkin's own instant (14/03 11:20). Row 3.12 (docs/package/38-WBS.md: "imile.driver_ids +
        // time-bounded assignments + termination trigger") owns this; the row's own
        // "terminated driver's ID auto-released" acceptance line names a DIFFERENT, already-built
        // mechanism — hr.close_driver_id_on_termination / trg_close_driver_id on hr.employees
        // (database/schema/13-Schema-Additions.sql:391-413), a SEPARATE trigger from
        // imile.close_assignment_on_suspension / trg_close_on_suspension on imile.driver_ids
        // (13-Schema-Additions.sql:415-430) — neither is a manual release path, neither is exercised
        // here. Never invented as a call to a handler that does not exist — the gap is asserted on
        // real state in (c) below, which fails with this message until the release lands.
        const releaseNotBuiltMessage =
          `NOT BUILT: no driver-ID release path at ${PG_0231_ASSIGNED_UNTIL_ISO} (14/03 11:20) (row 3.12, doc 40 line 474)`;

        // (c) asserts (a) on real state: the live driver_id_assignments row for PG-0231 is checked
        // against the Gherkin's own closing instant entirely in SQL (node-pg returns a timestamptz
        // column as a JS Date — comparing here, server-side, avoids a JS Date/string mismatch).
        const assignmentsResult: QueryResult<{ employee_id: string; closed_at_gherkin_instant: boolean }> = await pool.query(
          `select employee_id, (assigned_to = $2::timestamptz) as closed_at_gherkin_instant
             from imile.driver_id_assignments where driver_id_ref = $1 order by assigned_from`,
          [driverIdRefId, PG_0231_ASSIGNED_UNTIL_ISO],
        );
        const pg0231Row = assignmentsResult.rows.find((r) => r.employee_id === employeePg0231Id);
        expect(pg0231Row, 'PG-0231\'s own driver_id_assignments row must exist after the first call').toBeDefined();
        expect.soft(
          pg0231Row?.closed_at_gherkin_instant,
          `${releaseNotBuiltMessage} — assigned_to is not closed at that instant (still open, no release ran)`,
        ).toBe(true);

        // (b) the real second call — made for real, never faked by direct SQL — blocked by gap (a):
        // with no release, imile.driver_ids.status is still 'assigned' (isAssignableStatus guards the
        // built command's ONE transition on status = 'available'), so this genuinely conflicts
        // (DriverIdNotAvailableError, 409).
        const deps2 = createAssignDriverIdDeps({
          clock: new FixedClock(new Date(PG_0245_ASSIGNED_FROM_ISO)),
          ids: createIds(ASSIGN_DRIVER_ID_2_IDS_SEED),
        });
        const assignResult2 = await handleAssignDriverId(
          requestWithKey(
            { driverIdRef: driverIdRefId, employeeId: employeePg0245Id, correlationId: correlationTracker.next() },
            ctxFor(actorId),
          ),
          deps2,
        );
        expect.soft(
          assignResult2.status,
          `NOT BUILT: blocked by the unbuilt release at ${PG_0231_ASSIGNED_UNTIL_ISO} (14/03 11:20) ` +
            `(row 3.12) — got ${assignResult2.status}`,
        ).toBe(HTTP_STATUS_OK);
      },
    );

    await test.step('When shipments delivered on 14/03 10:00 and 15/03 09:00 are attributed', async () => {
      attributedTrackingNos = [`_s4_${randomUUID()}_1`, `_s4_${randomUUID()}_2`];
      shipment1Id = await insertShipment(pool, {
        trackingNo: attributedTrackingNos[0] ?? '',
        driverCode: S4_DRIVER_CODE,
        zoneCode: S4_ZONE_SABAH,
        internalStatus: SHIPMENT_INTERNAL_STATUS_DELIVERED,
        ofdAt: SHIPMENT_1_OFD_AT_ISO,
      });
      shipment2Id = await insertShipment(pool, {
        trackingNo: attributedTrackingNos[1] ?? '',
        driverCode: S4_DRIVER_CODE,
        zoneCode: S4_ZONE_SABAH,
        internalStatus: SHIPMENT_INTERNAL_STATUS_DELIVERED,
        ofdAt: SHIPMENT_2_OFD_AT_ISO,
      });

      // BACKED (real, HARD) — imile.shipments_attributed (database/schema/13-Schema-Additions.sql:
      // 315-329) is "العرض الوحيد المسموح لنسب شحنات iMile لسائق بشري" — the ONLY permitted source
      // for shipment -> driver attribution (row 3.13 "Attribution through assignment table only").
      // Never a hand join on imile.shipments.driver_code (the view's own comment: doing so is
      // "خطأ حرجاً" in code review). Attribution itself is not a separate write — this view IS the
      // built attribution path.
      const attributedResult: QueryResult<{ shipment_id: string; employee_id: string | null }> = await pool.query(
        `select shipment_id, employee_id from imile.shipments_attributed where shipment_id = any($1::uuid[]) order by ofd_at`,
        [[shipment1Id, shipment2Id]],
      );
      attributedShipmentRows = attributedResult.rows;
      expect(attributedShipmentRows, 'imile.shipments_attributed must return exactly the two seeded shipments').toHaveLength(
        attributedTrackingNos.length,
      );
    });

    await test.step('Then the first is attributed to "PG-0231" and the second to "PG-0245"', async () => {
      // Real, from imile.shipments_attributed (the When step's own describe-level variable) —
      // reported by name (named expect.soft — S18/S2 rule: every step reports its own genuine
      // result, never halts the run).
      const row1 = attributedShipmentRows[0];
      const row2 = attributedShipmentRows[1];

      expect.soft(
        row1?.employee_id,
        `doc 40 line 476: the first shipment (14/03 10:00) is attributed to PG-0231 — got employee_id ` +
          `${row1?.employee_id ?? 'null'}, expected ${employeePg0231Id} (PG-0231)`,
      ).toBe(employeePg0231Id);

      // The Given step's own NOT BUILT report above already names why this is expected to genuinely
      // mismatch: PG-0245's own assignment was never created (row 3.12's release gap), so this
      // shipment resolves, for real, to PG-0231's still-open assignment window instead.
      expect.soft(
        row2?.employee_id,
        `doc 40 line 476: the second shipment (15/03 09:00) is attributed to PG-0245 — got employee_id ` +
          `${row2?.employee_id ?? 'null'}, expected ${employeePg0245Id} (PG-0245); PG-0245 was never ` +
          'actually assigned (row 3.12\'s release gap, see the Given step above)',
      ).toBe(employeePg0245Id);
    });

    await test.step('And verify_attribution() returns zero rows', async () => {
      // Real, against the live imile.verify_attribution() function — this may genuinely pass or fail
      // (brief: "never soften"); named expect.soft so its own genuine result is always reported by
      // the automated run, consistent with S18. See the HONEST STATE paragraph above: both shipments
      // may still match PG-0231's own still-open assignment window, which would make this genuinely
      // PASS despite the misattribution reported in the previous step.
      const verifyResult: QueryResult<{ tracking_no: string; driver_code: string; ofd_at: Date; reason: string }> = await pool.query(
        `select tracking_no, driver_code, ofd_at, reason from imile.verify_attribution($1::date, $2::date)
          where tracking_no = any($3::text[])`,
        [VERIFY_ATTRIBUTION_FROM_DATE, VERIFY_ATTRIBUTION_TO_DATE, attributedTrackingNos],
      );
      expect.soft(
        verifyResult.rows,
        `doc 40 line 477: verify_attribution() returns zero rows — got ${verifyResult.rows.length} row(s): ` +
          `${JSON.stringify(verifyResult.rows)}`,
      ).toEqual([]);
    });
  });
});
