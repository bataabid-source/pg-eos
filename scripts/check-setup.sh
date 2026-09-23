#!/usr/bin/env bash
# check-setup.sh — verifies that the repository has everything `/resume` and BOOTSTRAP-v5 need.
# Run from the repo root:  bash scripts/check-setup.sh
# Exit 0 = ready for the bootstrap session · exit 1 = something is missing (listed).
# Works in Git Bash on Windows, in WSL, and on Linux/macOS. Read-only.

cd "$(dirname "$0")/.." || exit 1
fail=0; warn=0
ok()   { printf '  \033[32mOK\033[0m    %s\n' "$1"; }
miss() { printf '  \033[31mMISS\033[0m  %s\n' "$1"; fail=1; }
wrn()  { printf '  \033[33mWARN\033[0m  %s\n' "$1"; warn=1; }
need_file() { [ -f "$1" ] && ok "$1" || miss "$1"; }
need_dir()  { [ -d "$1" ] && ok "$1/" || miss "$1/"; }

echo "== 1. Governing package (docs/package/) — precedence ladder R-01"
for f in 40-Build-Specification-EN.md 36-Technical-Architecture-Audit.md EXECUTION-MASTER-v4.md \
         42-Oracle-Cloud-Deployment.md 38-WBS.md 22-Master-Data-Governance.md BOOTSTRAP-v5.md \
         PROJECT-SETUP-GUIDE.md 00-README-v4.md AUDIT-REPORT-v4.md CHANGELOG-v4.md; do
  need_file "docs/package/$f"
done
n=$(ls docs/package/*.md 2>/dev/null | wc -l); [ "$n" -ge 38 ] && ok "docs/package/*.md = $n files (A 9 + B 26 + root 3)" || miss "docs/package/*.md = $n (expected ≥ 38)"
need_dir docs/package/tools
need_dir docs/package/D-blueprints
n=$(ls docs/package/D-blueprints/*.md 2>/dev/null | wc -l); [ "$n" -eq 16 ] && ok "D-blueprints = 16 docs (00–15)" || miss "D-blueprints docs = $n (expected 16)"
n=$(ls docs/package/D-blueprints/diagrams/rendered/*.svg 2>/dev/null | wc -l); [ "$n" -ge 150 ] && ok "D-blueprints diagrams rendered = $n svg" || wrn "D-blueprints rendered diagrams = $n (expected 153; not blocking)"

echo "== 2. Schema (database/schema/) — the ONLY permitted schema"
for f in 01-Data-Model.sql 13-Schema-Additions.sql 13B-Schema-Reference-Consolidation.sql \
         019-Warehouse-WH1-Setup.sql guards.sql apply.sh; do need_file "database/schema/$f"; done

echo "== 3. Kit at repo root"
need_file CLAUDE.md
need_file .gitignore
need_file .claude/settings.json
n=$(ls .claude/agents/pg-*.md 2>/dev/null | wc -l); [ "$n" -eq 5 ] && ok ".claude/agents = 5" || miss ".claude/agents = $n (expected 5)"
n=$(ls .claude/commands/*.md 2>/dev/null | wc -l); [ "$n" -eq 6 ] && ok ".claude/commands = 6" || miss ".claude/commands = $n (expected 6)"
n=$(ls .claude/briefs/*.brief.md 2>/dev/null | grep -vc _TEMPLATE); [ "$n" -eq 15 ] && ok ".claude/briefs = 15 module briefs" || miss ".claude/briefs = $n (expected 15)"
for b in .claude/briefs/*.brief.md; do l=$(wc -l < "$b"); [ "$l" -le 120 ] || miss "$b has $l lines (> 120)"; done
need_file .claude/hooks/lane-guard.sh
need_file .claude/hooks/stop-reminder.sh
grep -q 'inherit' .claude/agents/*.md && miss "an agent file uses model: inherit (forbidden)" || ok "no agent uses model: inherit"
for s in scripts/gen-briefs.py scripts/gen-backlog.py scripts/new-slice.sh scripts/guards-run.sh; do need_file "$s"; done
need_file infra/docker/docker-compose.yml

echo "== 4. State files"
need_file docs/PROJECT_STATE.md
l=$(wc -l < docs/PROJECT_STATE.md); [ "$l" -le 60 ] && ok "PROJECT_STATE.md = $l lines (≤ 60)" || miss "PROJECT_STATE.md = $l lines (> 60)"
need_file docs/DECISION_LOG.md
c=$(grep -c 'DECISION REQUIRED' docs/DECISION_LOG.md 2>/dev/null || true); [ "${c:-0}" -eq 0 ] && ok "DECISION_LOG has no open-decision marker" || miss "DECISION_LOG has $c open-decision markers"
need_file docs/CHANGELOG.md
need_file docs/MODEL_ROUTING.md
need_file docs/AGENT_WORKFLOW.md
need_file tasks/MASTER_BACKLOG.md
n=$(sed '/^## Staged/,$d' tasks/MASTER_BACKLOG.md 2>/dev/null | grep -cE '^\| ([0-9]+\.[0-9]+[ab]?|X\.[0-9]+) \|' || true); [ "${n:-0}" -eq 133 ] && ok "MASTER_BACKLOG = 133 doc-38 rows (v4.2, D-124)" || miss "MASTER_BACKLOG rows = $n (expected 133 — run: python3 scripts/gen-backlog.py)"
need_file tasks/LANE_LOCKS.md
for d in tasks/proposed tasks/backlog tasks/active tasks/completed tasks/blocked docs/notes; do need_dir "$d"; done

echo "== 5. Git"
if [ -d .git ]; then ok ".git present (branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null))"; else miss ".git — run: git init -b main && git add -A && git commit -m 'chore: SETUP-000 import package v4 + kit'"; fi

echo "== 6. Tools on this machine (PROJECT-SETUP-GUIDE §1) — needed from task 0.4 onward"
for t in git node pnpm docker psql claude; do
  if command -v "$t" >/dev/null 2>&1; then ok "$t → $(command -v "$t")"; else
    case $t in
      git)    miss "git — https://git-scm.com (≥ 2.40)";;
      node)   miss "node — Node 22 LTS https://nodejs.org";;
      pnpm)   wrn "pnpm — npm i -g pnpm@9  (needed by 0.4; not by the bootstrap session)";;
      docker) wrn "docker — Docker Desktop (needed for the local Postgres 16 and apply.sh --recreate)";;
      psql)   wrn "psql — PostgreSQL 16 client (needed by apply.sh and scripts/gen-briefs.py)";;
      claude) wrn "claude — npm i -g @anthropic-ai/claude-code";;
    esac
  fi
done

echo
if [ $fail -eq 0 ]; then
  [ $warn -eq 0 ] && echo "READY — all files present, all tools installed. Next: PROJECT-SETUP-GUIDE §3 (local DB) then §4 (bootstrap session)." \
                  || echo "FILES READY — repository complete. WARN items are tools to install before task 0.4 / apply.sh (PROJECT-SETUP-GUIDE §1)."
  exit 0
else
  echo "NOT READY — fix the MISS items above, then rerun."
  exit 1
fi
