// modules/billing/tests/gl-account-change-requests/approver-mechanism.test.ts — WBS 4.1a part 2.
//
// NEW test file, not in the brief's original RED-test-paths list (docs/notes/slice-briefs/
// _slice-4.1a-part2.brief.md §"RED tests" names only .feature/.test.ts/machine.unit.test.ts/
// invariants.property.test.ts) — the brief was written before round-1 finding 2's resolution added
// the whole "Approver mechanism — SCR-PLAT-APPR-01" section (D-190). Per the Master's own
// instruction relaying this task, a 5th test file is a normal RED-test addition pg-tester is
// allowed to make; this deviation is called out again in the closing report.
//
// Covers the brief's new §"Approver mechanism — SCR-PLAT-APPR-01" verbatim:
//   1. platform.is_approval_chain_approver(p_request_type text, p_step int default 1) returns
//      boolean — built and live (migration 0034).
//   2. Approver SELECT/UPDATE policies on gl_account_change_requests — built and live.
//   3. gl_accounts approver INSERT/UPDATE policy OR-ed with reference_write, PLUS the plain BEFORE
//      trigger billing.assert_gl_account_change_approved() (NOT a true Postgres CONSTRAINT TRIGGER —
//      round-2/round-3 review correction; those can only fire AFTER, and this must fire BEFORE) —
//      all built and live.
//   4. The bypass path (Condition 1, exact wording): keyed on current_user <> 'pgeos_app', never on
//      the app.user_id GUC being empty.
//
// Every scenario below is exercised through withContext(ctx, fn) (pgeos_app, genuinely subject to
// RLS — precedent: ../dimensions/dimensions.test.ts's own RLS scenario) EXCEPT §4, which needs to
// distinguish the DB ROLE from the app.user_id GUC directly — for that, a raw admin-pool client
// issues `begin; set local role pgeos_app; ...; rollback;` itself (never committed — the ROLLBACK
// is unconditional, in a `finally`, so this file never needs a DELETE for these rows at all,
// D-183-clean by construction, not by cleanup).
//
// RUN CONTEXT: PG_APP_USER=pgeos_app must be set (per the task's own run instructions) for
// withContext's pool to actually connect as pgeos_app and be subject to RLS — otherwise it silently
// falls back to PGUSER (postgres, RLS-blind) and every scenario below would be meaningless.
//
// STATUS: GREEN. `billing.gl_account_change_requests`, the approval-chain function, the approver
// SELECT/UPDATE policies, the gl_accounts approver write policies and both triggers
// (billing.assert_gl_account_change_approved()/assert_gl_account_change_immutable_fields()) all
// exist (migration database/migrations/0034_2_gl-account-change-requests.sql, applied). Every
// scenario below now exercises real, live behaviour, not an absence.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WithContextCtx } from '@pg-eos/db';
import { withContext } from '@pg-eos/db';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// Admin pool (PGUSER, bypasses RLS) — fixture setup/teardown, and §4's own raw-role-switch client.
const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

// A dedicated pgeos_app-role pool (precedent: packages/db/tests/idempotency.test.ts's own appPool) —
// used ONLY by the round-3 fix (a) cross-CFO test below, which needs to switch app.user_id via raw
// set_config calls TWICE within one single transaction/connection (approve as one CFO, then attempt
// the write as a DIFFERENT CFO) — withContext(ctx, fn) itself only ever binds ONE actor per
// transaction, so it cannot express "approve and write as two different actors, same transaction".
const appPool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PG_APP_USER'] ?? 'pgeos_app',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

const NAME_AR = 'طلب تعديل حساب اختبار آلية الاعتماد — WBS 4.1a part 2';
const VALID_ACCOUNT_TYPE = 'expense';

const CFO_ACTOR_UUID = '00000000-0000-4000-8000-0000004a5a01';
const ACCOUNTANT_ACTOR_UUID = '00000000-0000-4000-8000-0000004a5a02'; // non-CFO — negative control for §1.
const MAKER_UUID = '00000000-0000-4000-8000-0000004a5a03'; // requested_by on admin-pool-seeded pending rows — no identity.users row needed (brief: requested_by/approved_by carry no FK).
// Round-2 fix round (findings 6/7/8/9) — additional real actors, all real identity.users rows driven
// entirely through withContext (pgeos_app), for the new §9 behavioral/RLS coverage below.
const OTHER_CFO_ACTOR_UUID = '00000000-0000-4000-8000-0000004a5a04'; // finding 9(b)/9(c): a second CFO, distinct from CFO_ACTOR_UUID.
const MAKER_ACTOR_UUID = '00000000-0000-4000-8000-0000004a5a05'; // finding 9(e): a real maker session (own row create/submit/cancel).
const OTHER_MAKER_ACTOR_UUID = '00000000-0000-4000-8000-0000004a5a06'; // finding 9(e): a DIFFERENT accountant — non-owner negative control.
const OTHER_ENTITY_CFO_ACTOR_UUID = '00000000-0000-4000-8000-0000004a5a07'; // finding 9(d): CFO scoped to otherEntityId.

const ROLE_CFO = 'CFO';
const ROLE_ACCOUNTANT = 'ACCOUNTANT';

let entityId: string;
let otherEntityId: string;
const fixtureActorIds: string[] = [];
const fixtureRequestIds: string[] = [];
const fixtureAccountIds: string[] = [];

let codeCounter = 0;
function freshProposedCode(): string {
  codeCounter += 1;
  return `5-01-001-${String(codeCounter).padStart(3, '0')}`; // class 5 — this file's own block, distinct from every other *.test.ts in this directory.
}

function freshDocNo(): string {
  return `GLC-APPR-${randomUUID().slice(0, 8)}`;
}

function ctxFor(userId: string): WithContextCtx {
  return { userId, clientId: null, isInternal: true };
}

async function grantRole(userId: string, roleCode: string): Promise<void> {
  const roleResult: QueryResult<{ id: string }> = await pool.query(
    `select id from identity.roles where code = $1`,
    [roleCode],
  );
  const roleId = roleResult.rows[0]?.id;
  if (!roleId) throw new Error(`identity.roles row not found for code ${roleCode}`);
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [userId, roleId]);
}

