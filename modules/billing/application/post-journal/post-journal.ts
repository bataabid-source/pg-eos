// modules/billing/application/post-journal/post-journal.ts — WBS 4.20 (lane 2).
//
// application/ layer: PostJournal — the ONE posting service (ADR-0004 D1 2). ONE
// withIdempotentContext transaction (golden slice: modules/wms/application/receive-inbound/*):
// (0) the idempotency claim when input.idem is set, (1) typed refusals BEFORE any write — entity in
// the caller's scope, an open period of the entity covering the entry date (4.19 carried), >= 2
// lines and balanced (#6), accounts in the entity and postable (#8), OD-15 manual rule — then
// (2) doc_no from platform.next_doc_no(entity, 'JE'), the posted entry, its lines, (3) the outbox
// row, (4) the audit row, last. The database re-checks every rule (migration 0041) — balance at
// COMMIT by the deferred constraint trigger.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { PERIOD_STATUS } from '../../domain/accounting-periods/machine.js';
import { EntityNotInScopeError, MissingActorError, PeriodNotOpenError } from '../../domain/post-journal/errors.js';
import { assertBalanced, assertEntryTypePostable, assertLineAccounts } from '../../domain/post-journal/invariants.js';
import type { JournalLine, PostJournalDeps } from './ports.js';

export const ENTRIES_AGGREGATE_TYPE = 'billing.journal_entries';
const POSTED_EVENT_TYPE: CatalogedEventType = 'billing.journal_entry.posted';
const AUDIT_OPERATION_POST = 'post';

export interface PostJournalInput {
  readonly entityId: string;
  readonly periodId: string;
  readonly entryDate: string;
  readonly entryType: string;
  readonly description: string;
  readonly lines: readonly JournalLine[];
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface PostJournalResult {
  readonly id: string;
  readonly docNo: string;
  readonly version: number;
}

/** The caller's actor — ctx.userId only. */
export function requireActor(ctx: WithContextCtx, command: string): string {
  if (!ctx.userId) throw new MissingActorError(`${command} requires ctx.userId.`);
  return ctx.userId;
}

/** Refuses (PeriodNotOpenError) unless `periodId` is an open period of `entityId` covering `entryDate`. */
export async function assertOpenPeriod(
  tx: NodePgDatabase,
  deps: PostJournalDeps,
  params: { readonly entityId: string; readonly periodId: string; readonly entryDate: string },
): Promise<void> {
  const period = await deps.repo.getPeriod(tx, params.periodId);
  const covers =
    period !== null &&
    period.entityId === params.entityId &&
    period.startDate <= params.entryDate &&
    params.entryDate <= period.endDate;
  if (!covers || period.status !== PERIOD_STATUS.OPEN) {
    throw new PeriodNotOpenError(
      `period ${params.periodId} is not an open period of entity ${params.entityId} covering ${params.entryDate} ` +
        '(Allowed: an open accounting period of the entity whose range contains the entry date)',
    );
  }
}

/** Every pre-write refusal of a new entry, in the settled order. */
export async function assertPostable(
  tx: NodePgDatabase,
  deps: PostJournalDeps,
  input: {
    readonly entityId: string;
    readonly periodId: string;
    readonly entryDate: string;
    readonly entryType: string;
    readonly lines: readonly JournalLine[];
  },
): Promise<void> {
  if (!(await deps.repo.isEntityInScope(tx, input.entityId))) {
    throw new EntityNotInScopeError(
      `entity ${input.entityId} is not one of the caller's entities (Allowed: an entity the caller belongs to)`,
    );
  }
  await assertOpenPeriod(tx, deps, input);
  assertBalanced(input.lines);
  const accounts = await deps.repo.getAccounts(tx, [...new Set(input.lines.map((line) => line.accountId))]);
  assertLineAccounts(input.entityId, input.lines, accounts);
  assertEntryTypePostable(input.entryType, input.lines, accounts);
}

/** Writes one posted entry and its lines (no outbox, no audit — the caller writes those). */
export async function insertPostedEntry(
  tx: NodePgDatabase,
  deps: PostJournalDeps,
  params: {
    readonly entityId: string;
    readonly periodId: string;
    readonly entryDate: string;
    readonly entryType: string;
    readonly description: string;
    readonly lines: readonly JournalLine[];
    readonly actorId: string;
    readonly postedAt: Date;
  },
): Promise<PostJournalResult> {
  const docNo = await deps.repo.nextDocNo(tx, params.entityId);
  const entry = await deps.repo.insertEntry(tx, {
    entityId: params.entityId,
    docNo,
    entryDate: params.entryDate,
    description: params.description,
    periodId: params.periodId,
    entryType: params.entryType,
    postedAt: params.postedAt,
    postedBy: params.actorId,
  });
  await deps.ledger.appendLines(tx, { entryId: entry.id, entityId: params.entityId, lines: params.lines });
  return { id: entry.id, docNo, version: entry.version };
}

/** Posts a new entry of `eventType`'s kind — shared by PostJournal and AdjustJournal. */
export async function postNewEntry(
  ctx: WithContextCtx,
  input: PostJournalInput,
  deps: PostJournalDeps,
  event: { readonly command: string; readonly eventType: CatalogedEventType; readonly auditOperation: string },
): Promise<PostJournalResult> {
  const actorId = requireActor(ctx, event.command);

  return withIdempotentContext<PostJournalResult>(ctx, input.idem, async (tx) => {
    await assertPostable(tx, deps, input);
    const now = deps.clock.now();
    const result = await insertPostedEntry(tx, deps, { ...input, actorId, postedAt: now });

    await writeOutboxEvent(tx, {
      entityId: input.entityId,
      aggregateType: ENTRIES_AGGREGATE_TYPE,
      aggregateId: result.id,
      eventType: event.eventType,
      payload: {
        entryId: result.id,
        docNo: result.docNo,
        entryType: input.entryType,
        entryDate: input.entryDate,
        periodId: input.periodId,
      },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: input.entityId,
      recordId: result.id,
      operation: event.auditOperation,
      correlationId: input.correlationId,
      actorId,
      newValue: { docNo: result.docNo, entryType: input.entryType, lines: input.lines.length, version: result.version },
      occurredAt: now,
    });

    return { id: result.id, docNo: result.docNo, version: result.version };
  });
}

export async function postJournal(
  ctx: WithContextCtx,
  input: PostJournalInput,
  deps: PostJournalDeps,
): Promise<PostJournalResult> {
  return postNewEntry(ctx, input, deps, {
    command: 'PostJournal',
    eventType: POSTED_EVENT_TYPE,
    auditOperation: AUDIT_OPERATION_POST,
  });
}
