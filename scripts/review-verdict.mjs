#!/usr/bin/env node
// PG-EOS · review-verdict.mjs — verdict reader for the `review` CI check (.github/workflows/claude-review.yml).
// The pg-reviewer posts ONE top-level PR comment `PASS(<n> findings)` or `FAIL(<n> findings)`; this script
// turns that comment into the job result, so a green `review` can be read as PASS by the merge queue.
//
// Semantics (X part 18, 2026-09-29):
//   · Input: the GitHub issue-comments JSON — a flat array, or the pages of `gh api --paginate --slurp`
//     (an array of arrays, flattened one level).
//   · Only comments by --author (default claude[bot]) created at or after --since count; verdicts quoted
//     in prose by anyone else, and older comments, are ignored.
//   · The NEWEST such comment whose body matches VERDICT_RE decides: PASS → green, FAIL → red.
//   · No such comment (the action ran but posted nothing) → red: a broken review is never a silent green.
//
// Usage: node scripts/review-verdict.mjs <comments.json> --since <ISO-8601> [--author <login>]
// stdout line 1: `green` | `red:FAIL(<n> findings) — <comment url>` | `red:no verdict comment by <author> since <since>`
//   line 2: `review: <k> comment(s) by <author> since <since>; verdict <PASS|FAIL|none>`.
// Exit 0 on green, 1 on red, 2 on usage or an unreadable file.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const EXIT_GREEN = 0;
const EXIT_RED = 1;
const EXIT_USAGE = 2;
const DEFAULT_AUTHOR = 'claude[bot]';
const VERDICT_RE = /\b(PASS|FAIL)\((\d+) findings?\)/;
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
 * @returns {{ verdict: 'PASS' | 'FAIL', findings: number, comment: object } | null}
 */
export function pickVerdict(comments, { since, author = DEFAULT_AUTHOR }) {
  for (const comment of eligible(comments, since, author)) {
    const m = VERDICT_RE.exec(comment.body ?? '');
    if (m) return { verdict: m[1], findings: Number(m[2]), comment };
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
  process.stdout.write(`red:FAIL(${picked.findings} findings) — ${picked.comment.html_url ?? ''}\n${summary}`);
  process.exit(EXIT_RED);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
