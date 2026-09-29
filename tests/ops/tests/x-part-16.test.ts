// tests/ops/tests/x-part-16.test.ts — X part 16 (pg-tester), RED fix round.
//
// Proves D-198 (أ) against tests/ops/x-part-16.feature: G16/Stryker leaves the local guards
// (CI unset, empty, "false" or "0"), stays in CI (scoped) and deploy (PG_GUARDS_STRICT=1). The
// decision is g16_decide's new `local` output (unit cases in x-part-6's runDecide style); guards-run
// is exercised in a disposable fixture with stub `pnpm` / `psql` first on PATH (no database, no
// Stryker). The lane-guard scenario lives in tests/hooks/run.sh.
//
// One `it` per Gherkin Scenario, titled verbatim with the Scenario title.

import { afterAll, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const G16_SCOPE_LIB = path.join(ROOT, 'scripts', 'lib', 'g16-scope.sh');
const PRE_COMMIT = path.join(ROOT, '.githooks', 'pre-commit');

// ---- named constants (CLAUDE.md: no magic numbers) --------------------------------------------
const EXEC_TIMEOUT_MS = 60_000;
const EXIT_OK = 0;
const EXIT_RED = 1;
const SCORE_PASS = '80';
const SCORE_FAIL = '70';
const BAD_BREAK = 50;
const REQUIRED_BREAK = 75;
const MODULE_A = 'alpha';
const MODULE_B = 'beta';
const TMP_PREFIX = 'x-part-16-';
const SKIP_LINE = 'G16 SKIPPED locally (D-198 (أ): CI gate ⑤ scoped + nightly govern)';
const NOT_CI_VALUES = [undefined, '', 'false', '0'] as const;
const G16_MODULES_VALUES = [undefined, '', 'wms fleet'] as const;

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function mkTmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), TMP_PREFIX));
  tempDirs.push(dir);
  return dir;
}

function writeExec(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

function copyReal(fixture: string, rel: string): void {
  const dest = path.join(fixture, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(path.join(ROOT, rel), dest);
}

// ---- g16_decide (x-part-6 runDecide pattern) ---------------------------------------------------
function runDecide(vars: Record<string, string | undefined>): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['CI', 'G16_MODULES', 'PG_GUARDS_STRICT']) delete env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) env[k] = v;
  return execFileSync('bash', ['-c', 'source "$1"; g16_decide', 'bash', G16_SCOPE_LIB], {
    cwd: ROOT,
    env,
    timeout: EXEC_TIMEOUT_MS,
  })
    .toString()
    .trim();
}

it('g16_decide prints local when CI is unset, empty, "false" or "0" and not strict, whatever G16_MODULES is', () => {
  for (const ci of NOT_CI_VALUES) {
    for (const mods of G16_MODULES_VALUES) {
      expect(runDecide({ CI: ci, G16_MODULES: mods }), `CI=${String(ci)} G16_MODULES=${String(mods)}`).toBe('local');
    }
  }
});

it("g16_decide keeps today's all/scoped rule when CI=true", () => {
  expect(runDecide({ CI: 'true' })).toBe('all');
  expect(runDecide({ CI: 'true', G16_MODULES: '' })).toBe('scoped:');
  expect(runDecide({ CI: 'true', G16_MODULES: 'wms fleet' })).toBe('scoped:wms fleet');
});

it('g16_decide prints all under PG_GUARDS_STRICT=1, CI or not', () => {
  for (const ci of [undefined, 'true']) {
    for (const mods of G16_MODULES_VALUES) {
      expect(runDecide({ CI: ci, G16_MODULES: mods, PG_GUARDS_STRICT: '1' }), `CI=${String(ci)}`).toBe('all');
    }
  }
});

// ---- guards-run fixture ------------------------------------------------------------------------
// Stub pnpm: strips -s; test:isolation prints a vitest marker (exit 1 when STUB_ISOLATION_FAIL);
// mutation records its args and prints a score per module (STUB_SCORE); everything else succeeds.
const PNPM_STUB = `#!/usr/bin/env bash
[ "\${1:-}" = "-s" ] && shift
cmd="\${1:-}"; shift || true
case "$cmd" in
  test:isolation)
    echo "Test Files  1 passed (1)"
    [ -n "\${STUB_ISOLATION_FAIL:-}" ] && exit 1 ;;
  mutation)
    echo "mutation:$*" >> "$STUB_LOG"
    mods=("$@")
    if [ "\${#mods[@]}" -eq 0 ]; then for d in modules/*/; do mods+=("$(basename "$d")"); done; fi
    for m in "\${mods[@]}"; do echo "mutation-all: $m"; echo "Final mutation score: \${STUB_SCORE:-80}"; done ;;
  *) ;;
esac
exit 0
`;

// Stub psql: prints one failing row under a G1 banner when STUB_PSQL_ROWS is set.
const PSQL_STUB = `#!/usr/bin/env bash
cat >/dev/null
if [ -n "\${STUB_PSQL_ROWS:-}" ]; then printf -- '--- G1: fixture ---\\nG1|offending row\\n'; fi
exit 0
`;

interface GuardsFixture {
  root: string;
  log: string;
  binDir: string;
}

