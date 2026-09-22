// packages/identity/index.ts — WBS 0.17.
//
// Barrel: the package's public surface — the OTP, session and RBAC/SoD mechanisms of doc 01 §2
// and 13B §SoD, and nothing else. This slice ships no endpoint and no UI (GM decision 2026-09-22,
// docs/notes/0.17-sequencing-decision-request.md): these TypeScript types ARE the contract until
// a later task wires a login endpoint and adds its Zod contract.
//
// The three test suites import directly from './src/*.js' rather than through this barrel — same
// precedent as packages/events/index.ts (WBS 0.12); the barrel exists for future consumers of
// @pg-eos/identity-mechanisms.
//
// PACKAGE NAME (round-2 review, finding 1): the manifest name is `@pg-eos/identity-mechanisms`,
// not `@pg-eos/identity` — the latter is already taken by `modules/identity/package.json`
// (WBS 0.16), and two workspace projects sharing one name make `pnpm --filter` ambiguous. The
// directory stays `packages/identity/`; only the manifest name carries the distinction, and
// "mechanisms" is the GM's own Phase-0 vocabulary (docs/notes/0.17-sequencing-decision-request.md:
// mechanisms only until 2.9).
//
// NOT re-exported, deliberately: src/hmac.ts (keyedHash / hashesEqual) and src/context.ts. Both
// are internal plumbing — a caller that can hash with the package's own key, or hand-assemble the
// RLS context, can forge a stored token_hash or run a query under a context nobody chose. Same
// reasoning as WBS 0.11's `pool` and WBS 0.12's `clearSubscribers`, which are likewise absent from
// their barrels.

export type { GeneratedOtp, OtpClockOptions, OtpVerification } from './src/otp.js';
export {
  generateOtp,
  OTP_EXPIRY_MINUTES_KEY,
  UnknownOrInactiveUserError,
  verifyOtp,
} from './src/otp.js';

export type { IssuedSession, SessionClockOptions, SessionVerification } from './src/session.js';
export {
  issueSession,
  revokeSession,
  SESSION_LIFETIME_MINUTES_KEY,
  verifySession,
} from './src/session.js';

export {
  allowedEntities,
  assignRole,
  hasPermission,
  listRoles,
  SodViolationError,
} from './src/rbac.js';

export { getThreshold } from './src/thresholds.js';
