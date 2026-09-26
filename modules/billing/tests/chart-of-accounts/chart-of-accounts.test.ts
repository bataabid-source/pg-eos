// modules/billing/tests/chart-of-accounts/chart-of-accounts.test.ts — WBS 4.1a (lane 2).
//
// Integration tests against `billing.gl_accounts` directly (01-Data-Model.sql:1177-1187). No
// domain command, no application layer, no api/ handler exists for this slice — `gl_accounts` is
// a single reference table with no lifecycle (brief: "An account has no lifecycle in 01").
//
// Part 1 scope (Master's ruling, pre-migration review round 2): the gl_accounts WRITE PATH and the
// SYSADMIN permission grant are WITHDRAWN from this slice, deferred to "4.1a part 2". Every
// scenario below therefore inserts through the same admin/bypass pool (`pool`, PGUSER — RLS-blind),
// same style as modules/billing/tests/record-billable-event/record-billable-event.test.ts's own
// admin-pool scenarios: it proves the DATABASE CHECK constraint (0028_2_chart-of-accounts.sql)
// fires on its own, independent of any application-layer validation, and that a well-formed code's
// class is read correctly from its first segment.
//
// Domain surface this slice expects pg-backend to add:
//   modules/billing/domain/chart-of-accounts/invariants.ts
//     - `isValidAccountCode(code: string): boolean`
//     - `assertValidAccountCode(code: string): void` — throws InvalidAccountCodeError
//     - `accountClassFromCode(code: string): number` — the code's first segment as a number 1-9;
//       throws InvalidAccountCodeError if the code is not X-XX-XXX-XXX shaped
//     - `ALLOWED_ACCOUNT_TYPES: readonly string[]`
//     - `assertValidAccountType(accountType: string): void` — throws InvalidAccountTypeError
//   modules/billing/domain/chart-of-accounts/errors.ts
//     - `InvalidAccountCodeError`, `InvalidAccountTypeError`

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  accountClassFromCode,
  ALLOWED_ACCOUNT_TYPES,
  assertValidAccountType,
} from '../../domain/chart-of-accounts/invariants.js';
import { InvalidAccountTypeError } from '../../domain/chart-of-accounts/errors.js';

// Admin pool (PGUSER, bypasses RLS) — fixture setup/teardown, and the "insert directly, skipping
// the domain layer entirely" scenarios that must prove the DB CHECK fires on its own.
const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

// --- literals --------------------------------------------------------------------------------

const VALID_CODE = '1-01-001-001'; // class 1 (asset), well-formed X-XX-XXX-XXX.
const VALID_ACCOUNT_TYPE = 'asset'; // 01:1183 — already one of the five existing values.
const NAME_AR = 'حساب اختبار دليل الحسابات — WBS 4.1a';

const OFF_FORMAT_CODES = [
  '1-1-001-001', // second segment only 1 digit, not 2
  '1-01-01-001', // third segment only 2 digits, not 3
  '1-01-001-01', // fourth segment only 2 digits, not 3
  '1_01_001_001', // wrong separator
  '1-01-001-0011', // extra character
  '101001001', // no hyphens at all
];

const OUT_OF_CLASS_CODES = [
  '0-01-001-001', // first segment 0, outside 1-9
  '10-01-001-001', // first segment two digits, outside 1-9 shape
];

const OUT_OF_LIST_ACCOUNT_TYPE = '_not_a_real_account_type_wbs_4_1a';

// Round-1 review finding 3: a code DISTINCT from `VALID_CODE` (already inserted by scenario 1 and
// only cleaned up in `afterAll`) and from every other literal code in this file — class 3 is not
// used by any other scenario here, so a count-of-1 collision with scenario 1's own row can never
// happen once the migration's CHECK constraints land.
const ACCOUNT_TYPE_SCENARIO_CODE = '3-01-001-001';

// Round-1 review finding 5: one distinct, well-formed code per account_type case under test, so the
// unique (entity_id, code) constraint never collides between cases or with any other scenario's own
// literal code in this file. `prefix` is a single-digit class 1-9 not used by any other scenario
// (class 4 = the "accepted" cases, class 5 = the domain/DB agreement cases).
function accountTypeTestCode(prefix: number, index: number): string {
  return `${prefix}-01-001-${String(index + 1).padStart(3, '0')}`;
}

let entityId: string;
let otherEntityId: string;
const fixtureAccountIds: string[] = [];

async function insertViaAdminPool(input: {
  entityId: string;
  code: string;
  accountType: string;
}): Promise<QueryResult<{ id: string }>> {
  return pool.query(
    `insert into billing.gl_accounts (entity_id, code, name_ar, account_type)
     values ($1, $2, $3, $4) returning id`,
    [input.entityId, input.code, NAME_AR, input.accountType],
  );
}

