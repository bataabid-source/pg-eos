// packages/contracts/hr/dispute-commission.ts — WBS 3.13 part 4.
//
// Zod input/result schemas for the dispute-commission use case's ONE command, DisputeCommission.
// Every field derives from hr.commission_daily (database/schema/13-Schema-Additions.sql:364-389).

import { z } from 'zod';

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