async function createFixtureActor(userId: string, forEntityId: string, roleCode: string): Promise<void> {
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [userId, `_glc_appr_fixture_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار آلية الاعتماد — WBS 4.1a part 2'],
  );
  await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, forEntityId]);
  await grantRole(userId, roleCode);
  fixtureActorIds.push(userId);
}

/** Seeds a `pending_approval` change request directly through the admin pool (RLS-blind) — this
 *  file is only interested in the APPROVER side (§§1-3), never the maker's own insert path (already
 *  covered in ./gl-account-change-requests.test.ts's own finding-10 section). */
async function seedPendingRequest(input: {
  readonly requestedBy?: string;
  readonly changeKind?: 'create' | 'update';
  readonly targetAccountId?: string | null;
}): Promise<string> {
  const proposedCode = freshProposedCode();
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into billing.gl_account_change_requests
       (entity_id, doc_no, change_kind, target_account_id, proposed_code, proposed_name_ar,
        proposed_account_type, status, requested_by)
     values ($1, $2, $3, $4, $5, $6, $7, 'pending_approval', $8)
     returning id`,
    [
      entityId,
      freshDocNo(),
      input.changeKind ?? 'create',
      input.targetAccountId ?? null,
      input.changeKind === 'update' ? null : proposedCode,
      input.changeKind === 'update' ? null : NAME_AR,
      input.changeKind === 'update' ? null : VALID_ACCOUNT_TYPE,
      input.requestedBy ?? MAKER_UUID,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture pending-request insert returned no id');
  fixtureRequestIds.push(row.id);
  return row.id;
}

async function seedRequestInStatus(status: 'draft' | 'approved' | 'rejected' | 'cancelled'): Promise<string> {
  const proposedCode = freshProposedCode();
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into billing.gl_account_change_requests
       (entity_id, doc_no, change_kind, proposed_code, proposed_name_ar, proposed_account_type,
        status, requested_by, approved_by, approved_at, decided_at, rejection_reason)
     values ($1, $2, 'create', $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning id`,
    [
      entityId,
      freshDocNo(),
      proposedCode,
      NAME_AR,
      VALID_ACCOUNT_TYPE,
      status,
      MAKER_UUID,
      status === 'approved' ? CFO_ACTOR_UUID : null,
      status === 'approved' ? new Date() : null,
      status === 'approved' || status === 'rejected' ? new Date() : null,
      status === 'rejected' ? 'seed fixture reason' : null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`fixture ${status}-request insert returned no id`);
  fixtureRequestIds.push(row.id);
  return row.id;
}

async function getRequestRow(
  id: string,
): Promise<{ status: string; approved_by: string | null; rejection_reason: string | null }> {
  const result: QueryResult<{ status: string; approved_by: string | null; rejection_reason: string | null }> =
    await pool.query(`select status, approved_by, rejection_reason from billing.gl_account_change_requests where id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw new Error(`no billing.gl_account_change_requests row for id ${id}`);
  return row;
}

/** Attempts an UPDATE (default actor: the CFO) and reports whether it was rejected outright (threw)
 *  OR silently matched zero rows (RLS's USING clause filtered the row out of the actor's own visible
 *  rowset) — the brief does not pin down WHICH of the two mechanisms the policy uses, only that the
 *  transition must not happen either way. Generalised (round-2 fix round, finding 9) beyond the CFO
 *  actor so §9(d)/(e) can reuse it for other-entity/other-maker negative controls. */
async function attemptTransition(
  requestId: string,
  setClauseSql: ReturnType<typeof sql>,
  actorId: string = CFO_ACTOR_UUID,
): Promise<{ threw: boolean; rowCount: number }> {
  try {
    const result = await withContext(ctxFor(actorId), async (tx: NodePgDatabase) => {
      return tx.execute(sql`update billing.gl_account_change_requests set ${setClauseSql} where id = ${requestId}`);
    });
    return { threw: false, rowCount: (result as unknown as { rowCount?: number }).rowCount ?? 0 };
  } catch {
    return { threw: true, rowCount: 0 };
  }
}
const attemptCfoTransition = attemptTransition;

/** Walks `error`'s own cause chain (drizzle wraps the underlying pg driver error in its own
 *  DrizzleQueryError) looking for ANY Error whose `.message` contains `substring` — same
 *  cause-chain-walk discipline as ../gl-account-change-requests.test.ts's own findRaisedException,
 *  but matching on message text (finding 7: SQLSTATE 42501 alone cannot distinguish an RLS rejection
 *  from the trigger's OWN rejection — both raise 42501 — so this checks the trigger's distinguishing
 *  '0034:' message prefix instead). */
function chainContainsMessage(error: unknown, substring: string): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current.message.includes(substring)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Awaits `promise`, expecting it to reject with an Error somewhere in its cause chain whose message
 *  contains `substring` (finding 7). */
async function expectRejectsWithMessage(promise: Promise<unknown>, substring: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(chainContainsMessage(caught, substring)).toBe(true);
}

/** A fresh billing.gl_accounts row in `entityId`, for the §9(a) UPDATE-path trigger tests — each test
 *  needs its OWN target row so an earlier test's approved write never pollutes another's "leave
 *  unchanged" (NULL proposed_*) assertions. */
async function createTargetAccountForUpdate(): Promise<string> {
  const code = freshProposedCode();
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into billing.gl_accounts (entity_id, code, name_ar, account_type) values ($1, $2, $3, $4) returning id`,
    [entityId, code, 'حساب هدف اختبار التحديث — WBS 4.1a part 2', VALID_ACCOUNT_TYPE],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture update-target gl_accounts insert returned no id');
  fixtureAccountIds.push(row.id);
  return row.id;
}

/** Seeds a `pending_approval` UPDATE change request directly through the admin pool (RLS-blind),
 *  with full control over which proposed_* columns carry a value — needed for the §9(a) content-
 *  matching trigger tests (a NULL proposed_* column means "leave unchanged"; a non-null one must
 *  match exactly what gl_accounts.* is written as). */
async function seedPendingUpdateRequest(input: {
  readonly targetAccountId: string;
  readonly requestedBy?: string;
  readonly proposedAccountType?: string | null;
  readonly proposedNameAr?: string | null;
  readonly proposedNameEn?: string | null;
  readonly proposedParentId?: string | null;
}): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into billing.gl_account_change_requests
       (entity_id, doc_no, change_kind, target_account_id, proposed_account_type, proposed_name_ar, proposed_name_en, proposed_parent_id, status, requested_by)
     values ($1, $2, 'update', $3, $4, $5, $6, $7, 'pending_approval', $8)
     returning id`,
    [
      entityId,
      freshDocNo(),
      input.targetAccountId,
      input.proposedAccountType ?? null,
      input.proposedNameAr ?? null,
      input.proposedNameEn ?? null,
      input.proposedParentId ?? null,
      input.requestedBy ?? MAKER_UUID,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture pending update-request insert returned no id');
  fixtureRequestIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow) throw new Error(`platform.entities row not found for code 'PST'`);
  entityId = entityRow.id;

  const otherEntityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where id <> $1 limit 1`,
    [entityId],
  );
  const otherEntityRow = otherEntityResult.rows[0];
  if (!otherEntityRow) throw new Error('expected at least 2 rows in platform.entities');
  otherEntityId = otherEntityRow.id;

  // Finding 9(f): confirm withContext's pool genuinely connects as pgeos_app BEFORE trusting any RLS
  // assertion in this file — an unset PG_APP_USER env var silently falls back to PGUSER (postgres,
  // superuser, RLS-blind), which would make every scenario below pass spuriously without ever
  // exercising RLS at all.
  const currentUserResult = await withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => {
    return tx.execute<{ current_user: string }>(sql`select current_user`);
  });
  expect(currentUserResult.rows[0]?.['current_user']).toBe('pgeos_app');

  await createFixtureActor(CFO_ACTOR_UUID, entityId, ROLE_CFO);
  await createFixtureActor(ACCOUNTANT_ACTOR_UUID, entityId, ROLE_ACCOUNTANT);
  await createFixtureActor(OTHER_CFO_ACTOR_UUID, entityId, ROLE_CFO);
  await createFixtureActor(MAKER_ACTOR_UUID, entityId, ROLE_ACCOUNTANT);
  await createFixtureActor(OTHER_MAKER_ACTOR_UUID, entityId, ROLE_ACCOUNTANT);
  await createFixtureActor(OTHER_ENTITY_CFO_ACTOR_UUID, otherEntityId, ROLE_CFO);
});

afterAll(async () => {
  if (fixtureRequestIds.length > 0) {
    await pool.query(`delete from billing.gl_account_change_requests where id = any($1::uuid[])`, [fixtureRequestIds]);
  }
  if (fixtureAccountIds.length > 0) {
    await pool.query(`delete from billing.gl_accounts where id = any($1::uuid[])`, [fixtureAccountIds]);
  }
  if (fixtureActorIds.length > 0) {
    await pool.query(`delete from platform.idempotency_keys where user_id = any($1::uuid[])`, [fixtureActorIds]);
    await pool.query(`delete from identity.user_roles where user_id = any($1::uuid[])`, [fixtureActorIds]);
    await pool.query(`delete from identity.user_entities where user_id = any($1::uuid[])`, [fixtureActorIds]);
    await pool.query(`delete from identity.users where id = any($1::uuid[])`, [fixtureActorIds]);
  }
  await appPool.end();
  await pool.end();
});

// --- §1: platform.is_approval_chain_approver(p_request_type, p_step default 1) ---------------------

describe('platform.is_approval_chain_approver(p_request_type text, p_step int default 1)', () => {
  it('a user holding CFO returns true for is_approval_chain_approver(\'gl_account_change\', 1)', async () => {
    const result = await withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute<{ is_approver: boolean }>(
        sql`select platform.is_approval_chain_approver('gl_account_change', 1) as is_approver`,
      );
    });
    expect(result.rows[0]?.is_approver).toBe(true);
  });

  it('a user holding ACCOUNTANT (non-CFO) returns false', async () => {
    const result = await withContext(ctxFor(ACCOUNTANT_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute<{ is_approver: boolean }>(
        sql`select platform.is_approval_chain_approver('gl_account_change', 1) as is_approver`,
      );
    });
    expect(result.rows[0]?.is_approver).toBe(false);
  });

  it('an unknown request_type returns false (no matching platform.approval_chains row)', async () => {
    const result = await withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute<{ is_approver: boolean }>(
        sql`select platform.is_approval_chain_approver('not_a_real_request_type', 1) as is_approver`,
      );
    });
    expect(result.rows[0]?.is_approver).toBe(false);
  });

  it('an unknown step returns false (no matching platform.approval_chains row for that step_no)', async () => {
    const result = await withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute<{ is_approver: boolean }>(
        sql`select platform.is_approval_chain_approver('gl_account_change', 99) as is_approver`,
      );
    });
    expect(result.rows[0]?.is_approver).toBe(false);
  });
});

// --- §2: approver SELECT/UPDATE policies on gl_account_change_requests ------------------------------

describe('approver SELECT policy on gl_account_change_requests', () => {
  it('a CFO can SELECT any in-entity pending request, even one they did NOT create', async () => {
    const requestId = await seedPendingRequest({ requestedBy: MAKER_UUID });

    const visible = await withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute<{ id: string }>(sql`select id from billing.gl_account_change_requests where id = ${requestId}`);
    });
    expect(visible.rows).toHaveLength(1);
  });
});

describe('approver UPDATE policy on gl_account_change_requests', () => {
  it('a CFO can UPDATE a pending request to approved, with approved_by/approved_at/decided_at all set in the SAME statement', async () => {
    const requestId = await seedPendingRequest({ requestedBy: MAKER_UUID });

    await withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute(
        sql`update billing.gl_account_change_requests
               set status = 'approved', approved_by = ${CFO_ACTOR_UUID}, approved_at = now(), decided_at = now()
             where id = ${requestId}`,
      );
    });

    const row = await getRequestRow(requestId);
    expect(row.status).toBe('approved');
    expect(row.approved_by).toBe(CFO_ACTOR_UUID);
  });

  it('a CFO can UPDATE a pending request to rejected, with rejection_reason also set', async () => {
    const requestId = await seedPendingRequest({ requestedBy: MAKER_UUID });

    await withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute(
        sql`update billing.gl_account_change_requests
               set status = 'rejected', approved_by = ${CFO_ACTOR_UUID}, decided_at = now(), rejection_reason = 'not needed'
             where id = ${requestId}`,
      );
    });

    const row = await getRequestRow(requestId);
    expect(row.status).toBe('rejected');
    expect(row.rejection_reason).toBe('not needed');
  });

  it('a CFO CANNOT approve their own request (requested_by = approved_by), at the approver-transition level (policy WITH CHECK, and/or the table CHECK)', async () => {
    const requestId = await seedPendingRequest({ requestedBy: CFO_ACTOR_UUID });

    const outcome = await attemptCfoTransition(
      requestId,
      sql`status = 'approved', approved_by = ${CFO_ACTOR_UUID}, approved_at = now(), decided_at = now()`,
    );
    expect(outcome.threw || outcome.rowCount === 0).toBe(true);

    const row = await getRequestRow(requestId);
    expect(row.status).toBe('pending_approval'); // unchanged.
  });

  it('a CFO cannot transition a request that is still draft (not yet submitted)', async () => {
    const requestId = await seedRequestInStatus('draft');

    const outcome = await attemptCfoTransition(
      requestId,
      sql`status = 'approved', approved_by = ${CFO_ACTOR_UUID}, approved_at = now(), decided_at = now()`,
    );
    expect(outcome.threw || outcome.rowCount === 0).toBe(true);

    const row = await getRequestRow(requestId);
    expect(row.status).toBe('draft'); // unchanged.
  });

  it.each(['approved', 'rejected', 'cancelled'] as const)(
    'a CFO cannot transition a request that is already %s (terminal — not in the machine\'s legal-transition set)',
    async (terminalStatus) => {
      const requestId = await seedRequestInStatus(terminalStatus);

      const outcome = await attemptCfoTransition(
        requestId,
        sql`status = 'approved', approved_by = ${CFO_ACTOR_UUID}, approved_at = now(), decided_at = now()`,
      );
      expect(outcome.threw || outcome.rowCount === 0).toBe(true);

      const row = await getRequestRow(requestId);
      expect(row.status).toBe(terminalStatus); // unchanged.
    },
  );
});

// --- §3: gl_accounts approver INSERT/UPDATE policy + billing.assert_gl_account_change_approved() ---

describe('gl_accounts approver INSERT/UPDATE policy OR-ed with reference_write, backed by billing.assert_gl_account_change_approved()', () => {
  it('as the CFO, INSERT into gl_accounts DIRECTLY (bypassing the request-approval flow) is rejected by the trigger itself (finding 7: 42501 alone cannot distinguish RLS from the trigger — both raise it — so this asserts the trigger\'s own \'0034:\' message prefix). Ordering note: this is an INSERT, and the BEFORE ROW trigger fires before RLS\'s own WITH CHECK is evaluated, so the trigger\'s rejection is what deterministically fires here, not RLS.', async () => {
    await expectRejectsWithMessage(
      withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => {
        return tx.execute(
          sql`insert into billing.gl_accounts (entity_id, code, name_ar, account_type)
              values (${entityId}, ${freshProposedCode()}, ${NAME_AR}, ${VALID_ACCOUNT_TYPE})`,
        );
      }),
      '0034:',
    );
  });

  it('the LEGITIMATE path (approve, THEN write gl_accounts, both in the SAME transaction so decided_at = now() matches) succeeds now that the approver policy + trigger both exist', async () => {
    const proposedCode = freshProposedCode();
    const pendingResult: QueryResult<{ id: string }> = await pool.query(
      `insert into billing.gl_account_change_requests
         (entity_id, doc_no, change_kind, proposed_code, proposed_name_ar, proposed_account_type, status, requested_by)
       values ($1, $2, 'create', $3, $4, $5, 'pending_approval', $6)
       returning id`,
      [entityId, freshDocNo(), proposedCode, NAME_AR, VALID_ACCOUNT_TYPE, MAKER_UUID],
    );
    const requestId = pendingResult.rows[0]?.id;
    if (!requestId) throw new Error('fixture pending-request insert returned no id');
    fixtureRequestIds.push(requestId);

    // Round-2 fix round correction: approve and write gl_accounts in ONE transaction — decided_at =
    // now() is the TRANSACTION's start timestamp (round-2 finding 2, Master's exact ruling), so
    // approving in a SEPARATE, earlier transaction (the previous draft of this test) can never satisfy
    // the trigger's replay guard once it actually exists (see §9(a)'s dedicated replay test below).
    let insertedId: string | undefined;
    await withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => {
      await tx.execute(
        sql`update billing.gl_account_change_requests
               set status = 'approved', approved_by = ${CFO_ACTOR_UUID}, approved_at = now(), decided_at = now()
             where id = ${requestId}`,
      );
      const result = await tx.execute<{ id: string }>(
        sql`insert into billing.gl_accounts (entity_id, code, name_ar, account_type)
            values (${entityId}, ${proposedCode}, ${NAME_AR}, ${VALID_ACCOUNT_TYPE}) returning id`,
      );
      insertedId = result.rows[0]?.id;
    });

    if (!insertedId) throw new Error('legitimate-path insert returned no id');
    fixtureAccountIds.push(insertedId);
  });
});

describe('billing.assert_gl_account_change_approved() — the trigger exists and fires', () => {
  // Finding 6: this checks the pg_trigger catalog for the actual trigger name the migration uses
  // (trg_assert_gl_account_change_approved on billing.gl_accounts) is present and enabled. Real
  // behavioral proof that the trigger's function actually fires correctly lives in §9(a) below
  // (finding 6's second half).
  it('the trigger trg_assert_gl_account_change_approved exists on billing.gl_accounts (before insert or update, per row)', async () => {
    const result: QueryResult<{ tgenabled: string }> = await pool.query(
      `select t.tgenabled
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'billing' and c.relname = 'gl_accounts'
          and t.tgname = 'trg_assert_gl_account_change_approved'
          and not t.tgisinternal`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.tgenabled).not.toBe('D'); // not disabled.
  });

  it('the second trigger trg_assert_gl_account_change_immutable_fields exists on billing.gl_account_change_requests (round-2 finding 3)', async () => {
    const result: QueryResult<{ tgenabled: string }> = await pool.query(
      `select t.tgenabled
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'billing' and c.relname = 'gl_account_change_requests'
          and t.tgname = 'trg_assert_gl_account_change_immutable_fields'
          and not t.tgisinternal`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.tgenabled).not.toBe('D');
  });
});

// --- §4: bypass path (Condition 1, exact wording) — keyed on current_user, never on the GUC ---------

describe('Bypass path (Condition 1): the trigger must key on current_user <> \'pgeos_app\', never on app.user_id being empty', () => {
  it('a no-app-context session (postgres/superuser, no pgeos_app role, no app.user_id GUC set) can INSERT/UPDATE gl_accounts freely — the seed/apply.sh/import path', async () => {
    // Positive control — this already holds true today (no trigger exists yet to block anything) and
    // MUST keep holding true once billing.assert_gl_account_change_approved() lands: a regression
    // guard, not a RED test for this slice's own missing feature.
    const code = freshProposedCode();
    const result: QueryResult<{ id: string }> = await pool.query(
      `insert into billing.gl_accounts (entity_id, code, name_ar, account_type) values ($1, $2, $3, $4) returning id`,
      [entityId, code, NAME_AR, VALID_ACCOUNT_TYPE],
    );
    const row = result.rows[0];
    if (!row) throw new Error('admin-pool (superuser, no app context) insert returned no id');
    fixtureAccountIds.push(row.id);

    await pool.query(`update billing.gl_accounts set name_en = $2 where id = $1`, [row.id, 'Bypass path positive control']);
    const after: QueryResult<{ name_en: string | null }> = await pool.query(
      `select name_en from billing.gl_accounts where id = $1`,
      [row.id],
    );
    expect(after.rows[0]?.name_en).toBe('Bypass path positive control');
  });

  it('a pgeos_app session with NO matching approved request is rejected, even with an EMPTY/missing app.user_id GUC (current_user = \'pgeos_app\' is what matters, never the GUC value) — never committed, always rolled back', async () => {
    const client = await pool.connect();
    let rejected = false;
    let rejectionMessage = '';
    try {
      await client.query('begin');
      // Genuinely switches the DB role for the rest of this transaction — current_user is now
      // literally 'pgeos_app' (NOBYPASSRLS, migration 0007), while app.user_id/app.client_id/
      // app.is_internal are left COMPLETELY UNSET (never called set_config at all) — the exact
      // "empty/missing GUC as the pgeos_app role" scenario the brief's own Condition 1 names.
      await client.query('set local role pgeos_app');
      try {
        await client.query(
          `insert into billing.gl_accounts (entity_id, code, name_ar, account_type) values ($1, $2, $3, $4)`,
          [entityId, freshProposedCode(), NAME_AR, VALID_ACCOUNT_TYPE],
        );
      } catch (error) {
        rejected = true;
        rejectionMessage = (error as { message?: string }).message ?? '';
      }
    } finally {
      await client.query('rollback'); // unconditional — this row must NEVER be committed either way.
      client.release();
    }

    expect(rejected).toBe(true);
    // Finding 7: this is a raw pg driver error (no drizzle wrapper on this path — a plain
    // `client.query`), so `.message` IS the actual Postgres error text. Once the trigger exists, this
    // must be REJECTED BY THE TRIGGER SPECIFICALLY (its own '0034:' message prefix) — never merely
    // "some 42501" that could equally be an unrelated RLS policy. Ordering note: this is a
    // BEFORE-ROW-trigger-fires-before-RLS-WITH-CHECK INSERT (same ordering as the §3 direct-insert
    // test above), so the trigger's own NOT EXISTS check (no request can ever be decided by a
    // null/empty user) is what fires here, deterministically, not RLS.
    expect(rejectionMessage).toContain('0034:');
  });
});

// --- §9: missing RLS/trigger tests (round-2 fix round, finding 9) — ALL real pgeos_app sessions ----

describe('§9(a): billing.assert_gl_account_change_approved() — UPDATE path, real behavioral coverage', () => {
  it('no matching approved request at all → rejected (0034-prefixed message)', async () => {
    const targetId = await createTargetAccountForUpdate();
    await expectRejectsWithMessage(
      withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => {
        return tx.execute(sql`update billing.gl_accounts set name_en = 'unauthorized change' where id = ${targetId}`);
      }),
      '0034:',
    );
  });

  it('an approved request whose proposed content does NOT MATCH what is actually written (proposed_account_type=expense, write account_type=asset) → rejected', async () => {
    const targetId = await createTargetAccountForUpdate();
    const requestId = await seedPendingUpdateRequest({ targetAccountId: targetId, proposedAccountType: VALID_ACCOUNT_TYPE });

    await expectRejectsWithMessage(
      withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => {
        await tx.execute(
          sql`update billing.gl_account_change_requests
                 set status = 'approved', approved_by = ${CFO_ACTOR_UUID}, approved_at = now(), decided_at = now()
               where id = ${requestId}`,
        );
        return tx.execute(sql`update billing.gl_accounts set account_type = 'asset' where id = ${targetId}`);
      }),
      '0034:',
    );
  });

  it('a properly matching approved request (approve THEN write, same transaction) succeeds', async () => {
    const targetId = await createTargetAccountForUpdate();
    const requestId = await seedPendingUpdateRequest({
      targetAccountId: targetId,
      proposedAccountType: VALID_ACCOUNT_TYPE,
      proposedNameEn: 'Matched update — §9(a)',
    });

    await withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => {
      await tx.execute(
        sql`update billing.gl_account_change_requests
               set status = 'approved', approved_by = ${CFO_ACTOR_UUID}, approved_at = now(), decided_at = now()
             where id = ${requestId}`,
      );
      return tx.execute(
        sql`update billing.gl_accounts set account_type = ${VALID_ACCOUNT_TYPE}, name_en = ${'Matched update — §9(a)'} where id = ${targetId}`,
      );
    });

    const after: QueryResult<{ account_type: string; name_en: string | null }> = await pool.query(
      `select account_type, name_en from billing.gl_accounts where id = $1`,
      [targetId],
    );
    expect(after.rows[0]?.account_type).toBe(VALID_ACCOUNT_TYPE);
    expect(after.rows[0]?.name_en).toBe('Matched update — §9(a)');
  });

  it('replay: an approved request DECIDED IN AN EARLIER TRANSACTION (not this one) is rejected — decided_at no longer equals THIS transaction\'s now()', async () => {
    const targetId = await createTargetAccountForUpdate();
    const requestId = await seedPendingUpdateRequest({ targetAccountId: targetId, proposedAccountType: VALID_ACCOUNT_TYPE });

    // Approve via the admin pool, its OWN separate transaction — decided_at is set to THAT
    // transaction's now(), already in the past by the time the withContext transaction below starts.
    await pool.query(
      `update billing.gl_account_change_requests
          set status = 'approved', approved_by = $2, approved_at = now(), decided_at = now()
        where id = $1`,
      [requestId, CFO_ACTOR_UUID],
    );

    await expectRejectsWithMessage(
      withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => {
        return tx.execute(sql`update billing.gl_accounts set account_type = ${VALID_ACCOUNT_TYPE} where id = ${targetId}`);
      }),
      '0034:',
    );
  });

  // Round-3 fix (d)1: an approved request that does NOT propose name_en/parent_id (both null in the
  // proposal) means "leave unchanged" — it must NOT let the approver clear an already-set value to
  // null. Before round-3 fix 1, the trigger's `... or new.x is not distinct from r.proposed_x` second
  // disjunct let new.x=NULL through even when r.proposed_x was also NULL (NULL "is not distinct from"
  // NULL is true), wrongly ACCEPTING this case.
  // Round-3 confirmation-pass finding 1 (mechanical, test-only): the previous single test here nulled
  // out BOTH name_en AND parent_id in one write attempt. That combined shape does not isolate either
  // column's fix — if only ONE of the two `... or new.x is not distinct from r.proposed_x` clauses
  // were reverted to the pre-round-3-fix-1 buggy form, the OTHER column's still-fixed clause would
  // independently reject the write, so the combined test would still (correctly, but for the wrong
  // reason for HALF of it) pass, masking a regression in the reverted column's own clause. Split into
  // two single-column tests below, each nulling out exactly one column while leaving the other column
  // untouched (matching its existing pre-write value, so the untouched column's own clause is
  // satisfied and cannot be the one causing the rejection).
  it('an approved request that does NOT propose name_en (null) rejects an attempt to null out the target\'s EXISTING non-null name_en ALONE — parent_id left at its existing value (round-3 fix 1, name_en column isolated)', async () => {
    const parentId = await createTargetAccountForUpdate();
    const targetId = await createTargetAccountForUpdate();
    await pool.query(`update billing.gl_accounts set name_en = $2, parent_id = $3 where id = $1`, [
      targetId,
      'Existing name_en — must survive an unrelated proposal',
      parentId,
    ]);

    // proposedNameEn omitted -> null in the request row. proposedParentId also omitted, matching the
    // write below leaving parent_id at its existing (unchanged) value — parent_id's own clause is
    // satisfied via the `(proposed_parent_id is null and new.parent_id is not distinct from
    // old.parent_id)` disjunct, so it cannot be what causes the rejection here.
    const requestId = await seedPendingUpdateRequest({ targetAccountId: targetId, proposedAccountType: VALID_ACCOUNT_TYPE });

    await expectRejectsWithMessage(
      withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => {
        await tx.execute(
          sql`update billing.gl_account_change_requests
                 set status = 'approved', approved_by = ${CFO_ACTOR_UUID}, approved_at = now(), decided_at = now()
               where id = ${requestId}`,
        );
        return tx.execute(
          sql`update billing.gl_accounts set account_type = ${VALID_ACCOUNT_TYPE}, name_en = null, parent_id = ${parentId} where id = ${targetId}`,
        );
      }),
      '0034:',
    );

    const after: QueryResult<{ name_en: string | null; parent_id: string | null }> = await pool.query(
      `select name_en, parent_id from billing.gl_accounts where id = $1`,
      [targetId],
    );
    expect(after.rows[0]?.name_en).toBe('Existing name_en — must survive an unrelated proposal'); // unchanged.
    expect(after.rows[0]?.parent_id).toBe(parentId); // unchanged (was never attempted to change).
  });

  it('an approved request that does NOT propose parent_id (null) rejects an attempt to null out the target\'s EXISTING non-null parent_id ALONE — name_en left at its existing value (round-3 fix 1, parent_id column isolated)', async () => {
    const parentId = await createTargetAccountForUpdate();
    const targetId = await createTargetAccountForUpdate();
    await pool.query(`update billing.gl_accounts set name_en = $2, parent_id = $3 where id = $1`, [
      targetId,
      'Existing name_en — left unchanged by this attempt',
      parentId,
    ]);

    // proposedParentId omitted -> null in the request row. proposedNameEn also omitted, matching the
    // write below leaving name_en at its existing (unchanged) value — name_en's own clause is
    // satisfied via the `(proposed_name_en is null and new.name_en is not distinct from old.name_en)`
    // disjunct, so it cannot be what causes the rejection here.
    const requestId = await seedPendingUpdateRequest({ targetAccountId: targetId, proposedAccountType: VALID_ACCOUNT_TYPE });

    await expectRejectsWithMessage(
      withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => {
        await tx.execute(
          sql`update billing.gl_account_change_requests
                 set status = 'approved', approved_by = ${CFO_ACTOR_UUID}, approved_at = now(), decided_at = now()
               where id = ${requestId}`,
        );
        return tx.execute(
          sql`update billing.gl_accounts set account_type = ${VALID_ACCOUNT_TYPE}, name_en = ${'Existing name_en — left unchanged by this attempt'}, parent_id = null where id = ${targetId}`,
        );
      }),
      '0034:',
    );

    const after: QueryResult<{ name_en: string | null; parent_id: string | null }> = await pool.query(
      `select name_en, parent_id from billing.gl_accounts where id = $1`,
      [targetId],
    );
    expect(after.rows[0]?.name_en).toBe('Existing name_en — left unchanged by this attempt'); // unchanged (was never attempted to change).
    expect(after.rows[0]?.parent_id).toBe(parentId); // unchanged.
  });

  it('an approved request that DOES propose a specific non-null parent_id, writing exactly that value, succeeds (positive control for fix 1)', async () => {
    const parentId = await createTargetAccountForUpdate();
    const targetId = await createTargetAccountForUpdate();
    const requestId = await seedPendingUpdateRequest({
      targetAccountId: targetId,
      proposedAccountType: VALID_ACCOUNT_TYPE,
      proposedParentId: parentId,
    });

    await withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => {
      await tx.execute(
        sql`update billing.gl_account_change_requests
               set status = 'approved', approved_by = ${CFO_ACTOR_UUID}, approved_at = now(), decided_at = now()
             where id = ${requestId}`,
      );
      return tx.execute(
        sql`update billing.gl_accounts set account_type = ${VALID_ACCOUNT_TYPE}, parent_id = ${parentId} where id = ${targetId}`,
      );
    });

    const after: QueryResult<{ parent_id: string | null }> = await pool.query(
      `select parent_id from billing.gl_accounts where id = $1`,
      [targetId],
    );
    expect(after.rows[0]?.parent_id).toBe(parentId);
  });

  // Round-3 fix (d)2: an approver setting decided_at to an arbitrary future value must be rejected
  // AT THE UPDATE-TO-APPROVED STEP ITSELF, by the approver UPDATE policy's own WITH CHECK (round-3
  // fix 2's `decided_at = now()` clause added there) — never merely at a later gl_accounts write.
  it('an approver cannot set decided_at to an arbitrary future value — rejected by the approver UPDATE policy\'s own WITH CHECK at the UPDATE-to-approved step itself, before any gl_accounts write is even attempted', async () => {
    const requestId = await seedPendingRequest({ requestedBy: MAKER_UUID });

    const outcome = await attemptTransition(
      requestId,
      sql`status = 'approved', approved_by = ${CFO_ACTOR_UUID}, approved_at = now(), decided_at = now() + interval '1 day'`,
      CFO_ACTOR_UUID,
    );
    expect(outcome.threw || outcome.rowCount === 0).toBe(true);

    const row = await getRequestRow(requestId);
    expect(row.status).toBe('pending_approval'); // never became approved — rejected at this step itself.
  });
});

