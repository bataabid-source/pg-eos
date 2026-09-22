// WBS 0.16 (pg-tester). Doc-38 acceptance criterion (verbatim): "Unclassified column fails
// deploy and G6 returns 0 on the applied schema; every later migration classifies its own
// columns (review point 4)." This file proves both halves against a live Postgres instance:
//   (1) SQL half — identity.column_classification covers every column G6 checks (guards.sql,
//       database/schema/guards.sql lines 59-72), and the classification is a sane rule-based
//       categorization, not a trivial "everything is public" dump — AND the guard genuinely
//       detects a gap when one is introduced.
//   (2) shell half — scripts/guards-run.sh and database/schema/apply.sh no longer special-case
//       G6 as non-blocking (WARNING/"مهمة WBS 0.16" carve-outs removed; pg-backend's job).
//
// RED at the time this file is written: identity.column_classification is empty (0 rows) —
// confirmed live: `select count(*) from identity.column_classification` => 0. The G6 completeness
// query (guards.sql lines 64-72) confirmed live: 2605. Neither database/schema/apply.sh nor
// scripts/guards-run.sh has had its G6 non-blocking special-case removed yet — confirmed live by
// reading both files (scripts/guards-run.sh lines 11-12, 71-73; database/schema/apply.sh lines
// 179, 199-201). This is genuine RED against an already-existing table/view, not a
// module-not-found RED — see database/schema/01-Data-Model.sql:289-295 (frozen DDL, already
// applied) and database/schema/guards.sql:59-72 (frozen G6 query, already applied).
//
// Connects to the already-running dev database (infra/docker/docker-compose.yml, `postgres`
// service) via PG* env vars, defaulting to the documented local values — same convention as
// modules/platform/tests/integration/thresholds-live-read.test.ts (WBS 0.10).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

afterAll(async () => {
  await pool.end();
});

// The 14 schemas G6 checks — copied verbatim from database/schema/guards.sql lines 66-67 (the
// frozen, already-applied guard query). Never invented; this is the guard's own schema list.
const G6_SCHEMAS = [
  'platform',
  'identity',
  'catalog',
  'sales',
  'wms',
  'tms',
  'cc',
  'billing',
  'hr',
  'partners',
  'admin',
  'housing',
  'imile',
  'governance',
];

// G6's exact completeness query (database/schema/guards.sql lines 64-72, frozen/already applied):
// every column in the 14 named schemas must have a matching row in identity.column_classification.
const G6_QUERY = `
  select c.table_schema, c.table_name, c.column_name
  from information_schema.columns c
  where c.table_schema = any($1::text[])
    and not exists (
      select 1 from identity.column_classification k
      where k.schema_name = c.table_schema
        and k.table_name  = c.table_name
        and k.column_name = c.column_name
    )
  order by 1, 2, 3;
`;

interface UnclassifiedRow {
  table_schema: string;
  table_name: string;
  column_name: string;
}

