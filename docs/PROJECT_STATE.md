# PROJECT_STATE — PG-EOS

**Hard limit: 60 lines.** Older history moves to `docs/CHANGELOG.md` (CLAUDE.md · QUOTA DISCIPLINE (v5)).
Maintained by pg-scribe only, in the same commit as the task it records.

| field | value |
|---|---|
| Phase | 0 — Foundation |
| Current task | **0.13** — `packages/contracts` (`docs/package/38-WBS.md`) — next session; 0.4 DONE, 0.9 BLOCKED on psql |
| Golden slice (2.9) | not built · `.golden-slice-accepted` absent · `scripts/new-slice.sh` is a no-op |
| Deployment tier | Tier 0 (`docs/package/42-Oracle-Cloud-Deployment.md`) |
| Schema | `database/schema/01 · 13 · 13B · 019` — the ONLY permitted schema · `apply.sh --recreate` **not yet run on this machine** |
| Session model | sonnet (opus only for the 2.9 session, an ADR, a security review, or a second failure) |
| Toolchain | pnpm 9.15.9 · Node 25.2.1 · Docker 29.0.1 present (2026-09-21) · **psql 16 absent** · TypeScript held at 5.9.3, ceiling `<6.1.0` (typescript-eslint peer) — CHANGELOG 0.4 |
| Setup check | `scripts/check-setup.sh` → FILES READY · `scripts/check-boundaries.sh` → BOUNDARIES ENFORCED (A–F) · `apply.sh --recreate` NOT RUN · guards G1–G18 NOT RUN |

## Lanes

None claimed. Live table: `tasks/LANE_LOCKS.md` — Phase 0 and the golden slice are never parallelised.

## Last 5 DONE (newest first)

| task | commit |
|---|---|
| 0.4 — monorepo skeleton: pnpm workspace · Turborepo · TS strict · ESLint boundaries (3 layers) | `<hash of the 0.4 commit — written by pg-scribe in the 0.9 commit>` |
| BOOTSTRAP-001 — kit verified/completed (BOOTSTRAP-v5 §9), first hash recorded, apply.sh NOT RUN | `aca1b16` |
| SETUP-000 — package v4 + schema + kit + backlog + decision log imported (no agent session) | `bab005a` |

## Blockers

- **psql 16 absent (environment, not a code blocker).** `apply.sh --recreate` and `pnpm guards:run` are
  NOT RUN, and **0.9 is the first task unverifiable without them**. Install psql 16 → `docker compose -f
  infra/docker/docker-compose.yml up -d postgres` → `apply.sh --recreate` → 0.9. pnpm · Node · Docker
  were installed 2026-09-21 and unblocked 0.4.
- **Sessions must start inside `claude-kit/`.** Opened one level above, Claude Code never registers
  `.claude/agents`, `.claude/commands` or the lane-guard hook, so `docs/MODEL_ROUTING.md` cannot be followed
  and all work falls back to the Master (this happened in 0.4 — CHANGELOG). Check: `/resume` is offered.
- **Git lock files in the Claude-connected folder cannot be deleted** (`.git/*.lock` →
  `stale-*.lock-*`); remove by hand. Commits from Git Bash are unaffected.
- A REAL BLOCKER is only: the acceptance test cannot be run · a money/permission/legal decision is
  absent from EXECUTION-MASTER-v4 Part 1 · a schema object is missing and G-01 forbids it. Otherwise:
  state one default, record it in CHANGELOG, proceed.

## Next 3 tasks

1. **0.13 · 0.14** — `packages/contracts` (Zod → OpenAPI) · `packages/domain-kit` (Money, Quantity,
   Clock, IdGenerator), lane C, unblocked by 0.4. **Neither needs a database** — runnable today.
2. **0.9** — `platform`: entities, settings, counters, `next_doc_no`, `platform.outbox`, `audit_log`
   partitioned + `audit_hash_chain` (lane B, 🤖). **BLOCKED**: its acceptance needs a live database
   and `apply.sh` calls `psql` on the host (line 64) — install psql 16 first. Unblocks 0.10–0.12.
3. **0.6** — CI, the seven named gates (Master) — needs 0.4 **and** 0.5 (lane A, WAITING_GM). Gate ①
   must call `scripts/check-boundaries.sh`; nothing does yet.

## Notes

- `tasks/MASTER_BACKLOG.md` is generated from doc 38 by `scripts/gen-backlog.py` (132 rows; regenerate
  after any doc-38 change — statuses are preserved). iMile API: a GM-lane task; the code track never waits.
- WAITING_GM (never blocks a code lane): Phase 0 lane A — 0.2 · 0.3 · 0.5 · 0.7 · 0.8 · 0.20, plus the four in `tasks/proposed/`.
- Phase 0 gate: 0.18 isolation (G7 = 0) · 0.16 classification (G6 = 0) · 0.8 restore succeeded · 0.1 owners named · 0.2 decisions recorded.
- `apply.sh --recreate` expectation: zero errors · 175 tables · 3,330 locations · G1–G13 = 0 · G7 = 0 · G-SEED = 0 · G6 non-blocking until 0.16.
