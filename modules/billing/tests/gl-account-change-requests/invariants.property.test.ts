// modules/billing/tests/gl-account-change-requests/invariants.property.test.ts — WBS 4.1a part 2.
//
// Property tests (fast-check): for every generated (change_kind, target_account_id-or-null,
// proposed_code, proposed_account_type) tuple, the domain-level pre-check and the DB CHECK/
// composite-FK agree (accept <=> accept) — same discipline as 4.1a part 1's own code/CHECK
// agreement test (../chart-of-accounts/invariants.property.test.ts) and 4.1b's own kind/source_table
// agreement test.
//
// DOMAIN SURFACE ASSUMED (report to the Master/build brief):
//   1. proposed_code / proposed_account_type reuse chart-of-accounts's OWN functions verbatim — the
//      Master's ruling is "ONE function... not a copy" for the SQL side
//      (billing.is_valid_gl_account_code / billing.is_valid_gl_account_type, called from BOTH
//      tables' CHECKs); this test assumes the domain side mirrors that discipline by REUSING
//      modules/billing/domain/chart-of-accounts/invariants.ts's existing
//      `isValidAccountCode(code: string): boolean` and `ALLOWED_ACCOUNT_TYPES`/
//      `assertValidAccountType(accountType: string): void` — NOT a duplicate in
//      domain/gl-account-change-requests/. If pg-backend instead adds new equivalents in
//      domain/gl-account-change-requests/invariants.ts, this file's two imports from
//      ../../domain/chart-of-accounts/invariants.js must be redirected there (a mechanical rename,
//      not a re-think of the assertion).
//   2. `isValidChangeKindTargetPairing(changeKind: 'create' | 'update', targetAccountId: string |
//      null): boolean` — NEW, in modules/billing/domain/gl-account-change-requests/invariants.ts.
//      True iff (changeKind === 'create' && targetAccountId === null) ||
//      (changeKind === 'update' && targetAccountId !== null) — the brief's own three-valued-logic
//      pairing CHECK, mirrored in the domain so the application layer rejects a malformed Submit
//      BEFORE any DB round-trip.
//
// The DB side of every property below is proven by an ACTUAL insert attempt through the admin pool
// (never by reading the constraint definition) — same technique as
// ../chart-of-accounts/invariants.property.test.ts's own dbAcceptsCode.

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isValidAccountCode, assertValidAccountType } from '../../domain/chart-of-accounts/invariants.js';
import { InvalidAccountTypeError } from '../../domain/chart-of-accounts/errors.js';
import {
  isValidChangeKindTargetPairing,
  isValidDeactivateReactivateDirection,
  isDeactivationAllowed,
} from '../../domain/gl-account-change-requests/invariants.js';

// WBS 4.1a part 3 (docs/notes/slice-briefs/_slice-4.1a-part3.brief.md): isValidChangeKindTargetPairing
// widens its changeKind parameter type from 'create' | 'update' to also accept 'deactivate' |
// 'reactivate' (body unchanged — its else branch already requires a non-null target for anything
// that isn't 'create'). This file's own dbAcceptsPairing helper below is widened to match, and a NEW
// property block covers the NEW pure function isValidDeactivateReactivateDirection(changeKind,
// currentIsActive: boolean): boolean — 'deactivate' requires currentIsActive===true, 'reactivate'
// requires currentIsActive===false, any other changeKind is unconstrained (always true).

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

const NAME_AR = 'طلب تعديل حساب اختبار الخاصية — WBS 4.1a part 2';
const VALID_ACCOUNT_TYPE = 'expense';
// A code family this file's own literals do not reuse (chart-of-accounts' own tests already
// occupy classes 1-5) — class 7, distinct from ../chart-of-accounts/*.test.ts's own literals.
const VALID_TARGET_CODE = '7-01-001-999';

let entityId: string;
let targetAccountId: string;
const insertedRequestIds: string[] = [];
const insertedAccountIds: string[] = [];

function randomDocNo(): string {
  return `GLC-PROP-${Math.random().toString(36).slice(2, 10)}`;
}

