// modules/billing/application/post-journal/reverse-journal.ts — WBS 4.20 (lane 2).
//
// application/ layer: ReverseJournal — ADR-0004 D1 4 "corrections only by reversal/adjustment with
// an audit row". ONE withIdempotentContext transaction: (0) the idempotency claim, (1) the original
// entry as RLS shows it (another entity's entry -> JournalEntryNotFoundError), then the CFO role
// gate (doc 38 row 4.20 Owner), (2) the reversal period, (3) the journal machine's REVERSE edge with its guards (same entity, not already
// reversed, version matches — never an if on a status string), (4) an open period covering the
// reversal date, (5) a NEW posted 'reversing' entry whose lines mirror the original's (debit and
// credit swapped, same accounts and dimensions), (6) billing.mark_journal_reversed() — the one
// in-place write (reversed_by + version, T6), (7) the outbox row (aggregate = the ORIGINAL entry),
// (8) the audit rows, last.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import { PeriodNotOpenError } from '../../domain/post-journal/errors.js';
import { assertLineAccounts, mirrorLines } from '../../domain/post-journal/invariants.js';
import { JOURNAL_EVENTS, advanceJournalStatus, journalStatusOf } from '../../domain/post-journal/machine.js';
import { assertOpenPeriod, assertPostingRole, ENTRIES_AGGREGATE_TYPE, insertPostedEntry, requireActor } from './post-journal.js';
import type { PostJournalDeps } from './ports.js';

const REVERSE_COMMAND = 'ReverseJournal';
const REVERSING_ENTRY_TYPE = 'reversing';
const REVERSED_EVENT_TYPE: CatalogedEventType = 'billing.journal_entry.reversed';
const AUDIT_OPERATION_REVERSE = 'reverse';
const AUDIT_OPERATION_POST_REVERSING = 'post';

export interface ReverseJournalInput {
  readonly entryId: string;
  readonly expectedVersion: number;
  readonly periodId: string;
  readonly entryDate: string;
  readonly description: string;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface ReverseJournalResult {
  /** The NEW 'reversing' entry. */
  readonly id: string;
  readonly docNo: string;
  readonly reversedEntryId: string;
  /** The original entry's version after the bump. */
  readonly originalVersion: number;
}

export async function reverseJournal(
  ctx: WithContextCtx,
  input: ReverseJournalInput,
  deps: PostJournalDeps,
): Promise<ReverseJournalResult> {
  const actorId = requireActor(ctx, REVERSE_COMMAND);

  return withIdempotentContext<ReverseJournalResult>(ctx, input.idem, async (tx) => {
    const original = await deps.repo.getPostedEntry(tx, input.entryId);
    await assertPostingRole(tx, deps, REVERSE_COMMAND);

    const period = await deps.repo.getPeriod(tx, input.periodId);
    if (period === null) {
      throw new PeriodNotOpenError(
        `period ${input.periodId} is not visible to the caller (Allowed: an open accounting period of the entry's entity)`,
      );
    }

    // No if on the status string — the machine's guards throw the typed refusal.
    advanceJournalStatus(
      { status: journalStatusOf(original.reversedBy), entityId: original.entityId, version: original.version },
      { type: JOURNAL_EVENTS.REVERSE, entityId: period.entityId, expectedVersion: input.expectedVersion },
    );
    await assertOpenPeriod(tx, deps, { entityId: original.entityId, periodId: input.periodId, entryDate: input.entryDate });

    const mirrored = mirrorLines(await deps.ledger.readLines(tx, original.id));
    // An account made non-postable (or moved) since the original posting is a typed 422 refusal,
    // before any write — never a T3 23514 surfacing as a 500.
    const accounts = await deps.repo.getAccounts(tx, [...new Set(mirrored.map((line) => line.accountId))]);
    assertLineAccounts(original.entityId, mirrored, accounts);
    const now = deps.clock.now();
    const reversing = await insertPostedEntry(tx, deps, {
      entityId: original.entityId,
      periodId: input.periodId,
      entryDate: input.entryDate,
      entryType: REVERSING_ENTRY_TYPE,
      description: input.description,
      lines: mirrored,
      actorId,
      postedAt: now,
    });

    const originalVersion = await deps.repo.markReversed(tx, original.id, reversing.id, input.expectedVersion);

    await writeOutboxEvent(tx, {
      entityId: original.entityId,
      aggregateType: ENTRIES_AGGREGATE_TYPE,
      aggregateId: original.id,
      eventType: REVERSED_EVENT_TYPE,
      payload: {
        entryId: original.id,
        reversingEntryId: reversing.id,
        reversingDocNo: reversing.docNo,
        entryDate: input.entryDate,
        periodId: input.periodId,
        version: originalVersion,
      },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: original.entityId,
      recordId: reversing.id,
      operation: AUDIT_OPERATION_POST_REVERSING,
      correlationId: input.correlationId,
      actorId,
      newValue: { docNo: reversing.docNo, entryType: REVERSING_ENTRY_TYPE, reverses: original.id, version: reversing.version },
      occurredAt: now,
    });
    await deps.repo.writeAuditRow(tx, {
      entityId: original.entityId,
      recordId: original.id,
      operation: AUDIT_OPERATION_REVERSE,
      correlationId: input.correlationId,
      actorId,
      newValue: { reversedBy: reversing.id, version: originalVersion },
      occurredAt: now,
    });

    return { id: reversing.id, docNo: reversing.docNo, reversedEntryId: original.id, originalVersion };
  });
}
