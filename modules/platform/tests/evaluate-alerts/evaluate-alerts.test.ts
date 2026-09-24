// modules/platform/tests/evaluate-alerts/evaluate-alerts.test.ts — WBS 5.13 part 1 (alert
// evaluation mechanism), replicated from the golden slice's shape
// (modules/wms/tests/receive-inbound/receive-inbound.test.ts) — this use case's logic is doc 40
// §B6 / doc 25 §1-§2, not inbound receiving. Sources: docs/notes/slice-briefs/_slice-5.13.brief.md,
// database/schema/13B-Schema-Reference-Consolidation.sql:500-3043 (alert_rules/alert_log DDL +
// seed), migration 0011_M_alert-log-version-seed-rules.sql (alert_log.version; N-16 is_active=false).
//
// Binding behaviour this file asserts (RED — none of modules/platform/{domain,application,
// infrastructure,api}/evaluate-alerts/* has real logic yet):
//   - EvaluateAlertRules(input, ctx, deps) evaluates one rule (input.ruleCode) or every
//     `is_active` rule (ruleCode omitted); is_active = false rules (N-16) are NEVER evaluated,
//     even when named explicitly;
//   - a rule fires iff shouldEvaluate() passes, isWithinQuietHours() is false (or the rule is one
//     of the two exemptions N-01/N-03, whose own quiet_hours = false), and isDeduped() is false
//     for that (rule_code, entity_ref) pair;
//   - a fired rule writes exactly one platform.alert_log row (rule_code, entity_ref = the
//     source_query's first column, fired_at = deps.clock.now(), recipients = the active
//     identity.user_roles holders of the rule's target_roles, version = 1) and exactly one
//     platform.outbox row (event_type = 'platform.alert.fired') in the SAME transaction —
//     asserted via correlation_id + event_type (packages/events/catalog.ts note: alert_log's PK is
//     bigint, platform.outbox.aggregate_id is uuid, so this file never asserts on aggregate_id —
//     see the closing report's open question);
//   - AcknowledgeAlert(input, ctx, deps) sets acknowledged_at/acknowledged_by = ctx.userId, bumps
//     alert_log.version by exactly 1, writes an audit row; a stale expectedVersion ->
//     StaleVersionError; acknowledging an already-acknowledged row -> AlertAlreadyAcknowledgedError
//     (never a silent no-op); it is idempotent under the same Idempotency-Key + body (replay, no
//     second write);
//   - EvaluateAlertRules called with ctx.isInternal = false is rejected with RoleRequiredError
//     BEFORE any row is written (DEFAULT taken per SESSION OPERATING DIRECTIVE — the brief says
//     "rejected by RLS/permission" without naming the exact mechanism; alert_log/user_roles both
//     carry an `internal_only` RLS policy keyed on platform.is_internal(), so a proactive
//     RoleRequiredError guard mirroring the golden slice's own role checks is the taken default —
//     see the closing report's open question).
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only), same as
// receive-inbound.test.ts, plus a dedicated pgeos_app-role pool (appPool) for the genuine-RLS
// checks below. PG_APP_USER=pgeos_app is REQUIRED to run this suite (every command call goes
// through withContext(ctx, fn) as pgeos_app, genuinely subject to RLS). platform.audit_log rows
// are NEVER deleted. Every source_query in platform.alert_rules reads the DATABASE's own
// `now()`/`current_date` (verified live below) — fixtures use SQL intervals against the real
// server clock; only the DOMAIN's quiet-hours/dedupe decisions use the INJECTED FixedClock
// (CLAUDE.md · AGENT CONSTRAINTS: "No Math.random() / new Date() in domain/").
//
// fix round 1 (pg-reviewer FAIL(19)): finding 3 renames the quiet-hours timezone citation from the
// fabricated 'Asia/Riyadh' to the platform default 'Asia/Kuwait' (doc 40 §A3 ~L54) — same UTC+3,
// no-DST offset, so every literal UTC instant below is unchanged, only its name/citation is.

import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import type { IdempotencyInput } from '@pg-eos/db';

import { acknowledgeAlert, evaluateAlertRules } from '../../application/evaluate-alerts/index.js';
import { createEvaluateAlertsDeps } from '../../api/evaluate-alerts/composition.js';
import {
  AlertAlreadyAcknowledgedError,
  AlertLogNotFoundError,
  MissingActorError,
  RoleRequiredError,
  StaleVersionError,
} from '../../domain/evaluate-alerts/errors.js';
import {
  AcknowledgeAlertInputSchema,
  EvaluateAlertRulesInputSchema,
} from '@pg-eos/contracts/platform/evaluate-alerts';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

// pgeos_app-role pool — dedicated so the RLS test (below) genuinely runs under RLS, not the
// admin/superuser connection. Same pattern as the golden slice's `appPool`.
const appPool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PG_APP_USER'] ?? 'pgeos_app',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

// --- literals, each cited to the schema fact, decision or brief line they come from -------------

// doc 25 §1: the 22:00–07:00 QUIET-HOURS WINDOW (doc 25 §1 names no timezone — 'Asia/Riyadh' was a
// fabricated attribution, pg-reviewer fix round 1 finding 3). doc 40 §A3 ~L54: the platform default
// timezone is 'Asia/Kuwait' — UTC+3, no daylight saving, same arithmetic as Riyadh would have had.
const KUWAIT_DAYTIME_UTC = '2026-09-24T09:00:00.000Z'; // 12:00 Kuwait — outside quiet hours.
const KUWAIT_QUIET_2300_UTC = '2026-09-24T20:00:00.000Z'; // 23:00 Kuwait — inside quiet hours.
const KUWAIT_0800_NEXT_DAY_UTC = '2026-09-25T05:00:00.000Z'; // 08:00 Kuwait, next day.

const N19_TARGET_ROLES = ['SYSADMIN', 'DEL_MGR', 'FLEET_MGR', 'CFO']; // 13B seed, verified live.
const OLD_QUEUE_ROW_AGE_HOURS = 49; // N-19: `min(created_at) < now() - interval '48 hours'`.
const SEEDED_ALERT_RULE_COUNT = 22; // 13B L2839-3043, `on conflict (code) do nothing`.
const ALERT_FIRED_EVENT_TYPE = 'platform.alert.fired';
const ALERT_RULES_AGGREGATE_TYPE = 'platform.alert_rules'; // outbox.aggregate_type (fix round 1).
const UNKNOWN_ALERT_LOG_ID_OFFSET = 1_000_000;

const ROLE_ACTOR_UUID = '00000000-0000-4000-8000-0000000513a1';

const roleCtx = { userId: ROLE_ACTOR_UUID, clientId: null, isInternal: true };
const nonInternalCtx = { userId: ROLE_ACTOR_UUID, clientId: null, isInternal: false };
const noActorCtx = { userId: null, clientId: null, isInternal: true };

const clock = new FixedClock(new Date(KUWAIT_DAYTIME_UTC));
const ids = new SequentialIdGenerator(513);
const deps = createEvaluateAlertsDeps({ clock, ids });

let entityId: string;
const usedCorrelationIds = new Set<string>();
const fixtureQueueIds: string[] = [];
// The `integration` text values used as N-19's entity_ref — DIFFERENT from fixtureQueueIds (the
// platform.integration_queue rows' own uuid PKs) — needed to clean up the alert_log rows
// evaluateAlertRules itself writes as a side effect of the tests below.
const fixtureN19EntityRefs: string[] = [];
const fixtureContractDocNos: string[] = [];
const fixtureContractIds: string[] = [];
const fixtureAccountIds: string[] = [];
const fixtureAlertLogIds: number[] = [];
const fixtureDeliveryTaskIds: string[] = [];
const fixtureReceiptIds: string[] = [];

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

