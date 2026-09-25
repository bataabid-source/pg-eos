// modules/sales/domain/manage-contract/invariants.ts — WBS 1.7, M02 sales.
//
// domain/ layer: pure invariant checks — no I/O, no Date, no Math.random(). The application layer
// (../../application/manage-contract/*) calls these BEFORE any DB write; a failed invariant throws
// a typed error from ./errors.ts.

import {
  AccountNotFoundError,
  AccountNotQualifiedError,
  ContractExpiredByDateError,
  ContractNotActiveError,
  ContractNotYetExpirableError,
  IllegalTransitionError,
  InvalidEndDateError,
  InvalidStartDateError,
  PriceListNotApplicableError,
} from './errors.js';
import {
  CONTRACT_TAG_PRICE_LIST_ASSIGNABLE,
  CONTRACT_TAG_SLA_ASSIGNABLE,
  CONTRACT_TAG_USABLE_FOR_ORDER,
  hasContractTag,
  type ContractStatus,
} from './machine.js';

/** pg-reviewer fix round 2 (manage-quote), finding 2: the minimal shape `assertAccountQualified`
 *  needs — deliberately NOT the application layer's own `AccountRow` (ports.ts), since domain/
 *  never imports from application/. A caller passes its own `AccountRow` straight through
 *  (structurally compatible). */
export interface AccountQualificationInput {
  readonly status: string;
  readonly crNumber: string | null;
}

const ACCOUNT_STATUS_CLOSED = 'closed';

/** Reuses manage-quote's own INV-C2-1-style check for consistency (slice brief Master decision 2:
 *  "a contract for an unqualified account is nonsensical by the same logic"): `account` is `null`
 *  when no `sales.accounts` row is visible (missing, or RLS hides it) -> AccountNotFoundError,
 *  never leaked as AccountNotQualifiedError. Otherwise the account must have `status !== 'closed'`
 *  and `crNumber !== null` -> else AccountNotQualifiedError. */
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
 *  CONSTRAINTS). */
const ISO_DATE_LENGTH = 10; // 'YYYY-MM-DD'.length
export function todayIso(clockNow: Date): string {
  return clockNow.toISOString().slice(0, ISO_DATE_LENGTH);
}

/** Master decision 2: `startDate` must be `>= today`. Compares ISO date strings ('YYYY-MM-DD')
 *  lexicographically — valid for that format, no Date parsing needed. */
export function assertValidStartDate(startDate: string, today: string): void {
  if (startDate < today) {
    throw new InvalidStartDateError(`startDate (${startDate}) must be >= today (${today}) (Master decision 2).`);
  }
}

/** Master decision 2: `endDate`, when set, must be `>= startDate`. */
export function assertValidEndDate(endDate: string | null, startDate: string): void {
  if (endDate !== null && endDate < startDate) {
    throw new InvalidEndDateError(
      `endDate (${endDate}) must be >= startDate (${startDate}) (Master decision 2).`,
    );
  }
}

/** Master decision 10: throws ContractNotActiveError{status} unless `status` carries
 *  CONTRACT_TAG_USABLE_FOR_ORDER (only `active` does) — the machine decides via its own tag,
 *  never an if/switch on the status string (CLAUDE.md · AGENT CONSTRAINTS). */
export function assertContractUsableForOrder(status: ContractStatus): void {
  if (!hasContractTag(status, CONTRACT_TAG_USABLE_FOR_ORDER)) {
    throw new ContractNotActiveError(
      `sales.contracts: status "${status}" is not usable for an order — only "active" carries the ` +
        `"${CONTRACT_TAG_USABLE_FOR_ORDER}" tag (Master decision 10).`,
      status,
    );
  }
}

/** Master decision 4 ("legal from draft/signed/active/suspended — i.e. any non-terminal
 *  status"): throws IllegalTransitionError iff `status` does not carry
 *  CONTRACT_TAG_PRICE_LIST_ASSIGNABLE (the machine decides via its own tag, never an if/switch on
 *  the status string). */
