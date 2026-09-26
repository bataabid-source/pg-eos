// modules/billing/tests/gl-account-change-requests/gl-account-change-requests.test.ts — WBS 4.1a part 2.
//
// NOTE for whoever reads this file after scripts/new-slice.sh: this REPLACES the scaffolded copy of
// the golden slice's (wms/receive-inbound) own gl-account-change-requests.test.ts content. That file exercised
// approveInbound/receiveLine/etc. application commands that have nothing to do with this slice — the
// maker/checker write path for billing.gl_accounts (docs/notes/slice-briefs/_slice-4.1a-part2.brief.md).
//
// Scope (pre-application-layer, DB level only — same admin-pool discipline as
// ../chart-of-accounts/chart-of-accounts.test.ts and ../record-billable-event/record-billable-event.test.ts's
// own admin-pool scenarios): this slice's migration (database/migrations/0034_2_gl-account-change-requests.sql)
// has landed — billing.gl_account_change_requests, billing.is_valid_gl_account_code(),
// billing.is_valid_gl_account_type() and the composite FKs (billing.gl_accounts(id, entity_id)
// unique pair, gl_accounts.parent_id/entity_id self-referencing retrofit,
// gl_account_change_requests.proposed_parent_id/entity_id and .target_account_id/entity_id) all
// exist. Every test below proves the SCHEMA-LEVEL rule (CHECK/FK/unique index) fires on its own,
// independent of any application-layer command — no Submit/Approve/Reject/Cancel command exists yet
// (WBS 4.1a part 2's own domain/application split, brief §"gl_accounts write — ONLY inside
// Approve"; that command lands in part 2b).
//
// requested_by/approved_by carry NO foreign key to identity.users in the brief's own column list —
// arbitrary fixed UUIDs are used below (no identity.users fixture rows needed for this DB-level
// suite; the four-eyes SoD guarantee comes from identity.sod_rules' pre-existing (CFO,ACCOUNTANT)
// row, already covered at the role-assignment level, not re-tested here).

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WithContextCtx } from '@pg-eos/db';
import { withContext } from '@pg-eos/db';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// Admin pool (PGUSER, bypasses RLS) — fixture setup/teardown and every scenario below: this slice
// has no application layer yet, so every write goes in directly, proving the DB's own rules.
const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

// --- literals ----------------------------------------------------------------------------------

const NAME_AR = 'طلب تعديل حساب اختبار — WBS 4.1a part 2';
const VALID_ACCOUNT_TYPE = 'expense'; // one of the 9 allowed values (0028_2), unused elsewhere in this file's own literals.
// Distinct code family from ../chart-of-accounts/*.test.ts (classes 1-5) and
// ../gl-account-change-requests/invariants.property.test.ts (classes 7-9) — class 6, this file's own block.
const CHECK_VIOLATION_SQLSTATE = '23514';
const FOREIGN_KEY_VIOLATION_SQLSTATE = '23503'; // composite FK — NOT a CHECK. Distinct SQLSTATE, asserted explicitly below.
const UNIQUE_VIOLATION_SQLSTATE = '23505';

const ACCOUNTANT_UUID = '00000000-0000-4000-8000-0000004a2a01'; // requested_by — no FK to identity.users per the brief's own column list.
const CFO_UUID = '00000000-0000-4000-8000-0000004a2a02'; // approved_by.
const OTHER_ACCOUNTANT_UUID = '00000000-0000-4000-8000-0000004a2a03';

const OFF_FORMAT_PROPOSED_CODES = [
  '6-1-001-001', // second segment only 1 digit
  '6-01-01-001', // third segment only 2 digits
  '6_01_001_001', // wrong separator
  '0-01-001-001', // class 0, outside 1-9
];

let entityId: string;
let otherEntityId: string;
let existingGlAccountId: string; // for 'update' change_kind fixtures — an existing gl_accounts row, entityId's own.
let otherEntityGlAccountId: string; // an existing gl_accounts row belonging to otherEntityId — the composite-FK scenario.

const insertedRequestIds: string[] = [];
const insertedAccountIds: string[] = [];

let codeCounter = 0;
/** A fresh, never-reused proposed_code in this file's own class-6 block — avoids any unique-index
 *  collision between scenarios (the partial unique index on (entity_id, proposed_code) for pending
 *  create requests is itself under test in one scenario below, so every OTHER scenario needs its
 *  own distinct code). */
function freshProposedCode(): string {
  codeCounter += 1;
  return `6-01-001-${String(codeCounter).padStart(3, '0')}`;
}

function freshDocNo(): string {
  return `GLC-TEST-${randomUUID().slice(0, 8)}`;
}

interface InsertRequestInput {
  readonly entityId: string;
  readonly changeKind: 'create' | 'update' | 'deactivate' | 'reactivate';
  readonly targetAccountId?: string | null;
  readonly proposedCode?: string | null;
  readonly proposedAccountType?: string | null;
  readonly proposedParentId?: string | null;
  readonly status?: string;
  readonly requestedBy?: string;
  readonly approvedBy?: string | null;
  readonly rejectionReason?: string | null;
}

async function insertChangeRequest(input: InsertRequestInput): Promise<QueryResult<{ id: string }>> {
  return pool.query(
    `insert into billing.gl_account_change_requests
       (entity_id, doc_no, change_kind, target_account_id, proposed_code, proposed_name_ar,
        proposed_account_type, proposed_parent_id, status, requested_by, approved_by, rejection_reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning id`,
    [
      input.entityId,
      freshDocNo(),
      input.changeKind,
      input.targetAccountId ?? null,
      input.proposedCode ?? null,
      input.proposedCode ? NAME_AR : null,
      input.proposedAccountType ?? null,
      input.proposedParentId ?? null,
      input.status ?? 'draft',
      input.requestedBy ?? ACCOUNTANT_UUID,
      input.approvedBy ?? null,
      input.rejectionReason ?? null,
    ],
  );
}

