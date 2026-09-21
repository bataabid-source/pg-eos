# PROJECT_STATE — PG-EOS

**Hard limit: 60 lines.** Older history moves to `docs/CHANGELOG.md` (CLAUDE.md · QUOTA DISCIPLINE (v5)).
Maintained by pg-scribe only, in the same commit as the task it records.

| field | value |
|---|---|
| Phase | 0 — Foundation |
| Current task | None READY — 0.14 DONE; 0.9 BLOCKED on psql; 0.6 awaits 0.5 WAITING_GM |
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
| 0.14 — `packages/domain-kit`: Money, Quantity, Clock, IdGenerator | `<pending>` |
| 0.13 — `packages/contracts`: Zod → OpenAPI; ContractRegistry · Problem · Idempotency-Key · drift test | `50055f8` |
| SCR-I18N-01 — Amharic (`am`) language added (G-01 · D-001) | `8d62747` |
| 0.4 — pnpm · Turborepo · TS strict · ESLint boundaries | `05674b5` |
| BOOTSTRAP-001 — kit verified (BOOTSTRAP-v5 §9) | `aca1b16` |

## Blockers

- **Concurrent external processes on this working directory can delete uncommitted work** (incident:
  `a901a04` mid-slice deleted 0.13 untracked files; recovered at `1bc09f7` + `50055f8`). Commit more
  frequently on long slices as mitigation until a root cause is found (CHANGELOG 0.13 §incident).
- **psql 16 absent (environment, not a code blocker).** `apply.sh --recreate` and `pnpm guards:run` are
  NOT RUN, and **0.9 is the first task unverifiable without them**. Install psql 16 → `docker compose -f
  infra/docker/docker-compose.yml up -d postgres` → `apply.sh --recreate` → 0.9. pnpm · Node · Docker
  were installed 2026-09-21 and unblocked 0.4.
- **Sessions must start inside `claude-kit/`.** Opened one level above, Claude Code never registers
  `.claude/agents`, `.claude/commands` or the lane-guard hook, so `docs/MODEL_ROUTING.md` cannot be followed
  and all work falls back to the Master (this happened in 0.4 — CHANGELOG). Check: `/resume` is offered.
- **Git lock files cannot be deleted** (`.git/*.lock` → `stale-*.lock-*`); remove by hand.
- A REAL BLOCKER: acceptance fails · legal/money decision absent · schema missing and G-01 forbids. Else state default, record in CHANGELOG, proceed.

## Next 3 tasks

1. **0.9** — `platform`: entities, settings, counters, `next_doc_no`, `platform.outbox`, `audit_log`
   partitioned + `audit_hash_chain` (lane B, 🤖). **BLOCKED**: its acceptance needs a live database
   and `apply.sh` calls `psql` on the host (line 64) — install psql 16 first. Unblocks 0.10–0.12.
2. **0.6** — CI, the seven named gates (Master) — needs 0.4 **and** 0.5 (lane A, WAITING_GM). Gate ①
   must call `scripts/check-boundaries.sh`; nothing does yet.
3. No task is READY after 0.14 DONE and 0.9 BLOCKED. All others block on either WAITING_GM lane A
   (0.2, 0.3, 0.5, 0.7, 0.8) or on 0.9 (0.10–0.12, 0.15, Phase 1+).

## Notes

- WAITING_GM (never blocks code lanes): Phase 0 lane A — 0.2 · 0.3 · 0.5 · 0.7 · 0.8 · 0.20, plus four in `tasks/proposed/`.
- Phase 0 gate: 0.18 isolation (G7 = 0) · 0.16 classification (G6 = 0) · 0.8 restore · 0.1 owners · 0.2 decisions.
