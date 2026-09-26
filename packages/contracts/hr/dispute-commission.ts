// packages/contracts/hr/dispute-commission.ts — WBS 3.13 part 4.
//
// Zod input/result schemas for the dispute-commission use case's ONE command, DisputeCommission.
// Every field derives from hr.commission_daily (database/schema/13-Schema-Additions.sql:364-389).

import { z } from 'zod';

import { IdempotencyKeyHeader } from '../_shared/headers.js';
import type { RouteDefinitionInput } from '../_shared/registry.js';
import { okWithBody, writeErrorResponses } from '../_shared/route-responses.js';

const UUID_ID = z.string().uuid();

export const DisputeCommissionInputSchema = z
  .object({
    commissionDailyId: UUID_ID,
    disputeNote: z.string().min(1),
    correlationId: UUID_ID,
  })
  .meta({ id: 'DisputeCommissionInput' });

export type DisputeCommissionInput = z.infer<typeof DisputeCommissionInputSchema>;

export const DisputeCommissionResultSchema = z
  .object({
    commissionDailyId: UUID_ID,
    status: z.literal('disputed'),
  })
  .meta({ id: 'DisputeCommissionResult' });

export type DisputeCommissionResult = z.infer<typeof DisputeCommissionResultSchema>;

// --- OpenAPI route registrations (Master task, docs/STREAMS.md §Enablement item 6) -------------
// modules/hr/api/dispute-commission/handlers.ts maps CannotDisputeAnotherEmployeesRowError to its
// local HTTP_STATUS_FORBIDDEN, so 403 is registered.
export const ROUTES: readonly RouteDefinitionInput[] = [
  {
    method: 'POST',
    path: '/hr/dispute-commission/dispute-commission',
    summary: 'Dispute commission',
    request: {
      headers: z.object({ 'Idempotency-Key': IdempotencyKeyHeader }),
      body: DisputeCommissionInputSchema,
    },
    responses: { 200: okWithBody(DisputeCommissionResultSchema), ...writeErrorResponses({ forbidden: true }) },
  },
];
