// modules/identity/api/otp-login/composition.ts — WBS 2.16 part 1a-3.
//
// Composition root for the otp-login use case (same role as
// modules/wms/api/receive-inbound/composition.ts). POST-P6c it wires no adapter at all: the
// pre-authentication path is owned end to end by @pg-eos/identity-mechanisms' two flows, which the
// application layer calls directly (review round 1, finding 6 — resolved, not relocated).
//
//   clock  — domain-kit's SystemClock, handed to the flows as `opts.now`.
//   logger — the pino adapter by default; a caller (tests) may inject a spy Logger.

import { SystemClock } from '@pg-eos/domain-kit';

import type { Logger, OtpLoginDeps } from '../../application/otp-login/ports.js';
import { otpLoginPinoLogger } from '../../infrastructure/otp-login/logger.js';

export function createOtpLoginDeps(overrides: { readonly logger?: Logger } = {}): OtpLoginDeps {
  return {
    clock: new SystemClock(),
    logger: overrides.logger ?? otpLoginPinoLogger,
  };
}
