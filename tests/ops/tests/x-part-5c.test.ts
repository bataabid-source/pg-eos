// tests/ops/tests/x-part-5c.test.ts — X part 5c (pg-tester).
//
// Proves the executable half of tests/ops/x-part-5c.feature: one image, `api` + `worker` compose
// services (ADR-0006 §1), gate ⑦ image build in CI, and a host-only role-password script
// (docs/notes/slice-briefs/_slice-X-part-5c.brief.md).
//
// One `it` per Gherkin Scenario, titled verbatim with the Scenario title; each Then/And line
// becomes a sequential assertion inside that one `it` (a comment per line), per the brief's
// structural rule.
//
// Scenarios 1-3 need no Docker daemon: scenario 1 runs `docker compose … config --no-interpolate`
// (works without a daemon, per the Master's facts); scenarios 2-3 parse the Dockerfile and
// .dockerignore as plain text with named regexes. Scenario 4 parses .github/workflows/ci.yml as
// text. Scenario 5 needs a reachable local Postgres as superuser (PGUSER, default "postgres"); it
// refuses — never skips — unless PGHOST is loopback/unset or CI=true, per the brief.
//
// No `any`, no eslint-disable, no console.* (CLAUDE.md — pino only in production code; this
// harness uses vitest's own reporting).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';

const execFileAsync = promisify(execFile);

// tests/ops/tests/x-part-5c.test.ts -> tests/ops/tests -> tests/ops -> tests -> repo root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const COMPOSE_FILE = path.join(ROOT, 'infra', 'docker', 'docker-compose.yml');
const DOCKERFILE = path.join(ROOT, 'apps', 'api', 'Dockerfile');
const APPS_DIR = path.join(ROOT, 'apps');
const DOCKERIGNORE = path.join(ROOT, '.dockerignore');
const CI_WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yml');
const SET_ROLE_PASSWORDS_SCRIPT = path.join(ROOT, 'scripts', 'set-role-passwords.sh');

// ---- named constants (CLAUDE.md: no magic numbers) --------------------------------------------
const API_PORT = 3000;
const WORKER_REPLICAS = 1;
const EXIT_USAGE = 2;
const COMPOSE_CONFIG_TIMEOUT_MS = 30_000;
// Bounded, retried probe for the worker's "relay loop starting" log line inside the ⑦ job — this
// test only proves the CI YAML text asks for a retried, bounded probe (a named constant), not that
// the probe itself runs here (no daemon in this container).
const WORKER_LOG_RETRIES = 'WORKER_LOG_RETRIES';
const SET_ROLE_PASSWORDS_TIMEOUT_MS = 30_000;
// scenario 5 shells out to the script this many times in its one `it`: two "exit 2" usage-error
// runs (missing/empty variable), one PGSERVICE-refusal run, and the good run twice (first +
// second/idempotent) — 5 invocations, each bounded by SET_ROLE_PASSWORDS_TIMEOUT_MS.
const SCRIPT_RUNS_PER_SCENARIO = 5;
const RANDOM_PASSWORD_BYTES = 24;
const SCRAM_PREFIX = 'SCRAM-SHA-256$';

type ComposeEnv = Record<string, string>;
interface ComposePort {
  host_ip?: string;
  published?: string;
  target?: number;
}
interface ComposeDependsOnEntry {
  condition?: string;
}
interface ComposeService {
  image?: string;
  build?: { context?: string; dockerfile?: string };
  environment?: ComposeEnv;
  ports?: ComposePort[];
  init?: boolean;
  restart?: string;
  container_name?: string;
  deploy?: { replicas?: number };
  stop_signal?: string;
  pull_policy?: string;
  profiles?: string[];
  depends_on?: Record<string, ComposeDependsOnEntry>;
  command?: string[] | string;
}
interface ComposeConfig {
  services: Record<string, ComposeService>;
}