/** sha256-free stub matching the golden pattern's IdempotencyInput builder — the endpoint follows
 *  the same 'platform.evaluate-alerts.<command>' convention as 'wms.receive-inbound.<command>'. */
function idemFor(endpoint: string, key: string, body: unknown): IdempotencyInput {
  return {
    key,
    endpoint: `platform.evaluate-alerts.${endpoint}`,
    requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    entityId: null,
    successStatus: 200,
  };
}

async function alertLogCountForRule(ruleCode: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.alert_log where rule_code = $1`,
    [ruleCode],
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** Highest existing platform.alert_log.id for a rule_code — used with `newAlertLogIdsSince` below
 *  to register (for afterAll cleanup) any row a command call writes for a rule with a FIXED,
 *  literal entity_ref (N-01's is always 'imile_agent') — without this, a leftover row from one
 *  test run would still be inside N-01's 60h dedupe_window_hours on the NEXT run and silently
 *  suppress the delta this suite asserts on. */
async function maxAlertLogId(ruleCode: string): Promise<number> {
  const result: QueryResult<{ max_id: string | null }> = await pool.query(
    `select max(id)::text as max_id from platform.alert_log where rule_code = $1`,
    [ruleCode],
  );
  return Number(result.rows[0]?.max_id ?? '0');
}

async function registerAlertLogIdsSince(ruleCode: string, maxIdBefore: number): Promise<void> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `select id::text as id from platform.alert_log where rule_code = $1 and id > $2`,
    [ruleCode, maxIdBefore],
  );
  for (const row of result.rows) fixtureAlertLogIds.push(Number(row.id));
}

/** Global watermark — used (reviewer fix round 1 finding 18) by the "ruleCode omitted" and the
 *  savepoint-isolation scenarios below, both of which call evaluateAlertRules with NO ruleCode and
 *  so may cause ANY active rule to genuinely fire against real seeded data, not just the one
 *  fixture under test. */
async function globalMaxAlertLogId(): Promise<number> {
  const result: QueryResult<{ max_id: string | null }> = await pool.query(
    `select coalesce(max(id), 0)::text as max_id from platform.alert_log`,
  );
  return Number(result.rows[0]?.max_id ?? '0');
}

async function registerAllAlertLogIdsSince(maxIdBefore: number): Promise<void> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `select id::text as id from platform.alert_log where id > $1`,
    [maxIdBefore],
  );
  for (const row of result.rows) fixtureAlertLogIds.push(Number(row.id));
}

/** A bigint id guaranteed not to exist yet (findings 7/12: AlertLogNotFoundError). */
async function unknownAlertLogId(): Promise<number> {
  return (await globalMaxAlertLogId()) + UNKNOWN_ALERT_LOG_ID_OFFSET;
}

async function ruleIdByCode(code: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.alert_rules where code = $1`,
    [code],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no platform.alert_rules row for code ${code}`);
  return row.id;
}

async function sourceQueryFor(code: string): Promise<string> {
  const result: QueryResult<{ source_query: string }> = await pool.query(
    `select source_query from platform.alert_rules where code = $1`,
    [code],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no platform.alert_rules row for code ${code}`);
  return row.source_query;
}

async function setSourceQuery(code: string, sourceQuery: string): Promise<void> {
  await pool.query(`update platform.alert_rules set source_query = $1 where code = $2`, [sourceQuery, code]);
}

/** fix round 2 finding 2: the exact active-rule count `evaluated` must equal (all active rules, on
 *  the seeded DB, minus any still-muted one — none are muted today, but the query is written to
 *  match `shouldEvaluate`'s own gate exactly, never a re-derived approximation). */
async function activeAlertRuleCount(): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.alert_rules
      where is_active and (muted_until is null or muted_until <= now())`,
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** fix round 2 finding 1: a real "the table is unchanged" proxy — a whole-table checksum, ordered
 *  deterministically by code, computed immediately AFTER this test's own deliberate source_query
 *  corruption (so the corruption itself never shows up as a false "changed" delta) and again right
 *  before restoring it in `finally`. */
async function alertRulesChecksum(): Promise<string> {
  const result: QueryResult<{ checksum: string | null }> = await pool.query(
    `select md5(string_agg(r::text, '|' order by r.code)) as checksum from platform.alert_rules r`,
  );
  return result.rows[0]?.checksum ?? '';
}

/** fix round 2 finding 1: platform.alert_log_id_seq's own state — a write-attempting source_query
 *  (`nextval(...)`) that the read-only savepoint correctly rejects must never actually advance it. */
async function alertLogSequenceState(): Promise<{ readonly lastValue: string; readonly isCalled: boolean }> {
  const result: QueryResult<{ last_value: string; is_called: boolean }> = await pool.query(
    `select last_value::text as last_value, is_called from platform.alert_log_id_seq`,
  );
  const row = result.rows[0];
  if (!row) throw new Error('platform.alert_log_id_seq returned no row');
  return { lastValue: row.last_value, isCalled: row.is_called };
}

/** fix round 2 finding 10: warnCalls alongside errorCalls — round-1 findings 13/17 (a null
 *  entity_ref is skipped with a warning; a failed rule's error line) were never actually asserted. */
function spyLogger(): {
  readonly error: (obj: Record<string, unknown>, msg: string) => void;
  readonly info: (obj: Record<string, unknown>, msg: string) => void;
  readonly warn: (obj: Record<string, unknown>, msg: string) => void;
  readonly errorCalls: Array<[Record<string, unknown>, string]>;
  readonly warnCalls: Array<[Record<string, unknown>, string]>;
} {
  const errorCalls: Array<[Record<string, unknown>, string]> = [];
  const warnCalls: Array<[Record<string, unknown>, string]> = [];
  return {
    errorCalls,
    warnCalls,
    error: (obj, msg) => {
      errorCalls.push([obj, msg]);
    },
    info: () => {
      // not asserted here.
    },
    warn: (obj, msg) => {
      warnCalls.push([obj, msg]);
    },
  };
}

async function alertLogRowsForRuleAndEntityRef(
  ruleCode: string,
  entityRef: string,
): Promise<Array<{ id: number; entity_ref: string | null; fired_at: Date; recipients: string[] | null; version: number }>> {
  const result: QueryResult<{
    id: string;
    entity_ref: string | null;
    fired_at: Date;
    recipients: string[] | null;
    version: number;
  }> = await pool.query(
    `select id::text as id, entity_ref, fired_at, recipients, version from platform.alert_log
      where rule_code = $1 and entity_ref = $2`,
    [ruleCode, entityRef],
  );
  return result.rows.map((row) => ({ ...row, id: Number(row.id) }));
}

/** Full-shape audit assertion (reviewer fix round 1 finding 10/1): operation 'insert' (fired) /
 *  'update' (acknowledge), record_id NULL, the bigint alert_log id living inside new_value.id
 *  instead (record_id is uuid; alert_log's own PK is bigint). */
async function auditRowsForCorrelation(
  correlationId: string,
): Promise<Array<{ operation: string; record_id: string | null; new_value: Record<string, unknown> }>> {
  const result: QueryResult<{ operation: string; record_id: string | null; new_value: Record<string, unknown> }> =
    await pool.query(
      `select operation, record_id, new_value from platform.audit_log where correlation_id = $1`,
      [correlationId],
    );
  return result.rows;
}

async function expectedRecipientsFor(targetRoles: readonly string[]): Promise<string[]> {
  const result: QueryResult<{ user_id: string }> = await pool.query(
    `select distinct ur.user_id
       from identity.user_roles ur
       join identity.roles r on r.id = ur.role_id
       join identity.users u on u.id = ur.user_id
      where r.code = any($1::text[]) and ur.revoked_at is null and u.is_active = true
      order by ur.user_id`,
    [targetRoles],
  );
  return result.rows.map((row) => row.user_id);
}

/** N-19: 'طابور المعالجة اليدوية' — one stale pending row is enough to trip its
 *  `min(created_at) < now() - interval '48 hours'` branch of the HAVING clause. */
async function insertOldPendingQueueRow(integration: string, ageHours: number): Promise<void> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into platform.integration_queue (integration, payload, status, created_at)
     values ($1, '{}'::jsonb, 'pending', now() - ($2 || ' hours')::interval)
     returning id`,
    [integration, ageHours],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture platform.integration_queue insert returned no row');
  fixtureQueueIds.push(row.id);
  fixtureN19EntityRefs.push(integration);
}