async function insertGlAccount(forEntityId: string, code: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into billing.gl_accounts (entity_id, code, name_ar, account_type) values ($1, $2, $3, $4) returning id`,
    [forEntityId, code, 'حساب هدف اختبار — WBS 4.1a part 2', VALID_ACCOUNT_TYPE],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture billing.gl_accounts insert returned no row');
  insertedAccountIds.push(row.id);
  return row.id;
}

// WBS 4.1a part 3 — insertGlAccount above cannot express a parent_id (fixed signature, reused by
// every part-2 scenario above); this variant is used ONLY by the new deactivate/reactivate/
// active-children tests below.
async function insertGlAccountWithParent(forEntityId: string, code: string, parentId: string | null): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into billing.gl_accounts (entity_id, code, name_ar, account_type, parent_id) values ($1, $2, $3, $4, $5) returning id`,
    [forEntityId, code, 'حساب هدف اختبار الإلغاء/إعادة التنشيط — WBS 4.1a part 3', VALID_ACCOUNT_TYPE, parentId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture billing.gl_accounts insert (deactivate/reactivate, part 3) returned no row');
  insertedAccountIds.push(row.id);
  return row.id;
}

// WBS 4.1a part 3 — references the NEW billing.gl_accounts.is_active column (does not exist yet;
// this is expected to fail with 42703 undefined_column until the migration lands).
async function setGlAccountActive(id: string, isActive: boolean): Promise<void> {
  await pool.query(`update billing.gl_accounts set is_active = $2 where id = $1`, [id, isActive]);
}

async function getGlAccountIsActive(id: string): Promise<boolean> {
  const result: QueryResult<{ is_active: boolean }> = await pool.query(
    `select is_active from billing.gl_accounts where id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no billing.gl_accounts row for id ${id}`);
  return row.is_active;
}

async function countGlAccountsForCode(code: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from billing.gl_accounts where code = $1`,
    [code],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function getRequestStatus(id: string): Promise<string> {
  const result: QueryResult<{ status: string }> = await pool.query(
    `select status from billing.gl_account_change_requests where id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no billing.gl_account_change_requests row for id ${id}`);
  return row.status;
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

  existingGlAccountId = await insertGlAccount(entityId, '6-09-900-001');
  otherEntityGlAccountId = await insertGlAccount(otherEntityId, '6-09-900-002');

  // Finding 9(f): confirm withContext's pool genuinely connects as pgeos_app BEFORE trusting any RLS
  // assertion in this file — an unset PG_APP_USER env var silently falls back to PGUSER (postgres,
  // superuser, RLS-blind), which would make the "Fix round finding 10" RLS section below (and the
  // §"CFO approves" headline scenario) pass spuriously without ever exercising RLS at all.
  const currentUserResult = await withContext({ userId: CFO_UUID, clientId: null, isInternal: true }, async (tx: NodePgDatabase) => {
    return tx.execute<{ current_user: string }>(sql`select current_user`);
  });
  expect(currentUserResult.rows[0]?.['current_user']).toBe('pgeos_app');
});

afterAll(async () => {
  // Round-1 fix round finding 1: this file no longer writes any platform.audit_log row itself (audit-
  // row proof is deferred to part 2b's real Approve command), so there is nothing append-only to leave
  // behind here — every fixture table this file wrote to is cleaned up below.
  if (insertedRequestIds.length > 0) {
    await pool.query(`delete from billing.gl_account_change_requests where id = any($1::uuid[])`, [insertedRequestIds]);
  }
  if (insertedAccountIds.length > 0) {
    await pool.query(`delete from billing.gl_accounts where id = any($1::uuid[])`, [insertedAccountIds]);
  }
  if (appFixtureActorIds.length > 0) {
    await pool.query(`delete from platform.idempotency_keys where user_id = any($1::uuid[])`, [appFixtureActorIds]);
    await pool.query(`delete from identity.user_roles where user_id = any($1::uuid[])`, [appFixtureActorIds]);
    await pool.query(`delete from identity.user_entities where user_id = any($1::uuid[])`, [appFixtureActorIds]);
    await pool.query(`delete from identity.users where id = any($1::uuid[])`, [appFixtureActorIds]);
  }
  await pool.end();
});

// --- Scenario: An ACCOUNTANT submits a create request; a gl_accounts row does NOT yet exist -------

describe('Scenario: An ACCOUNTANT submits a create request; a gl_accounts row does NOT yet exist', () => {
  it('inserting a pending_approval create request writes no billing.gl_accounts row for the proposed code', async () => {
    const proposedCode = freshProposedCode();
    const result = await insertChangeRequest({
      entityId,
      changeKind: 'create',
      proposedCode,
      proposedAccountType: VALID_ACCOUNT_TYPE,
      status: 'pending_approval',
      requestedBy: ACCOUNTANT_UUID,
    });
    const id = result.rows[0]?.id;
    if (!id) throw new Error('fixture insert returned no id');
    insertedRequestIds.push(id);

    expect(await getRequestStatus(id)).toBe('pending_approval');
    expect(await countGlAccountsForCode(proposedCode)).toBe(0);
  });
});

// --- Scenario: The CFO approves a pending create request; the gl_accounts row is inserted in the --
// --- SAME transaction, both users traceable in the audit row --------------------------------------

describe('Scenario: The CFO approves a pending create request; the gl_accounts row is inserted in the SAME transaction', () => {
  // Finding 8: this is the actual legitimate end-to-end path the whole feature exists to prove — a
  // REAL pgeos_app CFO session (withContext, genuinely subject to RLS and the trigger), not the
  // admin/superuser pool, and in the CORRECT order: (1) approve the request FIRST, (2) THEN insert
  // gl_accounts with matching proposed_* values — all inside the SAME withContext transaction, so
  // decided_at = now() still matches the trigger's replay guard (round-2 finding 2). Under pgeos_app,
  // the OLD order (insert gl_accounts, then update the request) would be rejected by
  // billing.assert_gl_account_change_approved() outright — no approved request exists yet at INSERT
  // time.
  //
  // Round-1 finding 1: this scenario does NOT insert or assert on a platform.audit_log row — no
  // Approve command exists yet (that lands in part 2b), so inserting an audit row here and then
  // asserting what it just wrote would not prove anything about real system behavior. Audit-row
  // proof (one row naming both the CFO and the ACCOUNTANT) is deferred to part 2b's real Approve
  // command and its own test.
  it('a real CFO session: UPDATE the request to approved, THEN INSERT gl_accounts — one transaction', async () => {
    await createAppFixtureActor(APP_CFO_ACTOR_UUID, entityId, ROLE_CFO);

    const proposedCode = freshProposedCode();
    const submitted = await insertChangeRequest({
      entityId,
      changeKind: 'create',
      proposedCode,
      proposedAccountType: VALID_ACCOUNT_TYPE,
      status: 'pending_approval',
      requestedBy: ACCOUNTANT_UUID,
    });
    const requestId = submitted.rows[0]?.id;
    if (!requestId) throw new Error('fixture insert returned no id');
    insertedRequestIds.push(requestId);

    let newAccountId: string | undefined;
    await withContext(ctxFor(APP_CFO_ACTOR_UUID), async (tx: NodePgDatabase) => {
      // (1) Approve FIRST — the request must already be 'approved', decided in THIS transaction,
      // before the gl_accounts write below can ever satisfy the trigger.
      await tx.execute(
        sql`update billing.gl_account_change_requests
               set status = 'approved', approved_by = ${APP_CFO_ACTOR_UUID}, approved_at = now(), decided_at = now()
             where id = ${requestId}`,
      );

      // (2) THEN insert gl_accounts with matching proposed_* values, same transaction (decided_at =
      // now() still equals THIS transaction's start timestamp).
      const accountResult = await tx.execute<{ id: string }>(
        sql`insert into billing.gl_accounts (entity_id, code, name_ar, account_type)
            values (${entityId}, ${proposedCode}, ${NAME_AR}, ${VALID_ACCOUNT_TYPE}) returning id`,
      );
      newAccountId = accountResult.rows[0]?.id;
      if (!newAccountId) throw new Error('approve-transaction gl_accounts insert returned no row');
    });

    if (!newAccountId) throw new Error('legitimate-path insert returned no id');
    insertedAccountIds.push(newAccountId);

    expect(await countGlAccountsForCode(proposedCode)).toBe(1);
    expect(await getRequestStatus(requestId)).toBe('approved');
  });
});

// --- Scenario: The CFO rejects a pending request; no gl_accounts row is ever written; ------------
// --- rejection_reason is required -----------------------------------------------------------------

describe('Scenario: The CFO rejects a pending request; no gl_accounts row is ever written; rejection_reason is required', () => {
  it('rejecting WITHOUT rejection_reason is rejected by the DB CHECK', async () => {
    const proposedCode = freshProposedCode();
    const submitted = await insertChangeRequest({
      entityId,
      changeKind: 'create',
      proposedCode,
      proposedAccountType: VALID_ACCOUNT_TYPE,
      status: 'pending_approval',
      requestedBy: ACCOUNTANT_UUID,
    });
    const requestId = submitted.rows[0]?.id;
    if (!requestId) throw new Error('fixture insert returned no id');
    insertedRequestIds.push(requestId);

    await expect(
      pool.query(
        `update billing.gl_account_change_requests set status = 'rejected', approved_by = $2 where id = $1`,
        [requestId, CFO_UUID],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION_SQLSTATE });

    expect(await getRequestStatus(requestId)).toBe('pending_approval');
  });

  it('rejecting WITH rejection_reason succeeds and no billing.gl_accounts row is ever written for it', async () => {
    const proposedCode = freshProposedCode();
    const submitted = await insertChangeRequest({
      entityId,
      changeKind: 'create',
      proposedCode,
      proposedAccountType: VALID_ACCOUNT_TYPE,
      status: 'pending_approval',
      requestedBy: ACCOUNTANT_UUID,
    });
    const requestId = submitted.rows[0]?.id;
    if (!requestId) throw new Error('fixture insert returned no id');
    insertedRequestIds.push(requestId);

    await pool.query(
      `update billing.gl_account_change_requests
          set status = 'rejected', approved_by = $2, decided_at = now(), rejection_reason = $3
        where id = $1`,
      [requestId, CFO_UUID, 'proposed code duplicates an existing chart entry'],
    );

    expect(await getRequestStatus(requestId)).toBe('rejected');
    expect(await countGlAccountsForCode(proposedCode)).toBe(0);
  });
});

// --- Scenario: An off-format proposed_code is rejected by the shared code-format function's CHECK -

describe("Scenario: An off-format proposed_code is rejected by the shared code-format function's CHECK, same rule as gl_accounts itself", () => {
  it.each(OFF_FORMAT_PROPOSED_CODES)('proposed_code %s is rejected by the DB CHECK (billing.is_valid_gl_account_code)', async (code) => {
    await expect(
      insertChangeRequest({ entityId, changeKind: 'create', proposedCode: code, proposedAccountType: VALID_ACCOUNT_TYPE }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION_SQLSTATE });
  });
});

// --- Scenario: A proposed_parent_id in a different entity is rejected (composite FK, not a CHECK) --

describe('Scenario: A proposed_parent_id in a different entity is rejected (composite FK, not a CHECK — Master ruling)', () => {
  it('rejects with SQLSTATE 23503 (foreign_key_violation) — NOT 23514 (check_violation), the distinguishing signal that this is the composite FK, not a CHECK', async () => {
    await expect(
      insertChangeRequest({
        entityId, // the REQUEST's own entity.
        changeKind: 'update',
        targetAccountId: existingGlAccountId,
        proposedAccountType: VALID_ACCOUNT_TYPE,
        proposedParentId: otherEntityGlAccountId, // belongs to otherEntityId, not entityId.
      }),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION_SQLSTATE });
  });

  it('the SAME parent id succeeds when it belongs to the SAME entity as the request (positive control)', async () => {
    const result = await insertChangeRequest({
      entityId,
      changeKind: 'update',
      targetAccountId: existingGlAccountId,
      proposedAccountType: VALID_ACCOUNT_TYPE,
      proposedParentId: existingGlAccountId, // same entity as `entityId` — the composite FK is satisfied.
    });
    const id = result.rows[0]?.id;
    if (!id) throw new Error('fixture insert returned no id');
    insertedRequestIds.push(id);
  });
});

// --- Scenario: A target_account_id in a different entity is rejected (composite FK ----------------
// --- gl_account_change_requests_target_entity_fk, not a CHECK — round-1 fix round finding 2) --------

describe('Scenario: A target_account_id in a different entity is rejected (composite FK gl_account_change_requests_target_entity_fk, not a CHECK — Master ruling)', () => {
  it('rejects with SQLSTATE 23503 (foreign_key_violation) when an update request targets an account belonging to a DIFFERENT entity than the request itself', async () => {
    await expect(
      insertChangeRequest({
        entityId, // the REQUEST's own entity.
        changeKind: 'update',
        targetAccountId: otherEntityGlAccountId, // belongs to otherEntityId, not entityId.
        proposedAccountType: VALID_ACCOUNT_TYPE,
      }),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION_SQLSTATE });
  });

  it('the SAME target_account_id succeeds when it belongs to the SAME entity as the request (positive control)', async () => {
    const result = await insertChangeRequest({
      entityId,
      changeKind: 'update',
      targetAccountId: existingGlAccountId, // same entity as `entityId` — the composite FK is satisfied.
      proposedAccountType: VALID_ACCOUNT_TYPE,
    });
    const id = result.rows[0]?.id;
    if (!id) throw new Error('fixture insert returned no id');
    insertedRequestIds.push(id);
  });
});

// --- Scenario: gl_accounts.parent_id must belong to the SAME entity as the child (retrofit ----------
// --- composite FK gl_accounts_parent_entity_fk — round-1 fix round finding 3) ------------------------

describe('Scenario: gl_accounts.parent_id must belong to the SAME entity as the child (retrofit composite FK gl_accounts_parent_entity_fk)', () => {
  it('an admin-pool INSERT with parent_id pointing at a DIFFERENT entity\'s account fails with SQLSTATE 23503', async () => {
    await expect(
      pool.query(
        `insert into billing.gl_accounts (entity_id, code, name_ar, account_type, parent_id) values ($1, $2, $3, $4, $5)`,
        [entityId, freshProposedCode(), NAME_AR, VALID_ACCOUNT_TYPE, otherEntityGlAccountId],
      ),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION_SQLSTATE });
  });

  it('an admin-pool UPDATE setting parent_id to a DIFFERENT entity\'s account fails with SQLSTATE 23503', async () => {
    await expect(
      pool.query(`update billing.gl_accounts set parent_id = $2 where id = $1`, [existingGlAccountId, otherEntityGlAccountId]),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION_SQLSTATE });
  });

  it('parent_id pointing at an account in the SAME entity succeeds (positive control)', async () => {
    const code = freshProposedCode();
    const result: QueryResult<{ id: string }> = await pool.query(
      `insert into billing.gl_accounts (entity_id, code, name_ar, account_type, parent_id) values ($1, $2, $3, $4, $5) returning id`,
      [entityId, code, NAME_AR, VALID_ACCOUNT_TYPE, existingGlAccountId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('fixture insert returned no id');
    insertedAccountIds.push(row.id);
  });
});

// --- Scenario: The same user cannot be both requested_by and approved_by --------------------------

describe('Scenario: The same user cannot be both requested_by and approved_by (CHECK, and structurally via the pre-existing CFO/ACCOUNTANT sod_rules row)', () => {
  it('inserting directly with requested_by = approved_by = the SAME user is rejected by the DB CHECK', async () => {
    await expect(
      insertChangeRequest({
        entityId,
        changeKind: 'create',
        proposedCode: freshProposedCode(),
        proposedAccountType: VALID_ACCOUNT_TYPE,
        status: 'approved',
        requestedBy: ACCOUNTANT_UUID,
        approvedBy: ACCOUNTANT_UUID, // same user as requestedBy.
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION_SQLSTATE });
  });

  it('a DIFFERENT approved_by (the CFO) succeeds (positive control)', async () => {
    const result = await insertChangeRequest({
      entityId,
      changeKind: 'create',
      proposedCode: freshProposedCode(),
      proposedAccountType: VALID_ACCOUNT_TYPE,
      status: 'approved',
      requestedBy: ACCOUNTANT_UUID,
      approvedBy: CFO_UUID,
    });
    const id = result.rows[0]?.id;
    if (!id) throw new Error('fixture insert returned no id');
    insertedRequestIds.push(id);
  });

  it('an UPDATE that sets approved_by = requested_by on an existing row is also rejected by the CHECK (not only on INSERT)', async () => {
    const submitted = await insertChangeRequest({
      entityId,
      changeKind: 'create',
      proposedCode: freshProposedCode(),
      proposedAccountType: VALID_ACCOUNT_TYPE,
      status: 'pending_approval',
      requestedBy: OTHER_ACCOUNTANT_UUID,
    });
    const requestId = submitted.rows[0]?.id;
    if (!requestId) throw new Error('fixture insert returned no id');
    insertedRequestIds.push(requestId);

    await expect(
      pool.query(`update billing.gl_account_change_requests set status = 'approved', approved_by = $2 where id = $1`, [
        requestId,
        OTHER_ACCOUNTANT_UUID, // same as requested_by above.
      ]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION_SQLSTATE });
  });
});

// --- Scenario: A second pending request for the same target_account_id (or the same proposed ------
// --- create code) is rejected by the partial unique index -----------------------------------------

describe('Scenario: A second pending request for the same target_account_id (or the same proposed create code) is rejected by the partial unique index', () => {
  it('a second pending_approval UPDATE request naming the SAME target_account_id is rejected (23505)', async () => {
    const first = await insertChangeRequest({
      entityId,
      changeKind: 'update',
      targetAccountId: existingGlAccountId,
      proposedAccountType: VALID_ACCOUNT_TYPE,
      status: 'pending_approval',
    });
    const firstId = first.rows[0]?.id;
    if (!firstId) throw new Error('fixture insert returned no id');
    insertedRequestIds.push(firstId);

    await expect(
      insertChangeRequest({
        entityId,
        changeKind: 'update',
        targetAccountId: existingGlAccountId, // SAME target, also pending_approval.
        proposedAccountType: VALID_ACCOUNT_TYPE,
        status: 'pending_approval',
      }),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION_SQLSTATE });
  });

  it('a second pending_approval CREATE request proposing the SAME (entity_id, proposed_code) is rejected (23505)', async () => {
    const proposedCode = freshProposedCode();
    const first = await insertChangeRequest({
      entityId,
      changeKind: 'create',
      proposedCode,
      proposedAccountType: VALID_ACCOUNT_TYPE,
      status: 'pending_approval',
    });
    const firstId = first.rows[0]?.id;
    if (!firstId) throw new Error('fixture insert returned no id');
    insertedRequestIds.push(firstId);

    await expect(
      insertChangeRequest({
        entityId,
        changeKind: 'create',
        proposedCode, // SAME code, same entity, also pending_approval.
        proposedAccountType: VALID_ACCOUNT_TYPE,
        status: 'pending_approval',
      }),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION_SQLSTATE });
  });

  it('the SAME proposed_code is accepted again once the FIRST pending request is no longer pending (e.g. rejected) — the index is PARTIAL', async () => {
    const proposedCode = freshProposedCode();
    const first = await insertChangeRequest({
      entityId,
      changeKind: 'create',
      proposedCode,
      proposedAccountType: VALID_ACCOUNT_TYPE,
      status: 'pending_approval',
    });
    const firstId = first.rows[0]?.id;
    if (!firstId) throw new Error('fixture insert returned no id');
    insertedRequestIds.push(firstId);

    await pool.query(
      `update billing.gl_account_change_requests
          set status = 'rejected', rejection_reason = $2, approved_by = $3
        where id = $1`,
      [firstId, 'superseded', CFO_UUID],
    );

    const second = await insertChangeRequest({
      entityId,
      changeKind: 'create',
      proposedCode, // same code — legal now, the first request is no longer 'pending_approval'.
      proposedAccountType: VALID_ACCOUNT_TYPE,
      status: 'pending_approval',
    });
    const secondId = second.rows[0]?.id;
    if (!secondId) throw new Error('fixture insert returned no id');
    insertedRequestIds.push(secondId);
  });

  it('the SAME target_account_id in two DIFFERENT (non-overlapping) pending windows is fine — an approved request does not block a later one', async () => {
    // A separate target account, to avoid interfering with the still-pending row this describe
    // block's own first test leaves behind on `existingGlAccountId`.
    const secondTargetId = await insertGlAccount(entityId, '6-09-900-003');

    const first = await insertChangeRequest({
      entityId,
      changeKind: 'update',
      targetAccountId: secondTargetId,
      proposedAccountType: VALID_ACCOUNT_TYPE,
      status: 'pending_approval',
    });
    const firstId = first.rows[0]?.id;
    if (!firstId) throw new Error('fixture insert returned no id');
    insertedRequestIds.push(firstId);

    await pool.query(
      `update billing.gl_account_change_requests
          set status = 'approved', approved_by = $2, approved_at = now(), decided_at = now()
        where id = $1`,
      [firstId, CFO_UUID],
    );

    const second = await insertChangeRequest({
      entityId,
      changeKind: 'update',
      targetAccountId: secondTargetId, // same target, but the first is now 'approved', not pending.
      proposedAccountType: VALID_ACCOUNT_TYPE,
      status: 'pending_approval',
    });
    const secondId = second.rows[0]?.id;
    if (!secondId) throw new Error('fixture insert returned no id');
    insertedRequestIds.push(secondId);
  });
});

// --- change_kind/target_account_id pairing CHECK (brief §Schema) — proven at the DB level here; ---
// --- the domain <-> DB agreement property is in ./invariants.property.test.ts ----------------------

describe('the change_kind/target_account_id pairing CHECK: create requires a null target, update requires a non-null one', () => {
  it('change_kind=create WITH a non-null target_account_id is rejected by the DB CHECK', async () => {
    await expect(
      insertChangeRequest({
        entityId,
        changeKind: 'create',
        targetAccountId: existingGlAccountId, // illegal pairing for 'create'.
        proposedCode: freshProposedCode(),
        proposedAccountType: VALID_ACCOUNT_TYPE,
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION_SQLSTATE });
  });

  it('change_kind=update WITH a null target_account_id is rejected by the DB CHECK', async () => {
    await expect(
      insertChangeRequest({
        entityId,
        changeKind: 'update',
        targetAccountId: null, // illegal pairing for 'update'.
        proposedCode: freshProposedCode(),
        proposedAccountType: VALID_ACCOUNT_TYPE,
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION_SQLSTATE });
  });
});

// --- WBS 4.1a part 3: chk_glc_requests_change_kind_target widens to also require a non-null target -
// --- for deactivate/reactivate (brief §Schema design item 3) ---------------------------------------

describe('the change_kind/target_account_id pairing CHECK, widened (WBS 4.1a part 3): deactivate/reactivate also require a non-null target_account_id', () => {
  it.each(['deactivate', 'reactivate'] as const)(
    "change_kind=%s WITH a null target_account_id is rejected by the DB CHECK",
    async (changeKind) => {
      await expect(
        insertChangeRequest({ entityId, changeKind, targetAccountId: null }),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION_SQLSTATE });
    },
  );

  it.each(['deactivate', 'reactivate'] as const)(
    "change_kind=%s WITH a non-null target_account_id is accepted (positive control)",
    async (changeKind) => {
      const result = await insertChangeRequest({ entityId, changeKind, targetAccountId: existingGlAccountId });
      const row = result.rows[0];
      if (!row) throw new Error('fixture insert returned no id');
      insertedRequestIds.push(row.id);
    },
  );
});

// --- chk_glc_requests_update_no_code (round-3 fix 4) ------------------------------------------------

describe('chk_glc_requests_update_no_code (round-3 fix 4): an update-kind request must never carry a proposed_code (code is immutable post-creation — billing.assert_gl_account_change_approved() requires new.code = old.code on update and never reads proposed_code there)', () => {
  it("change_kind='update' WITH a non-null proposed_code is rejected by the DB CHECK", async () => {
    await expect(
      insertChangeRequest({
        entityId,
        changeKind: 'update',
        targetAccountId: existingGlAccountId,
        proposedCode: freshProposedCode(), // illegal on an update request.
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION_SQLSTATE });
  });

  it("change_kind='update' WITHOUT a proposed_code (null) is unaffected by this CHECK (positive control)", async () => {
    const result = await insertChangeRequest({
      entityId,
      changeKind: 'update',
      targetAccountId: existingGlAccountId,
      proposedAccountType: VALID_ACCOUNT_TYPE, // some other proposed_* column, proposed_code stays null.
    });
    const row = result.rows[0];
    if (!row) throw new Error('positive-control update insert returned no id');
    insertedRequestIds.push(row.id);
  });

  it("change_kind='create' WITH a non-null proposed_code is unaffected by this CHECK (the rule is update-only, positive control)", async () => {
    const result = await insertChangeRequest({
      entityId,
      changeKind: 'create',
      proposedCode: freshProposedCode(),
      proposedAccountType: VALID_ACCOUNT_TYPE,
    });
    const row = result.rows[0];
    if (!row) throw new Error('positive-control create insert returned no id');
    insertedRequestIds.push(row.id);
  });

  // WBS 4.1a part 3 — chk_glc_requests_update_no_code is worded `change_kind = 'create' or
  // proposed_code is null`, so it already forbids proposed_code for ANY non-create change_kind,
  // deactivate/reactivate included, with no migration change needed for this rule specifically
  // (brief §Contract design: "deactivate/reactivate need no proposed_* column at all").
  it.each(['deactivate', 'reactivate'] as const)(
    "change_kind=%s WITH a non-null proposed_code is rejected by the DB CHECK (same rule as update)",
    async (changeKind) => {
      await expect(
        insertChangeRequest({
          entityId,
          changeKind,
          targetAccountId: existingGlAccountId,
          proposedCode: freshProposedCode(), // illegal on a deactivate/reactivate request.
        }),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION_SQLSTATE });
    },
  );
});

