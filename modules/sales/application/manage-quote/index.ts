// modules/sales/application/manage-quote/index.ts — WBS 1.6, M02 sales.
//
// Barrel for the manage-quote use case's nine commands (application/ layer public surface).

export type {
  AccountRow,
  AuditTarget,
  ClockDeps,
  InsertLineParams,
  InsertQuoteParams,
  Logger,
  LogFields,
  ManageQuoteDeps,
  PriceExceptionRow,
  QuoteLineRow,
  QuoteRepository,
  QuoteRow,
  QuoteUpdateColumns,
  ServiceRow,
  WriteAuditRowParams,
} from './ports.js';
export { createQuote, type CreateQuoteInput, type CreateQuoteResult } from './create-quote.js';
export { upsertQuoteLine, type UpsertQuoteLineInput, type UpsertQuoteLineResult } from './upsert-quote-line.js';
export { submitForReview, type SubmitForReviewInput, type SubmitForReviewResult } from './submit-for-review.js';
export { approveCommercial, type ApproveCommercialInput, type ApproveCommercialResult } from './approve-commercial.js';
export { approveFinance, type ApproveFinanceInput, type ApproveFinanceResult } from './approve-finance.js';
export { returnToDraft, type ReturnToDraftInput, type ReturnToDraftResult } from './return-to-draft.js';
export { sendQuote, type SendQuoteInput, type SendQuoteResult } from './send-quote.js';
export { recordDecision, type RecordDecisionInput, type RecordDecisionResult } from './record-decision.js';
export { reviseQuote, type ReviseQuoteInput, type ReviseQuoteResult } from './revise-quote.js';