/** N-01: 'وكيل iMile متوقف > ١٥ دقيقة' — `having max(h.last_pull_at) < now() - interval '15
 *  minutes'`. On an EMPTY imile.agent_health table max() is NULL and `NULL < ...` is UNKNOWN, not
 *  true — the HAVING clause then drops the (only, aggregate) row, so the rule does NOT fire. One
 *  real row with a stale last_pull_at is required (unlike N-16's empty-table case, whose HAVING
 *  compares against -infinity via coalesce, always true). */
async function insertStaleAgentHealthRow(agentId: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into imile.agent_health (agent_id, session_valid, last_pull_at)
     values ($1, true, now() - interval '30 minutes')
     returning id`,
    [agentId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture imile.agent_health insert returned no row');
  return row.id;
}

/** N-06: 'عقد عميل ينتهي خلال مدة الإشعار' — notice_days = 0 and end_date = today trips
 *  `end_date - coalesce(notice_days,30) <= current_date`. */
async function insertExpiringContract(docNo: string): Promise<void> {
  const accountResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [`_alert513_${randomUUID()}`, 'عميل اختبار تنبيهات العقود'],
  );
  const accountId = (accountResult.rows[0] as { id: string }).id;
  fixtureAccountIds.push(accountId);

  const contractResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.contracts (entity_id, doc_no, account_id, title, status, start_date, end_date, notice_days)
     values ($1, $2, $3, 'fixture contract', 'active', current_date - interval '365 days', current_date, 0)
     returning id`,
    [entityId, docNo, accountId],
  );
  const row = contractResult.rows[0];
  if (!row) throw new Error('fixture sales.contracts insert returned no row');
  fixtureContractIds.push(row.id);
  fixtureContractDocNos.push(docNo);
}

/** N-03: 'فرق COD غير مسوّى' — `t.is_cod and t.status = 'delivered' and coalesce(t.cod_collected,0)
 *  <> coalesce(t.cod_amount,0) and t.completed_at >= current_date - 7`. entity_ref = t.doc_no.
 *  tms.delivery_tasks is BOTH `client_portal_scope` (is_internal() OR client match) AND
 *  `entity_scope` (is_internal() AND entity in allowed_entities()) — roleCtx already satisfies
 *  both (isInternal: true + the identity.user_entities row inserted in beforeAll). */
async function insertCodVarianceDeliveryTask(docNo: string): Promise<void> {
  const accountResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [`_alert513_n03_${randomUUID()}`, 'عميل اختبار فرق التحصيل'],
  );
  const accountId = (accountResult.rows[0] as { id: string }).id;
  fixtureAccountIds.push(accountId);

  const taskResult: QueryResult<{ id: string }> = await pool.query(
    `insert into tms.delivery_tasks
       (entity_id, doc_no, client_id, status, is_cod, cod_amount, cod_collected, completed_at)
     values ($1, $2, $3, 'delivered', true, 100.000, 80.000, now() - interval '1 day')
     returning id`,
    [entityId, docNo, accountId],
  );
  const row = taskResult.rows[0];
  if (!row) throw new Error('fixture tms.delivery_tasks insert returned no row');
  fixtureDeliveryTaskIds.push(row.id);
}

/** N-21: 'مطابقة بنكية غير مكتملة > ٧ أيام' — `rc.reconciled_at is null and rc.received_at <
 *  current_date - 7`. entity_ref = rc.doc_no. Sorts AFTER "N-19" (`order by code`) — fix round 2
 *  finding 2's "a rule that sorts after N-19 still ran" proof, distinct from N-03 (sorts before).
 *  billing.receipts is `entity_scope` — the same identity.user_entities row already covers it. */
async function insertUnreconciledReceipt(docNo: string): Promise<void> {
  const accountResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [`_alert513_n21_${randomUUID()}`, 'عميل اختبار مطابقة بنكية'],
  );
  const accountId = (accountResult.rows[0] as { id: string }).id;
  fixtureAccountIds.push(accountId);

  const receiptResult: QueryResult<{ id: string }> = await pool.query(
    `insert into billing.receipts (entity_id, doc_no, client_id, received_at, method, amount, recorded_by)
     values ($1, $2, $3, current_date - 10, 'bank_transfer', 100.000, $4)
     returning id`,
    [entityId, docNo, accountId, ROLE_ACTOR_UUID],
  );
  const row = receiptResult.rows[0];
  if (!row) throw new Error('fixture billing.receipts insert returned no row');
  fixtureReceiptIds.push(row.id);
}

async function insertFiredAlertLogRow(
  ruleCode: string,
  entityRef: string,
): Promise<{ id: number; version: number }> {
  const result: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into platform.alert_log (rule_code, entity_ref, fired_at, recipients, version)
     values ($1, $2, now(), $3::uuid[], 1) returning id, version`,
    [ruleCode, entityRef, [ROLE_ACTOR_UUID]],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture platform.alert_log insert returned no row');
  const id = Number(row.id);
  fixtureAlertLogIds.push(id);
  return { id, version: row.version };
}

async function getAlertLogRow(id: number): Promise<{
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
  version: number;
}> {
  const result: QueryResult<{ acknowledged_at: Date | null; acknowledged_by: string | null; version: number }> =
    await pool.query(`select acknowledged_at, acknowledged_by, version from platform.alert_log where id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw new Error(`no platform.alert_log row for id ${id}`);
  return row;
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  entityId = (entityResult.rows[0] as { id: string }).id;

  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [ROLE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [ROLE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [ROLE_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [ROLE_ACTOR_UUID, `_alert513_actor_${randomUUID()}@test.invalid`, 'ممثل اختبار تقييم التنبيهات — WBS 5.13'],
  );
  // N-06's source_query reads sales.contracts, an entity_scope RLS table
  // (entity_id = any(platform.allowed_entities())) — unlike alert_log/user_roles/integration_queue
  // (internal_only, keyed on ctx.isInternal alone), this ALSO needs a real identity.user_entities
  // row, same as the golden slice's own fixture pattern
  // (modules/wms/tests/receive-inbound/receive-inbound.test.ts ~L363-367).
  await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [
    ROLE_ACTOR_UUID,
    entityId,
  ]);
});

afterAll(async () => {
  if (usedCorrelationIds.size > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [[...usedCorrelationIds]]);
  }
  if (fixtureAlertLogIds.length > 0) {
    await pool.query(`delete from platform.alert_log where id = any($1::bigint[])`, [fixtureAlertLogIds]);
  }
  // Rows evaluateAlertRules itself wrote as a side effect of firing N-19/N-06 against the fixtures
  // below (distinct from fixtureAlertLogIds, which are pre-inserted rows for the acknowledge tests).
  if (fixtureN19EntityRefs.length > 0) {
    await pool.query(`delete from platform.alert_log where rule_code = 'N-19' and entity_ref = any($1::text[])`, [
      fixtureN19EntityRefs,
    ]);
  }
  if (fixtureContractDocNos.length > 0) {
    await pool.query(`delete from platform.alert_log where rule_code = 'N-06' and entity_ref = any($1::text[])`, [
      fixtureContractDocNos,
    ]);
  }
  if (fixtureQueueIds.length > 0) {
    await pool.query(`delete from platform.integration_queue where id = any($1::uuid[])`, [fixtureQueueIds]);
  }
  if (fixtureContractIds.length > 0) {
    await pool.query(`delete from sales.contracts where id = any($1::uuid[])`, [fixtureContractIds]);
  }
  if (fixtureDeliveryTaskIds.length > 0) {
    await pool.query(`delete from tms.delivery_tasks where id = any($1::uuid[])`, [fixtureDeliveryTaskIds]);
  }
  if (fixtureReceiptIds.length > 0) {
    await pool.query(`delete from billing.receipts where id = any($1::uuid[])`, [fixtureReceiptIds]);
  }
  if (fixtureAccountIds.length > 0) {
    await pool.query(`delete from sales.accounts where id = any($1::uuid[])`, [fixtureAccountIds]);
  }
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [ROLE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [ROLE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [ROLE_ACTOR_UUID]);
  await pool.end();
  await appPool.end();
});

