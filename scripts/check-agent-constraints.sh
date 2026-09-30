#!/usr/bin/env bash
# PG-EOS · check-agent-constraints.sh — the AGENT CONSTRAINTS block is "copied verbatim into every
# agent file — gate ①" (CLAUDE.md · AGENT CONSTRAINTS); this script proves the copy (X part 17).
#   usage: bash scripts/check-agent-constraints.sh [--root <dir>]   (default: the repo root)
#   exit 0 = CLAUDE.md's block and the four agent copies are byte-identical
#   exit 1 = a copy differs, or an agent file / CLAUDE.md has no block (each named on stderr)
#   exit 2 = bad usage
#
# A block = the line starting with `AGENT CONSTRAINTS` plus every following line up to, not
# including, the first blank line. Compared byte for byte (cmp), no whitespace folding.
# Run by: tests/hooks/run.sh, which CI gate ① runs.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BLOCK_HEAD='AGENT CONSTRAINTS'
AGENT_FILES="pg-tester.md pg-builder.md pg-builder-core.md pg-reviewer.md"

usage() { echo "usage: bash scripts/check-agent-constraints.sh [--root <dir>]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --root) [ $# -ge 2 ] || usage; ROOT="$2"; shift 2 ;;
    *) usage ;;
  esac
done

fail=0
err() { echo "check-agent-constraints: VIOLATION — $1" >&2; fail=1; }

# block <file> → prints the block; returns 1 when the file has none
block() {
  awk -v head="$BLOCK_HEAD" '
    !on && index($0, head) == 1 { on = 1 }
    on && $0 == "" { exit }
    on { print; found = 1 }
    END { exit found ? 0 : 1 }
  ' "$1"
}

CLAUDE_MD="$ROOT/CLAUDE.md"
ref="$(block "$CLAUDE_MD" 2>/dev/null)" || { err "$CLAUDE_MD has no AGENT CONSTRAINTS block"; exit 1; }

for a in $AGENT_FILES; do
  f="$ROOT/.claude/agents/$a"
  if [ ! -f "$f" ]; then err "$f missing"; continue; fi
  copy="$(block "$f")" || { err "$f has no AGENT CONSTRAINTS block"; continue; }
  cmp -s <(printf '%s\n' "$ref") <(printf '%s\n' "$copy") \
    || err "$f: AGENT CONSTRAINTS block differs from CLAUDE.md (copy it with the block's lines of CLAUDE.md)"
done

exit "$fail"
