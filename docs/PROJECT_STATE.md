# PROJECT_STATE — PG-EOS

**Hard limit: 60 lines.** Older history moves to `docs/CHANGELOG.md` (CLAUDE.md · QUOTA DISCIPLINE (v5)).
Maintained by pg-scribe only, in the same commit as the task it records.

| field | value |
|---|---|
| Phase | **0 — Foundation CLOSED (0.20 sealed, D-176)** → 1 — Commercial Core (in progress) → 2 — Warehouse (in progress, 7/19) · **pilot-first (D-127): seed 019 + synthetic data; field/human/sign-off/training/Tier-0 provisioning DEFERRED-POST-PILOT** |
| Current task | **D-176 (2026-09-25): finish phases in order.** Phase 0 CLOSED @ `28ae48d`. 1.4 DONE @ `b21d89a`. 1.6 DONE @ `6accbf2` (M02 quotes, migration 0017). 5.5a FULLY DONE @ `ffab3bf`. 2.13 DONE @ `ca9a109` (lane 2, inventory count, INV-C3-7; migration 0018). 1.7 DONE @ `<this commit>` (lane 1, M02 contracts/price annex/SLA/billing flags; migration 0019). Next: lane 1 → 1.8 credit limit → 1.9 → 1.11 · lane 2 → 2.14 occupancy snapshot (lock `wms`) · lane 3 finishes 3.14 part 2 in flight, then **idles pending GM answer**. Completion 29/136. Previous governance commit: `e38d30a`. |
| Golden slice (2.9) | **ACCEPTED** · `.golden-slice-accepted` committed · `scripts/new-slice.sh` active (registers contract exports itself since `412708a`) · `.githooks/pre-commit` active (①lint/boundaries/types ②touched-module unit tests ③guards:run when database/ staged) · scope backend only, no PDA UI. R1: an all-zero order gets no GRN and no `wms.inbound.received` event. |
| Deployment tier | **Pilot Tier 0 = local Docker `postgres:16` (D-129)**; Oracle Tier 0 after the pilot (0.3, 0.5, 0.7, 0.6b DEFERRED-POST-PILOT) — procedures placeholder in `docs/RUNBOOK.md` §8 |
| Schema | `database/schema/01 · 13 · 13B · 019` — the ONLY permitted schema (migrations 0001–0021 applied: see `docs/CHANGELOG.md` for the full list) · DB locale UTF8 / collate C / ctype C.UTF-8 · next free migration **0022** · **SCR-HR-ATT-01 APPROVED (D-131)** — migration number not yet issued |
| Session model | **D-174: lane sessions sonnet / effort medium · Master sonnet / medium for merges + bookkeeping, opus only for ADR / security / D-117 · fable only when the GM names it** · agents pinned: pg-reviewer opus, all other agents sonnet, no haiku · fast mode unavailable (SDK) |
| Toolchain | pnpm 9.15.9 · Node 25.2.1 · Docker 29.0.1 · psql 16.15 · claude CLI · TypeScript 5.9.3 ceiling `<6.1.0` · Python 3.13 (`python`, not `python3`) · `gh` per command with the Git-Credential-Manager token (D-173, `docs/RUNBOOK.md` §3) |
| Setup check | 2026-09-24: `gen-backlog.py --check` 136 rows (v4.4) · `check-setup.sh` MASTER_BACKLOG OK, PG_APP_USER unset → NOTE only · gates ①–⑥ green on main via CI |

## Lanes

| lane | task | module lock | worktree | status |
|---|---|---|---|---|
| 1 | Phase 1, in order: 1.4 DONE @ `b21d89a` · 1.6 DONE @ `6accbf2` · 1.7 DONE @ `e3ced50` · 1.8 DONE @ `<this commit>` → next 1.9 → 1.11 (D-176) | `sales` | `../pg-eos-lane-1` | feat(1.8) committed on lane/1 @ `<this commit>`, PR pending Master merge; next per D-176: 1.9 customer 360 |
| 2 | Phase 2: 2.13 DONE @ `ca9a109`, next 2.14 (occupancy snapshot), D-176 | `wms` | `../pg-eos-lane-2` | queued — next lane-2 session; 5.5a FULLY DONE (part 1 @ `3679b70`, part 2 @ `ffab3bf`); next free migration **0020** |
| 3 | 3.14 part 2 — `services/agent` pull loop (in flight) — then **idle pending GM answer to D-176's batched question** | `imile` | shared `claude-kit` | queued — next lane-3 session; part 1 (health reporting) committed NOT DONE @ `8b12d60`, pg-reviewer PASS round 4 |

## Last 5 DONE (newest first)

