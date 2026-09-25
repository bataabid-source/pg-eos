# PROJECT_STATE — PG-EOS

**Hard limit: 60 lines.** Older history moves to `docs/CHANGELOG.md` (CLAUDE.md · QUOTA DISCIPLINE (v5)).
Maintained by pg-scribe only, in the same commit as the task it records.

| field | value |
|---|---|
| Phase | **0 — Foundation CLOSED (0.20 sealed, D-176)** → 1 — Commercial Core (next, phase-sequential per D-176) → 2 — Warehouse (in progress, 6/19) · **pilot-first (D-127): seed 019 + synthetic data; field/human/sign-off/training/Tier-0 provisioning DEFERRED-POST-PILOT** |
| Current task | **D-176 (2026-09-25): finish phases in order.** Phase 0 CLOSED @ `<this commit>` (WBS 0.20, `docs/RUNBOOK.md`). Next: lane 1 → Phase 1 in order (1.4→1.6→1.7→1.8→1.9→1.11) · lane 2 finishes 5.5a part 2 in flight, then Phase 2 (2.13, 2.14) · lane 3 finishes 3.14 part 2 in flight, then **idles pending GM answer** (no ready Phase-1/2 row owned by lane 3). Completion 24/136. Previous governance commit: `80e827f` (PR #24). |
| Golden slice (2.9) | **ACCEPTED** · `.golden-slice-accepted` committed · `scripts/new-slice.sh` active (registers contract exports itself since `412708a`) · `.githooks/pre-commit` active (①lint/boundaries/types ②touched-module unit tests ③guards:run when database/ staged) · scope backend only, no PDA UI. R1: an all-zero order gets no GRN and no `wms.inbound.received` event. |
| Deployment tier | **Pilot Tier 0 = local Docker `postgres:16` (D-129)**; Oracle Tier 0 after the pilot (0.3, 0.5, 0.7, 0.6b DEFERRED-POST-PILOT) — procedures placeholder in `docs/RUNBOOK.md` §8 |
| Schema | `database/schema/01 · 13 · 13B · 019` — the ONLY permitted schema (migrations 0001–0015: see `docs/CHANGELOG.md` for the full list) · DB locale UTF8 / collate C / ctype C.UTF-8 · next free migration **0016** · **SCR-HR-ATT-01 APPROVED (D-131)** — migration number not yet issued |
| Session model | **D-174: lane sessions sonnet / effort medium · Master sonnet / medium for merges + bookkeeping, opus only for ADR / security / D-117 · fable only when the GM names it** · agents pinned: pg-reviewer opus, all other agents sonnet, no haiku · fast mode unavailable (SDK) |
| Toolchain | pnpm 9.15.9 · Node 25.2.1 · Docker 29.0.1 · psql 16.15 · claude CLI · TypeScript 5.9.3 ceiling `<6.1.0` · Python 3.13 (`python`, not `python3`) · `gh` per command with the Git-Credential-Manager token (D-173, `docs/RUNBOOK.md` §3) |
| Setup check | 2026-09-24: `gen-backlog.py --check` 136 rows (v4.4) · `check-setup.sh` MASTER_BACKLOG OK, PG_APP_USER unset → NOTE only · gates ①–⑥ green on main via CI |

## Lanes

| lane | task | module lock | worktree | status |
|---|---|---|---|---|
| 1 | Phase 1, in order: 1.4 pricing engine → 1.6 → 1.7 → 1.8 → 1.9 → 1.11 (D-176) | `sales` (to claim) | `../pg-eos-lane-1` | queued — next lane-1 session; 0.19 DONE @ `80e827f` |
| 2 | 5.5a part 2: `hr.shifts` / `shift_assignments` / `shift_groups` (in flight) — then Phase 2: 2.13, 2.14 (D-176) | `hr` | `../pg-eos-lane-2` | queued — next lane-2 session; part 1 (`platform.sites`) DONE @ `3679b70`; next free migration **0016** |
| 3 | 3.14 part 2 — `services/agent` pull loop (in flight) — then **idle pending GM answer to D-176's batched question** | `imile` | shared `claude-kit` | queued — next lane-3 session; part 1 (health reporting) committed NOT DONE @ `8b12d60`, pg-reviewer PASS round 4 |

## Last 5 DONE (newest first)

| task | commit |
|---|---|
| 0.20 — Runbook v1 (`docs/RUNBOOK.md`, eight procedures), closes Phase 0 (D-176) | `<this commit>` |
| 0.19 — admin app shell: nav, Decision Inbox, empty-state, design system (lane 1, first frontend slice), DONE | `80e827f` |
| 3.14 part 1 — iMile health reporting mechanism (`ReportAgentHealth`), NOT DONE | `8b12d60` |
| 5.5a part 1 — `platform.sites` (SCR-HR-SHIFT-01 §2.4), migration 0015, DONE (part 2 pending) | `3679b70` |
| 3.3 — hr.employees (drivers), documents, hard gate (lane 2, first replicated slice) — DONE | `9616422` |

## Blockers (settle BEFORE any lane opens — reviewer's project-wide items)

- **`scripts/deploy.sh` does not exist yet**: G15–G17 are NOT RUNNABLE and non-blocking at merge until it exists (0.6b / deploy slice, DEFERRED-POST-PILOT).
- **Open G-01 items:** G8 anchor storage before the first partition detach (≥ 2028-03) — D-115. **3.14 part 1:** `imile.agent_health` has no `entity_id` (event not on the outbox yet); no DB CHECKs for two invariants (app-layer only) — `docs/notes/2026-09-24-imile-agent-scenario.md` §4 rows e/f.
- **Carried under D-131 (owner GM, post-pilot):** ADR-0003 items 1, 3, 4a, 5, 6, 8, 9; GPS classification; SoD mechanism; §2.5 values. APP-1 stays `tasks/proposed/`.
- WAITING_GM rows: **0** (D-127). Deferred post-pilot: 20 rows, listed under Phase 7 in `tasks/MASTER_BACKLOG.md`.
- Concurrent external processes can delete uncommitted work (incident `a901a04`) · sessions start inside `claude-kit/` · stale `.git/*.lock` files removed by hand — see `docs/RUNBOOK.md` "Incident quick reference".
- **Batched Master tasks (frozen paths, one Master-only window):** `entityId` on `WithContextCtx` (`packages/db`) · SCR-HR-EMP-01 three DB CHECKs (pre-migration review first) · catalog events into `packages/events/catalog.ts` when 1.4/1.6 consume them.
- **Flagged by lane 2, pre-existing, untouched:** ~7 failures in `tests/evaluate-alerts/**` and `tests/integration/{schema-invariants,audit-chain-*}.test.ts` — audit-chain ones need Master/GM attention.
- **D-176 open question (non-blocking):** lane 3 idles after finishing 3.14 part 2 — accept, or let it take a Phase-3/5/6 row out of strict order?

## Next 3 tasks (D-176 — phase-sequential)

1. Lane 1: Phase 1 in order, starting 1.4 (pricing engine: exception → contract → segment → list → pending)
2. Lane 2: finish 5.5a part 2 (in flight) — then 2.13 (inventory count) and 2.14 (occupancy snapshot), Phase 2
3. Lane 3: finish 3.14 part 2 (in flight) — then idle pending the GM's D-176 answer

## Notes

- main is PR-protected — commit on a branch, push, open a PR, merge on green CI. Lane PRs are opened and merged by the Master (`gh`, rebase merge); a lane branch that conflicts after another merges is rebased by the Master and re-pushed as `<branch>-rN` (D-173). Full mechanics: `docs/RUNBOOK.md`.
- Doc 38 is **v4.4 (136 rows, D-173)**. Staged rows 2.20 / 2.9b / 6.2b / SC-01 unchanged (TODO, `tasks/backlog/`).
- **D-176 (2026-09-25): finish phases in order** — supersedes the phase-jumping exceptions of D-172/D-173/D-175 for any *new* row a lane picks up; in-flight multi-part slices are finished first.
- 0.9 closed at `aa46787` with two unmerged WIP branches (`0217e85`, `f127ab2`) — `docs/notes/0.9-abandoned-wip.md`; never merge, never delete.
- GIT rule (GM 2026-09-23 B3): task ↔ code link is `git log` with `type(WBS):`; previous task's hash recorded here inside the next task's commit.
- GM decision sheet: `docs/notes/2026-09-23-gm-decision-sheet.md` · cleanup dispositions: `docs/notes/2026-09-24-cleanup-candidates.md` §4.
