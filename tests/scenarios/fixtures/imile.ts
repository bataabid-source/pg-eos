// tests/scenarios/fixtures/imile.ts — S4 Station client (iMile), new fixture (brief: "Write ONLY:
// tests/scenarios/S4.spec.ts · tests/scenarios/fixtures/imile.ts (new, only if a helper is needed)").
//
// Insert/delete pairs for the tables S4 needs that no existing fixture file covers: imile.sorting_plans
// / imile.plan_assignments (Scenario 1's Given — no command exists to create a sorting plan, WBS
// 3.16/3.15 not built, so this is direct fixture SQL, the same discipline seed.ts/partners.ts already
// use for THEIR modules' Given fixture rows), imile.driver_ids / imile.driver_id_assignments /
// imile.shipments (Scenario 2), and hr.employees / hr.employee_documents (Scenario 2's employee Given
// rows — assignDriverId's own INV-C4-1 gate reads these). Same shape as fixtures/seed.ts and
// fixtures/partners.ts: insertX(pool, {...}) => Promise<string> (the new row's id), deleteX(pool, id)
// => Promise<void>. No Math.random()/new Date() here — callers pass literal, named values.

import type { Pool, QueryResult } from 'pg';

// --- imile.sorting_plans / imile.plan_assignments (Scenario 1) -----------------------------------

export async function insertSortingPlan(pool: Pool, params: { readonly planDate: string }): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into imile.sorting_plans (plan_date) values ($1) returning id`,
    [params.planDate],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('insertSortingPlan: no id returned');
  return id;
}

/** `imile.plan_assignments.plan_id` cascades on delete of the parent `imile.sorting_plans` row
 *  (`plan_assignments_plan_id_fkey ... ON DELETE CASCADE`) — `deleteSortingPlan` below removes both;
 *  this explicit delete exists only so the cleanup order stays legible (D-183 discipline). */
export async function insertPlanAssignment(
  pool: Pool,
  params: {
    readonly planId: string;
    readonly driverCode: string;
    readonly zones: readonly string[];
    readonly cageCode: string;
    readonly plannedCount: number;
  },
): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into imile.plan_assignments (plan_id, driver_code, zones, cage_code, planned_count)
     values ($1, $2, $3::text[], $4, $5) returning id`,
    [params.planId, params.driverCode, params.zones, params.cageCode, params.plannedCount],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('insertPlanAssignment: no id returned');
  return id;
}

export async function deletePlanAssignmentsForPlan(pool: Pool, planId: string): Promise<void> {
  await pool.query(`delete from imile.plan_assignments where plan_id = $1`, [planId]);
}

export async function deleteSortingPlan(pool: Pool, id: string): Promise<void> {
  await pool.query(`delete from imile.sorting_plans where id = $1`, [id]);
}

// --- imile.driver_ids / imile.driver_id_assignments (Scenario 2) ---------------------------------

export async function insertDriverId(
  pool: Pool,
  params: { readonly imileCode: string; readonly allocatedAt: string },
): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into imile.driver_ids (imile_code, allocated_at) values ($1, $2) returning id`,
    [params.imileCode, params.allocatedAt],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('insertDriverId: no id returned');
  return id;
}

export async function deleteDriverIdAssignmentsForDriverId(pool: Pool, driverIdRef: string): Promise<void> {
  await pool.query(`delete from imile.driver_id_assignments where driver_id_ref = $1`, [driverIdRef]);
}

export async function deleteDriverId(pool: Pool, id: string): Promise<void> {
  await pool.query(`delete from imile.driver_ids where id = $1`, [id]);
}

// --- imile.shipments (Scenario 1's PDA input row, Scenario 2's delivered rows) ---------------------

export async function insertShipment(
  pool: Pool,
  params: {
    readonly trackingNo: string;
    readonly internalStatus: string;
    readonly zoneCode?: string;
    readonly driverCode?: string;
    readonly ofdAt?: string;
  },
): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into imile.shipments (tracking_no, driver_code, zone_code, internal_status, ofd_at)
     values ($1, $2, $3, $4, $5) returning id`,
    [params.trackingNo, params.driverCode ?? null, params.zoneCode ?? null, params.internalStatus, params.ofdAt ?? null],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('insertShipment: no id returned');
  return id;
}

export async function deleteShipment(pool: Pool, id: string): Promise<void> {
  await pool.query(`delete from imile.shipments where id = $1`, [id]);
}

// --- hr.employees / hr.employee_documents (Scenario 2's Given, INV-C4-1 gate) ----------------------

export async function insertHrEmployee(
  pool: Pool,
  params: { readonly entityId: string; readonly code: string; readonly nameAr: string; readonly hireDate: string },
): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into hr.employees (entity_id, code, name_ar, hire_date) values ($1, $2, $3, $4) returning id`,
    [params.entityId, params.code, params.nameAr, params.hireDate],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('insertHrEmployee: no id returned');
  return id;
}

export async function deleteHrEmployee(pool: Pool, id: string): Promise<void> {
  await pool.query(`delete from hr.employees where id = $1`, [id]);
}

export async function insertEmployeeResidencyDocument(
  pool: Pool,
  params: { readonly employeeId: string; readonly docType: string; readonly expiryDate: string },
): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into hr.employee_documents (employee_id, doc_type, expiry_date) values ($1, $2, $3) returning id`,
    [params.employeeId, params.docType, params.expiryDate],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('insertEmployeeResidencyDocument: no id returned');
  return id;
}

/** `hr.employee_documents.employee_id` cascades on delete of the parent `hr.employees` row
 *  (`employee_documents_employee_id_fkey ... ON DELETE CASCADE`) — `deleteHrEmployee` above removes
 *  both; this explicit delete exists only so the cleanup order stays legible (D-183 discipline). */
export async function deleteEmployeeDocumentsForEmployee(pool: Pool, employeeId: string): Promise<void> {
  await pool.query(`delete from hr.employee_documents where employee_id = $1`, [employeeId]);
}
