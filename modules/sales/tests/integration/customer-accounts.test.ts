// modules/sales/tests/integration/customer-accounts.test.ts — WBS 1.5 (pg-tester), proof slice
// (ADR-0001: docs/adr/ADR-0001-1.5-proof-slice.md). Governed by
// .claude/briefs/_slice-1.5.brief.md — read that file for the eight Master decisions this suite
// implements one-to-one.
//
// WHY THIS IS A PROOF SUITE, NOT A UNIT/DOMAIN SUITE (ADR-0001 Decision): the M02 sales data
// model already exists in database/schema/01-Data-Model.sql and
// database/schema/13B-Schema-Reference-Consolidation.sql — no migration, no application code is
// built by this slice. This file is the permanent, re-runnable proof that doc 38 row 1.5's
// acceptance ("One account per client across entities; duplicate detection fires") holds at the
// schema level, in the 2.1 / WH1 pattern (modules/wms/tests/integration/wh1-setup.test.ts). Rows
// are labelled test fixtures created in beforeAll and removed in afterAll (0.18 precedent,
// packages/identity/tests/rbac-sod.test.ts) — there is no seed source for `sales` in 01/13/13B/019
// (ADR-0001 Context), so no real client name, CR number or credit limit is ever written here
// (CLAUDE.md AGENT CONSTRAINTS — never fabricate a number, name or decision).
//
// Citations use NAMES, not line numbers (slice brief instruction): "doc 40 §A2 / §C2 INV-C2-3",
// "01 sales.accounts", "13B §13B-19 sales.possible_duplicates", "13B chk_accounts_status".
//
// Written RED first (decision 3(a), report honestly): on 2026-09-23, against the pre-0006 view,
// `sales.possible_duplicates` (13B §13B-19) read `similarity(a.name_ar, b.name_ar) > 0.85`; doc 40
// §C2 INV-C2-3 requires "≥ 0.85" (ADR-0001 "Known discrepancy"). The GM directive of 2026-09-23
// (phase D) ordered this corrected by migration 0006 (Master task, out of this suite's Write ONLY
// scope). The "decision 3(a)" test below was RED until 0006 landed, and was required to stay RED
// until it did — weakening it would have hidden the discrepancy the ADR exists to surface. It is
// green after migration 0006. Master correction (2026-09-23): pg_get_viewdef normalizes the view
// text, so no literal "`>= 0.85`" substring exists either way — the test asserts the fully
// normalized fragment instead (see that describe block for the exact strings, measured live on
// PostgreSQL 16.15).
//
// Written RED first (decision 7, brief update 2026-09-23, SCR-TRGM-01, GM-approved option A): on
// 2026-09-23, against a database still created with the plain C ctype, this failed — see the
// "SCR-TRGM-01" describe block below, placed before every Arabic name-similarity scenario in this
// file so the ctype check always runs first (brief decision 7 — the feature file's Background
// itself carries no ctype step; this is a file-ordering choice, not a Background clause) — and
// every Arabic name-similarity assertion below (identical names, the > 0.85 variant, its soft-deleted
// twin, and the 0.85 boundary pair) was consequently RED too, because plain C carries zero
// trigrams for non-ASCII text (show_trgm() returns {}), so similarity() on Arabic text returned 0
// regardless of the two strings compared. This was reported honestly, not weakened. It is green
// after the database was recreated with lc_ctype C.UTF-8, lc_collate C (SCR-TRGM-01 option A).
//
// Decision 6 (brief, verbatim): "the name-similarity fixtures (identical names, F/G, soft-deleted
// twin, boundary pair) start with the word `اختبار` (test) and use Arabic only, never Latin
// (SCR-TRGM-01)". See ARABIC_TEST_WORD below.
//
// Connects to the already-running dev database exactly like
// modules/wms/tests/integration/wh1-setup.test.ts (pg Pool, PG* env, same defaults). Superuser
// pool — RLS is proven by shape only (decision 4); functional client isolation of sales.accounts
// was already proven by WBS 0.18, 43/43 (tests/isolation/tests/client-isolation.test.ts) and is
// cited here, not repeated.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

