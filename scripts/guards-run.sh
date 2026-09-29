#!/usr/bin/env bash
# PG-EOS · guards-run.sh — run database/schema/guards.sql and turn its rows into an exit code.
#
#   scripts/guards-run.sh                 # uses $PGDATABASE (default pgeos) and the usual PG* vars
#   PGDATABASE=pgeos_ci scripts/guards-run.sh
#
# guards.sql (doc 40 Part F) is written so that EVERY query returns rows ONLY on failure.
# The pass condition is CLAUDE.md · TESTING:
#   - G1–G17 must each return zero rows or their stated condition; a single failure blocks merge
#     and deploy. G1–G13 are the SQL half and are evaluated here.
#   - G6 (unclassified columns) is a normal blocking guard (WBS 0.16 closed column
#     classification; identity.column_classification now covers every column G6 checks).
#   - G14 (doc 40 Part F row G14, WBS 0.18 `tests/isolation`) is NOT SQL — it is the
#     `pnpm test:isolation` vitest suite. It IS run here (as of WBS 0.18): CLAUDE.md ·
#     DEPLOYMENT PIPELINE and doc 40 Part F both say `pnpm guards:run` covers G1–G18, and this
#     script previously fell short of that for G14. Pass condition: the suite's own "0 rows, no
#     error" assertions all hold, i.e. `pnpm test:isolation` exits 0 — evaluated below, folded
#     into this script's own exit code exactly like G1–G13.
#     `turbo.json`'s `test:isolation` task sets **`"cache": false`, which is mandatory, not a
#     preference**: G14's verdict depends on live DATABASE state (which policies exist, what the
#     applied schema looks like), and turbo hashes only files — it cannot see the database. With
#     caching left on, turbo replays a previous green in ~50 ms without connecting to Postgres at
#     all, so a database whose RLS had since been disabled would still print `G14 0 green`. A guard
#     that can report green without executing is worse than no guard. Do not remove that line.
#   - G18 (billing.verify_unpriced_events) is REPORT-ONLY and never blocks.
#   - G-SEED (reference-seed completeness) is REPORT-ONLY and never blocks.
#   - G15–G17 are not SQL: their runners (test:scenarios · mutation · test:trace) are executed here
#     when present; a missing runner is NOT RUNNABLE (report only) unless PG_GUARDS_STRICT=1 (deploy).
#   - Deploy entry point: `pnpm guards:deploy` (root package.json) = `PG_GUARDS_STRICT=1` + this
#     script — G15–G17 all block, G16 runs on every module (never scoped, never skipped); pinned by
#     tests/ops/tests/x-part-16.test.ts, which executes the script string verbatim (PR #209 finding 1).
#     The Master's manual-merge step for M-core/migration PRs runs the same strict form.
#
# Exit: 0 all blocking guards green · 1 at least one of G1–G14 (G6 included, WBS 0.16 closed;
#       G14 included, WBS 0.18) returned a row / failed · 2 the guards file, psql or pnpm could not
#       be run.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARDS="${PG_GUARDS_FILE:-$ROOT/database/schema/guards.sql}"
DB="${PGDATABASE:-pgeos}"

command -v psql >/dev/null 2>&1 || { echo "guards-run: psql not found on PATH." >&2; exit 2; }
command -v pnpm >/dev/null 2>&1 || { echo "guards-run: pnpm not found on PATH (needed for G14 — pnpm test:isolation)." >&2; exit 2; }
[ -f "$GUARDS" ] || { echo "guards-run: $GUARDS not found." >&2; exit 2; }

OUT="$(mktemp)"
ERR="$(mktemp)"
G14_LOG="$(mktemp)"
trap 'rm -f "$OUT" "$ERR" "$G14_LOG" "$OUT".G15 "$OUT".G16 "$OUT".G17' EXIT

echo "guards-run: $GUARDS against database '$DB'"
# WBS 0.15: stdin redirection, not -f — see database/schema/apply.sh's header for the full,
# epistemically-honest account (root cause not fully isolated; verified-safe defensive fix, kept
# despite a diagnostics cost, because -f reproducibly corrupted multi-byte UTF-8 in the working
# environment these guards actually run in, and stdin did not).
if ! psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$DB" <"$GUARDS" >"$OUT" 2>"$ERR"; then
  echo "guards-run: psql failed — the guards did not complete." >&2
  sed -n '1,40p' "$ERR" >&2
  exit 2
fi

