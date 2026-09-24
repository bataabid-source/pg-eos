# claude-kit — the ready-to-copy Claude Code kit for PG-EOS

**Two ways to use this folder — pick one.**

**(A) This folder IS the repository root (what the GM did on 21/09/2026).** The package and the
schema are already inside it: `docs/package/` (A + B + C + D-blueprints), `database/schema/`
(01 · 13 · 13B · 019 · guards.sql · apply.sh), `tasks/MASTER_BACKLOG.md`, `docs/DECISION_LOG.md`,
`docs/CHANGELOG.md`. Nothing is copied. Verify and go:

```bash
bash scripts/check-setup.sh      # every MISS must be fixed; WARN = a tool to install (pnpm · docker · psql)
git status                       # the repository is initialised on `main` with the SETUP-000 commit
```

**(B) Copy into a fresh repository** — the original one-liner of PROJECT-SETUP-GUIDE §2:

```bash
cp -r "$PKG"/A-governing/claude-kit/. .          # CLAUDE.md · .claude/ · tasks/ · scripts/ · docs/ templates
chmod +x database/schema/apply.sh scripts/*.sh
python3 scripts/gen-backlog.py                   # tasks/MASTER_BACKLOG.md from docs/package/38-WBS.md
bash scripts/check-setup.sh
```

Copy it **after** the package has been copied into `docs/package/` and the four SQL files into
`database/schema/`, and **before** the first Claude Code session. Then the repository root already
holds `CLAUDE.md`, `.claude/`, `tasks/`, `scripts/`, `docs/`, `infra/` and `.gitignore`, and the
bootstrap session **completes** these files instead of re-deriving them — that is what the
bootstrap prompt in PROJECT-SETUP-GUIDE §4 says, and it is the single largest quota saving in
Phase 0.

Governed by `BOOTSTRAP-v5.md`; every file here matches it literally. Where this README and
BOOTSTRAP-v5 ever differ, BOOTSTRAP-v5 governs.

---

## What each file is

### Root

| file | what it is | who reads it |
|---|---|---|
| `CLAUDE.md` | The permanent rules. **BOOTSTRAP-v4 §6 verbatim** (ARCHITECTURE · BUILD METHOD · AGENT CONSTRAINTS · TESTING · GIT · DOCUMENTATION · HUMAN APPROVAL · MODEL ROUTING · PARALLEL LANES · DEPLOYMENT PIPELINE · DEFINITION OF DONE) **plus the three blocks BOOTSTRAP-v5 §6 appends verbatim** (PARALLEL LANES — CONFLICT-FREE MECHANISM (v5) · QUOTA DISCIPLINE (v5) · SPEED AND QUALITY (v5)). Never paraphrase it, never trim it. | every session, first |
| `.gitignore` | `.env` · `*.pem` · `*.key` · `data/` · `*.dump` · `*.tgz` · `id_*` (BOOTSTRAP-v4 §9) plus build output. **`.golden-slice-accepted` is deliberately NOT ignored** — it is the committed record of the GM's acceptance of WBS 2.9. | git |

### `.claude/`