| task | commit |
|---|---|
| 1.8 — group-level credit limit and hold; found + fixed a real RLS gap on sales.accounts (D-177) (lane 1), DONE pending merge | `<this commit>` |
| 1.7 — M02 contracts, price annexes, SLA definitions, billing flags (lane 1), DONE | `e3ced50` |
| 2.13 — inventory count: blind, recount mandatory, adjustment by approval (INV-C3-7), migration 0018 (lane 2), DONE | `ca9a109` |
| 1.6 — M02 quotes with approval flow: rep → sales mgr → CFO → GM on exception (lane 1), DONE | `6accbf2` |
| 1.4 — pricing engine: exception → contract → segment → list → pending (lane 1), DONE | `b21d89a` |

## Blockers (settle BEFORE any lane opens — reviewer's project-wide items)

- **`scripts/deploy.sh` does not exist yet**: G15–G17 are NOT RUNNABLE and non-blocking at merge until it exists (0.6b / deploy slice, DEFERRED-POST-PILOT).
- **Open G-01 items:** G8 anchor storage before the first partition detach (≥ 2028-03) — D-115. **3.14 part 1:** `imile.agent_health` has no `entity_id` (event not on the outbox yet); no DB CHECKs for two invariants (app-layer only) — `docs/notes/2026-09-24-imile-agent-scenario.md` §4 rows e/f.
- **Carried under D-131 (owner GM, post-pilot):** ADR-0003 items 1, 3, 4a, 5, 6, 8, 9; GPS classification; SoD mechanism; §2.5 values. APP-1 stays `tasks/proposed/`.
- WAITING_GM rows: **0** (D-127). Deferred post-pilot: 20 rows, listed under Phase 7 in `tasks/MASTER_BACKLOG.md`. Concurrent external processes can delete uncommitted work (incident `a901a04`) · sessions start inside `claude-kit/` · stale `.git/*.lock` files removed by hand — see `docs/RUNBOOK.md` "Incident quick reference".
- **Batched Master tasks (frozen paths, one Master-only window):** `entityId` on `WithContextCtx` (`packages/db`) · SCR-HR-EMP-01 three DB CHECKs (pre-migration review first) · catalog events into `packages/events/catalog.ts` when 1.4/1.6 consume them.
- **Flagged by lane 2, pre-existing, untouched:** ~7 failures in `tests/evaluate-alerts/**` and `tests/integration/{schema-invariants,audit-chain-*}.test.ts` — audit-chain ones need Master/GM attention.
- **D-176 open question (non-blocking):** lane 3 idles after finishing 3.14 part 2 — accept, or let it take a Phase-3/5/6 row out of strict order?
- **Flagged by lane 2 (5.5a part 2, still applies):** full unfiltered `pnpm --filter @pg-eos/hr test` occasionally shows transient failures under concurrent shared-Postgres access — not a defect, isolated reruns 100% green.
- **2.13 side-notes:** WH1 seed gap backfilled (1 missing location row, `wms.generate_locations()`, `verify_wh1()` 0 failing rows — WBS 2.1/2.3 fix, not 2.13's own delivery); round-3 fixes (3 findings) done by the lane session on sonnet, not escalated to opus per D-117's letter — re-verified PASS by pg-reviewer (opus) round 4.

## Next 3 tasks (D-176 — phase-sequential)

1. Lane 1: Phase 1 continues, next 1.8 credit limit (1.4, 1.6, 1.7 DONE)
2. Lane 2: Phase 2 — next 2.14 (occupancy snapshot + overflow billable event), lock `wms` (2.13 DONE @ `ca9a109`)
3. Lane 3: finish 3.14 part 2 (in flight) — then idle pending the GM's D-176 answer

## Notes

- main is PR-protected — commit on a branch, push, open a PR, merge on green CI. Lane PRs are opened and merged by the Master (`gh`, rebase merge); a lane branch that conflicts after another merges is rebased by the Master and re-pushed as `<branch>-rN` (D-173). Full mechanics: `docs/RUNBOOK.md`.
- Doc 38 is **v4.4 (136 rows, D-173)**. Staged rows 2.20 / 2.9b / 6.2b / SC-01 unchanged (TODO, `tasks/backlog/`).
- **D-176 (2026-09-25): finish phases in order** — supersedes the phase-jumping exceptions of D-172/D-173/D-175 for any *new* row a lane picks up; in-flight multi-part slices are finished first.
- 0.9 closed at `aa46787` with two unmerged WIP branches (`0217e85`, `f127ab2`) — `docs/notes/0.9-abandoned-wip.md`; never merge, never delete.
- GIT rule (GM 2026-09-23 B3): task ↔ code link is `git log` with `type(WBS):`; previous task's hash recorded here inside the next task's commit.
- GM decision sheet: `docs/notes/2026-09-23-gm-decision-sheet.md` · cleanup dispositions: `docs/notes/2026-09-24-cleanup-candidates.md` §4.
