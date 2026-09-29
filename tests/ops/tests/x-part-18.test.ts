// tests/ops/tests/x-part-18.test.ts — X part 18 (pg-tester).
//
// Proves scripts/review-verdict.mjs (verdict reader for the `review` CI check) and the wiring in
// .github/workflows/claude-review.yml, against tests/ops/x-part-18.feature. The script is driven
// from the repo root on fixture JSON files written to a mkdtemp dir, shaped like
// `gh api repos/{owner}/{repo}/issues/{n}/comments` items. The workflow scenario parses the YAML
// as text. One `it` per Gherkin Scenario, titled verbatim, plus a generated case table for
// pickVerdict (seeded LCG — no Math.random, no fast-check dependency in tests/ops).

import { afterAll, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickVerdict } from '../../../scripts/review-verdict.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

// ---- named constants ---------------------------------------------------------------------------
const SCRIPT = 'scripts/review-verdict.mjs';
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'claude-review.yml');
const EXEC_TIMEOUT_MS = 30_000;
const EXIT_GREEN = 0;
const EXIT_RED = 1;
const EXIT_USAGE = 2;
const TMP_PREFIX = 'review-verdict-';
const BOT = 'claude[bot]';
const BOT_TYPE = 'Bot';
const OTHER = 'pg-master';
const OTHER_TYPE = 'User';
const SINCE = '2026-09-29T10:00:00Z';
const BEFORE = '2026-09-29T09:00:00Z';
const AFTER_1 = '2026-09-29T10:05:00Z';
const AFTER_2 = '2026-09-29T10:30:00Z';
const PASS_BODY = '**PASS(0 findings)**';
const FAIL_BODY = '**FAIL(4 findings)** — pg-reviewer, round 2 — 1. file:1 breaks a rule';
const PROSE_BODY = 'Master note: pg-reviewer said round 2 FAIL(4) so I am fixing it.';
const HTML_URL_BASE = 'https://github.com/premium/pg-eos/pull/1#issuecomment-';
const FAIL_LINE_PREFIX = 'red:FAIL(4 findings)';
const NO_VERDICT_PREFIX = 'red:no verdict';
const ACTION_USES = 'anthropics/claude-code-action@v1';
const TOKEN_GATE = "if: ${{ env.HAS_REVIEW_TOKEN == 'true' }}";
const STEP_START_RE = /^ {6}- \w+:/gm;
const STEP_SPLIT_RE = /^(?= {6}- \w+:)/m;
const MS_PER_MINUTE = 60_000;
const VERDICT_RE = /\b(PASS|FAIL)\((\d+) findings?\)/;
const GATE_ENV_KEYS = ['GH_TOKEN', 'PR', 'SINCE', 'REPO'];
const GH_API_CALL = 'gh api "repos/$REPO/issues/$PR/comments?per_page=100" --paginate --slurp';
const NODE_CALL = 'node scripts/review-verdict.mjs';
const SINCE_ARG = '--since "$SINCE"';
const STALE_HEADER = 'two skipped steps';
const PR_FILES_CALL = 'gh api "repos/$REPO/pulls/$PR/files?per_page=100" --paginate --jq \'.[].filename\'';
const PR_FILES_PATH = 'pulls/$PR/files';
const COMMENTS_PATH = 'issues/$PR/comments';
const SELF_WORKFLOW_PATH = '.github/workflows/claude-review.yml';
const EXIT_ZERO_CALL = 'exit 0';
const SKIP_TITLE =
  'the verdict gate is skipped on a PR that edits claude-review.yml itself: ::warning + step summary + a `review: MANUAL` PR comment, exit 0 (the action does not run on such a PR — manual review by the Master)';
