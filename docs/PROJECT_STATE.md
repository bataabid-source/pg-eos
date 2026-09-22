# PROJECT_STATE — PG-EOS

**Hard limit: 60 lines.** Older history moves to `docs/CHANGELOG.md` (CLAUDE.md · QUOTA DISCIPLINE (v5)).
Maintained by pg-scribe only, in the same commit as the task it records.

| field | value |
|---|---|
| Phase | 0 — Foundation |
| Current task | **0.18** — RLS client-isolation test. Delivered: `tests/isolation` workspace, G14 runner (`pnpm test:isolation`) wired into `scripts/guards-run.sh`, turbo routing, eslint scoped. Suite 21/24 test scenarios pass; 3 pinned FAILS (SCR-RLS-01/-02 unfixed). **BLOCKED — not DONE — on two G-01 schema decisions pending GM.** Partial delivery merged to `main` at `428a565` (fast-forward, 2026-09-23). |
| Golden slice (2.9) | not built · `.golden-slice-accepted` absent · `scripts/new-slice.sh` is a no-op. **Acceptance gains a Phase-0 wiring line (GM 2026-09-22): the golden slice must wire up every part deferred from Phase-0 "mechanism only" tasks — starting with 0.17's login endpoints.** |
| Deployment tier | Tier 0 (`docs/package/42-Oracle-Cloud-Deployment.md`) |
| Schema | `database/schema/01 · 13 · 13B · 019` — the ONLY permitted schema · `apply.sh --recreate` **green on this machine 2026-09-22**: 175 tables/14 schemas, `wms.verify_wh1()` 21/21 pass (3,330 locations), G1–G13 = 0 (G6 blocking, 0 rows — WBS 0.16 complete), G18/G-SEED report-only = 0 |
| Session model | sonnet (opus only for the 2.9 session, an ADR, a security review, or a second failure) |
| Toolchain | pnpm 9.15.9 · Node 25.2.1 · Docker 29.0.1 · psql 16.15 installed · migrations auto-runner enabled (WBS 0.11) · **psql UTF-8 fix** (WBS 0.15: stdin redirect not `-f` to avoid multi-byte corruption; trade-off: error output loses line numbers — see `apply.sh` header for details) · TypeScript 5.9.3 ceiling `<6.1.0` |
| Setup check | `scripts/check-setup.sh` → FILES READY · `scripts/check-boundaries.sh` → BOUNDARIES ENFORCED (A–F) · `apply.sh --recreate` GREEN 2026-09-22 · guards G1–G14/G18 GREEN (G15–G17 not yet run) |

## Lanes

None claimed. Live table: `tasks/LANE_LOCKS.md` — Phase 0 and the golden slice are never parallelised.

## Last 5 DONE (newest first)

| task | commit |
|---|---|
| 0.17 — Identity mechanism (mechanisms only): OTP, sessions, RBAC/SoD evaluation — packages/identity/ | `c90dd6e` |
| 0.16 — Column sensitivity classification: `identity.column_classification` + deploy guard | `a021126` |
| 0.15 — Document engine: templates, bindings, Chromium PDF, bilingual RTL | `954ff3a` |
| 0.12 — `packages/events`: outbox relay + subscriber registry | `4164eb0` |
| 0.11 — `packages/db`: Drizzle + `withContext()` + lint rule | `e138ba2` |

## Blockers

- **WBS 0.18: SCR-RLS-01** (`entity_scope` OR `client_portal_scope` defeats isolation) — reproduced live,
  7 tables affected. Awaiting GM decision on Option B/C.
- **WBS 0.18: SCR-RLS-02** (`audit_log` partitioned parent has no RLS, bypasses G7) — reproduced live.
  Awaiting GM decision on recommended A+B+C.
- Concurrent external processes on this working directory can delete uncommitted work (incident `a901a04`).
- Sessions must start inside `claude-kit/` (`.claude/agents` + lane-guard hook not registered otherwise).
- Git lock files (`.git/*.lock` → `stale-*.lock-*`) cannot be deleted via tools; remove by hand.

## Next 3 tasks

1. **0.18** — **BLOCKED on SCR-RLS-01 and SCR-RLS-02 (GM)** — not DONE, partial delivery complete.
2. **0.19** — deferred in full (acceptance criterion IS a rendered screen; no mechanism-only subset).
3. **0.20** — Runbook v1 (deploy, rollback, restore, secrets rotation) — awaiting 0.6 green (lane A).

## Notes

- WAITING_GM: Phase 0 lane A tasks (0.2, 0.3, 0.5, 0.7, 0.8, 0.20) plus four in `tasks/proposed/`.
- Phase 0 gate: 0.18 isolation (G7 = 0; 2 SCRs open) · 0.16 classification (G6 = 0) · 0.8 restore · 0.1 owners.
- 0.9 closed at `aa46787` with two unmerged WIP branches (`0217e85`, `f127ab2`), catalogued in
  `docs/notes/0.9-abandoned-wip.md` — never merge, never delete.
- Phase-0 policy (GM 2026-09-22): every task delivers mechanism-only (`packages/*`, tests), no
  modules/endpoints/screens. Deferred parts tracked here and in `MASTER_BACKLOG.md` (not docs/package/38).
