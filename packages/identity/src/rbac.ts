// packages/identity/src/rbac.ts — WBS 0.17.
//
// RBAC evaluation and role assignment. Every call runs inside withContext(ctx, fn) (@pg-eos/db,
// WBS 0.11) — CLAUDE.md · ARCHITECTURE.
//
// THE RULES LIVE IN THE DATABASE, AND ARE NOT RE-IMPLEMENTED HERE:
//   · permission evaluation  → platform.has_perm(code)        (01-Data-Model.sql:303-314)
//   · entity scope           → platform.allowed_entities()    (01-Data-Model.sql:317-322)
//   · separation of duties   → identity.check_sod() + trigger trg_sod on identity.user_roles
//                              (13B-Schema-Reference-Consolidation.sql:539-555)
// This file wraps them. It does not mirror them. A second copy of the SoD predicate in TypeScript
// would be a rule that can drift from the one the database actually enforces, and the drift would
// be silent — so assignRole simply performs the insert and translates the trigger's rejection into
// a typed error. It does not pre-empt the check, does not swallow it, and does not retry around it
// (WBS 0.17 brief, "Feature: RBAC / SoD evaluation"). The trigger already tests both directions of
// every identity.sod_rules pair (13B:545-546), so symmetry is inherited, not re-coded.
//
// Tables used exactly as defined (01:226-265): identity.roles · identity.permissions ·
// identity.role_permissions · identity.user_roles · identity.user_entities. Nothing added.
// identity.delegations, identity.check_sod_delegation(), platform.domain_owners and
// platform.approval_chains are explicitly out of this slice's scope (WBS 0.17 brief, Stop-and-ask).

import { withContext } from '@pg-eos/db';
import { sql } from 'drizzle-orm';

import { INTERNAL_NO_ACTOR_CTX, internalCtxForSubject } from './context.js';

/**
 * SQLSTATE of a plpgsql `raise exception` with no explicit condition — what identity.check_sod()
 * raises (13B:549). Postgres documents it as 'P0001' / raise_exception.
 */
const PLPGSQL_RAISE_EXCEPTION_SQLSTATE = 'P0001';

/**
 * Fragment of identity.check_sod()'s message, quoted from 13B:549
 * ('إسناد الدور يخالف قاعدة فصل المهام' — "the role assignment violates a separation-of-duties
 * rule"). Matched together with the SQLSTATE so that some OTHER P0001 raised on
 * identity.user_roles is never mistaken for an SoD rejection and silently re-labelled. This is a
 * database error-string matcher, not a UI string — no i18n key applies.
 */
const SOD_EXCEPTION_MESSAGE_FRAGMENT = 'فصل المهام';

/** A role assignment refused by identity.check_sod() / trg_sod. */
export class SodViolationError extends Error {
  constructor(userId: string, roleCode: string, cause: unknown) {
    super(
      `separation-of-duties rule refuses role ${roleCode} for user ${userId} ` +
        '(identity.check_sod, identity.sod_rules)',
      { cause },
    );
    this.name = 'SodViolationError';
  }
}

/**
 * True only for the trigger's own rejection.
 *
 * The whole `cause` chain is walked, not just the thrown error: drizzle wraps a failing query in
 * its own DrizzleQueryError and carries pg's DatabaseError — the one that holds the SQLSTATE —
 * underneath as `cause`. Matching only the outermost error would miss it. The walk is bounded by
 * `seen`, so a self-referencing or cyclic cause chain cannot spin.
 *
 * Narrowed through `in` rather than a cast, since `code` belongs to pg's DatabaseError, not Error.
 */
function isSodViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = 'code' in current ? current.code : undefined;
    if (
      code === PLPGSQL_RAISE_EXCEPTION_SQLSTATE &&
      current.message.includes(SOD_EXCEPTION_MESSAGE_FRAGMENT)
    ) {
      return true;
    }
    current = current.cause;
  }

  return false;
}

/**
 * Does `userId` hold `permissionCode`?
 *
 * Wraps platform.has_perm(), which is defined over platform.current_user_id() and takes no user
 * argument — so the subject is supplied the only way that function accepts one: as the
 * `app.user_id` of the transaction it runs in (see context.ts, internalCtxForSubject). The
 * revoked_at / role_permissions join stays where doc 01 put it.
 */
export async function hasPermission(userId: string, permissionCode: string): Promise<boolean> {
  return withContext(internalCtxForSubject(userId), async (tx) => {
    const result = await tx.execute<{ granted: boolean }>(
      sql`select platform.has_perm(${permissionCode}) as granted`,
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('hasPermission: platform.has_perm() returned no row');
    }
    return row.granted;
  });
}

/**
 * Grants `roleCode` to `userId`, recording `grantedBy`.
 *
 * granted_at is left to the column default (01:253) — the database's own clock is the one clock
 * every row in that table already agrees on.
 *
 * @throws SodViolationError when trg_sod refuses the insert. The transaction rolls back, so no
 *         identity.user_roles row survives for the refused pairing — and roles granted by
 *         EARLIER, separate calls are untouched.
 * @throws Error when `roleCode` matches no identity.roles row (the insert…select then inserts
 *         nothing, which must not be reported as success).
 */
export async function assignRole(
  userId: string,
  roleCode: string,
  grantedBy: string | null,
): Promise<{ userRoleId: string }> {
  return withContext(INTERNAL_NO_ACTOR_CTX, async (tx) => {
    try {
      const inserted = await tx.execute<{ id: string }>(sql`
        insert into identity.user_roles (user_id, role_id, granted_by)
        select ${userId}::uuid, r.id, ${grantedBy}::uuid
          from identity.roles r
         where r.code = ${roleCode}
        returning id
      `);
      const row = inserted.rows[0];
      if (!row) {
        throw new Error(`unknown role code: ${roleCode} (no identity.roles row)`);
      }
      return { userRoleId: row.id };
    } catch (error) {
      if (isSodViolation(error)) {
        throw new SodViolationError(userId, roleCode, error);
      }
      throw error;
    }
  });
}

/** The codes of the roles `userId` actively holds (revoked_at is null), ordered by code. */
export async function listRoles(userId: string): Promise<readonly string[]> {
  return withContext(internalCtxForSubject(userId), async (tx) => {
    const result = await tx.execute<{ code: string }>(sql`
      select r.code
        from identity.user_roles ur
        join identity.roles r on r.id = ur.role_id
       where ur.user_id = ${userId}::uuid
         and ur.revoked_at is null
       order by r.code
    `);
    return result.rows.map((row) => row.code);
  });
}

/**
 * The platform.entities ids `userId` may see.
 *
 * Wraps platform.allowed_entities() (01:317-322), which — like has_perm — is defined over
 * platform.current_user_id() and takes no argument, so the subject is supplied as the
 * transaction's app.user_id. Reading identity.user_entities directly instead would be a second
 * definition of entity scope competing with the one every RLS policy in 13B already calls.
 */
export async function allowedEntities(userId: string): Promise<readonly string[]> {
  return withContext(internalCtxForSubject(userId), async (tx) => {
    const result = await tx.execute<{ entity_ids: string[] }>(
      sql`select platform.allowed_entities() as entity_ids`,
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('allowedEntities: platform.allowed_entities() returned no row');
    }
    return row.entity_ids;
  });
}