const MANUAL_TEXT = 'review: MANUAL';
const MANUAL_WINDOW = 300;
const WARNING_RE = /::warning[^\n]*review: MANUAL/;
const SUMMARY_RE = new RegExp(
  `review: MANUAL[\\s\\S]{0,${MANUAL_WINDOW}}?>>\\s*"?\\$GITHUB_STEP_SUMMARY|>>\\s*"?\\$GITHUB_STEP_SUMMARY[\\s\\S]{0,${MANUAL_WINDOW}}?review: MANUAL`,
);
const PR_COMMENT_RE = new RegExp(
  `review: MANUAL[\\s\\S]{0,${MANUAL_WINDOW}}?gh pr comment|gh pr comment[\\s\\S]{0,${MANUAL_WINDOW}}?review: MANUAL`,
);
const SELF_IF_RE = new RegExp(
  `\\bif\\b[^\\n]*pulls/\\$PR/files[\\s\\S]{0,${MANUAL_WINDOW}}?\\|\\s*grep -F\\w*[\\s\\S]{0,${MANUAL_WINDOW}}?claude-review\\.yml`,
);

// Case-table generator: seeded LCG (Numerical Recipes constants), deterministic across runs.
const GEN_SEED = 20_260_929;
const LCG_MULT = 1_664_525;
const LCG_INC = 1_013_904_223;
const LCG_MOD = 2 ** 32;
const CASE_COUNT = 300;
const MAX_COMMENTS = 7;
const OFFSET_RANGE_MIN = 120;
const AUTHOR_CHOICES = 2;
const BODY_CHOICES = 4;
const COUNT_RANGE = 9;

interface Comment {
  id: number;
  html_url: string;
  user: { login: string; type: string };
  created_at: string;
  body: string;
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), TMP_PREFIX));
  tempDirs.push(dir);
  return dir;
}

let nextId = 1;
function comment(login: string, createdAt: string, body: string): Comment {
  const id = nextId++;
  const type = login === BOT ? BOT_TYPE : OTHER_TYPE;
  return { id, html_url: `${HTML_URL_BASE}${id}`, user: { login, type }, created_at: createdAt, body };
}

function writeRaw(payload: Comment[] | Comment[][]): string {
  const file = path.join(makeDir(), 'comments.json');
  writeFileSync(file, JSON.stringify(payload));
  return file;
}

function writeComments(comments: Comment[]): string {
  return writeRaw(comments);
}

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: EXEC_TIMEOUT_MS,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function firstLine(stdout: string): string {
  return stdout.split('\n')[0] ?? '';
}

it('a PASS verdict by claude[bot] after --since prints green and exits 0, also when the file holds --slurp pages', () => {
  const file = writeComments([comment(BOT, AFTER_1, PASS_BODY)]);
  const r = run([file, '--since', SINCE]);
  expect(firstLine(r.stdout)).toBe('green');
  expect(r.status).toBe(EXIT_GREEN);

  // `gh api --paginate --slurp` shape: an array of pages, the PASS verdict in page 2
  const page1 = [comment(OTHER, AFTER_1, PROSE_BODY), comment(BOT, BEFORE, FAIL_BODY)];
  const page2 = [comment(BOT, AFTER_2, PASS_BODY)];
  const slurped = writeRaw([page1, page2]);
  const s = run([slurped, '--since', SINCE]);
  expect(firstLine(s.stdout)).toBe('green');
  expect(s.status).toBe(EXIT_GREEN);
});

it('a FAIL verdict by claude[bot] after --since prints red with the count and exits 1', () => {
  const failing = comment(BOT, AFTER_1, FAIL_BODY);
  const file = writeComments([failing]);
  const r = run([file, '--since', SINCE]);
  const line = firstLine(r.stdout);
  expect(line.startsWith(FAIL_LINE_PREFIX)).toBe(true);
  expect(line).toContain(failing.html_url);
  expect(r.status).toBe(EXIT_RED);
});

it('the newest verdict wins when an older PASS and a newer FAIL both exist, and vice versa', () => {
  const passOld = comment(BOT, AFTER_1, PASS_BODY);
  const failNew = comment(BOT, AFTER_2, FAIL_BODY);
  // array order deliberately newest-first: the script must sort by created_at, not by position
  const a = run([writeComments([failNew, passOld]), '--since', SINCE]);
  expect(firstLine(a.stdout).startsWith(FAIL_LINE_PREFIX)).toBe(true);
  expect(a.status).toBe(EXIT_RED);

  const failOld = comment(BOT, AFTER_1, FAIL_BODY);
  const passNew = comment(BOT, AFTER_2, PASS_BODY);
  const b = run([writeComments([failOld, passNew]), '--since', SINCE]);
  expect(firstLine(b.stdout)).toBe('green');
  expect(b.status).toBe(EXIT_GREEN);
});

