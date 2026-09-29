// tests/ops/tests/x-part-16.test.ts — X part 16 (pg-tester).
//
// Proves D-198 (أ) against tests/ops/x-part-16.feature: G16/Stryker leaves the local guards
// (CI unset), stays in CI (scoped) and deploy (PG_GUARDS_STRICT=1), and lane-guard.sh's lane-M
// `tooling` case covers .githooks/*. Hermetic: every scenario copies the real scripts into a
// disposable fixture under os.tmpdir() and puts stub `pnpm` / `psql` executables first on PATH;
// there is no database and no Stryker. The stub pnpm records every `mutation` call in a log file and
// prints one "Final mutation score" line per module (the score comes from STUB_SCORE).
//
// One `it` per Gherkin Scenario, titled verbatim with the Scenario title.

import { afterAll, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

// ---- named constants (CLAUDE.md: no magic numbers) --------------------------------------------
const EXEC_TIMEOUT_MS = 60_000;
const EXIT_OK = 0;
const EXIT_RED = 1;
const EXIT_LANE_BLOCK = 2;
const SCORE_PASS = '80';
const SCORE_FAIL = '70';
const MODULE_A = 'alpha';
const MODULE_B = 'beta';
const TMP_PREFIX = 'x-part-16-';
const LANE_MODULE = 'M';
const LANE_OTHER = 'A';
const SKIP_LINE = 'G16 SKIPPED locally (D-198 (أ): CI gate ⑤ scoped + nightly govern)';
const GIT_EMAIL = 'pg-tester@example.com';
const GIT_NAME = 'pg-tester';

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

// Stub pnpm: strips -s; test:isolation prints a vitest marker; mutation records its args and prints a
// score per module (args, or every modules/*/ when none); guards:run runs the fixture's guards-run.sh
// with the inherited environment and records the three G16 switches it was called with; anything
// else (lint, typecheck ...) succeeds.
const PNPM_STUB = `#!/usr/bin/env bash
[ "\${1:-}" = "-s" ] && shift
cmd="\${1:-}"; shift || true
case "$cmd" in
  test:isolation) echo "Test Files  1 passed (1)" ;;
  mutation)
    echo "mutation:$*" >> "$STUB_LOG"
    mods=("$@")
    if [ "\${#mods[@]}" -eq 0 ]; then for d in modules/*/; do mods+=("$(basename "$d")"); done; fi
    for m in "\${mods[@]}"; do echo "mutation-all: $m"; echo "Final mutation score: \${STUB_SCORE:-80}"; done ;;
  guards:run)
    echo "guards-env:CI=\${CI-<unset>} G16_LOCAL=\${G16_LOCAL-<unset>} PG_GUARDS_STRICT=\${PG_GUARDS_STRICT-<unset>}" >> "$STUB_LOG"
    bash "$FIXTURE_ROOT/scripts/guards-run.sh" ;;
  *) ;;
esac
exit 0
`;

const PSQL_STUB = `#!/usr/bin/env bash
exit 0
`;

interface GuardsFixture {
  root: string;
  log: string;
  binDir: string;
}

function createGuardsFixture(): GuardsFixture {
  const root = mkTmp();
  const binDir = path.join(root, '.stubbin');
  const log = path.join(root, 'stub.log');
  copyReal(root, 'scripts/guards-run.sh');
  copyReal(root, 'scripts/lib/g16-scope.sh');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { mutation: 'stub' } }));
  writeFileSync(path.join(root, 'guards.sql'), '-- no failing rows\n');
  for (const m of [MODULE_A, MODULE_B]) {
    const cfg = path.join(root, 'modules', m, 'stryker.config.json');
    mkdirSync(path.dirname(cfg), { recursive: true });
    writeFileSync(cfg, JSON.stringify({ thresholds: { break: 75 }, mutate: ['domain/**/*.ts'] }));
  }
  writeExec(path.join(binDir, 'pnpm'), PNPM_STUB);
  writeExec(path.join(binDir, 'psql'), PSQL_STUB);
  writeFileSync(log, '');
  return { root, log, binDir };
}

function baseEnv(fx: GuardsFixture, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['CI', 'G16_LOCAL', 'G16_MODULES', 'PG_GUARDS_STRICT', 'STUB_SCORE']) delete env[k];
  env['PATH'] = `${fx.binDir}${path.delimiter}${process.env['PATH'] ?? ''}`;
  env['STUB_LOG'] = fx.log;
  env['FIXTURE_ROOT'] = fx.root;
  env['PG_GUARDS_FILE'] = path.join(fx.root, 'guards.sql');
  return { ...env, ...extra };
}

function runGuards(fx: GuardsFixture, extra: Record<string, string>) {
  return spawnSync('bash', [path.join(fx.root, 'scripts', 'guards-run.sh')], {
    cwd: fx.root,
    env: baseEnv(fx, extra),
    encoding: 'utf8',
    timeout: EXEC_TIMEOUT_MS,
  });
}