describe('§9(b): the matched request must be approved by the SAME user performing the gl_accounts write', () => {
  // Round-3 fix (a): the previous draft of this test approved the request in an EARLIER admin-pool
  // transaction, then attempted the write in a SEPARATE, LATER withContext transaction — so the
  // trigger's `decided_at = now() (REPLAY guard, §9(a) above)` would ALREADY reject the write for
  // its own reason, regardless of who approved it. That proved replay, not the cross-CFO check. This
  // rewrite performs BOTH the approval AND the write in the exact SAME transaction/connection (so
  // decided_at = now() still matches throughout — the replay guard cannot be what fires here), using
  // the raw pgeos_app appPool to switch app.user_id via set_config TWICE mid-transaction: approve AS
  // OTHER_CFO_ACTOR_UUID, then attempt the gl_accounts write AS THE DIFFERENT CFO_ACTOR_UUID —
  // withContext(ctx, fn) cannot express two different actors in one transaction, hence the raw pool
  // (precedent: packages/db/tests/idempotency.test.ts's own appPool + set_config pattern).
  it('approve AS one CFO, then attempt the gl_accounts write AS A DIFFERENT CFO, in the exact SAME transaction (decided_at = now() holds throughout, so replay cannot be the cause) — rejected specifically because approved_by <> the writer\'s own current_user_id()', async () => {
    const targetId = await createTargetAccountForUpdate();
    const requestId = await seedPendingUpdateRequest({ targetAccountId: targetId, proposedAccountType: VALID_ACCOUNT_TYPE });

    const client = await appPool.connect();
    let rejected = false;
    let message = '';
    try {
      await client.query('begin');

      // Step 1 — approve AS OTHER_CFO_ACTOR_UUID. Satisfies the approver UPDATE policy's own WITH
      // CHECK (approved_by = current_user_id() = OTHER_CFO_ACTOR_UUID, approved_by <> requested_by)
      // and sets decided_at = now() — THIS transaction's start timestamp, unchanged for the rest of
      // this transaction's life.
      await client.query(`select set_config('app.user_id', $1, true)`, [OTHER_CFO_ACTOR_UUID]);
      await client.query(`select set_config('app.client_id', $1, true)`, [null]);
      await client.query(`select set_config('app.is_internal', 'true', true)`);
      await client.query(
        `update billing.gl_account_change_requests
            set status = 'approved', approved_by = $2, approved_at = now(), decided_at = now()
          where id = $1`,
        [requestId, OTHER_CFO_ACTOR_UUID],
      );

      // Step 2 — SAME transaction/connection, now switched to a DIFFERENT CFO. decided_at is still
      // exactly this transaction's now() (unchanged since step 1), so the replay guard (§9(a)) is
      // satisfied — the trigger's NOT EXISTS clause can only fail here because no approved row has
      // approved_by = platform.current_user_id() (now CFO_ACTOR_UUID, not OTHER_CFO_ACTOR_UUID who
      // actually approved it) — every other predicate (content match, decided_at) is controlled to
      // hold, isolating the cross-CFO mismatch as the only possible failing condition.
      await client.query(`select set_config('app.user_id', $1, true)`, [CFO_ACTOR_UUID]);
      try {
        await client.query(`update billing.gl_accounts set account_type = $2 where id = $1`, [
          targetId,
          VALID_ACCOUNT_TYPE,
        ]);
      } catch (error) {
        rejected = true;
        message = (error as { message?: string }).message ?? '';
      }
    } finally {
      await client.query('rollback'); // unconditional — never committed either way.
      client.release();
    }

    expect(rejected).toBe(true);
    // The trigger raises ONE combined generic '0034:' message for its whole NOT EXISTS clause (the
    // SQL has no separate per-predicate text distinguishing "approved_by mismatch" from "content
    // mismatch" — confirmed against modules/billing domain/migration draft). This test isolates the
    // cross-CFO cause through its CONTROLLED VARIABLES (identical proposed-content match, identical
    // decided_at = now(), ONLY approved_by/current_user_id() differ), not through message text —
    // documented per the Master's fix (a) instruction, since no more specific message exists to
    // assert on.
    expect(message).toContain('0034:');
  });
});