export function assertPriceListAssignable(status: ContractStatus): void {
  if (!hasContractTag(status, CONTRACT_TAG_PRICE_LIST_ASSIGNABLE)) {
    throw new IllegalTransitionError(
      `SetContractPriceList is not legal from status "${status}" — it requires the ` +
        `"${CONTRACT_TAG_PRICE_LIST_ASSIGNABLE}" tag (Master decision 4: any non-terminal status).`,
    );
  }
}

/** Master decision 8: ExpireContract requires `endDate` non-null and `endDate < asOfDate`. */
export function assertContractExpirable(endDate: string | null, asOfDate: string): void {
  if (endDate === null || !(endDate < asOfDate)) {
    throw new ContractNotYetExpirableError(
      `sales.contracts: end_date (${JSON.stringify(endDate)}) must be non-null and strictly before ` +
        `asOfDate (${asOfDate}) to expire (Master decision 8).`,
    );
  }
}

/** pg-reviewer fix round 1, finding 2: an `active` contract whose own `end_date` has already
 *  passed `asOfDate` is functionally expired even though nobody has called ExpireContract yet —
 *  the acceptance criterion itself ("order on expired contract rejected") is broken if it is still
 *  returned as usable. Distinct from ContractNotActiveError (which is about the status enum,
 *  independent of any date): thrown ONLY after the status/tag check already passed. */
export function assertContractNotExpiredByDate(contractId: string, endDate: string | null, asOfDate: string): void {
  if (endDate !== null && endDate < asOfDate) {
    throw new ContractExpiredByDateError(
      `sales.contracts ${contractId}: end_date (${endDate}) has already passed asOfDate (${asOfDate}) — ` +
        'functionally expired even though its status has not been transitioned yet.',
      contractId,
      endDate,
    );
  }
}

/** pg-reviewer fix round 1, finding 1: Master decision 9's own "not terminated" business check —
 *  throws IllegalTransitionError iff `status` does not carry CONTRACT_TAG_SLA_ASSIGNABLE (every
 *  status except `terminated`) — the machine decides via its own tag, never an if/switch
 *  comparing the status string to 'terminated' (the exact mistake WBS 1.6's review caught in
 *  return-to-draft.ts). */
export function assertSlaAssignable(status: ContractStatus): void {
  if (!hasContractTag(status, CONTRACT_TAG_SLA_ASSIGNABLE)) {
    throw new IllegalTransitionError(
      `AddContractSla is not legal on a contract with status "${status}" — it requires the ` +
        `"${CONTRACT_TAG_SLA_ASSIGNABLE}" tag (Master decision 9: not terminated).`,
    );
  }
}

/** pg-reviewer fix round 1, finding 3: the minimal shape SetContractPriceList's own scoping check
 *  needs — a `catalog.price_lists` row is applicable to a contract only when: not an internal
 *  (transfer-pricing) list, its own segment is either unset or the account's own segment, its own
 *  client is either unset or the contract's own account, and its own status is 'active' (a
 *  draft/expired list is never a valid annex). */
export interface PriceListCandidate {
  readonly entityId: string;
  readonly clientId: string | null;
  readonly segmentId: string | null;
  readonly isInternal: boolean;
  readonly status: string;
}

const PRICE_LIST_STATUS_ACTIVE = 'active';

export function assertPriceListApplicable(
  priceList: PriceListCandidate | null,
  params: { readonly entityId: string; readonly accountId: string; readonly accountSegmentId: string | null },
): void {
  const applicable =
    priceList !== null &&
    priceList.entityId === params.entityId &&
    !priceList.isInternal &&
    priceList.status === PRICE_LIST_STATUS_ACTIVE &&
    (priceList.clientId === null || priceList.clientId === params.accountId) &&
    (priceList.segmentId === null || priceList.segmentId === params.accountSegmentId);

  if (!applicable) {
    throw new PriceListNotApplicableError(
      'catalog.price_lists is not applicable to this contract — it must share the contract\'s ' +
        "entity_id, not be an internal (transfer-pricing) list, have status 'active', and its own " +
        'client_id/segment_id must be null or equal to the contract\'s account/segment.',
    );
  }
}
