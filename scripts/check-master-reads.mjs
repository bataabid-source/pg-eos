#!/usr/bin/env node
// PG-EOS · check-master-reads.mjs — D-210 item 4: "Master reads nothing inline (D-201 enforced): PR
// bodies, packets, backlog and CHANGELOG are read only through subagents with <= 20-line returns."
//
// Why a REPORT and not a PreToolUse hook: a hook cannot tell the Master's own read from its subagent's
// read (same session, same hooks). The session transcript can: subagent entries carry isSidechain.
//
// Semantics:
//   · Main thread = a transcript entry without `isSidechain === true`.
//   · A governed inline read is a main-thread tool_use that reads governed content:
//       Read (input.file_path) | Grep with output_mode 'content' (input.path) | Bash |
//       mcp__github__pull_request_read with method 'get'.
//     Bash: the command is split into simple commands on ; | && || & newline ( ) and backticks
//       (`$(` counts as `(`) AFTER heredoc bodies (`<<[-]TAG` .. line `TAG`) are dropped and quoted
//       spans are replaced by a placeholder (a quoted span that is itself a governed path, and the list
//       of `--json`, are kept), so text inside `-m "..."` never counts. Per simple command, leading NAME=value words are skipped; the first word
//       must be a read verb (cat head tail less grep sed, or git [-C dir] [--no-pager] show|diff) with
//       a right boundary (`category` is not `cat`); sed with an in-place option (-i, -[a-z]*i,
//       --in-place) is a write and never counts (every option token is scanned, skipping the argument
//       of -e/-f/--expression/--file); a redirect target (the token after `>` or `>>`) is never an
//       argument; and an argument token (split on whitespace, quotes, < : = and `(`) must end with a
//       governed path. `gh pr view` counts only as the first word of a simple command (after NAME=value
//       skips) unless it carries --json <list> (trimmed) without `body`.
//     Governed paths (path-suffix match): docs/CHANGELOG.md, tasks/MASTER_BACKLOG.md,
//     docs/notes/handover-*.md.
//   · overLimit: main-thread tool_results with more than maxLines lines (one trailing newline is not a
//     line), paired by a non-empty tool_use_id to a counted read or to a main-thread Agent/Task
//     tool_use (subagent returns are <= 20 lines). A tool_use without id / a result without
//     tool_use_id never pairs.
//   · Options: --max-lines needs /^\d+$/; an unknown option, or a JSONL line that is not a JSON object,
//     is a usage error.
//
// Usage: node scripts/check-master-reads.mjs <session.jsonl> [--strict] [--max-lines N]
// stdout line 1: `master-reads: <n> inline read(s) of governed content in <k> main-thread tool calls;
//   <m> result(s) over <N> lines`, then `<line#> <tool> <target>` per read. Exit 0 (report);
//   --strict: 1 when n > 0; 2 on usage (missing/unreadable file, line that is not JSON, bad option).

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const EXIT_OK = 0;
const EXIT_FINDING = 1;
const EXIT_USAGE = 2;
const DEFAULT_MAX_LINES = 20;
const USAGE = 'usage: check-master-reads.sh <session.jsonl> [--strict] [--max-lines N]';
const GOVERNED_SUFFIXES = ['docs/CHANGELOG.md', 'tasks/MASTER_BACKLOG.md'];
const HANDOVER_SUFFIX_RE = /(^|\/)docs\/notes\/handover-[^/\s'"]*\.md$/;
const SEPARATOR_RE = /[;|&\n()`]/;
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;
const READ_VERB_RE = /^(?:(?:cat|head|tail|less|grep|sed)(?![\w-])|git\s+(?:(?:-C\s+\S+|--no-pager)\s+)*(?:show|diff)(?![\w-]))/;
const SED_VERB_RE = /^sed(?![\w-])/;
const IN_PLACE_RE = /^(?:-[a-zA-Z]*i|--in-place)/;
const SED_ARG_OPTIONS = ['-e', '-f', '--expression', '--file'];
const REDIRECT_RE = /\d*>>?\s*\S+/g;
const HEREDOC_RE = /(<<-?\s*(['"]?)([A-Za-z_]\w*)\2)([^\n]*\n)[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g;
const QUOTED_SPAN_RE = /'([^']*)'|"([^"]*)"/g;
const JSON_QUOTED_RE = /--json(?:=|\s+)(?:'([^']*)'|"([^"]*)")/g;
const QUOTE_PLACEHOLDER = '_q_';
const ARG_DELIMITER_RE = /[\s'"<>:=(]+/;
const GH_PR_VIEW_RE = /^gh\s+pr\s+view\b/;
const JSON_FLAG_RE = /--json(?:=|\s+)(?:'([^']*)'|"([^"]*)"|(\S+))/;
const DIGITS_RE = /^\d+$/;
const TRAILING_NEWLINE_RE = /\n$/;
const BODY_FIELD = 'body';
const TOOL_READ = 'Read';
const TOOL_GREP = 'Grep';
const TOOL_BASH = 'Bash';
const TOOL_PR_READ = 'mcp__github__pull_request_read';
const PR_READ_TARGET = 'pull_request_read get';
const PR_METHOD_GET = 'get';
const GREP_CONTENT_MODE = 'content';
const SUBAGENT_TOOLS = ['Agent', 'Task'];

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');

function isGovernedPath(p) {
  if (p.length === 0) return false;
  return GOVERNED_SUFFIXES.some((s) => p === s || p.endsWith(`/${s}`)) || HANDOVER_SUFFIX_RE.test(p);
}

function sedIsInPlace(command) {
  const toks = command.split(/\s+/).slice(1);
  for (let i = 0; i < toks.length; i += 1) {
    const tok = toks[i];
    if (!tok.startsWith('-')) continue;
    if (IN_PLACE_RE.test(tok)) return true;
    if (SED_ARG_OPTIONS.includes(tok)) i += 1;
  }
  return false;
}

function stripNoise(command) {
  return command
    .replace(HEREDOC_RE, (_m, op, _q, _tag, rest) => `${op}${rest}`)
    .replace(JSON_QUOTED_RE, (_m, a, b) => `--json=${(a ?? b ?? '').replace(/\s+/g, '')}`)
    .replace(QUOTED_SPAN_RE, (_m, a, b) => {
      const inner = a ?? b ?? '';
      return isGovernedPath(inner.trim()) ? ` ${inner.trim()} ` : QUOTE_PLACEHOLDER;
    });
}

function simpleCommandReads(cmd) {
  const verb = READ_VERB_RE.exec(cmd);
  if (verb === null) return false;
  if (SED_VERB_RE.test(cmd) && sedIsInPlace(cmd)) return false;
  return cmd
    .slice(verb[0].length)
    .replace(REDIRECT_RE, ' ')
    .split(ARG_DELIMITER_RE)
    .some((t) => isGovernedPath(t));
}

function ghPrViewCounted(cmd) {
  if (!GH_PR_VIEW_RE.test(cmd)) return false;
  const m = JSON_FLAG_RE.exec(cmd);
  if (m === null) return true;
  const list = m[1] ?? m[2] ?? m[3] ?? '';
  return list.split(',').map((f) => f.trim()).includes(BODY_FIELD);
}

function bashCounted(command) {
  const segments = stripNoise(command).split(SEPARATOR_RE);
  return segments.some((s) => {
    let cmd = s.trim();
    while (ASSIGNMENT_RE.test(cmd)) cmd = cmd.replace(ASSIGNMENT_RE, '');
    return ghPrViewCounted(cmd) || simpleCommandReads(cmd);
  });
}

/** Returns the target string when the tool_use is a governed inline read, else null. */
function governedTarget(name, input) {
  if (!isRecord(input)) return null;
  if (name === TOOL_READ) {
    const p = str(input.file_path);
    return isGovernedPath(p) ? p : null;
  }
  if (name === TOOL_GREP) {
    const p = str(input.path);
    return input.output_mode === GREP_CONTENT_MODE && isGovernedPath(p) ? p : null;
  }
  if (name === TOOL_BASH) {
    const c = str(input.command);
    return bashCounted(c) ? c : null;
  }
  if (name === TOOL_PR_READ) return input.method === PR_METHOD_GET ? PR_READ_TARGET : null;
  return null;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (isRecord(c) ? str(c.text) : ''))
    .filter((t) => t.length > 0)
    .join('\n');
}

/**
 * @param {ReadonlyArray<unknown>} entries parsed transcript entries, in file order
 * @param {{ maxLines: number }} opts
 */
export function countMasterReads(entries, { maxLines }) {
  const reads = [];
  const watched = new Set();
  let mainCalls = 0;
  let overLimit = 0;
  const results = [];
  const watch = (id) => {
    if (typeof id === 'string' && id.length > 0) watched.add(id);
  };
  entries.forEach((entry, index) => {
    if (!isRecord(entry) || entry.isSidechain === true) return;
    const message = entry.message;
    const content = isRecord(message) ? message.content : undefined;
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === 'tool_use') {
        mainCalls += 1;
        const name = str(item.name);
        const target = governedTarget(name, item.input);
        if (target !== null) {
          reads.push({ line: index + 1, tool: name, target });
          watch(item.id);
        } else if (SUBAGENT_TOOLS.includes(name)) {
          watch(item.id);
        }
      } else if (item.type === 'tool_result') {
        results.push({ id: str(item.tool_use_id), text: resultText(item.content) });
      }
    }
  });
  for (const r of results) {
    if (r.id.length === 0 || !watched.has(r.id)) continue;
    if (r.text.replace(TRAILING_NEWLINE_RE, '').split('\n').length > maxLines) overLimit += 1;
  }
  return { reads, mainCalls, overLimit };
}

function parseArgs(argv) {
  let file = null;
  let strict = false;
  let maxLines = DEFAULT_MAX_LINES;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--strict') strict = true;
    else if (a === '--max-lines') {
      const raw = argv[i + 1];
      if (raw === undefined || !DIGITS_RE.test(raw)) return null;
      maxLines = Number(raw);
      i += 1;
    } else if (a.startsWith('--') || file !== null) return null;
    else file = a;
  }
  return file === null ? null : { file, strict, maxLines };
}

function loadEntries(file) {
  const entries = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().length === 0) {
      entries.push(null);
      continue;
    }
    const parsed = JSON.parse(line);
    if (!isRecord(parsed)) throw new Error('not an object');
    entries.push(parsed);
  }
  return entries;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts === null) {
    process.stderr.write(`${USAGE}\n`);
    return EXIT_USAGE;
  }
  let entries;
  try {
    entries = loadEntries(opts.file);
  } catch {
    process.stderr.write(`${USAGE}\n`);
    return EXIT_USAGE;
  }
  const { reads, mainCalls, overLimit } = countMasterReads(entries, { maxLines: opts.maxLines });
  const out = [
    `master-reads: ${reads.length} inline read(s) of governed content in ${mainCalls} main-thread tool calls; ${overLimit} result(s) over ${opts.maxLines} lines`,
    ...reads.map((r) => `${r.line} ${r.tool} ${r.target}`),
  ];
  process.stdout.write(`${out.join('\n')}\n`);
  return opts.strict && reads.length > 0 ? EXIT_FINDING : EXIT_OK;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