function writeStrykerConfig(root: string, mod: string, breakValue: number): void {
  const cfg = path.join(root, 'modules', mod, 'stryker.config.json');
  mkdirSync(path.dirname(cfg), { recursive: true });
  writeFileSync(cfg, JSON.stringify({ thresholds: { break: breakValue }, mutate: ['domain/**/*.ts'] }));
}

function createGuardsFixture(): GuardsFixture {
  const root = mkTmp();
  const binDir = path.join(root, '.stubbin');
  const log = path.join(root, 'stub.log');
  copyReal(root, 'scripts/guards-run.sh');
  copyReal(root, 'scripts/lib/g16-scope.sh');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { mutation: 'stub' } }));
  writeFileSync(path.join(root, 'guards.sql'), '-- no failing rows\n');
  for (const m of [MODULE_A, MODULE_B]) writeStrykerConfig(root, m, REQUIRED_BREAK);
  writeExec(path.join(binDir, 'pnpm'), PNPM_STUB);
  writeExec(path.join(binDir, 'psql'), PSQL_STUB);
  writeFileSync(log, '');
  return { root, log, binDir };
}

function runGuards(fx: GuardsFixture, extra: Record<string, string>) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['CI', 'G16_MODULES', 'PG_GUARDS_STRICT', 'STUB_SCORE', 'STUB_ISOLATION_FAIL', 'STUB_PSQL_ROWS']) delete env[k];
  env['PATH'] = `${fx.binDir}${path.delimiter}${process.env['PATH'] ?? ''}`;
  env['STUB_LOG'] = fx.log;
  env['PG_GUARDS_FILE'] = path.join(fx.root, 'guards.sql');
  return spawnSync('bash', [path.join(fx.root, 'scripts', 'guards-run.sh')], {
    cwd: fx.root,
    env: { ...env, ...extra },
    encoding: 'utf8',
    timeout: EXEC_TIMEOUT_MS,
  });
}

function mutationCalls(fx: GuardsFixture): string[] {
  return readFileSync(fx.log, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('mutation:'));
}

it('Locally, guards-run never invokes the mutation runner, prints G16 SKIPPED locally, and G16 is not NOT RUNNABLE or missing', () => {
  for (const extra of [{}, { G16_MODULES: MODULE_A }, { CI: 'false' }, { CI: '0' }, { CI: '' }]) {
    const fx = createGuardsFixture();
    const r = runGuards(fx, extra);
    const label = JSON.stringify(extra);

    expect(mutationCalls(fx), label).toEqual([]);
    expect(r.stdout, label).toContain(SKIP_LINE);
    expect(r.stdout, label).not.toMatch(/G16.*NOT RUNNABLE/);
    expect(r.stdout, label).not.toMatch(/G16.*missing/i);
    expect(r.status, label).toBe(EXIT_OK);
  }
});

it('Locally, another red guard still makes guards-run exit 1 while G16 is SKIPPED', () => {
  for (const extra of [{ STUB_ISOLATION_FAIL: '1' }, { STUB_PSQL_ROWS: '1' }]) {
    const fx = createGuardsFixture();
    const r = runGuards(fx, extra);
    const label = JSON.stringify(extra);

    expect(r.stdout, label).toContain(SKIP_LINE);
    expect(mutationCalls(fx), label).toEqual([]);
    expect(r.status, label).toBe(EXIT_RED);
  }
});

it('Locally, a stryker config with break != 75 is still reported red', () => {
  const fx = createGuardsFixture();
  writeStrykerConfig(fx.root, MODULE_B, BAD_BREAK);
  const r = runGuards(fx, {});

  expect(r.stdout).toMatch(/G16\s+-\s+RED/);
  expect(r.stdout).toMatch(/thresholds\.break is not 75/);
  expect(mutationCalls(fx)).toEqual([]);
  expect(r.status).toBe(EXIT_RED);
});

it('With CI=true, G16 runs scoped by G16_MODULES and a score below 75 blocks, exactly as before', () => {
  const pass = createGuardsFixture();
  const passRun = runGuards(pass, { CI: 'true', G16_MODULES: MODULE_A, STUB_SCORE: SCORE_PASS });
  expect(mutationCalls(pass)).toEqual([`mutation:${MODULE_A}`]);
  expect(passRun.stdout).not.toMatch(/G16 SKIPPED locally/);
  expect(passRun.status).toBe(EXIT_OK);

  const fail = createGuardsFixture();
  const failRun = runGuards(fail, { CI: 'true', G16_MODULES: MODULE_A, STUB_SCORE: SCORE_FAIL });
  expect(mutationCalls(fail)).toEqual([`mutation:${MODULE_A}`]);
  expect(failRun.stdout).toMatch(/G16\s+-\s+RED/);
  expect(failRun.status).toBe(EXIT_RED);
});

it('.githooks/pre-commit sets none of CI, PG_GUARDS_STRICT or G16_MODULES before calling guards:run', () => {
  const code = readFileSync(PRE_COMMIT, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  expect(code).toMatch(/guards:run/);
  expect(code).not.toMatch(/\b(CI|PG_GUARDS_STRICT|G16_MODULES)=/);
  expect(code).not.toMatch(/\b(export|declare\s+-x|env)\b[^\n]*\b(CI|PG_GUARDS_STRICT|G16_MODULES)\b/);
});
