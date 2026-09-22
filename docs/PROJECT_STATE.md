# PROJECT_STATE — PG-EOS

**Hard limit: 60 lines.** Older history moves to `docs/CHANGELOG.md` (CLAUDE.md · QUOTA DISCIPLINE (v5)).
Maintained by pg-scribe only, in the same commit as the task it records.

| field | value |
|---|---|
| Phase | 0 — Foundation |
| Current task | **0.15** — Document engine: templates, bindings, Chromium PDF, bilingual RTL (READY, lane M, depends on 0.9 DONE) |
| Golden slice (2.9) | not built · `.golden-slice-accepted` absent · `scripts/new-slice.sh` is a no-op |
| Deployment tier | Tier 0 (`docs/package/42-Oracle-Cloud-Deployment.md`) |
| Schema | `database/schema/01 · 13 · 13B · 019` — the ONLY permitted schema · `apply.sh --recreate` **green on this machine 2026-09-22**: 175 tables/14 schemas, `wms.verify_wh1()` 21/21 pass (3,330 locations), G1–G13 = 0 (G6 non-blocking, 2404 rows — WBS 0.16), G18/G-SEED report-only = 0 |
| Session model | sonnet (opus only for the 2.9 session, an ADR, a security review, or a second failure) |
| Toolchain | pnpm 9.15.9 · Node 25.2.1 · Docker 29.0.1 · **psql 16.15 installed 2026-09-22** (`C:\Program Files\PostgreSQL\16\bin`, User PATH) · **migrations auto-runner enabled 2026-09-22**: `apply.sh` applies every `database/migrations/*.sql` sorted numerically after baseline (WBS 0.11) · TypeScript held at 5.9.3, ceiling `<6.1.0` (typescript-eslint peer) — CHANGELOG 0.4 |
| Setup check | `scripts/check-setup.sh` → FILES READY · `scripts/check-boundaries.sh` → BOUNDARIES ENFORCED (A–F) · `apply.sh --recreate` GREEN 2026-09-22 · guards G1–G13/G18 GREEN (G14–G17 outside SQL, not yet run) |

## Lanes

None claimed. Live table: `tasks/LANE_LOCKS.md` — Phase 0 and the golden slice are never parallelised.

## Last 5 DONE (newest first)

| task | commit |
|---|---|
| 0.12 — `packages/events`: outbox relay + subscriber registry | `<pending>` |
| 0.11 — `packages/db`: Drizzle + `withContext()` + lint rule | `<pending>` |
| 0.10 — `platform`: thresholds, feature flags, automation rules, decisions table | `<pending>` |
| 0.9 — `platform` schema atomic allocator + audit chain proof | `<pending>` |
| 0.14 — `packages/domain-kit`: Money, Quantity, Clock, IdGenerator | `a8f4899` |

## Blockers

- **Concurrent external processes on this working directory can delete uncommitted work** (incident:
  `a901a04` mid-slice deleted 0.13 untracked files; recovered at `1bc09f7` + `50055f8`). Commit more
  frequently on long slices as mitigation until a root cause is found (CHANGELOG 0.13 §incident).
- **Sessions must start inside `claude-kit/`.** Opened one level above, Claude Code never registers
  `.claude/agents`, `.claude/commands` or the lane-guard hook, so `docs/MODEL_ROUTING.md` cannot be followed
  and all work falls back to the Master (this happened in 0.4 — CHANGELOG). Check: `/resume` is offered.
- **Git lock files cannot be deleted** (`.git/*.lock` → `stale-*.lock-*`); remove by hand.
- A REAL BLOCKER: acceptance fails · legal/money decision absent · schema missing and G-01 forbids. Else state default, record in CHANGELOG, proceed.

## Next 3 tasks

1. **0.15** — Document engine: templates, bindings, Chromium PDF, bilingual RTL (READY, lane M, depends on 0.9).
2. **0.16** — Column sensitivity classification (lane M, depends on 0.9; **blocker: G6 must return 0**).
3. **0.17** — M01 Identity: OTP login, sessions, roles, permissions, structure editor (lane M, depends on 0.11).

## Notes

- WAITING_GM (never blocks code lanes): Phase 0 lane A — 0.2 · 0.3 · 0.5 · 0.7 · 0.8 · 0.20, plus four in `tasks/proposed/`.
- Phase 0 gate: 0.18 isolation (G7 = 0) · 0.16 classification (G6 = 0) · 0.8 restore · 0.1 owners · 0.2 decisions.
- psql 16 + docker postgres verified 2026-09-22 (CHANGELOG). `docker compose up -d postgres` needs
  `PGADMIN_PASSWORD` set to any value (interpolation quirk, profile-gated service, not fixed).
