// tests/ops/tests/x-part-6.test.ts — X part 6 (pg-tester).
//
// Proves scripts/lib/g16-scope.sh's two functions (g16_changed_modules, g16_decide) and
// scripts/mutation-all.sh's fail-closed guard on an unknown module name, against
// tests/ops/x-part-6.feature (X part 6, D-193 D6). Each scenario that needs a git repository
// creates a disposable one under os.tmpdir() via mkdtemp and removes it in afterAll; nothing here
// touches the real repository's git state. Only scenario 6 runs against the real repo, read-only,
// with a module name that has no modules/ directory.
//
// One `it` per Gherkin Scenario, titled verbatim with the Scenario title.
//
// No `any`, no eslint-disable, no console.* (CLAUDE.md — pino only in production code; this
// harness uses vitest's own reporting).

import { afterAll, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tests/ops/tests/x-part-6.test.ts -> tests/ops/tests -> tests/ops -> tests -> repo root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const G16_SCOPE_LIB = path.join(ROOT, 'scripts', 'lib', 'g16-scope.sh');
const MUTATION_ALL_SCRIPT = path.join(ROOT, 'scripts', 'mutation-all.sh');

// ---- named constants (CLAUDE.md: no magic numbers) --------------------------------------------
const EXEC_TIMEOUT_MS = 30_000;
const ALL_ZERO_SHA = '0'.repeat(40);
const EXIT_MUTATION_ALL_UNKNOWN_MODULE = 1;
const GIT_AUTHOR_EMAIL = 'pg-tester@example.com';
const GIT_AUTHOR_NAME = 'pg-tester';
const TMP_PREFIX = 'g16-scope-';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Creates a disposable git repo under os.tmpdir(), `git init`-ed with a deterministic default
// branch so this test never depends on the host's git config (init.defaultBranch).
function createTempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), TMP_PREFIX));
  tempDirs.push(dir);
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: dir, timeout: EXEC_TIMEOUT_MS });
  return dir;
}

function writeRepoFiles(dir: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relativePath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
}

function commitAll(dir: string, message: string): string {
  execFileSync('git', ['add', '-A'], { cwd: dir, timeout: EXEC_TIMEOUT_MS });
  execFileSync(
    'git',
    [
      '-c',
      `user.email=${GIT_AUTHOR_EMAIL}`,
      '-c',
      `user.name=${GIT_AUTHOR_NAME}`,
      'commit',
      '--quiet',
      '-m',
      message,
    ],
    { cwd: dir, timeout: EXEC_TIMEOUT_MS },
  );
  return headSha(dir);
}

function headSha(dir: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, timeout: EXEC_TIMEOUT_MS }).toString().trim();
}

// git mv (like plain mv) renames via a single rename(2) call for a one-to-one move and does not
// create the destination's parent directory itself — it must already exist.
function gitMv(dir: string, from: string, to: string): void {
  mkdirSync(path.dirname(path.join(dir, to)), { recursive: true });
  execFileSync('git', ['mv', from, to], { cwd: dir, timeout: EXEC_TIMEOUT_MS });
}

// Sources the library by its absolute path in the real repo and calls g16_changed_modules with
// the given base, inside the disposable repo (cwd). Returns raw stdout, newline included — an
// empty in-scope set prints a single blank line (the library's own `xargs` with no input, running
// `echo` with no arguments).
function runChangedModules(cwd: string, base: string): string {
  return execFileSync('bash', ['-c', 'source "$1"; g16_changed_modules "$2"', 'bash', G16_SCOPE_LIB, base], {
    cwd,
    timeout: EXEC_TIMEOUT_MS,
  }).toString();
}

// Sources the library and calls g16_decide against the given env only — never this process's own
// G16_MODULES/PG_GUARDS_STRICT.
function runDecide(env: NodeJS.ProcessEnv): string {
  return execFileSync('bash', ['-c', 'source "$1"; g16_decide', 'bash', G16_SCOPE_LIB], {
    cwd: ROOT,
    env,
    timeout: EXEC_TIMEOUT_MS,
  })
    .toString()
    .trim();
}

it('g16_changed_modules reports no modules for a docs-only change', () => {
  const dir = createTempRepo();
  writeRepoFiles(dir, { 'docs/a.md': 'before\n' });
  const base = commitAll(dir, 'base');
  writeRepoFiles(dir, { 'docs/a.md': 'after\n' });
  commitAll(dir, 'docs change');

  const output = runChangedModules(dir, base);

  // Then it prints an empty line.
  expect(output).toBe('\n');
});

