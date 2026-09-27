// packages/contracts/billing/post-journal.ts — WBS 4.20 (lane 2), contract-first wave 1 (Master,
// ADR-0005 §3).
//
// Derived from `billing.journal_entries` / `billing.journal_lines` (01-Data-Model.sql:1189-1213)
// and SCR-ACC-01 #4-#8: entry_date and description (01:1193-1194), the period link (#4), the entry
// type (#5), account_id/debit/credit/description per line (01:1205-1211). The fixed
// client_id/contract_id/cost_center line columns (01:1208-1210) are not carried: ADR-0004 D1 6 makes
// every axis other than entity_id dimension data, so a line's axes travel as `dimensions`
// (SCR-ACC-01 #9, billing.line_dimensions).
//
// Not carried, because no brief or schema line fixes how a caller supplies them: doc_no (01:1192,
// numbering source undefined), source_table/source_id (automatic journals arrive through the outbox
// subscriber, D1 2 / WBS 4.11), is_intercompany (WBS 4.12a), the #5 approval columns (the approval
// edge is fixed at the pre-migration review), and any link from an adjustment to the entry it
// corrects (no column names one).
//
// Balance (sum debit = sum credit) is NOT checked here: it is enforced at COMMIT by the deferred
// constraint trigger (#6) and by the domain, never with float arithmetic on numeric(14,3) strings.

import { z } from 'zod';

import { IdempotencyKeyHeader } from '../_shared/headers.js';
import type { RouteDefinitionInput } from '../_shared/registry.js';
import { OK_RESPONSE, writeErrorResponses } from '../_shared/route-responses.js';
import { LineDimensionInputSchema } from './dimensions.js';

const UUID_ID = z.string().uuid();
const DATE = z.iso.date();
const NON_EMPTY_TEXT = z.string().trim().min(1);
// journal_entries.version — the stale-version scenario of the brief; starts at 1 like every other
// mutable aggregate.
const MIN_VERSION = 1;
const EXPECTED_VERSION = z.number().int().min(MIN_VERSION);

// numeric(14,3) (01:1206-1207) as a decimal string, same representation as every other money field
// in this package: 1-11 integer digits, optional '.' + 1-3 fractional digits, non-negative.
const AMOUNT = z.string().regex(/^\d{1,11}(?:\.\d{1,3})?$/);
// Strictly positive: the same shape with every all-zero value excluded (no Number() on the string).
const POSITIVE_AMOUNT_PATTERN = /^(?!0+(?:\.0+)?$)\d{1,11}(?:\.\d{1,3})?$/;

// A0 §1 row 4, verbatim (brief 4.20).
export const JOURNAL_ENTRY_TYPES = [
  'manual',
  'recurring',
  'reversing',
  'adjustment',
  'accrual',
  'prepayment',
  'closing',
] as const;
const ENTRY_TYPE = z.enum(JOURNAL_ENTRY_TYPES);
// ADR-0004 D1 4: corrections only through ReverseJournal / AdjustJournal (they set reversed_by,
// 01:1198, and carry the audit row) — PostJournal never takes those two types.
const POSTABLE_ENTRY_TYPE = ENTRY_TYPE.exclude(['reversing', 'adjustment']);

// 01:1212 one_side_only — debit > 0 and credit = 0, or credit > 0 and debit = 0. An omitted side
// is the column default 0.
function isOneSideOnly(line: { debit?: string | undefined; credit?: string | undefined }): boolean {
  const debitPositive = line.debit !== undefined && POSITIVE_AMOUNT_PATTERN.test(line.debit);
  const creditPositive = line.credit !== undefined && POSITIVE_AMOUNT_PATTERN.test(line.credit);
  return debitPositive !== creditPositive;
}

export const JournalLineInputSchema = z
  .object({
    accountId: UUID_ID,
    debit: AMOUNT.optional(),
    credit: AMOUNT.optional(),
    description: NON_EMPTY_TEXT.optional(),
    dimensions: z.array(LineDimensionInputSchema).optional(),
  })
  .refine(isOneSideOnly, {
    message: 'exactly one of debit or credit must be greater than zero (one_side_only)',
    path: ['debit'],
  })
  .meta({ id: 'JournalLineInput' });

export type JournalLineInput = z.infer<typeof JournalLineInputSchema>;

// One-side-only lines can balance only with at least one debit line and one credit line.
const MIN_LINES = 2;
const LINES = z.array(JournalLineInputSchema).min(MIN_LINES);

export const PostJournalInputSchema = z
  .object({
    entityId: UUID_ID,
    periodId: UUID_ID,
    entryDate: DATE,
    entryType: POSTABLE_ENTRY_TYPE,
    description: NON_EMPTY_TEXT,
    lines: LINES,
    correlationId: UUID_ID,
  })
  .meta({ id: 'PostJournalInput' });

export type PostJournalInput = z.infer<typeof PostJournalInputSchema>;

// The reversing entry's lines mirror the original's, so none are supplied; `reversed_by`
// (01:1198) is set on the original, hence its expectedVersion.
export const ReverseJournalInputSchema = z
  .object({
    entryId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    periodId: UUID_ID,
    entryDate: DATE,
    description: NON_EMPTY_TEXT,
    correlationId: UUID_ID,
  })
  .meta({ id: 'ReverseJournalInput' });

export type ReverseJournalInput = z.infer<typeof ReverseJournalInputSchema>;

// An adjustment is a new posted entry of type 'adjustment' (D1 4: corrections by new entries, never
// an edit), so it carries its own lines.
export const AdjustJournalInputSchema = z
  .object({
    entityId: UUID_ID,
    periodId: UUID_ID,
    entryDate: DATE,
    description: NON_EMPTY_TEXT,
    lines: LINES,
    correlationId: UUID_ID,
  })
  .meta({ id: 'AdjustJournalInput' });

export type AdjustJournalInput = z.infer<typeof AdjustJournalInputSchema>;

// --- OpenAPI route registrations (contract-first, ADR-0005 §3) ----------------------------------
// No result schema is defined by the brief — every 200 carries no body.
const WRITE_HEADERS = z.object({ 'Idempotency-Key': IdempotencyKeyHeader });

export const ROUTES: readonly RouteDefinitionInput[] = [
  {
    method: 'POST',
    path: '/billing/post-journal/post-journal',
    summary: 'Post journal entry',
    contractFirst: true,
    request: { headers: WRITE_HEADERS, body: PostJournalInputSchema },
    responses: { 200: OK_RESPONSE, ...writeErrorResponses() },
  },
  {
    method: 'POST',
    path: '/billing/post-journal/reverse-journal',
    summary: 'Reverse posted journal entry',
    contractFirst: true,
    request: { headers: WRITE_HEADERS, body: ReverseJournalInputSchema },
    responses: { 200: OK_RESPONSE, ...writeErrorResponses() },
  },
  {
    method: 'POST',
    path: '/billing/post-journal/adjust-journal',
    summary: 'Post adjustment journal entry',
    contractFirst: true,
    request: { headers: WRITE_HEADERS, body: AdjustJournalInputSchema },
    responses: { 200: OK_RESPONSE, ...writeErrorResponses() },
  },
];
