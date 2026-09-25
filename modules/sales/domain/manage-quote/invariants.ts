// modules/sales/domain/manage-quote/invariants.ts — WBS 1.6, M02 sales.
//
// domain/ layer: pure invariant checks — no I/O, no Date, no Math.random(). The application layer
// (../../application/manage-quote/*) calls these BEFORE any DB write; a failed invariant throws a
// typed error from ./errors.ts.

import { Quantity } from '@pg-eos/domain-kit';

import {
  AccountNotFoundError,
  AccountNotQualifiedError,
  InvalidDiscountError,
  InvalidPriceExceptionError,
  InvalidValidUntilError,
  IllegalTransitionError,
  MarginOutOfRangeError,
  QuoteFrozenError,
} from './errors.js';
import { QUOTE_TAG_EDITABLE, QUOTE_TAG_FROZEN, QUOTE_TAG_REVISABLE, hasQuoteTag, type QuoteStatus } from './machine.js';

/** Master decision 17 ("lines are mutable only while status is draft"): throws QuoteFrozenError
 *  iff `status` is not tagged QUOTE_TAG_EDITABLE by the machine (today only `draft` carries it) —
 *  pg-reviewer's round-1 fix on catalog (finding 6) applied to this aggregate: the machine decides
 *  via its own tag, never an if/switch on the status string. */
export function assertQuoteEditable(status: QuoteStatus): void {
  if (!hasQuoteTag(status, QUOTE_TAG_EDITABLE)) {
    throw new QuoteFrozenError(
      `sales.quotes: lines may be written only while the quote's status carries the ` +
        `"${QUOTE_TAG_EDITABLE}" tag; this quote's status is "${status}" (Master decision 17 — ` +
        'a non-draft quote is frozen for line edits; use ReturnToDraft first).',
    );
  }
}

/** Master decision 17 ("sent/accepted/rejected/expired reject EVERY mutating command with
 *  QuoteFrozenError, steering the caller to ReviseQuote"): throws QuoteFrozenError iff `status`
 *  carries QUOTE_TAG_FROZEN. Called by every workflow command (SubmitForReview/ApproveCommercial/
 *  ApproveFinance/ReturnToDraft/SendQuote) BEFORE it asks the machine for the specific event's own
 *  legality, so a call on a frozen quote always surfaces QuoteFrozenError rather than the
 *  machine's own IllegalTransitionError (RecordDecision, legal only from `sent`, never calls
 *  this). */
export function assertQuoteNotFrozen(status: QuoteStatus): void {
  if (hasQuoteTag(status, QUOTE_TAG_FROZEN)) {
    throw new QuoteFrozenError(
      `sales.quotes: status "${status}" carries the "${QUOTE_TAG_FROZEN}" tag — every mutating ` +
        'command is refused (Master decision 17); call ReviseQuote to build a fresh quote instead.',
    );
  }
}

/** Master decision 12 ("any status EXCEPT draft/commercial_review/finance_review"): throws
 *  IllegalTransitionError iff `status` does not carry QUOTE_TAG_REVISABLE — ReviseQuote is only
 *  legal on approved/sent/accepted/rejected/expired quotes (a mutable quote is edited directly, or
 *  via ReturnToDraft first). */
export function assertQuoteRevisable(status: QuoteStatus): void {
  if (!hasQuoteTag(status, QUOTE_TAG_REVISABLE)) {
    throw new IllegalTransitionError(
      `ReviseQuote is not legal from status "${status}" — it requires the ` +
        `"${QUOTE_TAG_REVISABLE}" tag (Master decision 12: only approved/sent/accepted/rejected/` +
        'expired quotes may be revised; a draft/commercial_review/finance_review quote is edited ' +
        'directly, or via ReturnToDraft first).',
    );
  }
}

/** Master decision 4: throws InvalidDiscountError iff `discountAmt` is negative, or greater than
 *  `subtotal`. */
export function assertValidDiscount(discountAmt: Quantity, subtotal: Quantity): void {
  if (discountAmt.isNegative()) {
    throw new InvalidDiscountError(
      `discountAmt (${discountAmt.toString()}) must be >= 0 (Master decision 4).`,
    );
  }
  if (discountAmt.compare(subtotal) > 0) {
    throw new InvalidDiscountError(
      `discountAmt (${discountAmt.toString()}) must be <= subtotal (${subtotal.toString()}) ` +
        '(Master decision 4).',
    );
  }
}

/** pg-reviewer fix round 2, finding 2: the minimal shape `assertAccountQualified` needs — deliberately
 *  NOT the application layer's own `AccountRow` (ports.ts), since domain/ never imports from
 *  application/. A caller passes its own `AccountRow` straight through (structurally compatible —
 *  the extra `id` field is simply ignored). */
export interface AccountQualificationInput {
  readonly status: string;
  readonly crNumber: string | null;
}

const ACCOUNT_STATUS_CLOSED = 'closed';

/** INV-C2-1 (Master decisions 2/6), called by CreateQuote, SubmitForReview (re-check), and
 *  ReviseQuote (re-check — pg-reviewer fix round 1, finding 6): `account` is `null` when no
 *  `sales.accounts` row is visible (missing, or RLS hides it) -> AccountNotFoundError, never
 *  leaked as AccountNotQualifiedError. Otherwise the account must have `status !== 'closed'` and
 *  `crNumber !== null` -> else AccountNotQualifiedError. The caller does the I/O (`repo.
 *  getAccountById`) and passes the (possibly null) row in — this function is pure. */