# G14 (doc 40 Part F row G14, WBS 0.18) — not SQL, so it is not part of guards.sql above. Run
# `pnpm test:isolation` (tests/isolation) here so it is folded into this script's own verdict table
# and exit code, exactly like G1–G13. `G14_ROWS` is 0 when the suite's own zero-rows/no-error
# assertions all held (the suite exited 0), 1 otherwise — there is no literal SQL row count for a
# test suite, so this mirrors the SQL guards' "0 = green" convention rather than inventing one.
echo "guards-run: pnpm test:isolation (G14, doc 40 Part F) ..."
if (cd "$ROOT" && pnpm test:isolation >"$G14_LOG" 2>&1); then
  G14_ROWS=0
else
  G14_ROWS=1
fi

# Exit 0 is NOT evidence that the suite ran. `turbo run <task> --filter=<pkg>` exits 0 when the
# package exists but no longer defines that script — so renaming or deleting `test:isolation` in
# tests/isolation/package.json would turn G14 into a permanent silent green. Require positive proof
# in the captured output that vitest actually reported a result. Same reasoning as turbo.json's
# `"cache": false`: a guard that can report green without executing is worse than no guard.
if [ "$G14_ROWS" -eq 0 ] && ! grep -q 'Test Files' "$G14_LOG"; then
  echo "guards-run: G14 exited 0 but its output contains no vitest result — the suite did not run." >&2
  G14_ROWS=1
fi

# guards.sql prints a "--- Gn: ... ---" banner before each guard; everything between two banners
# that is not a banner is a FAILING ROW of that guard. The final banner block is G-SEED.
SUMMARY="$(awk '
  /^--- / {
    sec = $0
    sub(/^--- /, "", sec)
    sub(/[:(].*$/, "", sec)
    gsub(/[[:space:]]+$/, "", sec)
    if (sec ~ /^G-SEED/) sec = "G-SEED"
    next
  }
  /^═/ { sec = ""; next }
  /^[[:space:]]*$/ { next }
  { if (sec != "") count[sec]++ }
  END { for (g in count) printf "%s %d\n", g, count[g] }
' "$OUT" | sort -V)"

BLOCKING=0
printf '\n%-10s %-8s %s\n' "guard" "rows" "verdict"
printf -- '---------- -------- ---------------------------------------------\n'

report_line() { printf '%-10s %-8s %s\n' "$1" "$2" "$3"; }

for g in G1 G2 G3 G4 G5 G6 G7 G8 G9 G10 G11 G12 G13 G14 G18 G-SEED; do
  if [ "$g" = "G14" ]; then
    rows="$G14_ROWS"
  else
    rows="$(printf '%s\n' "$SUMMARY" | awk -v k="$g" '$1==k {print $2}')"
    rows="${rows:-0}"
  fi
  case "$g" in
    G18)
      if [ "$rows" -gt 0 ]; then report_line "$g" "$rows" "REPORT ONLY — unpriced billing events"
      else report_line "$g" "$rows" "green"; fi ;;
    G-SEED)
      if [ "$rows" -gt 0 ]; then report_line "$g" "$rows" "REPORT ONLY — reference seed count mismatch"
      else report_line "$g" "$rows" "green"; fi ;;
    G14)
      if [ "$rows" -gt 0 ]; then report_line "$g" "$rows" "RED — blocks merge and deploy (pnpm test:isolation failed)"; BLOCKING=$((BLOCKING + 1))
      else report_line "$g" "$rows" "green"; fi ;;
    *)
      if [ "$rows" -gt 0 ]; then report_line "$g" "$rows" "RED — blocks merge and deploy"; BLOCKING=$((BLOCKING + 1))
      else report_line "$g" "$rows" "green"; fi ;;
  esac
done