// PostgreSQL unique_violation (PostgreSQL docs, Appendix A, Class 23) — decision 8 of the slice
// brief: "23505 is PostgreSQL's unique_violation"; never invented.
const UNIQUE_VIOLATION_SQLSTATE = '23505';

// Decision 6 (fixture literals — none is a real business value):
//   code prefixed `_sales_fixture_`, account_type 'client', client_kind '3pl', status 'active'
//   (13B chk_accounts_status), cr_number prefixed `FIXTURE-CR-`.
const FIXTURE_CODE_PREFIX = '_sales_fixture_';
const FIXTURE_CR_PREFIX = 'FIXTURE-CR-';
// 01 sales.accounts — account_type column comment: "prospect · client · partner · vendor".
const ACCOUNT_TYPE = 'client';
// 01 sales.accounts — client_kind column comment: "3pl · 2pl · delivery_b2c · delivery_b2b ·
// cc_external · cc_internal · mixed".
const CLIENT_KIND = '3pl';
// 13B chk_accounts_status: active · suspended · closed.
const ACCOUNT_STATUS = 'active';

// Decision 6 (brief, verbatim): "`name_ar` = a clearly synthetic Arabic label (never a real name);
// the name-similarity fixtures (identical names, F/G, soft-deleted twin, boundary pair) start with
// the word `اختبار` (test) and use Arabic only, never Latin (SCR-TRGM-01)". Every name_ar literal in
// the four name-similarity scenarios below (identical names, the F/G pair above 0.85, its
// soft-deleted twin, and the 0.85 boundary pair) STARTS with this word and uses Arabic only — never
// Latin — but is not always built purely from it: F is اختبار followed by the 23 other distinct
// Arabic letters (decision 2's fixture fix; G is F with one trailing letter changed), and the
// boundary pair is اختبارمكررتجريبي / اختبارمكررتجريبي كو. Only D and E, the identical-name pair,
// are built purely from اختبار repeated.
const ARABIC_TEST_WORD = 'اختبار';

// One run id per test-process invocation isolates this run's fixtures from any other concurrent
// or leftover run's rows (slice brief Fixtures rule: "Where a scenario must insert rows that could
// collide with other scenarios, isolate by unique names"). RUN_SLUG is the 8 hex-character head of
// RUN_ID with the dashes stripped, used inside `code`, `cr_number` and the non-name-similarity
// `name_ar` labels (accounts A/B/C, the throwaway contact-cascade fixture). Decision 6 (2026-09-23)
// forbids Latin characters — including RUN_SLUG's hex alphabet — inside the four name-similarity
// scenarios' name_ar values (identical, > 0.85 variant, its soft-deleted twin, the 0.85 boundary);
// those are isolated by distinct Arabic wording per scenario and by filtering the view on this
// test's own account ids, not by RUN_SLUG (same pattern as the pre-existing boundary-pair comment).
const RUN_ID = randomUUID();
const RUN_SLUG = RUN_ID.replace(/-/g, '').slice(0, 8);

function fixtureCode(label: string): string {
  return `${FIXTURE_CODE_PREFIX}${RUN_ID}_${label}`;
}

function fixtureCrNumber(label: string): string {
  return `${FIXTURE_CR_PREFIX}${RUN_ID}-${label}`;
}

function getPgErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the query to reject, but it resolved');
}

interface AccountRow {
  id: string;
  code: string;
  crNumber: string | null;
}