it(
  "g16_changed_modules names each module whose domain, tests or vitest config changed, never a module without stryker.config.json",
  () => {
    const dir = createTempRepo();
    writeRepoFiles(dir, {
      'modules/wms/stryker.config.json': '{}\n',
      'modules/fleet/stryker.config.json': '{}\n',
      'modules/hr/stryker.config.json': '{}\n',
      'modules/wms/domain/existing.ts': 'export const existing = 1;\n',
    });
    const base = commitAll(dir, 'base');

    writeRepoFiles(dir, {
      // a change under modules/wms/domain/ ...
      'modules/wms/domain/x.ts': 'export const x = 1;\n',
      // ... under modules/fleet/tests/ ...
      'modules/fleet/tests/y.test.ts': 'export const y = 1;\n',
      // ... modules/hr/vitest.config.ts ...
      'modules/hr/vitest.config.ts': 'export default {};\n',
      // ... and a module without stryker.config.json is never listed
      'modules/nocfg/domain/x.ts': 'export const n = 1;\n',
    });
    commitAll(dir, 'change');

    const output = runChangedModules(dir, base).trim();

    // Then it prints "fleet hr wms" and never lists nocfg
    expect(output).toBe('fleet hr wms');
    expect(output).not.toMatch(/nocfg/);
  },
);

it("a git mv still counts the source module, including a move into another module's domain", () => {
  const dir = createTempRepo();
  writeRepoFiles(dir, {
    'modules/wms/stryker.config.json': '{}\n',
    'modules/fleet/stryker.config.json': '{}\n',
    'modules/wms/domain/x.ts': 'export const x = 1;\n',
    'modules/wms/domain/y.ts': 'export const y = 1;\n',
  });
  const baseBeforeFirstMove = commitAll(dir, 'base');

  // When modules/wms/domain/x.ts is moved with git mv to modules/wms/application/x.ts and
  // committed, and g16_changed_modules is run with the pre-move commit as its argument
  gitMv(dir, 'modules/wms/domain/x.ts', 'modules/wms/application/x.ts');
  commitAll(dir, 'move x within wms');

  // Then it prints "wms"
  expect(runChangedModules(dir, baseBeforeFirstMove).trim()).toBe('wms');

  const baseBeforeSecondMove = headSha(dir);

  // When modules/wms/domain/y.ts is moved with git mv to modules/fleet/domain/y.ts and
  // committed, and g16_changed_modules is run with the pre-move commit as its argument
  gitMv(dir, 'modules/wms/domain/y.ts', 'modules/fleet/domain/y.ts');
  commitAll(dir, 'move y into fleet');

  // Then it prints "fleet wms", sorted
  expect(runChangedModules(dir, baseBeforeSecondMove).trim()).toBe('fleet wms');
});

it('an empty or all-zero base widens to every module', () => {
  const dir = createTempRepo();
  writeRepoFiles(dir, {
    'modules/wms/stryker.config.json': '{}\n',
    'modules/wms/domain/x.ts': 'export const x = 1;\n',
  });
  commitAll(dir, 'base');

  // When g16_changed_modules is run with an empty string as its argument, then it prints "ALL"
  expect(runChangedModules(dir, '').trim()).toBe('ALL');

  // When g16_changed_modules is run with the all-zero SHA as its argument, then it prints "ALL"
  expect(runChangedModules(dir, ALL_ZERO_SHA).trim()).toBe('ALL');
});

it('g16_decide honors G16_MODULES and PG_GUARDS_STRICT', () => {
  // X part 16 / D-198: CI unset now means `local`; this case pins CI mode (CI=true) so the all/scoped rule is tested deterministically.
  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  delete baseEnv['G16_MODULES'];
  delete baseEnv['PG_GUARDS_STRICT'];
  baseEnv['CI'] = 'true';

  // When g16_decide runs with G16_MODULES unset, then it prints "all"
  const unsetEnv: NodeJS.ProcessEnv = { ...baseEnv };
  delete unsetEnv['G16_MODULES'];
  expect(runDecide(unsetEnv)).toBe('all');

  // When g16_decide runs with G16_MODULES set to the empty string, then it prints "scoped:"
  expect(runDecide({ ...baseEnv, G16_MODULES: '' })).toBe('scoped:');

  // When g16_decide runs with G16_MODULES set to "wms fleet", then it prints "scoped:wms fleet"
  expect(runDecide({ ...baseEnv, G16_MODULES: 'wms fleet' })).toBe('scoped:wms fleet');

  // When g16_decide runs with G16_MODULES set to the empty string and PG_GUARDS_STRICT=1,
  // then it prints "all"
  expect(runDecide({ ...baseEnv, G16_MODULES: '', PG_GUARDS_STRICT: '1' })).toBe('all');
});

it('mutation-all.sh refuses an unknown module before building packages', () => {
  const result = spawnSync('bash', [MUTATION_ALL_SCRIPT, 'nosuch'], {
    cwd: ROOT,
    timeout: EXEC_TIMEOUT_MS,
    encoding: 'utf8',
  });

  // Then it exits 1
  expect(result.status).toBe(EXIT_MUTATION_ALL_UNKNOWN_MODULE);
  // And stderr names modules/nosuch
  expect(result.stderr).toMatch(/modules\/nosuch/);
  // And stdout does not contain "building packages"
  expect(result.stdout).not.toMatch(/building packages/);
});