it('a verdict quoted inside a comment by another author, or a claude[bot] verdict before --since, is ignored and the result is red:no verdict', () => {
  const file = writeComments([
    comment(OTHER, AFTER_1, PROSE_BODY),
    comment(OTHER, AFTER_2, PASS_BODY),
    comment(BOT, BEFORE, PASS_BODY),
    comment(BOT, AFTER_1, 'Reviewing now, no verdict yet.'),
  ]);
  const r = run([file, '--since', SINCE]);
  const line = firstLine(r.stdout);
  expect(line.startsWith(NO_VERDICT_PREFIX)).toBe(true);
  expect(line).toContain(BOT);
  expect(line).toContain(SINCE);
  expect(r.status).toBe(EXIT_RED);
});

it('an unreadable file or a missing --since exits 2 with a usage line', () => {
  const missing = path.join(makeDir(), 'does-not-exist.json');
  const unreadable = run([missing, '--since', SINCE]);
  expect(unreadable.status).toBe(EXIT_USAGE);
  expect(unreadable.stderr.toLowerCase()).toContain('usage');

  const noSince = run([writeComments([comment(BOT, AFTER_1, PASS_BODY)])]);
  expect(noSince.status).toBe(EXIT_USAGE);
  expect(`${noSince.stderr}${noSince.stdout}`.toLowerCase()).toContain('usage');
});

it('claude-review.yml records the job start before the action, fetches the PR comments with gh api and runs review-verdict.mjs with --since after the action, all gated on the token', () => {
  const yml = readFileSync(WORKFLOW, 'utf8');

  const startId = yml.search(/^\s+id: start\s*$/m);
  const outputWrite = yml.indexOf('since=');
  const actionAt = yml.indexOf(ACTION_USES);
  expect(startId).toBeGreaterThanOrEqual(0);
  expect(outputWrite).toBeGreaterThanOrEqual(0);
  expect(yml.slice(outputWrite)).toContain('$GITHUB_OUTPUT');
  expect(actionAt).toBeGreaterThanOrEqual(0);
  expect(startId).toBeLessThan(actionAt);
  expect(outputWrite).toBeLessThan(actionAt);
  expect(yml.slice(outputWrite, actionAt)).toContain('GITHUB_OUTPUT');

  const after = yml.slice(actionAt);
  const gateStep = after
    .split(STEP_SPLIT_RE)
    .find((st) => st.includes(NODE_CALL));
  expect(gateStep).toBeDefined();
  const gate = gateStep ?? '';
  expect(gate).toMatch(/^\s+env:\s*$/m);
  for (const key of GATE_ENV_KEYS) expect(gate).toMatch(new RegExp(`^\\s+${key}:`, 'm'));
  const runAt = gate.search(/^\s+run:/m);
  expect(runAt).toBeGreaterThanOrEqual(0);
  const runText = gate.slice(runAt);
  expect(runText).toContain(GH_API_CALL);
  expect(runText).toContain(NODE_CALL);
  expect(runText).toContain(SINCE_ARG);
  expect(runText).not.toMatch(/-F\s+per_page/);
  expect(runText).not.toContain('${{');
  expect(runText.indexOf(NODE_CALL)).toBeGreaterThan(runText.indexOf(GH_API_CALL));
  expect(yml).not.toContain(STALE_HEADER);

  // every step (any first key: `- uses:` / `- name:` / `- id:` / `- run:` ...) carries the token gate
  const steps = yml
    .slice(yml.search(STEP_START_RE))
    .split(STEP_SPLIT_RE)
    .filter((s) => /^ {6}- \w+:/.test(s));
  const stepCount = (yml.match(STEP_START_RE) ?? []).length;
  expect(steps.length).toBe(stepCount);
  expect(stepCount).toBeGreaterThanOrEqual(4);
  for (const step of steps) expect(step).toContain(TOKEN_GATE);
  expect(yml.split(TOKEN_GATE).length - 1).toBe(stepCount);
});

