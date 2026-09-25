# PROJECT_STATE — PG-EOS

**Hard limit: 60 lines.** Older history moves to `docs/CHANGELOG.md` (CLAUDE.md · QUOTA DISCIPLINE (v5)).
Maintained by pg-scribe only, in the same commit as the task it records.

| field | value |
|---|---|
| Phase | **0 — Foundation CLOSED (0.20 sealed, D-176)** → 1 — Commercial Core (buildable rows done except 1.11, Master-only) → 2 — Warehouse (in progress, 9/19) · **pilot-first (D-127): seed 019 + synthetic data; field/human/sign-off/training/Tier-0 provisioning DEFERRED-POST-PILOT** |
| Current task | **D-180 (2026-09-25): session plan** — one Master session ("إدارة الجلسات والوكلاء", fable, GM's menu choice) from `../pg-eos-gov`; lanes 1/2/3 assigned via D-179 use-case locks: lane 1 = `wms/process-outbound` (2.11), lane 2 = `wms/schedule-inbound` (2.9b), lane 3 = `imile` (3.14 part 2 → 3.15). Four stale/duplicate sessions archived; PR #50 → `81bc118`, PR #48 → `c1baa96` merged. 2.10 DONE @ `95a33b8`. **1.11 is BLOCKED (D-178)** — real prerequisites (doc 40 S6/S10) span 2.11, `modules/tms`/`modules/cc` (don't exist), Phase 4 billing, an admin quote-entry UI — evidence `docs/notes/2026-09-25-wbs-1.11-premature.md`. Completion 37/136. Previous governance commit: `c1baa96`. |
| Golden slice (2.9) | **ACCEPTED** · `.golden-slice-accepted` committed · `scripts/new-slice.sh` active (registers contract exports itself since `412708a`) · `.githooks/pre-commit` active (①lint/boundaries/types ②touched-module unit tests ③guards:run when database/ staged) · scope backend only, no PDA UI. R1: an all-zero order gets no GRN and no `wms.inbound.received` event. |
| Deployment tier | **Pilot Tier 0 = local Docker `postgres:16` (D-129)**; Oracle Tier 0 after the pilot (0.3, 0.5, 0.7, 0.6b DEFERRED-POST-PILOT) — procedures placeholder in `docs/RUNBOOK.md` §8 |
| Schema | `database/schema/01 · 13 · 13B · 019` — the ONLY permitted schema (migrations 0001–0025 applied (0022 lane 1 · 0023 lane 2 · 0024 lane 3 issued, in flight · 0025 Master, SCR-RLS-03 / D-181): see `docs/CHANGELOG.md` for the full list) · DB locale UTF8 / collate C / ctype C.UTF-8 · next free migration **0026** · **SCR-HR-ATT-01 APPROVED (D-131)** — migration number not yet issued |
| Session model | **D-174: lane sessions sonnet / effort medium · Master sonnet / medium for merges + bookkeeping, opus only for ADR / security / D-117 · fable only when the GM names it.** D-180: Master session = "إدارة الجلسات والوكلاء" on fable, GM's own menu choice; one session per worktree, no lane session in the shared `claude-kit` checkout · agents pinned: pg-reviewer opus, all other agents sonnet, no haiku · fast mode unavailable (SDK) |
| Toolchain | pnpm 9.15.9 · Node 25.2.1 · Docker 29.0.1 · psql 16.15 · claude CLI · TypeScript 5.9.3 ceiling `<6.1.0` · Python 3.13 (`python`, not `python3`) · `gh` per command with the Git-Credential-Manager token (D-173, `docs/RUNBOOK.md` §3) |
| Setup check | 2026-09-24: `gen-backlog.py --check` 136 rows (v4.4) · `check-setup.sh` MASTER_BACKLOG OK, PG_APP_USER unset → NOTE only · gates ①–⑥ green on main via CI |

## Lanes

| lane | task | module lock | worktree | status |
|---|---|---|---|---|
| 1 | 2.11 outbound order (ten-condition check, FEFO, pick sequence) → 2.12 | `wms/process-outbound` | `../pg-eos-lane-1` | **runnable now** — 2.10 DONE @ `95a33b8`; migration 0022 issued; scaffold + RED tests on disk |
| 2 | 2.9b schedule inbound + logistics terms (staged D-168/D-169, doc-38 lane 2) | `wms/schedule-inbound` | `../pg-eos-lane-2` | **runnable now**, concurrent with lane 1 (D-179 use-case locks); 2.13/2.14/2.15 DONE |
| 3 | 3.14 part 2 — `services/agent` pull loop — then 3.15→3.19 (D-180 item 3) | `imile` | `../pg-eos-lane-3` | own worktree (hook-enforced); part 1 done-in-part on main |

## Last 5 DONE (newest first)

