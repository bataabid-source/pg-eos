# PG-EOS — Project Setup Guide (how to stand up the build environment)
**Version 5.1 · 21 September 2026 · companion to BOOTSTRAP-v5.md and EXECUTION-MASTER-v4 Part 3**

> **بالعربية (ملخص):** هذا الدليل يشرح خطوة بخطوة كيف تُنشئ مشروع التنفيذ: مستودع Git واحد، تنسخ فيه الحزمة v4 كاملة (بما فيها الأطلس D-blueprints والمخطط)، تثبّت Claude Code، تنسخ «عدة التشغيل» الجاهزة (`claude-kit/`) إلى جذر المستودع، ثم تشغّل جلسة واحدة بأمر البوتستراب. بعدها كل جلسة = مهمة واحدة بأمر `/resume`، والمسارات المتوازية = جلسة لكل مسار في worktree مستقل بأمر `/lane`. القسم 7 يشرح ما تُلصقه في مشروع Claude (الدردشة) لتستخدمه أنت كمدير عام.

---

## 1. Prerequisites (GM machine or a build VM)
| Item | Version / note |
|---|---|
| Git | ≥ 2.40 (worktrees) |
| Node.js + pnpm | Node 22 LTS · `npm i -g pnpm@9` (or `corepack enable`) |
| Docker Desktop / Docker Engine | for local Postgres 16 + pg-boss (same `docker-compose.yml` as Tier 0) |
| PostgreSQL client | `psql` 16 (for `apply.sh` and guards) |
| Claude Code | latest (`npm i -g @anthropic-ai/claude-code`) — Max plan recommended for opus review sessions |
| Windows note | Claude Code runs the kit's hooks and scripts through Git Bash (installed with Git for Windows). `scripts/check-setup.sh` tells you which of these tools is still missing on the machine. |
| Package v4 | the folder `PG-EOS-v4/` (A-governing · B-reference · C-tools · D-blueprints · database) |

## 2. Create the repository (once)

**Fast path (used on 21/09/2026):** the folder `claude-kit/` delivered to the GM already contains the
whole repository: `docs/package/`, `database/schema/`, `tasks/MASTER_BACKLOG.md`, `docs/DECISION_LOG.md`,
`docs/CHANGELOG.md` and the `.git` history (`SETUP-000` on `main`). Rename or move the folder to
`pg-eos` if you like (git does not care), then:

```bash
cd pg-eos                       # the former claude-kit folder
bash scripts/check-setup.sh     # must end with READY or FILES READY; every MISS is a stop
```

**Manual path (from a fresh package copy):**
```bash
mkdir pg-eos && cd pg-eos && git init -b main
PKG=~/Desktop/New\ sys/PG-EOS-v4            # adjust
mkdir -p docs/package/tools docs/package/D-blueprints database/schema
cp "$PKG"/A-governing/*.md            docs/package/
cp "$PKG"/B-reference/*.md            docs/package/
cp "$PKG"/C-tools/*                   docs/package/tools/
cp "$PKG"/D-blueprints/*.md           docs/package/D-blueprints/
cp -r "$PKG"/D-blueprints/diagrams    docs/package/D-blueprints/
cp "$PKG"/A-governing/database/*.sql "$PKG"/A-governing/database/apply.sh database/schema/
cp "$PKG"/00-README-v4.md "$PKG"/AUDIT-REPORT-v4.md "$PKG"/CHANGELOG-v4.md docs/package/
cp -r "$PKG"/A-governing/claude-kit/. .          # CLAUDE.md · .claude/ · tasks/ · scripts/ · docs/ templates
chmod +x database/schema/apply.sh scripts/*.sh
python3 scripts/gen-backlog.py                   # tasks/MASTER_BACKLOG.md — 132 rows from doc 38
bash scripts/check-setup.sh                      # pre-flight: files · state · git · tools
git add -A && git commit -m "chore: SETUP-000 import package v4 + kit"
```
Result: `docs/package/` holds the complete package (A + B + C + D), `database/schema/` the four governing SQL files + guards + apply script, and the repo root already has `CLAUDE.md`, `.claude/`, `tasks/` (with `MASTER_BACKLOG.md`), `docs/` (with `DECISION_LOG.md`, `CHANGELOG.md`, `PROJECT_STATE.md`), `scripts/` from the kit. On Windows, the kit's `.claude/` folder may arrive as `dot-claude/` — rename it before anything else.

**What `/resume` needs and where it now is:** `docs/package/38-WBS.md` · `40` · `EXECUTION-MASTER-v4` → `docs/package/`; `01 · 13 · 13B · 019 · guards.sql · apply.sh` → `database/schema/`; `tasks/MASTER_BACKLOG.md` → generated; `.git` → initialised. If any of these is reported missing again, run `scripts/check-setup.sh` and fix the MISS lines — do not let the bootstrap session re-derive them.

## 3. Local database (proves the schema before any code)
```bash
docker compose -f infra/docker/docker-compose.yml up -d postgres       # kit provides the compose file
PGHOST=localhost PGPORT=5432 PGUSER=postgres PGDATABASE=pgeos database/schema/apply.sh --recreate
```
Expected: zero errors · **175 tables** · 3,330 locations · G1–G13 = 0 · G7 = 0 · G-SEED = 0 · G6 non-blocking (WBS 0.16). If this is not green, stop — nothing else should start.

