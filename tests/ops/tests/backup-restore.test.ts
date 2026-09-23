// tests/ops/tests/backup-restore.test.ts — WBS 0.8 (pg-tester).
//
// Proves the executable half of tests/ops/pilot-backup-restore.feature: D-130's pilot acceptance
// for WBS 0.8 (tasks/MASTER_BACKLOG.md row 0.8 and its Phase-gate line) — a real
// `scripts/backup.sh` / `scripts/restore.sh` round trip against the LOCAL Docker postgres:16
// (infra/docker/docker-compose.yml, database `pgeos`), local-file target only (no OCI Object
// Storage — that is WBS 0.5, deferred). Restore target is `pgeos_restore`.
//
// This file does NOT implement backup.sh/restore.sh — those are built by pg-backend/infra,
// against docs/package/42-Oracle-Cloud-Deployment.md §6.2/§6.3 (OCI reference, adapted for the
// local file target per D-130) and the exact guard-function calls verified manually in
// docs/notes/2026-09-23-restore-rehearsal.md.
//
// SKIP, NOT HANG (brief requirement): a `pg_isready` probe in `beforeAll` decides whether the
// local Docker Postgres is reachable at all. If it is not, every test calls vitest's own
// `ctx.skip(reason)` and returns immediately instead of letting `pg_dump`/`pg_restore` hang or
// fail with a confusing connection-refused stack trace deep inside a spawned shell script. No
// console output is used anywhere in this file (CLAUDE.md bans console.* outside pino in
// production code, and this harness follows the same rule) — the skip reason vitest prints in its
// own test-result output is the only signal, and it needs no eslint-disable.
//
// CLEANUP (defensive — the brief requires this to work even if an earlier assertion failed):
// `afterAll` always attempts `dropdb --if-exists pgeos_restore` and deletes the dump file this
// suite itself created, wrapped in try/catch so a failed drop or missing file never throws out of
// the hook and masks the real test failure. The S-0.8-3 test below owns its own throwaway
// "pgeos_locale_bait" database and dump file and cleans both up itself, for the same reason.

import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const execFileAsync = promisify(execFile);

// tests/ops/tests/backup-restore.test.ts -> tests/ops/tests -> tests/ops -> tests -> repo root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const BACKUP_SCRIPT = path.join(ROOT, 'scripts', 'backup.sh');
const RESTORE_SCRIPT = path.join(ROOT, 'scripts', 'restore.sh');
const BACKUPS_DIR = path.join(ROOT, 'data', 'backups');

const PGHOST = process.env['PGHOST'] ?? 'localhost';
const PGPORT = process.env['PGPORT'] ?? '5432';
const PGUSER = process.env['PGUSER'] ?? 'postgres';
const SOURCE_DB = process.env['PGDATABASE'] ?? 'pgeos';
const RESTORE_DB = 'pgeos_restore';

// Throwaway database + dump used only by the S-0.8-3 guard-failure test. Never the real "pgeos"
// or "pgeos_restore" — created, dumped and dropped entirely inside that test's own lifecycle.
const BAIT_DB = 'pgeos_locale_bait';

// ---- Timeouts (CLAUDE.md: no magic numbers) --------------------------------------------------
// Sized for a single quick liveness probe against the local Docker Postgres container, not a
// real query — pg_isready itself has its own internal 5s connect-timeout (the "-t 5" below).
const PG_ISREADY_TIMEOUT_MS = 10_000;
// Sized for `dropdb` of a single database on a local container — normally near-instant, but the
// container can be briefly busy right after a dump/restore.
const DROPDB_TIMEOUT_MS = 30_000;
// Sized for `createdb`/`dropdb`/the final `pg_dump` of the S-0.8-3 bait database (once its
// pg_trgm extension has already been dropped) — small, local operations.
const BAIT_DB_SETUP_TIMEOUT_MS = 30_000;
// Sized for `ALTER`/`DROP EXTENSION pg_trgm CASCADE` on the S-0.8-3 bait database — drops the
// handful of trigram indexes/views that depend on it, still a small local operation.
const EXTENSION_DROP_TIMEOUT_MS = 30_000;
// Sized for a full `pg_dump -Fc` of the seeded pilot "pgeos" database (191 tables incl.
// partitions, docs/notes/2026-09-23-restore-rehearsal.md took several seconds in the manual
// rehearsal; generous headroom for a slower dev machine or CI runner).
const BACKUP_TIMEOUT_MS = 120_000;
// Sized for a full `pg_restore` of that same dump into "pgeos_restore" plus every guard-function
// check restore.sh runs afterwards (wms/billing/platform verify_* + the SCR-TRGM-01 check).
const RESTORE_TIMEOUT_MS = 180_000;