| file | what it is |
|---|---|
| `settings.json` | `permissions.allow` for `pnpm`, `git` (never `--force`), `psql`, `docker compose`, `node`, `bash scripts/*`; `permissions.deny` for `rm -rf`, `git push --force`, `curl … \| sh`, `sudo`. `hooks.PreToolUse` on `Edit\|Write\|MultiEdit` → `lane-guard.sh`; `hooks.Stop` → `stop-reminder.sh`. |
| `hooks/lane-guard.sh` | PreToolUse guard. Reads the tool call's `file_path` from stdin JSON. With `PG_LANE` set (a lane session) it reads `tasks/LANE_LOCKS.md` and allows writes only under `modules/<locked>/`, `apps/<locked>/`, `tests/` and `database/migrations/NNNN_<lane>_*`; it blocks the frozen paths (`packages/*`, `database/schema/*`, `CLAUDE.md`, `.claude/*`) with **exit 2** and the reason on stderr. With `PG_LANE` unset (the Master) it allows everything **except** `database/schema/*`. |
| `hooks/stop-reminder.sh` | Stop hook. Prints the uncommitted-change count and the one-task-per-session reminder. Always exits 0 — it never blocks. |
| `agents/pg-reviewer.md` | opus · the only opus agent. Ten-point review (doc 36 §5-4) + RLS/SoD/secrets + routing-trailer + brief-compliance + golden-slice-shape. Never edits code. |
| `agents/pg-backend.md` | sonnet · NestJS · Drizzle · XState · outbox · pg-boss · migrations. Replicates the golden slice via `scripts/new-slice.sh`. |
| `agents/pg-frontend.md` | sonnet · React/TanStack/shadcn, React Native/Expo, PDA PWA. RTL default, i18n ar/en/hi/ur/bn. Builds from the Zod contract and the D-blueprint screen spec. |
| `agents/pg-tester.md` | sonnet · Gherkin → Playwright, property tests, guards G1–G18, mutation. Writes tests FIRST and reports RED. |
| `agents/pg-scribe.md` | sonnet (GM 2026-09-23: no haiku) · PROJECT_STATE · MASTER_BACKLOG · CHANGELOG · LANE_LOCKS release · commit message · i18n · renames. No logic, no schema. |
| `commands/pg-resume.md` | `/pg-resume` — read state, pick the next runnable task, hand it to `/slice`. |
| `commands/slice.md` | `/slice <id>` — carries the BRIEF template (§5) and the twelve-step loop (§2). |
| `commands/lane.md` | `/lane <id>` — a worktree session: the lane's doc-38 task list, its locks, its migration requests. |
| `commands/gate.md` | `/gate` — gates ①–⑤ locally, one verdict table. |
| `commands/pg-state.md` | `/pg-state` — PROJECT_STATE + LANE_LOCKS + the last 3 commits. Read-only. |
| `commands/pg-review.md` | `/pg-review <path>` — pg-reviewer on a slice with no build, after manual fixes. |
| `briefs/_TEMPLATE.brief.md` | Both brief formats: the SLICE BRIEF skeleton (§5) and the field list every module brief carries (CLAUDE.md · QUOTA DISCIPLINE (v5)). |
| `briefs/<module>.brief.md` | Fifteen generated module briefs — `identity platform catalog sales wms tms cc billing hr fleet housing partners admin imile governance`, each ≤ 120 lines. **Generated, never hand-edited.** `fleet` has no schema of its own: its tables live in schema `tms`, and both briefs say so. One-off slice briefs (e.g. `_slice-0.17`, `_slice-1.5`, `_slice-2.1`, `_slice-2.8`, `0.18-isolation`) live in `docs/notes/slice-briefs/`, not here (D-106, GM 2026-09-23). |

### `scripts/`

| file | what it is |
|---|---|
| `gen-briefs.py` | The brief generator: `psql` → the fifteen briefs. Rerunnable and idempotent. `python3 scripts/gen-briefs.py` rewrites them all; `--check` verifies the 120-line limit without writing. Run it whenever the schema changes under G-01. |
| `new-slice.sh` | The golden-slice generator. **A no-op that prints "golden slice not accepted yet" until the committed file `.golden-slice-accepted` exists**; after that it copies `modules/wms/*/receive-inbound` with sed renames (kebab · snake · camel · pascal · const · schema · import paths) plus the contract and the i18n keys. Its intended behaviour is documented in its own header comments. |
| `gen-backlog.py` | Generates `tasks/MASTER_BACKLOG.md` from `docs/package/38-WBS.md`: 134 rows (v4.3, 5.3b added D-165; D-124), IDs · type markers · deps · lane · owner · acceptance copied verbatim + a `Status` column (TODO · READY · ACTIVE · WAITING_GM · BLOCKED · DONE @ hash · SUPERSEDED · DEFERRED-POST-PILOT, D-127). Rerunnable — existing statuses are preserved; `--check` verifies the count without writing. |
| `check-setup.sh` | Read-only pre-flight for `/pg-resume`: package files, schema files, kit files, state files, 133 backlog rows, `.git`, and the tools of PROJECT-SETUP-GUIDE §1 (git · node · pnpm · docker · psql · claude). Exit 1 on any MISS. |
| `guards-run.sh` | Runs `database/schema/guards.sql` against `$PGDATABASE` and turns rows into an exit code: non-zero if any of **G1–G13** returned a row, with **G6 a warning only** (non-blocking until WBS 0.16) and **G18 / G-SEED report-only**. G14–G17 are not SQL and are named, not run. |

### `tasks/`