async function insertAccount(params: {
  code: string;
  nameAr: string;
  crNumber: string | null;
}): Promise<AccountRow> {
  const result: QueryResult<{ id: string; code: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type, client_kind, status, cr_number)
     values ($1, $2, $3, $4, $5, $6)
     returning id, code`,
    [params.code, params.nameAr, ACCOUNT_TYPE, CLIENT_KIND, ACCOUNT_STATUS, params.crNumber],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`insertAccount: no row returned for code ${params.code}`);
  return { id: row.id, code: row.code, crNumber: params.crNumber };
}

async function softDeleteAccount(id: string): Promise<void> {
  await pool.query(`update sales.accounts set deleted_at = now() where id = $1`, [id]);
}

async function insertContact(
  accountId: string,
  params: { name: string; roleType: string; isPrimary: boolean },
): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.contacts (account_id, name, role_type, is_primary)
     values ($1, $2, $3, $4)
     returning id`,
    [accountId, params.name, params.roleType, params.isPrimary],
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertContact: no row returned');
  return row.id;
}

// Background (feature file): "fixture accounts A, B, C (and contacts) created with synthetic
// values". A carries a live cr_number and a primary contact (used by the code/cr_number/contacts
// scenarios below); B and C both carry cr_number null (decision 1's "two rows with cr_number null
// coexist"), each with its own non-primary contact.
let accountA: AccountRow;
let accountB: AccountRow;
let accountC: AccountRow;

beforeAll(async () => {
  accountA = await insertAccount({
    code: fixtureCode('A'),
    nameAr: `حساب فحص أ ${RUN_SLUG}`,
    crNumber: fixtureCrNumber('A'),
  });
  await insertContact(accountA.id, {
    name: `Fixture Contact A ${RUN_SLUG}`,
    roleType: 'decision_maker', // 01 sales.contacts role_type comment
    isPrimary: true,
  });

  accountB = await insertAccount({
    code: fixtureCode('B'),
    nameAr: `حساب فحص ب ${RUN_SLUG}`,
    crNumber: null,
  });
  await insertContact(accountB.id, {
    name: `Fixture Contact B ${RUN_SLUG}`,
    roleType: 'operations',
    isPrimary: false,
  });

  accountC = await insertAccount({
    code: fixtureCode('C'),
    nameAr: `حساب فحص ج ${RUN_SLUG}`,
    crNumber: null,
  });
  await insertContact(accountC.id, {
    name: `Fixture Contact C ${RUN_SLUG}`,
    roleType: 'finance',
    isPrimary: false,
  });
});

afterAll(async () => {
  // Decision 6: "Created in beforeAll, deleted in afterAll (contacts cascade)." sales.contacts
  // has `on delete cascade` on account_id (01 sales.contacts), so this single delete also removes
  // every fixture contact row.
  await pool.query(`delete from sales.accounts where code like $1`, [`${FIXTURE_CODE_PREFIX}%`]);

  // Decision 6: "Assert afterAll leaves zero `_sales_fixture_%` rows" — the "nothing fixture-like
  // remains" scenario of the feature file, proved here, after the delete above runs.
  const result: QueryResult<{ count: string }> = await pool.query(
    `select count(*)::text as count from sales.accounts where code like $1`,
    [`${FIXTURE_CODE_PREFIX}%`],
  );
  expect(result.rows[0]?.count).toBe('0');

  await pool.end();
});

// Decision 7 (brief update, 2026-09-23; GM-approved option A, SCR-TRGM-01): databases are created
// with lc_ctype C.UTF-8, lc_collate C. Decision 7 requires this asserted BEFORE any Arabic
// name-similarity scenario, so this describe block is placed first in the file — the feature file's
// Background itself carries no ctype step; this is a file-ordering choice, not a Background clause
// (matching the file header above) — because under the old plain-C ctype, non-ASCII text carries
// zero trigrams (show_trgm() returns {}), so every similarity() call on Arabic text below returns 0,
// not the value it claims.
describe('SCR-TRGM-01 — Arabic matching works in this database (decision 7, GM-approved option A: lc_ctype C.UTF-8, lc_collate C)', () => {
  it('the current database ctype (pg_database.datctype) is C.UTF-8', async () => {
    const result: QueryResult<{ datctype: string }> = await pool.query(
      `select datctype from pg_database where datname = current_database()`,
    );
    expect(result.rows[0]?.datctype).toBe('C.UTF-8');
  });

  it('similarity of the Arabic test word اختبار with itself is 1 (0 under the old plain-C ctype — 0 trigrams)', async () => {
    const result: QueryResult<{ sim: number }> = await pool.query(
      `select similarity($1::text, $1::text) as sim`,
      [ARABIC_TEST_WORD],
    );
    expect(result.rows[0]?.sim).toBe(1);
  });
});

