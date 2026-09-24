// modules/platform/infrastructure/evaluate-alerts/repository.ts — WBS 5.13 part 1, replicated
// (shape only) from the golden slice's repository.ts. Every DB statement for the evaluate-alerts
// use case, run against the `tx` a caller's own withContext(ctx, fn) (or withIdempotentContext)
// already opened. Implements ../../application/evaluate-alerts/ports.ts's `AlertRuleRepository`.
//
// LOCK ORDER:
//   0. the idempotency advisory lock + platform.idempotency_keys upsert (packages/db/src/
//      idempotency.ts's withIdempotentContext), FIRST — AcknowledgeAlert only (EvaluateAlertRules
//      carries no `idem`, it is the pg-boss job body / internal trigger, not an HTTP write
//      endpoint in part 1).
//   1. getAlertLogForUpdate — `select ... for update of` the ONE platform.alert_log row
//      (AcknowledgeAlert only). Held for the rest of the transaction.
//   2. every read this use case's own EvaluateAlertRules performs takes NO row lock at all
//      (platform.alert_rules is read plainly; the rule's own source_query runs inside its own
//      savepoint with `transaction_read_only` forced on — Postgres enforces read-only, this
//      adapter never merely trusts the seed text — see runSourceQueryReadOnly below).
//   3. per fired entity_ref: the alert_log insert, then outbox insert, then writeAuditRow, last
//      (ADR-0002), all inside ONE savepoint per rule (application layer,
//      evaluate-alert-rules.ts) — a failing write rolls back only that rule's alerts, not the
//      whole pass (pg-reviewer round-1 finding 2).
//
// TEMPLATE GUIDANCE — every module-specific literal a later slice's copy must change is a named
// constant in this ONE file:
const ALERT_RULES_TABLE = 'platform.alert_rules'; // REPLACE-ON-COPY: the rule-definition table.
const ALERT_LOG_TABLE = 'platform.alert_log'; // REPLACE-ON-COPY: the aggregate table.
const AUDIT_SCHEMA_NAME = 'platform';
const AUDIT_TABLE_NAME = 'alert_log'; // this use case audits only one table (part 1 scope).
const AUDIT_ACTOR_TYPE_USER = 'user'; // every actor is ctx.userId — never 'system' here.

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { AlertLogNotFoundError } from '../../domain/evaluate-alerts/errors.js';
import type {
  AlertLogRow,
  AlertRuleRepository,
  AlertRuleRow,
  AuditRowParams,
  InsertedAlertLog,
} from '../../application/evaluate-alerts/ports.js';

function toAlertRuleRow(row: {
  id: string;
  code: string;
  source_query: string;
  target_roles: readonly string[];
  channels: readonly string[];
  dedupe_window_hours: number;
  quiet_hours: boolean;
  is_active: boolean;
  muted_until: Date | string | null;
  action_label: string;
  action_link: string;
}): AlertRuleRow {
  return {
    id: row.id,
    code: row.code,
    sourceQuery: row.source_query,
    targetRoles: row.target_roles,
    channels: row.channels,
    dedupeWindowHours: row.dedupe_window_hours,
    quietHours: row.quiet_hours,
    isActive: row.is_active,
    mutedUntil: row.muted_until === null ? null : new Date(row.muted_until),
    actionLabel: row.action_label,
    actionLink: row.action_link,
  };
}

const ALERT_RULE_COLUMNS = sql.raw(
  `id, code, source_query, target_roles, channels, dedupe_window_hours, quiet_hours, is_active, muted_until, action_label, action_link`,
);

async function getRuleByCode(tx: NodePgDatabase, code: string): Promise<AlertRuleRow | null> {
  const result = await tx.execute<{
    id: string;
    code: string;
    source_query: string;
    target_roles: readonly string[];
    channels: readonly string[];
    dedupe_window_hours: number;
    quiet_hours: boolean;
    is_active: boolean;
    muted_until: Date | string | null;
    action_label: string;
    action_link: string;
  }>(sql`select ${ALERT_RULE_COLUMNS} from ${sql.raw(ALERT_RULES_TABLE)} where code = ${code}`);
  const row = result.rows[0];
  return row ? toAlertRuleRow(row) : null;
}

async function getAllRules(tx: NodePgDatabase): Promise<readonly AlertRuleRow[]> {
  const result = await tx.execute<{
    id: string;
    code: string;
    source_query: string;
    target_roles: readonly string[];
    channels: readonly string[];
    dedupe_window_hours: number;
    quiet_hours: boolean;
    is_active: boolean;
    muted_until: Date | string | null;
    action_label: string;
    action_link: string;
  }>(sql`select ${ALERT_RULE_COLUMNS} from ${sql.raw(ALERT_RULES_TABLE)} order by code`);
  return result.rows.map(toAlertRuleRow);
}

