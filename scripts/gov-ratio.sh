#!/usr/bin/env bash
# PG-EOS · scripts/gov-ratio.sh — CLAUDE.md · OPERATING RULES · GOVERNANCE BUDGET: "Weekly target
# >= 60% feat/fix(<WBS>) commits; /pg-state prints the ratio." (P3.) Replaces the inline git-log
# one-liner /pg-state used before this script existed.
#
# For ${GOV_BUDGET_REF:-origin/main}, over the last 7 days, prints:
#   - total commit count
#   - feat/fix(<WBS>) commit count (WBS != X — the commits commit-msg requires a Review trailer on)
#   - that count as a percent of the total, against the >= 60% target
#   - chore(X)/docs(X) commit count per calendar day (GOVERNANCE BUDGET: at most one per day)
#   - the average review rounds across those feat/fix(<WBS>) commits, parsed from the `Review:`
#     trailer by scripts/lib/review-trailer.sh. Old-form trailers ("PASS(<n> findings fixed)") carry
#     no round count (P7) and are excluded from the average; how many are is reported separately, as
#     is the count of feat/fix commits with no Review trailer at all (pre-P7 history).
#
# Pure bash + git + awk (no python, no node) — works the same in Git Bash on Windows and in CI.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
# shellcheck source=/dev/null
. "$ROOT/scripts/lib/review-trailer.sh"

REF="${GOV_BUDGET_REF:-origin/main}"
SINCE="7 days ago"

if ! git rev-parse -q --verify "$REF" >/dev/null 2>&1; then
  echo "gov-ratio: ref '${REF}' not found (set GOV_BUDGET_REF, or fetch origin)" >&2
  exit 2
fi

RS=$'\x1e' # record separator between commits
FS=$'\x1f' # field separator within a commit's record

total=0
featfix=0
rounds_sum=0
rounds_n=0
old_form_n=0
no_trailer_n=0
declare -A gov_per_day=()

log_output="$(git log "$REF" --since="$SINCE" --date=format:'%Y-%m-%d' --format="%H${FS}%ad${FS}%s${FS}%b${RS}")"

while IFS= read -r -d "$RS" record; do
  [ -z "$record" ] && continue
  rest="$record"
  hash="${rest%%"$FS"*}"; rest="${rest#*"$FS"}"
  date="${rest%%"$FS"*}"; rest="${rest#*"$FS"}"
  subject="${rest%%"$FS"*}"; body="${rest#*"$FS"}"

  total=$((total + 1))

  case "$subject" in
    chore\(X\):*|docs\(X\):*)
      gov_per_day["$date"]=$(( ${gov_per_day["$date"]:-0} + 1 ))
      ;;
  esac

  if [[ "$subject" =~ ^(feat|fix)\([0-7]\.[0-9]+[ab]?\):\  ]]; then
    featfix=$((featfix + 1))
    rline="$(review_trailer_line <(printf '%s\n' "$body"))"
    form="$(review_trailer_form "$rline")"
    if [ "$form" = "new" ]; then
      r="$(review_rounds "$rline")"
      rounds_sum=$((rounds_sum + r))
      rounds_n=$((rounds_n + 1))
    elif [ "$form" = "old" ]; then
      old_form_n=$((old_form_n + 1))
    else
      no_trailer_n=$((no_trailer_n + 1))
    fi
  fi
done <<<"$log_output"

pct="n/a"
[ "$total" -gt 0 ] && pct="$(awk -v n="$featfix" -v d="$total" 'BEGIN{ printf "%.1f", (n * 100.0 / d) }')"

avg="n/a"
[ "$rounds_n" -gt 0 ] && avg="$(awk -v s="$rounds_sum" -v n="$rounds_n" 'BEGIN{ printf "%.2f", (s / n) }')"

echo "gov-ratio: ${REF} — commits since ${SINCE}"
echo "  total commits             : ${total}"
echo "  feat/fix(<WBS>) commits   : ${featfix}"
echo "  ratio                     : ${pct}% feat/fix (target >= 60%)"
echo "  chore(X)/docs(X) per day  :"
if [ "${#gov_per_day[@]}" -eq 0 ]; then
  echo "    (none)"
else
  for d in "${!gov_per_day[@]}"; do
    printf '%s\t%s\n' "$d" "${gov_per_day[$d]}"
  done | sort | while IFS=$'\t' read -r d n; do
    echo "    ${d}: ${n}"
  done
fi
echo "  review rounds (feat/fix)  : avg ${avg} over ${rounds_n} commit(s) with a rounds-bearing Review trailer; ${old_form_n} old-form trailer(s) excluded (rounds unknown); ${no_trailer_n} commit(s) with no Review trailer"
