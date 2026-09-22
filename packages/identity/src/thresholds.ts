// packages/identity/src/thresholds.ts — WBS 0.17.
//
// getThreshold(tx, key) — the ONLY way a numeric limit enters this package.
//
// CLAUDE.md · AGENT CONSTRAINTS: "No magic numbers — constants or platform.thresholds" and "Never
// fabricate a number, name, or decision. Numbers come from the system." The OTP expiry and the
// session lifetime are business numbers the General Manager edits (platform.thresholds, 13B:328-335,
// doc 40 §B5) — so they are read from the table at call time, and an absent row is an error, never
// a default. An embedded fallback here would be exactly the fabricated number the rule forbids,
// and would silently outlive the day someone sets the real value.
//
// KNOWN GAP (WBS 0.17 brief, "Known schema gap"): platform.thresholds carries no production seed
// row yet for `identity.otp.expiry_minutes`, `identity.otp.max_attempts` or
// `identity.session.lifetime_minutes`. 13B is frozen and database/schema/* is Master-only, so this
// package cannot seed them; the test suites seed their own fixture rows. Real seed rows are a
// Master follow-up, required before any live login flow ships — until then generateOtp and
// issueSession will (correctly, loudly) fail against a database that has none.
//
// `tx` is the scoped drizzle handle withContext(ctx, fn) passes to its callback (@pg-eos/db, WBS
// 0.11), typed exactly as packages/events/src/outbox.ts types it. getThreshold never opens its own
// transaction: it reads inside whatever transaction the caller already holds, so the limit that is
// applied is the limit that was visible at that instant of that transaction.

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** Unit conversion only — platform.thresholds.unit is 'minutes' for every key this package reads,
 *  JS Date arithmetic is in milliseconds. Not a business number. */
const MILLISECONDS_PER_MINUTE = 60_000;

/**
 * The platform.thresholds value for `key`, inside the caller's already-open transaction.
 *
 * @throws Error naming the missing key when no platform.thresholds row exists for it — there is no
 *         default, by design.
 */
export async function getThreshold(tx: NodePgDatabase, key: string): Promise<number> {
  const result = await tx.execute<{ value: string }>(
    sql`select value from platform.thresholds where key = ${key}`,
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `threshold not configured: ${key} — seed a platform.thresholds row for this key; ` +
        'this package has no default value (CLAUDE.md: numbers come from the system).',
    );
  }

  // platform.thresholds.value is numeric(14,3); node-postgres returns numeric as a string (it can
  // exceed IEEE-754 exact range), so it is parsed here rather than assumed to arrive as a number.
  const value = Number(row.value);
  if (!Number.isFinite(value)) {
    throw new Error(`threshold is not a finite number: ${key} = ${row.value}`);
  }
  return value;
}

/**
 * The instant `minutes` after `instant`. The single place a minutes-valued threshold becomes a
 * timestamp in this package, so the conversion cannot diverge between the OTP and session paths.
 */
export function minutesAfter(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * MILLISECONDS_PER_MINUTE);
}
