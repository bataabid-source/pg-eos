// packages/contracts/billing/chart-of-accounts.ts — WBS 4.1a (lane 2).
//
// Zod schema derived from `billing.gl_accounts` (01-Data-Model.sql:1177-1187) plus SCR-ACC-01
// #1-2 — no field that is not a column. This slice has no lifecycle, no application command and
// no api layer (brief: "An account has no lifecycle in 01") — `GlAccountInputSchema` describes the
// shape of a `billing.gl_accounts` row; there is no HTTP endpoint this slice wires it to.
//
// `code` is validated at the contract boundary to the same X-XX-XXX-XXX shape the domain layer
// (modules/billing/domain/chart-of-accounts/invariants.ts's `isValidAccountCode`) and the
// database's own CHECK constraint (migration 0028_2_chart-of-accounts.sql) enforce — three
// independent layers agreeing on one regex, never diverging (SCR-ACC-01 #1).
// `accountType` mirrors `ALLOWED_ACCOUNT_TYPES` — kept as a literal tuple here (contracts/ never
// imports modules/) rather than importing the domain module, same discipline as every other
// contract file in this package.

import { z } from 'zod';

const UUID_ID = z.string().uuid();

// SCR-ACC-01 #1 — X-XX-XXX-XXX, first segment (class) a single digit 1-9.
const ACCOUNT_CODE = z.string().regex(/^[1-9]-\d{2}-\d{3}-\d{3}$/);

// SCR-ACC-01 #2 — the existing five values (01:1183) plus the four new values named verbatim by
// SCR-ACC-01 #2 ("Cost of Revenue, Other Income/Expense, Tax, Control/Memorandum"). Spelling fixed
// at the pre-migration pg-reviewer review — see modules/billing/domain/chart-of-accounts/
// invariants.ts's own `ALLOWED_ACCOUNT_TYPES` comment.
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

export const GlAccountInputSchema = z
  .object({
    entityId: UUID_ID,
    code: ACCOUNT_CODE,
    nameAr: z.string().min(1),
    nameEn: z.string().min(1).optional(),
    accountType: ACCOUNT_TYPE,
    parentId: UUID_ID.optional(),
    isPostable: z.boolean().optional(),
  })
  .meta({ id: 'GlAccountInput' });

export type GlAccountInput = z.infer<typeof GlAccountInputSchema>;
