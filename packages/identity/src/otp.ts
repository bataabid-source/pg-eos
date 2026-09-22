// packages/identity/src/otp.ts — WBS 0.17.
//
// The OTP mechanism: generateOtp issues a one-time code for an existing, active user;
// verifyOtp checks one. Both run inside withContext(ctx, fn) (@pg-eos/db, WBS 0.11) — CLAUDE.md ·
// ARCHITECTURE: "All DB access goes through withContext(ctx, fn), which sets RLS session
// variables." No login endpoint, no self-registration, no rate-limit policy is built here: this
// slice is the mechanism only (WBS 0.17 brief, Scope; GM decision 2026-09-22).
//
// Tables (database/schema/01-Data-Model.sql:212-224, 279-286), used exactly as defined, nothing
// added:
//   identity.users     (id, email unique, is_active, …)
//   identity.otp_codes (id, email, code_hash, expires_at, consumed_at, attempts)
//
// NO SELF-REGISTRATION: there is no rule anywhere in docs 01 / 13 / 13B / 019 / 40 that creates a
// user from an OTP request, so generateOtp refuses an unknown or inactive email instead of
// inventing one (CLAUDE.md · AGENT CONSTRAINTS: "No table, column, or business rule outside docs
// 01 / 13 / 13B / 019 / 40 … never invent").
//
// The clock is injected (`opts.now`, default `() => new Date()`) rather than read as a bare
// `new Date()` in the expiry path — CLAUDE.md forbids `new Date()` in domain/ for exactly this
// reason, and the WBS 0.17 brief extends the same discipline here so expiry is testable without
// sleeping.

import { randomInt } from 'node:crypto';

import { withContext } from '@pg-eos/db';
import { sql } from 'drizzle-orm';

import { INTERNAL_NO_ACTOR_CTX } from './context.js';
import { hashesEqual, keyedHash } from './hmac.js';
import { getThreshold, minutesAfter } from './thresholds.js';

/** platform.thresholds key holding the OTP lifetime, in minutes. See thresholds.ts — the value is
 *  read from the table, never defaulted here. */
export const OTP_EXPIRY_MINUTES_KEY = 'identity.otp.expiry_minutes';

/** Code length, from the WBS 0.17 brief ("a 6-digit OTP is a 1e6-space …"). A format constant of
 *  the mechanism, not a GM-editable threshold, so it is a named constant and not a
 *  platform.thresholds row. */
const OTP_DIGIT_COUNT = 6;
const OTP_VALUE_UPPER_BOUND_EXCLUSIVE = 10 ** OTP_DIGIT_COUNT;
const OTP_PAD_CHARACTER = '0';

export interface GeneratedOtp {
  readonly otpId: string;
  readonly userId: string;
  readonly email: string;
  /** The plaintext code — returned to the caller for delivery, and NEVER stored: only its keyed
   *  HMAC reaches identity.otp_codes.code_hash. */
  readonly code: string;
  readonly expiresAt: Date;
}

export type OtpVerification =
  | { readonly valid: true; readonly userId: string; readonly otpId: string }
  | { readonly valid: false };

export interface OtpClockOptions {
  readonly now?: () => Date;
}

/**
 * No identity.users row for this subject, or the row has is_active = false. Never a signal to
 * create one — see the NO SELF-REGISTRATION note above.
 *
 * One class, two entry points, because it is one condition: "the account this call is about is not
 * an active account". generateOtp knows its subject by email, issueSession (session.ts) knows its
 * subject by id — a second, parallel error class for the id-shaped case would be two things that
 * mean the same thing and can drift apart (round-2 review, finding 4). session.ts imports this
 * class rather than declaring its own, and re-exports it so either module is a valid import site.
 */
export class UnknownOrInactiveUserError extends Error {
  private constructor(subject: string) {
    super(`no active identity.users row for ${subject}`);
    this.name = 'UnknownOrInactiveUserError';
  }

  /** The subject was identified by identity.users.email (the OTP path). */
  static forEmail(email: string): UnknownOrInactiveUserError {
    return new UnknownOrInactiveUserError(`email: ${email}`);
  }

