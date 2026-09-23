# PROJECT_STATE — PG-EOS

**Hard limit: 60 lines.** Older history moves to `docs/CHANGELOG.md` (CLAUDE.md · QUOTA DISCIPLINE (v5)).
Maintained by pg-scribe only, in the same commit as the task it records.

| field | value |
|---|---|
| Phase | 0 — Foundation → 2 — Warehouse (2.1 started 2026-09-23) |
| Current task | **2.1 — DONE** @ `<pending>`. WH1 registered exactly as doc 19 §4: proof suite `modules/wms/tests/integration/wh1-setup.test.ts` 29/29 (8 blocks · 11 zones · 3,153 storage · 3,301.641 m³ · verify_wh1 21/21) — proof-only slice, no code; `modules/wms` scaffolded like platform/identity. Phase 2 begins. |
| Golden slice (2.9) | not built · `.golden-slice-accepted` absent · `scripts/new-slice.sh` is a no-op. **Acceptance gains a Phase-0 wiring line (GM 2026-09-22): the golden slice must wire up every part deferred from Phase-0 "mechanism only" tasks — starting with 0.17's login endpoints.** |
| Deployment tier | Tier 0 (`docs/package/42-Oracle-Cloud-Deployment.md`) |
| Schema | `database/schema/01 · 13 · 13B · 019` — the ONLY permitted schema · `apply.sh --recreate` **green on this machine 2026-09-22**: 175 tables/14 schemas, `wms.verify_wh1()` 21/21 pass (3,330 locations), G1–G13 = 0 (G6 blocking, 0 rows — WBS 0.16 complete), G18/G-SEED report-only = 0 |
| Session model | fable (`claude-fable-5-1`, GM-set — not one of the four `docs/MODEL_ROUTING.md` tier aliases, reported verbatim, never silently mapped). Reviews and security design run on opus per MODEL_ROUTING §4 |
| Toolchain | pnpm 9.15.9 · Node 25.2.1 · Docker 29.0.1 · psql 16.15 installed · migrations auto-runner enabled (WBS 0.11) · **psql UTF-8 fix** (WBS 0.15: stdin redirect not `-f` to avoid multi-byte corruption; trade-off: error output loses line numbers — see `apply.sh` header for details) · TypeScript 5.9.3 ceiling `<6.1.0` |
| Setup check | `scripts/check-setup.sh` → FILES READY · `scripts/check-boundaries.sh` → BOUNDARIES ENFORCED (A–F) · `apply.sh --recreate` GREEN 2026-09-23 (175 tables, migrations 0001–0003) · guards G1–G14/G18 GREEN (G15–G17 not yet run) |

## Lanes

None claimed. Live table: `tasks/LANE_LOCKS.md` — Phase 0 and the golden slice are never parallelised.

## Last 5 DONE (newest first)

| task | commit |
|---|---|
| 2.1 — WH1 zones + 8 space blocks proof (modules/wms scaffold) | `<pending>` |
| 0.18 — RLS client-isolation suite (43/43) + G14 runner; SCRs 01/02 applied (D-002) | `f03e160` |
| 0.17 — Identity mechanism (mechanisms only): OTP, sessions, RBAC/SoD evaluation — packages/identity/ | `c90dd6e` |
| 0.16 — Column sensitivity classification: `identity.column_classification` + deploy guard | `a021126` |
| 0.15 — Document engine: templates, bindings, Chromium PDF, bilingual RTL | `954ff3a` |

## Blockers

- None for 0.18. Carried forward to 0.5/0.6 (role design): `entity_scope` is `FOR ALL` with `USING` only on `platform.audit_log` and on the seven tables, so it also governs INSERT — under a non-superuser runtime a portal user's audited action would be rejected, and every internal reader AND writer of the seven tables must pass `isInternal: true` (`platform.is_internal()` is GUC-only and false when unset). SCR-RLS-01 §6, SCR-RLS-02 §7, D-002.
- Concurrent external processes on this working directory can delete uncommitted work (incident `a901a04`).
- Sessions must start inside `claude-kit/` (`.claude/agents` + lane-guard hook not registered otherwise).
- Git lock files (`.git/*.lock` → `stale-*.lock-*`) cannot be deleted via tools; remove by hand.

## Next 3 tasks

1. **2.8** — stock ledger + derived balance + verify_balance_integrity() (lane 2; deps 0.12 DONE)
2. **0.6** — CI pipeline (lane M; waits on 0.5 WAITING_GM)
3. **0.19** — deferred → 2.9.

## Notes

- WAITING_GM: Phase 0 lane A tasks (0.2, 0.3, 0.5, 0.7, 0.8, 0.20) plus four in `tasks/proposed/`.
- Phase 0 gate: 0.18 isolation **DONE** (G7 = 0, D-002 applied) · 0.16 classification (G6 = 0) · 0.8 restore · 0.1 owners.
- 0.9 closed at `aa46787` with two unmerged WIP branches (`0217e85`, `f127ab2`), catalogued in
  `docs/notes/0.9-abandoned-wip.md` — never merge, never delete.
- Phase-0 policy (GM 2026-09-22): every task delivers mechanism-only (`packages/*`, tests), no
  modules/endpoints/screens. Deferred parts tracked here and in `MASTER_BACKLOG.md` (not docs/package/38).
