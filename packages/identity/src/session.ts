// packages/identity/src/session.ts — WBS 0.17.
//
// The session mechanism: issueSession mints a token, verifySession checks one, revokeSession
// ends one. Every call runs inside withContext(ctx, fn) (@pg-eos/db, WBS 0.11) — CLAUDE.md ·
// ARCHITECTURE. No cookie handling, no login endpoint, no refresh policy: mechanism only
// (WBS 0.17 brief, Scope).
//
// Table (database/schema/01-Data-Model.sql:267-277), used exactly as defined:
//   identity.sessions (id, user_id, token_hash, issued_at, expires_at, revoked_at, ip_address,
//                      user_agent)
// ip_address and user_agent are left null: they are request metadata, and no request layer exists
// in this slice. Populating them is the job of whatever transport later calls issueSession.
//
// The raw token is returned to the caller once and never stored — identity.sessions.token_hash
// holds only its keyed HMAC (hmac.ts). Verification therefore hashes the presented token and looks
// the hash up, which is why the stored value is deterministic under the key but one-way.
//
// The clock is injected (`opts.now`, default `() => new Date()`) so expiry is deterministic in
// tests without sleeping — same discipline as otp.ts.

import { randomBytes } from 'node:crypto';

import { withContext } from '@pg-eos/db';
import { sql } from 'drizzle-orm';

import { INTERNAL_NO_ACTOR_CTX } from './context.js';
import { keyedHash } from './hmac.js';
import { UnknownOrInactiveUserError } from './otp.js';
import { getThreshold, minutesAfter } from './thresholds.js';

// The "this account is not an active account" error is declared once, in otp.ts, and shared —
// not re-declared here (round-2 review, finding 4; see the class's own doc-comment). It is
// re-exported so a caller may import it from whichever module it reached the condition through.
export { UnknownOrInactiveUserError } from './otp.js';

/** platform.thresholds key holding the session lifetime, in minutes. Read from the table, never
 *  defaulted here — see thresholds.ts. */
export const SESSION_LIFETIME_MINUTES_KEY = 'identity.session.lifetime_minutes';

/** Entropy of the raw session token, in bytes: 32 bytes = 256 bits, the output width of the
 *  SHA-256 that hashes it, so the token is never the weaker half of the pair. A cryptographic
 *  parameter of the mechanism, not a GM-editable business threshold. */
const SESSION_TOKEN_BYTES = 32;

/** base64url: URL- and header-safe, no padding — a session token travels in transport headers. */
const SESSION_TOKEN_ENCODING = 'base64url';

export interface IssuedSession {
  readonly sessionId: string;
  readonly userId: string;
  /** The raw token — returned once, never stored. */
  readonly token: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export type SessionVerification =
  | { readonly valid: true; readonly userId: string; readonly sessionId: string }
  | { readonly valid: false };

export interface SessionClockOptions {
  readonly now?: () => Date;
}

function defaultClock(): Date {
  return new Date();
}

/** A cryptographically random session token. `randomBytes` (node:crypto), never Math.random() —
 *  CLAUDE.md · AGENT CONSTRAINTS. */
function generateToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString(SESSION_TOKEN_ENCODING);
}

/**
 * Issues a session for `userId`, expiring the session lifetime threshold after the injected
 * instant.
 *
 * issued_at is written explicitly from the injected clock rather than left to the column's
 * `default now()`: the two must agree, and only the injected clock is deterministic.
 *
 * IS_ACTIVE (round-2 review, finding 4). The subject's identity.users row is checked for
 * `is_active` (01-Data-Model.sql:220) inside the same transaction as the insert, before any
 * session exists. Round 1 checked it only in generateOtp, which left the deactivated-mid-flow
 * hole open at both ends: a user deactivated after their OTP was issued could verify it and then
 * be handed a working session. This is not an invented rule — is_active is the column doc 01
 * already defines for "this account may not be used", and the FK on identity.sessions.user_id
 * already forces the row to exist; only its active state was going unread.
 *
 * @throws UnknownOrInactiveUserError when no identity.users row with `is_active` matches
 *         `userId` — nothing is written (the withContext transaction rolls back).
 * @throws Error when platform.thresholds has no row for SESSION_LIFETIME_MINUTES_KEY.
 */