  /** The subject was identified by identity.users.id (the session path). */
  static forUserId(userId: string): UnknownOrInactiveUserError {
    return new UnknownOrInactiveUserError(`id: ${userId}`);
  }
}

function defaultClock(): Date {
  return new Date();
}

/** A cryptographically random OTP_DIGIT_COUNT-digit code. `randomInt` (node:crypto), never
 *  Math.random() — CLAUDE.md · AGENT CONSTRAINTS. Zero-padded so every code in the space is
 *  equally likely and the format is fixed. */
function generateCode(): string {
  return String(randomInt(0, OTP_VALUE_UPPER_BOUND_EXCLUSIVE)).padStart(
    OTP_DIGIT_COUNT,
    OTP_PAD_CHARACTER,
  );
}

/**
 * Issues one OTP for an existing, active user's email.
 *
 * @throws UnknownOrInactiveUserError when no active identity.users row matches `email` — nothing
 *         is written in that case (the withContext transaction rolls back).
 * @throws Error when platform.thresholds has no row for OTP_EXPIRY_MINUTES_KEY (thresholds.ts).
 */
export async function generateOtp(
  email: string,
  opts: OtpClockOptions = {},
): Promise<GeneratedOtp> {
  const now = opts.now ?? defaultClock;

  return withContext(INTERNAL_NO_ACTOR_CTX, async (tx) => {
    const users = await tx.execute<{ id: string }>(
      sql`select id from identity.users where email = ${email} and is_active`,
    );
    const user = users.rows[0];
    if (!user) {
      throw UnknownOrInactiveUserError.forEmail(email);
    }

    const expiryMinutes = await getThreshold(tx, OTP_EXPIRY_MINUTES_KEY);
    const issuedAt = now();
    const expiresAt = minutesAfter(issuedAt, expiryMinutes);
    const code = generateCode();

    const inserted = await tx.execute<{ id: string }>(sql`
      insert into identity.otp_codes (email, code_hash, expires_at)
      values (${email}, ${keyedHash(code)}, ${expiresAt.toISOString()}::timestamptz)
      returning id
    `);
    const otpRow = inserted.rows[0];
    if (!otpRow) {
      throw new Error('generateOtp: insert into identity.otp_codes returned no row');
    }

    return { otpId: otpRow.id, userId: user.id, email, code, expiresAt };
  });
}

