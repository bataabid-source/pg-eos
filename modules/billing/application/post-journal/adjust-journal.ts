// modules/billing/application/post-journal/adjust-journal.ts — WBS 4.20 (lane 2).
//
// application/ layer: AdjustJournal — a correction is a NEW posted entry of type 'adjustment'
// (ADR-0004 D1 4: "corrections only by reversal/adjustment with an audit row"), never an edit. No
// edge on any original entry (no column links an adjustment to the entry it corrects — contract
// header). Same transaction shape as ./post-journal.ts; outbox event billing.journal_entry.adjusted.

import type { IdempotencyInput, WithContextCtx } from '@pg-eos/db';
import type { CatalogedEventType } from '@pg-eos/events';

import { postNewEntry, type PostJournalResult } from './post-journal.js';
import type { JournalLine, PostJournalDeps } from './ports.js';

const ADJUSTMENT_ENTRY_TYPE = 'adjustment';
const ADJUSTED_EVENT_TYPE: CatalogedEventType = 'billing.journal_entry.adjusted';
const AUDIT_OPERATION_ADJUST = 'adjust';

export interface AdjustJournalInput {
  readonly entityId: string;
  readonly periodId: string;
  readonly entryDate: string;
  readonly description: string;
  readonly lines: readonly JournalLine[];
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export type AdjustJournalResult = PostJournalResult;

export async function adjustJournal(
  ctx: WithContextCtx,
  input: AdjustJournalInput,
  deps: PostJournalDeps,
): Promise<AdjustJournalResult> {
  return postNewEntry(ctx, { ...input, entryType: ADJUSTMENT_ENTRY_TYPE }, deps, {
    command: 'AdjustJournal',
    eventType: ADJUSTED_EVENT_TYPE,
    auditOperation: AUDIT_OPERATION_ADJUST,
  });
}
