// packages/contracts/imile/evaluate-dtl-problem.ts — WBS 3.17 (part 1).
//
// Zod input/result schemas for the evaluate-dtl-problem use case's ONE command,
// EvaluateDtlProblem. Every field derives from imile.dtl_problems (database/schema/
// 01-Data-Model.sql:1378-1398): tracking_no, driver_code, problem_type, evidence_urls,
// customer_text, driver_text, raised_at — never a field not on that table (brief, Contract line).
// `engine_confidence`/`engine_reason`/`gate_result` are NOT input — they are the port's own result,
// carried in EvaluateDtlProblemResultSchema only.

import { z } from 'zod';

const UUID_ID = z.string().uuid();
const NON_EMPTY_STRING = z.string().min(1);
const ENGINE_DECISION = z.enum(['accept', 'reject', 'human', 'reclassify']);

export const EvaluateDtlProblemInputSchema = z
  .object({
    trackingNo: NON_EMPTY_STRING,
    driverCode: z.string().nullable(),
    problemType: NON_EMPTY_STRING,
    evidenceUrls: z.array(NON_EMPTY_STRING),
    customerText: z.string().nullable(),
    driverText: z.string().nullable(),
    raisedAt: z.iso.datetime(),
    correlationId: UUID_ID,
  })
  .meta({ id: 'EvaluateDtlProblemInput' });

export type EvaluateDtlProblemInput = z.infer<typeof EvaluateDtlProblemInputSchema>;

export const EvaluateDtlProblemResultSchema = z
  .object({
    id: UUID_ID,
    engineDecision: ENGINE_DECISION,
    // A G0 (completeness) failure never reaches a real content analysis — there is no confidence
    // figure to report, so the result carries `null` rather than a fabricated `0` (round-1 finding
    // 3, Master decision; brief, Contract line; imile.dtl_problems.engine_confidence numeric(5,4)
    // already allows null, 01:1386).
    engineConfidence: z.number().nullable(),
    engineReason: z.string(),
  })
  .meta({ id: 'EvaluateDtlProblemResult' });

export type EvaluateDtlProblemResult = z.infer<typeof EvaluateDtlProblemResultSchema>;