async function countAccountsForCode(entityIdValue: string, code: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from billing.gl_accounts where entity_id = $1 and code = $2`,
    [entityIdValue, code],
  );
  return Number(result.rows[0]?.n ?? '0');
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
  if (!otherEntityRow) throw new Error('expected at least 2 rows in platform.entities (per-entity chart fixture)');
  otherEntityId = otherEntityRow.id;
});

afterAll(async () => {
  if (fixtureAccountIds.length > 0) {
    await pool.query(`delete from billing.gl_accounts where id = any($1::uuid[])`, [fixtureAccountIds]);
  }
  // sweep any row this suite's own literal codes left behind, scoped to the two fixture entities.
  await pool.query(
    `delete from billing.gl_accounts where entity_id = any($1::uuid[]) and name_ar = $2`,
    [[entityId, otherEntityId], NAME_AR],
  );
  await pool.end();
});

// --- Scenario: An account code in the X-XX-XXX-XXX format is accepted and its class is its first segment ---

describe('Scenario: An account code in the X-XX-XXX-XXX format is accepted and its class is its first segment', () => {
  it('inserts through the admin pool and the class read from the first segment is 1', async () => {
    const result = await insertViaAdminPool({
      entityId,
      code: VALID_CODE,
      accountType: VALID_ACCOUNT_TYPE,
    });
    const id = result.rows[0]?.id;
    if (!id) throw new Error('fixture insert returned no id');
    fixtureAccountIds.push(id);

    expect(await countAccountsForCode(entityId, VALID_CODE)).toBe(1);
    expect(accountClassFromCode(VALID_CODE)).toBe(1);
  });
});

// --- Scenario: An off-format account code is rejected by the database CHECK, not only by the domain ---

describe('Scenario: An off-format account code is rejected by the database CHECK, not only by the domain', () => {
  it.each(OFF_FORMAT_CODES)('code %s is rejected by the DB CHECK when inserted directly through the admin pool', async (code) => {
    await expect(insertViaAdminPool({ entityId, code, accountType: VALID_ACCOUNT_TYPE })).rejects.toMatchObject({
      code: '23514', // Postgres SQLSTATE for check_violation.
    });

    expect(await countAccountsForCode(entityId, code)).toBe(0);
  });
});

// --- Scenario: A first segment outside class 1-9 is rejected by the database CHECK ------------------

describe('Scenario: A first segment outside class 1-9 is rejected by the database CHECK', () => {
  it.each(OUT_OF_CLASS_CODES)('code %s is rejected by the DB CHECK when inserted directly through the admin pool', async (code) => {
    await expect(insertViaAdminPool({ entityId, code, accountType: VALID_ACCOUNT_TYPE })).rejects.toMatchObject({
      code: '23514',
    });

    expect(await countAccountsForCode(entityId, code)).toBe(0);
  });
});

// --- Scenario: An account_type outside the allowed list is rejected ---------------------------------

describe('Scenario: An account_type outside the allowed list is rejected', () => {
  it('rejects an account_type not in the allowed list, inserted directly through the admin pool', async () => {
    expect(ALLOWED_ACCOUNT_TYPES).not.toContain(OUT_OF_LIST_ACCOUNT_TYPE);

    await expect(
      insertViaAdminPool({ entityId, code: ACCOUNT_TYPE_SCENARIO_CODE, accountType: OUT_OF_LIST_ACCOUNT_TYPE }),
    ).rejects.toMatchObject({ code: '23514' });

    expect(await countAccountsForCode(entityId, ACCOUNT_TYPE_SCENARIO_CODE)).toBe(0);
  });
});

// --- round-1 review finding 5: account_type values ARE accepted by the DB (no existing test -----
// --- asserted acceptance, only rejection) -------------------------------------------------------

describe('account_type values in the allowed list are accepted through a direct admin-pool insert (round-1 review finding 5)', () => {
  it.each(ALLOWED_ACCOUNT_TYPES.map((type, index) => [type, accountTypeTestCode(4, index)] as const))(
    'account_type %s is accepted, inserted directly through the admin pool with a distinct well-formed code',
    async (accountType, code) => {
      const result = await insertViaAdminPool({ entityId, code, accountType });
      const id = result.rows[0]?.id;
      if (!id) throw new Error('fixture insert returned no id');
      fixtureAccountIds.push(id);

      expect(await countAccountsForCode(entityId, code)).toBe(1);
    },
  );
});

// One case per allowed value (domain and DB both expected to accept) plus a handful of known-bad
// strings (domain and DB both expected to reject) — a small closed-list agreement check, not a full
// fast-check property (the account_type space is a small closed list, not open-ended like the code
// format, which already has its own property test in ./invariants.property.test.ts).
const ACCOUNT_TYPE_AGREEMENT_CASES: ReadonlyArray<readonly [string, boolean]> = [
  ...ALLOWED_ACCOUNT_TYPES.map((type) => [type, true] as const),
  [OUT_OF_LIST_ACCOUNT_TYPE, false],
  ['ASSET', false], // the closed list is lower-case, per invariants.ts's own ALLOWED_ACCOUNT_TYPES literals
  ['', false],
  ['other_income', false], // close to, but not, 'other_income_expense'
];

describe('assertValidAccountType (domain) and the database CHECK constraint on account_type agree on accept/reject (round-1 review finding 5)', () => {
  it.each(
    ACCOUNT_TYPE_AGREEMENT_CASES.map(([type, expectedAccept], index) => [type, expectedAccept, accountTypeTestCode(5, index)] as const),
  )('account_type %s: domain assertValidAccountType and the DB CHECK agree (expected accept=%s)', async (accountType, expectedAccept, code) => {
    let domainAccepts = true;
    try {
      assertValidAccountType(accountType);
    } catch (error) {
      if (!(error instanceof InvalidAccountTypeError)) throw error;
      domainAccepts = false;
    }
    expect(domainAccepts).toBe(expectedAccept);

    let dbAccepts = true;
    try {
      const result = await insertViaAdminPool({ entityId, code, accountType });
      const id = result.rows[0]?.id;
      if (id) fixtureAccountIds.push(id);
    } catch (error) {
      const pgError = error as { code?: string };
      if (pgError.code === '23514') {
        dbAccepts = false;
      } else {
        throw error;
      }
    }

    expect(dbAccepts).toBe(domainAccepts);
  });
});

// --- Scenario: The same code may exist once per entity and never twice in one entity ----------------

describe('Scenario: The same code may exist once per entity and never twice in one entity (unique (entity_id, code))', () => {
  it('a second insert of the same (entity_id, code) is rejected by the unique constraint, but the same code for a different entity succeeds', async () => {
    const code = '2-01-001-001';

    const first = await insertViaAdminPool({ entityId, code, accountType: VALID_ACCOUNT_TYPE });
    const firstId = first.rows[0]?.id;
    if (!firstId) throw new Error('fixture insert returned no id');
    fixtureAccountIds.push(firstId);

    await expect(insertViaAdminPool({ entityId, code, accountType: VALID_ACCOUNT_TYPE })).rejects.toMatchObject({
      code: '23505', // Postgres SQLSTATE for unique_violation.
    });

    expect(await countAccountsForCode(entityId, code)).toBe(1);

    const otherEntityInsert = await insertViaAdminPool({ entityId: otherEntityId, code, accountType: VALID_ACCOUNT_TYPE });
    const otherId = otherEntityInsert.rows[0]?.id;
    if (!otherId) throw new Error('fixture insert (other entity) returned no id');
    fixtureAccountIds.push(otherId);

    expect(await countAccountsForCode(otherEntityId, code)).toBe(1);
  });
});

// --- Scenario: No account-code literal appears under modules/ (static scan test) --------------------

const MODULES_ROOT = join(__dirname, '..', '..', '..'); // modules/billing/tests/chart-of-accounts -> modules/
const ACCOUNT_CODE_LITERAL_RE = /["'`]\d-\d{2}-\d{3}-\d{3}["'`]/; // matches "1-01-001-001"-shaped literals.
const EXCLUDED_PATH_SEGMENT_RE = /[\\/](tests)[\\/]/;
const EXCLUDED_FILE_SUFFIX_RE = /\.(test|spec)\.[jt]sx?$|\.feature$/;
const SCANNABLE_FILE_RE = /\.(ts|tsx|js|jsx|sql)$/;

function listFilesRecursive(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      files.push(...listFilesRecursive(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

describe('Scenario: No account-code literal appears under modules/ (static scan test over the source tree)', () => {
  it('no string literal shaped like an X-XX-XXX-XXX account code appears outside modules/**/tests/** or *.test.*/*.spec.*/*.feature files', () => {
    const offenders: string[] = [];
    for (const file of listFilesRecursive(MODULES_ROOT)) {
      const rel = relative(MODULES_ROOT, file);
      if (EXCLUDED_PATH_SEGMENT_RE.test(file) || EXCLUDED_FILE_SUFFIX_RE.test(file)) continue;
      if (!SCANNABLE_FILE_RE.test(file)) continue;
      const content = readFileSync(file, 'utf8');
      if (ACCOUNT_CODE_LITERAL_RE.test(content)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
