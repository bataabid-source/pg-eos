# PROJECT_STATE — PG-EOS

**Hard limit: 60 lines.** Older history moves to `docs/CHANGELOG.md` (CLAUDE.md · QUOTA DISCIPLINE (v5)).
Maintained by pg-scribe only, in the same commit as the task it records.

| field | value |
|---|---|
| Phase | 0 — Foundation → 2 — Warehouse · **pilot-first (D-127, GM 2026-09-24): the pilot runs on seed 019 + synthetic data; every field/human/sign-off/training/naming item and Tier-0 provisioning is DEFERRED-POST-PILOT** |
| Current task | **0.6a DONE — CI gates ①–⑥ closed, branch protection active** (D-166). Previous task: 2.9 golden slice ACCEPTED @ `78c640e` (D-161/D-162). Completion 21/134. |
| Golden slice (2.9) | **ACCEPTED** · `.golden-slice-accepted` committed · `scripts/new-slice.sh` active (trial on throw-away worktree, `tms assign-route`, 18 REPLACE-ON-COPY markers) · `.githooks/pre-commit` active (①lint/boundaries/types ②touched-module unit tests ③guards:run when database/ staged; no gate on docs-only commits) · scope backend only, no PDA UI (GM choice). R1: an all-zero order gets no GRN and no `wms.inbound.received` event. |
| Deployment tier | **Pilot Tier 0 = local Docker `postgres:16` (D-129)**; Oracle Tier 0 (`docs/package/42-Oracle-Cloud-Deployment.md`) after the pilot (0.3, 0.5, 0.7, 0.6b DEFERRED-POST-PILOT) |
| Schema | `database/schema/01 · 13 · 13B · 019` — the ONLY permitted schema (01 v1.1, 13B v4.4, migrations 0001–0010: 0008 inbound-orders version/G6, 0009 next_doc_no SECURITY DEFINER, 0010 idempotency-keys + variance-photo columns, all task 2.9) · DB locale UTF8 / collate C / ctype C.UTF-8 · fresh `apply.sh --recreate` as `pgeos_app` 2026-09-24 (2.9 part 2): `turbo` 16/16 (wms 261/261, db 24/24, logger 3/3, platform 27/27), `test:isolation` 55/55, G1–G14/G18/G-SEED green, lint/typecheck 18/18/boundaries green · **SCR-HR-ATT-01 APPROVED (D-131)** — migration number not yet issued |
| Session model | fable (`claude-fable-5-1`, set by the GM via /model 2026-09-23 evening; earlier opus) · workers sonnet, reviews/ADR/security opus, pg-scribe sonnet, no haiku (GM 2026-09-23) |
| Toolchain | pnpm 9.15.9 · Node 25.2.1 · Docker 29.0.1 · psql 16.15 · claude CLI · migrations auto-runner (WBS 0.11) · psql UTF-8 fix (WBS 0.15, see `apply.sh` header) · TypeScript 5.9.3 ceiling `<6.1.0` · Python 3.13 (`python`, not `python3`, on this machine) |
| Setup check | 2026-09-24: `bash scripts/check-setup.sh` → READY (133 rows) · `python scripts/gen-briefs.py --check` 15 briefs ok · `python scripts/gen-backlog.py` 133 rows written; `--check` to rerun locally (see CHANGELOG) · `.githooks/commit-msg` accepts `0.6a`/`0.6b` · lint / typecheck / 330 tests / G1–G14+G18 green 2026-09-23 |

## Lanes

None claimed.

## Last 5 DONE (newest first)

| task | commit |
|---|---|
| 0.6a — CI gates ①–⑥ CLOSED, branch protection active (D-166), DONE | `<this commit>` |
| 2.9 — golden slice ACCEPTED (R1 applied; new-slice.sh + pre-commit active), DONE | `78c640e` |
| 2.9 part 2 — GM sheet-3 answers applied (idempotency store, cancel/close rules, variance photo, shared logger), NOT DONE | `efd52f4` (+ fix `811a159`) |
| 2.9 — golden slice "Receive inbound order" (backend), built + reviewed, NOT DONE | `83f984c` |
| 2.4 — location weight/volume limits enforced on put-away | `4aaecdf` |

## Blockers (settle BEFORE any lane opens — reviewer's project-wide items)

- (a) G15–G17 are not run by `guards-run.sh`.
- (b) `scripts/new-slice.sh` `LANGS` lacks `am` (SCR-I18N-01).
- (c) No package scaffold exists for a module with no golden counterpart (only `identity`, `platform`, `sales`, `wms` exist under `modules/`) — the scaffold rule must be recorded before the first lane slice in a new module.
- **Open G-01 item:** G8 anchor storage before the first partition detach (≥ 2028-03) — D-115: `platform.settings` key design.
- **Carried under D-131 (owner GM, post-pilot):** ADR-0003 items 1 (shared PDA — PDA path blocked), 3, 4a, 5 (punch-record retention; doc 40:668, doc 25:429 unchanged), 6, 8, 9; GPS classification; SoD mechanism; §2.5 values. APP-1 has no WBS ID (D-127 no naming) — stays `tasks/proposed/`.
- **Not applied under D-132:** G3 diagram `01-08` regeneration (mermaid renderer not installed); G1/G2 (no retention value).
- **D6 follow-up (0.6a part 2):** production partition maintenance must take the audit-chain advisory lock before partition DDL — no new WBS ID, tracked here.
- WAITING_GM rows: **0** (D-127). Deferred post-pilot: 20 rows, listed under Phase 7 in `tasks/MASTER_BACKLOG.md`.
- Concurrent external processes can delete uncommitted work (incident `a901a04`) · sessions start inside `claude-kit/` · stale `.git/*.lock` files are removed by hand.

## Next 3 tasks

1. Settle blockers (a) G15–G17 not run by `guards-run.sh`, (b) `new-slice.sh` `LANGS` lacks `am`, (c) new-module scaffold rule
2. Open lanes per GM sheet 5 Q18 = أ (D-165): lane 1: 1.2 → 3.1 · lane 2: 3.3 → D-144 shifts/sites/devices (5.3b after 5.3) · lane 3: 5.13 → 3.14 after the GM's iMile portal check
3. Proceed with lane work per doc 38 `Lane` column

## Notes

- main is PR-protected — commit on a branch, push, open a PR, merge on green CI.
- Doc 38 is v4.3 (134 rows, 5.3b added — D-165). `tasks/MASTER_BACKLOG.md` regenerated; Staged rows 2.20 / 5.18 / 6.2b / SC-01 unchanged (TODO, `tasks/backlog/`).
- D-104 superseded by D-129 + D-130 (D-132 G13); D-113 superseded by D-133; D-115's "2.2 within 7 days" superseded by D-128 for the pilot.
- 0.9 closed at `aa46787` with two unmerged WIP branches (`0217e85`, `f127ab2`) — `docs/notes/0.9-abandoned-wip.md`; never merge, never delete.
- Phase-0 policy (GM 2026-09-22): mechanism-only tasks; deferred parts tracked here and in `MASTER_BACKLOG.md`.
- GIT rule (GM 2026-09-23 B3): task ↔ code link is `git log` with `type(WBS):`; previous task's hash recorded here inside the next task's commit. Push policy D-120.
- GM decision sheet: `docs/notes/2026-09-23-gm-decision-sheet.md` · cleanup dispositions: `docs/notes/2026-09-24-cleanup-candidates.md` §4.