describe('§9(c): approver UPDATE policy WITH CHECK — negative controls as a real pgeos_app session', () => {
  it('the approver cannot set approved_by to someone OTHER than themselves', async () => {
    const requestId = await seedPendingRequest({ requestedBy: MAKER_UUID });

    const outcome = await attemptTransition(
      requestId,
      sql`status = 'approved', approved_by = ${OTHER_CFO_ACTOR_UUID}, approved_at = now(), decided_at = now()`,
      CFO_ACTOR_UUID,
    );
    expect(outcome.threw || outcome.rowCount === 0).toBe(true);

    const row = await getRequestRow(requestId);
    expect(row.status).toBe('pending_approval');
  });

  it('the approver rejecting WITHOUT a rejection_reason is rejected by the policy itself (real pgeos_app session, not only the admin-pool table-CHECK test)', async () => {
    const requestId = await seedPendingRequest({ requestedBy: MAKER_UUID });

    const outcome = await attemptTransition(
      requestId,
      sql`status = 'rejected', approved_by = ${CFO_ACTOR_UUID}, decided_at = now()`,
      CFO_ACTOR_UUID,
    );
    expect(outcome.threw || outcome.rowCount === 0).toBe(true);

    const row = await getRequestRow(requestId);
    expect(row.status).toBe('pending_approval');
  });
});