describe('sales.accounts is a group-level record (doc 40 §A2, ADR-0001 Context: "One sales.accounts row per client across all entities")', () => {
  it('has no entity_id column in information_schema.columns', async () => {
    const result: QueryResult<{ count: string }> = await pool.query(
      `select count(*)::text as count
         from information_schema.columns
        where table_schema = 'sales' and table_name = 'accounts' and column_name = 'entity_id'`,
    );
    expect(result.rows[0]?.count).toBe('0');
  });
});

describe('sales.accounts.code is unique (01 sales.accounts unique constraint)', () => {
  it("a second insert with account A's code fails with SQLSTATE 23505, and sales.accounts still has exactly one row with that code", async () => {
    const error = await rejectionOf(
      insertAccount({
        code: accountA.code,
        nameAr: `تكرار الكود ${RUN_SLUG}`,
        crNumber: fixtureCrNumber('code-dup'),
      }),
    );
    expect(getPgErrorCode(error)).toBe(UNIQUE_VIOLATION_SQLSTATE);

    const result: QueryResult<{ count: string }> = await pool.query(
      `select count(*)::text as count from sales.accounts where code = $1`,
      [accountA.code],
    );
    expect(result.rows[0]?.count).toBe('1');
  });
});

describe('sales.accounts.cr_number is unique among live rows (01 sales.accounts partial unique index on cr_number: "where cr_number is not null and deleted_at is null")', () => {
  it("a second LIVE account with account A's cr_number fails with SQLSTATE 23505", async () => {
    const crNumber = accountA.crNumber;
    if (!crNumber) throw new Error('accountA must carry a live cr_number for this test');

    const error = await rejectionOf(
      insertAccount({
        code: fixtureCode('cr-dup-live'),
        nameAr: `تكرار الرقم التجاري ${RUN_SLUG}`,
        crNumber,
      }),
    );
    expect(getPgErrorCode(error)).toBe(UNIQUE_VIOLATION_SQLSTATE);
  });

  it("A's cr_number can be reused once A is soft-deleted (deleted_at set) — the partial unique index only covers live rows", async () => {
    const crNumber = accountA.crNumber;
    if (!crNumber) throw new Error('accountA must carry a live cr_number for this test');

    await softDeleteAccount(accountA.id);

    // Confirms the soft-delete actually took effect before asserting the reuse succeeds.
    const deletedCheck: QueryResult<{ is_deleted: boolean }> = await pool.query(
      `select (deleted_at is not null) as is_deleted from sales.accounts where id = $1`,
      [accountA.id],
    );
    expect(deletedCheck.rows[0]?.is_deleted).toBe(true);

    // Removed by the shared afterAll's `_sales_fixture_%` sweep — decision 1: "the insert
    // succeeds ... and the new row is removed in cleanup".
    const reused = await insertAccount({
      code: fixtureCode('cr-reuse-after-soft-delete'),
      nameAr: `إعادة استخدام الرقم التجاري ${RUN_SLUG}`,
      crNumber,
    });
    expect(reused.id).not.toBe(accountA.id);
  });
});

describe('two accounts without a CR number coexist (01 sales.accounts partial unique index on cr_number ignores nulls)', () => {
  it('both inserts succeed: two live accounts B and C, both with cr_number null, coexist without violating the partial unique index', async () => {
    const result: QueryResult<{ count: string }> = await pool.query(
      `select count(*)::text as count
         from sales.accounts
        where id in ($1, $2) and cr_number is null and deleted_at is null`,
      [accountB.id, accountC.id],
    );
    expect(result.rows[0]?.count).toBe('2');
  });
});

