// packages/contracts/hr/confirm-commission.ts — WBS 3.13 part 4.
//
// Zod input/result schemas for the confirm-commission use case's ONE command, ConfirmCommission.
// Every field derives from hr.commission_daily (database/schema/13-Schema-Additions.sql:364-389).

import { z } from 'zod';

const UUID_ID = z.string().uuid();
// database/schema/13-Schema-Additions.sql:383 `payroll_period date` — a plain calendar date
// string (YYYY-MM-DD), first-of-month.
const DATE_STRING = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a date string (YYYY-MM-DD)');

export const ConfirmCommissionInputSchema = z
  .object({
    commissionDailyId: UUID_ID,
    correlationId: UUID_ID,
  })
  .meta({ id: 'ConfirmCommissionInput' });

export type ConfirmCommissionInput = z.infer<typeof ConfirmCommissionInputSchema>;

export const ConfirmCommissionResultSchema = z
  .object({
    commissionDailyId: UUID_ID,
    status: z.literal('confirmed'),
    payrollPeriod: DATE_STRING,
  })
  .meta({ id: 'ConfirmCommissionResult' });

export type ConfirmCommissionResult = z.infer<typeof ConfirmCommissionResultSchema>;