async function insertChangeRequest(input: {
  changeKind: 'create' | 'update' | 'deactivate' | 'reactivate';
  targetAccountId: string | null;
  proposedCode: string | null;
  proposedAccountType: string;
}): Promise<QueryResult<{ id: string }>> {
  return pool.query(
    `insert into billing.gl_account_change_requests
       (entity_id, doc_no, change_kind, target_account_id, proposed_code, proposed_name_ar,
        proposed_account_type, status, requested_by)
     values ($1, $2, $3, $4, $5, $6, $7, 'draft', $8)
     returning id`,
    [
      entityId,
      randomDocNo(),
      input.changeKind,
      input.targetAccountId,
      input.proposedCode,
      NAME_AR,
      input.proposedAccountType,
      '00000000-0000-4000-8000-000000041a01',
    ],
  );
}

/** True iff the DB accepts a change-request row carrying this proposed_code (account_type and
 *  pairing held constant at a KNOWN-VALID value, so only the code-format CHECK is exercised). A
 *  23505 (unique_violation, a doc_no/code collision across fast-check runs) is treated as "the CHECK
 *  itself did not reject it", same convention as ../chart-of-accounts/invariants.property.test.ts. */
async function dbAcceptsProposedCode(code: string): Promise<boolean> {
  try {
    const result = await insertChangeRequest({
      changeKind: 'create',
      targetAccountId: null,
      proposedCode: code,
      proposedAccountType: VALID_ACCOUNT_TYPE,
    });
    const id = result.rows[0]?.id;
    if (id) insertedRequestIds.push(id);
    return true;
  } catch (error) {
    const pgError = error as { code?: string };
    if (pgError.code === '23514') return false;
    if (pgError.code === '23505') return true;
    throw error;
  }
}

/** Same idea for proposed_account_type — proposed_code held constant at a KNOWN-VALID, per-call
 *  UNIQUE code (the create/pending-approval partial unique index is on proposed_code, so each call
 *  needs its own). */
async function dbAcceptsProposedAccountType(accountType: string, uniqueSuffix: number): Promise<boolean> {
  try {
    const result = await insertChangeRequest({
      changeKind: 'create',
      targetAccountId: null,
      proposedCode: `8-01-001-${String(uniqueSuffix % 1000).padStart(3, '0')}`,
      proposedAccountType: accountType,
    });
    const id = result.rows[0]?.id;
    if (id) insertedRequestIds.push(id);
    return true;
  } catch (error) {
    const pgError = error as { code?: string };
    if (pgError.code === '23514') return false;
    if (pgError.code === '23505') return true;
    throw error;
  }
}

/** change_kind/target_account_id pairing — proposed_code/proposed_account_type held constant at
 *  KNOWN-VALID values (a fresh unique code per call for 'create'; 'update' never carries a
 *  proposed_code — chk_glc_requests_update_no_code (round-3 fix 4) forbids it, code is immutable
 *  post-creation), targetAccountId is either `targetAccountId` (an existing, real
 *  billing.gl_accounts row) or null — never a dangling uuid, so a rejection can only come from the
 *  pairing CHECK, never the target_account_id FK or the update-no-code CHECK. */
async function dbAcceptsPairing(
  changeKind: 'create' | 'update' | 'deactivate' | 'reactivate',
  useRealTarget: boolean,
  uniqueSuffix: number,
): Promise<boolean> {
  try {
    const result = await insertChangeRequest({
      changeKind,
      targetAccountId: useRealTarget ? targetAccountId : null,
      proposedCode: changeKind === 'create' ? `9-01-001-${String(uniqueSuffix % 1000).padStart(3, '0')}` : null,
      proposedAccountType: VALID_ACCOUNT_TYPE,
    });
    const id = result.rows[0]?.id;
    if (id) insertedRequestIds.push(id);
    return true;
  } catch (error) {
    const pgError = error as { code?: string };
    if (pgError.code === '23514') return false;
    throw error;
  }
}

// Well-formed X-XX-XXX-XXX strings — the domain SHOULD accept every one of these (same arbitrary
// shape as ../chart-of-accounts/invariants.property.test.ts).
const wellFormedCodeArb = fc
  .tuple(
    fc.integer({ min: 1, max: 9 }),
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 999 }),
    fc.integer({ min: 0, max: 999 }),
  )
  .map(
    ([cls, seg2, seg3, seg4]) =>
      `${cls}-${String(seg2).padStart(2, '0')}-${String(seg3).padStart(3, '0')}-${String(seg4).padStart(3, '0')}`,
  );