describe("the CR-number path of sales.possible_duplicates is closed by the index itself (01 sales.accounts partial unique index; 13B §13B-19 sales.possible_duplicates cr_number branch) — cite both, prove nothing more", () => {
  it('no two LIVE rows in the whole table share a cr_number (the partial unique index forbids it structurally, proven behaviorally above)', async () => {
    const result: QueryResult<{ cr_number: string; n: string }> = await pool.query(
      `select cr_number, count(*)::text as n
         from sales.accounts
        where deleted_at is null and cr_number is not null
        group by cr_number
       having count(*) > 1`,
    );
    // If this is ever non-empty, the 13B §13B-19 cr_number branch
    // (`a.cr_number = b.cr_number`) could fire on a pair the index was supposed to forbid —
    // which would mean the index itself is broken, not this view. Nothing more is asserted here.
    expect(result.rows).toEqual([]);
  });
});

describe('sales.possible_duplicates fires on identical name_ar (13B §13B-19 sales.possible_duplicates)', () => {
  let accountD: AccountRow;
  let accountE: AccountRow;

  beforeAll(async () => {
    // Decision 6 (2026-09-23): built purely from the Arabic word اختبار, no Latin, no RUN_SLUG —
    // isolation is by id-pair filtering in the assertion below (same pattern as the 0.85 boundary
    // pair further down), not by a per-run suffix.
    const identicalNameAr = `${ARABIC_TEST_WORD} ${ARABIC_TEST_WORD} ${ARABIC_TEST_WORD}`;
    accountD = await insertAccount({
      code: fixtureCode('D'),
      nameAr: identicalNameAr,
      crNumber: null,
    });
    accountE = await insertAccount({
      code: fixtureCode('E'),
      nameAr: identicalNameAr,
      crNumber: null,
    });
  });

  it('returns exactly the (D, E) pair with sim = 1.000', async () => {
    const result: QueryResult<{ sim: string }> = await pool.query(
      `select sim
         from sales.possible_duplicates
        where (a_id = $1 and b_id = $2) or (a_id = $2 and b_id = $1)`,
      [accountD.id, accountE.id],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.sim).toBe('1.000');
  });
});