// --- status CHECK closed list widens to (create, update, deactivate, reactivate) — WBS 4.1a part 3 -

describe('change_kind is widened to (create, update, deactivate, reactivate) — WBS 4.1a part 3', () => {
  it("change_kind='delete' (not a legal value, never has been) is rejected by the DB CHECK", async () => {
    await expect(
      pool.query(
        `insert into billing.gl_account_change_requests
           (entity_id, doc_no, change_kind, target_account_id, status, requested_by)
         values ($1, $2, 'delete', $3, 'draft', $4)`,
        [entityId, freshDocNo(), existingGlAccountId, ACCOUNTANT_UUID],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION_SQLSTATE });
  });

  it.each(['deactivate', 'reactivate'] as const)(
    "change_kind=%s is now a legal value (WBS 4.1a part 3) — accepted by the change_kind CHECK",
    async (changeKind) => {
      const result = await insertChangeRequest({ entityId, changeKind, targetAccountId: existingGlAccountId });
      const row = result.rows[0];
      if (!row) throw new Error('fixture insert returned no id');
      insertedRequestIds.push(row.id);
    },
  );
});

// --- WBS 4.1a part 3: billing.gl_accounts.is_active + the active-children rule -----------------------
// (docs/notes/slice-briefs/_slice-4.1a-part3.brief.md §Schema design item 4 — the new unconditional
// check inside billing.assert_gl_account_change_approved(), running BEFORE the
// `current_user <> 'pgeos_app'` bypass, since it is a data-integrity invariant, not a maker/checker
// four-eyes rule) ------------------------------------------------------------------------------------

