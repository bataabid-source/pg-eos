// packages/identity/src/otp.ts — WBS 0.17.
//
// The OTP mechanism: generateOtp issues a one-time code for an existing, active user;
// verifyOtp checks one. Both run inside withContext(ctx, fn) (@pg-eos/db, WBS 0.11) — CLAUDE.md ·
// ARCHITECTURE: "All DB access goes through withContext(ctx, fn), which sets RLS session
// variables." No login endpoint and no self-registration are built here (WBS 0.17 brief, Scope;
// GM decision 2026-09-22).
//
// G-16a (EXECUTION-MASTER-v4 §1.8, verbatim): "OTP 6 digits · TTL 5 min · single-use · 5 attempts ·
// resend 60 s · 5/email/hour. Lockout 10 fails/15 min → 15→30→60 min; 3 lockouts/24 h → alert.
// Rate limits: login 5/min/IP + 20/h/email". WBS 2.16 part 1a-5 enforces the OTP-mechanism part of
// it here, every number read from platform.thresholds (seeded by migration 0042):
//   - TTL                       identity.otp.expiry_minutes            (generateOtpInTx, WBS 0.17)
//   - 5 attempts                identity.otp.max_attempts              (verifyOtpInTx)
//   - resend 60 s               identity.otp.resend_seconds            (generateOtpInTx)
//   - 5/email/hour              identity.otp.requests_per_email_per_hour (generateOtpInTx)
//   - single-use + a new request invalidates every earlier live code  (generateOtpInTx, D3)
// NOT enforced — the lockout ladder, "3 lockouts/24 h → alert" and both login rate limits. Their
// numbers are seeded (identity.login.*, migration 0042) but the schema holds no per-failure instant,
// no lockout record and no client IP; docs/notes/SCR-IDENTITY-AUTH-01.md (G-01) requests them.
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
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { INTERNAL_NO_ACTOR_CTX } from './context.js';
import { hashesEqual, keyedHash } from './hmac.js';
import { getThreshold, minutesAfter } from './thresholds.js';

/** platform.thresholds key holding the OTP lifetime, in minutes. See thresholds.ts — the value is
 *  read from the table, never defaulted here. */
export const OTP_EXPIRY_MINUTES_KEY = 'identity.otp.expiry_minutes';

/** platform.thresholds key: wrong verifications a code absorbs before it is refused even when
 *  correct (G-16a "5 attempts"). Read by verifyOtpInTx. */
export const OTP_MAX_ATTEMPTS_KEY = 'identity.otp.max_attempts';

/** platform.thresholds key: minimum seconds between two OTP requests for one email (G-16a
 *  "resend 60 s"). Read by generateOtpInTx. */
export const OTP_RESEND_SECONDS_KEY = 'identity.otp.resend_seconds';

/** platform.thresholds key: OTP requests accepted per email per hour (G-16a "5/email/hour"). Read
 *  by generateOtpInTx. */
export const OTP_REQUESTS_PER_EMAIL_PER_HOUR_KEY = 'identity.otp.requests_per_email_per_hour';

/** The length of the hourly-cap window, as a Postgres interval literal. It is the unit named in
 *  the G-16a rule itself ("5/email/hour") — the definition of "hour", not a GM-editable number;
 *  the cap's COUNT is the threshold. */
const HOURLY_CAP_WINDOW = '1 hour';

/** Namespace of the per-email advisory lock taken by generateOtpInTx, so the lock key can never
 *  coincide with an advisory lock another module derives from the same email text. */
const OTP_REQUEST_LOCK_NAMESPACE = 'identity.otp.request:';

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

/** Why generateOtpInTx refused a request: inside the resend window, or over the hourly cap. */
export type OtpRateLimitReason = 'resend' | 'hourly';

/**
 * generateOtpInTx refused the request under a G-16a limit (resend window or per-email hourly cap);
 * nothing was written. The message carries only the fixed reason — never the email or a code — so
 * it is safe in any log line. login.ts absorbs it into the anti-enumeration result: a caller never
 * learns that a limit bound.
 */
export class OtpRateLimitedError extends Error {
  readonly reason: OtpRateLimitReason;