interface ClassificationRow {
  schema_name: string;
  table_name: string;
  column_name: string;
  sensitivity: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Repo-root resolution for the shell-script text assertions (#4) — walks up from this test
// file's own directory (via import.meta.url, not process.cwd(), so it is stable regardless of
// which directory vitest is invoked from) until it finds both scripts/guards-run.sh and
// database/schema/apply.sh, which only coexist at the repo root.
// ─────────────────────────────────────────────────────────────────────────
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    if (
      existsSync(join(dir, 'scripts', 'guards-run.sh')) &&
      existsSync(join(dir, 'database', 'schema', 'apply.sh'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `could not locate repo root (scripts/guards-run.sh + database/schema/apply.sh) walking up from ${startDir}`,
  );
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = findRepoRoot(HERE);

describe('identity.column_classification — G6 completeness (WBS 0.16 acceptance, half 1: "G6 returns 0")', () => {
  it('every column in the 14 G6 schemas has a matching identity.column_classification row (G6 returns 0 rows)', async () => {
    const result: QueryResult<UnclassifiedRow> = await pool.query(G6_QUERY, [G6_SCHEMAS]);
    expect(
      result.rows,
      `expected 0 unclassified columns; got ${result.rows.length}. First few: ${JSON.stringify(
        result.rows.slice(0, 5),
      )}`,
    ).toHaveLength(0);
  });
});

describe('identity.column_classification — classification correctness spot-checks (not a trivial all-public dump)', () => {
  it('a discovered payroll-looking column (hr, name matches salary|commission|deduction|bonus|allowance|overtime|gratuity|payroll) is classified as something other than public', async () => {
    const discovery: QueryResult<{ table_schema: string; table_name: string; column_name: string }> =
      await pool.query(
        `select table_schema, table_name, column_name from information_schema.columns
         where table_schema = any($1::text[])
           and column_name ~* $2
         order by table_schema, table_name, column_name limit 1`,
        [G6_SCHEMAS, 'salary|commission|deduction|bonus|allowance|overtime|gratuity|payroll'],
      );
    const candidate = discovery.rows[0];
    expect(candidate, 'expected to discover at least one payroll-looking column via live pattern search — none found').toBeDefined();
    if (!candidate) throw new Error('unreachable');

    const classified: QueryResult<ClassificationRow> = await pool.query(
      `select schema_name, table_name, column_name, sensitivity from identity.column_classification
       where schema_name = $1 and table_name = $2 and column_name = $3`,
      [candidate.table_schema, candidate.table_name, candidate.column_name],
    );
    const row = classified.rows[0];
    expect(
      row,
      `expected a classification row for ${candidate.table_schema}.${candidate.table_name}.${candidate.column_name} — none found (identity.column_classification is empty)`,
    ).toBeDefined();
    if (!row) throw new Error('unreachable');
    expect(row.sensitivity).not.toBe('public');
  });

  it('a discovered personal-PII-looking column (name matches national_id|passport_no|date_of_birth|nationality|phone|email) is classified as something other than public', async () => {
    const discovery: QueryResult<{ table_schema: string; table_name: string; column_name: string }> =
      await pool.query(
        `select table_schema, table_name, column_name from information_schema.columns
         where table_schema = any($1::text[])
           and column_name ~* $2
         order by table_schema, table_name, column_name limit 1`,
        [G6_SCHEMAS, 'national_id|passport_no|date_of_birth|nationality|phone|email'],
      );
    const candidate = discovery.rows[0];
    expect(candidate, 'expected to discover at least one personal-PII-looking column via live pattern search — none found').toBeDefined();
    if (!candidate) throw new Error('unreachable');

    const classified: QueryResult<ClassificationRow> = await pool.query(
      `select schema_name, table_name, column_name, sensitivity from identity.column_classification
       where schema_name = $1 and table_name = $2 and column_name = $3`,
      [candidate.table_schema, candidate.table_name, candidate.column_name],
    );
    const row = classified.rows[0];
    expect(
      row,
      `expected a classification row for ${candidate.table_schema}.${candidate.table_name}.${candidate.column_name} — none found (identity.column_classification is empty)`,
    ).toBeDefined();
    if (!row) throw new Error('unreachable');
    expect(row.sensitivity).not.toBe('public');
  });

  it('a discovered commercial-pricing-looking column (name matches price|discount|credit_limit|margin|invoice_amount|fee) is classified as something other than public', async () => {
    const discovery: QueryResult<{ table_schema: string; table_name: string; column_name: string }> =
      await pool.query(
        `select table_schema, table_name, column_name from information_schema.columns
         where table_schema = any($1::text[])
           and column_name ~* $2
         order by table_schema, table_name, column_name limit 1`,
        [G6_SCHEMAS, 'price|discount|credit_limit|margin|invoice_amount|fee'],
      );
    const candidate = discovery.rows[0];
    expect(candidate, 'expected to discover at least one commercial-pricing-looking column via live pattern search — none found').toBeDefined();
    if (!candidate) throw new Error('unreachable');

    const classified: QueryResult<ClassificationRow> = await pool.query(
      `select schema_name, table_name, column_name, sensitivity from identity.column_classification
       where schema_name = $1 and table_name = $2 and column_name = $3`,
      [candidate.table_schema, candidate.table_name, candidate.column_name],
    );
    const row = classified.rows[0];
    expect(
      row,
      `expected a classification row for ${candidate.table_schema}.${candidate.table_name}.${candidate.column_name} — none found (identity.column_classification is empty)`,
    ).toBeDefined();
    if (!row) throw new Error('unreachable');
    expect(row.sensitivity).not.toBe('public');
  });

  it('a discovered structural primary-key "id" column is classified as public (classifier is not over-classifying everything as sensitive)', async () => {
    const discovery: QueryResult<{ table_schema: string; table_name: string; column_name: string }> =
      await pool.query(
        `select table_schema, table_name, column_name from information_schema.columns
         where table_schema = any($1::text[]) and column_name = 'id'
         order by table_schema, table_name limit 1`,
        [G6_SCHEMAS],
      );
    const candidate = discovery.rows[0];
    expect(candidate, 'expected to discover at least one "id" column — none found').toBeDefined();
    if (!candidate) throw new Error('unreachable');

    const classified: QueryResult<ClassificationRow> = await pool.query(
      `select schema_name, table_name, column_name, sensitivity from identity.column_classification
       where schema_name = $1 and table_name = $2 and column_name = $3`,
      [candidate.table_schema, candidate.table_name, candidate.column_name],
    );
    const row = classified.rows[0];
    expect(
      row,
      `expected a classification row for ${candidate.table_schema}.${candidate.table_name}.${candidate.column_name} — none found (identity.column_classification is empty)`,
    ).toBeDefined();
    if (!row) throw new Error('unreachable');
    expect(row.sensitivity).toBe('public');
  });

  it('a discovered "created_at" column is classified as public (structural/timestamp columns are not over-classified)', async () => {
    const discovery: QueryResult<{ table_schema: string; table_name: string; column_name: string }> =
      await pool.query(
        `select table_schema, table_name, column_name from information_schema.columns
         where table_schema = any($1::text[]) and column_name = 'created_at'
         order by table_schema, table_name limit 1`,
        [G6_SCHEMAS],
      );
    const candidate = discovery.rows[0];
    expect(candidate, 'expected to discover at least one "created_at" column — none found').toBeDefined();
    if (!candidate) throw new Error('unreachable');

    const classified: QueryResult<ClassificationRow> = await pool.query(
      `select schema_name, table_name, column_name, sensitivity from identity.column_classification
       where schema_name = $1 and table_name = $2 and column_name = $3`,
      [candidate.table_schema, candidate.table_name, candidate.column_name],
    );
    const row = classified.rows[0];
    expect(
      row,
      `expected a classification row for ${candidate.table_schema}.${candidate.table_name}.${candidate.column_name} — none found (identity.column_classification is empty)`,
    ).toBeDefined();
    if (!row) throw new Error('unreachable');
    expect(row.sensitivity).toBe('public');
  });
});

describe('identity.column_classification — the guard genuinely detects a gap (destructive-but-reversible proof)', () => {
  it('deleting one real classification row makes the G6 completeness query return exactly that 1 row, then restores it', async () => {
    // Pick any one real, already-classified row to use as the destructive-but-reversible probe.
    const anyClassified: QueryResult<ClassificationRow> = await pool.query(
      `select schema_name, table_name, column_name, sensitivity from identity.column_classification limit 1`,
    );
    const victim = anyClassified.rows[0];
    if (!victim) {
      throw new Error(
        'identity.column_classification is empty — expected at least one classified column to test guard enforcement against (WBS 0.16 migration not yet applied). This is the expected RED failure reason for this test today.',
      );
    }

    try {
      await pool.query(
        `delete from identity.column_classification
         where schema_name = $1 and table_name = $2 and column_name = $3`,
        [victim.schema_name, victim.table_name, victim.column_name],
      );

      const afterDelete: QueryResult<UnclassifiedRow> = await pool.query(G6_QUERY, [G6_SCHEMAS]);
      expect(
        afterDelete.rows,
        `expected exactly 1 unclassified column (the one just deleted: ${victim.schema_name}.${victim.table_name}.${victim.column_name}) after deletion; got ${afterDelete.rows.length}`,
      ).toHaveLength(1);
      const [onlyRow] = afterDelete.rows;
      expect(onlyRow).toBeDefined();
      expect(onlyRow?.table_schema).toBe(victim.schema_name);
      expect(onlyRow?.table_name).toBe(victim.table_name);
      expect(onlyRow?.column_name).toBe(victim.column_name);
    } finally {
      // Restore the exact row deleted, regardless of assertion outcome — this test may not
      // permanently leave the database in an unclassified state.
      await pool.query(
        `insert into identity.column_classification (schema_name, table_name, column_name, sensitivity)
         values ($1, $2, $3, $4)
         on conflict (schema_name, table_name, column_name) do update set sensitivity = excluded.sensitivity`,
        [victim.schema_name, victim.table_name, victim.column_name, victim.sensitivity],
      );
    }

    // Confirm the restore actually took.
    const restored: QueryResult<ClassificationRow> = await pool.query(
      `select schema_name, table_name, column_name, sensitivity from identity.column_classification
       where schema_name = $1 and table_name = $2 and column_name = $3`,
      [victim.schema_name, victim.table_name, victim.column_name],
    );
    expect(restored.rows[0]?.sensitivity).toBe(victim.sensitivity);
  });
});

describe('scripts/guards-run.sh and database/schema/apply.sh — G6 no longer special-cased as non-blocking (WBS 0.16 acceptance, half 2: "fails deploy")', () => {
  it('scripts/guards-run.sh no longer contains the "G6 is non-blocking until WBS 0.16" special-case text', () => {
    const scriptPath = join(REPO_ROOT, 'scripts', 'guards-run.sh');
    const content = readFileSync(scriptPath, 'utf8');

    const markers = ['non-blocking until WBS 0.16', 'WARNING — unclassified columns'];
    const found = markers.filter((m) => content.includes(m));
    expect(
      found,
      `expected none of these G6-non-blocking markers to remain in scripts/guards-run.sh, but found: ${JSON.stringify(found)}`,
    ).toHaveLength(0);
  });

  it('database/schema/apply.sh no longer contains the equivalent "G6 non-blocking" special-case text in its inline guard-summary loop', () => {
    const scriptPath = join(REPO_ROOT, 'database', 'schema', 'apply.sh');
    const content = readFileSync(scriptPath, 'utf8');

    // apply.sh's inline guard loop currently groups G6 with G18 into the same "non-blocking"
    // elif branch (`"$name" == "G6" || "$name" == "G18"`) and prints the Arabic marker
    // 'مهمة WBS 0.16' ("WBS 0.16 task") for G6 specifically. Both must be gone once G6 is a
    // normal blocking guard like G1-G5/G7-G13.
    const markers = ['"$name" == "G6" || "$name" == "G18"', 'مهمة WBS 0.16'];
    const found = markers.filter((m) => content.includes(m));
    expect(
      found,
      `expected none of these G6-non-blocking markers to remain in database/schema/apply.sh, but found: ${JSON.stringify(found)}`,
    ).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// pg-reviewer round 2, finding 9a: the "unclassified column fails deploy" half of the doc-38
// acceptance criterion was previously proven only by reading scripts/guards-run.sh's source text
// (the describe block above). That proves the non-blocking special-case text is gone, but never
// proves the script actually exits non-zero when G6 is genuinely red. This test closes that gap
// by spawning the real script as a subprocess against a deliberately-broken database state.
// ─────────────────────────────────────────────────────────────────────────
const PG_SUBPROCESS_ENV = {
  ...process.env,
  PGHOST: process.env['PGHOST'] ?? 'localhost',
  PGPORT: process.env['PGPORT'] ?? '5432',
  PGUSER: process.env['PGUSER'] ?? 'postgres',
  PGDATABASE: process.env['PGDATABASE'] ?? 'pgeos',
};

describe('scripts/guards-run.sh — real subprocess genuinely blocks deploy on an unclassified column (WBS 0.16 acceptance, finding 9a)', () => {
  it(
    'deleting one real classification row (making G6 genuinely non-zero) and spawning scripts/guards-run.sh exits with code 1, then restores the row',
    async () => {
      const anyClassified: QueryResult<ClassificationRow> = await pool.query(
        `select schema_name, table_name, column_name, sensitivity from identity.column_classification limit 1`,
      );
      const victim = anyClassified.rows[0];
      expect(
        victim,
        'expected at least one classified row to use as the destructive-but-reversible probe — identity.column_classification is empty',
      ).toBeDefined();
      if (!victim) throw new Error('unreachable');

      try {
        await pool.query(
          `delete from identity.column_classification
           where schema_name = $1 and table_name = $2 and column_name = $3`,
          [victim.schema_name, victim.table_name, victim.column_name],
        );

        const scriptPath = join(REPO_ROOT, 'scripts', 'guards-run.sh');
        const result = spawnSync('bash', [scriptPath], {
          env: PG_SUBPROCESS_ENV,
          encoding: 'utf8',
          timeout: 60_000,
        });

        expect(
          result.status,
          `expected scripts/guards-run.sh to exit with code 1 (blocking) while ${victim.schema_name}.${victim.table_name}.${victim.column_name} is deleted from identity.column_classification; got exit code ${String(
            result.status,
          )}, signal ${String(result.signal)}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        ).toBe(1);
      } finally {
        // Restore the exact row deleted, regardless of assertion outcome — this test must not
        // permanently leave the database in an unclassified state.
        await pool.query(
          `insert into identity.column_classification (schema_name, table_name, column_name, sensitivity)
           values ($1, $2, $3, $4)
           on conflict (schema_name, table_name, column_name) do update set sensitivity = excluded.sensitivity`,
          [victim.schema_name, victim.table_name, victim.column_name, victim.sensitivity],
        );
      }

      const restored: QueryResult<ClassificationRow> = await pool.query(
        `select schema_name, table_name, column_name, sensitivity from identity.column_classification
         where schema_name = $1 and table_name = $2 and column_name = $3`,
        [victim.schema_name, victim.table_name, victim.column_name],
      );
      expect(restored.rows[0]?.sensitivity).toBe(victim.sensitivity);
    },
    60_000,
  );
});

// ─────────────────────────────────────────────────────────────────────────
// pg-reviewer round 2, finding 9b: the spot-check tests above use live pattern-discovery with
// `limit 1`, so they never pin a SPECIFIC column and would keep passing even if a later edit
// accidentally reclassified a genuinely important column back to `public`. This hardcoded
// allow-list — named explicitly by pg-reviewer — proves pg-backend's parallel round-2 fix landed
// AND guards against future regression of these specific, real columns.
// ─────────────────────────────────────────────────────────────────────────
describe('identity.column_classification — hardcoded regression guard for named columns (WBS 0.16 finding 9b)', () => {
  const NAMED_COLUMNS: ReadonlyArray<{ schema: string; table: string; column: string }> = [
    { schema: 'partners', table: 'partners', column: 'bank_iban' },
    { schema: 'billing', table: 'invoices', column: 'total' },
    { schema: 'hr', table: 'employees', column: 'name_ar' },
    { schema: 'hr', table: 'employee_documents', column: 'doc_no' },
  ];

  it.each(NAMED_COLUMNS)(
    '$schema.$table.$column is classified as something other than the insensitive default "public"',
    async ({ schema, table, column }) => {
      const result: QueryResult<ClassificationRow> = await pool.query(
        `select schema_name, table_name, column_name, sensitivity from identity.column_classification
         where schema_name = $1 and table_name = $2 and column_name = $3`,
        [schema, table, column],
      );
      const row = result.rows[0];
      expect(
        row,
        `expected identity.column_classification to contain a row for ${schema}.${table}.${column} — no such row exists yet (pg-backend's classification-rule fix for this column has not landed)`,
      ).toBeDefined();
      if (!row) throw new Error('unreachable');
      expect(
        row.sensitivity,
        `expected ${schema}.${table}.${column} to be classified as something other than the insensitive default "public" — it is still classified "public" (pg-backend's classification-rule fix for this column has not landed)`,
      ).not.toBe('public');
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────
// pg-reviewer round 2, finding 8's cheap substitute: identity.column_classification.sensitivity
// has no database-level CHECK constraint (the table is frozen DDL — 01-Data-Model.sql:289-295 —
// and cannot be altered here). This proves the migration's regex `case` expression never produces
// a typo'd or invented sensitivity value outside the five doc-40-documented categories.
// ─────────────────────────────────────────────────────────────────────────
describe('identity.column_classification — sensitivity values are exactly the 5 doc-40-documented categories (finding 8 cheap substitute)', () => {
  it('select distinct sensitivity from identity.column_classification is a subset of {public, personal, payroll, commercial, secret}', async () => {
    const ALLOWED = new Set(['public', 'personal', 'payroll', 'commercial', 'secret']);
    const result: QueryResult<{ sensitivity: string }> = await pool.query(
      `select distinct sensitivity from identity.column_classification order by 1`,
    );
    const found = result.rows.map((r) => r.sensitivity);
    const invalid = found.filter((s) => !ALLOWED.has(s));
    expect(
      invalid,
      `expected every distinct sensitivity value to be one of ${JSON.stringify(
        Array.from(ALLOWED),
      )}; found invalid/invented value(s): ${JSON.stringify(invalid)}. All distinct values present: ${JSON.stringify(found)}`,
    ).toHaveLength(0);
  });
});