| task | commit |
|---|---|
| 2.10 — put-away automatic location suggestion: conditions + ABC, golden-slice enhancement (lane 1), DONE | `95a33b8` |
| 2.15 — space management: allocations, reservations, check_space_available() guard (INV-C3-8), no migration (lane 2), DONE — 6 review rounds, round 3 escalated to opus per D-117 | `dc0515c` |
| 1.9 — Customer 360 screen (sales data + admin UI, second frontend slice) (lane 1), DONE | `90faea3` |
| 1.8 — group-level credit limit and hold; found + fixed a real RLS gap on sales.accounts (D-177) (lane 1), DONE | `7fa0c43` |
| 2.14 — daily occupancy snapshot + overflow (ST-12) billable event, no migration (lane 2), DONE | `eec1618` |

## Blockers (settle BEFORE any lane opens — reviewer's project-wide items)

- **`scripts/deploy.sh` does not exist yet**: G15–G17 NOT RUNNABLE, non-blocking until it exists (0.6b, DEFERRED-POST-PILOT).
- **Open G-01 items:** G8 anchor storage before the first partition detach (≥ 2028-03) — D-115. **3.14 part 1:** `imile.agent_health` has no `entity_id`; no DB CHECKs for two invariants — `docs/notes/2026-09-24-imile-agent-scenario.md` §4 rows e/f. **2.15:** `wms.space_reservations.qty` has no DB `CHECK (qty > 0)` (domain-only enforcement) — future G-01 candidate; `wms.convert_reservation()` intentionally not exposed as a command this slice (batched GM questions, see CHANGELOG).
- **Carried under D-131 (owner GM, post-pilot):** ADR-0003 items 1, 3, 4a, 5, 6, 8, 9; GPS classification; SoD mechanism; §2.5 values. APP-1 stays `tasks/proposed/`.
- WAITING_GM rows: **0** (D-127). Deferred post-pilot: 20 rows, Phase 7 in `tasks/MASTER_BACKLOG.md`. Stale `.git/*.lock` files removed by hand — `docs/RUNBOOK.md` "Incident quick reference".
- **Batched Master tasks (frozen paths, one Master-only window):** `entityId` on `WithContextCtx` (`packages/db`) · SCR-HR-EMP-01 three DB CHECKs · catalog events on first consumer.
- **WBS 1.11 BLOCKED (D-178):** not a lane task, not buildable today by anyone — see Current task above and `docs/notes/2026-09-25-wbs-1.11-premature.md`. Re-attempt once Phase 2 (2.11), a `tms` module, a `cc` module and Phase 4 billing each have their first slice.
- **Flagged, pre-existing, untouched:** ~7 failures in `tests/evaluate-alerts/**` and `tests/integration/{schema-invariants,audit-chain-*}.test.ts` — Master/GM attention needed. `pnpm --filter @pg-eos/hr test` transient failures under concurrent shared-Postgres access — isolated reruns 100% green. **2.15 side-note:** `count-inventory.test.ts`/`receive-inbound.test.ts` each have one assertion expecting an outdated error type where the code now throws a different, arguably more-correct one — pre-existing, untouched by 2.15.
- **D-176 open question answered by D-180 item 3, GM confirmed (D-182, Q1: أ):** lane 3 continues its own doc-38 lane-3 rows (3.15, 3.16, 3.17, 3.18, 3.19) after 3.14 part 2, rather than idling.
- **D-117 note:** lane 2 self-fixed past the two-round bound twice (2.13, 2.14); acknowledged as a judgment lapse. 2.15 (6 rounds/19 findings, a real BLOCKER in round 1) correctly escalated to opus at round 3 per D-117 — committed followed through this time. All three of 2.13/2.14/2.15 ran well past budget — SPEED AND QUALITY "split before, not after" default noted.

## Next 3 tasks (D-176 phase order + D-180 session plan)

1. Lane 1: 2.11 (outbound order) in `wms/process-outbound` — then 2.12
2. Lane 2: 2.9b (schedule inbound) in `wms/schedule-inbound`
3. Lane 3: 3.14 part 2 (`services/agent` pull loop) — then 3.15

## Notes

- main is PR-protected — commit on a branch, push, open a PR, merge on green CI. Lane PRs are opened and merged by the Master (`gh`, rebase merge); a lane branch that conflicts after another merges is rebased by the Master and re-pushed as `<branch>-rN` (D-173). Full mechanics: `docs/RUNBOOK.md`.
- Doc 38 is **v4.4 (136 rows, D-173)**. Its Lane column is the single source for lane assignment — always check `tasks/LANE_LOCKS.md` module availability before redirecting a lane (2026-09-25 near-miss: `wms` briefly double-assigned to lanes 1 and 2, caught before either wrote code).
- **D-176 (2026-09-25): finish phases in order** — supersedes the phase-jumping exceptions of D-172/D-173/D-175 for any *new* row a lane picks up; in-flight multi-part slices are finished first.
- GIT rule (GM 2026-09-23 B3): task ↔ code link is `git log` with `type(WBS):`; previous task's hash recorded here inside the next task's commit.
- GM decision sheet: `docs/notes/2026-09-23-gm-decision-sheet.md` · cleanup dispositions: `docs/notes/2026-09-24-cleanup-candidates.md` §4.
