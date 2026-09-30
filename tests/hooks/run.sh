#!/usr/bin/env bash
# PG-EOS · tests/hooks/run.sh — regression tests for the versioned hooks and bookkeeping gates
# (D-179, 2026-09-25). Pure bash, no database. Runs in CI gate ① and via `pnpm test:hooks`.
#   .claude/hooks/lane-guard.sh · .claude/hooks/db-guard.sh · .githooks/commit-msg · scripts/check-locks.sh
#   · scripts/brief-check.sh · scripts/resolve-hashes.mjs (node, P3) · scripts/gov-ratio.sh (P3)
# Every rule these files enforce has a case here; a change that drops a rule turns a case red.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; failn=0
ok()  { pass=$((pass+1)); }
ko()  { failn=$((failn+1)); echo "  FAIL: $1" >&2; }
expect() { # expect <label> <expected-exit> <actual-exit>
  if [ "$2" -eq "$3" ]; then ok; else ko "$1 — expected exit $2, got $3"; fi
}

# ---- fixture: a fake lane-1 worktree and a fake shared checkout --------------------------------
LANE1="$TMP/pg-eos-lane-1"; SHARED="$TMP/claude-kit"
for d in "$LANE1" "$SHARED"; do
  mkdir -p "$d/tasks/backlog" "$d/modules/wms/tests/put-away" "$d/database/migrations" "$d/docs/package"
  cp "$REPO/.claude/hooks/lane-guard.sh" "$d/lane-guard.sh"
done
guard() { # guard <root> <lane|""> <path>  → exit code
  local root="$1" lane="$2" path="$3"
  if [ -n "$lane" ]; then
    printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$path" | CLAUDE_PROJECT_DIR="$root" PG_LANE="$lane" env -u CLAUDE_CODE_REMOTE bash "$root/lane-guard.sh" 2>/dev/null; echo $?
  else
    printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$path" | CLAUDE_PROJECT_DIR="$root" env -u PG_LANE -u CLAUDE_CODE_REMOTE bash "$root/lane-guard.sh" 2>/dev/null; echo $?
  fi
}
locks() { printf '| module | lane | task | claimed_at | worktree |\n|---|---|---|---|---|\n%s\n' "$1" > "$LANE1/tasks/LANE_LOCKS.md"; }

echo "lane-guard.sh"
expect "master: modules write allowed"          0 "$(guard "$SHARED" "" "modules/wms/index.ts")"
expect "master: database/schema blocked"        2 "$(guard "$SHARED" "" "database/schema/01-Data-Model.sql")"
locks '| wms | 1 | 2.10 | 2026-09-25 | ../pg-eos-lane-1 |'
cp "$LANE1/tasks/LANE_LOCKS.md" "$SHARED/tasks/LANE_LOCKS.md"
expect "lane in shared checkout blocked (D-179)" 2 "$(guard "$SHARED" 1 "modules/wms/index.ts")"
# ADR-0007 Decision 3: a cloud session (CLAUDE_CODE_REMOTE=true) is its own clone `pg-eos`; the branch
# replaces the worktree directory and, with PG_LANE unset, names the role (lane/<id>-* · core/* · else Master).
CLOUD="$TMP/pg-eos"; mkdir -p "$CLOUD/tasks" && cp "$REPO/.claude/hooks/lane-guard.sh" "$CLOUD/lane-guard.sh"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1   # no host git config leaks into the cases
git -C "$CLOUD" init -q -b main 2>/dev/null || { git -C "$CLOUD" init -q && git -C "$CLOUD" checkout -q -b main; }
printf '| module | lane | task | claimed_at | worktree |\n|---|---|---|---|---|\n| wms | 1 | 2.10 | d | cloud:session_01A |\n| identity | M | 2.16 | d | . |\n| packages/identity | M | 2.16 | d | . |\n' > "$CLOUD/tasks/LANE_LOCKS.md"
gc() { # gc <PG_LANE|""> <path> → exit code, as a cloud session in $CLOUD on its current branch
  if [ -n "$1" ]; then
    printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$2" | CLAUDE_PROJECT_DIR="$CLOUD" PG_LANE="$1" CLAUDE_CODE_REMOTE=true bash "$CLOUD/lane-guard.sh" 2>/dev/null; echo $?
  else
    printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$2" | CLAUDE_PROJECT_DIR="$CLOUD" CLAUDE_CODE_REMOTE=true env -u PG_LANE bash "$CLOUD/lane-guard.sh" 2>/dev/null; echo $?
  fi
}
on() { git -C "$CLOUD" checkout -q -B "$1"; }
expect "cloud, main, no PG_LANE: Master mode"       0 "$(gc "" "modules/hr/index.ts")"
expect "cloud, main, PG_LANE=1: blocked"            2 "$(gc 1 "modules/wms/index.ts")"
on lane/2-4.19
expect "cloud, PG_LANE=1 on lane/2 branch: blocked" 2 "$(gc 1 "modules/wms/index.ts")"
on lane/1-
expect "cloud, branch lane/1- (no wbs): blocked"    2 "$(gc 1 "modules/wms/index.ts")"
on lane/1
expect "cloud, branch lane/1 (no wbs): blocked"     2 "$(gc 1 "modules/wms/index.ts")"
on lane/1-2.16
expect "cloud, PG_LANE=1 on its branch: lock allows" 0 "$(gc 1 "modules/wms/domain/put-away/x.ts")"
expect "cloud, PG_LANE=2 wins over branch lane/1: blocked" 2 "$(gc 2 "modules/wms/index.ts")"
expect "cloud, lane from branch: lock allows"       0 "$(gc "" "modules/wms/domain/put-away/x.ts")"
expect "cloud, lane from branch: other module blocked" 2 "$(gc "" "modules/hr/index.ts")"
expect "cloud, lane from branch: packages/* frozen" 2 "$(gc "" "packages/db/index.ts")"
expect "cloud, lane from branch: .claude/* frozen"  2 "$(gc "" ".claude/hooks/x.sh")"
git -C "$CLOUD" config --local pgeos.role master
expect "cloud, pgeos.role=master on a lane branch: Master mode" 0 "$(gc "" "modules/hr/index.ts")"
git -C "$CLOUD" config --local --unset pgeos.role
expect "local session ignores the branch (D-179 unchanged)" 0 "$(guard "$CLOUD" "" "modules/hr/index.ts")"
expect "local lane outside its worktree still blocked" 2 "$(guard "$CLOUD" 1 "modules/wms/domain/put-away/x.ts")"
git -C "$CLOUD" -c user.email=t@t -c user.name=t commit -q --allow-empty -m x && git -C "$CLOUD" checkout -q --detach
expect "cloud, detached HEAD, PG_LANE=1: blocked"   2 "$(gc 1 "modules/wms/index.ts")"
on core/2.16-1a-5
expect "M-core: its packages/<name> row allows"     0 "$(gc "" "packages/identity/src/otp.ts")"
expect "M-core: its module row allows"              0 "$(gc "" "modules/identity/application/x.ts")"
expect "M-core: an unlocked package blocked"        2 "$(gc "" "packages/db/index.ts")"
expect "M-core: CLAUDE.md is Master-only"           2 "$(gc "" "CLAUDE.md")"
expect "M-core: .claude/* blocked without tooling"  2 "$(gc "" ".claude/hooks/x.sh")"
expect "M-core: .githooks/* blocked without tooling" 2 "$(gc "" ".githooks/pre-commit")"
printf '| tooling | M | X | d | . |\n' >> "$CLOUD/tasks/LANE_LOCKS.md"
expect "M-core: tooling row opens .claude/*"        0 "$(gc "" ".claude/hooks/x.sh")"
expect "M-core: tooling row opens scripts/*"        0 "$(gc "" "scripts/check-locks.sh")"
expect "M-core: tooling row opens .githooks/*"      0 "$(gc "" ".githooks/pre-commit")"
expect "M-core: database/schema still blocked"      2 "$(gc "" "database/schema/01-Data-Model.sql")"
on lane/1-2.16
expect "lane 1 with M rows present: packages still frozen" 2 "$(gc "" "packages/identity/src/otp.ts")"
expect "lane 1 with the tooling row present: .githooks/* frozen" 2 "$(gc "" ".githooks/pre-commit")"
unset GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM
expect "lane: whole-module lock allows module"  0 "$(guard "$LANE1" 1 "modules/wms/domain/put-away/x.ts")"
expect "lane: other module blocked"             2 "$(guard "$LANE1" 1 "modules/hr/index.ts")"
expect "lane: packages/* frozen"                2 "$(guard "$LANE1" 1 "packages/db/index.ts")"
expect "lane: CLAUDE.md frozen"                 2 "$(guard "$LANE1" 1 "CLAUDE.md")"
expect "lane: tests/ always writable"           0 "$(guard "$LANE1" 1 "tests/guards/x.test.ts")"
expect "lane: absolute path normalised"         0 "$(guard "$LANE1" 1 "$LANE1/modules/wms/api/put-away/h.ts")"
locks '| wms/put-away | 1 | 2.10 | 2026-09-25 | ../pg-eos-lane-1 |'
expect "use-case lock: own use case allowed"    0 "$(guard "$LANE1" 1 "modules/wms/application/put-away/put-away.ts")"
expect "use-case lock: own tests allowed"       0 "$(guard "$LANE1" 1 "modules/wms/tests/put-away/put-away.feature")"
expect "use-case lock: apps feature allowed"    0 "$(guard "$LANE1" 1 "apps/wms/src/features/put-away/page.tsx")"
expect "use-case lock: tsconfig.test.json allowed" 0 "$(guard "$LANE1" 1 "modules/wms/tsconfig.test.json")"
expect "use-case lock: module barrel blocked"   2 "$(guard "$LANE1" 1 "modules/wms/index.ts")"
expect "use-case lock: package.json blocked"    2 "$(guard "$LANE1" 1 "modules/wms/package.json")"
expect "use-case lock: other use case blocked"  2 "$(guard "$LANE1" 1 "modules/wms/domain/receive-inbound/x.ts")"
locks '| wms/put-away | 1 | 2.10 | 2026-09-25 | ../pg-eos-lane-1 |
| wms | 2 | 2.15 | 2026-09-25 | ../pg-eos-lane-2 |'
expect "whole vs use-case clash blocks writes"  2 "$(guard "$LANE1" 1 "modules/wms/domain/put-away/x.ts")"
locks '| wms/put-away | 1 | 2.10 | 2026-09-25 | ../pg-eos-lane-1 |
| wms/manage-space | 2 | 2.15 | 2026-09-25 | ../pg-eos-lane-2 |'
expect "two use cases of one module coexist"    0 "$(guard "$LANE1" 1 "modules/wms/domain/put-away/x.ts")"
locks ''
expect "no lock: blocked"                       2 "$(guard "$LANE1" 1 "modules/wms/domain/put-away/x.ts")"