/**
 * Verifies a code against EVERY live OTP outstanding for that email.
 *
 * Decision order, and why:
 *   1. no live candidate row        → invalid. A live candidate is a row that is unconsumed AND
 *                                     not past its own expires_at, so this one branch covers both
 *                                     "a consumed code cannot be reused" and "an expired code is
 *                                     rejected even if correct". Neither kind of row is touched:
 *                                     a dead row's attempts counter records nothing useful.
 *   2. the owning user is inactive  → invalid, and no counter moves (see IS_ACTIVE below).
 *   3. no candidate's code_hash matches → invalid, identity.otp_codes.attempts += 1 on every live
 *                                     candidate, none consumed (see ATTEMPTS below).
 *   4. otherwise                    → the MATCHING row's consumed_at is set to the injected
 *                                     instant, valid, and that row's user id is returned.
 *
 * WHY EVERY ROW AND NOT "THE NEWEST" (round-2 review, finding 3). Round 1 selected a single
 * candidate with `order by o.expires_at desc limit 1`. identity.otp_codes has no created_at column
 * (01-Data-Model.sql:279-286), so expires_at was the only available proxy for issue order — and it
 * is not a sound one: `identity.otp.expiry_minutes` is a live-editable platform.thresholds value,
 * so lowering it between two outstanding codes gives the NEWER code the EARLIER expires_at. The
 * newest-first pick then locked onto the stale row and rejected the code the user had just
 * received. There is no ordering that fixes this without a created_at column, so ordering is no
 * longer relied upon at all: the submitted code is checked against each live row, and a match on
 * ANY of them is a valid verification of THAT row. This is not a weakening — each row still
 * requires its own exact HMAC match, so the guess space is unchanged.
 *
 * ATTEMPTS, when several codes are outstanding (the brief does not specify which row absorbs the
 * attempt). Every live row is incremented, because every live row was in fact tested against the
 * submitted code: the guess was an attempt on the whole live set, not on one arbitrarily chosen
 * member of it, and a counter that rose on only one row would understate brute force against the
 * others. With the ordinary single-outstanding-code case this is exactly one increment, unchanged
 * from round 1.
 *
 * IS_ACTIVE (round-2 review, finding 4). A user deactivated between issue and verification must
 * not be able to consume a live code and walk it into issueSession. The owning identity.users row
 * is therefore re-checked here and not only in generateOtp. This is not an invented business rule:
 * `is_active` is the column doc 01 already defines for it (01:220) and generateOtp already refuses
 * on it — round 1 simply applied it at one end of the code's life and not the other. An inactive
 * owner does NOT increment attempts, for the same reason an expired row does not: the codes are
 * already dead, so the counter has nothing left to bound. identity.users.email is unique (01:214),
 * so all candidates for one email share one owner and the check cannot be self-contradictory.
 *
 * `for update of o` locks the live candidate rows for the life of the caller's transaction, so two
 * concurrent verifications of the same code cannot both reach step 4.
 *
 * The expiry comparison is made BY POSTGRES, against the injected instant passed in as a bound
 * timestamptz parameter, rather than in JavaScript: drizzle's node-postgres session installs its
 * own type parsers and hands timestamptz back as a raw string, so a client-side comparison would
 * depend on JS parsing Postgres's output format — an avoidable failure mode when the database can
 * compare two timestamptz values exactly.
 *
 * Still deliberately NOT implemented: OTP max attempts. Refusing a verification because attempts
 * exceeded a threshold is a lockout policy that appears nowhere in docs 01 / 13 / 13B / 019 / 40,
 * and inventing one here is what CLAUDE.md · AGENT CONSTRAINTS forbids; it is flagged to the
 * Master for the task that builds the login endpoint, which is where such a policy belongs.
 */
export async function verifyOtp(
  email: string,
  code: string,
  opts: OtpClockOptions = {},
): Promise<OtpVerification> {
  const now = opts.now ?? defaultClock;
  const at = now();

  return withContext(INTERNAL_NO_ACTOR_CTX, async (tx) => {
    const candidates = await tx.execute<{
      id: string;
      code_hash: string;
      user_id: string;
      is_active: boolean;
    }>(sql`
      select o.id,
             o.code_hash,
             u.id as user_id,
             u.is_active
        from identity.otp_codes o
        join identity.users u on u.email = o.email
       where o.email = ${email}
         and o.consumed_at is null
         and o.expires_at >= ${at.toISOString()}::timestamptz
       order by o.id
         for update of o
    `);

    const liveRows = candidates.rows;
    if (liveRows.length === 0) {
      return { valid: false };
    }

    if (liveRows.some((row) => !row.is_active)) {
      return { valid: false };
    }

    const presented = keyedHash(code);
    const matched = liveRows.find((row) => hashesEqual(row.code_hash, presented));

    if (!matched) {
      // Each live id is bound as its own parameter (sql.join), not as one array parameter:
      // drizzle's sql template unwraps a JS array value into its elements rather than handing
      // node-postgres an array to serialise, so `= any($1::uuid[])` receives a bare uuid and
      // Postgres rejects it as a malformed array literal.
      const liveIds = sql.join(
        liveRows.map((row) => sql`${row.id}::uuid`),
        sql`, `,
      );
      await tx.execute(sql`
        update identity.otp_codes
           set attempts = attempts + 1
         where id in (${liveIds})
      `);
      return { valid: false };
    }

    await tx.execute(sql`
      update identity.otp_codes
         set consumed_at = ${at.toISOString()}::timestamptz
       where id = ${matched.id}
    `);

    return { valid: true, userId: matched.user_id, otpId: matched.id };
  });
}
