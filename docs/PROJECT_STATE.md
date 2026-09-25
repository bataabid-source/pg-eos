# PROJECT_STATE — PG-EOS

**Hard limit: 60 lines.** Older history moves to `docs/CHANGELOG.md` (CLAUDE.md · QUOTA DISCIPLINE (v5)).
Maintained by pg-scribe only, in the same commit as the task it records.

| field | value |
|---|---|
| Phase | **0 — Foundation CLOSED (0.20 sealed, D-176)** → 1 — Commercial Core (buildable rows done except 1.11, Master-only) → 2 — Warehouse (in progress, 8/19) · **pilot-first (D-127): seed 019 + synthetic data; field/human/sign-off/training/Tier-0 provisioning DEFERRED-POST-PILOT** |
| Current task | **D-176 (2026-09-25): finish phases in order.** Phase 1 lane-1 rows (1.4/1.6/1.7/1.8/1.9) all DONE @ `90faea3`. **1.11 is BLOCKED (D-178)** — investigated on GM instruction, not fabricated: its real prerequisites (doc 40 S6/S10) span 2.11 (Phase 2, in progress), `modules/tms` + `modules/cc` (don't exist), `billing.*`/a nightly job (Phase 4, not started), an admin quote-entry UI — evidence `docs/notes/2026-09-25-wbs-1.11-premature.md`. Phase 1's buildable rows are therefore exhausted for now. Phase 2: 2.13/2.14 DONE (lane 2), 2.15 built + committed (lane 2, `1ed8b41`, awaiting merge). **D-179 (2026-09-25, GM "نفذ التوصيات كاملة"): pace mechanisms landed @ `<this commit>`** — use-case locks (lane 1 builds 2.10 in `wms/put-away` NOW, concurrent with lane 2), lane worktree enforced by hook, `brief-check.sh` + `check-locks.sh` in pre-commit/CI, RED-before-migration in `lane-guard.sh`, `docs(X)` needs a directive trailer, `tests/hooks/run.sh` (48 cases) in gate ①. Measured finding: every brief since 1.2 was over the 12-file/1,500-line budget (1.8: 47 files / 5,094 lines) — forward-only enforcement from this commit. Completion 35/136. Previous governance commit: `eaa3394`. |
| Golden slice (2.9) | **ACCEPTED** · `.golden-slice-accepted` committed · `scripts/new-slice.sh` active (registers contract exports itself since `412708a`) · `.githooks/pre-commit` active (①lint/boundaries/types ②touched-module unit tests ③guards:run when database/ staged) · scope backend only, no PDA UI. R1: an all-zero order gets no GRN and no `wms.inbound.received` event. |
| Deployment tier | **Pilot Tier 0 = local Docker `postgres:16` (D-129)**; Oracle Tier 0 after the pilot (0.3, 0.5, 0.7, 0.6b DEFERRED-POST-PILOT) — procedures placeholder in `docs/RUNBOOK.md` §8 |
| Schema | `database/schema/01 · 13 · 13B · 019` — the ONLY permitted schema (migrations 0001–0021 applied: see `docs/CHANGELOG.md` for the full list) · DB locale UTF8 / collate C / ctype C.UTF-8 · next free migration **0022** · **SCR-HR-ATT-01 APPROVED (D-131)** — migration number not yet issued |
| Session model | **D-174: lane sessions sonnet / effort medium · Master sonnet / medium for merges + bookkeeping, opus only for ADR / security / D-117 · fable only when the GM names it** · agents pinned: pg-reviewer opus, all other agents sonnet, no haiku · fast mode unavailable (SDK) |
| Toolchain | pnpm 9.15.9 · Node 25.2.1 · Docker 29.0.1 · psql 16.15 · claude CLI · TypeScript 5.9.3 ceiling `<6.1.0` · Python 3.13 (`python`, not `python3`) · `gh` per command with the Git-Credential-Manager token (D-173, `docs/RUNBOOK.md` §3) |
| Setup check | 2026-09-24: `gen-backlog.py --check` 136 rows (v4.4) · `check-setup.sh` MASTER_BACKLOG OK, PG_APP_USER unset → NOTE only · gates ①–⑥ green on main via CI |

## Lanes

| lane | task | module lock | worktree | status |
|---|---|---|---|---|
| 1 | Phase 2: 2.10 (put-away) → 2.11 (outbound order, as `wms/outbound-order`) | `wms/put-away` | `../pg-eos-lane-1` | **runnable now** (D-179 use-case lock) — start the lane-1 session, `/lane 1` |
| 2 | Phase 2: 2.13 DONE, 2.14 DONE, 2.15 built + committed `1ed8b41` (`lane/2-2.15`) | `wms/manage-space` | `../pg-eos-lane-2` | awaiting Master PR/merge; lock released on merge |
| 3 | 3.14 part 2 — `services/agent` pull loop (in flight) — then **idle pending GM answer to D-176's batched question** | `imile` | `../pg-eos-lane-3` | next lane-3 session runs in its own worktree (branch `lane/3`, hook-enforced); part 1 NOT DONE @ `8b12d60` |

## Last 5 DONE (newest first)

| task | commit |
|---|---|
| 1.9 — Customer 360 screen (sales data + admin UI, second frontend slice) (lane 1), DONE | `90faea3` |
| 1.8 — group-level credit limit and hold; found + fixed a real RLS gap on sales.accounts (D-177) (lane 1), DONE | `7fa0c43` |
| 2.14 — daily occupancy snapshot + overflow (ST-12) billable event, no migration (lane 2), DONE — Phase 2 for lane 2's original list complete | `eec1618` |
| 1.7 — M02 contracts, price annexes, SLA definitions, billing flags (lane 1), DONE | `e3ced50` |
| 2.13 — inventory count: blind, recount mandatory, adjustment by approval (INV-C3-7), migration 0018 (lane 2), DONE | `ca9a109` |

## Blockers (settle BEFORE any lane opens — reviewer's project-wide items)

- **`scripts/deploy.sh` does not exist yet**: G15–G17 NOT RUNNABLE, non-blocking until it exists (0.6b, DEFERRED-POST-PILOT).
- **Open G-01 items:** G8 anchor storage before the first partition detach (≥ 2028-03) — D-115. **3.14 part 1:** `imile.agent_health` has no `entity_id`; no DB CHECKs for two invariants — `docs/notes/2026-09-24-imile-agent-scenario.md` §4 rows e/f.
- **Carried under D-131 (owner GM, post-pilot):** ADR-0003 items 1, 3, 4a, 5, 6, 8, 9; GPS classification; SoD mechanism; §2.5 values. APP-1 stays `tasks/proposed/`.
- WAITING_GM rows: **0** (D-127). Deferred post-pilot: 20 rows, Phase 7 in `tasks/MASTER_BACKLOG.md`. Stale `.git/*.lock` files removed by hand — `docs/RUNBOOK.md` "Incident quick reference".
- **Batched Master tasks (frozen paths, one Master-only window):** `entityId` on `WithContextCtx` (`packages/db`) · SCR-HR-EMP-01 three DB CHECKs · catalog events on first consumer.
- **WBS 1.11 BLOCKED (D-178):** not a lane task, not buildable today by anyone — see Current task above and `docs/notes/2026-09-25-wbs-1.11-premature.md`. Re-attempt once Phase 2 (2.11), a `tms` module, a `cc` module and Phase 4 billing each have their first slice.
- **Flagged, pre-existing, untouched:** ~7 failures in `tests/evaluate-alerts/**` and `tests/integration/{schema-invariants,audit-chain-*}.test.ts` — Master/GM attention needed. `pnpm --filter @pg-eos/hr test` transient failures under concurrent shared-Postgres access — isolated reruns 100% green.
- **D-176 open question (non-blocking):** lane 3 idles after 3.14 part 2 — accept, or let it take a later-phase row?
- **D-117 note:** lane 2 self-fixed past the two-round bound twice (2.13, 2.14); acknowledged as a judgment lapse, not a mechanics problem — committed to escalating strictly going forward.

## Next 3 tasks (D-176 — phase-sequential)

1. Lane 1: 2.10 (put-away) in `wms/put-away` — concurrent with lane 2 — then 2.11 as `wms/outbound-order`
2. Master: open + merge lane 2's `lane/2-2.15` PR (2.15) — release `wms/manage-space`
3. Lane 3: finish 3.14 part 2 in `../pg-eos-lane-3` — then idle pending the GM's D-176 answer

## Notes

- main is PR-protected — commit on a branch, push, open a PR, merge on green CI. Lane PRs are opened and merged by the Master (`gh`, rebase merge); a lane branch that conflicts after another merges is rebased by the Master and re-pushed as `<branch>-rN` (D-173). Full mechanics: `docs/RUNBOOK.md`.
- Doc 38 is **v4.4 (136 rows, D-173)**. Its Lane column is the single source for lane assignment — always check `tasks/LANE_LOCKS.md` module availability before redirecting a lane (2026-09-25 near-miss: `wms` briefly double-assigned to lanes 1 and 2, caught before either wrote code).
- **D-176 (2026-09-25): finish phases in order** — supersedes the phase-jumping exceptions of D-172/D-173/D-175 for any *new* row a lane picks up; in-flight multi-part slices are finished first.
- 0.9 closed at `aa46787` with two unmerged WIP branches (`0217e85`, `f127ab2`) — `docs/notes/0.9-abandoned-wip.md`; never merge, never delete.
- GIT rule (GM 2026-09-23 B3): task ↔ code link is `git log` with `type(WBS):`; previous task's hash recorded here inside the next task's commit.
- GM decision sheet: `docs/notes/2026-09-23-gm-decision-sheet.md` · cleanup dispositions: `docs/notes/2026-09-24-cleanup-candidates.md` §4.