echo "lane-guard.sh — RED before migration"
locks '| wms/put-away | 1 | 2.10 | 2026-09-25 | ../pg-eos-lane-1 |'
REQ="$LANE1/tasks/backlog/MIGRATION-REQUEST-1.md"
MIG="database/migrations/0022_1_locations-version.sql"
expect "wrong lane prefix blocked"              2 "$(guard "$LANE1" 1 "database/migrations/0022_2_x.sql")"
rm -f "$REQ"
expect "no request file blocked"                2 "$(guard "$LANE1" 1 "$MIG")"
printf '| 1 | wms | `other-slug` | purpose | 2026-09-25 | 0022 |\n' > "$REQ"
expect "no row for slug blocked"                2 "$(guard "$LANE1" 1 "$MIG")"
printf '| 1 | wms | `locations-version` | purpose, no tests | 2026-09-25 | 0022 |\n' > "$REQ"
expect "row without RED paths blocked"          2 "$(guard "$LANE1" 1 "$MIG")"
printf '| 1 | wms | `locations-version` | RED: modules/wms/tests/put-away/put-away.feature | 2026-09-25 | 0022 |\n' > "$REQ"
expect "RED path missing on disk blocked"       2 "$(guard "$LANE1" 1 "$MIG")"
touch "$LANE1/modules/wms/tests/put-away/put-away.feature"
expect "RED path present → migration allowed"   0 "$(guard "$LANE1" 1 "$MIG")"

echo "commit-msg"
printf '| 2.9 | Receive inbound order |\n' > "$TMP/38-WBS.md"
cm() { # cm <message> → exit
  local f="$TMP/msg"; printf '%b' "$1" > "$f"
  ( cd "$TMP" && git init -q . 2>/dev/null; mkdir -p docs/package scripts/lib; cp "$TMP/38-WBS.md" docs/package/38-WBS.md; cp "$REPO/scripts/lib/review-trailer.sh" scripts/lib/; bash "$REPO/.githooks/commit-msg" "$f" 2>/dev/null ); echo $?
}
expect "bad first line refused"                 1 "$(cm 'update stuff')"
expect "feat(2.9) with new Review form accepted" 0 "$(cm 'feat(2.9): receive\n\nbody\nReview: PASS(3 findings, 2 rounds)')"
expect "feat(2.9) with old Review form accepted" 0 "$(cm 'feat(2.9): receive\n\nReview: PASS(5 findings fixed)')"
expect "feat(2.9) Review form + free text ok"   0 "$(cm 'feat(2.9): receive\n\nReview: PASS(0 findings, 1 round) — subset')"
expect "P7: feat without Review refused"        1 "$(cm 'feat(2.9): receive\n\nbody')"
expect "P7: feat with FAIL-only Review refused" 1 "$(cm 'feat(2.9): receive\n\nReview: round 3 FAIL(1 low)')"
expect "P7: fix(2.9) without Review refused"    1 "$(cm 'fix(2.9): typo\n')"
expect "P7: wip(2.9) needs no Review"           0 "$(cm 'wip(2.9): checkpoint\n')"
GB="$TMP/gb"; mkdir -p "$GB/docs/package" "$GB/scripts/lib"; cp "$TMP/38-WBS.md" "$GB/docs/package/38-WBS.md"; cp "$REPO/scripts/lib/review-trailer.sh" "$GB/scripts/lib/"
( cd "$GB" && git init -q -b main . && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m 'chore(X): earlier bookkeeping today' ) >/dev/null 2>&1
gb() { printf '%b' "$1" > "$GB/msg"; ( cd "$GB" && GOV_BUDGET_REF=main bash "$REPO/.githooks/commit-msg" "$GB/msg" 2>/dev/null ); echo $?; }
expect "P2: second chore(X) today refused"      1 "$(gb 'chore(X): more bookkeeping\n')"
expect "P2: second docs(X) today refused"       1 "$(gb 'docs(X): a note\n\nDecision: D-189')"
expect "P2: Override + GM-Directive accepted"   0 "$(gb 'chore(X): GM-directed\n\nOverride: GM\nGM-Directive: "نفذ هذا القيد اليوم"')"
expect "P2: Override without directive refused" 1 "$(gb 'chore(X): GM-directed\n\nOverride: GM')"
expect "P2: feat(2.9) not budgeted"             0 "$(gb 'feat(2.9): x\n\nReview: PASS(0 findings, 1 rounds)')"
GB0="$TMP/gb0"; mkdir -p "$GB0/docs/package" "$GB0/scripts/lib"; cp "$TMP/38-WBS.md" "$GB0/docs/package/38-WBS.md"; cp "$REPO/scripts/lib/review-trailer.sh" "$GB0/scripts/lib/"
( cd "$GB0" && git init -q -b main . && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m 'feat(2.9): only a feature today' \
  && GIT_COMMITTER_DATE="2 days ago" GIT_AUTHOR_DATE="2 days ago" git -c user.email=t@t -c user.name=t commit -q --allow-empty -m 'chore(X): bookkeeping two days ago' ) >/dev/null 2>&1
gb0() { printf '%b' "$1" > "$GB0/msg"; ( cd "$GB0" && GOV_BUDGET_REF=main bash "$REPO/.githooks/commit-msg" "$GB0/msg" 2>/dev/null ); echo $?; }
expect "P2: first chore(X) of the day accepted" 0 "$(gb0 'chore(X): first bookkeeping today\n')"
expect "P7: review_rounds parses new form"      0 "$( . "$REPO/scripts/lib/review-trailer.sh"; [ "$(review_rounds 'Review: PASS(4 findings, 2 rounds)')" = 2 ]; echo $?)"
expect "feat(9.9) unknown WBS refused"          1 "$(cm 'feat(9.9): nope')"
expect "docs(X) without directive refused"      1 "$(cm 'docs(X): a note\n\nModel: x')"
expect "docs(X) with Decision trailer accepted" 0 "$(cm 'docs(X): a note\n\nDecision: D-179\nModel: x')"
expect "docs(X) with GM-Directive accepted"     0 "$(cm 'docs(X): a note\n\nGM-Directive: "نفذ التوصيات كاملة مع ضمان عدم كسرها"\n')"
expect "docs(X) with short directive refused"   1 "$(cm 'docs(X): a note\n\nGM-Directive: "ok"\n')"
expect "chore(X) needs no trailer"              0 "$(cm 'chore(X): issue migration 0022\n')"

echo "check-locks.sh"
cl() { printf '| module | lane | task | claimed_at | worktree |\n|---|---|---|---|---|\n%b\n' "$1" > "$TMP/locks.md"; bash "$REPO/scripts/check-locks.sh" "$TMP/locks.md" >/dev/null 2>&1; echo $?; }
expect "valid table OK"                         0 "$(cl '| wms/put-away | 1 | 2.10 | d | ../pg-eos-lane-1 |\n| wms/manage-space | 2 | 2.15 | d | ../pg-eos-lane-2 (building) |\n| imile | 3 | 3.14 | d | ../pg-eos-lane-3 |')"
expect "shared claude-kit worktree refused"     1 "$(cl '| imile | 3 | 3.14 | d | shared `claude-kit` |')"
expect "wrong lane worktree refused"            1 "$(cl '| imile | 3 | 3.14 | d | ../pg-eos-lane-2 |')"
expect "cloud session worktree accepted (ADR-0007)" 0 "$(cl '| imile | 3 | 3.14 | d | cloud:session_01AbC |')"
expect "bare cloud: worktree refused"           1 "$(cl '| imile | 3 | 3.14 | d | cloud: |')"
expect "cloud worktree with trailing junk refused" 1 "$(cl '| imile | 3 | 3.14 | d | cloud:session_1 ../x |')"
expect "cloud worktree with a dash refused"     1 "$(cl '| imile | 3 | 3.14 | d | cloud:session_a-b |')"
expect "Master row exempt from worktree rule"   0 "$(cl '| packages/db | M | 0.6a | d | claude-kit |')"
expect "duplicate lock refused"                 1 "$(cl '| wms | 1 | 2.11 | d | ../pg-eos-lane-1 |\n| wms | 2 | 2.13 | d | ../pg-eos-lane-2 |')"
expect "whole + use-case clash refused"         1 "$(cl '| wms | 2 | 2.13 | d | ../pg-eos-lane-2 |\n| wms/put-away | 1 | 2.10 | d | ../pg-eos-lane-1 |')"
expect "four lanes refused"                     1 "$(cl '| a | 1 | 2.11 | d | ../pg-eos-lane-1 |\n| b | 2 | 2.13 | d | ../pg-eos-lane-2 |\n| c | 3 | 3.14 | d | ../pg-eos-lane-3 |\n| e | A | 2.7 | d | ../pg-eos-lane-A |')"
expect "task not a doc-38 row refused (D-185)"   1 "$(cl '| wms/work-orders | 1 | 2.20 | d | ../pg-eos-lane-1 |')"
expect "unknown task id refused (D-185)"        1 "$(cl '| imile | 3 | 9.99 | d | ../pg-eos-lane-3 |')"
expect "deps-column value is not a row ID"      1 "$(cl '| imile | 3 | 2.9–2.13 | d | ../pg-eos-lane-3 |')"
expect "doc-38 row with suffix accepted"        0 "$(cl '| wms/schedule-inbound | 2 | 2.9b | d | ../pg-eos-lane-2 |')"
expect "task X accepted"                        0 "$(cl '| packages/events | M | X | d | claude-kit |')"
expect "missing doc 38 refused (D-185)"         1 "$(printf '| module | lane | task | claimed_at | worktree |\n|---|---|---|---|---|\n| imile | 3 | 3.14 | d | ../pg-eos-lane-3 |\n' > "$TMP/locks.md"; CHECK_LOCKS_WBS="$TMP/no-38.md" bash "$REPO/scripts/check-locks.sh" "$TMP/locks.md" >/dev/null 2>&1; echo $?)"
expect "missing file → 2"                       2 "$(bash "$REPO/scripts/check-locks.sh" "$TMP/none.md" >/dev/null 2>&1; echo $?)"