// --- contract stub (package subpath import) -------------------------------------------------

describe('@pg-eos/contracts/platform/evaluate-alerts — schemas', () => {
  it('EvaluateAlertRulesInputSchema accepts { correlationId } alone (ruleCode optional)', () => {
    const parsed = EvaluateAlertRulesInputSchema.parse({ correlationId: randomUUID() });
    expect(parsed.ruleCode).toBeUndefined();
  });

  it('EvaluateAlertRulesInputSchema accepts a valid ruleCode ("N-19") and rejects a malformed one', () => {
    const parsed = EvaluateAlertRulesInputSchema.parse({ ruleCode: 'N-19', correlationId: randomUUID() });
    expect(parsed.ruleCode).toBe('N-19');
    expect(() => EvaluateAlertRulesInputSchema.parse({ ruleCode: 'nope', correlationId: randomUUID() })).toThrow();
  });

  it('AcknowledgeAlertInputSchema requires alertLogId, expectedVersion >= 1, correlationId', () => {
    const parsed = AcknowledgeAlertInputSchema.parse({ alertLogId: 1, expectedVersion: 1, correlationId: randomUUID() });
    expect(parsed.alertLogId).toBe(1);
    expect(() =>
      AcknowledgeAlertInputSchema.parse({ alertLogId: 1, expectedVersion: 0, correlationId: randomUUID() }),
    ).toThrow();
  });
});

// --- Scenario: seed-data guards (doc 40 §B6 / doc 25 §1-2, DB-backed, read-only) -----------------

describe('Seed-data guards — platform.alert_rules (13B L2839-3043, migration 0011)', () => {
  it('has exactly 22 rows (G-SEED)', async () => {
    const result: QueryResult<{ n: string }> = await pool.query(`select count(*)::text as n from platform.alert_rules`);
    expect(Number(result.rows[0]?.n)).toBe(SEEDED_ALERT_RULE_COUNT);
  });

  it('every row has a non-empty action_label and an action_link starting with "/"', async () => {
    const result: QueryResult<{ code: string }> = await pool.query(
      `select code from platform.alert_rules
        where action_label is null or trim(action_label) = ''
           or action_link is null or action_link !~ '^/'`,
    );
    expect(result.rows).toHaveLength(0);
  });

  it('quiet_hours = false ONLY for N-01 and N-03', async () => {
    const result: QueryResult<{ code: string }> = await pool.query(
      `select code from platform.alert_rules where quiet_hours = false order by code`,
    );
    expect(result.rows.map((row) => row.code)).toEqual(['N-01', 'N-03']);
  });

  it('no target_roles or escalate_to_roles array contains OPS_DIR or HR_MGR', async () => {
    const result: QueryResult<{ code: string }> = await pool.query(
      `select code from platform.alert_rules
        where 'OPS_DIR' = any(target_roles) or 'HR_MGR' = any(target_roles)
           or 'OPS_DIR' = any(coalesce(escalate_to_roles, '{}')) or 'HR_MGR' = any(coalesce(escalate_to_roles, '{}'))`,
    );
    expect(result.rows).toHaveLength(0);
  });

  it('exactly one inactive row, and it is N-16', async () => {
    const result: QueryResult<{ code: string }> = await pool.query(
      `select code from platform.alert_rules where is_active = false`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.code).toBe('N-16');
  });

  it('every role code named in target_roles/escalate_to_roles exists in identity.roles', async () => {
    const result: QueryResult<{ role_code: string }> = await pool.query(`
      select distinct role_code from (
        select unnest(target_roles) as role_code from platform.alert_rules
        union
        select unnest(escalate_to_roles) as role_code from platform.alert_rules where escalate_to_roles is not null
      ) roles
      where role_code not in (select code from identity.roles)
    `);
    expect(result.rows).toHaveLength(0);
  });
});

// --- Scenario: a rule fires when its source_query returns a row ---------------------------------

describe('Scenario: a rule fires when its source_query returns a row (N-19)', () => {
  it('writes exactly one platform.alert_log row, one outbox row (correct aggregate/payload) and one audit row, same transaction', async () => {
    clock.set(new Date(KUWAIT_DAYTIME_UTC));
    const integration = `_alert513_fires_${randomUUID()}`;
    await insertOldPendingQueueRow(integration, OLD_QUEUE_ROW_AGE_HOURS);
    const ruleId = await ruleIdByCode('N-19');

    const correlationId = nextCorrelationId();
    const result = await evaluateAlertRules({ ruleCode: 'N-19', correlationId }, roleCtx, deps);
    expect(result.fired).toHaveLength(1);
    const firedEntry = result.fired[0];
    if (!firedEntry) throw new Error('expected one N-19 fired entry');
    expect(firedEntry.ruleCode).toBe('N-19');
    expect(firedEntry.entityRef).toBe(integration);

    const rows = await alertLogRowsForRuleAndEntityRef('N-19', integration);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error('expected one N-19 alert_log row');
    expect(row.id).toBe(firedEntry.alertLogId);
    expect(row.fired_at.toISOString()).toBe(clock.now().toISOString());
    expect(row.version).toBe(1);

    const expectedRecipients = await expectedRecipientsFor(N19_TARGET_ROLES);
    expect([...(row.recipients ?? [])].sort()).toEqual([...expectedRecipients].sort());

    // Exact-count outbox assertion — aggregate_type/aggregate_id/payload (fix round 1 finding 10).
    const outboxResult: QueryResult<{ aggregate_type: string; aggregate_id: string; payload: Record<string, unknown> }> =
      await pool.query(
        `select aggregate_type, aggregate_id, payload from platform.outbox
          where correlation_id = $1 and event_type = $2`,
        [correlationId, ALERT_FIRED_EVENT_TYPE],
      );
    expect(outboxResult.rows).toHaveLength(1);
    const outboxRow = outboxResult.rows[0];
    if (!outboxRow) throw new Error('expected one outbox row');
    expect(outboxRow.aggregate_type).toBe(ALERT_RULES_AGGREGATE_TYPE);
    expect(outboxRow.aggregate_id).toBe(ruleId);
    expect(outboxRow.payload['alertLogId']).toBe(firedEntry.alertLogId);
    expect(outboxRow.payload['ruleCode']).toBe('N-19');
    expect(outboxRow.payload['entityRef']).toBe(integration);

    // Exact-count audit assertion (fix round 1 finding 10): operation 'insert', record_id NULL,
    // the bigint alert_log id living in new_value.id instead (record_id is uuid).
    const auditRows = await auditRowsForCorrelation(correlationId);
    expect(auditRows).toHaveLength(1);
    const auditRow = auditRows[0];
    if (!auditRow) throw new Error('expected one audit row');
    expect(auditRow.operation).toBe('insert');
    expect(auditRow.record_id).toBeNull();
    expect(auditRow.new_value['id']).toBe(firedEntry.alertLogId);
  });
});