// pg-reviewer round-1 finding 1: a rule's source_query must never be able to write — a
// data-modifying CTE (`with d as (update ... returning ...) select ...`) is syntactically a single
// SELECT-shaped statement, so no permission check alone stops it. Two independent defenses:
//   (a) the query runs inside its OWN savepoint with `transaction_read_only` forced ON for the
//       duration — Postgres itself then refuses any write, anywhere in the statement (including
//       inside a CTE), regardless of protocol; the savepoint is ALWAYS rolled back afterwards
//       (success or error), which also reverts the GUC (Master note: `set local` inside a
//       savepoint is undone by `rollback to savepoint`).
//   (b) the query text is wrapped as a derived table and executed through the EXTENDED (parameterised)
//       protocol — Postgres' extended-protocol Parse step accepts exactly one statement, so a
//       multi-statement text (`; drop table ...`) is rejected outright rather than silently run
//       (the simple protocol drizzle's `sql.raw()` used before this fix allows multiple ;-separated
//       statements). The wrapper also supplies the one bound parameter (`$1 = true`) that forces
//       node-postgres onto the extended protocol in the first place (pg's own `Query.
//       requiresPreparation()` only prepares when `values.length > 0`, a named statement, or a row
//       limit is set — an empty-but-present values array is NOT enough).
const READ_ONLY_SAVEPOINT = 'alert_rule_source_query';

/** Runs `sourceQuery` (trusted, operator-authored 13B seed text — never interpolated with caller
 *  input) read-only, per the defenses above, and returns the FIRST column of every row — as text,
 *  or `null` when that column itself is null — read positionally (`Object.values(row)[0]`), never
 *  by an assumed column name, per the slice brief. Implements the `AlertRuleRepository` port's
 *  `runSourceQueryReadOnly` — the name documents the read-only guarantee. */
async function runSourceQueryReadOnly(tx: NodePgDatabase, sourceQuery: string): Promise<readonly (string | null)[]> {
  await tx.execute(sql.raw(`savepoint ${READ_ONLY_SAVEPOINT}`));
  try {
    await tx.execute(sql`set local transaction_read_only = on`);
    const guardedQuery = sql`select * from (${sql.raw(sourceQuery)}) as __alert_rule_source where ${true}::boolean is true`;
    const result = await tx.execute<Record<string, unknown>>(guardedQuery);
    return result.rows.map((row) => {
      const [firstColumnValue] = Object.values(row);
      return firstColumnValue === null || firstColumnValue === undefined ? null : String(firstColumnValue);
    });
  } finally {
    // Always rolls back — reverts the read-only GUC and any accidental write the query attempted —
    // whether the query above succeeded or threw. Then releases the savepoint so 22 rules run in
    // one pass never accumulate an unbounded savepoint stack.
    await tx.execute(sql.raw(`rollback to savepoint ${READ_ONLY_SAVEPOINT}`));
    await tx.execute(sql.raw(`release savepoint ${READ_ONLY_SAVEPOINT}`));
  }
}

async function getLastFiredAt(tx: NodePgDatabase, ruleCode: string, entityRef: string): Promise<Date | null> {
  const result = await tx.execute<{ fired_at: Date | string }>(sql`
    select fired_at from ${sql.raw(ALERT_LOG_TABLE)}
     where rule_code = ${ruleCode} and entity_ref = ${entityRef}
     order by fired_at desc
     limit 1
  `);
  const row = result.rows[0];
  return row ? new Date(row.fired_at) : null;
}

async function resolveRecipients(tx: NodePgDatabase, targetRoles: readonly string[]): Promise<readonly string[]> {
  const result = await tx.execute<{ user_id: string }>(sql`
    select distinct ur.user_id
      from identity.user_roles ur
      join identity.roles r on r.id = ur.role_id
      join identity.users u on u.id = ur.user_id
     where r.code = any(${sql.param(targetRoles)}::text[]) and ur.revoked_at is null and u.is_active = true
     order by ur.user_id
  `);
  return result.rows.map((row) => row.user_id);
}

async function insertAlertLog(
  tx: NodePgDatabase,
  params: {
    readonly ruleCode: string;
    readonly entityRef: string;
    readonly firedAt: Date;
    readonly recipients: readonly string[];
    readonly channel: string | null;
  },
): Promise<InsertedAlertLog> {
  const result = await tx.execute<{ id: string; version: number }>(sql`
    insert into ${sql.raw(ALERT_LOG_TABLE)} (rule_code, entity_ref, fired_at, recipients, channel)
    values (
      ${params.ruleCode}, ${params.entityRef}, ${params.firedAt.toISOString()}::timestamptz,
      ${sql.param(params.recipients)}::uuid[], ${params.channel}
    )
    returning id, version
  `);
  const row = result.rows[0];
  if (!row) throw new Error(`insert into ${ALERT_LOG_TABLE} returned no row`);
  return { id: Number(row.id), version: row.version };
}