echo "brief-check.sh"
FX="$TMP/fx"; mkdir -p "$FX/modules/m/domain/uc" "$FX/docs"
for i in $(seq 1 14); do seq 1 100 > "$FX/modules/m/domain/uc/f$i.ts"; done
seq 1 3000 > "$FX/docs/big.md"
bc() { printf 'builder: pg-builder
%b' "$1" > "$TMP/brief.md"; bash "$REPO/scripts/brief-check.sh" "$TMP/brief.md" --root "$FX" >/dev/null 2>&1; echo $?; }
bcn() { printf '%b' "$1" > "$TMP/brief.md"; bash "$REPO/scripts/brief-check.sh" "$TMP/brief.md" --root "$FX" >/dev/null 2>&1; echo $?; }
expect "routing v2: no builder line refused"            1 "$(bcn 'Read ONLY:
- `modules/m/domain/uc/f1.ts`
Write ONLY: x')"
expect "routing v2: unknown builder refused"            1 "$(bcn 'builder: pg-wizard
Read ONLY:
- `modules/m/domain/uc/f1.ts`
Write ONLY: x')"
expect "ADR-0005: pg-builder-core accepted"             0 "$(bcn 'builder: pg-builder-core
Read ONLY:
- `modules/m/domain/uc/f1.ts`
Write ONLY: x')"
expect "ADR-0005: core + builder accepted"              0 "$(bcn 'builder: pg-builder-core + pg-builder
Read ONLY:
- `modules/m/domain/uc/f1.ts`
Write ONLY: x')"
expect "ADR-0005: retired pg-backend refused"           1 "$(bcn 'builder: pg-backend
Read ONLY:
- `modules/m/domain/uc/f1.ts`
Write ONLY: x')"
expect "ADR-0005: retired pg-frontend refused"          1 "$(bcn 'builder: pg-frontend
Read ONLY:
- `modules/m/domain/uc/f1.ts`
Write ONLY: x')"
expect "no Read ONLY block → 2"                 2 "$(bc '# brief\nDeliver: x')"
expect "small list OK"                          0 "$(bc 'Read ONLY:\n- `modules/m/domain/uc/f1.ts`\n- `modules/m/domain/uc/f2.ts`\n\nWrite ONLY: x')"
expect "brace group expanded"                   0 "$(bc 'Read ONLY:\n- modules/m/domain/uc/{f1,f2,f3}.ts\nWrite ONLY: x')"
expect "14 files over budget"                   1 "$(bc 'Read ONLY:\n- `modules/m/domain/uc/*`\nWrite ONLY: x')"
expect "P7: 8 files OK"                          0 "$(bc 'Read ONLY:\n- modules/m/domain/uc/{f1,f2,f3,f4,f5,f6,f7,f8}.ts\nWrite ONLY: x')"
expect "P7: 9 files OVER BUDGET"                 1 "$(bc 'Read ONLY:\n- modules/m/domain/uc/{f1,f2,f3,f4,f5,f6,f7,f8,f9}.ts\nWrite ONLY: x')"
expect "P7: 1,000 lines OK"                      0 "$(bc 'Read ONLY:\n- `docs/big.md` lines 1-1000\nWrite ONLY: x')"
expect "P7: 1,001 lines OVER BUDGET"             1 "$(bc 'Read ONLY:\n- `docs/big.md` lines 1-1001\nWrite ONLY: x')"
expect "line budget: whole big file refused"    1 "$(bc 'Read ONLY:\n- `docs/big.md`\nWrite ONLY: x')"
expect "line budget: range counted"             0 "$(bc 'Read ONLY:\n- `docs/big.md` lines 10-40\nWrite ONLY: x')"
expect "line budget: two ranges summed"         1 "$(bc 'Read ONLY:\n- `docs/big.md` lines 1-800, 900-1700\nWrite ONLY: x')"
expect "block ends at Write ONLY"               0 "$(bc 'Read ONLY:\n- `modules/m/domain/uc/f1.ts`\nWrite ONLY: `docs/big.md`\n')"
expect "## heading form parsed"                 0 "$(bc '## Read ONLY (workers)\n1. `modules/m/domain/uc/f1.ts`\n\n## Facts\n- `docs/big.md`')"

# ---- check-setup.sh (P4a, GM 2026-09-26): a lane worktree on the shared `pgeos` is refused ------
echo "check-setup.sh — lane database isolation (P4a)"
mkdir -p "$LANE1/scripts" "$LANE1/infra/docker"
cp "$REPO/scripts/check-setup.sh" "$LANE1/scripts/check-setup.sh"
MASTER="$TMP/pg-eos-gov"; mkdir -p "$MASTER/scripts"
cp "$REPO/scripts/check-setup.sh" "$MASTER/scripts/check-setup.sh"
# cs_verdict <worktree-dir> <PGDATABASE|""> <infra/docker/.env content|""> → "OK" or "MISS" (section 0 line only)
cs_verdict() {
  local dir="$1" envdb="$2" envfile="$3"
  if [ -n "$envfile" ]; then printf '%s\n' "$envfile" > "$dir/infra/docker/.env"; else rm -f "$dir/infra/docker/.env"; fi
  local line
  if [ -n "$envdb" ]; then line="$(cd "$dir" && PGDATABASE="$envdb" bash scripts/check-setup.sh 2>/dev/null | sed -n '2p')"
  else line="$(cd "$dir" && env -u PGDATABASE bash scripts/check-setup.sh 2>/dev/null | sed -n '2p')"; fi
  case "$line" in *MISS*) echo "MISS" ;; *OK*) echo "OK" ;; *) echo "NEITHER" ;; esac
}
expect "lane on pgeos (default, no env) refused"    0 "$([ "$(cs_verdict "$LANE1" "" "")" = "MISS" ]; echo $?)"
expect "lane on pgeos (explicit env) refused"       0 "$([ "$(cs_verdict "$LANE1" pgeos "")" = "MISS" ]; echo $?)"
expect "lane with PGDATABASE=pgeos_lane1 not refused (on this check)" 0 "$([ "$(cs_verdict "$LANE1" pgeos_lane1 "")" = "OK" ]; echo $?)"
expect "lane with ONLY infra/docker/.env=pgeos_lane1 (no process env) still refused" 0 "$([ "$(cs_verdict "$LANE1" "" "PGDATABASE=pgeos_lane1")" = "MISS" ]; echo $?)"
expect "lane with process env AND .env both pgeos_lane1 not refused"  0 "$([ "$(cs_verdict "$LANE1" pgeos_lane1 "PGDATABASE=pgeos_lane1")" = "OK" ]; echo $?)"
expect "Master checkout (pg-eos-gov) keeps pgeos, not refused"        0 "$([ "$(cs_verdict "$MASTER" "" "")" = "OK" ]; echo $?)"