describe('sales.possible_duplicates fires on name_ar similarity above 0.85 (doc 40 §C2 INV-C2-3: "Duplicate detection on cr_number and name similarity ≥ 0.85 (pg_trgm)")', () => {
  // FIXTURE FIX (Master directive, 2026-09-23; fixes the fixture, not the assertion — CLAUDE.md:
  // never fabricate a number, never weaken a test): the original fixture built F as
  // ARABIC_TEST_WORD.repeat(5) — a PERIODIC string. A periodic string has far fewer DISTINCT
  // trigrams than its length implies (the same 3-letter window recurs every period), so on
  // C.UTF-8 (real trigrams, not the old plain-C zero-trigram bug) replacing F's last letter drops
  // similarity(F, G) BELOW 0.85, not above it (measured: fails). The fix is to build F so that its
  // trigrams are ALL DISTINCT, which makes the trigram arithmetic exact:
  //   pg_trgm pads a word of length n with guard blanks, producing n+1 trigrams total.
  //   Replacing ONLY the last letter changes exactly the 2 trigrams that touch that letter and
  //   leaves the other n-1 untouched, so shared = n-1 and union = (n+1)+(n+1)-(n-1) = n+3.
  //   similarity(F, G) = (n-1)/(n+3), which exceeds 0.85 only when n-1 > 0.85(n+3), i.e. n >= 24.
  // F below starts with اختبار (decision 6, verbatim: "the name-similarity fixtures (identical
  // names, F/G, soft-deleted twin, boundary pair) start with the word اختبار (test) and use Arabic
  // only, never Latin (SCR-TRGM-01)") and is extended with the 23 other distinct letters of the
  // Arabic alphabet — a
  // clearly synthetic label (literally "test" + "the rest of the alphabet"), never a real name —
  // giving n = 29 distinct-trigram letters, comfortably clearing the n >= 24 floor:
  // (29-1)/(29+3) = 28/32 = 0.875 > 0.85 (verified live below, and independently on the command
  // line against pgeos_g2 before this file was written). G is F with only its last letter changed.
  const ARABIC_ALPHABET = 'ابتثجحخدذرزسشصضطظعغفقكلمنهوي'; // the 28 distinct basic Arabic letters
  const REPLACEMENT_LAST_CHAR = 'ا'; // any letter distinct from F's actual last letter (checked below)
  // Derivation (brief decision 2): similarity(F, G) = (n-1)/(n+3) for a word of n letters with all
  // distinct trigrams whose last letter is replaced. This exceeds 0.85 exactly when
  // n-1 > 0.85(n+3), i.e. n >= 24 — the smallest integer n for which the inequality holds.
  const MIN_DISTINCT_TRIGRAM_LETTERS_FOR_SIMILARITY_ABOVE_085 = 24;

  let accountF: AccountRow;
  let accountG: AccountRow;
  let nameArF: string;
  let nameArG: string;

  beforeAll(async () => {
    const usedInPrefix = new Set(ARABIC_TEST_WORD.split(''));
    const fillerLetters = ARABIC_ALPHABET.split('').filter((ch) => !usedInPrefix.has(ch));
    nameArF = ARABIC_TEST_WORD + fillerLetters.join('');
    // n >= 24 per the (n-1)/(n+3) > 0.85 derivation above.
    expect(nameArF.length).toBeGreaterThanOrEqual(
      MIN_DISTINCT_TRIGRAM_LETTERS_FOR_SIMILARITY_ABOVE_085,
    );

    const lastChar = nameArF.slice(-1);
    const replacementChar =
      lastChar === REPLACEMENT_LAST_CHAR ? ARABIC_TEST_WORD[1] : REPLACEMENT_LAST_CHAR;
    nameArG = `${nameArF.slice(0, -1)}${replacementChar}`;
    expect(nameArG).not.toBe(nameArF);
    expect(nameArG).toHaveLength(nameArF.length);

    accountF = await insertAccount({ code: fixtureCode('F'), nameAr: nameArF, crNumber: null });
    accountG = await insertAccount({ code: fixtureCode('G'), nameAr: nameArG, crNumber: null });
  });

  it('similarity(F, G) is above 0.85 and below 1, asserted in SQL before the view is queried (decision 2)', async () => {
    const result: QueryResult<{ sim_gt_085: boolean; sim_lt_1: boolean }> = await pool.query(
      `select (similarity($1::text, $2::text) > 0.85) as sim_gt_085,
              (similarity($1::text, $2::text) < 1) as sim_lt_1`,
      [nameArF, nameArG],
    );
    expect(result.rows[0]?.sim_gt_085).toBe(true);
    expect(result.rows[0]?.sim_lt_1).toBe(true);
  });

  it('sales.possible_duplicates returns exactly the (F, G) pair with sim = round(similarity, 3)', async () => {
    const expectedSim: QueryResult<{ sim: string }> = await pool.query(
      `select round(similarity($1::text, $2::text)::numeric, 3)::text as sim`,
      [nameArF, nameArG],
    );

    const result: QueryResult<{ sim: string }> = await pool.query(
      `select sim
         from sales.possible_duplicates
        where (a_id = $1 and b_id = $2) or (a_id = $2 and b_id = $1)`,
      [accountF.id, accountG.id],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.sim).toBe(expectedSim.rows[0]?.sim);
  });

  it('a soft-deleted twin is not reported: once G is soft-deleted, sales.possible_duplicates returns no row for (F, G)', async () => {
    await softDeleteAccount(accountG.id);

    const result: QueryResult<{ sim: string }> = await pool.query(
      `select sim
         from sales.possible_duplicates
        where (a_id = $1 and b_id = $2) or (a_id = $2 and b_id = $1)`,
      [accountF.id, accountG.id],
    );
    expect(result.rows).toEqual([]);
  });
});

