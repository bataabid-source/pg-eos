#!/usr/bin/env bash
# PG-EOS · scripts/lib/session-archive.sh — the watchdog's archive decision for a session
# (ADR-0007 Decision 5 amendment, X part 17). Pure and sourceable: defines a constant and one
# function, runs nothing, reads nothing, writes nothing. Driven by tests/hooks/run.sh.
#
#   archive_decide <acked 0|1> <merged 0|1> <open_pr 0|1> <idle_minutes> <tree_clean 0|1> <commits_ahead n> <stash_count n>
#   prints `archive` or `keep`; returns 0, or 2 (message on stderr) on a missing/non-numeric argument
#   or a flag (acked, merged, open_pr, tree_clean) other than 0 or 1.
#
# Rule: acked=1 or merged=1 → archive. Otherwise archive only when there is no open PR, the session
# has been idle MORE than ARCHIVE_IDLE_MINUTES, the tree is clean, nothing is ahead of the remote and
# nothing is stashed. Every other case → keep (a dirty or unpushed session is never archived).

# The Master's proposal for D-198 (ب) «أرشفة تلقائية», not GM wording — ADR-0007 amendment, X part 17.
ARCHIVE_IDLE_MINUTES=120

ARCHIVE_DECIDE_ARGC=7

archive_decide() {
  if [ "$#" -ne "$ARCHIVE_DECIDE_ARGC" ]; then
    echo "archive_decide: expected $ARCHIVE_DECIDE_ARGC arguments (acked merged open_pr idle_minutes tree_clean commits_ahead stash_count), got $#" >&2
    return 2
  fi
  local v
  for v in "$@"; do
    case "$v" in
      ''|*[!0-9]*) echo "archive_decide: non-numeric argument '$v'" >&2; return 2 ;;
    esac
  done
  local flag
  for flag in "$1" "$2" "$3" "$5"; do
    case "$flag" in
      0|1) ;;
      *) echo "archive_decide: flag argument '$flag' must be 0 or 1" >&2; return 2 ;;
    esac
  done
  local acked=$1 merged=$2 open_pr=$3 idle=$4 clean=$5 ahead=$6 stash=$7
  if [ "$acked" -eq 1 ] || [ "$merged" -eq 1 ]; then echo archive; return 0; fi
  if [ "$open_pr" -eq 0 ] && [ "$idle" -gt "$ARCHIVE_IDLE_MINUTES" ] && [ "$clean" -eq 1 ] \
     && [ "$ahead" -eq 0 ] && [ "$stash" -eq 0 ]; then
    echo archive; return 0
  fi
  echo keep
}