function mutationCalls(fx: GuardsFixture): string[] {
  return readFileSync(fx.log, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('mutation:'));
}

it('With CI unset, guards-run does not invoke the mutation runner and reports G16 SKIPPED locally, non-blocking', () => {
  const fx = createGuardsFixture();
  const r = runGuards(fx, {});

  expect(mutationCalls(fx)).toEqual([]);
  expect(r.stdout).toMatch(/G16 SKIPPED locally/);
  expect(r.stdout).toContain(SKIP_LINE);
  expect(r.status).toBe(EXIT_OK);
});

it('With CI unset and G16_LOCAL=1, guards-run runs G16 as before (scoped by G16_MODULES)', () => {
  const fx = createGuardsFixture();
  const r = runGuards(fx, { G16_LOCAL: '1', G16_MODULES: MODULE_A });

  expect(mutationCalls(fx)).toEqual([`mutation:${MODULE_A}`]);
  expect(r.stdout).not.toMatch(/G16 SKIPPED locally/);
  expect(r.status).toBe(EXIT_OK);
});

it('With CI=true, guards-run runs G16 scoped by G16_MODULES exactly as before (75 % break blocks)', () => {
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

it('With PG_GUARDS_STRICT=1, G16 always runs over every module, CI or not', () => {
  const fx = createGuardsFixture();
  const r = runGuards(fx, { PG_GUARDS_STRICT: '1', G16_MODULES: MODULE_A });

  // one call, no module argument = every module, despite the scoped G16_MODULES and CI unset
  expect(mutationCalls(fx)).toEqual(['mutation:']);
  expect(r.stdout).not.toMatch(/G16 SKIPPED locally/);
});

// Approach chosen: end to end. A disposable git repo carries the real .githooks/pre-commit with a
// file under database/ staged; the stub pnpm routes `guards:run` to the fixture's copy of the real
// guards-run.sh. The log then proves both that the hook passes no CI/G16_LOCAL/PG_GUARDS_STRICT and
// that no mutation run happens.
it('The pre-commit hook no longer triggers Stryker when database/ is staged locally', () => {
  const fx = createGuardsFixture();
  copyReal(fx.root, '.githooks/pre-commit');
  const git = (args: string[]) =>
    execFileSync('git', ['-c', `user.email=${GIT_EMAIL}`, '-c', `user.name=${GIT_NAME}`, ...args], {
      cwd: fx.root,
      timeout: EXEC_TIMEOUT_MS,
    });
  git(['init', '--quiet', '-b', 'main']);
  const staged = path.join(fx.root, 'database', 'migrations', '0001_x.sql');
  mkdirSync(path.dirname(staged), { recursive: true });
  writeFileSync(staged, 'select 1;\n');
  git(['add', 'database/migrations/0001_x.sql']);

  const r = spawnSync('bash', [path.join(fx.root, '.githooks', 'pre-commit')], {
    cwd: fx.root,
    env: baseEnv(fx, {}),
    encoding: 'utf8',
    timeout: EXEC_TIMEOUT_MS,
  });

  const log = readFileSync(fx.log, 'utf8');
  expect(log).toContain('guards-env:CI=<unset> G16_LOCAL=<unset> PG_GUARDS_STRICT=<unset>');
  expect(mutationCalls(fx)).toEqual([]);
  expect(r.status).toBe(EXIT_OK);
});

function runLaneGuard(lane: string, filePath: (root: string) => string): number | null {
  const parent = mkTmp();
  const root = path.join(parent, `pg-eos-lane-${lane}`);
  mkdirSync(path.join(root, 'tasks'), { recursive: true });
  writeFileSync(
    path.join(root, 'tasks', 'LANE_LOCKS.md'),
    [
      '| module | lane | note |',
      '|---|---|---|',
      '| `tooling` | M | X |',
      '| `wms` | A | fixture |',
      '',
    ].join('\n'),
  );
  const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: filePath(root) } });
  const env: NodeJS.ProcessEnv = { ...process.env, PG_LANE: lane, CLAUDE_PROJECT_DIR: root };
  delete env['CLAUDE_CODE_REMOTE'];
  const r = spawnSync('bash', [path.join(ROOT, '.claude', 'hooks', 'lane-guard.sh')], {
    cwd: root,
    env,
    input: payload,
    encoding: 'utf8',
    timeout: EXEC_TIMEOUT_MS,
  });
  return r.status;
}

it('lane-guard allows a lane-M tooling write to .githooks/pre-commit and still refuses .githooks for other lanes', () => {
  const target = (root: string) => path.join(root, '.githooks', 'pre-commit');

  expect(runLaneGuard(LANE_MODULE, target)).toBe(EXIT_OK);
  expect(runLaneGuard(LANE_OTHER, target)).toBe(EXIT_LANE_BLOCK);
  expect(existsSync(path.join(ROOT, '.claude', 'hooks', 'lane-guard.sh'))).toBe(true);
});