describe('decision 3(a) — the view text: doc 40 §C2 INV-C2-3 says "≥ 0.85"; 13B §13B-19 sales.possible_duplicates read "> 0.85" before migration 0006 (ADR-0001 known discrepancy, GM directive 2026-09-23 phase D)', () => {
  // Written RED first (Master correction, 2026-09-23): pg_get_viewdef normalizes the view text, so
  // a literal "`>= 0.85`" substring never appears either way. Measured live on PostgreSQL 16.15:
  //   OLD view (before migration 0006): `(similarity(a.name_ar, b.name_ar) > (0.85)::double precision)`
  //   NEW view (after migration 0006): `(similarity(a.name_ar, b.name_ar) >= (0.85)::double precision)`
  // This also documents that the comparison runs in double precision — the reason the decision-3(b)
  // boundary pair below already matched under the OLD `>` operator (float4(0.85) rounds up to
  // 0.8500000238 in double precision).
  const OLD_OPERATOR_FRAGMENT = 'similarity(a.name_ar, b.name_ar) > (0.85)::double precision';
  const NEW_OPERATOR_FRAGMENT = 'similarity(a.name_ar, b.name_ar) >= (0.85)::double precision';

  it('pg_get_viewdef contains the ">= 0.85" comparison and not the bare "> 0.85" one — written RED first on 2026-09-23 against the pre-0006 view, green after migration 0006', async () => {
    const result: QueryResult<{ viewdef: string }> = await pool.query(
      `select pg_get_viewdef('sales.possible_duplicates'::regclass) as viewdef`,
    );
    const viewdef = result.rows[0]?.viewdef ?? '';

    expect(viewdef).toContain(NEW_OPERATOR_FRAGMENT);
    expect(viewdef).not.toContain(OLD_OPERATOR_FRAGMENT);
  });
});

describe('decision 3(b) — non-regression at exactly 0.85 (ADR-0001 known discrepancy; Master measurement on PostgreSQL 16.15, lc_ctype C.UTF-8; brief update 2026-09-23 decisions 6/7: Arabic, not Latin)', () => {
  // These two literal strings are the Master's own measured boundary pair (brief decision 3:
  // "Measured on PostgreSQL 16.15 with lc_ctype C.UTF-8: the synthetic pair name_ar =
  // 'اختبارمكررتجريبي' / 'اختبارمكررتجريبي كو' has similarity() = 17/20 = 0.85 exactly"; the
  // اختبار prefix itself is decision 6's word, verbatim: "the name-similarity fixtures ... start
  // with the word اختبار (test) and use Arabic only, never Latin (SCR-TRGM-01)"), used verbatim —
  // not generated, not RUN_ID-suffixed, because any change to their characters changes their trigram content and
  // would no longer measure exactly 0.85. Cross-run collision is avoided below by filtering the
  // view on this test's own account ids, not on name text. Measured on lc_ctype C.UTF-8 — written
  // RED first on 2026-09-23 against a database still created with the plain C ctype, where this
  // pair carried zero trigrams and similarity() returned 0, not 0.85 (decision 7, SCR-TRGM-01);
  // green after the database was recreated with lc_ctype C.UTF-8 (SCR-TRGM-01 option A).
  const BOUNDARY_NAME_A = 'اختبارمكررتجريبي';
  const BOUNDARY_NAME_B = 'اختبارمكررتجريبي كو';

  let boundaryA: AccountRow;
  let boundaryB: AccountRow;

  beforeAll(async () => {
    boundaryA = await insertAccount({
      code: fixtureCode('boundary-a'),
      nameAr: BOUNDARY_NAME_A,
      crNumber: null,
    });
    boundaryB = await insertAccount({
      code: fixtureCode('boundary-b'),
      nameAr: BOUNDARY_NAME_B,
      crNumber: null,
    });
  });

  it('similarity(a, b)::numeric(10,6) = 0.850000, asserted in SQL first', async () => {
    const result: QueryResult<{ sim: string }> = await pool.query(
      `select similarity($1::text, $2::text)::numeric(10,6)::text as sim`,
      [BOUNDARY_NAME_A, BOUNDARY_NAME_B],
    );
    expect(result.rows[0]?.sim).toBe('0.850000');
  });

  it(
    'sales.possible_duplicates reports the pair with sim 0.850 — passes on BOTH the old (">") and the ' +
      'new (">=") view text, because similarity() returns real (float4) and float4(0.85) = ' +
      '0.8500000238 when widened to double precision for the literal comparison, so the OLD `> 0.85` ' +
      'already includes this pair; this test is therefore a non-regression check, not the decision-3(a) ' +
      'RED (never a weakened test — ADR-0001 "Known discrepancy")',
    async () => {
      const result: QueryResult<{ sim: string }> = await pool.query(
        `select sim
           from sales.possible_duplicates
          where (a_id = $1 and b_id = $2) or (a_id = $2 and b_id = $1)`,
        [boundaryA.id, boundaryB.id],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.sim).toBe('0.850');
    },
  );
});