# ---- db-guard.sh (D-183): psql DELETE/DROP/TRUNCATE against the shared `pgeos` is refused ------------
echo "db-guard.sh"
dbg() { # dbg <session PGDATABASE|""> <command>  → exit code
  local envdb="$1" cmd="$2"
  local payload; payload="$(printf '%s' "$cmd" | "$PYBIN" -c 'import json,sys; print(json.dumps({"tool_name":"Bash","tool_input":{"command":sys.stdin.read()}}))')"
  if [ -n "$envdb" ]; then printf '%s' "$payload" | PGDATABASE="$envdb" bash "$REPO/.claude/hooks/db-guard.sh" 2>/dev/null; echo $?
  else printf '%s' "$payload" | env -u PGDATABASE bash "$REPO/.claude/hooks/db-guard.sh" 2>/dev/null; echo $?; fi
}
PYBIN="$(command -v python3 || command -v python)"
expect "psql delete on -d pgeos blocked"          2 "$(dbg "" "psql -h localhost -U postgres -d pgeos -c \"delete from wms.stock_balance where x\"")"
expect "psql DROP on --dbname=pgeos blocked"      2 "$(dbg "" "psql --dbname=pgeos -c 'DROP TABLE wms.x'")"
expect "psql truncate via env PGDATABASE blocked" 2 "$(dbg pgeos "psql -c 'truncate wms.x'")"
expect "psql inline PGDATABASE=pgeos blocked"     2 "$(dbg "" "PGDATABASE=pgeos psql -c 'delete from a'")"
expect "psql heredoc body delete blocked"         2 "$(dbg "" "psql -d pgeos -v ON_ERROR_STOP=1 <<'SQL'
begin;
delete from sales.accounts where code like 'x%';
commit;
SQL")"
expect "psql select on pgeos allowed"             0 "$(dbg "" "psql -d pgeos -At -c 'select count(*) from wms.skus'")"
expect "psql delete on throwaway db allowed"      0 "$(dbg "" "psql -d pgeos_scr03 -c 'delete from a'")"
expect "psql drop database throwaway allowed"     0 "$(dbg pgeos "psql -d postgres -c 'drop database if exists pgeos_scr03'")"
expect "-d flag beats env PGDATABASE"             0 "$(dbg pgeos "psql -d pgeos_tmp -c 'delete from a'")"
# D-188: the Master (session project dir basename = pg-eos-gov) may clean the shared DB with the marker.
dbgm() { # dbgm <project-dir basename> <command>  → exit code (session PGDATABASE unset)
  local proj="$TMP/$1" cmd="$2"; mkdir -p "$proj"
  local payload; payload="$(printf '%s' "$cmd" | "$PYBIN" -c 'import json,sys; print(json.dumps({"tool_name":"Bash","tool_input":{"command":sys.stdin.read()}}))')"
  printf '%s' "$payload" | CLAUDE_PROJECT_DIR="$proj" env -u PGDATABASE bash "$REPO/.claude/hooks/db-guard.sh" 2>/dev/null; echo $?
}
MARK='-- MASTER-CLEANUP (D-188)'
expect "D-188: Master worktree + marker allowed"       0 "$(dbgm pg-eos-gov "psql -d pgeos -c \"$MARK
delete from sales.accounts where code like 'x%'\"")"
expect "D-188: Master worktree without marker refused" 2 "$(dbgm pg-eos-gov "psql -d pgeos -c 'delete from a'")"
expect "D-188: lane worktree with marker refused"      2 "$(dbgm pg-eos-lane-1 "psql -d pgeos -c \"$MARK
delete from a\"")"
expect "D-188: look-alike worktree name refused"       2 "$(dbgm pg-eos-gov-x "psql -d pgeos -c \"$MARK
delete from a\"")"
expect "D-188: wrong marker text refused"              2 "$(dbgm pg-eos-gov "psql -d pgeos -c \"-- MASTER-CLEANUP D-188
delete from a\"")"
expect "no db anywhere: allowed"                  0 "$(dbg "" "psql -c 'delete from a'")"
expect "non-psql command with drop allowed"       0 "$(dbg pgeos "git branch -D drop-me && echo 'drop '")"
expect "apply.sh invocation allowed"              0 "$(dbg pgeos "bash database/schema/apply.sh --recreate")"
expect "empty payload allowed"                    0 "$(printf '{}' | bash "$REPO/.claude/hooks/db-guard.sh" 2>/dev/null; echo $?)"

# ---- resolve-hashes.mjs (P3): resolves the `<this commit>` placeholder from git blame ----------
echo "resolve-hashes.mjs"
RH="$TMP/rh"; mkdir -p "$RH/docs"
(
  cd "$RH" && git init -q -b main .
  printf 'line1\nline2 <this commit> placeholder\nline3\n' > docs/PROJECT_STATE.md
  git add docs/PROJECT_STATE.md
  git -c user.email=t@t -c user.name=t commit -q -m 'feat(2.9): introduce placeholder'
  printf 'other\n' > other.txt
  git add other.txt
  git -c user.email=t@t -c user.name=t commit -q -m 'feat(2.9): unrelated, does not touch PROJECT_STATE.md'
) >/dev/null 2>&1
RH_INTRO="$(cd "$RH" && git rev-parse --short=7 HEAD~1)"
rh_check() { ( cd "$RH" && node "$REPO/scripts/resolve-hashes.mjs" --check >/dev/null 2>&1 ); echo $?; }
rh_write() { ( cd "$RH" && node "$REPO/scripts/resolve-hashes.mjs" --write >/dev/null 2>&1 ); echo $?; }
# (b) "a placeholder introduced by an older base commit -> stale": no origin remote here, so base
# falls back to `main`, which (single-branch fixture) equals HEAD; the older commit is still a
# real ancestor of it and != HEAD, so this already exercises the ancestor-of-base rule, not just
# a naive "!= HEAD" check (Master review round 1 BLOCKER fix).
expect "check: stale placeholder (older base commit) refused" 1 "$(rh_check)"
expect "write: exits 0"                                        0 "$(rh_write)"
expect "write: placeholder replaced with introducing hash"     0 "$(grep -q "$RH_INTRO" "$RH/docs/PROJECT_STATE.md"; echo $?)"
expect "write: literal placeholder gone"                       1 "$(grep -q '<this commit>' "$RH/docs/PROJECT_STATE.md"; echo $?)"
expect "check: clean after write"                              0 "$(rh_check)"

# ---- resolve-hashes.mjs (P3, Master review round 1 BLOCKER fix): stale iff the introducing commit
# is an ancestor of the base ref AND is not HEAD — not simply "!= HEAD". A `pull_request` CI build
# checks out a synthetic merge commit (refs/pull/N/merge); a naive "!= HEAD" rule would attribute
# every lane PR's own new placeholder to its lane commit and turn every lane PR red.
echo "resolve-hashes.mjs — ancestor-of-base staleness rule"
RH2="$TMP/rh2"; mkdir -p "$RH2/docs"
(
  cd "$RH2" && git init -q -b main .
  printf 'base line\n' > docs/PROJECT_STATE.md
  git add docs/PROJECT_STATE.md
  git -c user.email=t@t -c user.name=t commit -q -m 'feat(2.9): base, no placeholder'
  git checkout -q -b feature
  printf 'base line\nfeature <this commit> placeholder\n' > docs/PROJECT_STATE.md
  git add docs/PROJECT_STATE.md
  git -c user.email=t@t -c user.name=t commit -q -m 'feat(2.9): PR introduces its own placeholder'
  git checkout -q main
  printf 'base line\nunrelated bump\n' > other.txt
  git add other.txt
  git -c user.email=t@t -c user.name=t commit -q -m 'feat(2.9): main advances, unrelated to the PR'
  git checkout -q -b pr-merge main
  git -c user.email=t@t -c user.name=t merge -q --no-ff feature -m 'Merge PR into main (simulates refs/pull/N/merge)'
) >/dev/null 2>&1
rh2_check() { ( cd "$RH2" && node "$REPO/scripts/resolve-hashes.mjs" --check >/dev/null 2>&1 ); echo $?; }
# (a) placeholder introduced on a feature branch, checked out from the PR's synthetic merge commit -> clean
expect "check: PR's own placeholder on a merge-commit checkout is clean" 0 "$(rh2_check)"

RH3="$TMP/rh3"; mkdir -p "$RH3/docs"
(
  cd "$RH3" && git init -q -b main .
  printf 'line1\nline2 <this commit> placeholder\n' > docs/PROJECT_STATE.md
  git add docs/PROJECT_STATE.md
  git -c user.email=t@t -c user.name=t commit -q -m 'feat(2.9): placeholder introduced by the tip of main itself'
) >/dev/null 2>&1
rh3_check() { ( cd "$RH3" && node "$REPO/scripts/resolve-hashes.mjs" --check >/dev/null 2>&1 ); echo $?; }
# (c) placeholder introduced by HEAD, and HEAD is the base ref's own tip (a plain push-to-main
# build, not a PR) -> clean
expect "check: placeholder introduced by HEAD on the base is clean" 0 "$(rh3_check)"

# ---- resolve-hashes.mjs: the generated "Last 5 feat/fix commits" section may quote a commit subject
# that mentions the placeholder; only that section is exempt (X-scribe-placeholder).
echo "resolve-hashes.mjs — generated commit-list section exemption"
rh_mk() { # rh_mk <dir> <section heading the literal sits under>
  mkdir -p "$1/docs"
  (
    cd "$1" && git init -q -b main .
    { printf '# state\n\n## Lanes (tasks/LANE_LOCKS.md)\n- none\n\n## Last 5 feat/fix commits (git log)\n'
      if [ "$2" = commits ]; then printf -- '- `abc1234` fix(X): resolve the stale <this commit> placeholders\n'; else printf -- '- `abc1234` fix(X): clean\n'; fi
      printf '\n## Blockers\n'
      if [ "$2" = blockers ]; then printf -- '- stale <this commit> placeholder\n'; else printf -- '- none\n'; fi
      printf '\n## Next\n1. go\n'; } > docs/PROJECT_STATE.md
    git add docs/PROJECT_STATE.md
    git -c user.email=t@t -c user.name=t commit -q -m 'feat(2.9): state with quoted subject'
    printf 'other\n' > other.txt
    git add other.txt
    git -c user.email=t@t -c user.name=t commit -q -m 'feat(2.9): unrelated, HEAD moves past the state commit'
  ) >/dev/null 2>&1
}
RH4="$TMP/rh4"; rh_mk "$RH4" commits
RH5="$TMP/rh5"; rh_mk "$RH5" blockers
rh4_run() { ( cd "$RH4" && node "$REPO/scripts/resolve-hashes.mjs" "$1" >/dev/null 2>&1 ); echo $?; }
rh5_run() { ( cd "$RH5" && node "$REPO/scripts/resolve-hashes.mjs" "$1" >/dev/null 2>&1 ); echo $?; }
expect "check: placeholder quoted in the commit-list section (ancestor of base) is clean" 0 "$(rh4_run --check)"
expect "write: commit-list section exits 0 and literal left untouched"                  0 "$(rc=$(rh4_run --write); grep -qF 'stale <this commit> placeholders' "$RH4/docs/PROJECT_STATE.md" || rc=9; echo $rc)"
expect "check: placeholder in the Blockers section (ancestor of base) still refused"    1 "$(rh5_run --check)"