echo
# ---- G15–G17: not SQL — run their runners here when they exist (lane blocker (a), 2026-09-24) ----
# doc 40 Part F: G15 = playwright tests/scenarios 20/20 · G16 = stryker on domain/ ≥ 75 % ·
# G17 = pnpm test:trace ≤ 2 s. A guard whose runner does not exist yet (S1–S20 arrive with the
# slices; stryker is the nightly job; test:trace is WBS 6.4) is reported NOT RUNNABLE and blocks
# only under PG_GUARDS_STRICT=1 (deploy mode). PG_GUARDS_STRICT accepts exactly "0" or "1" (unset =
# "0"); any other value fails closed. Each guard proves it ran (a marker line in its log) and is
# judged on doc 40's stated condition, never on the runner's exit code alone (reviewer findings
# 1–3 and 6 on 421afe2, folded 2026-09-24).
case "${PG_GUARDS_STRICT:-0}" in 0|1) ;; *) echo "guards-run: PG_GUARDS_STRICT must be 0 or 1 (got '${PG_GUARDS_STRICT}')" >&2; exit 2 ;; esac
has_script() { node -e "process.exit(require('./package.json').scripts&&require('./package.json').scripts['$1']?0:1)" 2>/dev/null; }
verdict_nonsql() {   # $1 guard  $2 label  $3 present(0/1)  $4 result: green|red:<why>|missing
  local g="$1" label="$2" present="$3" res="$4"
  if [ "$present" = "1" ]; then
    case "$res" in
      green) report_line "$g" "-" "green ($label)" ;;
      *) report_line "$g" "-" "RED — blocks merge and deploy ($label: ${res#red:}; see $OUT.$g)"; BLOCKING=$((BLOCKING + 1)) ;;
    esac
  elif [ "${PG_GUARDS_STRICT:-0}" = "1" ]; then
    report_line "$g" "-" "RED — NOT RUNNABLE under PG_GUARDS_STRICT=1 ($label runner missing)"; BLOCKING=$((BLOCKING + 1))
  else
    report_line "$g" "-" "NOT RUNNABLE — $label runner not present yet (report only; deploy = pnpm guards:deploy, PG_GUARDS_STRICT=1)"
  fi
}
# G15 — doc 40 Part E scenarios S1..S20 (playwright JSON reporter), judged by
# scripts/scenarios-verdict.mjs: under PG_GUARDS_STRICT=1 (deploy) every scenario must be present
# AND passed; otherwise (merge gate) only the scenarios listed in tests/scenarios/green.json must be
# — a listed scenario failing or missing is a regression and RED, the rest is reported
# (docs/STREAMS.md §G15: a scenario RED because its rows are not built yet is the plan, not a defect).
g15_present=0; [ -n "$(ls -A tests/scenarios 2>/dev/null)" ] && has_script test:scenarios && g15_present=1
g15_res=missing; g15_sum=""
if [ "$g15_present" = "1" ]; then
  if pnpm -s test:scenarios --reporter=json >"$OUT.G15" 2>/dev/null; then :; fi
  g15_strict=(); [ "${PG_GUARDS_STRICT:-0}" = "1" ] && g15_strict=(--strict)
  g15_out="$(node scripts/scenarios-verdict.mjs "$OUT.G15" "${g15_strict[@]}" || true)"
  g15_res="${g15_out%%$'\n'*}"; g15_sum="${g15_out#*$'\n'}"