describe('§9(d): approver-side negatives', () => {
  it('a CFO scoped to a DIFFERENT entity cannot SELECT the request', async () => {
    const requestId = await seedPendingRequest({ requestedBy: MAKER_UUID });

    const visible = await withContext(ctxFor(OTHER_ENTITY_CFO_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute<{ id: string }>(sql`select id from billing.gl_account_change_requests where id = ${requestId}`);
    });
    expect(visible.rows).toHaveLength(0);
  });

  it('a CFO scoped to a DIFFERENT entity cannot UPDATE the request', async () => {
    const requestId = await seedPendingRequest({ requestedBy: MAKER_UUID });

    const outcome = await attemptTransition(
      requestId,
      sql`status = 'approved', approved_by = ${OTHER_ENTITY_CFO_ACTOR_UUID}, approved_at = now(), decided_at = now()`,
      OTHER_ENTITY_CFO_ACTOR_UUID,
    );
    expect(outcome.threw || outcome.rowCount === 0).toBe(true);

    const row = await getRequestRow(requestId);
    expect(row.status).toBe('pending_approval');
  });

  it('a CFO cannot INSERT a new change request at all (no maker permission — billing.gl_accounts.manage is ACCOUNTANT-only) — rejected specifically by the maker INSERT policy\'s own RLS check (42501, row-level security policy violation naming THIS table), not merely "some error" (round-3 fix (c): a bare catch would keep passing once the table exists, for 42501s raised by unrelated reasons too — same distinguishing-SQLSTATE/message discipline as this file\'s other fixed ambiguous-catch tests, round-2 finding 7)', async () => {
    let rejected = false;
    let code: string | undefined;
    let message = '';
    try {
      await withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => {
        return tx.execute(
          sql`insert into billing.gl_account_change_requests
                (entity_id, doc_no, change_kind, proposed_code, proposed_name_ar, proposed_account_type, requested_by)
              values (${entityId}, ${freshDocNo()}, 'create', ${freshProposedCode()}, ${NAME_AR}, ${VALID_ACCOUNT_TYPE}, ${CFO_ACTOR_UUID})`,
        );
      });
    } catch (error) {
      rejected = true;
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      code = cause?.code ?? (error as { code?: string }).code;
      message = cause?.message ?? (error as { message?: string }).message ?? '';
    }
    expect(rejected).toBe(true);
    // 42501 = insufficient_privilege, the SQLSTATE every RLS WITH CHECK failure raises — NOT 42P01
    // (relation does not exist, today's actual RED reason) and not any other SQLSTATE class.
    expect(code).toBe('42501');
    // Postgres's own RLS-violation message names the specific table it rejected the write against —
    // this pins the rejection to THIS table's maker INSERT policy, not an unrelated 42501 elsewhere.
    expect(message).toMatch(/row-level security policy/i);
    expect(message).toContain('gl_account_change_requests');
  });

  it('the approver cannot CANCEL a request (that is the maker-only transition — the approver policy only allows approved/rejected)', async () => {
    const requestId = await seedPendingRequest({ requestedBy: MAKER_UUID });

    const outcome = await attemptTransition(requestId, sql`status = 'cancelled'`, CFO_ACTOR_UUID);
    expect(outcome.threw || outcome.rowCount === 0).toBe(true);

    const row = await getRequestRow(requestId);
    expect(row.status).toBe('pending_approval');
  });

  it('the approver cannot rewrite proposed_* fields or requested_by while approving — rejected by the SECOND trigger (assert_gl_account_change_immutable_fields)', async () => {
    const requestId = await seedPendingRequest({ requestedBy: MAKER_UUID });

    await expectRejectsWithMessage(
      withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => {
        // requested_by is rewritten to a THIRD party (not the approver) so the approver policy's own
        // `approved_by <> requested_by` WITH CHECK still holds — isolating the immutable-fields
        // trigger, not the approver policy, as the thing doing the rejecting here.
        return tx.execute(
          sql`update billing.gl_account_change_requests
                 set status = 'approved', approved_by = ${CFO_ACTOR_UUID}, approved_at = now(), decided_at = now(),
                     proposed_name_ar = 'rewritten by the approver — must be rejected',
                     requested_by = ${OTHER_MAKER_ACTOR_UUID}
               where id = ${requestId}`,
        );
      }),
      '0034:',
    );

    const row = await getRequestRow(requestId);
    expect(row.status).toBe('pending_approval');
  });
});