// Bounds a CI job's text from its `  <job-id>:` line (2-space indent under `jobs:`) to the next
// such line (the next job, or end of file) — job bodies are indented 4+ spaces, so a line-anchored
// 2-space-indent boundary never matches inside a job (e.g. `services:`/`steps:` sub-keys).
function extractJobText(ciText: string, nameRegex: RegExp): string {
  const jobsIndex = ciText.indexOf('\njobs:');
  if (jobsIndex < 0) return '';
  const jobsText = ciText.slice(jobsIndex);
  const jobIdLine = /^ {2}[A-Za-z_][\w-]*:.*$/gm;
  const boundaries: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = jobIdLine.exec(jobsText)) !== null) {
    boundaries.push(m.index);
  }
  const nameMatch = jobsText.match(nameRegex);
  if (!nameMatch || nameMatch.index === undefined) return '';
  const nameIndex = nameMatch.index;
  let start = -1;
  for (const b of boundaries) {
    if (b <= nameIndex) start = b;
    else break;
  }
  if (start < 0) return '';
  const end = boundaries.find((b) => b > start) ?? jobsText.length;
  return jobsText.slice(start, end);
}

function runComposeConfig(): ComposeConfig {
  const stdout = execFileSync(
    'docker',
    ['compose', '-f', COMPOSE_FILE, 'config', '--no-interpolate', '--format', 'json'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: COMPOSE_CONFIG_TIMEOUT_MS },
  );
  return JSON.parse(stdout.toString('utf8')) as ComposeConfig;
}

it('the compose file renders the documented services on one image', () => {
  const config = runComposeConfig();
  const api = config.services['api'];
  const worker = config.services['worker'];
  const pgadmin = config.services['pgadmin'];

  // Then services postgres, api and worker exist, pgadmin still carries profile tools, and no
  // other service exists
  expect(new Set(Object.keys(config.services))).toEqual(new Set(['postgres', 'api', 'worker', 'pgadmin']));
  expect(pgadmin?.profiles).toContain('tools');

  // And api builds from the repository root context with dockerfile apps/api/Dockerfile and
  // worker declares no build but the same image name as api and a command override
  expect(api?.build?.dockerfile).toBe('apps/api/Dockerfile');
  expect(api?.build?.context && path.resolve(api.build.context)).toBe(path.resolve(ROOT));
  expect(worker?.build).toBeUndefined();
  expect(worker?.image).toBe(api?.image);
  expect(Array.isArray(worker?.command) ? worker?.command.length : 0).toBeGreaterThan(0);

  // And api sets PG_APP_USER=pgeos_app, PGHOST=postgres, PORT=3000, publishes only
  // 127.0.0.1:3000, init true, restart unless-stopped
  expect(api?.environment?.['PG_APP_USER']).toBe('pgeos_app');
  expect(api?.environment?.['PGHOST']).toBe('postgres');
  expect(api?.environment?.['PORT']).toBe(String(API_PORT));
  expect(api?.ports).toHaveLength(1);
  expect(api?.ports?.[0]?.host_ip).toBe('127.0.0.1');
  expect(Number(api?.ports?.[0]?.published)).toBe(API_PORT);
  expect(api?.ports?.[0]?.target).toBe(API_PORT);
  expect(api?.init).toBe(true);
  expect(api?.restart).toBe('unless-stopped');

  // And worker sets PG_APP_USER=pgeos_worker, PGHOST=postgres, publishes no port, has
  // container_name pg-eos-worker, deploy.replicas = 1, stop_signal SIGTERM, init true,
  // pull_policy never, restart unless-stopped
  expect(worker?.environment?.['PG_APP_USER']).toBe('pgeos_worker');
  expect(worker?.environment?.['PGHOST']).toBe('postgres');
  expect(worker?.ports ?? []).toHaveLength(0);
  expect(worker?.container_name).toBe('pg-eos-worker');
  expect(worker?.deploy?.replicas).toBe(WORKER_REPLICAS);
  expect(worker?.stop_signal).toBe('SIGTERM');
  expect(worker?.init).toBe(true);
  expect(worker?.pull_policy).toBe('never');
  expect(worker?.restart).toBe('unless-stopped');

  // And api and worker depend on postgres with condition service_healthy
  expect(api?.depends_on?.['postgres']?.condition).toBe('service_healthy');
  expect(worker?.depends_on?.['postgres']?.condition).toBe('service_healthy');

  // And outside pgadmin (D-108), every environment value whose key contains PASSWORD is a
  // ${…} reference with an empty default
  const passwordRefPattern = /^\$\{[A-Za-z_][A-Za-z0-9_]*:-\}$/;
  for (const [name, service] of Object.entries(config.services)) {
    if (name === 'pgadmin') continue;
    const env = service.environment ?? {};
    for (const [key, value] of Object.entries(env)) {
      if (!key.includes('PASSWORD')) continue;
      expect(value, `${name}.environment.${key} must be an empty-default \${…} reference`).toMatch(
        passwordRefPattern,
      );
    }
  }
});

