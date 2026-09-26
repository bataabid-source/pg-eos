// packages/contracts/billing/gl-account-change-requests.ts — WBS 4.1a part 2.
//
// Zod schema for the SUBMIT input shape of billing.gl_account_change_requests
// (docs/notes/slice-briefs/_slice-4.1a-part2.brief.md "Schema design") — no field beyond the
// migration's own columns. No Approve/Reject/Cancel action contracts this round: this slice ships
// domain + migration only (no application command exists yet — see the brief's own part 2a/2b
// split note); a future part builds those alongside the application layer.
//
// `proposedCode`/`proposedAccountType` mirror the same shared rules as
// packages/contracts/billing/chart-of-accounts.ts's own `GlAccountInputSchema` (contracts/ never
// imports modules/, so the regex/list is a literal here too, same discipline as that file) — kept
// optional because they only apply to `create`/`update` change kinds, per the DB's own nullable
// proposed_* columns.

import { z } from 'zod';

const UUID_ID = z.string().uuid();

// SCR-ACC-01 #1 — X-XX-XXX-XXX, first segment (class) a single digit 1-9. Same shared rule as
// billing.gl_accounts.code (billing.is_valid_gl_account_code at the DB layer).
const ACCOUNT_CODE = z.string().regex(/^[1-9]-\d{2}-\d{3}-\d{3}$/);

// SCR-ACC-01 #2 — same closed list as billing.gl_accounts.account_type
// (billing.is_valid_gl_account_type at the DB layer).
const ACCOUNT_TYPE = z.enum([
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
  'cost_of_revenue',
  'other_income_expense',
  'tax',
  'control_memorandum',
]);

// brief §"Schema design": change_kind in ('create','update') this part — deactivate/reactivate are
// WBS 4.1a part 3.
const CHANGE_KIND = z.enum(['create', 'update']);

export const SubmitGlAccountChangeRequestInputSchema = z
  .object({
    entityId: UUID_ID,
    changeKind: CHANGE_KIND,
    // `targetAccountId` and `proposedParentId` are both nullable columns (pg-reviewer round-1
    // finding 17) — both `.nullable().optional()`, so a caller may either omit the field or send an
    // explicit `null`, exactly as the DB column allows.
    targetAccountId: UUID_ID.nullable().optional(),
    proposedCode: ACCOUNT_CODE.optional(),
    proposedNameAr: z.string().min(1).optional(),
    proposedNameEn: z.string().min(1).optional(),
    proposedAccountType: ACCOUNT_TYPE.optional(),
    proposedParentId: UUID_ID.nullable().optional(),
    proposedIsPostable: z.boolean().optional(),
  })
  .refine(
    (value) =>
      (value.changeKind === 'create' && (value.targetAccountId === null || value.targetAccountId === undefined)) ||
      (value.changeKind === 'update' && value.targetAccountId !== null && value.targetAccountId !== undefined),
    {
      message: "changeKind='create' requires a null targetAccountId; changeKind='update' requires a non-null one",
      path: ['targetAccountId'],
    },
  )
  // pg-reviewer round-1 finding 7 / finding 17(a) — a `create` request must carry every column
  // `billing.gl_accounts` declares NOT NULL, mirroring the domain's own
  // `isCreateRequestComplete`/`assertCreateRequestComplete`
  // (modules/billing/domain/gl-account-change-requests/invariants.ts) and the DB CHECK
  // `chk_glc_requests_create_complete`.
  .refine(
    (value) =>
      value.changeKind !== 'create' ||
      (value.proposedCode !== undefined &&
        value.proposedNameAr !== undefined &&
        value.proposedAccountType !== undefined),
    {
      message: "changeKind='create' requires proposedCode, proposedNameAr and proposedAccountType",
      path: ['proposedCode'],
    },
  )
  // Round-3 fix 4 (migration 0034's chk_glc_requests_update_no_code / invariants.ts's
  // isProposedCodeOnlyForCreate): code is immutable post-creation, so an `update` request must never
  // carry a proposedCode — rejected here at the API boundary too, not just at the DB.
  .refine((value) => value.changeKind !== 'update' || value.proposedCode === undefined, {
    message: "changeKind='update' must not carry a proposedCode (code is immutable post-creation)",
    path: ['proposedCode'],
  })
  .meta({ id: 'SubmitGlAccountChangeRequestInput' });

export type SubmitGlAccountChangeRequestInput = z.infer<typeof SubmitGlAccountChangeRequestInputSchema>;
