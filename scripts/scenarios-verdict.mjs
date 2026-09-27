#!/usr/bin/env node
// PG-EOS · scenarios-verdict.mjs — G15 (doc 40 Part F) verdict over a Playwright JSON report of
// tests/scenarios (S1–S20, doc 40 Part E). One reader for scripts/guards-run.sh, CI gate ④ and nightly.
//
// Semantics (ADR-0005 / docs/STREAMS.md §G15, 2026-09-27):
//   · doc 40 Part E: "All 20 (S1-S20) must pass before any production deploy" → --strict (deploy,
//     PG_GUARDS_STRICT=1): every scenario present AND passed, else red.
//   · Merge gate (default): a scenario that is RED because its doc-38 rows are not built yet is the
//     build plan, not a regression. Only the scenarios listed in tests/scenarios/green.json ("green":
//     the Master adds an id when its row closes DONE) must be present and passing; a listed scenario
//     that is missing or failing is red — a regression blocks merge. Everything else is reported.
//
// Usage: node scripts/scenarios-verdict.mjs <playwright-report.json> [--strict] [--manifest <path>]
// stdout line 1: `green` | `red:<why>`   line 2: `S1..S20: <present>/20 present, <passed>/20 passed;
//   expected green: <ok>/<listed>[; failing: ...][; missing: ...]`. Exit 0 on green, 1 on red, 2 on usage.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCENARIO_MIN = 1;
const SCENARIO_MAX = 20;
const EXIT_GREEN = 0;
const EXIT_RED = 1;
const EXIT_USAGE = 2;

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const manifestIdx = args.indexOf('--manifest');
const manifestPath =
  manifestIdx >= 0 ? args[manifestIdx + 1] : resolve('tests/scenarios/green.json');
const reportPath = args.find((a, i) => !a.startsWith('--') && (i === 0 || args[i - 1] !== '--manifest'));

if (!reportPath) {
  process.stderr.write('usage: scenarios-verdict.mjs <playwright-report.json> [--strict] [--manifest <path>]\n');
  process.exit(EXIT_USAGE);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** @returns {Map<number, boolean>} scenario number → every spec of it passed */
export function scenarioStatus(report) {
  const seen = new Map();
  const walk = (suite) => {
    for (const s of suite.suites ?? []) walk(s);
    for (const spec of suite.specs ?? []) {
      const m = /\bS(\d{1,2})\b/.exec(`${spec.title} ${spec.file ?? ''} ${suite.title ?? ''} ${suite.file ?? ''}`);
      if (!m) continue;
      const n = Number(m[1]);
      if (n < SCENARIO_MIN || n > SCENARIO_MAX) continue;
      const ok =
        spec.ok === true ||
        (spec.tests ?? []).every((t) => (t.results ?? []).some((r) => r.status === 'passed'));
      seen.set(n, (seen.get(n) ?? true) && ok);
    }
  };
  for (const s of report.suites ?? []) walk(s);
  return seen;
}

/** @returns {{ verdict: string, summary: string }} */
export function verdict(report, manifest, strictMode) {
  const seen = scenarioStatus(report);
  const missing = [];
  const failed = [];
  for (let n = SCENARIO_MIN; n <= SCENARIO_MAX; n++) {
    if (!seen.has(n)) missing.push(`S${n}`);
    else if (!seen.get(n)) failed.push(`S${n}`);
  }
  const passed = [...seen.values()].filter(Boolean).length;
  const listed = [...new Set((manifest.green ?? []).map(String))].sort(
    (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
  );
  const listedMissing = listed.filter((id) => missing.includes(id));
  const listedFailed = listed.filter((id) => failed.includes(id));
  const listedOk = listed.length - listedMissing.length - listedFailed.length;

  const counts = `S1..S20: ${seen.size}/20 present, ${passed}/20 passed; expected green: ${listedOk}/${listed.length}`;
  const detail =
    (listedFailed.length ? `; failing: ${listedFailed.join(',')}` : '') +
    (listedMissing.length ? `; missing: ${listedMissing.join(',')}` : '');
  const summary = counts + detail;

  if (strictMode) {
    if (!missing.length && !failed.length) return { verdict: 'green', summary };
    return {
      verdict:
        `red:strict (deploy) needs 20/20 — ${seen.size}/20 present, ${passed}/20 passed` +
        (missing.length ? `; missing ${missing.join(',')}` : '') +
        (failed.length ? `; failed ${failed.join(',')}` : ''),
      summary,
    };
  }
  if (listedFailed.length || listedMissing.length) {
    return {
      verdict:
        `red:regression — a scenario listed green in tests/scenarios/green.json is ` +
        (listedFailed.length ? `failing (${listedFailed.join(',')})` : '') +
        (listedFailed.length && listedMissing.length ? ' and ' : '') +
        (listedMissing.length ? `missing (${listedMissing.join(',')})` : ''),
      summary,
    };
  }
  return { verdict: 'green', summary };
}

let report;
try {
  report = readJson(reportPath);
} catch {
  process.stdout.write('red:no playwright JSON report (did it run?)\nS1..S20: report unreadable\n');
  process.exit(EXIT_RED);
}
let manifest;
try {
  manifest = readJson(manifestPath);
} catch {
  process.stdout.write(`red:manifest ${manifestPath} unreadable\nS1..S20: manifest unreadable\n`);
  process.exit(EXIT_RED);
}
if (!Array.isArray(manifest.green)) {
  process.stdout.write(`red:manifest ${manifestPath} has no "green" array\nS1..S20: manifest invalid\n`);
  process.exit(EXIT_RED);
}

const out = verdict(report, manifest, strict);
process.stdout.write(`${out.verdict}\n${out.summary}\n`);
process.exit(out.verdict === 'green' ? EXIT_GREEN : EXIT_RED);
