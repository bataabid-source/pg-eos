// modules/billing/domain/chart-of-accounts/errors.ts — WBS 4.1a (lane 2).
//
// Typed errors for the chart-of-accounts use case (SCR-ACC-01 §1-2). This slice has no lifecycle,
// no application command and no api layer (brief: "An account has no lifecycle in 01") — the only
// two invariants are the account code shape (X-XX-XXX-XXX, class 1-9 from the first segment) and
// the account_type closed list. Every class sets `name` explicitly (CLAUDE.md · AGENT
// CONSTRAINTS) — an `Error` subclass does NOT get its constructor name for free at runtime.

/** SCR-ACC-01 #1: `code` does not match the `X-XX-XXX-XXX` shape with its first segment in 1-9.
 *  Thrown by `assertValidAccountCode`/`accountClassFromCode` (./invariants.ts) BEFORE any DB write
 *  — the database's own CHECK constraint on `billing.gl_accounts.code` (migration
 *  0028_2_chart-of-accounts.sql) is the race-safe backstop, never the only line of defence. */
export class InvalidAccountCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAccountCodeError';
  }
}

/** SCR-ACC-01 #2: `account_type` is not a member of `ALLOWED_ACCOUNT_TYPES` (./invariants.ts).
 *  Thrown by `assertValidAccountType` BEFORE any DB write — the database's own CHECK constraint on
 *  `billing.gl_accounts.account_type` is the race-safe backstop. */
export class InvalidAccountTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAccountTypeError';
  }
}