## 4. Claude Code — first session (bootstrap)
If Docker/psql are not installed yet, the bootstrap session still runs (it writes files only) and records `apply.sh --recreate` as NOT RUN; task 0.4 then needs pnpm. Install the tools before §3 whenever possible — a green schema first is the intended order.
```bash
claude            # in the repo root
/model sonnet
```
Paste exactly:
```
Execute docs/package/BOOTSTRAP-v5.md exactly as written. The package is in docs/package/ and
database/schema/. The kit files in the repo root (CLAUDE.md, .claude/, tasks/, scripts/) are the
starting point — complete them, do not re-derive them. Pin agent models with tier aliases; `inherit`
is forbidden — report any unsupported alias. Generate the 15 module briefs from the live schema.
Run apply.sh --recreate and record the result. Stop after the final report. Do not start 0.4.
```
Accept only if (from EXECUTION-MASTER-v4 §3.2, extended): cross-module import fails `pnpm lint` · task 2.9 present with its doc 38 criterion · `grep -c "DECISION REQUIRED" docs/DECISION_LOG.md` = 0 · `grep -c inherit .claude/agents/*` = 0 · 15 briefs exist and each ≤ 120 lines · `tasks/LANE_LOCKS.md` exists · PROJECT_STATE has exactly one DONE with a hash · `apply.sh` result recorded.

## 5. Every later session (one task each)
```bash
claude
/model sonnet
/resume
```
The Master reads state, picks the next runnable task, and runs the `/slice` loop. When it reports DONE with a commit hash, **end the session**. Never start a second task in the same session.

**Golden slice (WBS 2.9) — the one opus session:**
```
/model opus
/slice 2.9
```
Review the file tree, tests and the generated `scripts/new-slice.sh` template personally. Nothing replicates before you accept it (EXECUTION-MASTER-v4 §3.5).

## 6. Parallel lanes (Phase 2 onward) — three terminals, zero conflicts
```bash
# Master terminal (repo root)
claude → /model sonnet → /resume            # Master claims Phase-2 locks and issues migration numbers

# Lane terminals
git worktree add ../pg-eos-lane-1 -b lane/1 && cd ../pg-eos-lane-1 && claude → /model sonnet → /lane 1
git worktree add ../pg-eos-lane-2 -b lane/2 && cd ../pg-eos-lane-2 && claude → /model sonnet → /lane 2
git worktree add ../pg-eos-lane-3 -b lane/3 && cd ../pg-eos-lane-3 && claude → /model sonnet → /lane 3
```
Rules that make this safe (enforced by `tasks/LANE_LOCKS.md` and the PreToolUse hook): a module is owned by one lane at a time; `packages/*`, `database/schema/*`, `CLAUDE.md`, `.claude/*` are frozen; migrations are numbered by the Master; lanes never merge — the Master merges in the queue order after pg-reviewer PASS and green gates. When a lane finishes its list it stops; you close its terminal and the Master merges.

## 7. The Claude Project (chat) for the GM — not for coding
Create a Project named `PG-EOS — GM Office` and upload **only**: `00-README-v4.md` · `EXECUTION-MASTER-v4.md` · `AUDIT-REPORT-v4.md` · `D-blueprints/00-Atlas-Index.md` · `D-blueprints/09-Gap-Register.md` · `D-blueprints/01-Enterprise-Map.md` · `D-blueprints/07-Governance-Control.md` · the `PROJECT_STATE.md` you paste weekly. Custom instructions:
```
You are the GM's management assistant for PG-EOS. Answer in Arabic. Never propose code or schema
changes here — those go through Claude Code and the G-01 rule. When I ask "where are we", read
PROJECT_STATE.md and answer in ≤ 10 lines: phase, current task, lanes, blockers, decisions waiting
for me (from 09-Gap-Register). When I take a decision, draft the EXECUTION-MASTER-v4 Part 1 row for it
and the tasks/proposed/ change so I can paste it into the repo. Numbers come from the files, never
from reasoning.
```
This keeps the coding context (repository) and the management context (chat) separate — the biggest single saver of quota.

## 8. Quota rules in one place
| Rule | Why |
|---|---|
| One task per session; `/clear` between tasks | context never accumulates |
| Workers get file lists (briefs), never documents | a brief is ~2k tokens; a package doc is 20–40k |
| Sonnet default; opus only for review, 2.9, ADR, security, second failure | opus is the only agent allowed to cost more |
| `pnpm test --filter <module>` locally; full suite in CI | full runs are minutes and tokens |
| Golden slice generator, not hand-written trees | replication is copy + rename, not reasoning |
| Reports carry token estimates; tasks over 2× budget are split | budget is measured, not hoped |

## 9. Complementary files the build needs (and where they are)
| Need | File(s) | Status |
|---|---|---|
| Governing rules | 40 · 36 · EXECUTION-MASTER-v4 · 42 · 38 · 22 | in package |
| Schema | database/schema/01 · 13 · 13B · 019 · guards.sql · apply.sh | in package, green |
| Screens, boards, KPIs, scenarios per module | D-blueprints 02–07 · 10 · 12 · 13 · 15 | in package |
| Client integration design | D-blueprints 11 | in package (options need GM) |
| Agent kit | `A-governing/claude-kit/` (CLAUDE.md · .claude/agents · commands · briefs template · settings.json · hooks · scripts · tasks templates · docker-compose) | in package |
| Staged tasks pending GM | `tasks/proposed/` (2.20 work orders · 5.18 focus boards · 6.2b connectors · sales commission activation) | in kit |
| Decisions still open | D-blueprints/09-Gap-Register.md (79 items: 22 GM decisions) | in package |

## 10. What to decide before Phase 1 (does not block Phase 0)
Structural slab approval (19 §10) · data-residency legal opinion (WBS 7.9) · internal transfer price · sales commission model and rates (D-14 §8) · ST-14 billing source (D-13 §8-3) · whether payroll/attendance enter PG-EOS (Gap #7). Each has a temporary value already applied; the register lists it.
