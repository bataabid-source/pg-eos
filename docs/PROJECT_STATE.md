# PROJECT_STATE — PG-EOS

**Hard limit: 60 lines.** Older history moves to `docs/CHANGELOG.md` (CLAUDE.md · QUOTA DISCIPLINE (v5)).
Maintained by pg-scribe only, in the same commit as the task it records.

| field | value |
|---|---|
| Phase | 0 — Foundation → 2 — Warehouse (2.1 started 2026-09-23) |
| Current task | **X — record GM decisions 2026-09-23 (D-103…D-121)** (previous task 2.6 — `wms.skus` registration mechanism @ `e38370e`). Governance/bookkeeping only — no code, schema, migration or test touched. Completion 14/132 unchanged (0.17 mechanisms and 1.5 proof still excluded — ADR-0001). |
| Golden slice (2.9) | not built · `.golden-slice-accepted` absent · `scripts/new-slice.sh` is a no-op. Depends on 2.4, 2.6, 2.8, 0.15 — **2.6 now DONE** (joins 2.8, 0.15 already DONE); 2.4 still TODO; **Phase-0 gate still open (0.2, 0.8) → 2.9 is no closer to starting.** **Acceptance gains a Phase-0 wiring line (GM 2026-09-22): the golden slice must wire up every part deferred from Phase-0 "mechanism only" tasks — starting with 0.17's login endpoints.** |
| Deployment tier | Tier 0 (`docs/package/42-Oracle-Cloud-Deployment.md`) |
| Schema | `database/schema/01 · 13 · 13B · 019` — the ONLY permitted schema (01 v1.1, 13B v4.4, migrations 0001–0006) · DB locale UTF8 / collate C / ctype C.UTF-8 · `apply.sh --recreate` **green on this machine 2026-09-23**: 175 tables/14 schemas, `wms.verify_wh1()` 21/21 pass (3,330 locations), G1–G13 = 0 (G6 blocking, 0 rows — WBS 0.16 complete), G18/G-SEED report-only = 0 |
| Session model | opus (`claude-opus-5-5`, set by the GM via /model on 2026-09-23 before phase F; earlier today fable `claude-fable-5-1`) · workers sonnet, reviews/ADR/security opus, pg-scribe sonnet, no haiku (GM 2026-09-23) |
| Toolchain | pnpm 9.15.9 · Node 25.2.1 · Docker 29.0.1 · psql 16.15 installed · claude CLI installed (npm -g) · migrations auto-runner enabled (WBS 0.11) · **psql UTF-8 fix** (WBS 0.15: stdin redirect not `-f` to avoid multi-byte corruption; trade-off: error output loses line numbers — see `apply.sh` header for details) · TypeScript 5.9.3 ceiling `<6.1.0` |
| Setup check | Task X Part 4 verification (2026-09-23): `bash scripts/check-setup.sh` → READY · `pnpm lint` clean · `pnpm lint:boundaries` → BOUNDARIES ENFORCED (A-F) · `pnpm typecheck` 14/14 (cached, full turbo) · `PGUSER=postgres pnpm guards:run` → G1-G14+G18+G-SEED = 0 rows, all blocking guards green (G15-G17 not run, known) · `gen-briefs.py --check` all 15 briefs ok, ≤120 lines · `gen-backlog.py --check` 132 rows, header/X.1-X.6/0.19 agree |

## Lanes

None claimed.

## Last 5 DONE (newest first)

| task | commit |
|---|---|
| 2.6 — wms.skus registration mechanism, cross-client SKU mix rejected (D-103) | `e38370e` |
| X — GM decisions 2026-09-23 housekeeping (D-105…D-112) | `0260778` |
| 1.5 — Customer accounts proof slice (ADR-0001) + SCR-TRGM-01 option A | `f790da7` |
| 2.8 — Stock ledger + derived balance + verify_balance_integrity (fixes e5bff15 SCR-AUDIT-01, 787d9dc SCR-WMS-01) | `b5da282` |
| 2.1 — WH1 zones + 8 space blocks proof (modules/wms scaffold) | `0d546d5` |

## Blockers

- **Open G-01 item:** where the G8 anchor is stored before the first partition detach (≥ 2028-03).
- **G-01 item (2.6) CLOSED by D-116:** `wms.skus` stays with no `entity_id`; `outbox_business_needs_entity` not weakened; audit_log-only is final, correct behaviour.
- WAITING_GM · **2.2** field survey — chain 2.2 → 2.3 → 2.4 → 2.9.
- WAITING_GM · **0.2** three cloud decisions (doc 42 §11) → 0.3 → 0.5 → 0.6; and **0.8** restore test.
- **Phase-0 gate open** (0.2, 0.8); **2.9 does not start before it closes**.
- (0.18 carried forward) `entity_scope` is `FOR ALL` with `USING` only on `platform.audit_log` and on seven tables, governs INSERT — portal user's audited action rejected; every internal reader/writer must pass `isInternal: true` (GUC-only, false when unset). SCR-RLS-01 §6, SCR-RLS-02 §7, D-002.
- Concurrent external processes on this working directory can delete uncommitted work (incident `a901a04`).
- Sessions must start inside `claude-kit/` (`.claude/agents` + lane-guard hook not registered otherwise).
- Git lock files (`.git/*.lock` → `stale-*.lock-*`) cannot be deleted via tools; remove by hand.

## Next 3 tasks

1. 2.7 Data gate M04 (SKUs) — dependency 2.6 now met; still WAITING_GM per D-119 (GM must read the decision sheet)
2. 2.2 field survey → 2.3 → 2.4 (WAITING_GM)
3. 0.6 CI (waits on 0.5)

## Notes

- WAITING_GM: Phase 0 lane A tasks (0.2, 0.3, 0.5, 0.7, 0.8, 0.20) plus four in `tasks/proposed/`.
- Phase 0 gate: 0.18 isolation **DONE** (G7 = 0, D-002 applied) · 0.16 classification (G6 = 0) · 0.8 restore · 0.1 owners.
- 0.9 closed at `aa46787` with two unmerged WIP branches (`0217e85`, `f127ab2`), catalogued in `docs/notes/0.9-abandoned-wip.md` — never merge, never delete.
- Phase-0 policy (GM 2026-09-22): every task delivers mechanism-only (`packages/*`, tests), no modules/endpoints/screens. Deferred parts tracked here and in `MASTER_BACKLOG.md` (not docs/package/38).
- GIT rule (GM 2026-09-23 B3): no standalone "record the verified hash" commit; task ↔ code link is `git log` with `type(WBS):`; previous task's hash is recorded here inside the next task's commit.
- GM decision sheet: docs/notes/2026-09-23-gm-decision-sheet.md (WAITING_GM rows + G-01 G8 anchor + blockers 2.2/0.2/0.8).
