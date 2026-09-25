// modules/sales — package shell created by WBS 1.5 (proof slice, ADR-0001).
// Proof slice: data model + seed only (fixtures created/removed by the proof suite), no UI, no
// workflow, no public API — docs/adr/ADR-0001-1.5-proof-slice.md.
//
// WBS 1.4 is a mechanism slice (precedent WBS 2.8): a read-only pricing-resolution engine with no
// API endpoint and no state machine (slice brief docs/notes/slice-briefs/_slice-1.4.brief.md,
// "Scope taken by the lane"). Re-exported here — the module's public barrel — per the brief's
// Deliver list.
export * from './application/resolve-price/index.js';
export * from './domain/resolve-price/errors.js';
export * from './domain/resolve-price/tiered-pricing.js';

// WBS 1.6 — manage-quote (quotes with approval flow). Re-exported here — the module's public
// barrel — per the slice brief's Deliver list. Named (not `export *`) because resolve-price's own
// barrel above already claims AccountRow/ServiceRow/PriceExceptionRow/AccountNotFoundError/
// ServiceNotFoundError — a bare `export *` would collide; manage-quote's own errors/ports are
// imported directly from their own use-case path (as every test in this slice already does), not
// through this top-level barrel.
export {
  createQuote,
  upsertQuoteLine,
  submitForReview,
  approveCommercial,
  approveFinance,
  returnToDraft,
  sendQuote,
  recordDecision,
  reviseQuote,
  type CreateQuoteInput,
  type CreateQuoteResult,
  type UpsertQuoteLineInput,
  type UpsertQuoteLineResult,
  type SubmitForReviewInput,
  type SubmitForReviewResult,
  type ApproveCommercialInput,
  type ApproveCommercialResult,
  type ApproveFinanceInput,
  type ApproveFinanceResult,
  type ReturnToDraftInput,
  type ReturnToDraftResult,
  type SendQuoteInput,
  type SendQuoteResult,
  type RecordDecisionInput,
  type RecordDecisionResult,
  type ReviseQuoteInput,
  type ReviseQuoteResult,
} from './application/manage-quote/index.js';
export {
  QUOTE_STATUS,
  QUOTE_EVENTS,
  QUOTE_TAG_EDITABLE,
  QUOTE_TAG_FROZEN,
  QUOTE_TAG_REVISABLE,
  quoteMachine,
  canTransition as canTransitionQuote,
  advanceQuote,
  type QuoteStatus,
  type QuoteEventType,
} from './domain/manage-quote/machine.js';
export { computeEstimatedMarginPct, type MarginLine } from './domain/manage-quote/margin.js';
