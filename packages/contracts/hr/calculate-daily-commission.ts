// packages/contracts/hr/calculate-daily-commission.ts — WBS 3.13 part 1.
//
// Zod input/result schemas for the calculate-daily-commission use case's ONE command,
// CalculateDailyCommission. `entityId` is NOT input — resolved from ctx, never caller-supplied
// (brief, Contract line, same discipline as register-employee/register-vehicle/assign-driver-id's
// own resolveCallerEntityId pattern). Every field derives from hr.commission_daily
// (database/schema/13-Schema-Additions.sql:364-389).

import { z } from 'zod';

const UUID_ID = z.string().uuid();
// database/schema/13-Schema-Additions.sql:367 `work_date date not null` — a plain calendar date
// string (YYYY-MM-DD), never a timestamp.
const DATE_STRING = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a date string (YYYY-MM-DD)');

export const CalculateDailyCommissionInputSchema = z
  .object({
    employeeId: UUID_ID,
    workDate: DATE_STRING,
    correlationId: UUID_ID,
  })
  .meta({ id: 'CalculateDailyCommissionInput' });

export type CalculateDailyCommissionInput = z.infer<typeof CalculateDailyCommissionInputSchema>;

// gross_commission is numeric(14,3) — carried as a decimal string, never a float, same discipline
// as @pg-eos/domain-kit's own Money type (packages/domain-kit/money.ts: "Never float (doc 40
// §A3)") this use case's application/domain layers use internally.
export const CalculateDailyCommissionResultSchema = z
  .object({
    commissionDailyId: UUID_ID,
    grossCommission: z.string(),
    deliveredCount: z.number().int(),
    failedCount: z.number().int(),
    returnedCount: z.number().int(),
  })
  .meta({ id: 'CalculateDailyCommissionResult' });

export type CalculateDailyCommissionResult = z.infer<typeof CalculateDailyCommissionResultSchema>;