describe('§9(f) [round-3 fix (b)]: the draft-only proposal lock also blocks the MAKER rewriting their own PENDING proposal, not only the approver', () => {
  it('the maker changes ONLY proposed_name_ar (requested_by/id/entity_id/doc_no left untouched) on their own PENDING (not draft) request — rejected by the immutable-fields trigger\'s status-dependent lock, proving a pending proposal cannot be edited by ANYONE once submitted (round-3 fix (b): the existing §9(d) rewrite test only ever changed requested_by too, so it only ever proved the always-immutable-fields branch, never this draft-only lock)', async () => {
    const proposedCode = freshProposedCode();
    const insertResult = await withContext(ctxFor(MAKER_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute<{ id: string }>(
        sql`insert into billing.gl_account_change_requests
              (entity_id, doc_no, change_kind, proposed_code, proposed_name_ar, proposed_account_type, requested_by, status)
            values (${entityId}, ${freshDocNo()}, 'create', ${proposedCode}, ${NAME_AR}, ${VALID_ACCOUNT_TYPE}, ${MAKER_ACTOR_UUID}, 'pending_approval')
            returning id`,
      );
    });
    const requestId = insertResult.rows[0]?.id;
    if (!requestId) throw new Error('withContext insert returned no id');
    fixtureRequestIds.push(requestId);

    // Note: the maker's own UPDATE RLS policy alone would ALLOW this statement (own row,
    // requested_by unchanged, status stays 'pending_approval', decision columns stay null) — it is
    // the SECOND trigger's draft-only proposal lock (old.status <> 'draft') that must reject it, in
    // isolation from both RLS and the always-immutable-fields branch (requested_by/id/entity_id/
    // doc_no are deliberately left untouched here, unlike §9(d)'s rewrite test above).
    await expectRejectsWithMessage(
      withContext(ctxFor(MAKER_ACTOR_UUID), async (tx: NodePgDatabase) => {
        return tx.execute(
          sql`update billing.gl_account_change_requests
                 set proposed_name_ar = 'rewritten by the maker post-submit — must be rejected'
               where id = ${requestId}`,
        );
      }),
      '0034:',
    );

    const after: QueryResult<{ proposed_name_ar: string }> = await pool.query(
      `select proposed_name_ar from billing.gl_account_change_requests where id = $1`,
      [requestId],
    );
    expect(after.rows[0]?.proposed_name_ar).toBe(NAME_AR); // unchanged.
  });
});