describe('Scenario: Deactivating a gl_account that has an active child account is rejected by the database', () => {
  it('an UPDATE setting is_active from true to false on a parent with an active child is rejected — SQLSTATE 23514, message names the parent account id', async () => {
    const parentAccountId = await insertGlAccountWithParent(entityId, freshProposedCode(), null);
    await insertGlAccountWithParent(entityId, freshProposedCode(), parentAccountId); // active child (default is_active=true).

    let rejection: unknown;
    try {
      await pool.query(`update billing.gl_accounts set is_active = false where id = $1`, [parentAccountId]);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject({ code: CHECK_VIOLATION_SQLSTATE });
    expect((rejection as { message?: string }).message ?? '').toContain(parentAccountId);
  });

  it('the check is unconditional — even the admin pool (current_user <> \'pgeos_app\', the seed/import bypass) is rejected, since this is a data-integrity invariant, not a maker/checker rule', async () => {
    const parentAccountId = await insertGlAccountWithParent(entityId, freshProposedCode(), null);
    await insertGlAccountWithParent(entityId, freshProposedCode(), parentAccountId);

    // Fix round finding 4: assert `pool` genuinely connects as something other than pgeos_app BEFORE
    // trusting the rejection below as proof of the UNCONDITIONAL bypass path — otherwise this test is
    // indistinguishable from the first test above (same statement, same superuser pool).
    const currentUserResult: QueryResult<{ current_user: string }> = await pool.query(`select current_user`);
    expect(currentUserResult.rows[0]?.['current_user']).not.toBe('pgeos_app');

    await expect(
      pool.query(`update billing.gl_accounts set is_active = false where id = $1`, [parentAccountId]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION_SQLSTATE });
  });

  it('deactivating a parent whose child is ALREADY inactive succeeds on the raw admin pool (positive control — only an ACTIVE child blocks it)', async () => {
    const parentAccountId = await insertGlAccountWithParent(entityId, freshProposedCode(), null);
    const childAccountId = await insertGlAccountWithParent(entityId, freshProposedCode(), parentAccountId);
    await setGlAccountActive(childAccountId, false);

    await pool.query(`update billing.gl_accounts set is_active = false where id = $1`, [parentAccountId]);
    expect(await getGlAccountIsActive(parentAccountId)).toBe(false);
  });
});

// Round-1 fix round findings 1-3: the write-through-approval path (real pgeos_app CFO session), both
// the success cases and the rejection cases the trigger's own change_kind-keyed disjuncts and
// old.is_active backstop are meant to enforce. Finding 2: a single shared CFO fixture actor, created
// ONCE in this describe's own beforeAll — no test below silently depends on a PRECEDING sibling
// test's fixture setup, and every test here still passes if run alone or reordered.
describe('WBS 4.1a part 3 — deactivate/reactivate write-through-approval path (shared CFO fixture actor)', () => {
  beforeAll(async () => {
    await createAppFixtureActor(APP_CFO_ACTOR_P3_UUID, entityId, ROLE_CFO);
    await createAppFixtureActor(APP_CFO_ACTOR_P3_OTHER_UUID, entityId, ROLE_CFO);
  });

  describe('Scenario: Deactivating a gl_account whose children are already inactive (or absent) succeeds (write-through-approval path)', () => {
    it('a real CFO session: approve a deactivate request, THEN set is_active=false — succeeds when the target has NO children at all', async () => {
      const targetAccountId = await insertGlAccountWithParent(entityId, freshProposedCode(), null);

      const submitted = await insertChangeRequest({
        entityId,
        changeKind: 'deactivate',
        targetAccountId,
        status: 'pending_approval',
        requestedBy: ACCOUNTANT_UUID,
      });
      const requestId = submitted.rows[0]?.id;
      if (!requestId) throw new Error('fixture insert returned no id');
      insertedRequestIds.push(requestId);

      await withContext(ctxFor(APP_CFO_ACTOR_P3_UUID), async (tx: NodePgDatabase) => {
        await tx.execute(
          sql`update billing.gl_account_change_requests
                 set status = 'approved', approved_by = ${APP_CFO_ACTOR_P3_UUID}, approved_at = now(), decided_at = now()
               where id = ${requestId}`,
        );
        return tx.execute(sql`update billing.gl_accounts set is_active = false where id = ${targetAccountId}`);
      });

      expect(await getGlAccountIsActive(targetAccountId)).toBe(false);
      expect(await getRequestStatus(requestId)).toBe('approved');
    });

    // Finding 3: a GENUINE "children already inactive" case — a real child row, deactivated first,
    // THEN the parent's own deactivate request is approved and written through the SAME pgeos_app
    // write path (not the raw admin/superuser pool the earlier describe block's own positive control
    // used).
    it('a real CFO session: approve a deactivate request, THEN set is_active=false — succeeds when the target HAS a child, but that child is already inactive', async () => {
      const parentAccountId = await insertGlAccountWithParent(entityId, freshProposedCode(), null);
      const childAccountId = await insertGlAccountWithParent(entityId, freshProposedCode(), parentAccountId);
      await setGlAccountActive(childAccountId, false);

      const submitted = await insertChangeRequest({
        entityId,
        changeKind: 'deactivate',
        targetAccountId: parentAccountId,
        status: 'pending_approval',
        requestedBy: ACCOUNTANT_UUID,
      });
      const requestId = submitted.rows[0]?.id;
      if (!requestId) throw new Error('fixture insert returned no id');
      insertedRequestIds.push(requestId);

      await withContext(ctxFor(APP_CFO_ACTOR_P3_UUID), async (tx: NodePgDatabase) => {
        await tx.execute(
          sql`update billing.gl_account_change_requests
                 set status = 'approved', approved_by = ${APP_CFO_ACTOR_P3_UUID}, approved_at = now(), decided_at = now()
               where id = ${requestId}`,
        );
        return tx.execute(sql`update billing.gl_accounts set is_active = false where id = ${parentAccountId}`);
      });

      expect(await getGlAccountIsActive(parentAccountId)).toBe(false);
      expect(await getRequestStatus(requestId)).toBe('approved');
    });
  });

  describe('Scenario: A reactivate request follows the same maker/checker path', () => {
    it('a real CFO session: approve a reactivate request, THEN set is_active=true — succeeds', async () => {
      const targetAccountId = await insertGlAccountWithParent(entityId, freshProposedCode(), null);
      await setGlAccountActive(targetAccountId, false); // start inactive.

      const submitted = await insertChangeRequest({
        entityId,
        changeKind: 'reactivate',
        targetAccountId,
        status: 'pending_approval',
        requestedBy: ACCOUNTANT_UUID,
      });
      const requestId = submitted.rows[0]?.id;
      if (!requestId) throw new Error('fixture insert returned no id');
      insertedRequestIds.push(requestId);

      await withContext(ctxFor(APP_CFO_ACTOR_P3_UUID), async (tx: NodePgDatabase) => {
        await tx.execute(
          sql`update billing.gl_account_change_requests
                 set status = 'approved', approved_by = ${APP_CFO_ACTOR_P3_UUID}, approved_at = now(), decided_at = now()
               where id = ${requestId}`,
        );
        return tx.execute(sql`update billing.gl_accounts set is_active = true where id = ${targetAccountId}`);
      });

      expect(await getGlAccountIsActive(targetAccountId)).toBe(true);
      expect(await getRequestStatus(requestId)).toBe('approved');
    });
  });

  // Finding 1: the trigger's change_kind-keyed disjuncts and old.is_active backstop proven as
  // REJECTIONS, as pgeos_app, with a real approved-request setup — mirroring the isolation style of
  // the success scenarios directly above (same shared CFO fixture actor, same withContext/
  // insertChangeRequest/insertGlAccountWithParent helpers). findRaisedException/
  // RLS_POLICY_VIOLATION_SQLSTATE are declared further down this file (hoisted function / evaluated
  // by module-load time before any test body runs — same forward-reference already used by
  // APP_CFO_ACTOR_P3_UUID above).
  describe('Scenario: an approved deactivate/reactivate/update request cannot be misused to write something the CFO did not actually approve — the DB rejects with 42501', () => {
    it('an approved UPDATE request cannot be used to ALSO flip is_active (the update disjunct requires is_active unchanged)', async () => {
      const targetAccountId = await insertGlAccountWithParent(entityId, freshProposedCode(), null);

      const submitted = await insertChangeRequest({
        entityId,
        changeKind: 'update',
        targetAccountId,
        proposedAccountType: VALID_ACCOUNT_TYPE,
        status: 'pending_approval',
        requestedBy: ACCOUNTANT_UUID,
      });
      const requestId = submitted.rows[0]?.id;
      if (!requestId) throw new Error('fixture insert returned no id');
      insertedRequestIds.push(requestId);

      let rejection: unknown;
      try {
        await withContext(ctxFor(APP_CFO_ACTOR_P3_UUID), async (tx: NodePgDatabase) => {
          await tx.execute(
            sql`update billing.gl_account_change_requests
                   set status = 'approved', approved_by = ${APP_CFO_ACTOR_P3_UUID}, approved_at = now(), decided_at = now()
                 where id = ${requestId}`,
          );
          // The request's own proposed_account_type matches — every OTHER column the 'update'
          // disjunct checks would pass — but is_active is not something an 'update' request may ever
          // touch, so this must still be rejected.
          return tx.execute(
            sql`update billing.gl_accounts set account_type = ${VALID_ACCOUNT_TYPE}, is_active = false where id = ${targetAccountId}`,
          );
        });
      } catch (error) {
        rejection = error;
      }
      expect(findRaisedException(rejection, RLS_POLICY_VIOLATION_SQLSTATE)).toBeDefined();
      expect(await getGlAccountIsActive(targetAccountId)).toBe(true); // rolled back — untouched.
    });

    it('an approved DEACTIVATE request cannot be used to ALSO change content (name_ar) alongside the is_active flip (the deactivate disjunct requires the other 5 mutable columns unchanged)', async () => {
      const targetAccountId = await insertGlAccountWithParent(entityId, freshProposedCode(), null);

      const submitted = await insertChangeRequest({
        entityId,
        changeKind: 'deactivate',
        targetAccountId,
        status: 'pending_approval',
        requestedBy: ACCOUNTANT_UUID,
      });
      const requestId = submitted.rows[0]?.id;
      if (!requestId) throw new Error('fixture insert returned no id');
      insertedRequestIds.push(requestId);

      let rejection: unknown;
      try {
        await withContext(ctxFor(APP_CFO_ACTOR_P3_UUID), async (tx: NodePgDatabase) => {
          await tx.execute(
            sql`update billing.gl_account_change_requests
                   set status = 'approved', approved_by = ${APP_CFO_ACTOR_P3_UUID}, approved_at = now(), decided_at = now()
                 where id = ${requestId}`,
          );
          return tx.execute(
            sql`update billing.gl_accounts set is_active = false, name_ar = ${'اسم مختلف — لا يوافق عليه الطلب'} where id = ${targetAccountId}`,
          );
        });
      } catch (error) {
        rejection = error;
      }
      expect(findRaisedException(rejection, RLS_POLICY_VIOLATION_SQLSTATE)).toBeDefined();
      expect(await getGlAccountIsActive(targetAccountId)).toBe(true); // rolled back — untouched.
    });

    it('an approved DEACTIVATE request on an account that is ALREADY inactive is rejected — the trigger keys on old.is_active, not just the approved change_kind', async () => {
      const targetAccountId = await insertGlAccountWithParent(entityId, freshProposedCode(), null);
      await setGlAccountActive(targetAccountId, false); // already inactive BEFORE the request is even approved.

      const submitted = await insertChangeRequest({
        entityId,
        changeKind: 'deactivate',
        targetAccountId,
        status: 'pending_approval',
        requestedBy: ACCOUNTANT_UUID,
      });
      const requestId = submitted.rows[0]?.id;
      if (!requestId) throw new Error('fixture insert returned no id');
      insertedRequestIds.push(requestId);

      let rejection: unknown;
      try {
        await withContext(ctxFor(APP_CFO_ACTOR_P3_UUID), async (tx: NodePgDatabase) => {
          await tx.execute(
            sql`update billing.gl_account_change_requests
                   set status = 'approved', approved_by = ${APP_CFO_ACTOR_P3_UUID}, approved_at = now(), decided_at = now()
                 where id = ${requestId}`,
          );
          return tx.execute(sql`update billing.gl_accounts set is_active = false where id = ${targetAccountId}`);
        });
      } catch (error) {
        rejection = error;
      }
      expect(findRaisedException(rejection, RLS_POLICY_VIOLATION_SQLSTATE)).toBeDefined();
      expect(await getGlAccountIsActive(targetAccountId)).toBe(false); // unchanged (was already false).
    });

    it('an approved REACTIVATE request on an account that is ALREADY active is rejected — same old.is_active backstop, the other direction', async () => {
      const targetAccountId = await insertGlAccountWithParent(entityId, freshProposedCode(), null); // active by default.

      const submitted = await insertChangeRequest({
        entityId,
        changeKind: 'reactivate',
        targetAccountId,
        status: 'pending_approval',
        requestedBy: ACCOUNTANT_UUID,
      });
      const requestId = submitted.rows[0]?.id;
      if (!requestId) throw new Error('fixture insert returned no id');
      insertedRequestIds.push(requestId);

      let rejection: unknown;
      try {
        await withContext(ctxFor(APP_CFO_ACTOR_P3_UUID), async (tx: NodePgDatabase) => {
          await tx.execute(
            sql`update billing.gl_account_change_requests
                   set status = 'approved', approved_by = ${APP_CFO_ACTOR_P3_UUID}, approved_at = now(), decided_at = now()
                 where id = ${requestId}`,
          );
          return tx.execute(sql`update billing.gl_accounts set is_active = true where id = ${targetAccountId}`);
        });
      } catch (error) {
        rejection = error;
      }
      expect(findRaisedException(rejection, RLS_POLICY_VIOLATION_SQLSTATE)).toBeDefined();
      expect(await getGlAccountIsActive(targetAccountId)).toBe(true); // unchanged (was already true).
    });

    it('a deactivate write attempted with NO approval at all (request still pending_approval) is rejected', async () => {
      const targetAccountId = await insertGlAccountWithParent(entityId, freshProposedCode(), null);

      const submitted = await insertChangeRequest({
        entityId,
        changeKind: 'deactivate',
        targetAccountId,
        status: 'pending_approval', // never approved.
        requestedBy: ACCOUNTANT_UUID,
      });
      const requestId = submitted.rows[0]?.id;
      if (!requestId) throw new Error('fixture insert returned no id');
      insertedRequestIds.push(requestId);

      let rejection: unknown;
      try {
        await withContext(ctxFor(APP_CFO_ACTOR_P3_UUID), async (tx: NodePgDatabase) => {
          return tx.execute(sql`update billing.gl_accounts set is_active = false where id = ${targetAccountId}`);
        });
      } catch (error) {
        rejection = error;
      }
      expect(findRaisedException(rejection, RLS_POLICY_VIOLATION_SQLSTATE)).toBeDefined();
      expect(await getGlAccountIsActive(targetAccountId)).toBe(true); // unchanged.
    });

    it('a deactivate write attempted using an approval DECIDED IN AN EARLIER TRANSACTION (replay) is rejected — decided_at = now() no longer matches THIS transaction', async () => {
      const targetAccountId = await insertGlAccountWithParent(entityId, freshProposedCode(), null);

      const submitted = await insertChangeRequest({
        entityId,
        changeKind: 'deactivate',
        targetAccountId,
        status: 'pending_approval',
        requestedBy: ACCOUNTANT_UUID,
      });
      const requestId = submitted.rows[0]?.id;
      if (!requestId) throw new Error('fixture insert returned no id');
      insertedRequestIds.push(requestId);

      // Approve in its OWN, separate transaction — decided_at is fixed to THAT transaction's now().
      await withContext(ctxFor(APP_CFO_ACTOR_P3_UUID), async (tx: NodePgDatabase) => {
        return tx.execute(
          sql`update billing.gl_account_change_requests
                 set status = 'approved', approved_by = ${APP_CFO_ACTOR_P3_UUID}, approved_at = now(), decided_at = now()
               where id = ${requestId}`,
        );
      });
      expect(await getRequestStatus(requestId)).toBe('approved');

      // Replay attempt — a LATER, separate transaction; now() has moved on, decided_at no longer matches.
      let rejection: unknown;
      try {
        await withContext(ctxFor(APP_CFO_ACTOR_P3_UUID), async (tx: NodePgDatabase) => {
          return tx.execute(sql`update billing.gl_accounts set is_active = false where id = ${targetAccountId}`);
        });
      } catch (error) {
        rejection = error;
      }
      expect(findRaisedException(rejection, RLS_POLICY_VIOLATION_SQLSTATE)).toBeDefined();
      expect(await getGlAccountIsActive(targetAccountId)).toBe(true); // unchanged.
    });

    it('a deactivate write attempted by a DIFFERENT user than the one the request was approved_by is rejected', async () => {
      const targetAccountId = await insertGlAccountWithParent(entityId, freshProposedCode(), null);

      const submitted = await insertChangeRequest({
        entityId,
        changeKind: 'deactivate',
        targetAccountId,
        status: 'pending_approval',
        requestedBy: ACCOUNTANT_UUID,
      });
      const requestId = submitted.rows[0]?.id;
      if (!requestId) throw new Error('fixture insert returned no id');
      insertedRequestIds.push(requestId);

      // Approved by APP_CFO_ACTOR_P3_UUID, its own valid session.
      await withContext(ctxFor(APP_CFO_ACTOR_P3_UUID), async (tx: NodePgDatabase) => {
        return tx.execute(
          sql`update billing.gl_account_change_requests
                 set status = 'approved', approved_by = ${APP_CFO_ACTOR_P3_UUID}, approved_at = now(), decided_at = now()
               where id = ${requestId}`,
        );
      });
      expect(await getRequestStatus(requestId)).toBe('approved');

      // The write is attempted by a DIFFERENT CFO actor (APP_CFO_ACTOR_P3_OTHER_UUID) — RLS on
      // gl_accounts permits it (also holds the CFO approver role), but the trigger's own
      // r.approved_by = platform.current_user_id() match fails, since current_user_id() here is
      // APP_CFO_ACTOR_P3_OTHER_UUID, not the actor the request was actually approved_by.
      let rejection: unknown;
      try {
        await withContext(ctxFor(APP_CFO_ACTOR_P3_OTHER_UUID), async (tx: NodePgDatabase) => {
          return tx.execute(sql`update billing.gl_accounts set is_active = false where id = ${targetAccountId}`);
        });
      } catch (error) {
        rejection = error;
      }
      expect(findRaisedException(rejection, RLS_POLICY_VIOLATION_SQLSTATE)).toBeDefined();
      expect(await getGlAccountIsActive(targetAccountId)).toBe(true); // unchanged.
    });
  });

  // Round-1 fix round finding 1 (pg-reviewer, opus): the active-children CHECK
  // (billing.assert_gl_account_change_approved(), lines 778-782 above) runs UNCONDITIONALLY, even
  // for an approved request under a real pgeos_app session — the two scenarios further above
  // (lines 784-822) only proved this on the raw admin/superuser pool (current_user = 'postgres'),
  // never through withContext as a real CFO session. Since the trigger is NOT security definer, the
  // child lookup inside it runs under the CALLER's own RLS — a pgeos_app session is exactly the path
  // where a child invisible to that session's RLS could silently let a deactivation through. This is
  // the only test in the file that exercises that path.
  describe('Scenario: an approved deactivate request cannot bypass the active-children CHECK even under a real pgeos_app CFO session', () => {
    it('a real CFO session: approve a deactivate request for a parent with a REAL active child — the write is still rejected (23514), nothing is committed', async () => {
      const parentAccountId = await insertGlAccountWithParent(entityId, freshProposedCode(), null);
      await insertGlAccountWithParent(entityId, freshProposedCode(), parentAccountId); // active child (default is_active=true).

      const submitted = await insertChangeRequest({
        entityId,
        changeKind: 'deactivate',
        targetAccountId: parentAccountId,
        status: 'pending_approval',
        requestedBy: ACCOUNTANT_UUID,
      });
      const requestId = submitted.rows[0]?.id;
      if (!requestId) throw new Error('fixture insert returned no id');
      insertedRequestIds.push(requestId);

      let rejection: unknown;
      try {
        await withContext(ctxFor(APP_CFO_ACTOR_P3_UUID), async (tx: NodePgDatabase) => {
          await tx.execute(
            sql`update billing.gl_account_change_requests
                   set status = 'approved', approved_by = ${APP_CFO_ACTOR_P3_UUID}, approved_at = now(), decided_at = now()
                 where id = ${requestId}`,
          );
          return tx.execute(sql`update billing.gl_accounts set is_active = false where id = ${parentAccountId}`);
        });
      } catch (error) {
        rejection = error;
      }
      expect(findRaisedException(rejection, CHECK_VIOLATION_SQLSTATE)).toBeDefined();
      // rolled back — the whole transaction, including the request approval above, never committed.
      expect(await getGlAccountIsActive(parentAccountId)).toBe(true);
      expect(await getRequestStatus(requestId)).toBe('pending_approval');
    });
  });
});

// --- Fix round finding 10: the maker-side RLS policy, exercised as `pgeos_app` through withContext --
// (not the admin/bypass pool) — precedent: ../dimensions/dimensions.test.ts's own RLS scenario
// (createFixtureActor/grantRole/ctxFor/withContext). Brief §"Permission model — maker side":
// `billing.gl_accounts.manage` -> ACCOUNTANT only; the maker's own policy checks
// `platform.has_perm('billing.gl_accounts.manage')`, own-row (`requested_by = current_user_id()`),
// and LOCKS status to draft/pending_approval/cancelled with approved_by/approved_at/decided_at all
// null (a maker can never self-approve by editing their own row). RLS_POLICY_VIOLATION = 42501
// (insufficient_privilege — a WITH CHECK policy rejects the write outright), same SQLSTATE as
// ../dimensions/dimensions.test.ts's own RLS scenario.

const RLS_POLICY_VIOLATION_SQLSTATE = '42501';

/** Walks `error`'s own cause chain for a Postgres error with the given SQLSTATE — drizzle wraps the
 *  underlying pg driver error in its own `DrizzleQueryError`, so the real SQLSTATE lives on
 *  `.cause`, never on the outer wrapper's own `.code` — same technique as
 *  ../dimensions/dimensions.test.ts's own findRaisedException and
 *  ../../infrastructure/record-billable-event/repository.ts's own findRaisedException. */
function findRaisedException(error: unknown, sqlstate: string): Error | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = 'code' in current ? current.code : undefined;
    if (code === sqlstate) {
      return current;
    }
    current = current.cause;
  }

  return undefined;
}