  constructor(reason: OtpRateLimitReason) {
    super(`OTP request refused by G-16a limit: ${reason}`);
    this.name = 'OtpRateLimitedError';
    this.reason = reason;
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
 * The identity.users.id of the ACTIVE user with this email, or null — read on the caller's
 * transaction. Unknown and inactive (`is_active = false`) are deliberately the same `null`.
 */
async function activeUserIdByEmailInTx(tx: NodePgDatabase, email: string): Promise<string | null> {
  const users = await tx.execute<{ id: string }>(
    sql`select id from identity.users where email = ${email} and is_active`,
  );
  return users.rows[0]?.id ?? null;
}

/**
 * Issues one OTP for an existing, active user's email, on the CALLER's already-open transaction
 * (P6c). Opens no connection of its own: a caller already holding a pool client (e.g.
 * withIdempotentContext in the login endpoint) must not acquire a second one, or a bounded pool
 * deadlocks under concurrency. `tx` is typed exactly as getThreshold's (thresholds.ts). The
 * caller's context must satisfy the identity tables' `internal_only` RLS policy.
 *
 * Order (WBS 2.16 part 1a-5, G-16a):
 *   1. active-user check — an unknown or inactive email is refused before any limit is evaluated.
 *   2. SERIALISE PER EMAIL, as its own statement, before anything is counted:
 *      `pg_advisory_xact_lock(hashtext(namespace || email))`. Chosen over
 *      `select … for no key update` on the identity.users row because a row lock needs UPDATE
 *      privilege on identity.users and would also queue behind (and block) every unrelated writer
 *      of that user row; the advisory lock touches no table and is released with the transaction.
 *      A hashtext collision between two emails only serialises two unrelated requests — it can
 *      never let two requests for ONE email count concurrently. Being its own statement matters:
 *      under READ COMMITTED the count below takes a fresh snapshot AFTER the lock is granted, so it
 *      sees the row the previous lock holder committed.
 *   3. read expiry, resend and hourly cap — once each, via getThreshold (never a literal).
 *   4. ONE statement over EVERY identity.otp_codes row for the email (consumed and expired rows
 *      included — a code the user already used or let lapse was still a request):
 *        derived_issue = expires_at − expiry_minutes × 1 minute (see ISSUE-INSTANT SKEW below)
 *        resend  refused when any derived_issue > now − resend_seconds (so a request exactly
 *                resend_seconds later is accepted);
 *        hourly  refused when count(derived_issue > now − 1 hour) ≥ requests_per_email_per_hour.
 *      No upper bound on derived_issue: a row issued "after" the injected instant still counts.
 *   5. refused → throw OtpRateLimitedError(reason), nothing written. Otherwise every unconsumed
 *      row for the email gets consumed_at = now (a new request invalidates every earlier live code,
 *      D3), then the new row is inserted.
 * `now` is bound as a timestamptz parameter and compared by Postgres, as verifyOtpInTx does.
 *
 * ISSUE-INSTANT SKEW (D4). identity.otp_codes has no created_at column (01-Data-Model.sql:289-296),
 * so the issue instant is derived from expires_at and the CURRENT identity.otp.expiry_minutes. If a
 * GM edits expiry_minutes, rows issued under the old value are placed off their true issue instant
 * by exactly the size of the edit: LOWERING it moves them later (they count longer — fails closed);
 * RAISING it moves them earlier, so a resend can be accepted early — fails open on resend for at
 * most one old TTL, after which every row was issued under the new value. Removed by adding
 * identity.otp_codes.created_at (SCR-IDENTITY-AUTH-01, item 5).
 *
 * @throws UnknownOrInactiveUserError when no active identity.users row matches `email` — this call
 *         writes nothing; the caller's transaction decides what rolls back.
 * @throws OtpRateLimitedError when the resend window or the hourly cap refuses the request — this
 *         call writes nothing.
 * @throws Error when platform.thresholds has no row for one of the OTP keys (thresholds.ts).
 */
export async function generateOtpInTx(
  tx: NodePgDatabase,
  email: string,
  opts: OtpClockOptions = {},
): Promise<GeneratedOtp> {
  const now = opts.now ?? defaultClock;

  const userId = await activeUserIdByEmailInTx(tx, email);
  if (userId === null) {
    throw UnknownOrInactiveUserError.forEmail(email);
  }

  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${OTP_REQUEST_LOCK_NAMESPACE + email}))`,
  );

  const expiryMinutes = await getThreshold(tx, OTP_EXPIRY_MINUTES_KEY);
  const resendSeconds = await getThreshold(tx, OTP_RESEND_SECONDS_KEY);
  const requestsPerHour = await getThreshold(tx, OTP_REQUESTS_PER_EMAIL_PER_HOUR_KEY);

  const issuedAt = now();
  const issuedAtParam = issuedAt.toISOString();

  const issueWindow = await tx.execute<{ within_resend: boolean; issued_in_hour: string }>(sql`
    with issued as (
      select o.expires_at - ${expiryMinutes}::double precision * interval '1 minute' as derived_issue
        from identity.otp_codes o
       where o.email = ${email}
    )
    select coalesce(
             bool_or(
               derived_issue > ${issuedAtParam}::timestamptz
                               - ${resendSeconds}::double precision * interval '1 second'
             ),
             false
           ) as within_resend,
           count(*) filter (
             where derived_issue > ${issuedAtParam}::timestamptz - ${HOURLY_CAP_WINDOW}::interval
           ) as issued_in_hour
      from issued
  `);
  const counted = issueWindow.rows[0];
  if (!counted) {
    throw new Error('generateOtp: the G-16a window query returned no row');
  }
  if (counted.within_resend) {
    throw new OtpRateLimitedError('resend');
  }
  if (Number(counted.issued_in_hour) >= requestsPerHour) {
    throw new OtpRateLimitedError('hourly');
  }

  await tx.execute(sql`
    update identity.otp_codes
       set consumed_at = ${issuedAtParam}::timestamptz
     where email = ${email}
       and consumed_at is null
  `);

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

  return { otpId: otpRow.id, userId, email, code, expiresAt };
}

/**
 * Issues one OTP for an existing, active user's email, in its own withContext transaction.
 * Delegates to generateOtpInTx — one implementation.
 *
 * @throws UnknownOrInactiveUserError when no active identity.users row matches `email` — nothing
 *         is written in that case (the withContext transaction rolls back).
 * @throws OtpRateLimitedError when the resend window or the hourly cap refuses the request —
 *         nothing is written.
 * @throws Error when platform.thresholds has no row for one of the OTP keys (thresholds.ts).
 */
export async function generateOtp(
  email: string,
  opts: OtpClockOptions = {},
): Promise<GeneratedOtp> {
  return withContext(INTERNAL_NO_ACTOR_CTX, async (tx) => generateOtpInTx(tx, email, opts));
}

/**
 * Verifies a code against EVERY live OTP outstanding for that email, on the CALLER's
 * already-open transaction (P6c) — opens no connection of its own; see generateOtpInTx.
 *
 * Decision order, and why:
 *   1. no live candidate row        → invalid. A live candidate is a row that is unconsumed, not
 *                                     past its own expires_at, AND has fewer than
 *                                     identity.otp.max_attempts recorded attempts, so this one
 *                                     branch covers "a consumed code cannot be reused", "an expired
 *                                     code is rejected even if correct" and "an exhausted code is
 *                                     rejected even if correct". No such row is touched: a dead
 *                                     row's attempts counter records nothing useful.
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
 * MAX ATTEMPTS (G-16a "5 attempts", WBS 2.16 part 1a-5). identity.otp.max_attempts is read once
 * via getThreshold and applied as `o.attempts < max` in the candidate select itself, so a row that
 * has absorbed max wrong verifications is refused even for the correct code, and is neither
 * consumed nor incremented further. The refusal is the ordinary `{ valid: false }`, never a throw:
 * a throw would roll back the attempts increment of the same call inside withIdempotentContext,
 * and it would also give a caller an oracle ("exhausted" vs "wrong") that the uniform refusal
 * denies. The lockout ladder ("Lockout 10 fails/15 min → 15→30→60 min") is NOT enforced here: it
 * needs per-failure instants the schema does not hold — docs/notes/SCR-IDENTITY-AUTH-01.md.
 */
export async function verifyOtpInTx(
  tx: NodePgDatabase,
  email: string,
  code: string,
  opts: OtpClockOptions = {},
): Promise<OtpVerification> {
  const now = opts.now ?? defaultClock;
  const at = now();
  const maxAttempts = await getThreshold(tx, OTP_MAX_ATTEMPTS_KEY);

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
       and o.attempts < ${maxAttempts}::numeric
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
}

/**
 * verifyOtpInTx in its own withContext transaction — one implementation, same behaviour. The
 * injected clock is still read once, before the transaction opens, exactly as before P6c.
 */
export async function verifyOtp(
  email: string,
  code: string,
  opts: OtpClockOptions = {},
): Promise<OtpVerification> {
  const at = (opts.now ?? defaultClock)();
  return withContext(INTERNAL_NO_ACTOR_CTX, async (tx) =>
    verifyOtpInTx(tx, email, code, { now: () => at }),
  );
}

/**
 * Pre-authentication user lookup (P6c — the login endpoint's user-directory read): the id of the
 * ACTIVE identity.users row with this email, or null. Unknown and inactive (`is_active = false`)
 * return the SAME null, so a caller cannot tell them apart. Runs under this package's own internal
 * context and takes no ctx parameter, so that context never leaves the package (context.ts
 * header); it returns only the id.
 */
export async function findActiveUserIdByEmail(email: string): Promise<string | null> {
  return withContext(INTERNAL_NO_ACTOR_CTX, async (tx) => activeUserIdByEmailInTx(tx, email));
}

/**
 * Pre-authentication read of the live platform.thresholds OTP lifetime, in minutes (P6c — the
 * login endpoint's OTP-expiry read). Runs under this package's own internal context; no ctx
 * parameter; returns only the number.
 *
 * @throws Error when platform.thresholds has no row for OTP_EXPIRY_MINUTES_KEY (thresholds.ts).
 */
export async function otpExpiryMinutes(): Promise<number> {
  return withContext(INTERNAL_NO_ACTOR_CTX, async (tx) => getThreshold(tx, OTP_EXPIRY_MINUTES_KEY));
}
