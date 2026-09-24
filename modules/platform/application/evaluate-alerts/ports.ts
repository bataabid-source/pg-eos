// modules/platform/application/evaluate-alerts/ports.ts — WBS 5.13 part 1, replicated (shape
// only) from the golden slice's ports.ts. The ports THIS use case programs against.
// ../../infrastructure/evaluate-alerts/repository.ts implements `AlertRuleRepository`;
// ../../api/evaluate-alerts/composition.ts wires it (and the logger adapter) together.
//
// TEMPLATE GUIDANCE: a later slice's own ports.ts declares its OWN interfaces named after its own
// aggregate — do not import this file from another use case.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** The clock and id generator every command needs (injected — domain-kit adapters in production,
 *  fixed ones in tests). */
export interface ClockDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by ../../infrastructure/evaluate-alerts/logger.ts (a
 *  @pg-eos/logger child-logger adapter); a fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
  /** A row this use case could not treat as a normal condition but that must not abort the pass —
   *  e.g. a source_query's first column (entity_ref) came back null (pg-reviewer finding 17). */
  warn(obj: LogFields, msg: string): void;
}

/** Everything a command needs, injected by the composition root
 *  (../../api/evaluate-alerts/composition.ts). Commands program only against these ports — the
 *  application layer never imports infrastructure/. */
export interface EvaluateAlertsDeps extends ClockDeps {
  readonly repo: AlertRuleRepository;
  readonly logger: Logger;
}

/** platform.alert_rules (13B §13B-4, L500-516) — camelCased. `id` is the rule's own uuid (the
 *  aggregate id platform.outbox.aggregate_id carries — the row's PK is bigserial, so it travels in
 *  the payload instead). */
export interface AlertRuleRow {
  readonly id: string;
  readonly code: string;
  readonly sourceQuery: string;
  readonly targetRoles: readonly string[];
  readonly channels: readonly string[];
  readonly dedupeWindowHours: number;
  readonly quietHours: boolean;
  readonly isActive: boolean;
  readonly mutedUntil: Date | null;
  readonly actionLabel: string;
  readonly actionLink: string;
}

/** platform.alert_log (13B §13B-4, L519-529, migration 0011) — camelCased. `ruleId` is joined in
 *  from platform.alert_rules via `rule_code` — kept for a future (part 2) use, but audit_log's own
 *  `record_id` is always null for this use case (pg-reviewer round-1 finding 5), so `ruleId` is NOT
 *  read for that purpose any more. */
export interface AlertLogRow {
  readonly id: number;
  readonly ruleId: string;
  readonly ruleCode: string;
  readonly entityRef: string | null;
  readonly firedAt: Date;
  readonly acknowledgedAt: Date | null;
  readonly acknowledgedBy: string | null;
  readonly version: number;
}

export interface InsertedAlertLog {
  readonly id: number;
  readonly version: number;
}

/** doc 40 P3/P7: one append-only audit_log row (schema_name/table_name are fixed by the adapter —
 *  'platform'/'alert_log' — the application layer never names a table). `recordId` is always
 *  `null` (pg-reviewer round-1 finding 5): platform.alert_rules.id (uuid) dangling as
 *  `table_name='alert_log'`'s record_id would not identify an alert_log row, and audit_log.record_id
 *  is nullable (13B ~L189) — alert_log's own bigint id travels inside `newValue` instead. `operation`
 *  is one of 13B's audit_log.operation list (~L193: insert · update · delete · approve · reject ·
 *  void · login · export · print · read_secret) — 'insert' for the fired row, 'update' for
 *  acknowledge (finding 4). `occurredAt` is mandatory (always from the injected Clock, never the
 *  column's own `default now()`). */
export interface AuditRowParams {
  readonly recordId: string | null;
  readonly operation: string;
  readonly correlationId: string;
  readonly actorId: string | null;
  readonly newValue: unknown;
  readonly occurredAt: Date;
}

