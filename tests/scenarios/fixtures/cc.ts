// tests/scenarios/fixtures/cc.ts — S5 External call-center client (doc 40 §C5 / lines 479-484).
//
// Admin-pool-only insert/delete helpers for cc.queues / cc.tickets / cc.agents / cc.agent_queues
// (same "admin pool bypasses RLS for fixture setup/teardown only" shape as ./pool.ts). Every
// RLS-relevant read in S5.spec.ts itself goes through `withContext` from '@pg-eos/db' (real
// pgeos_app role, real RLS), never through these fixture helpers.
//
// `selectTicketIdsSql` / `uuidLiteral`: `tx.execute()` (the drizzle `NodePgDatabase` withContext's
// `fn` callback receives) accepts `SQLWrapper | string` — drizzle-orm's `sql` tagged-template (the
// package's only parameterised form) is not a resolvable import from tests/scenarios: it is not a
// declared dependency here (`@pg-eos/db` added to tests/scenarios/package.json (+ lockfile) by the
// lane session per brief line 35, same as X part 5d) and pnpm's
// strict linking does not expose a transitive dependency of `@pg-eos/db` to its consumers. Every
// value `uuidLiteral` embeds is a UUID this spec generated itself via `randomUUID()` (never
// external input) — validated against a strict UUID shape before interpolation, so the embedded
// literal can never carry SQL syntax. `withContext`'s own `tx` type is inferred from
// `@pg-eos/db`'s declaration file (no direct import of drizzle-orm needed here either).

import { randomUUID } from 'node:crypto';

import type { Pool, QueryResult } from 'pg';

const TICKET_DOC_TYPE = 'TKT';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** See file header — validates before interpolating into a raw SQL string passed to `tx.execute`. */
export function uuidLiteral(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`uuidLiteral: not a UUID-shaped value: ${value}`);
  }
  return `'${value}'`;
}

/** The only query S5 needs at the RLS-real layer: every `cc.tickets.id` visible for one queue,
 *  under whatever ctx `withContext` was opened with. */
export function selectTicketIdsSql(queueId: string): string {
  return `select id from cc.tickets where queue_id = ${uuidLiteral(queueId)}`;
}

export interface InsertQueueParams {
  readonly entityId: string;
  readonly clientId: string;
  readonly codePrefix: string;
  readonly nameAr: string;
}

/** cc.queues: `entity_id`, `code` (globally UNIQUE — codePrefix + a fresh uuid), `name_ar` are the
 *  only NOT NULL columns beyond the `id`/`is_internal`/`channel`/... DEFAULTs (confirmed by
 *  `psql \d cc.queues`). Review round 1 finding 1: doc 40 §C5 line 303 — queues have `client_id` OR
 *  `is_internal`; S5 is "External call-center client", so every queue here carries the seeded
 *  client's id and `is_internal` stays at its own DEFAULT `false`. */
export async function insertQueue(pool: Pool, params: InsertQueueParams): Promise<string> {
  const id = randomUUID();
  const code = `${params.codePrefix}${id}`;
  await pool.query(`insert into cc.queues (id, entity_id, client_id, code, name_ar) values ($1, $2, $3, $4, $5)`, [
    id,
    params.entityId,
    params.clientId,
    code,
    params.nameAr,
  ]);
  return id;
}

export async function deleteQueue(pool: Pool, queueId: string): Promise<void> {
  await pool.query(`delete from cc.queues where id = $1`, [queueId]);
}

export interface InsertTicketParams {
  readonly entityId: string;
  readonly queueId: string;
  readonly clientId: string;
  readonly category: string;
  readonly subject: string;
}

/** cc.tickets: `entity_id`, `doc_no` (UNIQUE per entity — `platform.next_doc_no(entity, 'TKT')`,
 *  the counter row confirmed present for every entity by `psql`), `queue_id`, `category`,
 *  `subject` are the NOT NULL columns beyond DEFAULTs (`status='open'`, `priority='normal'`,
 *  `channel='voice'`) confirmed by `psql \d cc.tickets`. `client_id` is nullable but set here to
 *  the same seeded client as its queue (review round 1 finding 1 — "External call-center client"). */
export async function insertTicket(pool: Pool, params: InsertTicketParams): Promise<string> {
  const id = randomUUID();
  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(`select platform.next_doc_no($1, $2) as doc_no`, [
    params.entityId,
    TICKET_DOC_TYPE,
  ]);
  const docNo = docNoResult.rows[0]?.doc_no;
  if (!docNo) throw new Error(`platform.next_doc_no returned no row for ${TICKET_DOC_TYPE}`);
  await pool.query(
    `insert into cc.tickets (id, entity_id, doc_no, queue_id, client_id, category, subject) values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, params.entityId, docNo, params.queueId, params.clientId, params.category, params.subject],
  );
  return id;
}

export async function deleteTicketsForQueue(pool: Pool, queueId: string): Promise<void> {
  await pool.query(`delete from cc.tickets where queue_id = $1`, [queueId]);
}

export async function countTicketsForQueue(pool: Pool, queueId: string): Promise<number> {
  const result: QueryResult<{ count: string }> = await pool.query(`select count(*)::text as count from cc.tickets where queue_id = $1`, [
    queueId,
  ]);
  return Number(result.rows[0]?.count ?? '0');
}

/** cc.agents: `user_id` (FK identity.users) is the only NOT NULL column beyond `id`/`status`
 *  DEFAULT ('offline') and the nullable columns (`employee_id`, `extension`, `languages`,
 *  `skill_level`, `hired_at`) confirmed by `psql \d cc.agents`. */
export async function insertAgent(pool: Pool, userId: string): Promise<string> {
  const id = randomUUID();
  await pool.query(`insert into cc.agents (id, user_id) values ($1, $2)`, [id, userId]);
  return id;
}

export async function deleteAgent(pool: Pool, agentId: string): Promise<void> {
  await pool.query(`delete from cc.agents where id = $1`, [agentId]);
}

export async function insertAgentQueue(pool: Pool, agentId: string, queueId: string): Promise<void> {
  await pool.query(`insert into cc.agent_queues (agent_id, queue_id) values ($1, $2)`, [agentId, queueId]);
}

export async function deleteAgentQueuesForAgent(pool: Pool, agentId: string): Promise<void> {
  await pool.query(`delete from cc.agent_queues where agent_id = $1`, [agentId]);
}

export async function countAgentQueuesForAgent(pool: Pool, agentId: string): Promise<number> {
  const result: QueryResult<{ count: string }> = await pool.query(`select count(*)::text as count from cc.agent_queues where agent_id = $1`, [
    agentId,
  ]);
  return Number(result.rows[0]?.count ?? '0');
}