it('one non-root Node 22 image serves both processes', () => {
  // Then apps/api/Dockerfile exists and no other Dockerfile exists under apps/
  expect(existsSync(DOCKERFILE)).toBe(true);
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'Dockerfile') found.push(full);
    }
  };
  walk(APPS_DIR);
  expect(found).toEqual([DOCKERFILE]);

  const text = readFileSync(DOCKERFILE, 'utf8');

  // And it starts FROM node:22-bookworm-slim, sets COREPACK_HOME to a world-readable path
  // before corepack prepare pnpm@9.15.9, installs postgresql-client-16, runs
  // pnpm install --frozen-lockfile and pnpm build
  expect(text).toMatch(/^FROM\s+node:22-bookworm-slim/m);
  const corepackHomeIndex = text.search(/^ENV\s+COREPACK_HOME=\S+/m);
  const corepackPrepareIndex = text.search(/corepack prepare pnpm@9\.15\.9/);
  expect(corepackHomeIndex, 'ENV COREPACK_HOME=<world-readable path> must be set').toBeGreaterThanOrEqual(0);
  expect(corepackPrepareIndex, 'corepack prepare pnpm@9.15.9 must run').toBeGreaterThan(0);
  expect(corepackHomeIndex).toBeLessThan(corepackPrepareIndex);
  expect(text).toMatch(/postgresql-client-16/);
  expect(text).toMatch(/pnpm install --frozen-lockfile/);
  expect(text).toMatch(/pnpm build/);

  // And it ends with USER node and a CMD that runs node --import tsx directly (no pnpm at
  // PID 1) from WORKDIR /app/apps/api
  const userNodeIndex = text.search(/^USER\s+node\s*$/m);
  const workdirIndex = text.search(/^WORKDIR\s+\/app\/apps\/api\s*$/m);
  const cmdMatch = text.match(/^CMD\s+\[(.+)\]\s*$/m);
  expect(userNodeIndex, 'USER node must be set').toBeGreaterThanOrEqual(0);
  expect(workdirIndex, 'WORKDIR /app/apps/api must be set').toBeGreaterThan(userNodeIndex);
  expect(cmdMatch, 'CMD must be an exec-form array').not.toBeNull();
  const cmdArgs = (cmdMatch?.[1] ?? '').split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
  expect(cmdArgs[0]).toBe('node');
  expect(cmdArgs).toContain('--import');
  expect(cmdArgs).toContain('tsx');
  expect(cmdArgs.some((a) => a === 'pnpm' || a.includes('pnpm'))).toBe(false);

  // And it contains no ENV or ARG whose name contains PASSWORD, SECRET or TOKEN
  const offenders = text.split('\n').filter((line) => /^\s*(ENV|ARG)\s+\S*(PASSWORD|SECRET|TOKEN)\S*/i.test(line));
  expect(offenders).toEqual([]);

  // And it declares a HEALTHCHECK that reads PORT from the environment and sets
  // --start-period=30s
  const healthcheckMatch = text.match(/^HEALTHCHECK\b.*$/m);
  expect(healthcheckMatch, 'a HEALTHCHECK instruction must exist').not.toBeNull();
  expect(healthcheckMatch?.[0]).toMatch(/--start-period=30s/);
  expect(healthcheckMatch?.[0]).toMatch(/PORT/);
});