// D-130 / doc 42 §6.3 SCR-TRGM-01: the exact locale query the restore rehearsal (D-115) and the
// OCI reference restore.sh both use, expressed against the RESTORED database.
const LOCALE_TRIGRAM_SQL =
  "select datctype || '|' || datcollate || '|' || (cardinality(show_trgm('مخزن')) > 0) as locale_check " +
  'from pg_database where datname = current_database()';
const EXPECTED_LOCALE_TRIGRAM = 'C.UTF-8|C|true';

// wms.verify_wh1() (database/schema/019-Warehouse-WH1-Setup.sql) is a fixed, named list of 21
// individual WH1 seed-data checks — the count comes from that function's own definition, not
// from this test.
const WMS_WH1_CHECK_COUNT = 21;

let dbReachable = true;
let createdDumpPath: string | null = null;

function connect(database: string): Client {
  return new Client({ host: PGHOST, port: Number(PGPORT), user: PGUSER, database });
}

async function skipIfDbUnreachable(ctx: { skip: (note?: string) => void }): Promise<boolean> {
  if (!dbReachable) {
    ctx.skip(`Postgres at ${PGHOST}:${PGPORT} (db "${SOURCE_DB}") is not reachable`);
    return true;
  }
  return false;
}

beforeAll(async () => {
  try {
    await execFileAsync(
      'pg_isready',
      ['-h', PGHOST, '-p', String(PGPORT), '-U', PGUSER, '-d', SOURCE_DB, '-t', '5'],
      { timeout: PG_ISREADY_TIMEOUT_MS },
    );
  } catch {
    dbReachable = false;
  }
});

