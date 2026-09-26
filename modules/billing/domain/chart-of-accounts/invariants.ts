// modules/billing/domain/chart-of-accounts/invariants.ts — WBS 4.1a (lane 2).
//
// domain/ layer: pure invariant checks — no I/O, no Date, no Math.random() (CLAUDE.md · AGENT
// CONSTRAINTS). `billing.gl_accounts` (01-Data-Model.sql:1177-1187) is a single reference table
// with no lifecycle (brief: "An account has no lifecycle in 01") — this slice's only two
// invariants are the account code shape (SCR-ACC-01 #1) and the account_type closed list
// (SCR-ACC-01 #2). Both are re-enforced by the database's own CHECK constraints (migration
// 0028_2_chart-of-accounts.sql) — these functions are the
// domain-level, no-DB-round-trip line of defence a caller checks BEFORE any insert; pg-tester's
// property test (../../tests/chart-of-accounts/invariants.property.test.ts) proves the two agree.

import { InvalidAccountCodeError, InvalidAccountTypeError } from './errors.js';

// SCR-ACC-01 #1: code shape `X-XX-XXX-XXX` — class (1 digit, 1-9) - sub (2 digits) -
// group (3 digits) - account (3 digits). Named constants, never magic numbers inline in the regex
// or the class-bounds check.
const CODE_CLASS_SEGMENT_LENGTH = 1;
const CODE_SUB_SEGMENT_LENGTH = 2;
const CODE_GROUP_SEGMENT_LENGTH = 3;
const CODE_ACCOUNT_SEGMENT_LENGTH = 3;
const ACCOUNT_CLASS_MIN = 1;
const ACCOUNT_CLASS_MAX = 9;

const ACCOUNT_CODE_PATTERN = new RegExp(
  `^([${ACCOUNT_CLASS_MIN}-${ACCOUNT_CLASS_MAX}]{${CODE_CLASS_SEGMENT_LENGTH}})-` +
    `(\\d{${CODE_SUB_SEGMENT_LENGTH}})-` +
    `(\\d{${CODE_GROUP_SEGMENT_LENGTH}})-` +
    `(\\d{${CODE_ACCOUNT_SEGMENT_LENGTH}})$`,
);

/** SCR-ACC-01 #1: true iff `code` matches `X-XX-XXX-XXX` with its first segment (the class) a
 *  single digit in 1-9. Pure: no I/O, no Date, no Math.random(). */
export function isValidAccountCode(code: string): boolean {
  return ACCOUNT_CODE_PATTERN.test(code);
}

/** SCR-ACC-01 #1: throws `InvalidAccountCodeError` iff `!isValidAccountCode(code)`. */
export function assertValidAccountCode(code: string): void {
  if (!isValidAccountCode(code)) {
    throw new InvalidAccountCodeError(
      `chart-of-accounts: code '${code}' does not match the X-XX-XXX-XXX shape with a class ` +
        `digit ${ACCOUNT_CLASS_MIN}-${ACCOUNT_CLASS_MAX} as its first segment (SCR-ACC-01 #1). ` +
        `(Allowed: X-XX-XXX-XXX, first segment ${ACCOUNT_CLASS_MIN}-${ACCOUNT_CLASS_MAX})`,
    );
  }
}

/** SCR-ACC-01 #1: the code's class — its first segment, as a number 1-9. Throws
 *  `InvalidAccountCodeError` if `code` is not X-XX-XXX-XXX shaped (never returns a value for an
 *  off-format code). */
export function accountClassFromCode(code: string): number {
  const match = ACCOUNT_CODE_PATTERN.exec(code);
  if (!match) {
    throw new InvalidAccountCodeError(
      `chart-of-accounts: code '${code}' does not match the X-XX-XXX-XXX shape — cannot read a ` +
        `class from it (SCR-ACC-01 #1). (Allowed: X-XX-XXX-XXX, first segment ` +
        `${ACCOUNT_CLASS_MIN}-${ACCOUNT_CLASS_MAX})`,
    );
  }
  const classSegment = match[1];
  if (classSegment === undefined) {
    throw new InvalidAccountCodeError(`chart-of-accounts: code '${code}' has no class segment.`);
  }
  return Number(classSegment);
}

// SCR-ACC-01 #2: the existing five values (01-Data-Model.sql:1183 comment: "asset · liability ·
// equity · revenue · expense") plus the four new values named verbatim by SCR-ACC-01 #2 ("Cost of
// Revenue, Other Income/Expense, Tax, Control/Memorandum"). DB-safe snake_case, matching the
// existing five's lower-case, no-space style — this exact spelling was fixed at the pre-migration
// pg-reviewer review (brief "Defaults taken" §2) and is applied by migration
// 0028_2_chart-of-accounts.sql's `account_type` CHECK constraint.
export const ALLOWED_ACCOUNT_TYPES: readonly string[] = [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
  'cost_of_revenue',
  'other_income_expense',
  'tax',
  'control_memorandum',
] as const;

/** SCR-ACC-01 #2: throws `InvalidAccountTypeError` iff `accountType` is not a member of
 *  `ALLOWED_ACCOUNT_TYPES`. */
export function assertValidAccountType(accountType: string): void {
  if (!ALLOWED_ACCOUNT_TYPES.includes(accountType)) {
    throw new InvalidAccountTypeError(
      `chart-of-accounts: account_type '${accountType}' is not in the allowed list (SCR-ACC-01 ` +
        `#2). (Allowed: ${ALLOWED_ACCOUNT_TYPES.join(', ')})`,
    );
  }
}