// Distinct from every UUID literal already used above in this file (ACCOUNTANT_UUID/CFO_UUID/
// OTHER_ACCOUNTANT_UUID are admin-pool-only fixtures with no identity.users row) — these actors are
// REAL identity.users rows this section creates and grants roles to, then drives entirely through
// withContext (pgeos_app), never the admin pool, for the write itself.
const APP_ACCOUNTANT_ACTOR_UUID = '00000000-0000-4000-8000-0000004a2a10';
const APP_ACCOUNTANT_OTHER_ENTITY_ACTOR_UUID = '00000000-0000-4000-8000-0000004a2a11';
const APP_NO_PERMISSION_ACTOR_UUID = '00000000-0000-4000-8000-0000004a2a12';
const APP_CFO_ACTOR_UUID = '00000000-0000-4000-8000-0000004a2a13'; // finding 8: a real CFO session for the headline "CFO approves" scenario.
const APP_CFO_ACTOR_P3_UUID = '00000000-0000-4000-8000-0000004a2a20'; // WBS 4.1a part 3 — a dedicated real CFO session for the new deactivate/reactivate scenarios below, distinct from APP_CFO_ACTOR_UUID.
const APP_CFO_ACTOR_P3_OTHER_UUID = '00000000-0000-4000-8000-0000004a2a21'; // Fix round finding 1(d) — a SECOND, distinct CFO actor, used only by the "approved by a different user" rejection test.
const ROLE_ACCOUNTANT = 'ACCOUNTANT';
const ROLE_SALES_REP = 'SALES_REP'; // any role NOT granted billing.gl_accounts.manage (13B:555).
const ROLE_CFO = 'CFO';

