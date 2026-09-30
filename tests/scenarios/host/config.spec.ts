// tests/scenarios/host/config.spec.ts — X part 5e, project `host`. Config-level checks: without the
// PG_EOS_E2E flag the config is today's single project with no webServer; with it three projects with
// the stated testMatch and two webServer entries; and the verdict script ignores the new projects.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test } from '@playwright/test';

const E2E_FLAG_ENV_VAR = 'PG_EOS_E2E';
const E2E_FLAG_ON = '1';
const PROJECT_SCENARIOS = 'scenarios';
const PROJECT_HOST = 'host';
const PROJECT_PDA = 'pda';
const EXPECTED_TEST_MATCH: Readonly<Record<string, string>> = {
  [PROJECT_SCENARIOS]: String(/S\d{1,2}\.spec\.ts$/),
  [PROJECT_HOST]: String(/host\/.*\.spec\.ts$/),
  [PROJECT_PDA]: String(/pda\/.*\.spec\.ts$/),
};
const FLAG_ON_PROJECT_COUNT = 3;
const WEB_SERVER_COUNT = 2;
const HEALTH_URL_SUFFIX = '/health';
const ROOT_URL_SUFFIX = '/';
const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const VERDICT_SCRIPT = 'scripts/scenarios-verdict.mjs';
const MANIFEST_FLAG = '--manifest';
const REPORT_FILE = 'report.json';
const MANIFEST_FILE = 'manifest.json';
const TEMP_PREFIX = 'pg-eos-x5e-';
const VERDICT_GREEN = 'green';
const VERDICT_RED_REGRESSION = 'red:regression';
const EXIT_GREEN = 0;
const EXIT_RED = 1;
const NODE_BINARY = 'node';
const UTF8 = 'utf8';
const PASSED = 'passed';
const FAILED = 'failed';
const SCENARIO_FILE = 'S7.spec.ts';
const SCENARIO_TITLE = 'S7 trial client';
const HOST_FILE = 'host/health-and-auth.spec.ts';
const HOST_TITLE = 'health over TCP';

interface ProbedConfig {
  readonly projects: ReadonlyArray<{ readonly name: string; readonly testMatch: string }> | null;
  readonly webServer: readonly string[];
}

const SCENARIOS_DIR = resolve(import.meta.dirname, '..');
const PROBE_SCRIPT = `const c = (await import('./playwright.config.ts')).default; console.log(JSON.stringify({ projects: c.projects?.map(p => ({ name: p.name, testMatch: String(p.testMatch) })) ?? null, webServer: (Array.isArray(c.webServer) ? c.webServer : c.webServer ? [c.webServer] : []).map(w => w.url) }))`;
const NODE_ARGS = ['--input-type=module', '-e', PROBE_SCRIPT];

/** Loads the config in a CHILD process so the host worker's own module cache never leaks in. */
function probeConfig(flag: string | undefined): ProbedConfig {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (flag === undefined) delete env[E2E_FLAG_ENV_VAR];
  else env[E2E_FLAG_ENV_VAR] = flag;
  const result = spawnSync(NODE_BINARY, NODE_ARGS, { cwd: SCENARIOS_DIR, env, encoding: UTF8 });
  if (result.status !== 0) throw new Error(`config probe failed: ${result.stderr}`);
  const lines = result.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1] ?? '') as ProbedConfig;
}

interface ReportSpec {
  readonly title: string;
  readonly file: string;
  readonly ok: boolean;
  readonly project: string;
}

function suiteOf(spec: ReportSpec): object {
  return {
    title: spec.file,
    file: spec.file,
    specs: [
      {
        title: spec.title,
        file: spec.file,
        ok: spec.ok,
        tests: [{ projectName: spec.project, results: [{ status: spec.ok ? PASSED : FAILED }] }],
      },
    ],
  };
}

interface VerdictRun {
  readonly stdout: string;
  readonly status: number | null;
}

/** Runs the verdict script on a temp report + a manifest listing S7; returns stdout and the exit status. */
function runVerdict(specs: readonly ReportSpec[]): VerdictRun {
  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  try {
    const reportPath = join(dir, REPORT_FILE);
    const manifestPath = join(dir, MANIFEST_FILE);
    writeFileSync(reportPath, JSON.stringify({ suites: specs.map(suiteOf) }));
    writeFileSync(manifestPath, JSON.stringify({ green: ['S7'] }));
    const result = spawnSync(NODE_BINARY, [VERDICT_SCRIPT, reportPath, MANIFEST_FLAG, manifestPath], {
      cwd: REPO_ROOT,
      encoding: UTF8,
    });
    return { stdout: result.stdout, status: result.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.describe('playwright config and verdict', () => {
  test('without PG_EOS_E2E the config is today\'s single scenarios project, with it three projects and two webServers, and the verdict ignores the host and pda projects', async () => {
    // (a) flag unset: today's behaviour (a child process, PG_EOS_E2E deleted, never '').
    const off = probeConfig(undefined);
    expect(off.projects).toBeNull();
    expect(off.webServer).toEqual([]);

    // (b) flag on: a separate child process.
    const on = probeConfig(E2E_FLAG_ON);
    const projects = on.projects ?? [];
    expect(projects).toHaveLength(FLAG_ON_PROJECT_COUNT);
    expect(projects.map((p) => p.name).sort()).toEqual([PROJECT_HOST, PROJECT_PDA, PROJECT_SCENARIOS]);
    for (const project of projects) {
      expect(project.testMatch, `${project.name} testMatch`).toBe(EXPECTED_TEST_MATCH[project.name]);
    }
    expect(on.webServer).toHaveLength(WEB_SERVER_COUNT);
    expect(on.webServer[0]?.endsWith(HEALTH_URL_SUFFIX)).toBe(true);
    expect(on.webServer[1]?.endsWith(ROOT_URL_SUFFIX)).toBe(true);

    // (c) verdict: case A — scenario spec passes, a host-project spec fails -> green.
    const caseA = runVerdict([
      { title: SCENARIO_TITLE, file: SCENARIO_FILE, ok: true, project: PROJECT_SCENARIOS },
      { title: HOST_TITLE, file: HOST_FILE, ok: false, project: PROJECT_HOST },
    ]);
    expect(caseA.stdout.startsWith(VERDICT_GREEN)).toBe(true);
    expect(caseA.status).toBe(EXIT_GREEN);

    // case B — the scenario spec fails -> red:regression.
    const caseB = runVerdict([
      { title: SCENARIO_TITLE, file: SCENARIO_FILE, ok: false, project: PROJECT_SCENARIOS },
    ]);
    expect(caseB.stdout.startsWith(VERDICT_RED_REGRESSION)).toBe(true);
    expect(caseB.status).toBe(EXIT_RED);
  });
});
