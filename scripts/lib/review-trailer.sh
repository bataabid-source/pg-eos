#!/usr/bin/env bash
# PG-EOS · scripts/lib/review-trailer.sh — parse the `Review:` trailer of a commit message (P7, 2026-09-26).
# Sourced by .githooks/commit-msg (validation) and by scripts/gov-ratio.sh (P3: average review rounds of
# the last feat commits). Two accepted forms:
#   old:  Review: PASS(<n> findings fixed) …          (before P7)
#   new:  Review: PASS(<n> findings, <r> rounds) …    (P7 onward; a round-2 PASS-subset commit uses it too)
# Free text may follow the closing parenthesis. Nothing here reads git; callers pass the message text.

# review_trailer_line <message-file> → prints the first `Review:` line (empty if none)
review_trailer_line() {
  grep -m1 -E '^Review:' "$1" 2>/dev/null || true
}

# review_trailer_form <line> → prints `new`, `old` or nothing
review_trailer_form() {
  local l="$1"
  if [[ "$l" =~ PASS\(([0-9]+)\ findings,\ ([0-9]+)\ rounds?\) ]]; then echo new
  elif [[ "$l" =~ PASS\(([0-9]+)\ findings\ fixed ]]; then echo old
  fi
}

# review_rounds <line> → prints <r> for the new form, nothing otherwise (hook point for gov-ratio.sh)
review_rounds() {
  local l="$1"
  if [[ "$l" =~ PASS\(([0-9]+)\ findings,\ ([0-9]+)\ rounds?\) ]]; then echo "${BASH_REMATCH[2]}"; fi
}
