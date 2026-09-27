// packages/contracts/identity/otp-login.ts — WBS 2.16 part 1a-3.
//
// Zod input schemas for the otp-login use case's two commands (request a code, verify a code).
// The caller is unauthenticated by definition, so there is no actor field and no ctx-derived
// field here — the subject is identified by `email` only (brief, Master decision 1: the OTP
// mechanism of WBS 0.17 is keyed by identity.users.email; the employee-code + PIN mechanism is
// 2.16 part 1b). `correlationId` follows the golden slice's convention
// (packages/contracts/wms/receive-inbound.ts).
//
// `code` is a non-empty string only: its format (digit count) is a constant of the WBS 0.17
// mechanism that the package does not export, so it is not duplicated here — a malformed code is
// simply a code that does not verify (InvalidOtpError, 422), indistinguishable from a wrong one.
//
// Neither schema, and no response of this use case, ever carries the OTP code itself (brief,
// Master decision 3).
//
// TEMPLATE GUIDANCE: one contract file per use case, one exported `<Command>InputSchema` per
// command.

import { z } from 'zod';

import { IdempotencyKeyHeader } from '../_shared/headers.js';
import type { RouteDefinitionInput } from '../_shared/registry.js';
import { ProblemSchema } from '../_shared/problem.js';
import { OK_RESPONSE, writeErrorResponses } from '../_shared/route-responses.js';

const UUID_ID = z.string().uuid();

export const RequestOtpCodeInputSchema = z
  .object({
    email: z.email(),
    correlationId: UUID_ID,
  })
  .meta({ id: 'RequestOtpCodeInput' });

export type RequestOtpCodeInput = z.infer<typeof RequestOtpCodeInputSchema>;

export const VerifyOtpCodeInputSchema = z
  .object({
    email: z.email(),
    code: z.string().min(1),
    correlationId: UUID_ID,
  })
  .meta({ id: 'VerifyOtpCodeInput' });

export type VerifyOtpCodeInput = z.infer<typeof VerifyOtpCodeInputSchema>;

// --- OpenAPI route registrations (Master task, docs/STREAMS.md §Enablement item 6) -------------
// Neither command has an exported result schema (brief, Master decision 3 — the OTP code itself
// never reaches a response either way). modules/identity/api/otp-login/handlers.ts's own header
// comment documents that a 409 is deliberately never mapped here (IdempotencyConflictError is
// absorbed inside login.ts), so both routes are registered with `conflict: false`.
const WRITE_HEADERS = z.object({ 'Idempotency-Key': IdempotencyKeyHeader });

// X part 12 (b): both routes are held by the host until 2.16 part 1a-5 (G-16a limits) is DONE
// (apps/api NOT_MOUNTED_UNTIL_2_16_PART_1A_5) and answer 501 — declared here until the hold lifts.
const HTTP_STATUS_NOT_IMPLEMENTED = 501;
const HELD_UNTIL_2_16_PART_1A_5 = { description: 'Not Implemented', body: ProblemSchema };

export const ROUTES: readonly RouteDefinitionInput[] = [
  {
    method: 'POST',
    path: '/identity/otp-login/request-otp-code',
    summary: 'Request OTP code',
    request: { headers: WRITE_HEADERS, body: RequestOtpCodeInputSchema },
    responses: {
      200: OK_RESPONSE,
      ...writeErrorResponses({ conflict: false }),
      [HTTP_STATUS_NOT_IMPLEMENTED]: HELD_UNTIL_2_16_PART_1A_5,
    },
  },
  {
    method: 'POST',
    path: '/identity/otp-login/verify-otp-code',
    summary: 'Verify OTP code',
    request: { headers: WRITE_HEADERS, body: VerifyOtpCodeInputSchema },
    responses: {
      200: OK_RESPONSE,
      ...writeErrorResponses({ conflict: false }),
      [HTTP_STATUS_NOT_IMPLEMENTED]: HELD_UNTIL_2_16_PART_1A_5,
    },
  },
];
