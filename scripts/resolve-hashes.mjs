// PG-EOS · resolve-hashes.mjs — CLAUDE.md · GIT: a slice commit writes the literal placeholder
// `<this commit>` in docs/PROJECT_STATE.md, tasks/MASTER_BACKLOG.md, tasks/LANE_LOCKS.md and
// docs/CHANGELOG.md; the real hash is recorded later, in the NEXT task's commit. This script finds,
// for every line still carrying the placeholder, the commit on the current branch that introduced
// that line (`git blame`) and either writes its short hash in place (--write) or reports which
// placeholders were never resolved (--check).
//
// Modes (exactly one required):
//   --write   edit the files in place, replacing `<this commit>` with the introducing commit's
//             7-char short hash on every line where that commit is a real, committed one; a line
//             blame attributes to uncommitted work (the all-zero hash) is left untouched. No base
//             ref involved — --write always resolves whatever it can, unconditionally.
//   --check   no edits. Exits 1 and lists `file:line` for every STALE placeholder, 0 otherwise.
//
//             A placeholder is stale iff its introducing commit (a) is an ancestor of the base ref
//             and (b) is not HEAD. This is deliberately not "introducing commit != HEAD": on a
//             `pull_request` build, actions/checkout checks out a synthetic merge commit
//             (`refs/pull/N/merge`), so EVERY placeholder the PR's own lane commits legitimately
//             introduce would be attributed to those lane commits, not to that merge commit — a
//             naive "!= HEAD" check would turn every lane PR red. Restricting staleness to
//             placeholders already reachable from the base ref means: on a PR, the PR's own new
//             placeholders are fine (not yet on base) and old ones already on base are still
//             caught; on a push to main, the tip's own placeholders are fine and older ones are
//             still caught.
//
//             Base = $RESOLVE_BASE, default `origin/main` (needs a non-shallow checkout —
//             `fetch-depth: 0` in CI — or the ancestry walk can't see far enough back). If that ref
//             doesn't exist, falls back to `main`; if neither exists, prints a note and exits 0 —
//             there is nothing to compare against, so nothing can be called stale.
//
// Hashes always come from whatever is currently checked out (`git blame` walks HEAD + the working
// tree, no fixed ref): a rebase-merge rewrites lane hashes, so resolving against a fixed ref would
// go stale the moment history is rewritten. Resolving against "whatever HEAD is" does not.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PLACEHOLDER = '<this commit>';
const TARGET_FILES = [
  'docs/PROJECT_STATE.md',
  'tasks/MASTER_BACKLOG.md',
  'tasks/LANE_LOCKS.md',
  'docs/CHANGELOG.md',
];
const ALL_ZERO_SHA = '0'.repeat(40);

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts }).trim();
}

function repoRoot() {
  return git(['rev-parse', '--show-toplevel']);
}

function refExists(ref, root) {
  try {
    execFileSync('git', ['rev-parse', '-q', '--verify', ref], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The base ref to compare ancestry against, or null if none of the candidates exist. */
function resolveBase(root) {
  const primary = process.env.RESOLVE_BASE || 'origin/main';
  if (refExists(primary, root)) return primary;
  if (primary !== 'main' && refExists('main', root)) return 'main';
  return null;
}

/** True iff `sha` is an ancestor of (or equal to) `base`. */
function isAncestor(sha, base, root) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, base], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Full SHA of the line's introducing commit (blame, porcelain, one line), or null if blame has nothing to say. */
function introducingSha(root, relPath, lineNo) {
  let out;
  try {
    out = execFileSync(
      'git',
      ['blame', '--porcelain', '-L', `${lineNo},${lineNo}`, '--', relPath],
      { cwd: root, encoding: 'utf8' },
    );
  } catch {
    return null;
  }
  const first = out.split('\n', 1)[0];
  const sha = first.split(' ', 1)[0];
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

function findPlaceholderLines(content) {
  const lines = content.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(PLACEHOLDER)) hits.push(i + 1); // 1-based, matches git blame -L
  }
  return hits;
}

/** Every {relPath, lineNo} still carrying the placeholder, across all target files present on disk. */
function allPlaceholders(root) {
  const found = [];
  for (const relPath of TARGET_FILES) {
    let content;
    try {
      content = readFileSync(join(root, relPath), 'utf8');
    } catch {
      continue; // file not present — nothing to resolve there
    }
    for (const lineNo of findPlaceholderLines(content)) found.push({ relPath, lineNo });
  }
  return found;
}

function runWrite(root) {
  let resolved = 0;
  let uncommitted = 0;

  for (const relPath of TARGET_FILES) {
    const absPath = join(root, relPath);
    let content;
    try {
      content = readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }
    const lineNumbers = findPlaceholderLines(content);
    if (lineNumbers.length === 0) continue;

    const lines = content.split('\n');
    let changed = false;
    for (const lineNo of lineNumbers) {
      const sha = introducingSha(root, relPath, lineNo);
      if (sha === null || sha === ALL_ZERO_SHA) {
        uncommitted += 1;
        continue; // uncommitted work — leave the placeholder alone
      }
      lines[lineNo - 1] = lines[lineNo - 1].split(PLACEHOLDER).join(sha.slice(0, 7));
      resolved += 1;
      changed = true;
    }
    if (changed) writeFileSync(absPath, lines.join('\n'));
  }

  process.stdout.write(
    `resolve-hashes --write: ${resolved} placeholder(s) resolved, ${uncommitted} left (uncommitted work)\n`,
  );
  process.exit(0);
}

function runCheck(root) {
  const base = resolveBase(root);
  if (base === null) {
    process.stdout.write(
      'resolve-hashes --check: no base ref found (tried $RESOLVE_BASE/origin/main, main) — nothing to compare against, skipping\n',
    );
    process.exit(0);
  }

  const headSha = git(['rev-parse', 'HEAD']);
  const placeholders = allPlaceholders(root);

  let checked = 0;
  let uncommitted = 0;
  const stale = [];

  for (const { relPath, lineNo } of placeholders) {
    const sha = introducingSha(root, relPath, lineNo);
    if (sha === null || sha === ALL_ZERO_SHA) {
      uncommitted += 1;
      continue;
    }
    checked += 1;
    if (sha !== headSha && isAncestor(sha, base, root)) {
      stale.push(`${relPath}:${lineNo}`);
    }
  }

  if (stale.length > 0) {
    process.stdout.write(`resolve-hashes --check: ${stale.length} stale placeholder(s) (base ${base}):\n`);
    for (const loc of stale) process.stdout.write(`  ${loc}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `resolve-hashes --check: clean (base ${base}; ${checked} checked, ${uncommitted} pending uncommitted work)\n`,
  );
  process.exit(0);
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const check = args.includes('--check');
  if (write === check) {
    process.stderr.write('usage: resolve-hashes.mjs (--write|--check)\n');
    process.exit(2);
  }

  const root = repoRoot();
  if (write) runWrite(root);
  else runCheck(root);
}

main();