const arbitraryCodeArb = fc.oneof(
  wellFormedCodeArb,
  fc.string({ maxLength: 20 }),
  fc
    .tuple(fc.integer({ min: 0, max: 20 }), fc.integer({ min: 0, max: 999 }), fc.integer({ min: 0, max: 9999 }), fc.integer({ min: 0, max: 9999 }))
    .map(([cls, seg2, seg3, seg4]) => `${cls}-${seg2}-${seg3}-${seg4}`),
);

const ACCOUNT_TYPE_CANDIDATES = [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
  'cost_of_revenue',
  'other_income_expense',
  'tax',
  'control_memorandum',
  '_not_a_real_account_type_wbs_4_1a',
  'ASSET',
  '',
  'other_income',
];

beforeAll(async () => {
  const entityResult = await pool.query<{ id: string }>(`select id from platform.entities where code = $1`, ['PST']);
  const row = entityResult.rows[0];
  if (!row) throw new Error(`platform.entities row not found for code 'PST'`);
  entityId = row.id;

  const accountResult: QueryResult<{ id: string }> = await pool.query(
    `insert into billing.gl_accounts (entity_id, code, name_ar, account_type) values ($1, $2, $3, $4) returning id`,
    [entityId, VALID_TARGET_CODE, 'حساب هدف اختبار الخاصية — WBS 4.1a part 2', VALID_ACCOUNT_TYPE],
  );
  const accountRow = accountResult.rows[0];
  if (!accountRow) throw new Error('fixture billing.gl_accounts insert (property test target) returned no row');
  targetAccountId = accountRow.id;
  insertedAccountIds.push(accountRow.id);
});

afterAll(async () => {
  if (insertedRequestIds.length > 0) {
    await pool.query(`delete from billing.gl_account_change_requests where id = any($1::uuid[])`, [insertedRequestIds]);
  }
  if (insertedAccountIds.length > 0) {
    await pool.query(`delete from billing.gl_accounts where id = any($1::uuid[])`, [insertedAccountIds]);
  }
  await pool.end();
});

describe('proposed_code: domain isValidAccountCode agrees with the DB CHECK on billing.gl_account_change_requests.proposed_code (same shared function as billing.gl_accounts.code)', () => {
  it('a well-formed X-XX-XXX-XXX code with class 1-9 is accepted by BOTH the domain check and the DB', async () => {
    await fc.assert(
      fc.asyncProperty(wellFormedCodeArb, async (code) => {
        expect(isValidAccountCode(code)).toBe(true);
        expect(await dbAcceptsProposedCode(code)).toBe(true);
      }),
      { numRuns: 20 },
    );
  });

  it('for any generated code shape, the domain check and the DB CHECK agree on accept/reject', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryCodeArb, async (code) => {
        const domainAccepts = isValidAccountCode(code);
        const dbAccepts = await dbAcceptsProposedCode(code);
        expect(dbAccepts).toBe(domainAccepts);
      }),
      { numRuns: 30 },
    );
  });
});

describe('proposed_account_type: domain assertValidAccountType agrees with the DB CHECK (same shared function as billing.gl_accounts.account_type)', () => {
  it.each(ACCOUNT_TYPE_CANDIDATES.map((type, index) => [type, index] as const))(
    'account_type %s: domain and DB agree on accept/reject',
    async (accountType, index) => {
      let domainAccepts = true;
      try {
        assertValidAccountType(accountType);
      } catch (error) {
        if (!(error instanceof InvalidAccountTypeError)) throw error;
        domainAccepts = false;
      }

      const dbAccepts = await dbAcceptsProposedAccountType(accountType, index);
      expect(dbAccepts).toBe(domainAccepts);
    },
  );
});

