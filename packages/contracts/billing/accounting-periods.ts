// packages/contracts/billing/accounting-periods.ts — WBS 4.19 (lane 2), contract-first wave 1
// (Master, ADR-0005 §3).
//
// Derived from SCR-ACC-01 #3 (new `billing.fiscal_years`, new `billing.accounting_periods` —
// "Fiscal year; periods open/closed/locked per entity") and ADR-0004 D1 5 / D3 OD-12. The migration
// is not written yet: SCR-ACC-01 names the two tables but not their columns, so the fields below are
// only what the brief itself requires — `entity_id` (D1 5 "per entity", D1 6 hard column), a date
// range (the brief's "entry dated inside a period" / "covering period"), the period's fiscal year
// and its status. Column names are fixed at the pre-migration review; nothing else is carried.
//
// OpenPeriod creates a period in its initial `open` state; the machine's only edges are close,
// lock and reopen (OD-12). Reopen goes through the Decision Inbox — this command files the request;
// no `decisionId` is carried because the brief does not name one.

import { z } from 'zod';

import { IdempotencyKeyHeader } from '../_shared/headers.js';
import type { RouteDefinitionInput } from '../_shared/registry.js';
import { OK_RESPONSE, writeErrorResponses } from '../_shared/route-responses.js';

const UUID_ID = z.string().uuid();
const DATE = z.iso.date();
// accounting_periods.version — every mutable aggregate starts at 1 (CLAUDE.md ARCHITECTURE).
const MIN_VERSION = 1;
const EXPECTED_VERSION = z.number().int().min(MIN_VERSION);

// ADR-0004 D1 5 — the three states, verbatim.
export const ACCOUNTING_PERIOD_STATUSES = ['open', 'closed', 'locked'] as const;
const PERIOD_STATUS = z.enum(ACCOUNTING_PERIOD_STATUSES);

const DATE_RANGE_MESSAGE = 'startDate must not be after endDate';
// ISO dates (YYYY-MM-DD) order lexicographically, so no Date object is built here.
function isOrderedRange(value: { startDate: string; endDate: string }): boolean {
  return value.startDate <= value.endDate;
}

export const FiscalYearInputSchema = z
  .object({
    entityId: UUID_ID,
    startDate: DATE,
    endDate: DATE,
  })
  .refine(isOrderedRange, { message: DATE_RANGE_MESSAGE, path: ['endDate'] })
  .meta({ id: 'FiscalYearInput' });

export type FiscalYearInput = z.infer<typeof FiscalYearInputSchema>;

// SCR-ACC-01 #3 (`new billing.fiscal_years`): a period needs a fiscal year to belong to, so the
// year is created by its own command; the fiscal-year end per entity stays an OD-12 question.
export const CreateFiscalYearInputSchema = FiscalYearInputSchema.extend({
  correlationId: UUID_ID,
}).meta({ id: 'CreateFiscalYearInput' });

export type CreateFiscalYearInput = z.infer<typeof CreateFiscalYearInputSchema>;

export const AccountingPeriodInputSchema = z
  .object({
    entityId: UUID_ID,
    fiscalYearId: UUID_ID,
    startDate: DATE,
    endDate: DATE,
    status: PERIOD_STATUS,
  })
  .refine(isOrderedRange, { message: DATE_RANGE_MESSAGE, path: ['endDate'] })
  .meta({ id: 'AccountingPeriodInput' });

export type AccountingPeriodInput = z.infer<typeof AccountingPeriodInputSchema>;

export const OpenPeriodInputSchema = z
  .object({
    entityId: UUID_ID,
    fiscalYearId: UUID_ID,
    startDate: DATE,
    endDate: DATE,
    correlationId: UUID_ID,
  })
  .refine(isOrderedRange, { message: DATE_RANGE_MESSAGE, path: ['endDate'] })
  .meta({ id: 'OpenPeriodInput' });

export type OpenPeriodInput = z.infer<typeof OpenPeriodInputSchema>;

const PeriodTransitionShape = {
  periodId: UUID_ID,
  expectedVersion: EXPECTED_VERSION,
  correlationId: UUID_ID,
};

export const ClosePeriodInputSchema = z.object(PeriodTransitionShape).meta({ id: 'ClosePeriodInput' });
export type ClosePeriodInput = z.infer<typeof ClosePeriodInputSchema>;

export const LockPeriodInputSchema = z.object(PeriodTransitionShape).meta({ id: 'LockPeriodInput' });
export type LockPeriodInput = z.infer<typeof LockPeriodInputSchema>;

export const ReopenPeriodInputSchema = z.object(PeriodTransitionShape).meta({ id: 'ReopenPeriodInput' });
export type ReopenPeriodInput = z.infer<typeof ReopenPeriodInputSchema>;

// --- OpenAPI route registrations (contract-first, ADR-0005 §3) ----------------------------------
// No result schema is defined by the brief — every 200 carries no body. Close and lock declare 403:
// both are CFO actions (OD-12; the brief's default names the CFO for lock too).
const WRITE_HEADERS = z.object({ 'Idempotency-Key': IdempotencyKeyHeader });

export const ROUTES: readonly RouteDefinitionInput[] = [
  {
    method: 'POST',
    path: '/billing/accounting-periods/create-fiscal-year',
    summary: 'Create fiscal year',
    contractFirst: true,
    request: { headers: WRITE_HEADERS, body: CreateFiscalYearInputSchema },
    responses: { 200: OK_RESPONSE, ...writeErrorResponses({ forbidden: true }) },
  },
  {
    method: 'POST',
    path: '/billing/accounting-periods/open-period',
    summary: 'Open accounting period',
    contractFirst: true,
    request: { headers: WRITE_HEADERS, body: OpenPeriodInputSchema },
    responses: { 200: OK_RESPONSE, ...writeErrorResponses() },
  },
  {
    method: 'POST',
    path: '/billing/accounting-periods/close-period',
    summary: 'Close accounting period',
    contractFirst: true,
    request: { headers: WRITE_HEADERS, body: ClosePeriodInputSchema },
    responses: { 200: OK_RESPONSE, ...writeErrorResponses({ forbidden: true }) },
  },
  {
    method: 'POST',
    path: '/billing/accounting-periods/lock-period',
    summary: 'Lock accounting period',
    contractFirst: true,
    request: { headers: WRITE_HEADERS, body: LockPeriodInputSchema },
    responses: { 200: OK_RESPONSE, ...writeErrorResponses({ forbidden: true }) },
  },
  {
    method: 'POST',
    path: '/billing/accounting-periods/reopen-period',
    summary: 'Request reopening of an accounting period (Decision Inbox)',
    contractFirst: true,
    request: { headers: WRITE_HEADERS, body: ReopenPeriodInputSchema },
    responses: { 200: OK_RESPONSE, ...writeErrorResponses() },
  },
];
