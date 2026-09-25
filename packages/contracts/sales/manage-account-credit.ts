// packages/contracts/sales/manage-account-credit.ts — WBS 1.8, M02 sales.
//
// Zod input schemas for the manage-account-credit use case's three write commands (slice brief
// docs/notes/slice-briefs/_slice-1.8.brief.md, "Contract" section). `sales.accounts` has no
// `entity_id` column at all (Scope: "genuinely group-level, not entity-scoped") — no schema below
// takes one. `getAccountCreditStatus`'s input (`{ accountId }` only) is not a Zod contract — it is
// a pure read with no Idempotency-Key, validated by TypeScript alone (same as 1.7's
// GetContractForOrderInput). `creditLimit` is a numeric(14,3) string, non-negative (zero legal —
// Master decision 5, S7 trial-client case) — parsed via `@pg-eos/domain-kit`'s `Money`, never
// `Number()`/`parseFloat()`. `reason` (SetCreditHold/ReleaseCreditHold) is a required, non-empty
// string. Every command carries `expectedVersion` (optimistic lock) and `correlationId`. `idem` is
// NOT part of these schemas — the api layer (../../modules/sales/api/manage-account-credit/
// handlers.ts) adds it after parsing (golden pattern, reused from manage-contract/manage-quote).
//
// TEMPLATE GUIDANCE: one contract file per use case, one exported `<Command>InputSchema` per
// command.

import { z } from 'zod';

const UUID_ID = z.string().uuid();
// sales.accounts.version starts at 1 (migration 0020: int not null default 1).
const MIN_VERSION = 1;
const EXPECTED_VERSION = z.number().int().min(MIN_VERSION);
// numeric(14,3): 1-11 integer digits, optional '.' + 1-3 fractional digits — non-negative (zero
// legal, Master decision 5); a leading '-' fails this regex, so a negative creditLimit is rejected
// at the contract boundary (400), never reaching the application layer.
const NON_NEGATIVE_QUANTITY = z.string().regex(/^\d{1,11}(?:\.\d{1,3})?$/);
// pg-reviewer fix round 1, finding 3: `.trim()` first — an all-whitespace string like "   " must
// not be accepted as a legal reason.
const NON_EMPTY_REASON = z.string().trim().min(1);

export const SetCreditLimitInputSchema = z
  .object({
    accountId: UUID_ID,
    creditLimit: NON_NEGATIVE_QUANTITY,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'SetCreditLimitInput' });

export type SetCreditLimitInput = z.infer<typeof SetCreditLimitInputSchema>;

export const SetCreditHoldInputSchema = z
  .object({
    accountId: UUID_ID,
    reason: NON_EMPTY_REASON,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'SetCreditHoldInput' });

export type SetCreditHoldInput = z.infer<typeof SetCreditHoldInputSchema>;

export const ReleaseCreditHoldInputSchema = z
  .object({
    accountId: UUID_ID,
    reason: NON_EMPTY_REASON,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'ReleaseCreditHoldInput' });

export type ReleaseCreditHoldInput = z.infer<typeof ReleaseCreditHoldInputSchema>;