/** Every DB statement the evaluate-alerts use case needs, as an interface — the port the
 *  application layer programs against. Implemented by
 *  ../../infrastructure/evaluate-alerts/repository.ts. */
export interface AlertRuleRepository {
  /** platform.alert_rules by code — returned even when `is_active = false` (N-16); the caller
   *  gates on `shouldEvaluate` (../../domain/evaluate-alerts/invariants.js), never the SQL. */
  getRuleByCode(tx: NodePgDatabase, code: string): Promise<AlertRuleRow | null>;
  /** every platform.alert_rules row, active or not — same gating discipline as getRuleByCode. */
  getAllRules(tx: NodePgDatabase): Promise<readonly AlertRuleRow[]>;
  /** Runs `sourceQuery` (trusted, operator-authored 13B seed text — never caller input) inside its
   *  own SAVEPOINT with `transaction_read_only` forced ON for the duration, via an extended-protocol
   *  (parameterised) execute so a multi-statement text is rejected rather than silently run
   *  (pg-reviewer round-1 finding 1) — the name documents the read-only guarantee. Always rolls
   *  back to the savepoint before returning (or throwing), which also reverts the GUC. Returns the
   *  FIRST column of every returned row, as text, or `null` when that column itself is null — every
   *  seeded `source_query` aliases it `entity_ref`, but this reads positionally, not by name, per
   *  the slice brief; the caller (evaluate-alert-rules.ts) is responsible for skipping/logging a
   *  null entry (finding 17), not this adapter. */
  runSourceQueryReadOnly(tx: NodePgDatabase, sourceQuery: string): Promise<readonly (string | null)[]>;
  /** The most recent platform.alert_log.fired_at for (ruleCode, entityRef), or null if the pair
   *  never fired before. */
  getLastFiredAt(tx: NodePgDatabase, ruleCode: string, entityRef: string): Promise<Date | null>;
  /** The distinct active holders (identity.user_roles, not revoked; identity.users, is_active) of
   *  every role code in `targetRoles` (part 1: static roles only). */
  resolveRecipients(tx: NodePgDatabase, targetRoles: readonly string[]): Promise<readonly string[]>;
  insertAlertLog(
    tx: NodePgDatabase,
    params: {
      readonly ruleCode: string;
      readonly entityRef: string;
      readonly firedAt: Date;
      readonly recipients: readonly string[];
      readonly channel: string | null;
    },
  ): Promise<InsertedAlertLog>;
  /** `select ... for update of` the ONE platform.alert_log row, joined (read-only) to its
   *  platform.alert_rules row for `ruleId`. */
  getAlertLogForUpdate(tx: NodePgDatabase, id: number): Promise<AlertLogRow>;
  /** unconditional version bump — the caller already validated expectedVersion against the locked
   *  row and holds that lock for the whole transaction, so this never races. Returns the new
   *  version. */
  acknowledgeAlertLog(
    tx: NodePgDatabase,
    params: { readonly id: number; readonly acknowledgedAt: Date; readonly acknowledgedBy: string | null },
  ): Promise<number>;
  writeAuditRow(tx: NodePgDatabase, params: AuditRowParams): Promise<void>;
  /** Runs `fn` inside its own SAVEPOINT — one rule's write failure (alert_log insert, outbox,
   *  audit) must not abort the whole EvaluateAlertRules pass (pg-reviewer round-1 finding 2). On
   *  success: release the savepoint. On error: roll back to the savepoint (undoing every write
   *  `fn` made), then release it too — so a pass over 22 rules never accumulates an unreleased
   *  savepoint stack (repository.ts's own "never accumulate" discipline, round-2 finding 3) —
   *  then rethrow the original error so the caller can record it in `failed`. Every DB statement
   *  this use case needs stays behind this ONE port — the application layer never issues raw SQL
   *  itself (ports.ts's own "every DB statement goes through the port" rule, round-2 finding 3). */
  withRuleSavepoint<T>(tx: NodePgDatabase, fn: () => Promise<T>): Promise<T>;
}
