// modules/billing/application/post-journal/index.ts — WBS 4.20 (lane 2).
//
// Barrel for the post-journal use case's three commands (application/ layer public surface), one
// per FROZEN contract route (packages/contracts/billing/post-journal.ts).

export type {
  AuditRowInput,
  ClockDeps,
  JournalEntryRow,
  JournalLedgerPort,
  JournalLine,
  JournalRepository,
  Logger,
  LogFields,
  PeriodRow,
  PostJournalDeps,
} from './ports.js';
export { postJournal, type PostJournalInput, type PostJournalResult } from './post-journal.js';
export { reverseJournal, type ReverseJournalInput, type ReverseJournalResult } from './reverse-journal.js';
export { adjustJournal, type AdjustJournalInput, type AdjustJournalResult } from './adjust-journal.js';
