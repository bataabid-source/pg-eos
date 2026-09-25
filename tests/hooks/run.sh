#!/usr/bin/env bash
# PG-EOS · tests/hooks/run.sh — regression tests for the versioned hooks and bookkeeping gates
# (D-179, 2026-09-25). Pure bash, no database, no node. Runs in CI gate ① and via `pnpm test:hooks`.
#   .claude/hooks/lane-guard.sh · .claude/hooks/db-guard.sh · .githooks/commit-msg · scripts/check-locks.sh · scripts/brief-check.sh
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
    printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$path" | CLAUDE_PROJECT_DIR="$root" PG_LANE="$lane" bash "$root/lane-guard.sh" 2>/dev/null; echo $?
  else
    printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$path" | CLAUDE_PROJECT_DIR="$root" env -u PG_LANE bash "$root/lane-guard.sh" 2>/dev/null; echo $?
  fi
}
locks() { printf '| module | lane | task | claimed_at | worktree |\n|---|---|---|---|---|\n%s\n' "$1" > "$LANE1/tasks/LANE_LOCKS.md"; }

echo "lane-guard.sh"
expect "master: modules write allowed"          0 "$(guard "$SHARED" "" "modules/wms/index.ts")"
expect "master: database/schema blocked"        2 "$(guard "$SHARED" "" "database/schema/01-Data-Model.sql")"
locks '| wms | 1 | 2.10 | 2026-09-25 | ../pg-eos-lane-1 |'
cp "$LANE1/tasks/LANE_LOCKS.md" "$SHARED/tasks/LANE_LOCKS.md"
expect "lane in shared checkout blocked (D-179)" 2 "$(guard "$SHARED" 1 "modules/wms/index.ts")"
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
  ( cd "$TMP" && git init -q . 2>/dev/null; mkdir -p docs/package; cp "$TMP/38-WBS.md" docs/package/38-WBS.md; bash "$REPO/.githooks/commit-msg" "$f" 2>/dev/null ); echo $?
}
expect "bad first line refused"                 1 "$(cm 'update stuff')"
expect "feat(2.9) accepted"                     0 "$(cm 'feat(2.9): receive\n\nbody')"
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
bc() { printf '%b' "$1" > "$TMP/brief.md"; bash "$REPO/scripts/brief-check.sh" "$TMP/brief.md" --root "$FX" >/dev/null 2>&1; echo $?; }
expect "no Read ONLY block → 2"                 2 "$(bc '# brief\nDeliver: x')"
expect "small list OK"                          0 "$(bc 'Read ONLY:\n- `modules/m/domain/uc/f1.ts`\n- `modules/m/domain/uc/f2.ts`\n\nWrite ONLY: x')"
expect "brace group expanded"                   0 "$(bc 'Read ONLY:\n- modules/m/domain/uc/{f1,f2,f3}.ts\nWrite ONLY: x')"
expect "13 files over budget"                   1 "$(bc 'Read ONLY:\n- `modules/m/domain/uc/*`\nWrite ONLY: x')"
expect "line budget: whole big file refused"    1 "$(bc 'Read ONLY:\n- `docs/big.md`\nWrite ONLY: x')"
expect "line budget: range counted"             0 "$(bc 'Read ONLY:\n- `docs/big.md` lines 10-40\nWrite ONLY: x')"
expect "line budget: two ranges summed"         1 "$(bc 'Read ONLY:\n- `docs/big.md` lines 1-800, 900-1700\nWrite ONLY: x')"
expect "block ends at Write ONLY"               0 "$(bc 'Read ONLY:\n- `modules/m/domain/uc/f1.ts`\nWrite ONLY: `docs/big.md`\n')"
expect "## heading form parsed"                 0 "$(bc '## Read ONLY (workers)\n1. `modules/m/domain/uc/f1.ts`\n\n## Facts\n- `docs/big.md`')"

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

echo
echo "hooks tests: $pass passed, $failn failed"
[ "$failn" -eq 0 ]