describe('§9(g) [round-3 fix (d)3]: draft-rewind / rewind lock — the immutable-fields trigger\'s two illegal-transition guards', () => {
  it('pending_approval -> draft as the maker on their own request is rejected (not a legal machine-transition edge — CANCEL is the only exit toward a non-terminal-adjacent state from pending_approval)', async () => {
    const requestId = await seedPendingRequest({ requestedBy: MAKER_ACTOR_UUID });

    await expectRejectsWithMessage(
      withContext(ctxFor(MAKER_ACTOR_UUID), async (tx: NodePgDatabase) => {
        return tx.execute(sql`update billing.gl_account_change_requests set status = 'draft' where id = ${requestId}`);
      }),
      '0034:',
    );

    const row = await getRequestRow(requestId);
    expect(row.status).toBe('pending_approval'); // unchanged.
  });

  it('draft -> cancelled as the maker on their own draft request is rejected (not a legal machine-transition edge — CANCEL is only legal from pending_approval)', async () => {
    const proposedCode = freshProposedCode();
    const insertResult = await withContext(ctxFor(MAKER_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute<{ id: string }>(
        sql`insert into billing.gl_account_change_requests
              (entity_id, doc_no, change_kind, proposed_code, proposed_name_ar, proposed_account_type, requested_by)
            values (${entityId}, ${freshDocNo()}, 'create', ${proposedCode}, ${NAME_AR}, ${VALID_ACCOUNT_TYPE}, ${MAKER_ACTOR_UUID})
            returning id`,
      );
    });
    const requestId = insertResult.rows[0]?.id;
    if (!requestId) throw new Error('withContext insert returned no id');
    fixtureRequestIds.push(requestId);
    // status defaults to 'draft' — note: the maker UPDATE policy's own WITH CHECK would ALLOW
    // draft -> cancelled (its status set includes 'cancelled'); it is specifically the trigger's
    // second illegal-transition guard that must reject this, isolated from RLS.

    await expectRejectsWithMessage(
      withContext(ctxFor(MAKER_ACTOR_UUID), async (tx: NodePgDatabase) => {
        return tx.execute(sql`update billing.gl_account_change_requests set status = 'cancelled' where id = ${requestId}`);
      }),
      '0034:',
    );

    const after: QueryResult<{ status: string }> = await pool.query(
      `select status from billing.gl_account_change_requests where id = $1`,
      [requestId],
    );
    expect(after.rows[0]?.status).toBe('draft'); // unchanged.
  });
});