| file | what it is |
|---|---|
| `MASTER_BACKLOG.md` | **Generated** from doc 38 by `scripts/gen-backlog.py` — the 132 tasks with their status. pg-scribe moves rows; nobody edits IDs, lanes or deps here (doc 38 governs). |
| `LANE_LOCKS.md` | The empty ownership table `\| module \| lane \| task \| claimed_at \| worktree \|` plus the five lane rules. The Master claims and releases; pg-scribe writes it; `lane-guard.sh` reads it. |
| `proposed/2.20-work-orders.md` | Warehouse work orders and VAS (SCR-WO-01) — D-12. **WAITING_GM.** |
| `proposed/5.18-focus-boards.md` | Focus boards on `platform.my_work` (SCR-FB-01) — D-15. **WAITING_GM.** |
| `proposed/6.2b-store-connectors.md` | Client store connectors (`I-12`) — D-11. **WAITING_GM**, and blocked on the option choice. |
| `proposed/SC-01-sales-commission.md` | Sales commission activation (SCR-SC-01) — D-14. **WAITING_GM.** |

Each staged task states its objective, its source D-blueprint, whether its schema is already in 13B,
its acceptance criterion, its dependencies, and the decision the GM owes. None of them enters
`tasks/MASTER_BACKLOG.md` before the GM approves it.

### `docs/`

| file | what it is |
|---|---|
| `PROJECT_STATE.md` | The ≤ 60-line state file, initialised per BOOTSTRAP-v4 §8 with Current Task **BOOTSTRAP-001 → 0.4**, empty lane table, Tier 0, golden slice not built, environment blockers listed. Maintained by pg-scribe only, in the same commit as the task it records; the current task shown in the file itself now reflects the latest completed/active WBS item, not the bootstrap value above. |
| `DECISION_LOG.md` | Seeded verbatim from EXECUTION-MASTER-v4 Part 1 (§1.1–§1.16) + an append-only working log (D-000 = setup). Zero open-decision markers. |
| `CHANGELOG.md` | One entry per completed task, newest first; starts with SETUP-000. |
| `package/` | The complete package v4: A-governing (9) · B-reference (26) · root docs (3) · `tools/` (C-tools) · `D-blueprints/` (16 docs + `diagrams/` mmd+svg + `tools/`). Read-only for agents; edited only by the GM. |
| `MODEL_ROUTING.md` | The routing table of BOOTSTRAP-v5 §4 **verbatim, budget column included**. |
| `AGENT_WORKFLOW.md` | The twelve-step loop, the lane mechanism and the merge queue — the shape of the work, ≤ 80 lines, restating no rule. |

### `infra/`

| file | what it is |
|---|---|
| `docker/docker-compose.yml` | `postgres:16` (Debian/glibc — D-105, GM 2026-09-23) as `pgeos`, trust auth for local loopback connections only, port 5432, named volume; optional pgAdmin behind the `tools` profile, password `${PGADMIN_PASSWORD:-pgadmin-dev}` — override via `PGADMIN_PASSWORD` or `infra/docker/.env` (see `infra/docker/.env.example`). Nothing else — other services arrive with their own WBS tasks. |

---

## Files the kit does NOT ship (the bootstrap session / task 0.4 create them)

The pnpm/Turborepo/ESLint-boundaries workspace with its **failing** cross-module import test ·
`packages/*` · `modules/*` · `apps/*` · `database/migrations/` · `scripts/deploy.sh`.
(`docs/CHANGELOG.md`, `docs/DECISION_LOG.md`, `tasks/MASTER_BACKLOG.md` and `docs/notes/` **are**
shipped since 21/09/2026 — the bootstrap session verifies them instead of creating them.)

## After copying — the checks that matter

```bash
bash scripts/check-setup.sh                      # one-shot version of everything below + tools
grep -c inherit .claude/agents/*                 # 0 in every file
ls .claude/briefs/*.brief.md | wc -l             # 16 (15 modules + _TEMPLATE)
awk 'END{print FILENAME, NR}' .claude/briefs/*.brief.md   # none over 120 lines
python3 -m json.tool .claude/settings.json >/dev/null      # valid
bash -n .claude/hooks/*.sh scripts/*.sh          # valid
bash scripts/new-slice.sh wms x                  # "golden slice not accepted yet"
PGDATABASE=pgeos bash scripts/guards-run.sh      # G7 = 0 · G-SEED = 0 · G6 warning only
```

Regenerate the briefs whenever the schema changes:

```bash
PGHOST=localhost PGPORT=5432 PGUSER=postgres PGDATABASE=pgeos python3 scripts/gen-briefs.py
```
