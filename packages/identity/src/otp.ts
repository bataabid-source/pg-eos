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
 * No identity.users row for this email, or the row has is_active = false. Never a signal to
 * create one — see the NO SELF-REGISTRATION note above.
 */
export class UnknownOrInactiveUserError extends Error {
  constructor(email: string) {
    super(`no active identity.users row for email: ${email}`);
    this.name = 'UnknownOrInactiveUserError';
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
      throw new UnknownOrInactiveUserError(email);
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
 * Verifies a code against the newest unconsumed OTP for that email.
 *
 * Decision order, and why:
 *   1. no unconsumed row            → invalid. Covers "a consumed code cannot be reused": the
 *                                     consumed row is no longer a candidate at all.
 *   2. past its own expires_at      → invalid, and the row is left untouched. An expired row is
 *                                     already dead; bumping its attempts counter would record
 *                                     nothing useful and mutate a row the caller can never use.
 *   3. hash mismatch                → invalid, identity.otp_codes.attempts += 1, NOT consumed.
 *                                     The counter exists to bound brute force against a live code,
 *                                     which is why it is incremented only in this branch.
 *   4. otherwise                    → consumed_at is set to the injected instant, valid.
 *
 * `for update of o` locks the candidate row for the life of the caller's transaction, so two
 * concurrent verifications of the same live code cannot both reach step 4.
 *
 * The expiry comparison is made BY POSTGRES, against the injected instant passed in as a bound
 * timestamptz parameter, rather than in JavaScript: drizzle's node-postgres session installs its
 * own type parsers and hands timestamptz back as a raw string, so a client-side comparison would
 * depend on JS parsing Postgres's output format — an avoidable failure mode when the database can
 * compare two timestamptz values exactly.
 *
 * identity.otp_codes has no created_at column (01:279-286), so "newest" is ordered by expires_at —
 * monotonic with issue time for a fixed expiry threshold. Reading the user id through the join on
 * identity.users is what makes the `valid` branch able to return a userId at all.
 *
 * Note (deliberately NOT implemented): this does not re-check is_active, and it does not enforce
 * OTP max attempts. Refusing a verification because the user was deactivated after the code was
 * issued, or because attempts exceeded a threshold, are both rules that appear nowhere in docs
 * 01 / 13 / 13B / 019 / 40 — inventing either here is precisely what CLAUDE.md · AGENT CONSTRAINTS
 * forbids. Both are flagged to the Master as open questions for the task that builds the login
 * endpoint (which is where a lockout policy belongs).
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
      is_expired: boolean;
      user_id: string;
    }>(sql`
      select o.id,
             o.code_hash,
             (o.expires_at < ${at.toISOString()}::timestamptz) as is_expired,
             u.id as user_id
        from identity.otp_codes o
        join identity.users u on u.email = o.email
       where o.email = ${email}
         and o.consumed_at is null
       order by o.expires_at desc
       limit 1
         for update of o
    `);

    const candidate = candidates.rows[0];
    if (!candidate) {
      return { valid: false };
    }

    if (candidate.is_expired) {
      return { valid: false };
    }

    if (!hashesEqual(candidate.code_hash, keyedHash(code))) {
      await tx.execute(
        sql`update identity.otp_codes set attempts = attempts + 1 where id = ${candidate.id}`,
      );
      return { valid: false };
    }

    await tx.execute(sql`
      update identity.otp_codes
         set consumed_at = ${at.toISOString()}::timestamptz
       where id = ${candidate.id}
    `);

    return { valid: true, userId: candidate.user_id, otpId: candidate.id };
  });
}