// --- Scenario: dedupe within a non-zero window ---------------------------------------------------

describe('Scenario: a rule does not fire twice inside its non-zero dedupe window (N-19, dedupe_window_hours = 6)', () => {
  it('a second immediate evaluation writes no additional platform.alert_log row', async () => {
    clock.set(new Date(KUWAIT_DAYTIME_UTC));
    const integration = `_alert513_dedupe_${randomUUID()}`;
    await insertOldPendingQueueRow(integration, OLD_QUEUE_ROW_AGE_HOURS);

    await evaluateAlertRules({ ruleCode: 'N-19', correlationId: nextCorrelationId() }, roleCtx, deps);
    expect(await alertLogRowsForRuleAndEntityRef('N-19', integration)).toHaveLength(1);

    await evaluateAlertRules({ ruleCode: 'N-19', correlationId: nextCorrelationId() }, roleCtx, deps);
    expect(await alertLogRowsForRuleAndEntityRef('N-19', integration)).toHaveLength(1);
  });
});

// --- Scenario: dedupe_window_hours = 0 means no suppression --------------------------------------

describe('Scenario: dedupe_window_hours = 0 means no suppression (N-06)', () => {
  it('two consecutive evaluations both write a platform.alert_log row', async () => {
    clock.set(new Date(KUWAIT_DAYTIME_UTC));
    const docNo = `_alert513-n06-${randomUUID()}`;
    await insertExpiringContract(docNo);

    await evaluateAlertRules({ ruleCode: 'N-06', correlationId: nextCorrelationId() }, roleCtx, deps);
    expect(await alertLogRowsForRuleAndEntityRef('N-06', docNo)).toHaveLength(1);

    await evaluateAlertRules({ ruleCode: 'N-06', correlationId: nextCorrelationId() }, roleCtx, deps);
    expect(await alertLogRowsForRuleAndEntityRef('N-06', docNo)).toHaveLength(2);
  });
});

// --- Scenario: quiet hours suppress a non-exempt rule ---------------------------------------------

describe('Scenario: quiet hours suppress a non-exempt rule (N-19, quiet_hours = true), then fire once quiet hours end', () => {
  it('writes nothing at 23:00 Kuwait, then fires at 08:00 Kuwait for the SAME unfired condition', async () => {
    const integration = `_alert513_quiet_${randomUUID()}`;
    await insertOldPendingQueueRow(integration, OLD_QUEUE_ROW_AGE_HOURS);

    clock.set(new Date(KUWAIT_QUIET_2300_UTC));
    await evaluateAlertRules({ ruleCode: 'N-19', correlationId: nextCorrelationId() }, roleCtx, deps);
    expect(await alertLogRowsForRuleAndEntityRef('N-19', integration)).toHaveLength(0);

    clock.set(new Date(KUWAIT_0800_NEXT_DAY_UTC));
    await evaluateAlertRules({ ruleCode: 'N-19', correlationId: nextCorrelationId() }, roleCtx, deps);
    expect(await alertLogRowsForRuleAndEntityRef('N-19', integration)).toHaveLength(1);
  });
});

// --- Scenario: quiet hours never suppress the emergency-exempt rules -----------------------------

describe('Scenario: quiet hours never suppress N-01 (quiet_hours = false, doc 25 §1 exemption)', () => {
  it('N-01 still fires at 23:00 Kuwait', async () => {
    const agentHealthId = await insertStaleAgentHealthRow(`_alert513_n01_${randomUUID()}`);
    try {
      clock.set(new Date(KUWAIT_QUIET_2300_UTC));
      const before = await alertLogCountForRule('N-01');
      const maxIdBefore = await maxAlertLogId('N-01');

      await evaluateAlertRules({ ruleCode: 'N-01', correlationId: nextCorrelationId() }, roleCtx, deps);

      const after = await alertLogCountForRule('N-01');
      expect(after).toBe(before + 1);
      await registerAlertLogIdsSince('N-01', maxIdBefore); // afterAll cleanup — see helper comment.
    } finally {
      await pool.query(`delete from imile.agent_health where id = $1`, [agentHealthId]);
    }
  });
});

// --- Scenario: the superseded rule (N-16) never fires, even when explicitly requested -------------

describe('Scenario: the superseded rule never fires (N-16, is_active = false after migration 0011)', () => {
  it('an explicit ruleCode: "N-16" call writes no row, even though its own query returns a row on empty integration_runs', async () => {
    clock.set(new Date(KUWAIT_DAYTIME_UTC));
    const before = await alertLogCountForRule('N-16');

    await evaluateAlertRules({ ruleCode: 'N-16', correlationId: nextCorrelationId() }, roleCtx, deps);

    const after = await alertLogCountForRule('N-16');
    expect(after).toBe(before);
  });
});

// --- Scenario: ruleCode omitted evaluates every active rule, excluding N-16 ------------------------

describe('Scenario: ruleCode omitted evaluates every active rule (N-16 excluded)', () => {
  it('a fresh N-19 condition fires as part of the "evaluate all" pass, N-16 still never fires, evaluated/failed are exact', async () => {
    clock.set(new Date(KUWAIT_DAYTIME_UTC));
    const integration = `_alert513_all_${randomUUID()}`;
    await insertOldPendingQueueRow(integration, OLD_QUEUE_ROW_AGE_HOURS);
    const n16Before = await alertLogCountForRule('N-16');
    const activeCount = await activeAlertRuleCount();
    // fix round 1 finding 18: a ruleCode-omitted call may genuinely fire ANY active rule against
    // real seeded data, not just N-19 — record the watermark and delete every newer row below,
    // instead of leaving them behind (platform.audit_log stays — it is append-only).
    const globalMaxIdBefore = await globalMaxAlertLogId();

    const result = await evaluateAlertRules({ correlationId: nextCorrelationId() }, roleCtx, deps);

    // fix round 2 finding 2: exact, not just "the fixture fired" — every active rule genuinely ran,
    // none reported a failure, on the real seeded database.
    expect(result.evaluated).toBe(activeCount);
    expect(result.failed).toEqual([]);
    expect(await alertLogRowsForRuleAndEntityRef('N-19', integration)).toHaveLength(1);
    expect(await alertLogCountForRule('N-16')).toBe(n16Before);

    await registerAllAlertLogIdsSince(globalMaxIdBefore);
  });
});

// --- Scenario: N-03 (quiet_hours = false, dedupe_window_hours = 0) fires at 23:00 Kuwait ----------
// fix round 1 finding 10: the feature file named N-13/N-03/N-02 while the tests actually ran
// N-19/N-06/N-19 — this is the real N-03 exemption test the feature's "quiet hours never suppress"
// scenario names, with full outbox-payload / aggregate / audit assertions.

