# PROJECT_STATE — PG-EOS

**Hard limit: 60 lines.** Older history moves to `docs/CHANGELOG.md` (CLAUDE.md · QUOTA DISCIPLINE (v5)).
Maintained by pg-scribe only, in the same commit as the task it records.

| field | value |
|---|---|
| Phase | 0 — Foundation |
| Current task | **BOOTSTRAP-001** (PROJECT-SETUP-GUIDE §4) → then **0.4** monorepo skeleton (`docs/package/38-WBS.md`) |
| Golden slice (2.9) | not built · `.golden-slice-accepted` absent · `scripts/new-slice.sh` is a no-op |
| Deployment tier | Tier 0 (`docs/package/42-Oracle-Cloud-Deployment.md`) |
| Schema | `database/schema/01 · 13 · 13B · 019` — the ONLY permitted schema · `apply.sh --recreate` **not yet run on this machine** |
| Session model | sonnet (opus only for the 2.9 session, an ADR, a security review, or a second failure) |
| Setup check | `bash scripts/check-setup.sh` — all files present; tool WARNs are listed under Blockers |

## Lanes

| module | lane | task | claimed_at | worktree |
|---|---|---|---|---|

(empty — Phase 0 and the golden slice are never parallelised. The live table is `tasks/LANE_LOCKS.md`.)

## Last 5 DONE (newest first)

| task | commit |
|---|---|
| SETUP-000 — package v4 + schema + kit + backlog + decision log imported (no agent session) | `<hash — the first commit on main>` |

## Blockers

- **Environment (GM machine), not a code blocker:** `pnpm`, Docker Desktop and `psql` 16 were absent at the last `/resume` pre-check. BOOTSTRAP-001 can run without them (it writes files only) but must record `apply.sh --recreate` as NOT RUN; task 0.4 needs pnpm; §3 of PROJECT-SETUP-GUIDE needs Docker + psql. Install → rerun `scripts/check-setup.sh`.
- A REAL BLOCKER is only: the acceptance test cannot be run · a money/permission/legal decision is absent from EXECUTION-MASTER-v4 Part 1 · a schema object is missing and G-01 does not allow adding it. Everything else: state one default, record it in CHANGELOG, proceed.

## Next 3 tasks

1. **BOOTSTRAP-001** — complete the kit (not re-derive it): verify 15 briefs ≤ 120 lines, `.gitignore`, first commit hash into this table, `apply.sh --recreate` result recorded (or NOT RUN + reason).
2. **0.4** — monorepo skeleton (lane B, pg-backend) — unblocks 0.9 and 0.13/0.14. Needs pnpm.
3. **0.9** — after 0.4 (lane B) — then 0.10 · 0.11 · 0.12 in parallel; **0.6** CI (Master) needs 0.4 **and** 0.5 (lane A).

## Notes

- `tasks/MASTER_BACKLOG.md` is generated from doc 38 by `scripts/gen-backlog.py` (132 rows; regenerate after any doc-38 change — statuses are preserved). `docs/DECISION_LOG.md` is seeded from EXECUTION-MASTER-v4 Part 1.
- iMile API: the letter is a GM-lane task; the code track never waits on it.
- WAITING_GM (never blocks a code lane): Lane A of Phase 0 — 0.2 (three cloud decisions) · 0.3 · 0.5 · 0.7 · 0.8 · 0.20; plus the four staged tasks in `tasks/proposed/`.
- Phase 0 gate: 0.18 isolation green (G7 = 0) · 0.16 classification complete (G6 = 0) · 0.8 restore succeeded · 0.1 owners named · 0.2 three decisions recorded.
- `database/schema/apply.sh --recreate` expectation: zero errors · 175 tables · 3,330 locations · G1–G13 = 0 · G7 = 0 · G-SEED = 0 · G6 non-blocking until 0.16.
