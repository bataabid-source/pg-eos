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
const FAIL_PLAIN_BODY = '**FAIL(4 findings)** — pg-reviewer, round 2 — 1. file:1 breaks a rule';
const FAIL_SECURITY_BODY = [
  '**FAIL(4 findings)** — pg-reviewer, round 2',
  '1. [security: RLS] table has no policy',
  '2. **[Security — audit chain]** hash skipped',
  '3. file:1 breaks a rule',
  '4. file:2 nit',
  'Checked and clean: no `[security]` finding elsewhere',
].join('\n');
const FAIL_MIDLINE_BODY = [
  '**FAIL(2 findings)** — pg-reviewer, round 2',
  '1. file:1 breaks a rule, not a [security] one',
  '2. `[security]` is only quoted in a code span here',
].join('\n');
const FAIL_PROSE_WORDS_BODY =
  '**FAIL(2 findings)** — pg-reviewer — 1. file:1 breaks a rule 2. file:2 nit. Checked and clean: RLS policies, permissions, audit chain, no secrets.';
const SECURITY_TAG_RE = /^\s*(?:\d+[.)]|[-*])?\s*\**\[security\b[^\]\n]*\]/gim;
const SECURITY_COUNT = (FAIL_SECURITY_BODY.match(SECURITY_TAG_RE) ?? []).length;
const RED_SECURITY_PREFIX = `red:FAIL(4 findings, ${SECURITY_COUNT} security)`;
const REPORT_PREFIX = 'report:FAIL(4 findings)';
const WARNING_LINE_HEAD = '::warning title=review: FAIL(4 findings) report-only (D-206)::';
const PROSE_FAIL_PREFIX = 'report:FAIL(2 findings)';
const FAIL_2_WARNING_HEAD = '::warning title=review: FAIL(2 findings) report-only (D-206)::';
const PROMPT_START = 'prompt: |';
const PROMPT_END = 'claude_args:';
const SECURITY_TAG = '[security]';
const SECURITY_WORDS = ['RLS', 'audit chain', 'secrets', 'permissions'];
const PROSE_BODY = 'Master note: pg-reviewer said round 2 FAIL(4) so I am fixing it.';
const HTML_URL_BASE = 'https://github.com/premium/pg-eos/pull/1#issuecomment-';
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
const EXIT_ONE_RE = /^\s*exit 1\s*$/m;
const HEAD_SHA_RE = /head \$SHA/;
const WARNING_ANNOTATION = '::warning';
const SKIP_TITLE =
  'the verdict gate is skipped on a PR that edits claude-review.yml itself: ::error + step summary + a `review: MANUAL` PR comment naming the head SHA, exit 1 (the review check is red on purpose — the action does not run on such a PR, manual review by the Master)';
const MANUAL_TEXT = 'review: MANUAL';
const MANUAL_WINDOW = 300;
const ERROR_RE = /::error[^\n]*review: MANUAL/;
const RED_WORD_RE = /\bred\b/i;
const MANUAL_REVIEW_RE = /manual review/i;
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
const BODY_CHOICES = 5;
const TAGGED_KIND = 4;
const MAX_TAGS = 3;
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
  const page1 = [comment(OTHER, AFTER_1, PROSE_BODY), comment(BOT, BEFORE, FAIL_PLAIN_BODY)];
  const page2 = [comment(BOT, AFTER_2, PASS_BODY)];
  const slurped = writeRaw([page1, page2]);
  const s = run([slurped, '--since', SINCE]);
  expect(firstLine(s.stdout)).toBe('green');
  expect(s.status).toBe(EXIT_GREEN);
});

it('a FAIL verdict carrying [security] tags prints red:FAIL(<n> findings, <k> security) and exits 1', () => {
  const failing = comment(BOT, AFTER_1, FAIL_SECURITY_BODY);
  const file = writeComments([failing]);
  const r = run([file, '--since', SINCE]);
  const line = firstLine(r.stdout);
  expect(SECURITY_COUNT).toBe(2);
  expect(line.startsWith(RED_SECURITY_PREFIX)).toBe(true);
  expect(line).toContain(failing.html_url);
  expect(r.status).toBe(EXIT_RED);
});

it('a FAIL verdict without a security tag prints report:FAIL(<n> findings), a ::warning annotation naming D-206 and exits 0', () => {
  const failing = comment(BOT, AFTER_1, FAIL_PLAIN_BODY);
  const file = writeComments([failing]);
  const r = run([file, '--since', SINCE]);
  const lines = r.stdout.split('\n');
  expect(lines[0]).toBe(`${REPORT_PREFIX} — ${failing.html_url}`);
  expect(lines[1]).toBe(`${WARNING_LINE_HEAD}${failing.html_url}`);
  expect(r.status).toBe(EXIT_GREEN);
});

it('bare words such as no secrets or RLS in prose without the [security] tag do not turn a FAIL red', () => {
  const failing = comment(BOT, AFTER_1, FAIL_PROSE_WORDS_BODY);
  const r = run([writeComments([failing]), '--since', SINCE]);
  const lines = r.stdout.split('\n');
  expect(lines[0]).toBe(`${PROSE_FAIL_PREFIX} — ${failing.html_url}`);
  expect(lines[1]).toBe(`${FAIL_2_WARNING_HEAD}${failing.html_url}`);
  expect(r.status).toBe(EXIT_GREEN);
});