afterAll(async () => {
  // Drop the restore target, defensively, even if an earlier assertion threw.
  try {
    execFileSync('dropdb', ['-h', PGHOST, '-p', String(PGPORT), '-U', PGUSER, '--if-exists', RESTORE_DB], {
      stdio: 'pipe',
      timeout: DROPDB_TIMEOUT_MS,
    });
  } catch {
    // best-effort cleanup — nothing more to do if this fails (e.g. dropdb itself missing)
  }
  // Remove only the dump this suite created, never sweep the whole directory.
  if (createdDumpPath && existsSync(createdDumpPath)) {
    try {
      rmSync(createdDumpPath, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('scripts/backup.sh — local file target (D-130 pilot, no OCI)', () => {
  it('dumps the local pgeos database to a new file under data/backups/', async (ctx) => {
    if (await skipIfDbUnreachable(ctx)) return;

    if (!existsSync(BACKUPS_DIR)) {
      mkdirSync(BACKUPS_DIR, { recursive: true });
    }
    const before = new Set(readdirSync(BACKUPS_DIR));

    execFileSync('bash', [BACKUP_SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, PGHOST, PGPORT, PGUSER, PGDATABASE: SOURCE_DB },
      stdio: 'pipe',
      timeout: BACKUP_TIMEOUT_MS,
    });

    const after = readdirSync(BACKUPS_DIR);
    const newFiles = after.filter((f) => !before.has(f));
    expect(newFiles.length).toBeGreaterThan(0);

    const newest = newFiles
      .map((f) => path.join(BACKUPS_DIR, f))
      .filter((p) => statSync(p).isFile())
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    expect(newest).toBeDefined();
    createdDumpPath = newest ?? null;
    expect(createdDumpPath).not.toBeNull();
    if (createdDumpPath) {
      expect(statSync(createdDumpPath).size).toBeGreaterThan(0);
    }
  });
});

describe('scripts/restore.sh — restores into pgeos_restore and every guard passes (D-130 pilot)', () => {
  it('restores the dump and exits 0', async (ctx) => {
    if (await skipIfDbUnreachable(ctx)) return;
    expect(
      createdDumpPath,
      'backup.sh must have produced a dump in the previous describe block before restore.sh can be tested',
    ).not.toBeNull();
    if (!createdDumpPath) return;

    execFileSync('bash', [RESTORE_SCRIPT, createdDumpPath], {
      cwd: ROOT,
      env: { ...process.env, PGHOST, PGPORT, PGUSER },
      stdio: 'pipe',
      timeout: RESTORE_TIMEOUT_MS,
    });
  });

  it('wms.verify_balance_integrity() returns 0 rows on pgeos_restore', async (ctx) => {
    if (await skipIfDbUnreachable(ctx)) return;
    const client = connect(RESTORE_DB);
    await client.connect();
    try {
      const { rows } = await client.query<{ n: number }>('select count(*)::int as n from wms.verify_balance_integrity()');
      expect(rows[0]?.n).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('billing.verify_journal_balance() returns 0 rows on pgeos_restore', async (ctx) => {
    if (await skipIfDbUnreachable(ctx)) return;
    const client = connect(RESTORE_DB);
    await client.connect();
    try {
      const { rows } = await client.query<{ n: number }>('select count(*)::int as n from billing.verify_journal_balance()');
      expect(rows[0]?.n).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('platform.verify_audit_chain() returns 0 rows on pgeos_restore', async (ctx) => {
    if (await skipIfDbUnreachable(ctx)) return;
    const client = connect(RESTORE_DB);
    await client.connect();
    try {
      const { rows } = await client.query<{ n: number }>('select count(*)::int as n from platform.verify_audit_chain()');
      expect(rows[0]?.n).toBe(0);
    } finally {
      await client.end();
    }
  });

  it(`wms.verify_wh1() returns ${WMS_WH1_CHECK_COUNT} rows, all passed = true, on pgeos_restore`, async (ctx) => {
    if (await skipIfDbUnreachable(ctx)) return;
    const client = connect(RESTORE_DB);
    await client.connect();
    try {
      const { rows } = await client.query<{ check_name: string; passed: boolean }>(
        'select check_name, passed from wms.verify_wh1()',
      );
      expect(rows.length).toBe(WMS_WH1_CHECK_COUNT);
      expect(rows.every((r) => r.passed === true)).toBe(true);
    } finally {
      await client.end();
    }
  });

  it('locale/trigram check (SCR-TRGM-01, doc 42 §6.3) passes on pgeos_restore', async (ctx) => {
    if (await skipIfDbUnreachable(ctx)) return;
    const client = connect(RESTORE_DB);
    await client.connect();
    try {
      const { rows } = await client.query<{ locale_check: string }>(LOCALE_TRIGRAM_SQL);
      expect(rows[0]?.locale_check).toBe(EXPECTED_LOCALE_TRIGRAM);
    } finally {
      await client.end();
    }
  });
});

describe('scripts/restore.sh — S-0.8-3: fails loudly on a broken locale/guard dump', () => {
  // Build a real bait dump: a full copy of the actual "pgeos" schema/data (so every
  // wms/billing/platform verify_* function genuinely exists and genuinely passes) with its
  // pg_trgm extension dropped afterwards. restore.sh always (re)creates "pgeos_restore" itself
  // with the correct fixed locale flags, so the only way to make its SCR-TRGM-01 guard fail for
  // real is for the restored data itself to be missing what that check depends on — exactly what
  // a from-a-wrong-locale-source dump (no pg_trgm) looks like once restored. This is the real
  // S-0.8-3 failure path — not a synthetic one — exercised against the exact same restore.sh this
  // suite already proved passes on a good dump, and it proves the OTHER guards still pass while
  // only the locale/trigram guard fails, so the failure is specific, not a generic crash.
  it(
    'exits non-zero and reports the SCR-TRGM-01 guard failure, not success, on a bait dump',
    async (ctx) => {
      if (await skipIfDbUnreachable(ctx)) return;

      const tmpDir = mkdtempSync(path.join(tmpdir(), 'pgeos-locale-bait-'));
      const sourceDumpPath = path.join(tmpDir, 'source.dump');
      const baitDumpPath = path.join(tmpDir, 'bait.dump');
      let baitDbCreated = false;

      try {
        // 1. Dump the real, working "pgeos" schema/data — never mutate the source database.
        execFileSync(
          'pg_dump',
          ['-h', PGHOST, '-p', String(PGPORT), '-U', PGUSER, '-d', SOURCE_DB, '-Fc', '-f', sourceDumpPath],
          { stdio: 'pipe', timeout: BACKUP_TIMEOUT_MS },
        );

        // 2. Restore it into a throwaway database — never pgeos or pgeos_restore.
        execFileSync(
          'dropdb',
          ['-h', PGHOST, '-p', String(PGPORT), '-U', PGUSER, '--if-exists', BAIT_DB],
          { stdio: 'pipe', timeout: DROPDB_TIMEOUT_MS },
        );
        execFileSync(
          'createdb',
          [
            '-h', PGHOST, '-p', String(PGPORT), '-U', PGUSER,
            '-T', 'template0', '-E', 'UTF8', '--lc-collate=C', '--lc-ctype=C.UTF-8', BAIT_DB,
          ],
          { stdio: 'pipe', timeout: BAIT_DB_SETUP_TIMEOUT_MS },
        );
        baitDbCreated = true;
        execFileSync(
          'pg_restore',
          ['-h', PGHOST, '-p', String(PGPORT), '-U', PGUSER, '-d', BAIT_DB, '--no-owner', '--no-privileges', sourceDumpPath],
          { stdio: 'pipe', timeout: RESTORE_TIMEOUT_MS },
        );

        // 3. Break exactly the thing SCR-TRGM-01 checks — drop pg_trgm — nothing else.
        execFileSync(
          'psql',
          ['-h', PGHOST, '-p', String(PGPORT), '-U', PGUSER, '-d', BAIT_DB, '-Atqc', 'drop extension pg_trgm cascade'],
          { stdio: 'pipe', timeout: EXTENSION_DROP_TIMEOUT_MS },
        );

        // 4. Dump the now-broken bait database — this is what gets handed to restore.sh.
        execFileSync(
          'pg_dump',
          ['-h', PGHOST, '-p', String(PGPORT), '-U', PGUSER, '-d', BAIT_DB, '-Fc', '-f', baitDumpPath],
          { stdio: 'pipe', timeout: BAIT_DB_SETUP_TIMEOUT_MS },
        );
        expect(existsSync(baitDumpPath)).toBe(true);

        let exitCode: number | null = null;
        let combinedOutput = '';
        try {
          execFileSync('bash', [RESTORE_SCRIPT, baitDumpPath], {
            cwd: ROOT,
            env: { ...process.env, PGHOST, PGPORT, PGUSER },
            stdio: 'pipe',
            timeout: RESTORE_TIMEOUT_MS,
          });
          exitCode = 0;
        } catch (err) {
          const e = err as { status?: number | null; stdout?: Buffer | string; stderr?: Buffer | string };
          exitCode = e.status ?? 1;
          combinedOutput = `${String(e.stdout ?? '')}${String(e.stderr ?? '')}`;
        }

        expect(exitCode).not.toBe(0);
        expect(exitCode).not.toBeNull();
        // The failure must be the SCR-TRGM-01 guard check reporting FAILED, not restore.sh's
        // usage error (exit 2 for a missing/bad dump path — this dump path is real and valid)
        // and not an unrelated crash. restore.sh's own success line must never appear.
        expect(exitCode).not.toBe(2);
        // Match restore.sh's exact printed line (scripts/restore.sh) so a FAILED line for some
        // other guard, plus an unrelated summary "one or more checks FAILED", cannot satisfy
        // this assertion — it must be the SCR-TRGM-01 check itself that failed.
        expect(combinedOutput).toContain('FAILED — SCR-TRGM-01');
        expect(combinedOutput).not.toContain('OK — SCR-TRGM-01');
        expect(combinedOutput).not.toContain('restore.sh: all checks passed');
        // Proves the failure is specific to the locale/trigram guard, not a generic crash: the
        // other three guard functions genuinely exist (restored from the real pgeos schema) and
        // genuinely pass against the bait data.
        expect(combinedOutput).toContain('OK — wms.verify_balance_integrity()');
        expect(combinedOutput).toContain('OK — billing.verify_journal_balance()');
        expect(combinedOutput).toContain('OK — platform.verify_audit_chain()');
      } finally {
        if (baitDbCreated) {
          try {
            execFileSync(
              'dropdb',
              ['-h', PGHOST, '-p', String(PGPORT), '-U', PGUSER, '--if-exists', BAIT_DB],
              { stdio: 'pipe', timeout: DROPDB_TIMEOUT_MS },
            );
          } catch {
            // best-effort cleanup
          }
        }
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
        // restore.sh recreates pgeos_restore against the bait dump too — leave its final
        // cleanup to this file's own afterAll (dropdb --if-exists pgeos_restore), which always
        // runs.
      }
    },
    RESTORE_TIMEOUT_MS + BACKUP_TIMEOUT_MS,
  );
});