const appFixtureActorIds: string[] = [];

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

async function createAppFixtureActor(userId: string, forEntityId: string, roleCode: string): Promise<void> {
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [userId, `_glc_fixture_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار موافقات الحسابات — WBS 4.1a part 2'],
  );
  await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, forEntityId]);
  await grantRole(userId, roleCode);
  appFixtureActorIds.push(userId);
}

describe('Fix round finding 10 — the maker-side RLS policy on gl_account_change_requests, exercised as pgeos_app (not the admin pool)', () => {
  it('an ACCOUNTANT inserts their own draft and submits it to pending_approval through withContext', async () => {
    await createAppFixtureActor(APP_ACCOUNTANT_ACTOR_UUID, entityId, ROLE_ACCOUNTANT);

    const proposedCode = freshProposedCode();
    const insertResult = await withContext(ctxFor(APP_ACCOUNTANT_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute<{ id: string }>(
        sql`insert into billing.gl_account_change_requests
              (entity_id, doc_no, change_kind, proposed_code, proposed_name_ar, proposed_account_type, requested_by)
            values (${entityId}, ${freshDocNo()}, 'create', ${proposedCode}, ${NAME_AR}, ${VALID_ACCOUNT_TYPE}, ${APP_ACCOUNTANT_ACTOR_UUID})
            returning id`,
      );
    });
    const requestId = insertResult.rows[0]?.id;
    if (!requestId) throw new Error('withContext insert returned no id');
    insertedRequestIds.push(requestId);
    expect(await getRequestStatus(requestId)).toBe('draft');

    await withContext(ctxFor(APP_ACCOUNTANT_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute(
        sql`update billing.gl_account_change_requests set status = 'pending_approval', submitted_at = now() where id = ${requestId}`,
      );
    });
    expect(await getRequestStatus(requestId)).toBe('pending_approval');
  });

  it('an ACCOUNTANT CANNOT set status=approved / approved_by / approved_at / decided_at on their own row (maker locked-columns policy)', async () => {
    const proposedCode = freshProposedCode();
    const insertResult = await withContext(ctxFor(APP_ACCOUNTANT_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute<{ id: string }>(
        sql`insert into billing.gl_account_change_requests
              (entity_id, doc_no, change_kind, proposed_code, proposed_name_ar, proposed_account_type, requested_by, status)
            values (${entityId}, ${freshDocNo()}, 'create', ${proposedCode}, ${NAME_AR}, ${VALID_ACCOUNT_TYPE}, ${APP_ACCOUNTANT_ACTOR_UUID}, 'pending_approval')
            returning id`,
      );
    });
    const requestId = insertResult.rows[0]?.id;
    if (!requestId) throw new Error('withContext insert returned no id');
    insertedRequestIds.push(requestId);

    let lockedColumnRejection: unknown;
    try {
      await withContext(ctxFor(APP_ACCOUNTANT_ACTOR_UUID), async (tx: NodePgDatabase) => {
        return tx.execute(
          sql`update billing.gl_account_change_requests
                 set status = 'approved', approved_by = ${APP_ACCOUNTANT_ACTOR_UUID}, approved_at = now(), decided_at = now()
               where id = ${requestId}`,
        );
      });
    } catch (error) {
      lockedColumnRejection = error;
    }
    expect(lockedColumnRejection).toBeInstanceOf(Error);
    expect(findRaisedException(lockedColumnRejection, RLS_POLICY_VIOLATION_SQLSTATE)).toBeDefined();

    // the row is untouched — the WITH CHECK failure rolled the whole statement back.
    expect(await getRequestStatus(requestId)).toBe('pending_approval');
  });

  it('a caller WITHOUT billing.gl_accounts.manage cannot INSERT at all', async () => {
    await createAppFixtureActor(APP_NO_PERMISSION_ACTOR_UUID, entityId, ROLE_SALES_REP);

    let noPermissionRejection: unknown;
    try {
      await withContext(ctxFor(APP_NO_PERMISSION_ACTOR_UUID), async (tx: NodePgDatabase) => {
        return tx.execute(
          sql`insert into billing.gl_account_change_requests
                (entity_id, doc_no, change_kind, proposed_code, proposed_name_ar, proposed_account_type, requested_by)
              values (${entityId}, ${freshDocNo()}, 'create', ${freshProposedCode()}, ${NAME_AR}, ${VALID_ACCOUNT_TYPE}, ${APP_NO_PERMISSION_ACTOR_UUID})`,
        );
      });
    } catch (error) {
      noPermissionRejection = error;
    }
    expect(noPermissionRejection).toBeInstanceOf(Error);
    expect(findRaisedException(noPermissionRejection, RLS_POLICY_VIOLATION_SQLSTATE)).toBeDefined();
  });

  it("another entity's rows are invisible to an ACCOUNTANT scoped to a different entity (entity_scope)", async () => {
    await createAppFixtureActor(APP_ACCOUNTANT_OTHER_ENTITY_ACTOR_UUID, otherEntityId, ROLE_ACCOUNTANT);

    const proposedCode = freshProposedCode();
    const insertResult = await withContext(ctxFor(APP_ACCOUNTANT_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute<{ id: string }>(
        sql`insert into billing.gl_account_change_requests
              (entity_id, doc_no, change_kind, proposed_code, proposed_name_ar, proposed_account_type, requested_by)
            values (${entityId}, ${freshDocNo()}, 'create', ${proposedCode}, ${NAME_AR}, ${VALID_ACCOUNT_TYPE}, ${APP_ACCOUNTANT_ACTOR_UUID})
            returning id`,
      );
    });
    const requestId = insertResult.rows[0]?.id;
    if (!requestId) throw new Error('withContext insert returned no id');
    insertedRequestIds.push(requestId);

    const outsiderVisible = await withContext(ctxFor(APP_ACCOUNTANT_OTHER_ENTITY_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute<{ id: string }>(sql`select id from billing.gl_account_change_requests where id = ${requestId}`);
    });
    expect(outsiderVisible.rows).toHaveLength(0);
  });
});
