// packages/contracts/hr/register-employee.ts — WBS 3.3.
//
// Zod input schemas for the register-employee use case's four commands. Every id is a uuid.
// `expiryDate`/`issueDate`/`hireDate` are `z.iso.date()` (zod v4, `YYYY-MM-DD`). `performedBy`
// does NOT exist on any schema: the actor is ALWAYS `ctx.userId`, never a caller-supplied field.
// `entityId` does NOT exist on RegisterEmployeeInputSchema either — brief D9: "entity_id =
// ctx.entityId (never caller-supplied)". RecordEmployeeDocument and ChangeEmployeeStatus carry
// `expectedVersion` — the optimistic-lock token the caller read most recently; a stale one ->
// StaleVersionError (409). CheckDriverAssignableInputSchema carries no `expectedVersion` and no
// Idempotency-Key (it is read-only, brief D1) — a failure is always a typed throw, never
// `{ assignable: false }` (CheckDriverAssignableResultSchema only ever encodes `true`).
//
// TEMPLATE GUIDANCE: one contract file per use case, one exported `<Command>InputSchema` per
// command — scripts/new-slice.sh's sed-rename relies on that literal naming.

import { z } from 'zod';

const UUID_ID = z.string().uuid();
// doc 40 §C7 `PG-####` — 01-Data-Model.sql:1270 `hr.employees.code text not null unique`.
const EMPLOYEE_CODE = z.string().regex(/^PG-\d{4}$/);
// hr.employees.version starts at 1 (migration 0014: int not null default 1).
const MIN_VERSION = 1;
const EXPECTED_VERSION = z.number().int().min(MIN_VERSION);
// 01-Data-Model.sql:1303 comment — the five doc_type values this schema carries (no DB CHECK).
const DOC_TYPES = ['residency', 'passport', 'license', 'health_card', 'contract'] as const;
// 01-Data-Model.sql:1279 chk_employees_status (13B:2445).
const EMPLOYEE_STATUSES = ['active', 'on_leave', 'suspended', 'terminated'] as const;
// brief D4 — the two purposes CheckDriverAssignable's hard gate is called for.
const ASSIGNMENT_PURPOSES = ['task', 'vehicle'] as const;

export const RegisterEmployeeInputSchema = z
  .object({
    code: EMPLOYEE_CODE,
    nameAr: z.string().min(1),
    nameEn: z.string().min(1).optional(),
    civilId: z.string().min(1).optional(),
    nationality: z.string().min(1).optional(),
    passportNo: z.string().min(1).optional(),
    jobTitleAr: z.string().min(1).optional(),
    jobTitleEn: z.string().min(1).optional(),
    orgUnitId: UUID_ID.optional(),
    reportsTo: UUID_ID.optional(),
    employmentType: z.string().min(1).optional(),
    hireDate: z.iso.date(),
    assignedClientId: UUID_ID.optional(),
    phone: z.string().min(1).optional(),
    email: z.string().email().optional(),
    correlationId: UUID_ID,
  })
  .meta({ id: 'RegisterEmployeeInput' });

export type RegisterEmployeeInput = z.infer<typeof RegisterEmployeeInputSchema>;

export const RecordEmployeeDocumentInputSchema = z
  .object({
    employeeId: UUID_ID,
    docType: z.enum(DOC_TYPES),
    docNo: z.string().min(1).optional(),
    issueDate: z.iso.date().optional(),
    expiryDate: z.iso.date(),
    fileUrl: z.string().min(1).optional(),
    alertDaysBefore: z.number().int().positive().optional(),
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'RecordEmployeeDocumentInput' });

export type RecordEmployeeDocumentInput = z.infer<typeof RecordEmployeeDocumentInputSchema>;

export const ChangeEmployeeStatusInputSchema = z
  .object({
    employeeId: UUID_ID,
    newStatus: z.enum(EMPLOYEE_STATUSES),
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'ChangeEmployeeStatusInput' });

export type ChangeEmployeeStatusInput = z.infer<typeof ChangeEmployeeStatusInputSchema>;

export const CheckDriverAssignableInputSchema = z
  .object({
    employeeId: UUID_ID,
    purpose: z.enum(ASSIGNMENT_PURPOSES),
    correlationId: UUID_ID,
  })
  .meta({ id: 'CheckDriverAssignableInput' });

export type CheckDriverAssignableInput = z.infer<typeof CheckDriverAssignableInputSchema>;

export const CheckDriverAssignableResultSchema = z
  .object({
    assignable: z.literal(true),
  })
  .meta({ id: 'CheckDriverAssignableResult' });

export type CheckDriverAssignableResult = z.infer<typeof CheckDriverAssignableResultSchema>;
