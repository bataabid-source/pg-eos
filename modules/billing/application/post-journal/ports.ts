// modules/billing/application/post-journal/ports.ts — WBS 4.20 (lane 2).
//
// application/ layer: the ports this use case programs against. Every command takes ONE
// `deps: PostJournalDeps` (clock, repo, ledger, logger) and never imports infrastructure/ (golden
// slice: modules/wms/application/receive-inbound/ports.ts).
// ../../infrastructure/post-journal/repository.ts implements `JournalRepository`;
// ../../infrastructure/post-journal/ledger.ts implements `JournalLedgerPort` (the append-only
// journal_lines book); ../../infrastructure/post-journal/logger.ts implements `Logger`;
// ../../api/post-journal/composition.ts wires them.

import type { Clock } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { AccountFacts } from '../../domain/post-journal/invariants.js';

/** The clock every command needs (injected — domain-kit adapter in production, fixed in tests). */
export interface ClockDeps {
  readonly clock: Clock;
}

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by ../../infrastructure/post-journal/logger.ts. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** Everything a command needs, injected by the composition root. */
export interface PostJournalDeps extends ClockDeps {
  readonly repo: JournalRepository;
  readonly ledger: JournalLedgerPort;
  readonly logger: Logger;
}

/** One journal line as the commands carry it (contract JournalLineInput). */
export interface JournalLine {
  readonly accountId: string;
  readonly debit?: string | undefined;
  readonly credit?: string | undefined;
  readonly description?: string | undefined;
  readonly dimensions?: ReadonlyArray<{ readonly dimensionTypeId: string; readonly valueId: string }> | undefined;
}

/** The accounting period a posting names (billing.accounting_periods, migration 0040). */
export interface PeriodRow {
  readonly id: string;
  readonly entityId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: string;
}

/** A billing.journal_entries row as the reverse path reads it. */
export interface JournalEntryRow {
  readonly id: string;
  readonly entityId: string;
  readonly docNo: string;
  readonly reversedBy: string | null;
  readonly version: number;
}

/** What an audit row records — the adapter maps it to schema/table; the application never names a
 *  table. */
export interface AuditRowInput {
  readonly entityId: string;
  readonly recordId: string;
  readonly operation: string;
  readonly correlationId: string;
  readonly actorId: string;
  readonly newValue: unknown;
  readonly occurredAt: Date;
}

/** Every DB statement the post-journal use case needs besides the lines. */
export interface JournalRepository {
  /** True iff `entityId` is one of the caller's entities (platform.allowed_entities()). */
  isEntityInScope(tx: NodePgDatabase, entityId: string): Promise<boolean>;
  /** True iff the session user holds `roleCode` (platform.my_roles()). */
  hasRole(tx: NodePgDatabase, roleCode: string): Promise<boolean>;
  /** The period `periodId` as RLS lets the caller see it, or null. */
  getPeriod(tx: NodePgDatabase, periodId: string): Promise<PeriodRow | null>;
  /** The GL-account facts for each id the caller can read (missing ids are absent from the map). */
  getAccounts(tx: NodePgDatabase, accountIds: readonly string[]): Promise<ReadonlyMap<string, AccountFacts>>;
  /** platform.next_doc_no(entity, 'JE'). */
  nextDocNo(tx: NodePgDatabase, entityId: string): Promise<string>;
  /** Inserts one POSTED entry (posted_at/by set, version 1). */
  insertEntry(
    tx: NodePgDatabase,
    params: {
      readonly entityId: string;
      readonly docNo: string;
      readonly entryDate: string;
      readonly description: string;
      readonly periodId: string;
      readonly entryType: string;
      readonly postedAt: Date;
      readonly postedBy: string;
    },
  ): Promise<{ readonly id: string; readonly version: number }>;
  /** The entry `entryId` as RLS lets the caller see it (the reverse path's first read). No row lock:
   *  pgeos_app holds no UPDATE; billing.mark_journal_reversed() (T6) locks. Throws
   *  JournalEntryNotFoundError when no row is visible. */
  getPostedEntry(tx: NodePgDatabase, entryId: string): Promise<JournalEntryRow>;
  /** billing.mark_journal_reversed() (T6): sets reversed_by, bumps version; returns the new version.
   *  Maps the function's refusals to AlreadyReversedError / StaleVersionError. */
  markReversed(tx: NodePgDatabase, entryId: string, reversingId: string, expectedVersion: number): Promise<number>;
  writeAuditRow(tx: NodePgDatabase, params: AuditRowInput): Promise<void>;
}

/** The append-only book: billing.journal_lines (+ billing.line_dimensions). */
export interface JournalLedgerPort {
  appendLines(tx: NodePgDatabase, params: { readonly entryId: string; readonly entityId: string; readonly lines: readonly JournalLine[] }): Promise<void>;
  readLines(tx: NodePgDatabase, entryId: string): Promise<JournalLine[]>;
}