it(SKIP_TITLE, () => {
  const yml = readFileSync(WORKFLOW, 'utf8');
  const gateStep = yml
    .slice(yml.indexOf(ACTION_USES))
    .split(STEP_SPLIT_RE)
    .find((st) => st.includes(NODE_CALL));
  expect(gateStep).toBeDefined();
  const gate = gateStep ?? '';
  const runAt = gate.search(/^\s+run:/m);
  expect(runAt).toBeGreaterThanOrEqual(0);
  const runText = gate.slice(runAt);

  expect(runText).toContain(PR_FILES_PATH);
  expect(runText).toContain(PR_FILES_CALL);
  expect(runText).toContain(SELF_WORKFLOW_PATH);
  expect(runText).toContain(EXIT_ZERO_CALL);
  expect(runText).toMatch(WARNING_RE);
  expect(runText).toMatch(SUMMARY_RE);
  expect(runText).toMatch(PR_COMMENT_RE);
  expect(runText).toMatch(SELF_IF_RE);

  const commentsAt = runText.indexOf(COMMENTS_PATH);
  expect(commentsAt).toBeGreaterThanOrEqual(0);
  for (const re of [WARNING_RE, SUMMARY_RE, PR_COMMENT_RE, SELF_IF_RE]) {
    expect(runText.search(re)).toBeLessThan(commentsAt);
  }
  expect(runText.indexOf(MANUAL_TEXT)).toBeLessThan(commentsAt);
  expect(runText.indexOf(PR_FILES_PATH)).toBeLessThan(commentsAt);
  expect(runText.indexOf(SELF_WORKFLOW_PATH)).toBeLessThan(commentsAt);
  expect(runText.indexOf(EXIT_ZERO_CALL)).toBeLessThan(commentsAt);
});

// ---- generated case table for pickVerdict -----------------------------------------------------
it('generated case table: pickVerdict returns the newest claude[bot] verdict at/after since, else none', () => {
  let state = GEN_SEED;
  const next = (bound: number): number => {
    state = (state * LCG_MULT + LCG_INC) % LCG_MOD;
    return Math.floor((state / LCG_MOD) * bound);
  };
  const sinceMs = Date.parse(SINCE);

  for (let c = 0; c < CASE_COUNT; c++) {
    const n = 1 + next(MAX_COMMENTS);
    const list: Comment[] = [];
    // distinct timestamps (index-scaled) so "newest" is unambiguous
    for (let i = 0; i < n; i++) {
      const login = next(AUTHOR_CHOICES) === 0 ? BOT : OTHER;
      const offsetMin = (next(OFFSET_RANGE_MIN) - OFFSET_RANGE_MIN / 2) * MAX_COMMENTS + i;
      const at = new Date(sinceMs + offsetMin * MS_PER_MINUTE).toISOString();
      const kind = next(BODY_CHOICES);
      const count = next(COUNT_RANGE);
      const body =
        kind === 0
          ? `**PASS(${count} findings)**`
          : kind === 1
            ? `**FAIL(${count} findings)** — round`
            : kind === 2
              ? `prose quoting round FAIL(${count}) only`
              : 'no verdict here';
      list.push(comment(login, at, body));
    }
    const eligible = list
      .filter(
        (m) =>
          m.user.login === BOT &&
          Date.parse(m.created_at) >= sinceMs &&
          VERDICT_RE.test(m.body),
      )
      .sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at));
    const expected = eligible[0];
    const got = pickVerdict(list, { since: SINCE, author: BOT });
    if (expected === undefined) {
      expect(got).toBeNull();
    } else {
      const m = VERDICT_RE.exec(expected.body);
      expect(got).not.toBeNull();
      expect(got?.comment.id).toBe(expected.id);
      expect(got?.verdict).toBe(m?.[1]);
      expect(got?.findings).toBe(Number(m?.[2]));
    }
  }
});
