// modules/identity/domain/otp-login/errors.ts — WBS 2.16 part 1a-3.
//
// The one typed error the otp-login use case adds. Sets `name` explicitly — an `Error` subclass
// does NOT get its constructor name for free at runtime (same discipline as
// modules/wms/domain/receive-inbound/errors.ts). The api/ layer (../../api/otp-login/handlers.ts)
// maps it to a 422 Problem, title = error.name.
//
// Deliberately NOT a reuse of @pg-eos/identity-mechanisms' UnknownOrInactiveUserError (brief,
// Master decision 2): an unmatched code, an expired code, a consumed code and an unknown or
// inactive email must all be indistinguishable to the caller, so every one of them surfaces as
// this single class — never as an error whose name or message says which case occurred.

/** The (email, code) pair did not verify — for any reason. Maps to HTTP 422. */
export class InvalidOtpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOtpError';
  }
}