it('the build context leaves secrets and data out', () => {
  // Then .dockerignore lists .git, **/.env, **/.env.*, **/data/, **/node_modules/, **/dist/,
  // **/coverage/, **/.turbo/, **/reports/, **/*.pem, **/*.key, **/*.dump, **/*.bak, **/*.tgz,
  // **/id_*, !**/id_*.ts, !**/id_*.tsx, **/*.sql.gz, .claude/settings.local.json, **/build/,
  // **/.stryker-tmp/, **/playwright-report/, **/test-results/
  expect(existsSync(DOCKERIGNORE)).toBe(true);
  const lines = new Set(
    readFileSync(DOCKERIGNORE, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#')),
  );
  const required = [
    '.git',
    '**/.env',
    '**/.env.*',
    '**/data/',
    '**/node_modules/',
    '**/dist/',
    '**/coverage/',
    '**/.turbo/',
    '**/reports/',
    '**/*.pem',
    '**/*.key',
    '**/*.dump',
    '**/*.bak',
    '**/*.tgz',
    '**/id_*',
    '!**/id_*.ts',
    '!**/id_*.tsx',
    '**/*.sql.gz',
    '.claude/settings.local.json',
    '**/build/',
    '**/.stryker-tmp/',
    '**/playwright-report/',
    '**/test-results/',
  ];
  for (const pattern of required) {
    expect(lines.has(pattern), `.dockerignore must list "${pattern}"`).toBe(true);
  }
});

it('gate ⑦ builds for linux/arm64, runs the stack once on amd64 and pushes nothing', () => {
  // When .github/workflows/ci.yml is read
  expect(existsSync(CI_WORKFLOW)).toBe(true);
  const ciText = readFileSync(CI_WORKFLOW, 'utf8');

  // Then a job whose name starts with "⑦" exists with timeout-minutes set, uses
  // docker/setup-qemu-action@v3 and docker/setup-buildx-action@v3
  const sevenNameRegex = /name:\s*"⑦[^"]*"/;
  expect(ciText.match(sevenNameRegex), 'a job name starting with "⑦" must exist').not.toBeNull();
  const sevenJobText = extractJobText(ciText, sevenNameRegex);
  expect(sevenJobText).toMatch(/timeout-minutes:\s*\d+/);
  expect(sevenJobText).toMatch(/docker\/setup-qemu-action@v3/);
  expect(sevenJobText).toMatch(/docker\/setup-buildx-action@v3/);

  // And it builds apps/api/Dockerfile with platforms linux/arm64 and push: false, and once
  // more for linux/amd64 with load: true
  expect(sevenJobText).toMatch(/file:\s*apps\/api\/Dockerfile/);
  expect(sevenJobText).toMatch(/platforms:\s*linux\/arm64/);
  expect(sevenJobText).toMatch(/push:\s*false/);
  expect(sevenJobText).toMatch(/platforms:\s*linux\/amd64/);
  expect(sevenJobText).toMatch(/load:\s*true/);

  // And it runs docker compose config -q, starts postgres, applies the schema with
  // docker compose run --rm -e PGUSER=postgres api bash database/schema/apply.sh, starts api
  // and worker with up -d --wait, asserts GET http://127.0.0.1:3000/health is 200 and the
  // worker log (retried, bounded) contains "relay loop starting", then compose down -v
  expect(sevenJobText).toMatch(/docker compose[^\n]*config -q/);
  expect(sevenJobText).toMatch(/docker compose[^\n]*up -d postgres/);
  expect(sevenJobText).toMatch(/docker compose run --rm -e PGUSER=postgres api bash database\/schema\/apply\.sh/);
  expect(sevenJobText).toMatch(/docker compose[^\n]*up -d --wait[^\n]*(api|worker)/);
  expect(sevenJobText).toMatch(/--wait-timeout/);
  expect(sevenJobText).toMatch(/COMPOSE_WAIT_TIMEOUT_SECONDS/);
  expect(sevenJobText).toMatch(new RegExp(`http://127\\.0\\.0\\.1:${API_PORT}/health`));
  expect(sevenJobText).toMatch(
    /docker inspect -f '\{\{\.State\.Running\}\} \{\{\.RestartCount\}\}' pg-eos-worker/,
  );
  expect(sevenJobText).toMatch(/relay loop starting/);
  expect(sevenJobText).toMatch(new RegExp(WORKER_LOG_RETRIES));
  expect(sevenJobText).toMatch(/docker compose[^\n]*down -v/);

  // And the ②③ job carries a pnpm test:ops step (presence within the job only — not its
  // position relative to any other step)
  const testNameRegex = /name:\s*"②③[^"]*"/;
  expect(ciText.match(testNameRegex), 'the ②③ job must exist').not.toBeNull();
  const testJobText = extractJobText(ciText, testNameRegex);
  expect(testJobText).toMatch(/pnpm test:ops/);

  // And the header comment no longer says gate ⑦ is outside CI
  const header = ciText.split('\njobs:')[0] ?? '';
  expect(header).not.toMatch(/gate ⑦[^\n]*(is not part of CI|not part of CI)/);
  expect(header).not.toMatch(/is the deploy pipeline, not CI/);
});

