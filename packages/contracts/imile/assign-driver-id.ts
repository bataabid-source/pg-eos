// packages/contracts/imile/assign-driver-id.ts — WBS 3.12.
//
// Zod input/result schemas for the assign-driver-id use case's ONE command, AssignDriverId. Every
// field derives from imile.driver_id_assignments (database/schema/13-Schema-Additions.sql:295-313):
// driver_id_ref, employee_id — never a field not on that table (brief, Contract line).
// `assignedBy`/`approvedBy` are NOT input — `assignedBy` comes from ctx.userId, `approvedBy` stays
// null this slice (brief, Contract: "no approvedBy this slice").

import { z } from 'zod';

const UUID_ID = z.string().uuid();

export const AssignDriverIdInputSchema = z
  .object({
    driverIdRef: UUID_ID,
    employeeId: UUID_ID,
    correlationId: UUID_ID,
  })
  .meta({ id: 'AssignDriverIdInput' });

export type AssignDriverIdInput = z.infer<typeof AssignDriverIdInputSchema>;

export const AssignDriverIdResultSchema = z
  .object({
    assignmentId: UUID_ID,
  })
  .meta({ id: 'AssignDriverIdResult' });

export type AssignDriverIdResult = z.infer<typeof AssignDriverIdResultSchema>;
