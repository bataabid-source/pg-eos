// packages/identity/src/context.ts — WBS 0.17.
//
// The two RLS contexts this package runs under. Both are ordinary `WithContextCtx` values
// (@pg-eos/db, WBS 0.11) — no new withContext variant, no bypass, no invented context shape.
// They live here, once, so the same combination is not re-typed (and drifted) in otp.ts,
// session.ts and rbac.ts.
//
// Why `isInternal: true` in both: every identity table this package reads or writes
// (identity.users · identity.otp_codes · identity.sessions · identity.user_roles ·
// identity.user_entities) carries the generated `internal_only` RLS policy —
// `using (platform.is_internal())`, database/schema/13B-Schema-Reference-Consolidation.sql:3033-3038
// — and platform.thresholds carries `reference_read`, `for select using (platform.is_internal())`
// (13B:3010-3014). Nothing here is reachable without it.

import type { WithContextCtx } from '@pg-eos/db';

/**
 * Pre-authentication context: there is no authenticated actor yet.
 *
 * Used by the OTP and session paths (a caller asking for an OTP, or presenting a token, is by
 * definition not yet authenticated) and by role assignment (whose actor is recorded in the row's
 * own `granted_by` column, not in the session GUCs). `WithContextCtx.userId` is `string | null`,
 * so `null` is an existing, legitimate value of the type — not a widening of it.
 */
export const INTERNAL_NO_ACTOR_CTX: WithContextCtx = {
  userId: null,
  clientId: null,
  isInternal: true,
};

/**
 * Context for evaluating the access scope OF a given user.
 *
 * `platform.has_perm(code)` and `platform.allowed_entities()` (01-Data-Model.sql:303-322) are both
 * defined over `platform.current_user_id()`, i.e. over the `app.user_id` session GUC that
 * withContext sets — they take no user argument. Evaluating them for a subject therefore means
 * running them with that subject as the session user; that IS what those two functions mean. This
 * is a read-only evaluation of the subject's own scope, never an action performed on their behalf.
 */
export function internalCtxForSubject(userId: string): WithContextCtx {
  return { userId, clientId: null, isInternal: true };
}
