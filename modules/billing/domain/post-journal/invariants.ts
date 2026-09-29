// modules/billing/domain/post-journal/invariants.ts — WBS 4.20 (lane 2).
//
// domain/ layer: pure invariant checks — no I/O, no Date, no Math.random(). The application layer
// (../../application/post-journal/*) calls these BEFORE any DB write; a failed invariant throws a
// typed error from ./errors.ts (golden slice: modules/wms/domain/receive-inbound/invariants.ts).
// The database enforces the same rules as a backstop (migration 0041: T1/T2 balance at COMMIT,
// T3 account entity/postable/manual-revenue, chk_journal_entries_manual_approved).
//
// Amounts are numeric(14,3) decimal STRINGS (packages/contracts/billing/post-journal.ts AMOUNT) and
// are compared as integer thousandths (bigint) — never float arithmetic.

import {
  AccountNotInEntityError,
  AccountNotPostableError,
  InsufficientLinesError,
  InvalidAmountError,
  ManualJournalApprovalRequiredError,
  ManualRevenueJournalRefusedError,
  UnbalancedEntryError,
} from './errors.js';

/** numeric(14,3): three fractional digits. */
const FRACTION_DIGITS = 3;
const MILLI_PER_UNIT = 1000n;
const AMOUNT_PATTERN = /^(\d{1,11})(?:\.(\d{1,3}))?$/;
/** One-side-only lines (01:1212) can balance only with at least one debit and one credit line. */
export const MIN_JOURNAL_LINES = 2;

/** A0 §1 row 4 entry type the OD-15 rule names, and the account type it excludes. */
export const MANUAL_ENTRY_TYPE = 'manual';
export const REVENUE_ACCOUNT_TYPE = 'revenue';

export type AmountLine = { debit?: string | undefined; credit?: string | undefined };

/** numeric(14,3) decimal string -> integer thousandths. Throws InvalidAmountError on any other shape. */
export function toMilli(amount: string): bigint {
  const match = AMOUNT_PATTERN.exec(amount);
  if (!match) {
    throw new InvalidAmountError(`amount "${amount}" is not a numeric(14,3) decimal string (Allowed: e.g. 100.000)`);
  }
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(FRACTION_DIGITS, '0');
  return BigInt(whole) * MILLI_PER_UNIT + BigInt(fraction);
}

function sideMilli(amount: string | undefined): bigint {
  return amount === undefined ? 0n : toMilli(amount);
}

function totals(lines: readonly AmountLine[]): { readonly debit: bigint; readonly credit: bigint } {
  return lines.reduce(
    (sum, line) => ({ debit: sum.debit + sideMilli(line.debit), credit: sum.credit + sideMilli(line.credit) }),
    { debit: 0n, credit: 0n },
  );
}

/** lines.length >= 2 AND sum(debit) = sum(credit), in exact decimal arithmetic. */
export function isBalanced(lines: readonly AmountLine[]): boolean {
  const sums = totals(lines);
  return lines.length >= MIN_JOURNAL_LINES && sums.debit === sums.credit;
}

/** Throws InsufficientLinesError (checked first) or UnbalancedEntryError. */
export function assertBalanced(lines: readonly AmountLine[]): void {
  if (lines.length < MIN_JOURNAL_LINES) {
    throw new InsufficientLinesError(
      `a journal entry has ${lines.length} line(s) (Allowed: at least ${MIN_JOURNAL_LINES} lines)`,
    );
  }
  const sums = totals(lines);
  if (sums.debit !== sums.credit) {
    throw new UnbalancedEntryError(
      `sum(debit) ${sums.debit} and sum(credit) ${sums.credit} (in thousandths) differ ` +
        '(Allowed: sum(debit) = sum(credit))',
    );
  }
}

/** A reversing entry's lines: same order, same other fields, debit and credit swapped. */
export function mirrorLines<T extends AmountLine>(lines: readonly T[]): T[] {
  return lines.map((line) => {
    const { debit, credit, ...rest } = line;
    const mirrored: AmountLine = { ...rest };
    if (credit !== undefined) mirrored.debit = credit;
    if (debit !== undefined) mirrored.credit = debit;
    return mirrored as T;
  });
}

/** What the domain needs to know about a line's GL account (billing.gl_accounts). */
export interface AccountFacts {
  readonly entityId: string;
  readonly isPostable: boolean;
  readonly accountType: string;
}

/** SCR-ACC-01 #8: every line's account is an account of `entityId` and postable. An account the
 *  caller cannot see is treated as not of the entity. */
export function assertLineAccounts(
  entityId: string,
  lines: ReadonlyArray<{ readonly accountId: string }>,
  accounts: ReadonlyMap<string, AccountFacts>,
): void {
  for (const line of lines) {
    const account = accounts.get(line.accountId);
    if (!account || account.entityId !== entityId) {
      throw new AccountNotInEntityError(
        `account ${line.accountId} is not an account of entity ${entityId} (Allowed: an account of the entry's entity)`,
      );
    }
    if (!account.isPostable) {
      throw new AccountNotPostableError(
        `account ${line.accountId} is not postable (Allowed: an account with is_postable = true)`,
      );
    }
  }
}

/**
 * ADR-0004 D3 OD-15 — "Manual journals allowed except revenue accounts; CFO approval". Part 1
 * (settled design, default F1): every manual journal is refused — ManualRevenueJournalRefusedError
 * when a line touches a revenue account, otherwise ManualJournalApprovalRequiredError (the approved
 * path is 4.20 part 2). Every other entry type passes.
 */
export function assertEntryTypePostable(
  entryType: string,
  lines: ReadonlyArray<{ readonly accountId: string }>,
  accounts: ReadonlyMap<string, AccountFacts>,
): void {
  if (entryType !== MANUAL_ENTRY_TYPE) return;
  const revenueLine = lines.find((line) => accounts.get(line.accountId)?.accountType === REVENUE_ACCOUNT_TYPE);
  if (revenueLine) {
    throw new ManualRevenueJournalRefusedError(
      `a manual journal may not post to revenue account ${revenueLine.accountId} (OD-15; Allowed: a non-revenue account)`,
    );
  }
  throw new ManualJournalApprovalRequiredError(
    'a manual journal requires CFO approval (OD-15; Allowed: an approved manual journal — 4.20 part 2)',
  );
}