export function assertAccountQualified(account: AccountQualificationInput | null): void {
  if (!account) {
    throw new AccountNotFoundError('no sales.accounts row visible (Allowed: an existing, visible account).');
  }
  if (account.status === ACCOUNT_STATUS_CLOSED || account.crNumber === null) {
    throw new AccountNotQualifiedError(
      `sales.accounts fails INV-C2-1: status must not be 'closed' (is "${account.status}") and ` +
        `cr_number must be set (is ${JSON.stringify(account.crNumber)}).`,
    );
  }
}

/** `clockNow.toISOString().slice(0, 10)` — an ISO date string ('YYYY-MM-DD') derived from the
 *  injected Clock's own `now()` Date instance, never `new Date()` (CLAUDE.md · AGENT
 *  CONSTRAINTS). Used by every check below that compares against "today" as a plain date. */
const ISO_DATE_LENGTH = 10; // 'YYYY-MM-DD'.length
export function todayIso(clockNow: Date): string {
  return clockNow.toISOString().slice(0, ISO_DATE_LENGTH);
}

export interface PriceExceptionCandidate {
  readonly clientId: string;
  readonly serviceId: string;
  readonly validFrom: string;
  readonly validTo: string;
  /** pg-reviewer fix round 1, finding 9: the price the GM actually approved — quoting further
   *  below it (without a NEW exception) defeats the point of the approval. */
  readonly approvedPrice: string;
}

export interface PriceExceptionCheckInput {
  readonly unitPrice: Quantity;
  readonly minPrice: Quantity | null;
  readonly exception: PriceExceptionCandidate | null;
  readonly accountId: string;
  readonly serviceId: string;
  /** ISO date string ('YYYY-MM-DD') — the injected Clock's own "today", never `new Date()`. */
  readonly today: string;
}

/** Master decision 3 (mirrors the DB's own `below_min_needs_exception` CHECK, but checked in the
 *  domain BEFORE the write): a `minPrice` of `null` means the floor cannot be evaluated — no
 *  exception is required (the generated `below_min` column would compare against `coalesce(...,
 *  0)`, which a positive unitPrice always satisfies). Otherwise, if `unitPrice < minPrice`, an
 *  exception is REQUIRED: it must exist, match `(client_id=accountId, service_id=serviceId)`, and
 *  be valid at `today` (`validFrom <= today <= validTo`) — else InvalidPriceExceptionError. */
export function assertPriceExceptionValid(input: PriceExceptionCheckInput): void {
  if (input.minPrice === null || input.unitPrice.compare(input.minPrice) >= 0) return;

  if (!input.exception) {
    throw new InvalidPriceExceptionError(
      `unitPrice (${input.unitPrice.toString()}) is below min_price_at_quote ` +
        `(${input.minPrice.toString()}) and no exceptionId was cited (Master decision 3).`,
    );
  }
  if (input.exception.clientId !== input.accountId || input.exception.serviceId !== input.serviceId) {
    throw new InvalidPriceExceptionError(
      `the cited price exception does not match (client_id=${input.accountId}, ` +
        `service_id=${input.serviceId}) (Master decision 3).`,
    );
  }
  if (input.today < input.exception.validFrom || input.today > input.exception.validTo) {
    throw new InvalidPriceExceptionError(
      `the cited price exception is not valid on ${input.today} (validFrom ` +
        `${input.exception.validFrom}, validTo ${input.exception.validTo}) (Master decision 3).`,
    );
  }
  // pg-reviewer fix round 1, finding 9: the GM approved a SPECIFIC floor-below price — quoting
  // further below it (without citing a new exception) defeats the point of the approval.
  if (input.unitPrice.compare(Quantity.of(input.exception.approvedPrice)) < 0) {
    throw new InvalidPriceExceptionError(
      `unitPrice (${input.unitPrice.toString()}) is below the cited exception's own ` +
        `approved_price (${input.exception.approvedPrice}) — quoting further below the GM's ` +
        'approval requires a new exception (pg-reviewer fix round 1, finding 9).',
    );
  }
}

/** Master decision 2 (CreateQuote's own input) / pg-reviewer fix round 1, finding 6 (ReviseQuote's
 *  copied-then-re-checked `validUntil`): throws InvalidValidUntilError iff `validUntil < today`.
 *  Compares ISO date strings ('YYYY-MM-DD') lexicographically — valid for that format, no Date
 *  parsing needed. */
export function assertValidUntilNotPast(validUntil: string, today: string): void {
  if (validUntil < today) {
    throw new InvalidValidUntilError(`validUntil (${validUntil}) must be >= today (${today}) (Master decision 2).`);
  }
}

// numeric(6,3): max magnitude 999.999 (3 integer digits + 3 fractional digits).
const ESTIMATED_MARGIN_PCT_MAX_MAGNITUDE = 999.999;

/** pg-reviewer fix round 1, finding 10: `sales.quotes.estimated_margin_pct` is `numeric(6,3)` —
 *  throws MarginOutOfRangeError (never a raw Postgres numeric-overflow) iff `estimatedMarginPct`'s
 *  magnitude would overflow that column. `null` (an empty/zero-subtotal quote) always passes. */
export function assertMarginInRange(estimatedMarginPct: number | null): void {
  if (estimatedMarginPct === null) return;
  if (Math.abs(estimatedMarginPct) > ESTIMATED_MARGIN_PCT_MAX_MAGNITUDE) {
    throw new MarginOutOfRangeError(
      `estimatedMarginPct (${estimatedMarginPct}) exceeds numeric(6,3) (max magnitude ` +
        `${ESTIMATED_MARGIN_PCT_MAX_MAGNITUDE}) (pg-reviewer fix round 1, finding 10).`,
    );
  }
}