describe('RLS shape proof on sales.accounts (0.18 pattern; functional client isolation already proven by WBS 0.18, 43/43 — tests/isolation/tests/client-isolation.test.ts — cited, not repeated)', () => {
  it('relrowsecurity = true for sales.accounts', async () => {
    const result: QueryResult<{ relrowsecurity: boolean }> = await pool.query(
      `select c.relrowsecurity
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'sales' and c.relname = 'accounts'`,
    );
    expect(result.rows[0]?.relrowsecurity).toBe(true);
  });

  it('client_portal_scope is a FOR SELECT policy on sales.accounts whose qual contains platform.is_internal() and platform.current_client_id()', async () => {
    const result: QueryResult<{ polpermissive: boolean; cmd: string; qual: string }> = await pool.query(
      `select polpermissive, polcmd::text as cmd, pg_get_expr(polqual, polrelid) as qual
         from pg_policy
        where polrelid = 'sales.accounts'::regclass and polname = 'client_portal_scope'`,
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    if (!row) throw new Error('unreachable: length checked above');

    expect(row.cmd).toBe('r');
    expect(row.qual).toContain('platform.is_internal()');
    expect(row.qual).toContain('platform.current_client_id()');
  });
});

describe('sales.contacts belong to their account (01 sales.contacts: name, role_type, is_primary; on delete cascade)', () => {
  it("account A's contact is primary (is_primary = true)", async () => {
    const result: QueryResult<{ is_primary: boolean; role_type: string }> = await pool.query(
      `select is_primary, role_type from sales.contacts where account_id = $1`,
      [accountA.id],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.is_primary).toBe(true);
    expect(result.rows[0]?.role_type).toBe('decision_maker');
  });

  it('deleting a throw-away fixture account cascades to delete its contact row (on delete cascade, 01 sales.contacts)', async () => {
    const throwaway = await insertAccount({
      code: fixtureCode('throwaway'),
      nameAr: `حساب مؤقت للحذف ${RUN_SLUG}`,
      crNumber: null,
    });
    const contactId = await insertContact(throwaway.id, {
      name: `Fixture Contact Throwaway ${RUN_SLUG}`,
      roleType: 'technical',
      isPrimary: false,
    });

    const beforeDelete: QueryResult<{ count: string }> = await pool.query(
      `select count(*)::text as count from sales.contacts where id = $1`,
      [contactId],
    );
    expect(beforeDelete.rows[0]?.count).toBe('1');

    await pool.query(`delete from sales.accounts where id = $1`, [throwaway.id]);

    const afterDelete: QueryResult<{ count: string }> = await pool.query(
      `select count(*)::text as count from sales.contacts where id = $1`,
      [contactId],
    );
    expect(afterDelete.rows[0]?.count).toBe('0');
  });
});