it('a FAIL whose only [security] mention is mid-line or inside backticks stays report-only and exits 0', () => {
  const failing = comment(BOT, AFTER_1, FAIL_MIDLINE_BODY);
  const r = run([writeComments([failing]), '--since', SINCE]);
  const lines = r.stdout.split('\n');
  expect(lines[0]).toBe(`${PROSE_FAIL_PREFIX} — ${failing.html_url}`);
  expect(lines[1]).toBe(`${FAIL_2_WARNING_HEAD}${failing.html_url}`);
  expect(r.status).toBe(EXIT_GREEN);
  const picked = pickVerdict([failing], { since: SINCE, author: BOT });
  expect(picked?.security).toBe(0);
});

it('pickVerdict also returns the security count of [security] tags in the verdict body', () => {
  const tagged = pickVerdict([comment(BOT, AFTER_1, FAIL_SECURITY_BODY)], { since: SINCE, author: BOT });
  expect(tagged?.security).toBe(SECURITY_COUNT);
  const plain = pickVerdict([comment(BOT, AFTER_1, FAIL_PLAIN_BODY)], { since: SINCE, author: BOT });
  expect(plain?.security).toBe(0);
  const midline = pickVerdict([comment(BOT, AFTER_1, FAIL_MIDLINE_BODY)], { since: SINCE, author: BOT });
  expect(midline?.security).toBe(0);
  const prose = pickVerdict([comment(BOT, AFTER_1, FAIL_PROSE_WORDS_BODY)], { since: SINCE, author: BOT });
  expect(prose?.security).toBe(0);
  const pass = pickVerdict([comment(BOT, AFTER_1, PASS_BODY)], { since: SINCE, author: BOT });
  expect(pass?.security).toBe(0);
});

it('the newest verdict wins when an older PASS and a newer FAIL both exist, and vice versa', () => {
  const passOld = comment(BOT, AFTER_1, PASS_BODY);
  const failNew = comment(BOT, AFTER_2, FAIL_SECURITY_BODY);
  // array order deliberately newest-first: the script must sort by created_at, not by position
  const a = run([writeComments([failNew, passOld]), '--since', SINCE]);
  expect(firstLine(a.stdout).startsWith(RED_SECURITY_PREFIX)).toBe(true);
  expect(a.status).toBe(EXIT_RED);

  const failOld = comment(BOT, AFTER_1, FAIL_PLAIN_BODY);
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

it('the claude-review.yml prompt tells the bot to mark each security finding (RLS, audit chain, secrets, permissions) with the tag [security]', () => {
  const yml = readFileSync(WORKFLOW, 'utf8');
  const start = yml.indexOf(PROMPT_START);
  const end = yml.indexOf(PROMPT_END, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const prompt = yml.slice(start, end);
  expect(prompt).toContain(SECURITY_TAG);
  for (const word of SECURITY_WORDS) expect(prompt).toContain(word);
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
  expect(runText).toMatch(EXIT_ONE_RE);
  expect(runText).toMatch(ERROR_RE);
  expect(runText).toMatch(SUMMARY_RE);
  expect(runText).toMatch(PR_COMMENT_RE);
  expect(runText).toMatch(SELF_IF_RE);

  const commentsAt = runText.indexOf(COMMENTS_PATH);
  expect(commentsAt).toBeGreaterThanOrEqual(0);
  for (const re of [ERROR_RE, SUMMARY_RE, PR_COMMENT_RE, SELF_IF_RE]) {
    expect(runText.search(re)).toBeLessThan(commentsAt);
  }
  expect(runText.indexOf(MANUAL_TEXT)).toBeLessThan(commentsAt);
  expect(runText.indexOf(PR_FILES_PATH)).toBeLessThan(commentsAt);
  expect(runText.indexOf(SELF_WORKFLOW_PATH)).toBeLessThan(commentsAt);
  expect(runText.search(EXIT_ONE_RE)).toBeLessThan(commentsAt);

  // a self-edit is never downgraded to a warning, and the comment says the check is red on purpose
  const selfEditBlock = runText.slice(0, commentsAt);
  expect(selfEditBlock).not.toContain(WARNING_ANNOTATION);
  expect(selfEditBlock).toMatch(RED_WORD_RE);
  expect(selfEditBlock).toMatch(MANUAL_REVIEW_RE);
  expect(selfEditBlock).toMatch(HEAD_SHA_RE);
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
    const tagsById = new Map<number, number>();
    // distinct timestamps (index-scaled) so "newest" is unambiguous
    for (let i = 0; i < n; i++) {
      const login = next(AUTHOR_CHOICES) === 0 ? BOT : OTHER;
      const offsetMin = (next(OFFSET_RANGE_MIN) - OFFSET_RANGE_MIN / 2) * MAX_COMMENTS + i;
      const at = new Date(sinceMs + offsetMin * MS_PER_MINUTE).toISOString();
      const kind = next(BODY_CHOICES);
      const count = next(COUNT_RANGE);
      const tags = kind === TAGGED_KIND ? 1 + next(MAX_TAGS) : 0;
      const taggedLines = Array.from({ length: tags }, (_, t) => `${t + 1}. [security] finding ${t + 1}`);
      const body =
        kind === TAGGED_KIND
          ? [`**FAIL(${count} findings)** — round`, ...taggedLines].join('\n')
          : kind === 0
          ? `**PASS(${count} findings)**`
          : kind === 1
            ? `**FAIL(${count} findings)** — round`
            : kind === 2
              ? `prose quoting round FAIL(${count}) only`
              : 'no verdict here';
      const made = comment(login, at, body);
      tagsById.set(made.id, tags);
      list.push(made);
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
      expect(got?.security).toBe(tagsById.get(expected.id));
    }
  }
});