# ---- gov-ratio.sh (P3): 7-day feat/fix(<WBS>) ratio + average review rounds --------------------
echo "scribe.mjs"
SC="$TMP/scribe"; mkdir -p "$SC/docs/state" "$SC/tasks"
( cd "$SC" && git init -q -b main && git config user.email t@t && git config user.name t
  printf 'Plan: x\n' > docs/state/header.md; printf 'b1\n' > docs/state/blockers.md; printf 'n1\n' > docs/state/next.md
  printf '| module | lane | task | claimed_at | worktree |\n|---|---|---|---|---|\n| wms | 1 | 2.10 | 2026-09-25 | ../pg-eos-lane-1 |\n' > tasks/LANE_LOCKS.md
  git add -A && git commit -qm 'feat(2.10): first' && git commit -q --allow-empty -m 'chore(X): bookkeeping' \
  && git commit -q --allow-empty -m 'feat(2.10): second, closes <this commit> placeholders' )
sc_run() { ( cd "$SC" && node "$REPO/scripts/scribe.mjs" "$1" >/dev/null 2>&1 ); echo $?; }
expect "scribe: --check before --write refused"      1 "$(sc_run --check)"
expect "scribe: --write generates"                   0 "$(sc_run --write)"
expect "scribe: --check after --write OK"            0 "$(sc_run --check)"
expect "scribe: commit-subject placeholder rewritten to <this-commit>" 0 "$(cd "$SC" && grep -qF '<this-commit>' docs/PROJECT_STATE.md; echo $?)"
expect "scribe: literal <this commit> absent from PROJECT_STATE"      1 "$(cd "$SC" && grep -qF '<this commit>' docs/PROJECT_STATE.md; echo $?)"
expect "scribe: lanes + last commit rendered"        0 "$(cd "$SC" && grep -q 'lane 1 · wms · 2.10' docs/PROJECT_STATE.md && grep -q 'feat(2.10): first' docs/PROJECT_STATE.md && ! grep -q 'chore(X)' docs/PROJECT_STATE.md; echo $?)"
expect "scribe: hand edit refused"                   1 "$(cd "$SC" && echo 'manual' >> docs/PROJECT_STATE.md; sc_run --check)"
expect "scribe: over-long source line refused"       1 "$(cd "$SC" && printf '%0200d\n' 0 > docs/state/next.md; sc_run --write)"
expect "scribe: placeholder in source refused"       1 "$(cd "$SC" && printf 'n <this commit>\n' > docs/state/next.md; sc_run --write)"

echo "gov-ratio.sh"
GR="$TMP/gr"; mkdir -p "$GR/scripts/lib"
cp "$REPO/scripts/lib/review-trailer.sh" "$GR/scripts/lib/"
(
  cd "$GR" && git init -q -b main .
  git -c user.email=t@t -c user.name=t commit -q --allow-empty -m "$(printf 'feat(2.9): a\n\nReview: PASS(3 findings, 2 rounds)')"
  git -c user.email=t@t -c user.name=t commit -q --allow-empty -m "$(printf 'fix(2.9): b\n\nReview: PASS(1 findings, 4 rounds)')"
  git -c user.email=t@t -c user.name=t commit -q --allow-empty -m "$(printf 'feat(2.9): c\n\nReview: PASS(5 findings fixed)')"
  git -c user.email=t@t -c user.name=t commit -q --allow-empty -m 'chore(X): bookkeeping'
  git -c user.email=t@t -c user.name=t commit -q --allow-empty -m "$(printf 'docs(X): a note\n\nDecision: D-1')"
) >/dev/null 2>&1
# ---- scenarios-verdict.mjs (G15, docs/STREAMS.md §G15): merge gate = green.json regressions only;
# --strict (deploy) = 20/20 present and passed ---------------------------------------------------
echo "scenarios-verdict.mjs"
SV="$TMP/sv"; mkdir -p "$SV"
sv_report() { # sv_report <file> <S1 ok> <S2 ok>  (two present scenarios)
  printf '{"suites":[{"title":"S1.spec.ts","file":"S1.spec.ts","suites":[{"title":"S1 client","specs":[{"title":"inbound","ok":%s,"tests":[{"results":[{"status":"%s"}]}]}]}]},{"title":"S2.spec.ts","file":"S2.spec.ts","specs":[{"title":"S2 storage","ok":%s,"tests":[{"results":[{"status":"%s"}]}]}]}]}' \
    "$2" "$([ "$2" = true ] && echo passed || echo failed)" "$3" "$([ "$3" = true ] && echo passed || echo failed)" > "$1"
}
sv_report "$SV/red.json" false false
sv_report "$SV/s1.json" true false
printf '{"green":[]}' > "$SV/none.json"; printf '{"green":["S1"]}' > "$SV/g1.json"; printf '{"green":["S1","S2"]}' > "$SV/g12.json"; printf '{"green":["S3"]}' > "$SV/g3.json"; printf '{"nope":1}' > "$SV/bad.json"
sv() { node "$REPO/scripts/scenarios-verdict.mjs" "$@" 2>/dev/null || true; }  # output checks under pipefail: exit via sv_code
sv_code() { node "$REPO/scripts/scenarios-verdict.mjs" "$@" >/dev/null 2>&1; echo $?; }
expect "merge gate: nothing listed, S1/S2 RED → green (reported only)"  0 "$(sv_code "$SV/red.json" --manifest "$SV/none.json")"
expect "merge gate: first line is 'green'"                                0 "$(sv "$SV/red.json" --manifest "$SV/none.json" | head -1 | grep -qx green; echo $?)"
expect "merge gate: summary counts 2/20 present, 0/20 passed"             0 "$(sv "$SV/red.json" --manifest "$SV/none.json" | grep -q '2/20 present, 0/20 passed'; echo $?)"
expect "merge gate: listed S1 passing, S2 RED unlisted → green"           0 "$(sv_code "$SV/s1.json" --manifest "$SV/g1.json")"
expect "merge gate: listed S1 failing → red regression"                   1 "$(sv_code "$SV/red.json" --manifest "$SV/g1.json")"
expect "merge gate: names the failing listed scenario"                    0 "$(sv "$SV/red.json" --manifest "$SV/g1.json" | head -1 | grep -q 'failing (S1)'; echo $?)"
expect "merge gate: listed S2 failing while S1 passes → red"              1 "$(sv_code "$SV/s1.json" --manifest "$SV/g12.json")"
expect "merge gate: listed S3 missing → red regression"                   1 "$(sv_code "$SV/s1.json" --manifest "$SV/g3.json")"
expect "merge gate: names the missing listed scenario"                    0 "$(sv "$SV/s1.json" --manifest "$SV/g3.json" | head -1 | grep -q 'missing (S3)'; echo $?)"
expect "strict: 2/20 present → red"                                       1 "$(sv_code "$SV/s1.json" --strict --manifest "$SV/none.json")"
expect "strict: red line names 20/20 and the missing ids"                 0 "$(sv "$SV/s1.json" --strict --manifest "$SV/none.json" | head -1 | grep -q '20/20.*missing S3'; echo $?)"
expect "unreadable report → red, exit 1"                                  1 "$(sv_code "$SV/absent.json" --manifest "$SV/none.json")"
expect "manifest without a green array → red, exit 1"                     1 "$(sv_code "$SV/s1.json" --manifest "$SV/bad.json")"
expect "no report argument → usage exit 2"                                2 "$(sv_code --manifest "$SV/none.json")"
# ---- scribe.mjs v2 (CLAUDE.md · AGENTS AND SESSIONS): --claim / --release write the lock table through
# check-locks.sh; --changelog-template prints (and with --insert inserts) the ≤ 12-line entry skeleton ---
echo "scribe.mjs"
SC="$TMP/scribe"; mkdir -p "$SC/scripts" "$SC/tasks" "$SC/docs/state"
cp "$REPO/scripts/scribe.mjs" "$REPO/scripts/check-locks.sh" "$SC/scripts/"
printf '# LANE_LOCKS\n\n| module | lane | task | claimed_at | worktree |\n|---|---|---|---|---|\n\n## Rules\n\n1. one lock per module.\n' > "$SC/tasks/LANE_LOCKS.md"
printf 'Plan: fixture.\n' > "$SC/docs/state/header.md"; printf 'none.\n' > "$SC/docs/state/blockers.md"; printf 'next.\n' > "$SC/docs/state/next.md"
printf '# CHANGELOG\n\nOne entry per task.\n\n---\n\n## X — older entry (2026-01-01)\n\n- older.\n' > "$SC/docs/CHANGELOG.md"
( cd "$SC" && git init -q -b main . && git add -A && git -c user.email=t@t -c user.name=t commit -q -m 'feat(2.9): fixture' ) >/dev/null 2>&1
sc() { ( cd "$SC" && CHECK_LOCKS_WBS="$REPO/docs/package/38-WBS.md" node scripts/scribe.mjs "$@" >/dev/null 2>&1 ); echo $?; }
sc_out() { ( cd "$SC" && CHECK_LOCKS_WBS="$REPO/docs/package/38-WBS.md" node scripts/scribe.mjs "$@" 2>/dev/null || true ); }
expect "scribe: --write renders PROJECT_STATE"                    0 "$(sc --write)"
expect "scribe: --check green after --write"                      0 "$(sc --check)"
expect "scribe: --claim wms 1 2.9 exits 0"                        0 "$(sc --claim wms 1 2.9)"
expect "scribe: claim row written with today's date and worktree" 0 "$(grep -qE '^\| wms \| 1 \| 2\.9 \| [0-9]{4}-[0-9]{2}-[0-9]{2} \| \.\./pg-eos-lane-1 \|$' "$SC/tasks/LANE_LOCKS.md"; echo $?)"
expect "scribe: PROJECT_STATE lists the lane after a claim"       0 "$(grep -q 'lane 1 · wms · 2.9' "$SC/docs/PROJECT_STATE.md"; echo $?)"
expect "scribe: second claim of the same lock refused"            1 "$(sc --claim wms 2 2.9)"
expect "scribe: cloud claim writes cloud:session_<id> (ADR-0007)" 0 "$(sc --claim fleet 2 2.9 cloud:session_01XyZ >/dev/null; grep -qE '^\| fleet \| 2 \| 2\.9 \| [0-9-]+ \| cloud:session_01XyZ \|$' "$SC/tasks/LANE_LOCKS.md"; echo $?)"
expect "scribe: malformed cloud worktree refused"                 1 "$(sc --claim tms 2 2.9 somewhere)"
expect "scribe: claim with a task that is not a doc-38 row refused (check-locks), table unchanged" 1 "$(sc --claim hr 2 NOPE-ROW)"
expect "scribe: table unchanged after the refused claim"          1 "$(grep -q '^| hr ' "$SC/tasks/LANE_LOCKS.md"; echo $?)"
expect "scribe: claim with a bad lane refused"                    1 "$(sc --claim hr 9 2.9)"
expect "scribe: --release wms exits 0"                            0 "$(sc --release wms)"
expect "scribe: row gone after release"                           1 "$(grep -q '^| wms ' "$SC/tasks/LANE_LOCKS.md"; echo $?)"
expect "scribe: release of a missing lock refused"                1 "$(sc --release wms)"
expect "scribe: --changelog-template prints the heading"          0 "$(sc_out --changelog-template 2.9 'Receive inbound' | head -1 | grep -qE '^## 2\.9 — Receive inbound \([0-9-]{10}\)$'; echo $?)"
expect "scribe: template is at most 12 lines"                     0 "$(n=$(sc_out --changelog-template 2.9 t | wc -l); [ "$n" -le 12 ]; echo $?)"
expect "scribe: --insert puts the entry above the older one"      0 "$(sc --changelog-template 2.9 'Receive inbound' --insert >/dev/null; awk '/^## /{print; exit}' "$SC/docs/CHANGELOG.md" | grep -q '^## 2.9 — Receive inbound'; echo $?)"
expect "scribe: unknown mode exits 2"                             2 "$(sc --nope)"
GR_OUT="$(cd "$GR" && GOV_BUDGET_REF=main bash "$REPO/scripts/gov-ratio.sh" 2>/dev/null)"
expect "gov-ratio: total commits = 5"              0 "$(printf '%s' "$GR_OUT" | grep -qE 'total commits +: 5'; echo $?)"
expect "gov-ratio: feat/fix(<WBS>) commits = 3"    0 "$(printf '%s' "$GR_OUT" | grep -qE 'feat/fix\(<WBS>\) commits +: 3'; echo $?)"
expect "gov-ratio: ratio 60.0% (3/5, meets target)" 0 "$(printf '%s' "$GR_OUT" | grep -q '60.0% feat/fix'; echo $?)"
expect "gov-ratio: avg rounds 3.00 over 2 new-form" 0 "$(printf '%s' "$GR_OUT" | grep -q 'avg 3.00 over 2 commit'; echo $?)"
expect "gov-ratio: 1 old-form trailer excluded"     0 "$(printf '%s' "$GR_OUT" | grep -q '1 old-form trailer(s) excluded'; echo $?)"
expect "gov-ratio: chore(X)/docs(X) = 2 today"      0 "$(printf '%s' "$GR_OUT" | grep -q ': 2$'; echo $?)"
expect "gov-ratio: unknown ref exits 2"             2 "$(cd "$GR" && GOV_BUDGET_REF=no-such-ref bash "$REPO/scripts/gov-ratio.sh" >/dev/null 2>&1; echo $?)"