describe('role passwords come from the host, never from the repository or a process list', () => {
  const PGHOST = process.env['PGHOST'];
  const isLocal = !PGHOST || PGHOST === 'localhost' || PGHOST === '127.0.0.1' || PGHOST.startsWith('/');
  const isCi = process.env['CI'] === 'true';
  if (!isLocal && !isCi) {
    throw new Error(
      'scenario 5 (role passwords) requires PGHOST to be loopback/unset or CI=true — it never skips silently',
    );
  }

  const PGUSER = process.env['PGUSER'] ?? 'postgres';
  const PGPORT = process.env['PGPORT'] ?? '5432';
  const PGDATABASE = process.env['PGDATABASE'] ?? 'pgeos';

  let storedAppPassword: string | null = null;
  let storedWorkerPassword: string | null = null;

  function connectSuperuser(): Client {
    return new Client({ host: PGHOST, port: Number(PGPORT), user: PGUSER, database: PGDATABASE });
  }

  async function readRolpassword(client: Client, role: string): Promise<string | null> {
    const { rows } = await client.query<{ rolpassword: string | null }>(
      'select rolpassword from pg_authid where rolname = $1',
      [role],
    );
    return rows[0]?.rolpassword ?? null;
  }

  beforeAll(async () => {
    const client = connectSuperuser();
    await client.connect();
    try {
      storedAppPassword = await readRolpassword(client, 'pgeos_app');
      storedWorkerPassword = await readRolpassword(client, 'pgeos_worker');
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    const client = connectSuperuser();
    await client.connect();
    try {
      const restore = async (role: string, stored: string | null): Promise<void> => {
        const literal = stored === null ? 'null' : client.escapeLiteral(stored);
        await client.query(`alter role ${role} password ${literal}`);
      };
      await restore('pgeos_app', storedAppPassword);
      await restore('pgeos_worker', storedWorkerPassword);
    } finally {
      await client.end();
    }
  });

  it(
    'role passwords come from the host, never from the repository or a process list',
    async () => {
      // Given scripts/set-role-passwords.sh
      expect(existsSync(SET_ROLE_PASSWORDS_SCRIPT)).toBe(true);
      const text = readFileSync(SET_ROLE_PASSWORDS_SCRIPT, 'utf8');

      // Then it reads PG_APP_PASSWORD and PG_WORKER_PASSWORD only through psql \getenv on a
      // stdin script (no -v/--set, no interpolation into SQL) and sets local log_statement =
      // 'none' before each alter role
      expect(text).toMatch(/\\getenv\s+\S*app\S*\s+PG_APP_PASSWORD/);
      expect(text).toMatch(/\\getenv\s+\S*worker\S*\s+PG_WORKER_PASSWORD/);
      expect(text).not.toMatch(/psql[^\n]*(-v\s|--set[\s=])/);
      expect(text).toMatch(/set local log_statement\s*=\s*'none'/);
      expect(text).toMatch(/set local log_min_error_statement\s*=\s*'panic'/);
      expect(text).toMatch(/set local log_min_duration_statement\s*=\s*-1/);
      // "no SQL" per the scenario title — the alter role statements must bind through psql
      // :'var' substitution from \getenv, never bash string interpolation of the password
      // itself.
      expect(text).not.toMatch(/\$PG_APP_PASSWORD/);
      expect(text).not.toMatch(/\$PG_WORKER_PASSWORD/);
      expect(text).not.toMatch(/\$\{PG_APP_PASSWORD/);
      expect(text).not.toMatch(/\$\{PG_WORKER_PASSWORD/);

      // The log_statement suppression must precede BOTH alter role statements — never logged,
      // not even the first one.
      const logStatementIndex = text.search(/set local log_statement\s*=\s*'none'/);
      const alterRoleIndices: number[] = [];
      const alterRoleRegex = /alter role\s+\S+\s+password/gi;
      let alterRoleMatch: RegExpExecArray | null;
      while ((alterRoleMatch = alterRoleRegex.exec(text)) !== null) {
        alterRoleIndices.push(alterRoleMatch.index);
      }
      expect(alterRoleIndices.length, 'both alter role statements must exist').toBeGreaterThanOrEqual(2);
      for (const alterRoleIndex of alterRoleIndices) {
        expect(logStatementIndex).toBeGreaterThanOrEqual(0);
        expect(logStatementIndex).toBeLessThan(alterRoleIndex);
      }

      // When it runs with either variable unset or empty
      const runWith = (env: NodeJS.ProcessEnv): { status: number | null; output: string } => {
        try {
          const stdout = execFileSync('bash', [SET_ROLE_PASSWORDS_SCRIPT], {
            cwd: ROOT,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: SET_ROLE_PASSWORDS_TIMEOUT_MS,
          });
          return { status: 0, output: stdout.toString('utf8') };
        } catch (err) {
          const e = err as { status?: number | null; stdout?: Buffer | string; stderr?: Buffer | string };
          return { status: e.status ?? null, output: `${String(e.stdout ?? '')}${String(e.stderr ?? '')}` };
        }
      };
      const baseEnv = { ...process.env, PGHOST, PGPORT, PGUSER, PGDATABASE };

      const unsetApp: NodeJS.ProcessEnv = { ...baseEnv, PG_WORKER_PASSWORD: 'x' };
      delete unsetApp['PG_APP_PASSWORD'];
      const unsetAppResult = runWith(unsetApp);

      const emptyWorker = { ...baseEnv, PG_APP_PASSWORD: 'x', PG_WORKER_PASSWORD: '' };
      const emptyWorkerResult = runWith(emptyWorker);

      // Then it exits 2 before any SQL, naming the missing variable
      expect(unsetAppResult.status).toBe(EXIT_USAGE);
      expect(unsetAppResult.output).toMatch(/PG_APP_PASSWORD/);
      expect(emptyWorkerResult.status).toBe(EXIT_USAGE);
      expect(emptyWorkerResult.output).toMatch(/PG_WORKER_PASSWORD/);

      // And the guard refuses when PGHOSTADDR or PGSERVICE is set — both passwords provided,
      // PGSERVICE=x: exit 2, rolpassword unchanged.
      const preServiceClient = connectSuperuser();
      await preServiceClient.connect();
      let appBeforeService: string | null;
      let workerBeforeService: string | null;
      try {
        appBeforeService = await readRolpassword(preServiceClient, 'pgeos_app');
        workerBeforeService = await readRolpassword(preServiceClient, 'pgeos_worker');
      } finally {
        await preServiceClient.end();
      }

      const pgServiceEnv = { ...baseEnv, PG_APP_PASSWORD: 'x', PG_WORKER_PASSWORD: 'x', PGSERVICE: 'x' };
      const pgServiceResult = runWith(pgServiceEnv);
      expect(pgServiceResult.status).toBe(EXIT_USAGE);

      const postServiceClient = connectSuperuser();
      await postServiceClient.connect();
      let appAfterService: string | null;
      let workerAfterService: string | null;
      try {
        appAfterService = await readRolpassword(postServiceClient, 'pgeos_app');
        workerAfterService = await readRolpassword(postServiceClient, 'pgeos_worker');
      } finally {
        await postServiceClient.end();
      }
      expect(appAfterService).toBe(appBeforeService);
      expect(workerAfterService).toBe(workerBeforeService);

      // And run against the local database (PGHOST loopback or the CI service only,
      // PGUSER=postgres) with two random values, pg_authid.rolpassword of pgeos_app and
      // pgeos_worker both start with SCRAM-SHA-256$, a second run succeeds, and no output
      // line contains either value
      const appPassword = randomBytes(RANDOM_PASSWORD_BYTES).toString('hex');
      const workerPassword = randomBytes(RANDOM_PASSWORD_BYTES).toString('hex');
      const goodEnv = {
        ...process.env,
        PGHOST,
        PGPORT,
        PGUSER,
        PGDATABASE,
        PG_APP_PASSWORD: appPassword,
        PG_WORKER_PASSWORD: workerPassword,
      };

      const firstResult = await execFileAsync('bash', [SET_ROLE_PASSWORDS_SCRIPT], {
        cwd: ROOT,
        env: goodEnv,
        timeout: SET_ROLE_PASSWORDS_TIMEOUT_MS,
      });
      const firstOutput = `${firstResult.stdout}${firstResult.stderr}`;
      expect(firstOutput).not.toContain(appPassword);
      expect(firstOutput).not.toContain(workerPassword);
      for (const line of firstOutput.split('\n')) {
        expect(line).not.toContain(appPassword);
        expect(line).not.toContain(workerPassword);
      }

      const client = connectSuperuser();
      await client.connect();
      let appRolpassword: string | null;
      let workerRolpassword: string | null;
      try {
        appRolpassword = await readRolpassword(client, 'pgeos_app');
        workerRolpassword = await readRolpassword(client, 'pgeos_worker');
      } finally {
        await client.end();
      }
      expect(appRolpassword?.startsWith(SCRAM_PREFIX)).toBe(true);
      expect(workerRolpassword?.startsWith(SCRAM_PREFIX)).toBe(true);

      const secondResult = await execFileAsync('bash', [SET_ROLE_PASSWORDS_SCRIPT], {
        cwd: ROOT,
        env: goodEnv,
        timeout: SET_ROLE_PASSWORDS_TIMEOUT_MS,
      });
      const secondOutput = `${secondResult.stdout}${secondResult.stderr}`;
      expect(secondOutput).not.toContain(appPassword);
      expect(secondOutput).not.toContain(workerPassword);

      // And afterAll restores each role's rolpassword to the value read in beforeAll
      // (password null when it was null) — see afterAll above.
    },
    SET_ROLE_PASSWORDS_TIMEOUT_MS * SCRIPT_RUNS_PER_SCENARIO,
  );
});
