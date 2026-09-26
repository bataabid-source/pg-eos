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