# ---- post-edit-check.sh (GM 2026-09-27 "نفذ الكل بنفسك"): lint + typecheck of the touched package after
# every Edit/Write; exit 2 = findings fed back, exit 0 = nothing to report. Test seams PEC_LINT_CMD /
# PEC_TYPECHECK_CMD replace eslint / `pnpm run typecheck`; each stub records that it ran.
echo "post-edit-check.sh"
PEC="$TMP/pec"; mkdir -p "$PEC/modules/wms/domain" "$PEC/bin"
printf '{ "name": "@pg-eos/wms" }\n' > "$PEC/modules/wms/package.json"
printf 'export const x = 1;\n' > "$PEC/modules/wms/domain/x.ts"
printf 'export const r = 1;\n' > "$PEC/root-level.ts"
printf '# doc\n' > "$PEC/README.md"
printf '#!/usr/bin/env bash\necho "$1" >> "%s/lint.ran"; exit "${PEC_LINT_RC:-0}"\n' "$PEC" > "$PEC/bin/lint"
printf '#!/usr/bin/env bash\necho "$1" >> "%s/tc.ran"; exit "${PEC_TC_RC:-0}"\n' "$PEC" > "$PEC/bin/tc"
pec() { # pec <path> <lint-rc> <tc-rc> → exit code; stub run markers in $PEC/{lint,tc}.ran
  rm -f "$PEC/lint.ran" "$PEC/tc.ran"
  printf '{"tool_name":"Edit","tool_input":{"file_path":"%s"}}' "$1" \
    | CLAUDE_PROJECT_DIR="$PEC" PEC_LINT_CMD="bash $PEC/bin/lint" PEC_TYPECHECK_CMD="bash $PEC/bin/tc" PEC_LINT_RC="$2" PEC_TC_RC="$3" \
      bash "$REPO/.claude/hooks/post-edit-check.sh" 2>/dev/null; echo $?
}
expect "ts file, lint + typecheck green → 0"      0 "$(pec modules/wms/domain/x.ts 0 0)"
expect "  … lint stub ran on the file"            0 "$(grep -qx 'modules/wms/domain/x.ts' "$PEC/lint.ran"; echo $?)"
expect "  … typecheck stub ran on the package"    0 "$(grep -qx 'modules/wms' "$PEC/tc.ran"; echo $?)"
expect "ts file, lint red → 2"                    2 "$(pec modules/wms/domain/x.ts 1 0)"
expect "ts file, typecheck red → 2"               2 "$(pec modules/wms/domain/x.ts 0 1)"
expect "absolute path normalised"                 0 "$(pec "$PEC/modules/wms/domain/x.ts" 0 0)"
expect "markdown file → 0 without running"        0 "$(pec README.md 1 1)"
expect "  … no stub ran for markdown"             1 "$([ -f "$PEC/lint.ran" ] || [ -f "$PEC/tc.ran" ]; echo $?)"
expect "missing ts file → 0"                      0 "$(pec modules/wms/domain/absent.ts 1 1)"
expect "root-level ts: lint only, no package"     0 "$(pec root-level.ts 0 1)"
expect "  … typecheck stub not run at root"       1 "$([ -f "$PEC/tc.ran" ]; echo $?)"
expect "empty payload → 0"                        0 "$(printf '{}' | CLAUDE_PROJECT_DIR="$PEC" bash "$REPO/.claude/hooks/post-edit-check.sh" 2>/dev/null; echo $?)"

# ---- pre-commit gate ⓒ (GM 2026-09-27): gitleaks on the staged content, before the docs-only exit;
# blocking only when gitleaks is installed (CI gate ⑥ always blocks). A docs-only fixture keeps
# gates ①–③ (pnpm) out of the test.
echo "pre-commit — gate ⓒ gitleaks (staged)"
GLR="$TMP/glr"; mkdir -p "$GLR/bin"
( cd "$GLR" && git init -q -b main . && printf 'note\n' > note.md && git add note.md ) >/dev/null 2>&1
printf '#!/usr/bin/env bash\nexit "${GL_RC:-0}"\n' > "$GLR/bin/gitleaks"; chmod +x "$GLR/bin/gitleaks"
# PATH without any directory that ships a gitleaks binary (keeps git, bash, coreutils reachable).
NO_GL_PATH="$(printf '%s' "$PATH" | tr ':' '\n' | while IFS= read -r d; do
  [ -n "$d" ] || continue
  if [ -x "$d/gitleaks" ] || [ -x "$d/gitleaks.exe" ]; then continue; fi
  printf '%s:' "$d"
done)"
pcg() { # pcg <gitleaks rc | "none"> → pre-commit exit code
  if [ "$1" = none ]; then ( cd "$GLR" && PATH="${NO_GL_PATH%:}" bash "$REPO/.githooks/pre-commit" >/dev/null 2>&1 ); echo $?
  else ( cd "$GLR" && PATH="$GLR/bin:$PATH" GL_RC="$1" bash "$REPO/.githooks/pre-commit" >/dev/null 2>&1 ); echo $?; fi
}
expect "gitleaks clean → docs-only commit accepted"   0 "$(pcg 0)"
expect "gitleaks finds a secret → refused"            1 "$(pcg 1)"
expect "gitleaks not installed → warn, not refused"   0 "$(pcg none)"

