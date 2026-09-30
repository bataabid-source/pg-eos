// tests/ops/tests/x-part-20.test.ts — X part 20 item 1 (pg-tester).
//
// Executable half of tests/ops/x-part-20.feature: gate ⑦ moves from ci.yml to nightly.yml. Workflows
// are parsed as text (no YAML dependency), like x-part-5c. One `it` per Scenario, titled verbatim.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const CI_WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yml');
const NIGHTLY_WORKFLOW = path.join(ROOT, '.github', 'workflows', 'nightly.yml');

const IMAGE_JOB_ID = 'image';
const IMAGE_JOB_NAME = '⑦ build images (linux/arm64) + compose smoke';
const IMAGE_TIMEOUT_MINUTES = 45;
const GATE_SEVEN_MARK = '⑦';
const CI_KEPT_JOBS = ['static', 'test', 'acceptance', 'guards', 'security'];
const IMAGE_ENV_KEYS = [
  'COMPOSE_FILE',
  'WORKER_LOG_RETRIES',
  'WORKER_LOG_RETRY_SECONDS',
  'COMPOSE_WAIT_TIMEOUT_SECONDS',
];
const MUTATION_TIMEOUT = 'timeout-minutes: 180';
const MUTATION_COMMAND = 'pnpm -s mutation';
const NIGHTLY_TRIGGER_KEYS = ['schedule', 'workflow_dispatch'];
const FORBIDDEN_CI_ACTIONS = ['docker/build-push-action', 'docker/setup-qemu-action'];
const MUTATION_JOB_NAME = 'G16 mutation on domain/ (≥ 75 %) + G15 scenarios + recreate';
const BUILD_ACTION = 'docker/build-push-action@v6';
const AMD64_TAG = 'pg-eos/app:local';
const HEALTH_URL = 'http://127.0.0.1:3000/health';
const LOG_PROBE = 'relay loop starting';

// Text of the top-level block `<key>:` (0-indent) up to the next top-level key.
function topBlock(text: string, key: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const len = rest.findIndex((l) => /^\S/.test(l));
  return [lines[start] ?? '', ...(len < 0 ? rest : rest.slice(0, len))].join('\n');
}

// Keys at 2-space indent inside the top-level `on:` block.
function onKeys(text: string): string[] {
  return topBlock(text, 'on')
    .split('\n')
    .map((l) => /^ {2}([A-Za-z_][\w-]*):/.exec(l)?.[1])
    .filter((k): k is string => k !== undefined);
}

// Job ids under `jobs:` (2-space-indented keys).
function jobIds(text: string): string[] {
  return topBlock(text, 'jobs')
    .split('\n')
    .map((l) => /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(l)?.[1])
    .filter((id): id is string => id !== undefined);
}

// Text of job `<id>` from its 2-space key line to the next 2-space key or end of file.
function jobBlock(text: string, id: string): string {
  const lines = topBlock(text, 'jobs').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^ {2}${id}:\\s*$`).test(l));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const len = rest.findIndex((l) => /^ {2}[A-Za-z_][\w-]*:/.test(l));
  return [lines[start] ?? '', ...(len < 0 ? rest : rest.slice(0, len))].join('\n');
}

const ciText = readFileSync(CI_WORKFLOW, 'utf8');
const nightlyText = readFileSync(NIGHTLY_WORKFLOW, 'utf8');

describe('X part 20 — gate ⑦ runs nightly, not per PR', () => {
  it('per-PR CI carries gates one to six only', () => {
    // Then it has no job key image and no job name containing "⑦"
    expect(jobIds(ciText)).not.toContain(IMAGE_JOB_ID);
    expect(topBlock(ciText, 'jobs')).not.toContain(GATE_SEVEN_MARK);
    // And its jobs block uses neither docker/build-push-action nor docker/setup-qemu-action
    for (const action of FORBIDDEN_CI_ACTIONS) expect(topBlock(ciText, 'jobs')).not.toContain(action);
    // And its triggers keep pull_request and push
    const on = topBlock(ciText, 'on');
    expect(on).toMatch(/^ {2}pull_request:/m);
    expect(on).toMatch(/^ {2}push:/m);
    // And the jobs static, test, acceptance, guards and security still exist
    for (const id of CI_KEPT_JOBS) expect(jobIds(ciText)).toContain(id);
  });

  it('nightly.yml carries the gate seven image job', () => {
    // Then it has a job image named "⑦ …" with timeout-minutes 45
    expect(jobIds(nightlyText)).toContain(IMAGE_JOB_ID);
    const job = jobBlock(nightlyText, IMAGE_JOB_ID);
    expect(job).toContain(`name: "${IMAGE_JOB_NAME}"`);
    expect(job).toMatch(new RegExp(`^ {4}timeout-minutes:\\s*${IMAGE_TIMEOUT_MINUTES}\\b`, 'm'));
    // And it builds with docker/build-push-action@v6 for arm64 (push false) and amd64 (load true, tag)
    expect(job.split(BUILD_ACTION).length - 1).toBe(2);
    expect(job).toMatch(/platforms:\s*linux\/arm64/);
    expect(job).toMatch(/push:\s*false/);
    expect(job).toMatch(/platforms:\s*linux\/amd64/);
    expect(job).toMatch(/load:\s*true/);
    expect(job).toContain(`tags: ${AMD64_TAG}`);
    // And it runs compose up -d --wait, GET /health and the worker log probe
    expect(job).toMatch(/docker compose[^\n]*up -d --wait/);
    expect(job).toContain(`curl -fsS ${HEALTH_URL}`);
    expect(job).toContain(LOG_PROBE);
    // And it tears down with compose down -v under if: always()
    expect(job).toMatch(/if:\s*always\(\)\s*\n\s*run:\s*docker compose[^\n]*down -v/);
    // And its env sets the four keys
    for (const key of IMAGE_ENV_KEYS) expect(job).toMatch(new RegExp(`^ {6}${key}:`, 'm'));
  });

  it('nightly.yml triggers are schedule and workflow_dispatch only', () => {
    // Then its on block has schedule and workflow_dispatch and no pull_request
    const on = topBlock(nightlyText, 'on');
    expect(on).toMatch(/^ {2}schedule:/m);
    expect(on).toMatch(/^ {2}workflow_dispatch:/m);
    expect(on).not.toContain('pull_request');
    expect([...onKeys(nightlyText)].sort()).toEqual([...NIGHTLY_TRIGGER_KEYS].sort());
    // And concurrency group nightly is kept and the mutation job still exists with its name
    expect(topBlock(nightlyText, 'concurrency')).toMatch(/^ {2}group:\s*nightly\s*$/m);
    expect(jobIds(nightlyText)).toContain('mutation');
    const mutation = jobBlock(nightlyText, 'mutation');
    expect(mutation).toContain(`name: "${MUTATION_JOB_NAME}"`);
    expect(mutation).toContain(MUTATION_TIMEOUT);
    expect(mutation).toContain(MUTATION_COMMAND);
  });
});