describe('Scenario: N-03 fires at 23:00 Kuwait (quiet_hours = false, doc 25 §1 exemption) — full payload/aggregate/audit', () => {
  it('fires despite quiet hours; outbox carries the exact payload + aggregate_type/aggregate_id; exactly one audit row', async () => {
    const docNo = `_alert513_n03_${randomUUID()}`;
    await insertCodVarianceDeliveryTask(docNo);
    const ruleId = await ruleIdByCode('N-03');

    clock.set(new Date(KUWAIT_QUIET_2300_UTC));
    const correlationId = nextCorrelationId();
    const result = await evaluateAlertRules({ ruleCode: 'N-03', correlationId }, roleCtx, deps);

    expect(result.fired).toHaveLength(1);
    const firedEntry = result.fired[0];
    if (!firedEntry) throw new Error('expected one N-03 fired entry');
    expect(firedEntry.ruleCode).toBe('N-03');
    expect(firedEntry.entityRef).toBe(docNo);
    fixtureAlertLogIds.push(firedEntry.alertLogId);

    const outboxResult: QueryResult<{ aggregate_type: string; aggregate_id: string; payload: Record<string, unknown> }> =
      await pool.query(
        `select aggregate_type, aggregate_id, payload from platform.outbox
          where correlation_id = $1 and event_type = $2`,
        [correlationId, ALERT_FIRED_EVENT_TYPE],
      );
    expect(outboxResult.rows).toHaveLength(1);
    const outboxRow = outboxResult.rows[0];
    if (!outboxRow) throw new Error('expected one outbox row');
    expect(outboxRow.aggregate_type).toBe(ALERT_RULES_AGGREGATE_TYPE);
    expect(outboxRow.aggregate_id).toBe(ruleId);
    expect(outboxRow.payload['alertLogId']).toBe(firedEntry.alertLogId);
    expect(outboxRow.payload['ruleCode']).toBe('N-03');
    expect(outboxRow.payload['entityRef']).toBe(docNo);

    const auditRows = await auditRowsForCorrelation(correlationId);
    expect(auditRows).toHaveLength(1);
    const auditRow = auditRows[0];
    if (!auditRow) throw new Error('expected one audit row');
    expect(auditRow.operation).toBe('insert');
    expect(auditRow.record_id).toBeNull();
    expect(auditRow.new_value['id']).toBe(firedEntry.alertLogId);
  });
});

// --- Scenario: permission — EvaluateAlertRules requires the internal role -------------------------