describe('change_kind/target_account_id pairing: domain isValidChangeKindTargetPairing agrees with the DB CHECK', () => {
  // WBS 4.1a part 3: widened from 2 to all 4 changeKind values — isValidChangeKindTargetPairing's
  // TS parameter type widens to 'create' | 'update' | 'deactivate' | 'reactivate' (body unchanged).
  const pairingCasesArb = fc.record({
    changeKind: fc.constantFrom<'create' | 'update' | 'deactivate' | 'reactivate'>(
      'create',
      'update',
      'deactivate',
      'reactivate',
    ),
    useRealTarget: fc.boolean(),
  });

  it('for every (change_kind, target_account_id-or-null) combination across all 4 change_kind values, the domain pairing check and the DB CHECK agree', async () => {
    let uniqueSuffix = 0;
    await fc.assert(
      fc.asyncProperty(pairingCasesArb, async ({ changeKind, useRealTarget }) => {
        uniqueSuffix += 1;
        const domainAccepts = isValidChangeKindTargetPairing(changeKind, useRealTarget ? targetAccountId : null);
        const dbAccepts = await dbAcceptsPairing(changeKind, useRealTarget, uniqueSuffix);
        expect(dbAccepts).toBe(domainAccepts);
      }),
      { numRuns: 30 },
    );
  });

  it('create + null target_account_id is the only accepted "create" pairing; create + a real target is rejected', () => {
    expect(isValidChangeKindTargetPairing('create', null)).toBe(true);
    expect(isValidChangeKindTargetPairing('create', targetAccountId)).toBe(false);
  });

  it('update + a real target_account_id is the only accepted "update" pairing; update + null is rejected', () => {
    expect(isValidChangeKindTargetPairing('update', targetAccountId)).toBe(true);
    expect(isValidChangeKindTargetPairing('update', null)).toBe(false);
  });

  it('deactivate/reactivate + a real target_account_id is accepted; deactivate/reactivate + null is rejected (WBS 4.1a part 3)', () => {
    expect(isValidChangeKindTargetPairing('deactivate', targetAccountId)).toBe(true);
    expect(isValidChangeKindTargetPairing('deactivate', null)).toBe(false);
    expect(isValidChangeKindTargetPairing('reactivate', targetAccountId)).toBe(true);
    expect(isValidChangeKindTargetPairing('reactivate', null)).toBe(false);
  });
});

// --- WBS 4.1a part 3: isValidDeactivateReactivateDirection(changeKind, currentIsActive) ------------
// (brief §Domain design — the new pure invariant the future 4.1a part 2b Submit command reuses,
// pairing with the DB trigger's own old.is_active check as its backstop.)

describe('isValidDeactivateReactivateDirection: pure direction invariant, no DB round-trip needed', () => {
  it('deactivate requires currentIsActive===true; reactivate requires currentIsActive===false; any other changeKind is unconstrained (always true)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<'create' | 'update' | 'deactivate' | 'reactivate'>('create', 'update', 'deactivate', 'reactivate'),
        fc.boolean(),
        (changeKind, currentIsActive) => {
          const expected =
            changeKind === 'deactivate'
              ? currentIsActive === true
              : changeKind === 'reactivate'
                ? currentIsActive === false
                : true;
          expect(isValidDeactivateReactivateDirection(changeKind, currentIsActive)).toBe(expected);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('create/update are unconstrained by this rule regardless of currentIsActive', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<'create' | 'update'>('create', 'update'),
        fc.boolean(),
        (changeKind, currentIsActive) => {
          expect(isValidDeactivateReactivateDirection(changeKind, currentIsActive)).toBe(true);
        },
      ),
    );
  });

  it('deactivate + currentIsActive=true is valid; deactivate + currentIsActive=false is invalid', () => {
    expect(isValidDeactivateReactivateDirection('deactivate', true)).toBe(true);
    expect(isValidDeactivateReactivateDirection('deactivate', false)).toBe(false);
  });

  it('reactivate + currentIsActive=false is valid; reactivate + currentIsActive=true is invalid', () => {
    expect(isValidDeactivateReactivateDirection('reactivate', false)).toBe(true);
    expect(isValidDeactivateReactivateDirection('reactivate', true)).toBe(false);
  });
});

// --- WBS 4.1a part 3, fix round finding 2: isDeactivationAllowed(hasActiveChild) -------------------
// (domain counterpart of the active-children check in the DB trigger
// billing.assert_gl_account_change_approved(), migration 0036 — that trigger remains its backstop.)

describe('isDeactivationAllowed: pure active-children invariant, no DB round-trip needed', () => {
  it('for any boolean hasActiveChild, isDeactivationAllowed(hasActiveChild) === !hasActiveChild', () => {
    fc.assert(
      fc.property(fc.boolean(), (hasActiveChild) => {
        expect(isDeactivationAllowed(hasActiveChild)).toBe(!hasActiveChild);
      }),
      { numRuns: 50 },
    );
  });

  it('hasActiveChild=false is allowed; hasActiveChild=true is blocked', () => {
    expect(isDeactivationAllowed(false)).toBe(true);
    expect(isDeactivationAllowed(true)).toBe(false);
  });
});