describe('§9(e): maker-side RLS/DB-level behaviour, as a real pgeos_app session', () => {
  it('the maker cancels their OWN pending request successfully', async () => {
    const proposedCode = freshProposedCode();
    const insertResult = await withContext(ctxFor(MAKER_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute<{ id: string }>(
        sql`insert into billing.gl_account_change_requests
              (entity_id, doc_no, change_kind, proposed_code, proposed_name_ar, proposed_account_type, requested_by, status)
            values (${entityId}, ${freshDocNo()}, 'create', ${proposedCode}, ${NAME_AR}, ${VALID_ACCOUNT_TYPE}, ${MAKER_ACTOR_UUID}, 'pending_approval')
            returning id`,
      );
    });
    const requestId = insertResult.rows[0]?.id;
    if (!requestId) throw new Error('withContext insert returned no id');
    fixtureRequestIds.push(requestId);

    await withContext(ctxFor(MAKER_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute(sql`update billing.gl_account_change_requests set status = 'cancelled' where id = ${requestId}`);
    });

    const row = await getRequestRow(requestId);
    expect(row.status).toBe('cancelled');
  });

  it('a DIFFERENT ACCOUNTANT (non-owner) attempting to cancel someone else\'s pending request affects 0 rows (RLS silently filters it out of their own-row USING clause — same no-op pattern as 4.1b\'s own UPDATE/DELETE RLS tests)', async () => {
    const proposedCode = freshProposedCode();
    const insertResult = await withContext(ctxFor(MAKER_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute<{ id: string }>(
        sql`insert into billing.gl_account_change_requests
              (entity_id, doc_no, change_kind, proposed_code, proposed_name_ar, proposed_account_type, requested_by, status)
            values (${entityId}, ${freshDocNo()}, 'create', ${proposedCode}, ${NAME_AR}, ${VALID_ACCOUNT_TYPE}, ${MAKER_ACTOR_UUID}, 'pending_approval')
            returning id`,
      );
    });
    const requestId = insertResult.rows[0]?.id;
    if (!requestId) throw new Error('withContext insert returned no id');
    fixtureRequestIds.push(requestId);

    const result = await withContext(ctxFor(OTHER_MAKER_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute(sql`update billing.gl_account_change_requests set status = 'cancelled' where id = ${requestId}`);
    });
    expect((result as unknown as { rowCount?: number }).rowCount ?? 0).toBe(0);

    const row = await getRequestRow(requestId);
    expect(row.status).toBe('pending_approval'); // unchanged — the non-owner's UPDATE matched 0 rows.
  });

  it('an INSERT with requested_by set to someone OTHER than the caller is rejected (42501)', async () => {
    let rejected = false;
    let rejectionCode: string | undefined;
    try {
      await withContext(ctxFor(MAKER_ACTOR_UUID), async (tx: NodePgDatabase) => {
        return tx.execute(
          sql`insert into billing.gl_account_change_requests
                (entity_id, doc_no, change_kind, proposed_code, proposed_name_ar, proposed_account_type, requested_by)
              values (${entityId}, ${freshDocNo()}, 'create', ${freshProposedCode()}, ${NAME_AR}, ${VALID_ACCOUNT_TYPE}, ${OTHER_MAKER_ACTOR_UUID})`,
        );
      });
    } catch (error) {
      rejected = true;
      const cause = (error as { cause?: { code?: string } }).cause;
      rejectionCode = cause?.code ?? (error as { code?: string }).code;
    }
    expect(rejected).toBe(true);
    expect(rejectionCode).toBe('42501');
  });

  it('the maker attempting to set their own row\'s status to approved/rejected directly is rejected (own-row UPDATE policy locks decision columns to null)', async () => {
    const proposedCode = freshProposedCode();
    const insertResult = await withContext(ctxFor(MAKER_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute<{ id: string }>(
        sql`insert into billing.gl_account_change_requests
              (entity_id, doc_no, change_kind, proposed_code, proposed_name_ar, proposed_account_type, requested_by, status)
            values (${entityId}, ${freshDocNo()}, 'create', ${proposedCode}, ${NAME_AR}, ${VALID_ACCOUNT_TYPE}, ${MAKER_ACTOR_UUID}, 'pending_approval')
            returning id`,
      );
    });
    const requestId = insertResult.rows[0]?.id;
    if (!requestId) throw new Error('withContext insert returned no id');
    fixtureRequestIds.push(requestId);

    let rejected = false;
    try {
      await withContext(ctxFor(MAKER_ACTOR_UUID), async (tx: NodePgDatabase) => {
        return tx.execute(
          sql`update billing.gl_account_change_requests
                 set status = 'approved', approved_by = ${MAKER_ACTOR_UUID}, approved_at = now(), decided_at = now()
               where id = ${requestId}`,
        );
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);

    const row = await getRequestRow(requestId);
    expect(row.status).toBe('pending_approval');
  });
});

describe('§9(i) [fix round finding 6]: the gl_accounts approver write policies (gl_account_change_write_insert / gl_account_change_write_update) enforce the entity boundary, independent of billing.assert_gl_account_change_approved()', () => {
  // Structural note (why the trigger is disabled for this test, in-transaction, never committed):
  // billing.assert_gl_account_change_approved() is NOT security definer, so its own internal SELECT
  // against billing.gl_account_change_requests is itself subject to glc_entity_scope RLS as the CALLING
  // session. Its NOT EXISTS match additionally requires r.entity_id = new.entity_id. Together these two
  // facts mean the trigger can only ever find a matching approved row when new.entity_id is ALSO an
  // entity the acting session is already scoped to via platform.allowed_entities() — the exact same
  // predicate the gl_accounts write policy's own entity-boundary check uses. A cross-entity CFO can
  // therefore never simultaneously satisfy the trigger's content-match AND fail the write policy's
  // entity check; whichever fires first (the trigger, for INSERT/UPDATE, per Postgres's own BEFORE-
  // trigger-before-WITH-CHECK ordering) always wins with its own '0034:' message. The ONLY way to prove
  // the write policy's entity boundary is enforced ON ITS OWN, independent of the trigger, is to remove
  // the trigger from the equation for the duration of this one transaction (DISABLE — rolled back,
  // never committed, re-enabled automatically) — the cleanest possible isolation.
  it('a CFO scoped to a DIFFERENT entity than the target gl_accounts row is rejected by RLS (42501, message does NOT contain the trigger\'s own \'0034:\' prefix) even with a content-matching approved request set up in that OTHER entity', async () => {
    const proposedCode = freshProposedCode();
    const client = await pool.connect();
    let rejected = false;
    let code: string | undefined;
    let message = '';
    try {
      await client.query('begin');

      // Seed a fully-approved, content-matching create request for `entityId` AS THE ADMIN/SUPERUSER
      // role (bypasses RLS entirely AND the trigger's own `current_user <> 'pgeos_app'` bypass —
      // Condition 1), approved_by = OTHER_ENTITY_CFO_ACTOR_UUID (a real CFO, but scoped ONLY to
      // otherEntityId, never entityId) — a plausible, legitimate-looking approval scenario, present so
      // this test cannot be accused of merely proving "no approved request exists" rather than the
      // entity boundary specifically.
      const seeded = await client.query(
        `insert into billing.gl_account_change_requests
           (entity_id, doc_no, change_kind, proposed_code, proposed_name_ar, proposed_account_type,
            status, requested_by, approved_by, approved_at, decided_at)
         values ($1, $2, 'create', $3, $4, $5, 'approved', $6, $7, now(), now())
         returning id`,
        [entityId, freshDocNo(), proposedCode, NAME_AR, VALID_ACCOUNT_TYPE, MAKER_UUID, OTHER_ENTITY_CFO_ACTOR_UUID],
      );
      const requestId = seeded.rows[0]?.id;
      if (!requestId) throw new Error('seed insert returned no id');
      fixtureRequestIds.push(requestId);

      // Remove the trigger from the equation for the rest of THIS transaction only (see the describe-
      // level comment above for why this is the only way to isolate the write policy's own entity
      // boundary from the trigger's separate, entity-coupled content-matching check).
      await client.query('alter table billing.gl_accounts disable trigger trg_assert_gl_account_change_approved');

      // Switch to pgeos_app AS OTHER_ENTITY_CFO_ACTOR_UUID — a real CFO (is_approval_chain_approver
      // passes on ROLE alone), but scoped ONLY to otherEntityId, never entityId.
      await client.query('set local role pgeos_app');
      await client.query(`select set_config('app.user_id', $1, true)`, [OTHER_ENTITY_CFO_ACTOR_UUID]);
      await client.query(`select set_config('app.client_id', $1, true)`, [null]);
      await client.query(`select set_config('app.is_internal', 'true', true)`);

      try {
        await client.query(
          `insert into billing.gl_accounts (entity_id, code, name_ar, account_type) values ($1, $2, $3, $4)`,
          [entityId, proposedCode, NAME_AR, VALID_ACCOUNT_TYPE],
        );
      } catch (error) {
        rejected = true;
        code = (error as { code?: string }).code;
        message = (error as { message?: string }).message ?? '';
      }
    } finally {
      await client.query('rollback'); // unconditional — never committed either way; re-enables the trigger too.
      client.release();
    }

    expect(rejected).toBe(true);
    // 42501 = insufficient_privilege, the generic SQLSTATE Postgres itself raises for an RLS WITH
    // CHECK violation — distinguishable from the trigger's OWN 42501 rejections (which always carry the
    // '0034:' message prefix) by the ABSENCE of that prefix. With the trigger disabled for this
    // transaction, this rejection can only be RLS's own gl_accounts entity-scope check.
    expect(code).toBe('42501');
    expect(message).not.toContain('0034:');
  });

  // UPDATE-side counterpart to the INSERT test above (round-3 confirmation-pass gap): the same
  // gl_accounts approver write policy also covers UPDATE (the brief's own "INSERT/UPDATE policy"
  // wording), and only the INSERT half had entity-boundary coverage. Same isolation technique —
  // the trigger is disabled for the duration of the (rolled-back) transaction so the write policy's
  // own USING/WITH CHECK entity check is what is exercised, not the trigger's separate,
  // entity-coupled content-matching NOT EXISTS clause.
  it('a CFO scoped to entityId cannot UPDATE a gl_accounts row belonging to a DIFFERENT entity (cross-entity UPDATE rejected by RLS — either thrown 42501 without the trigger\'s own \'0034:\' prefix, or silently matching 0 rows via the USING clause)', async () => {
    const client = await pool.connect();
    let rejected = false;
    let code: string | undefined;
    let message = '';
    try {
      await client.query('begin');

      const otherEntityAccount: QueryResult<{ id: string }> = await client.query(
        `insert into billing.gl_accounts (entity_id, code, name_ar, account_type) values ($1, $2, $3, $4) returning id`,
        [otherEntityId, freshProposedCode(), 'حساب في كيان آخر — اختبار حدود الكيان (تحديث)', VALID_ACCOUNT_TYPE],
      );
      const targetId = otherEntityAccount.rows[0]?.id;
      if (!targetId) throw new Error('fixture other-entity gl_accounts insert returned no id');

      // Remove the trigger from the equation for the rest of THIS transaction only — same rationale
      // as the describe-level comment above.
      await client.query('alter table billing.gl_accounts disable trigger trg_assert_gl_account_change_approved');

      // Switch to pgeos_app AS CFO_ACTOR_UUID — scoped ONLY to entityId, never otherEntityId.
      await client.query('set local role pgeos_app');
      await client.query(`select set_config('app.user_id', $1, true)`, [CFO_ACTOR_UUID]);
      await client.query(`select set_config('app.client_id', $1, true)`, [null]);
      await client.query(`select set_config('app.is_internal', 'true', true)`);

      try {
        const result = await client.query(`update billing.gl_accounts set name_en = $2 where id = $1`, [
          targetId,
          'must never be written — cross-entity UPDATE',
        ]);
        if ((result.rowCount ?? 0) === 0) {
          rejected = true; // silently filtered out of the actor's own visible rowset by the USING clause.
        }
      } catch (error) {
        rejected = true;
        code = (error as { code?: string }).code;
        message = (error as { message?: string }).message ?? '';
      }
    } finally {
      await client.query('rollback'); // unconditional — never committed either way; re-enables the trigger too.
      client.release();
    }

    expect(rejected).toBe(true);
    if (code !== undefined) {
      expect(code).toBe('42501');
      expect(message).not.toContain('0034:');
    }
  });

  // Positive control for the UPDATE-side write policy (round-3 confirmation-pass gap): proves the
  // policy actually GRANTS a same-entity approver UPDATE, not merely that it rejects everything —
  // the negative-only coverage above and in §9(i)'s INSERT test could otherwise equally be explained
  // by a policy that rejects ALL UPDATEs unconditionally. Trigger disabled for the same isolation
  // reason (the write policy's own entity check is what is under test here, not the trigger's
  // separate content-matching requirement).
  it('a CFO scoped to entityId CAN UPDATE a gl_accounts row belonging to THAT SAME entity (same-entity UPDATE succeeds — positive control for the write policy\'s entity check)', async () => {
    const client = await pool.connect();
    let succeeded: boolean;
    try {
      await client.query('begin');

      const sameEntityAccount: QueryResult<{ id: string }> = await client.query(
        `insert into billing.gl_accounts (entity_id, code, name_ar, account_type) values ($1, $2, $3, $4) returning id`,
        [entityId, freshProposedCode(), 'حساب في نفس الكيان — ضابط تحكم إيجابي (تحديث)', VALID_ACCOUNT_TYPE],
      );
      const targetId = sameEntityAccount.rows[0]?.id;
      if (!targetId) throw new Error('fixture same-entity gl_accounts insert returned no id');

      await client.query('alter table billing.gl_accounts disable trigger trg_assert_gl_account_change_approved');

      await client.query('set local role pgeos_app');
      await client.query(`select set_config('app.user_id', $1, true)`, [CFO_ACTOR_UUID]);
      await client.query(`select set_config('app.client_id', $1, true)`, [null]);
      await client.query(`select set_config('app.is_internal', 'true', true)`);

      const result = await client.query(`update billing.gl_accounts set name_en = $2 where id = $1`, [
        targetId,
        'same-entity UPDATE positive control',
      ]);
      succeeded = (result.rowCount ?? 0) === 1;
    } finally {
      await client.query('rollback'); // unconditional — never committed either way; re-enables the trigger too.
      client.release();
    }

    expect(succeeded).toBe(true);
  });
});