async function getAlertLogForUpdate(tx: NodePgDatabase, id: number): Promise<AlertLogRow> {
  const result = await tx.execute<{
    id: string;
    rule_id: string;
    rule_code: string;
    entity_ref: string | null;
    fired_at: Date | string;
    acknowledged_at: Date | string | null;
    acknowledged_by: string | null;
    version: number;
  }>(sql`
    select al.id, ar.id as rule_id, al.rule_code, al.entity_ref, al.fired_at, al.acknowledged_at,
           al.acknowledged_by, al.version
      from ${sql.raw(ALERT_LOG_TABLE)} al
      join ${sql.raw(ALERT_RULES_TABLE)} ar on ar.code = al.rule_code
     where al.id = ${id}
     for update of al
  `);
  const row = result.rows[0];
  if (!row) {
    throw new AlertLogNotFoundError(
      `no ${ALERT_LOG_TABLE} row visible for id ${id} — it does not exist, or RLS hides it from ` +
        `the caller. (Allowed: an existing, visible alert_log id)`,
    );
  }
  return {
    id: Number(row.id),
    ruleId: row.rule_id,
    ruleCode: row.rule_code,
    entityRef: row.entity_ref,
    firedAt: new Date(row.fired_at),
    acknowledgedAt: row.acknowledged_at === null ? null : new Date(row.acknowledged_at),
    acknowledgedBy: row.acknowledged_by,
    version: row.version,
  };
}

async function acknowledgeAlertLog(
  tx: NodePgDatabase,
  params: { readonly id: number; readonly acknowledgedAt: Date; readonly acknowledgedBy: string | null },
): Promise<number> {
  const result = await tx.execute<{ version: number }>(sql`
    update ${sql.raw(ALERT_LOG_TABLE)}
       set acknowledged_at = ${params.acknowledgedAt.toISOString()}::timestamptz,
           acknowledged_by = ${params.acknowledgedBy}::uuid,
           version = version + 1
     where id = ${params.id}
    returning version
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`acknowledgeAlertLog: no ${ALERT_LOG_TABLE} row for id ${params.id} (lock was already held)`);
  }
  return row.version;
}

/** doc 40 P3/P7: one append-only audit_log row, correlation_id shared with the outbox row the
 *  same call writes (G9). `entity_id` is always null — platform.alert_rules is not entity-scoped
 *  (platform brief §2). `record_id` is always null (pg-reviewer round-1 finding 5) —
 *  platform.alert_rules.id dangling under `table_name='alert_log'` does not identify an alert_log
 *  row, and audit_log.record_id is nullable (13B ~L189); the bigint alert_log id travels inside
 *  `new_value` instead. */
async function writeAuditRow(tx: NodePgDatabase, params: AuditRowParams): Promise<void> {
  await tx.execute(sql`
    insert into platform.audit_log
      (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation,
       new_value, correlation_id)
    values
      (${params.occurredAt.toISOString()}::timestamptz, ${params.actorId}::uuid, ${AUDIT_ACTOR_TYPE_USER},
       null, ${AUDIT_SCHEMA_NAME}, ${AUDIT_TABLE_NAME}, ${params.recordId}::uuid,
       ${params.operation}, ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

// pg-reviewer round-2 finding 3: the application layer must never issue raw SQL (savepoint or
// otherwise) itself — every DB statement goes through this port. `withRuleSavepoint` is the ONE
// place evaluate-alert-rules.ts's per-rule write isolation is implemented.
const WRITE_SAVEPOINT = 'alert_rule_writes';

async function withRuleSavepoint<T>(tx: NodePgDatabase, fn: () => Promise<T>): Promise<T> {
  await tx.execute(sql.raw(`savepoint ${WRITE_SAVEPOINT}`));
  try {
    const result = await fn();
    await tx.execute(sql.raw(`release savepoint ${WRITE_SAVEPOINT}`));
    return result;
  } catch (error) {
    // Roll back every write `fn` made, THEN release — never leaves an unreleased savepoint behind
    // (same "never accumulate" discipline as runSourceQueryReadOnly's own read-only savepoint).
    await tx.execute(sql.raw(`rollback to savepoint ${WRITE_SAVEPOINT}`));
    await tx.execute(sql.raw(`release savepoint ${WRITE_SAVEPOINT}`));
    throw error;
  }
}

export const alertRuleRepository: AlertRuleRepository = {
  getRuleByCode,
  getAllRules,
  runSourceQueryReadOnly,
  getLastFiredAt,
  resolveRecipients,
  insertAlertLog,
  getAlertLogForUpdate,
  acknowledgeAlertLog,
  writeAuditRow,
  withRuleSavepoint,
};