describe('Scenario: EvaluateAlertRules without the internal role is rejected', () => {
  it('ctx.isInternal = false -> RoleRequiredError, nothing written', async () => {
    clock.set(new Date(KUWAIT_DAYTIME_UTC));
    const integration = `_alert513_noperm_${randomUUID()}`;
    await insertOldPendingQueueRow(integration, OLD_QUEUE_ROW_AGE_HOURS);

    await expect(
      evaluateAlertRules({ ruleCode: 'N-19', correlationId: nextCorrelationId() }, nonInternalCtx, deps),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    expect(await alertLogRowsForRuleAndEntityRef('N-19', integration)).toHaveLength(0);
  });
});

// --- Scenario: RLS — an out-of-scope caller (fix round 1 finding 11) -----------------------------

describe('Scenario: AcknowledgeAlert without the internal role is rejected', () => {
  it('ctx.isInternal = false -> RoleRequiredError, row unchanged', async () => {
    const { id, version } = await insertFiredAlertLogRow('N-13', `_alert513_ack_noperm_${randomUUID()}`);

    await expect(
      acknowledgeAlert({ alertLogId: id, expectedVersion: version, correlationId: nextCorrelationId() }, nonInternalCtx, deps),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    const row = await getAlertLogRow(id);
    expect(row.acknowledged_at).toBeNull();
    expect(row.version).toBe(version);
  });
});

describe('Scenario: RLS — a genuine row is visible with is_internal = true, invisible with false', () => {
  it('the SAME session, same fixture row: app.is_internal = true sees it, false sees zero', async () => {
    // fix round 2 finding 6: the round-1 version asserted "0 rows" against an otherwise-EMPTY
    // table from the pgeos_app session's own point of view — trivially true whether or not RLS did
    // anything at all. This version inserts a real row first, so "invisible" is a genuine RLS
    // effect, not an empty-table accident.
    const { id } = await insertFiredAlertLogRow('N-13', `_alert513_rls_${randomUUID()}`);

    const client = await appPool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.user_id', $1, true)`, [ROLE_ACTOR_UUID]);
      await client.query(`select set_config('app.client_id', $1, true)`, [null]);

      await client.query(`select set_config('app.is_internal', 'true', true)`);
      const visible: QueryResult<{ n: string }> = await client.query(
        `select count(*)::text as n from platform.alert_log where id = $1`,
        [id],
      );
      expect(Number(visible.rows[0]?.n)).toBe(1);

      await client.query(`select set_config('app.is_internal', 'false', true)`);
      const invisible: QueryResult<{ n: string }> = await client.query(
        `select count(*)::text as n from platform.alert_log where id = $1`,
        [id],
      );
      expect(Number(invisible.rows[0]?.n)).toBe(0);

      await client.query('rollback');
    } finally {
      client.release();
    }
  });
});

// --- Scenario: a source_query that would WRITE is rejected, other rules in the pass still fire ---
// fix round 1 "New RED tests for pg-backend's fixes" (1): each rule runs read-only in its own
// savepoint — a data-changing or erroring source_query is skipped (reported in `failed`), never
// aborts the pass, never changes data.

describe('Scenario: a rule whose source_query would write is rejected by its own read-only savepoint, without aborting the pass', () => {
  it('a data-changing CTE: exact `failed`/`evaluated`, table genuinely unchanged, companions before AND after N-19 (order by code) still fire', async () => {
    clock.set(new Date(KUWAIT_DAYTIME_UTC));
    const originalN19Query = await sourceQueryFor('N-19');
    const writingQuery =
      "with d as (update platform.alert_rules set name_ar = name_ar where code = 'N-19' returning code) " +
      'select code as entity_ref from d';
    await setSourceQuery('N-19', writingQuery);
    const checksumAfterCorruption = await alertRulesChecksum();

    const n03DocNo = `_alert513_savepoint_write_n03_${randomUUID()}`;
    const n21DocNo = `_alert513_savepoint_write_n21_${randomUUID()}`;
    await insertCodVarianceDeliveryTask(n03DocNo); // N-03 sorts BEFORE N-19.
    await insertUnreconciledReceipt(n21DocNo); // N-21 sorts AFTER N-19 (fix round 2 finding 2).
    const activeCount = await activeAlertRuleCount();
    const globalMaxIdBefore = await globalMaxAlertLogId();

    try {
      const result = await evaluateAlertRules({ correlationId: nextCorrelationId() }, roleCtx, deps);

      // fix round 2 finding 2: exact, not `.some(...)`.
      expect(result.failed).toEqual([{ ruleCode: 'N-19', reason: expect.any(String) }]);
      expect(result.evaluated).toBe(activeCount - 1); // N-19's own runSourceQueryReadOnly never
      // reached the `evaluated += 1` line (it threw) — every OTHER active rule still counted.

      // The CTE's own entity_ref literal would be 'N-19' if the write had actually gone through —
      // asserting its total absence is a stronger, RLS-safe proxy than re-reading source_query
      // itself (which this test controls directly, in `finally`).
      expect(await alertLogRowsForRuleAndEntityRef('N-19', 'N-19')).toHaveLength(0);
      expect(await alertLogRowsForRuleAndEntityRef('N-03', n03DocNo)).toHaveLength(1);
      expect(await alertLogRowsForRuleAndEntityRef('N-21', n21DocNo)).toHaveLength(1);

      // fix round 2 finding 1: a REAL "table unchanged" proxy — checksum immediately before the
      // call (post-corruption baseline) vs. immediately after, not `name_ar = name_ar`.
      expect(await alertRulesChecksum()).toBe(checksumAfterCorruption);

      await registerAllAlertLogIdsSince(globalMaxIdBefore);
    } finally {
      await setSourceQuery('N-19', originalN19Query);
    }
  });

  it('a multi-statement source_query is rejected the same way, without aborting the pass', async () => {
    clock.set(new Date(KUWAIT_DAYTIME_UTC));
    const originalN19Query = await sourceQueryFor('N-19');
    await setSourceQuery('N-19', 'select 1 as entity_ref; select 2');
    const checksumAfterCorruption = await alertRulesChecksum();

    const docNo = `_alert513_savepoint_multi_${randomUUID()}`;
    await insertCodVarianceDeliveryTask(docNo);
    const n19CountBefore = await alertLogCountForRule('N-19');
    const activeCount = await activeAlertRuleCount();
    const globalMaxIdBefore = await globalMaxAlertLogId();

    try {
      const result = await evaluateAlertRules({ correlationId: nextCorrelationId() }, roleCtx, deps);

      expect(result.failed).toEqual([{ ruleCode: 'N-19', reason: expect.any(String) }]);
      expect(result.evaluated).toBe(activeCount - 1);
      expect(await alertLogCountForRule('N-19')).toBe(n19CountBefore); // the rejected call wrote nothing.
      expect(await alertLogRowsForRuleAndEntityRef('N-03', docNo)).toHaveLength(1);
      expect(await alertRulesChecksum()).toBe(checksumAfterCorruption);

      await registerAllAlertLogIdsSince(globalMaxIdBefore);
    } finally {
      await setSourceQuery('N-19', originalN19Query);
    }
  });

  it('a write failure AFTER a successful insert of the same rule rolls back that rule entirely — result.fired never names a row that does not exist', async () => {
    // pg-reviewer round 3 finding 1 (MEDIUM, Master fix under D-117): `fired`/`deduped` used to be
    // mutated INSIDE the per-rule savepoint callback. Two fresh N-19 entity_refs; the repo's
    // writeAuditRow throws on its SECOND call, i.e. after the first entity_ref's alert_log +
    // outbox + audit rows were written. The savepoint rolls back both; the result must not carry
    // an alertLogId that no longer exists, and N-19 must appear in `failed` only.
    clock.set(new Date(KUWAIT_DAYTIME_UTC));
    const integrationA = `_alert513_rollback_a_${randomUUID()}`;
    const integrationB = `_alert513_rollback_b_${randomUUID()}`;
    await insertOldPendingQueueRow(integrationA, 72);
    await insertOldPendingQueueRow(integrationB, 72);
    const globalMaxIdBefore = await globalMaxAlertLogId();
    const logger = spyLogger();
    const realDeps = createEvaluateAlertsDeps({ clock, ids, logger });
    let auditCalls = 0;
    const thrown = new Error('audit write failed on purpose after a successful insert');
    const brokenDeps = {
      ...realDeps,
      repo: {
        ...realDeps.repo,
        writeAuditRow: async (...args: Parameters<typeof realDeps.repo.writeAuditRow>): Promise<void> => {
          auditCalls += 1;
          if (auditCalls === 2) throw thrown;
          return realDeps.repo.writeAuditRow(...args);
        },
      },
    };
    const correlationId = nextCorrelationId();

    const result = await evaluateAlertRules({ ruleCode: 'N-19', correlationId }, roleCtx, brokenDeps);

    expect(auditCalls).toBe(2); // the first entity_ref's audit row WAS written before the failure.
    expect(result.failed).toEqual([{ ruleCode: 'N-19', reason: expect.any(String) }]);
    expect(result.fired.map((f) => f.ruleCode)).not.toContain('N-19');
    expect(result.fired).toHaveLength(0);
    expect(await alertLogRowsForRuleAndEntityRef('N-19', integrationA)).toHaveLength(0);
    expect(await alertLogRowsForRuleAndEntityRef('N-19', integrationB)).toHaveLength(0);
    const outboxResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from platform.outbox where correlation_id = $1`,
      [correlationId],
    );
    expect(outboxResult.rows[0]?.n).toBe('0');
    expect(await globalMaxAlertLogId()).toBe(globalMaxIdBefore); // nothing of this pass survived.
    expect(logger.errorCalls.some(([fields]) => fields.ruleCode === 'N-19')).toBe(true);
  });

  it('a plain-SELECT-shaped query that WRITES at runtime (nextval) is rejected by "set local transaction_read_only", the sequence never moves', async () => {
    // fix round 2 finding 1 (HIGH): the CTE/multi-statement/broken cases above are all rejected
    // BEFORE the read-only guard is ever reached (parser-level or missing-table errors) — deleting
    // `set local transaction_read_only = on` (repository.ts) would keep every one of them green.
    // `nextval(...)` is syntactically a plain, single-statement SELECT (parses fine) but mutates
    // sequence state at RUN TIME — Postgres itself refuses it ONLY because of the read-only GUC.
    clock.set(new Date(KUWAIT_DAYTIME_UTC));
    const originalN19Query = await sourceQueryFor('N-19');
    await setSourceQuery('N-19', "select nextval('platform.alert_log_id_seq')::text as entity_ref");
    const checksumAfterCorruption = await alertRulesChecksum();
    const sequenceBefore = await alertLogSequenceState();

    const n03DocNo = `_alert513_savepoint_nextval_n03_${randomUUID()}`;
    const n21DocNo = `_alert513_savepoint_nextval_n21_${randomUUID()}`;
    await insertCodVarianceDeliveryTask(n03DocNo);
    await insertUnreconciledReceipt(n21DocNo);
    const n19CountBefore = await alertLogCountForRule('N-19');
    const activeCount = await activeAlertRuleCount();
    const globalMaxIdBefore = await globalMaxAlertLogId();
    const logger = spyLogger();
    const spyDeps = createEvaluateAlertsDeps({ clock, ids, logger });
    const correlationId = nextCorrelationId();

    try {
      const result = await evaluateAlertRules({ correlationId }, roleCtx, spyDeps);

      expect(result.failed).toHaveLength(1);
      const failure = result.failed[0];
      if (!failure) throw new Error('expected exactly one failure');
      expect(failure.ruleCode).toBe('N-19');
      expect(failure.reason).toMatch(/read-only transaction/);
      expect(result.evaluated).toBe(activeCount - 1);

      expect(await alertLogCountForRule('N-19')).toBe(n19CountBefore);
      expect(await alertLogRowsForRuleAndEntityRef('N-03', n03DocNo)).toHaveLength(1);
      expect(await alertLogRowsForRuleAndEntityRef('N-21', n21DocNo)).toHaveLength(1);

      // The rejected nextval() consumed NO sequence value — the clearest possible proof the write
      // was rejected, not merely that its RESULT was discarded. The sequence DOES legitimately
      // advance by one per alert_log row this same pass inserted (N-03 + N-21 fired above), so the
      // exact expectation is before + fired.length, not "unchanged" (Master fix, round 3: the
      // earlier `toEqual(sequenceBefore)` ignored those two legitimate inserts).
      const sequenceAfter = await alertLogSequenceState();
      expect(sequenceAfter.isCalled).toBe(true);
      expect(BigInt(sequenceAfter.lastValue) - BigInt(sequenceBefore.lastValue)).toBe(
        BigInt(result.fired.length),
      );
      // Other seeded rules with dedupe 0 or fresh entity_refs may also fire in a full-suite pass;
      // what matters is that N-19 is not among them and every sequence value maps to a fired row.
      expect(result.fired.map((f) => f.ruleCode)).not.toContain('N-19');
      expect(result.fired.map((f) => f.ruleCode)).toEqual(expect.arrayContaining(['N-03', 'N-21']));
      // Table-unchanged proxy (finding 1), same pattern as the CTE case above.
      expect(await alertRulesChecksum()).toBe(checksumAfterCorruption);

      // fix round 2 finding 10: the failed-rule error line (round-1 finding 2's own logger.error
      // call) was never actually asserted — do it here, on the SAME failure this test produces.
      expect(logger.errorCalls).toHaveLength(1);
      const [errorObj] = logger.errorCalls[0] as [Record<string, unknown>, string];
      expect(errorObj['ruleCode']).toBe('N-19');
      expect(errorObj['correlationId']).toBe(correlationId);

      await registerAllAlertLogIdsSince(globalMaxIdBefore);
    } finally {
      await setSourceQuery('N-19', originalN19Query);
    }
  });
});

// --- Scenario: a broken source_query does not abort the pass -------------------------------------
// fix round 1 "New RED tests" (2).

describe('Scenario: one rule with a broken source_query does not abort the pass', () => {
  it('the broken rule appears EXACTLY ONCE in `failed`; other rules in the SAME pass still fire; evaluated is exact', async () => {
    clock.set(new Date(KUWAIT_DAYTIME_UTC));
    const originalN19Query = await sourceQueryFor('N-19');
    await setSourceQuery('N-19', 'select from nowhere_table');
    const checksumAfterCorruption = await alertRulesChecksum();

    const docNo = `_alert513_savepoint_broken_${randomUUID()}`;
    await insertCodVarianceDeliveryTask(docNo);
    const activeCount = await activeAlertRuleCount();
    const globalMaxIdBefore = await globalMaxAlertLogId();

    try {
      const result = await evaluateAlertRules({ correlationId: nextCorrelationId() }, roleCtx, deps);

      expect(result.failed).toEqual([{ ruleCode: 'N-19', reason: expect.any(String) }]);
      expect(result.evaluated).toBe(activeCount - 1);
      expect(await alertLogRowsForRuleAndEntityRef('N-03', docNo)).toHaveLength(1);
      expect(await alertRulesChecksum()).toBe(checksumAfterCorruption);

      await registerAllAlertLogIdsSince(globalMaxIdBefore);
    } finally {
      await setSourceQuery('N-19', originalN19Query);
    }
  });
});

// --- Scenario: a null entity_ref is skipped with a warning, never aborts the rule -----------------
// fix round 2 finding 10 (round-1 findings 13/17 were never actually asserted).

describe('Scenario: a null entity_ref is skipped with a warning, not stringified, never aborts the rule', () => {
  it('N-19 -> select null::text as entity_ref: no alert_log row, exactly one warn line, N-19 NOT in `failed`', async () => {
    clock.set(new Date(KUWAIT_DAYTIME_UTC));
    const originalN19Query = await sourceQueryFor('N-19');
    await setSourceQuery('N-19', 'select null::text as entity_ref');
    const n19CountBefore = await alertLogCountForRule('N-19');
    const logger = spyLogger();
    const spyDeps = createEvaluateAlertsDeps({ clock, ids, logger });

    try {
      const result = await evaluateAlertRules(
        { ruleCode: 'N-19', correlationId: nextCorrelationId() },
        roleCtx,
        spyDeps,
      );

      expect(await alertLogCountForRule('N-19')).toBe(n19CountBefore);
      expect(result.failed.some((entry) => entry.ruleCode === 'N-19')).toBe(false);

      expect(logger.warnCalls).toHaveLength(1);
      const [warnObj] = logger.warnCalls[0] as [Record<string, unknown>, string];
      expect(warnObj['ruleCode']).toBe('N-19');
    } finally {
      await setSourceQuery('N-19', originalN19Query);
    }
  });
});

// --- Scenario: MissingActorError when ctx.userId is null ------------------------------------------
// fix round 1 "New RED tests" (6).

describe('Scenario: MissingActorError when ctx.userId is null', () => {
  it('evaluateAlertRules rejects with MissingActorError', async () => {
    await expect(
      evaluateAlertRules({ ruleCode: 'N-19', correlationId: nextCorrelationId() }, noActorCtx, deps),
    ).rejects.toBeInstanceOf(MissingActorError);
  });

  it('acknowledgeAlert rejects with MissingActorError, row unchanged', async () => {
    const { id, version } = await insertFiredAlertLogRow('N-13', `_alert513_missingactor_${randomUUID()}`);

    await expect(
      acknowledgeAlert({ alertLogId: id, expectedVersion: version, correlationId: nextCorrelationId() }, noActorCtx, deps),
    ).rejects.toBeInstanceOf(MissingActorError);

    const row = await getAlertLogRow(id);
    expect(row.acknowledged_at).toBeNull();
    expect(row.version).toBe(version);
  });
});

// --- Scenario: AlertLogNotFoundError for an unknown id ---------------------------------------------
// fix round 1 "New RED tests" (7).

describe('Scenario: AlertLogNotFoundError for an unknown alertLogId', () => {
  it('acknowledgeAlert rejects with AlertLogNotFoundError for a non-existent id', async () => {
    const alertLogId = await unknownAlertLogId();

    await expect(
      acknowledgeAlert({ alertLogId, expectedVersion: 1, correlationId: nextCorrelationId() }, roleCtx, deps),
    ).rejects.toBeInstanceOf(AlertLogNotFoundError);
  });
});

// --- Scenario: acknowledging an alert -------------------------------------------------------------

describe('Scenario: AcknowledgeAlert', () => {
  it('sets acknowledged_at/acknowledged_by = ctx.userId, bumps version 1 -> 2, writes EXACTLY ONE audit row', async () => {
    const { id, version } = await insertFiredAlertLogRow('N-13', `_alert513_ack_${randomUUID()}`);
    const correlationId = nextCorrelationId();

    await acknowledgeAlert({ alertLogId: id, expectedVersion: version, correlationId }, roleCtx, deps);

    const row = await getAlertLogRow(id);
    expect(row.acknowledged_at).not.toBeNull();
    expect(row.acknowledged_by).toBe(ROLE_ACTOR_UUID);
    expect(row.version).toBe(version + 1);

    // Exact-count audit assertion (fix round 1 finding 10): operation 'update', record_id NULL,
    // the bigint alert_log id living in new_value.id instead (record_id is uuid).
    const auditRows = await auditRowsForCorrelation(correlationId);
    expect(auditRows).toHaveLength(1);
    const auditRow = auditRows[0];
    if (!auditRow) throw new Error('expected one audit row');
    expect(auditRow.operation).toBe('update');
    expect(auditRow.record_id).toBeNull();
    expect(auditRow.new_value['id']).toBe(id);
  });

  it('rejects a stale expectedVersion with StaleVersionError, leaving the row unchanged', async () => {
    const { id, version } = await insertFiredAlertLogRow('N-13', `_alert513_stale_${randomUUID()}`);

    await expect(
      acknowledgeAlert({ alertLogId: id, expectedVersion: version + 999, correlationId: nextCorrelationId() }, roleCtx, deps),
    ).rejects.toBeInstanceOf(StaleVersionError);

    const row = await getAlertLogRow(id);
    expect(row.acknowledged_at).toBeNull();
    expect(row.version).toBe(version);
  });

  it('rejects acknowledging an already-acknowledged row with AlertAlreadyAcknowledgedError, not a silent no-op', async () => {
    const { id, version } = await insertFiredAlertLogRow('N-13', `_alert513_twice_${randomUUID()}`);
    await acknowledgeAlert({ alertLogId: id, expectedVersion: version, correlationId: nextCorrelationId() }, roleCtx, deps);

    await expect(
      acknowledgeAlert(
        { alertLogId: id, expectedVersion: version + 1, correlationId: nextCorrelationId() },
        roleCtx,
        deps,
      ),
    ).rejects.toBeInstanceOf(AlertAlreadyAcknowledgedError);
  });

  it('is idempotent: the same Idempotency-Key + body replays the stored result, version bumps exactly once', async () => {
    const { id, version } = await insertFiredAlertLogRow('N-13', `_alert513_idem_${randomUUID()}`);
    const idemKey = `ack-replay-${randomUUID()}`;
    const body = { alertLogId: id, expectedVersion: version, correlationId: nextCorrelationId() };

    const first = await acknowledgeAlert({ ...body, idem: idemFor('acknowledge-alert', idemKey, body) }, roleCtx, deps);
    // Same key, same body — even though expectedVersion is now stale against the bumped row, the
    // replay must return the FIRST response, not re-run the command.
    const second = await acknowledgeAlert({ ...body, idem: idemFor('acknowledge-alert', idemKey, body) }, roleCtx, deps);
    expect(second).toEqual(first);

    const row = await getAlertLogRow(id);
    expect(row.version).toBe(version + 1);
  });
});
