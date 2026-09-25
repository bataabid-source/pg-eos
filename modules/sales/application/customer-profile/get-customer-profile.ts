// modules/sales/application/customer-profile/get-customer-profile.ts — WBS 1.9, M02 sales.
//
// Read-only application query — Master decision 1: read-only, no lock, no version, no
// Idempotency-Key, no `entityId` parameter at all (Scope: "genuinely group-level", same
// construction as 1.8's getAccountCreditStatus — a customer's contracts span every entity). Runs a
// single withContext(ctx, fn) (never withIdempotentContext — there is no Idempotency-Key on a pure
// read, same as 1.7's getContractForOrder / 1.8's getAccountCreditStatus). Throws
// AccountNotFoundError when no `sales.accounts` row is visible (missing, or RLS
// client_portal_scope hides it — never leaked as a distinct error, Master decision 6).
//
// Readiness rules (Master decision 2, the literal predicate each item implements — the repository
// itself does the `is not null`/`> 0` comparisons in SQL — `getAccountById`'s own `credit_limit >
// 0` compare — this function only assembles the five items from what the repository already
// computed; pg-reviewer fix round 1, finding 1/2: a JS-side string-shape check on the numeric(14,3)
// text cannot distinguish a negative value from a positive one, so the `> 0` compare must happen in
// SQL, never here):
//   cr_number       -> account.crNumber !== null
//   credit_limit    -> account.creditLimit !== null AND account.creditLimitPositive (D03's own
//                      `> 0` — a legal `0` for a trial client, S7, still counts as an outstanding
//                      gap here; a negative value, though not reachable via any CHECK constraint
//                      today, is correctly NOT "present" either)
//   segment         -> account.segmentId !== null
//   payment_terms   -> account.paymentTermsDays !== null
//   priced_contract -> at least one contract (any entity, any status) has a price_list_id
// Every item's owner is 'CFO' (Master decision 2).

import { withContext, type WithContextCtx } from '@pg-eos/db';

import { AccountNotFoundError } from '../../domain/customer-profile/errors.js';
import type { CustomerProfileDeps } from './ports.js';

export interface GetCustomerProfileInput {
  readonly accountId: string;
}

export interface CustomerProfileIdentity {
  readonly accountId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly segmentCode: string | null;
  readonly segmentNameAr: string | null;
  readonly ownerUserId: string | null;
  readonly ownerNameAr: string | null;
}

export interface CustomerProfileContract {
  readonly contractId: string;
  readonly entityCode: string;
  readonly status: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly hasPriceList: boolean;
}

export type ReadinessItemName = 'cr_number' | 'credit_limit' | 'segment' | 'payment_terms' | 'priced_contract';

export interface CustomerProfileReadinessItem {
  readonly item: ReadinessItemName;
  readonly present: boolean;
  readonly owner: 'CFO';
}

export interface CustomerProfileFinance {
  readonly creditLimit: string | null;
  readonly creditHold: boolean;
  readonly holdReason: string | null;
}

export interface CustomerProfileResult {
  readonly identity: CustomerProfileIdentity;
  readonly contracts: readonly CustomerProfileContract[];
  readonly readiness: readonly CustomerProfileReadinessItem[];
  readonly finance: CustomerProfileFinance;
  readonly profitability: { readonly available: false };
}

const CFO_OWNER = 'CFO' as const;

export async function getCustomerProfile(
  ctx: WithContextCtx,
  input: GetCustomerProfileInput,
  deps: CustomerProfileDeps,
): Promise<CustomerProfileResult> {
  return withContext<CustomerProfileResult>(ctx, async (tx) => {
    const account = await deps.repo.getAccountById(tx, input.accountId);
    if (!account) {
      throw new AccountNotFoundError(
        `no sales.accounts row visible for id ${input.accountId} (Allowed: an existing, visible account).`,
      );
    }

    const contractRows = await deps.repo.getContractsForAccount(tx, account.id);
    const hasPricedContract = contractRows.some((row) => row.hasPriceList);

    const readiness: readonly CustomerProfileReadinessItem[] = [
      { item: 'cr_number', present: account.crNumber !== null, owner: CFO_OWNER },
      {
        item: 'credit_limit',
        present: account.creditLimit !== null && account.creditLimitPositive,
        owner: CFO_OWNER,
      },
      { item: 'segment', present: account.segmentId !== null, owner: CFO_OWNER },
      { item: 'payment_terms', present: account.paymentTermsDays !== null, owner: CFO_OWNER },
      { item: 'priced_contract', present: hasPricedContract, owner: CFO_OWNER },
    ];

    return {
      identity: {
        accountId: account.id,
        code: account.code,
        nameAr: account.nameAr,
        nameEn: account.nameEn,
        segmentCode: account.segmentCode,
        segmentNameAr: account.segmentNameAr,
        ownerUserId: account.ownerUserId,
        ownerNameAr: account.ownerNameAr,
      },
      contracts: contractRows.map((row) => ({
        contractId: row.contractId,
        entityCode: row.entityCode,
        status: row.status,
        startDate: row.startDate,
        endDate: row.endDate,
        hasPriceList: row.hasPriceList,
      })),
      readiness,
      finance: {
        creditLimit: account.creditLimit,
        creditHold: account.creditHold,
        holdReason: account.holdReason,
      },
      profitability: { available: false },
    };
  });
}