# ---- X-p17 (ADR-0007 addendum gates): agent-constraints copy · check-locks cap · auto-archive · strict merge step
echo "X-p17 — agent-constraints copy"
AC_BLOCK='AGENT CONSTRAINTS (copied verbatim into every agent file — gate ①)
- No `any`, `@ts-ignore`, `eslint-disable`. Never weaken a test to pass it.
- No if/switch for state transitions — XState. No magic numbers — constants.
- No Math.random() / new Date() in domain/ — inject generator and clock.
- Never fabricate a number, name or decision. Never soften a rule.'
AC_D199='- No embedded UI strings — i18n (ar, en, hi, ur, bn, am); exception (D-199): the language selector box in apps/<app>/src/i18n/languages.ts.'
AC_AGENTS="pg-tester pg-builder pg-builder-core pg-reviewer"
ac_root() { # ac_root <name> <claude-block> <block for every agent>  → creates $TMP/<name>
  local r="$TMP/$1" a; rm -rf "$r"; mkdir -p "$r/.claude/agents"
  printf '# CLAUDE.md\n\nintro line\n\n%s\n\nafter the block\n' "$2" > "$r/CLAUDE.md"
  for a in $AC_AGENTS; do printf -- '---\nname: %s\n---\n\nbody\n\n%s\n\ntail\n' "$a" "$3" > "$r/.claude/agents/$a.md"; done
}
ac() { bash "$REPO/scripts/check-agent-constraints.sh" --root "$TMP/$1" >/dev/null 2>&1; echo $?; }
ac_root ac1 "$AC_BLOCK" "$AC_BLOCK"
expect "X-p17: identical AGENT CONSTRAINTS blocks → 0"                    0 "$(ac ac1)"
ac_root ac2 "$AC_BLOCK" "$AC_BLOCK"
sed -i 's/Never soften a rule\./Never soften a rulf./' "$TMP/ac2/.claude/agents/pg-builder.md"
expect "X-p17: one copy with one changed character → 1"                   1 "$(ac ac2)"
ac_err() { bash "$REPO/scripts/check-agent-constraints.sh" --root "$TMP/$1" 2>&1 >/dev/null || true; }   # stderr only
expect "X-p17: differing copy is named on stderr (pg-builder.md)"         0 "$(ac_err ac2 | grep 'pg-builder\.md' >/dev/null; echo $?)"
ac_root ac3 "$AC_BLOCK" "$AC_BLOCK"
printf -- '---\nname: pg-reviewer\n---\n\nbody without the block\n' > "$TMP/ac3/.claude/agents/pg-reviewer.md"
expect "X-p17: one copy missing the block → 1"                            1 "$(ac ac3)"
expect "X-p17: missing block: stderr names pg-reviewer.md"                0 "$(ac_err ac3 | grep 'pg-reviewer\.md' >/dev/null; echo $?)"
ac_root ac4 "$AC_BLOCK" "$AC_BLOCK"
printf '# CLAUDE.md\n\nno constraints here\n' > "$TMP/ac4/CLAUDE.md"
expect "X-p17: CLAUDE.md without the block → 1"                           1 "$(ac ac4)"
AC_BLOCK_D="$AC_BLOCK
$AC_D199"
ac_root ac5 "$AC_BLOCK_D" "$AC_BLOCK_D"
expect "X-p17: D-199 exception line in CLAUDE.md and all four copies → 0" 0 "$(ac ac5)"
ac_root ac6 "$AC_BLOCK_D" "$AC_BLOCK_D"
printf -- '---\nname: pg-tester\n---\n\nbody\n\n%s\n\ntail\n' "$AC_BLOCK" > "$TMP/ac6/.claude/agents/pg-tester.md"
expect "X-p17: D-199 line in CLAUDE.md, one copy without it → 1"          1 "$(ac ac6)"
expect "X-p17: real repo: CLAUDE.md and the four agent copies identical"  0 "$(bash "$REPO/scripts/check-agent-constraints.sh" >/dev/null 2>&1; echo $?)"

echo "X-p17 — check-locks max three lanes"
printf '| module | lane | task | claimed_at | worktree |\n|---|---|---|---|---|\n| a | 1 | 2.11 | d | ../pg-eos-lane-1 |\n| b | 2 | 2.13 | d | ../pg-eos-lane-2 |\n| c | 3 | 3.14 | d | ../pg-eos-lane-3 |\n| e | A | 2.7 | d | ../pg-eos-lane-A |\n' > "$TMP/locks4.md"
bash "$REPO/scripts/check-locks.sh" "$TMP/locks4.md" >/dev/null 2>"$TMP/locks4.err"; lk4=$?
expect "X-p17: lanes 1,2,3 and A refused with 'max three lanes' on stderr" 0 "$([ "$lk4" = 1 ] && grep -q 'max three lanes' "$TMP/locks4.err"; echo $?)"
expect "X-p17: lanes 1,2,3 plus a Master row accepted (M not counted)"    0 "$(cl '| a | 1 | 2.11 | d | ../pg-eos-lane-1 |\n| b | 2 | 2.13 | d | ../pg-eos-lane-2 |\n| c | 3 | 3.14 | d | ../pg-eos-lane-3 |\n| packages/db | M | 0.6a | d | claude-kit |')"

echo "X-p17 — session-archive.sh"
SA="$REPO/scripts/lib/session-archive.sh"
sa() { ( . "$SA" 2>/dev/null && archive_decide "$@" 2>/dev/null ); }   # → prints archive|keep
sa_code() { ( . "$SA" >/dev/null 2>&1 && archive_decide "$@" >/dev/null 2>&1 ); echo $?; }
# archive_decide <acked> <merged> <open_pr> <idle_minutes> <tree_clean> <commits_ahead> <stash_count>
expect "X-p17: constant ARCHIVE_IDLE_MINUTES=120 declared"                0 "$(grep -q '^ARCHIVE_IDLE_MINUTES=120$' "$SA" 2>/dev/null; echo $?)"
expect "X-p17: acked → archive"                                           0 "$([ "$(sa 1 0 0 0 0 5 2)" = archive ]; echo $?)"
expect "X-p17: merged → archive"                                          0 "$([ "$(sa 0 1 0 0 0 5 2)" = archive ]; echo $?)"
expect "X-p17: acked with an open PR → archive"                           0 "$([ "$(sa 1 0 1 0 0 5 2)" = archive ]; echo $?)"
expect "X-p17: idle 121, no PR, clean, pushed, nothing stashed → archive" 0 "$([ "$(sa 0 0 0 121 1 0 0)" = archive ]; echo $?)"
expect "X-p17: idle 120 (not over the constant) → keep"                   0 "$([ "$(sa 0 0 0 120 1 0 0)" = keep ]; echo $?)"
expect "X-p17: idle 121 clean pushed nothing stashed but an open PR → keep" 0 "$([ "$(sa 0 0 1 121 1 0 0)" = keep ]; echo $?)"
expect "X-p17: idle 121 with a dirty tree → keep"                         0 "$([ "$(sa 0 0 0 121 0 0 0)" = keep ]; echo $?)"
expect "X-p17: idle 121 with a commit ahead → keep"                       0 "$([ "$(sa 0 0 0 121 1 1 0)" = keep ]; echo $?)"
expect "X-p17: idle 121 with a stash → keep"                              0 "$([ "$(sa 0 0 0 121 1 0 1)" = keep ]; echo $?)"
expect "X-p17: non-numeric argument → exit 2"                             2 "$(sa_code 0 0 0 abc 1 0 0)"
expect "X-p17: flag not 0|1 (acked=2) → exit 2"                          2 "$(sa_code 2 0 0 121 1 0 0)"
expect "X-p17: missing argument → exit 2"                                 2 "$(sa_code 0 0 0 121)"
# generated property table: seeded LCG, oracle computed inline from the stated rule
LCG_SEED=20260930; LCG_A=1103515245; LCG_C=12345; LCG_M=2147483648; LCG_CASES=1000
LCG_IDLE_RANGE=301; LCG_AHEAD_RANGE=4; LCG_STASH_RANGE=3; ORACLE_IDLE_LIMIT=120
BOUND_LO=100; BOUND_SPAN=41          # every other case draws idle in 100..140 so 120/121 appear
MIN_BRANCH_HITS=5; LCG_RARE=8        # acked/merged 1 in 8; tree clean 7 in 8 (bias toward the idle branches)
sa_out="$( ( . "$SA" >/dev/null 2>&1 || { echo "MM=$LCG_CASES H_ACK=0 H_IDLE=0 H_PR=0 H_DIRTY=0 H_AHEAD=0 H_STASH=0 H_SHORT=0"; exit 0; }
  s=$LCG_SEED; mm=0; hack=0; hidle=0; hpr=0; hdirty=0; hahead=0; hstash=0; hshort=0
  next() { s=$(( (s * LCG_A + LCG_C) % LCG_M )); R=$(( s >> 8 )); }
  for n in $(seq 1 "$LCG_CASES"); do
    next; ak=$(( R % LCG_RARE == 0 )); next; mg=$(( R % LCG_RARE == 0 )); next; op=$(( R % 2 )); next; id=$(( R % LCG_IDLE_RANGE ))
    [ $(( n % 2 )) = 0 ] && id=$(( BOUND_LO + R % BOUND_SPAN ))
    next; cn=$(( R % LCG_RARE != 0 )); next; ah=$(( R % LCG_AHEAD_RANGE )); next; st=$(( R % LCG_STASH_RANGE ))
    if [ "$ak" = 1 ] || [ "$mg" = 1 ]; then want=archive; hack=$((hack+1))
    elif [ "$op" = 1 ]; then want=keep; hpr=$((hpr+1))
    elif [ "$id" -le "$ORACLE_IDLE_LIMIT" ]; then want=keep; hshort=$((hshort+1))
    elif [ "$cn" != 1 ]; then want=keep; hdirty=$((hdirty+1))
    elif [ "$ah" != 0 ]; then want=keep; hahead=$((hahead+1))
    elif [ "$st" != 0 ]; then want=keep; hstash=$((hstash+1))
    else want=archive; hidle=$((hidle+1)); fi
    got="$(archive_decide "$ak" "$mg" "$op" "$id" "$cn" "$ah" "$st" 2>/dev/null)"
    [ "$got" = "$want" ] || mm=$((mm+1))
  done
  echo "MM=$mm H_ACK=$hack H_IDLE=$hidle H_PR=$hpr H_DIRTY=$hdirty H_AHEAD=$hahead H_STASH=$hstash H_SHORT=$hshort" ) )"
