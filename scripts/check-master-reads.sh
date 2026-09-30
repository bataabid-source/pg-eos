#!/usr/bin/env bash
# PG-EOS · scripts/check-master-reads.sh — D-210 item 4: the Master reads nothing inline (PR bodies,
# handover packets, backlog, CHANGELOG go through subagents with <= 20-line returns). This reports,
# from a Claude Code session transcript (JSONL), the main-thread inline reads of that content.
# A REPORT, not a PreToolUse hook: a hook cannot tell the Master's read from its subagent's (same
# session, same hooks); the transcript can (subagent entries carry isSidechain).
#
# Usage: check-master-reads.sh <session.jsonl> [--strict] [--max-lines N]
# Exit 0 report · 1 with --strict when a read is found · 2 usage. Logic lives in the .mjs (JSON needs node).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT/scripts/check-master-reads.mjs" "$@"
