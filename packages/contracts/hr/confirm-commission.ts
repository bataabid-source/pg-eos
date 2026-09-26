// packages/contracts/hr/confirm-commission.ts — WBS 3.13 part 4.
//
// Zod input/result schemas for the confirm-commission use case's ONE command, ConfirmCommission.
// Every field derives from hr.commission_daily (database/schema/13-Schema-Additions.sql:364-389).

import { z } from 'zod';

import { IdempotencyKeyHeader } from '../_shared/headers.js';
import type { RouteDefinitionInput } from '../_shared/registry.js';
import { okWithBody, writeErrorResponses } from '../_shared/route-responses.js';

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

// --- OpenAPI route registrations (Master task, docs/STREAMS.md §Enablement item 6) -------------
// modules/hr/api/confirm-commission/handlers.ts maps SelfReviewNotAllowedError /
// ConfirmPermissionRequiredError to a LOCAL 403 constant, not PROBLEM_STATUS.FORBIDDEN — per the
// Master brief's literal grep rule (`PROBLEM_STATUS.FORBIDDEN`, which matches nowhere in this
// codebase today) no 403 is registered here; flagged in the closing report.
export const ROUTES: readonly RouteDefinitionInput[] = [
  {
    method: 'POST',
    path: '/hr/confirm-commission/confirm-commission',
    summary: 'Confirm commission',
    request: {
      headers: z.object({ 'Idempotency-Key': IdempotencyKeyHeader }),
      body: ConfirmCommissionInputSchema,
    },
    responses: { 200: okWithBody(ConfirmCommissionResultSchema), ...writeErrorResponses({ forbidden: true }) },
  },
];