sa_field() { printf '%s\n' "$sa_out" | tr ' ' '\n' | sed -n "s/^$1=//p"; }
expect "X-p17: property table, $LCG_CASES seeded cases, 0 mismatches vs oracle" 0 "$([ "$(sa_field MM)" = 0 ]; echo $?)"
for br in H_ACK H_IDLE H_PR H_DIRTY H_AHEAD H_STASH H_SHORT; do
  expect "X-p17: property table drew branch $br at least $MIN_BRANCH_HITS times" 0 "$([ "$(sa_field $br)" -ge "$MIN_BRANCH_HITS" ] 2>/dev/null; echo $?)"
done

echo "X-p17 — merge-step.sh strict guards"
MS="$TMP/ms"; mkdir -p "$MS/scripts"
cp "$REPO/scripts/merge-step.sh" "$MS/scripts/merge-step.sh" 2>/dev/null
printf '#!/usr/bin/env bash\nprintf "%%s" "${PG_GUARDS_STRICT:-unset}" > "%s/seen"\nexit "${STUB_EXIT:-0}"\n' "$MS" > "$MS/scripts/guards-run.sh"
# scripts/guards-run.sh is what `pnpm guards:run` runs (package.json:18)
ms_code() { rm -f "$MS/seen"; ( cd "$MS" && env -u PG_GUARDS_STRICT STUB_EXIT="$1" bash "$MS/scripts/merge-step.sh" >/dev/null 2>&1 ); echo $?; }
ms_code 0 >/dev/null
expect "X-p17: merge step runs guards-run.sh with PG_GUARDS_STRICT=1"     0 "$([ "$(cat "$MS/seen" 2>/dev/null)" = 1 ]; echo $?)"
expect "X-p17: guards-run exit 0 → merge step exit 0"                     0 "$(ms_code 0)"
expect "X-p17: guards-run exit 3 → merge step exits exactly 3 (stub ran)" 0 "$(c="$(ms_code 3)"; [ "$c" -eq 3 ] && [ -f "$MS/seen" ]; echo $?)"
rm -f "$MS/seen"; ( cd "$MS" && PG_GUARDS_STRICT=0 STUB_EXIT=0 bash "$MS/scripts/merge-step.sh" >/dev/null 2>&1 )
expect "X-p17: caller exporting PG_GUARDS_STRICT=0 → stub still sees 1"   0 "$([ "$(cat "$MS/seen" 2>/dev/null)" = 1 ]; echo $?)"
expect "X-p17: merge-step.sh text carries PG_GUARDS_STRICT=1"             0 "$(grep -q 'PG_GUARDS_STRICT=1' "$REPO/scripts/merge-step.sh" 2>/dev/null; echo $?)"
# ---- X-d208 (GM 2026-09-30): test scope rule in the agent files (M-core, tooling) -------------
echo "agent files — TEST SCOPE (D-208)"
TESTER="$REPO/.claude/agents/pg-tester.md"; REVIEWER="$REPO/.claude/agents/pg-reviewer.md"
has() { grep -qF -- "$2" "$1" 2>/dev/null; echo $?; }
hasx() { grep -qxF -- "$2" "$1" 2>/dev/null; echo $?; }
TRULE='- Property tests (fast-check) ONLY on invariants of stock (wms ledger/balances), money (billing journals/amounts) and security (RLS, permissions, audit chain); every other rule gets an ordinary unit test. No behaviour is tested twice across layers: one assertion per rule at the lowest layer that can prove it (domain unit > application integration > scenario); the scenario asserts only the doc 40 Part E step text. Coverage ≥ 90% on domain/ and the guards G1–G17 are unchanged.'
RRULE='- A duplicated test across layers, or a property test outside the three D-208 scopes (stock, money, security), is a blocking finding in the pre-build review.'
before() { a=$(grep -nF -- "$2" "$1" | head -1 | cut -d: -f1); b=$(grep -n '^AGENT CONSTRAINTS' "$1" | head -1 | cut -d: -f1); if [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]; then echo 0; else echo 1; fi; }
expect "pg-tester.md has heading TEST SCOPE (D-208)"          0 "$(has "$TESTER" 'TEST SCOPE (D-208)')"
expect "pg-tester.md carries the whole rule line verbatim"    0 "$(hasx "$TESTER" "$TRULE")"
expect "pg-tester.md: D-208 heading is before AGENT CONSTRAINTS" 0 "$(before "$TESTER" 'TEST SCOPE (D-208)')"
expect "pg-reviewer.md has heading PRE-BUILD BLOCKING (D-206, D-208)" 0 "$(has "$REVIEWER" 'PRE-BUILD BLOCKING (D-206, D-208)')"
expect "pg-reviewer.md carries the whole blocking sentence verbatim" 0 "$(hasx "$REVIEWER" "$RRULE")"
expect "pg-reviewer.md: D-206/D-208 heading is before AGENT CONSTRAINTS" 0 "$(before "$REVIEWER" 'PRE-BUILD BLOCKING (D-206, D-208)')"
# ---- X part 19: lane-db.sh accepts the lane letters A|B|C as well as 1|2|3 (no Postgres needed:
# PATH holds only dirname, so an accepted id fails later on "psql not found", a refused id on usage:).
echo "lane-db.sh — lane ids (X part 19)"
LDB="$TMP/ldbbin"; mkdir -p "$LDB"; ln -sf "$(command -v dirname)" "$LDB/dirname"
ldb() { # ldb <id> → stderr of lane-db.sh with a psql-less PATH
  PATH="$LDB" "$(command -v bash)" "$REPO/scripts/lane-db.sh" "$@" 2>&1 >/dev/null
}
ldb_usage() { local e; e="$(ldb "$@")"; case "$e" in *"psql not found on PATH"*) echo 1;; *usage:*) echo 0;; *) echo 9;; esac; }   # 1 = accepted, 0 = refused, 9 = crash/other
expect "lane-db: B accepted"                 1 "$(ldb_usage B)"
expect "lane-db: A accepted"                 1 "$(ldb_usage A)"
expect "lane-db: C accepted"                 1 "$(ldb_usage C)"
expect "lane-db: 1 accepted (regression)"    1 "$(ldb_usage 1)"
expect "lane-db: M refused"                  0 "$(ldb_usage M)"
expect "lane-db: 9 refused"                  0 "$(ldb_usage 9)"
expect "lane-db: empty refused"              0 "$(ldb_usage '')"
expect "lane-db: lowercase b refused"        0 "$(ldb_usage b)"
ldb_refuse() { local rc e; e="$(PATH="$LDB" "$(command -v bash)" "$REPO/scripts/lane-db.sh" M 2>&1 >/dev/null)"; rc=$?; case "$e" in *usage:*) echo "$rc";; *) echo 99;; esac; }
expect "lane-db: refusal exits 2 with usage:" 2 "$(ldb_refuse)"
ldb_usage_line() { local e; e="$(ldb 9)"; case "$e" in *"usage: bash scripts/lane-db.sh <1|2|3|A|B|C>"*) echo 0;; *) echo 1;; esac; }
expect "lane-db: usage line (stderr, executed) lists A|B|C" 0 "$(ldb_usage_line)"
# name derivation, executed against a fixture root: stub psql says "exists", stub createdb must NOT be reached.
FX="$TMP/ldbfx"; mkdir -p "$FX/scripts" "$FX/infra/docker" "$FX/bin"
cp "$REPO/scripts/lane-db.sh" "$FX/scripts/lane-db.sh"
for t in dirname mkdir mktemp grep mv rm cat; do ln -sf "$(command -v $t)" "$FX/bin/$t"; done
printf '#!%s\necho 1\nexit 0\n' "$(command -v bash)" > "$FX/bin/psql"
printf '#!%s\n: > "%s/createdb.marker"\nexit 1\n' "$(command -v bash)" "$FX" > "$FX/bin/createdb"
chmod +x "$FX/bin/psql" "$FX/bin/createdb"
LDB_OUT="$(PATH="$FX/bin" "$(command -v bash)" "$FX/scripts/lane-db.sh" B 2>&1)"
has() { case "$LDB_OUT" in *"$1"*) echo 0;; *) echo 1;; esac; }
expect "lane-db: id B → target database 'pgeos_laneB'"  0 "$(has "target database 'pgeos_laneB'")"
expect "lane-db: existing db → 'already exists' line"   0 "$(has "already exists")"
expect "lane-db: existing db → createdb never reached"  0 "$([ ! -e "$FX/createdb.marker" ]; echo $?)"
expect "lane-db: .env gets PGDATABASE=pgeos_laneB"      0 "$(grep -qx 'PGDATABASE=pgeos_laneB' "$FX/infra/docker/.env"; echo $?)"

echo
echo "hooks tests: $pass passed, $failn failed"
[ "$failn" -eq 0 ]