export async function issueSession(
  userId: string,
  opts: SessionClockOptions = {},
): Promise<IssuedSession> {
  const now = opts.now ?? defaultClock;

  return withContext(INTERNAL_NO_ACTOR_CTX, async (tx) => {
    const users = await tx.execute<{ id: string }>(
      sql`select id from identity.users where id = ${userId}::uuid and is_active`,
    );
    if (!users.rows[0]) {
      throw UnknownOrInactiveUserError.forUserId(userId);
    }

    const lifetimeMinutes = await getThreshold(tx, SESSION_LIFETIME_MINUTES_KEY);
    const issuedAt = now();
    const expiresAt = minutesAfter(issuedAt, lifetimeMinutes);
    const token = generateToken();

    const inserted = await tx.execute<{ id: string }>(sql`
      insert into identity.sessions (user_id, token_hash, issued_at, expires_at)
      values (
        ${userId}::uuid,
        ${keyedHash(token)},
        ${issuedAt.toISOString()}::timestamptz,
        ${expiresAt.toISOString()}::timestamptz
      )
      returning id
    `);
    const row = inserted.rows[0];
    if (!row) {
      throw new Error('issueSession: insert into identity.sessions returned no row');
    }

    return { sessionId: row.id, userId, token, issuedAt, expiresAt };
  });
}

/**
 * Verifies a raw session token.
 *
 * Invalid when the token hashes to no stored token_hash, when revoked_at is set, or when the
 * injected instant is past expires_at — the three conditions are one predicate in SQL, so a
 * session can never be judged valid by a query that saw only part of its row.
 */
export async function verifySession(
  token: string,
  opts: SessionClockOptions = {},
): Promise<SessionVerification> {
  const now = opts.now ?? defaultClock;
  const at = now();

  return withContext(INTERNAL_NO_ACTOR_CTX, async (tx) => {
    // KNOWN SCHEMA GAP — no index on identity.sessions.token_hash (round-2 review, finding 8).
    // 01-Data-Model.sql:267-277 indexes identity.sessions on (user_id, expires_at) only, so this
    // lookup — the hot path of every authenticated request once a transport exists — is a
    // sequential scan on the busiest table in auth. The fix is a migration adding an index on
    // token_hash; database/schema/* is frozen in Phase 0 and Master-owned, so it is out of WBS
    // 0.17's write scope and is recorded here (and in the report) rather than silently carried.
    const result = await tx.execute<{ id: string; user_id: string }>(sql`
      select id, user_id
        from identity.sessions
       where token_hash = ${keyedHash(token)}
         and revoked_at is null
         and expires_at >= ${at.toISOString()}::timestamptz
       limit 1
    `);

    const row = result.rows[0];
    if (!row) {
      return { valid: false };
    }
    return { valid: true, userId: row.user_id, sessionId: row.id };
  });
}

/**
 * Ends a session by setting identity.sessions.revoked_at to the injected instant.
 *
 * Idempotent by the `revoked_at is null` guard: revoking twice leaves the FIRST revocation time
 * standing, because when a session ended is a fact, not something a later call may overwrite. An
 * unknown session id is a no-op — there is no session left to end, which is the requested state.
 */
export async function revokeSession(
  sessionId: string,
  opts: SessionClockOptions = {},
): Promise<void> {
  const now = opts.now ?? defaultClock;
  const at = now();

  await withContext(INTERNAL_NO_ACTOR_CTX, async (tx) => {
    await tx.execute(sql`
      update identity.sessions
         set revoked_at = ${at.toISOString()}::timestamptz
       where id = ${sessionId}::uuid
         and revoked_at is null
    `);
  });
}
