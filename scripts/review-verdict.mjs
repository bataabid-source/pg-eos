#!/usr/bin/env node
// PG-EOS · review-verdict.mjs — verdict reader for the `review` CI check (.github/workflows/claude-review.yml).
// The pg-reviewer posts ONE top-level PR comment `PASS(<n> findings)` or `FAIL(<n> findings)`; this script
// turns that comment into the job result. D-206 (GM 2026-09-30): the bot review is REPORT-ONLY — its findings
// become backlog rows, it never starts a fix round, and `review` blocks a merge only on a security finding.
//
// Semantics (X part 18, 2026-09-29):
//   · Input: the GitHub issue-comments JSON — a flat array, or the pages of `gh api --paginate --slurp`
//     (an array of arrays, flattened one level).
//   · Only comments by --author (default claude[bot]) created at or after --since count; verdicts quoted
//     in prose by anyone else, and older comments, are ignored.
//   · The NEWEST such comment whose body matches VERDICT_RE decides.
//   · PASS → green. FAIL carrying >= 1 `[security...]` tag (RLS, audit chain, secrets, permissions — the bot
//     tags each such finding per its prompt, at the START of the finding line after an optional number/bullet
//     and `**`; a tag quoted mid-line or in a code span, and bare words in prose, do not count) → red.
//   · FAIL with no security tag → report-only (D-206): `report:FAIL(...)` plus a ::warning annotation, exit 0.
//   · No such comment (the action ran but posted nothing) → red: a broken review is never a silent green.
//
// Usage: node scripts/review-verdict.mjs <comments.json> --since <ISO-8601> [--author <login>]
// stdout line 1: `green` | `red:FAIL(<n> findings, <k> security) — <comment url>` | `report:FAIL(<n> findings) — <comment url>`
//   | `red:no verdict comment by <author> since <since>`
//   report-only: line 2 is `::warning title=review: FAIL(<n> findings) report-only (D-206)::<url>`.
//   last line: `review: <k> comment(s) by <author> since <since>; verdict <PASS|FAIL|none>`.
// Exit 0 on green or report-only, 1 on red, 2 on usage or an unreadable file.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const EXIT_GREEN = 0;
const EXIT_RED = 1;
const EXIT_USAGE = 2;
const DEFAULT_AUTHOR = 'claude[bot]';
const VERDICT_RE = /\b(PASS|FAIL)\((\d+) findings?\)/;
const SECURITY_TAG_RE = /^\s*(?:\d+[.)]|[-*])?\s*\**\[security\b[^\]\n]*\]/gim;
const USAGE = 'usage: review-verdict.mjs <comments.json> --since <ISO-8601> [--author <login>]\n';
const ARGV_OFFSET = 2;
const FLAG_SINCE = '--since';
const FLAG_AUTHOR = '--author';

function flatten(comments) {
  return Array.isArray(comments[0]) ? comments.flat() : comments;
}

function eligible(comments, since, author) {
  const sinceMs = Date.parse(since);
  return flatten(comments)
    .filter((c) => c?.user?.login === author && Date.parse(c.created_at) >= sinceMs)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

/**
 * @param {ReadonlyArray<object> | ReadonlyArray<ReadonlyArray<object>>} comments
 * @param {{ since: string, author?: string }} opts
 * @returns {{ verdict: 'PASS' | 'FAIL', findings: number, security: number, comment: object } | null}
 */
export function pickVerdict(comments, { since, author = DEFAULT_AUTHOR }) {
  for (const comment of eligible(comments, since, author)) {
    const body = comment.body ?? '';
    const m = VERDICT_RE.exec(body);
    if (m) return { verdict: m[1], findings: Number(m[2]), security: (body.match(SECURITY_TAG_RE) ?? []).length, comment };
  }
  return null;
}

function usageExit(message) {
  process.stderr.write(`${message ? `${message}\n` : ''}${USAGE}`);
  process.exit(EXIT_USAGE);
}

function main() {
  const args = process.argv.slice(ARGV_OFFSET);
  const valueOf = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const since = valueOf(FLAG_SINCE);
  const author = valueOf(FLAG_AUTHOR) ?? DEFAULT_AUTHOR;
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== FLAG_SINCE && args[i - 1] !== FLAG_AUTHOR);
  if (!file || !since || Number.isNaN(Date.parse(since))) usageExit('missing <comments.json> or a valid --since');

  let comments;
  try {
    comments = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    usageExit(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(comments)) usageExit(`${file} is not a JSON array of comments`);

  const count = eligible(comments, since, author).length;
  const picked = pickVerdict(comments, { since, author });
  const summary = `review: ${count} comment(s) by ${author} since ${since}; verdict ${picked ? picked.verdict : 'none'}\n`;
  if (!picked) {
    process.stdout.write(`red:no verdict comment by ${author} since ${since}\n${summary}`);
    process.exit(EXIT_RED);
  }
  if (picked.verdict === 'PASS') {
    process.stdout.write(`green\n${summary}`);
    process.exit(EXIT_GREEN);
  }
  const url = picked.comment.html_url ?? '';
  if (picked.security > 0) {
    process.stdout.write(`red:FAIL(${picked.findings} findings, ${picked.security} security) — ${url}\n${summary}`);
    process.exit(EXIT_RED);
  }
  const title = `review: FAIL(${picked.findings} findings) report-only (D-206)`;
  process.stdout.write(`report:FAIL(${picked.findings} findings) — ${url}\n::warning title=${title}::${url}\n${summary}`);
  process.exit(EXIT_GREEN);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
