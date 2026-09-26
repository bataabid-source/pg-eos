// modules/identity/application/otp-login/ports.ts — WBS 2.16 part 1a-3.
//
// The ports the otp-login commands program against. Every command takes `deps: OtpLoginDeps`,
// built by the composition root (../../api/otp-login/composition.ts), and never imports
// infrastructure/ — same hexagonal shape as modules/wms/application/receive-inbound/ports.ts.
//
// POST-P6c: there is no repository port. The whole pre-authentication path — account lookup,
// idempotency, OTP issue/verify, session issue — is owned end to end by the two flows
// @pg-eos/identity-mechanisms exports (requestLoginOtp / verifyLoginOtp), under that package's own
// internal context, so this module never adapts a table and never builds an RLS context. What is
// left to inject is the clock (handed to the flows as `opts.now`) and the logger.

import type { Clock } from '@pg-eos/domain-kit';

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". Any value
 *  is accepted (including an `err` key holding the raw caught value) so pino's own `err`
 *  convention passes straight through. */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by ../../infrastructure/otp-login/logger.ts (a
 *  @pg-eos/logger child-logger adapter); a spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** Everything a command needs, injected by the composition root. */
export interface OtpLoginDeps {
  readonly clock: Clock;
  readonly logger: Logger;
}