fi
verdict_nonsql G15 "doc 40 Part E scenarios S1–S20 — ${g15_sum:-runner}" "$g15_present" "$g15_res"
# G16 — stryker on every module's domain/ (modules/*/stryker.config.json, thresholds.break = 75,
# ADR-0005 §6): the root `pnpm mutation` runs the modules one at a time (shared database); every
# config must print its own "Final mutation score" line and every score must be >= 75.
# Scope (X part 6, D-193 D6; X part 16, D-198 (أ)): scripts/lib/g16-scope.sh g16_decide decides —
# PG_GUARDS_STRICT=1 (deploy) = every module, never scoped; CI mode (gate ⑤) = G16_MODULES unset →
# every module, set → the listed modules (computed from the diff: domain/, tests/, vitest.config.ts
# or stryker.config.json changed), set but empty → none in scope, not run, the nightly run governs;
# otherwise (local) = the config check below still runs, Stryker does not — G16 is reported SKIPPED
# (non-blocking) and CI gate ⑤ plus the nightly run govern.
. "$ROOT/scripts/lib/g16-scope.sh"
g16_cfgs=(modules/*/stryker.config.json)
g16_mods=(); g16_scoped=0; g16_local=0
g16_decision="$(g16_decide)"
if [ "$g16_decision" = "local" ]; then
  g16_local=1
elif [ "$g16_decision" != "all" ]; then
  g16_scoped=1; read -r -a g16_mods <<<"${g16_decision#scoped:}"
fi
g16_expected="${#g16_cfgs[@]}"; [ "$g16_scoped" = "1" ] && g16_expected="${#g16_mods[@]}"
g16_present=0; [ -f "${g16_cfgs[0]}" ] && has_script mutation && g16_present=1
g16_res=missing
if [ "$g16_present" = "1" ] && [ "$g16_scoped" = "1" ] && [ "$g16_expected" -eq 0 ]; then
  g16_res=skipped
elif [ "$g16_present" = "1" ]; then
  g16_res="$(node -e '
    const fs=require("fs"); const bad=[];
    for (const f of process.argv.slice(1)) { let c; try { c=JSON.parse(fs.readFileSync(f,"utf8")); } catch { bad.push(f+": not JSON"); continue; }
      if (!c.thresholds || c.thresholds.break !== 75) bad.push(f+": thresholds.break is not 75");
      if (!Array.isArray(c.mutate) || !c.mutate.some(m=>/^domain\//.test(m))) bad.push(f+": mutate does not target domain/"); }
    console.log(bad.length ? "red:"+bad.join("; ") : "green");' "${g16_cfgs[@]}")"
  if [ "$g16_res" = "green" ] && [ "$g16_local" = "1" ]; then
    g16_res=skipped_local
  elif [ "$g16_res" = "green" ]; then
    pnpm -s mutation "${g16_mods[@]}" >"$OUT.G16" 2>&1 || true
    # The temp log is removed on exit; keep a copy so a red G16 can be diagnosed (reports/ is git-ignored).
    mkdir -p reports/mutation && cp "$OUT.G16" reports/mutation/guards-G16.log
    mapfile -t g16_scores < <(grep -Eo 'Final mutation score[^0-9]*[0-9]+(\.[0-9]+)?' "$OUT.G16" | grep -Eo '[0-9]+(\.[0-9]+)?$')
    if [ "${#g16_scores[@]}" -ne "$g16_expected" ]; then
      g16_res="red:${#g16_scores[@]} of ${g16_expected} modules printed a 'Final mutation score' line — stryker did not run to completion everywhere"
      # CI never shows the temp log; print the tail so a crash (not a low score) is diagnosable from the job output.
      echo "guards-run: G16 per-module lines (mutation-all / Final mutation score / initial-run errors):" >&2
      grep -E "^mutation-all:|Final mutation score|Initial test run|ERROR " "$OUT.G16" | sed 's/^/  G16> /' >&2
      echo "guards-run: G16 log tail (${OUT}.G16, last 60 lines):" >&2
      grep -vE '^\s+at |Mutation testing [0-9]+%' "$OUT.G16" | tail -n 60 | sed 's/^/  G16> /' >&2
    else
      g16_res=green
      for s in "${g16_scores[@]}"; do awk -v s="$s" 'BEGIN{exit !(s+0 >= 75)}' || { g16_res="red:a module's mutation score $s % < 75 %"; break; }; done
    fi
  fi
fi
if [ "$g16_res" = "skipped" ]; then
  report_line G16 "-" "not run — G16_MODULES is empty (no module in scope for this change); the nightly run scores every module"
elif [ "$g16_res" = "skipped_local" ]; then
  report_line G16 "-" "SKIPPED locally (D-198 (أ): CI gate ⑤ scoped + nightly govern)"
else
  g16_label="stryker mutation on domain/ >= 75 %"; [ "$g16_scoped" = "1" ] && g16_label="$g16_label — ${g16_mods[*]}"
  verdict_nonsql G16 "$g16_label" "$g16_present" "$g16_res"
fi
# G17 — one number in, full timeline out, <= 2 s: the runner must print 'trace_ms=<n>'; turbo must not cache it.
g17_present=0; has_script test:trace && g17_present=1
g17_res=missing
if [ "$g17_present" = "1" ]; then
  if grep -Eq '"test:trace"[^}]*"cache"[[:space:]]*:[[:space:]]*true' turbo.json 2>/dev/null; then g17_res="red:turbo.json caches test:trace — set cache:false"
  else
    pnpm -s test:trace >"$OUT.G17" 2>&1 || true
    ms="$(grep -Eo 'trace_ms=[0-9]+' "$OUT.G17" | tail -1 | cut -d= -f2)"
    if [ -z "$ms" ]; then g17_res="red:no 'trace_ms=<n>' line — test:trace did not prove it ran"
    elif [ "$ms" -le 2000 ]; then g17_res=green; else g17_res="red:trace took ${ms} ms > 2000 ms"; fi
  fi
fi
verdict_nonsql G17 "trace screen <= 2 s" "$g17_present" "$g17_res"

if [ "$BLOCKING" -gt 0 ]; then
  echo
  echo "guards-run: $BLOCKING blocking guard(s) RED. There is no 'deploy and fix'. Failing rows:" >&2
  grep -E '^G([1-9]|1[0-3])\|' "$OUT" | head -40 >&2
  if [ "$G14_ROWS" -gt 0 ]; then
    echo >&2
    echo "guards-run: G14 (pnpm test:isolation) failed — last 40 lines of its output:" >&2
    tail -n 40 "$G14_LOG" >&2
  fi
  exit 1
fi

echo "guards-run: all blocking guards green."
exit 0
