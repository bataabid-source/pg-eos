# PROJECT_STATE — PG-EOS

**Hard limit: 60 lines.** Older history moves to `docs/CHANGELOG.md` (CLAUDE.md · QUOTA DISCIPLINE (v5)).
Maintained by pg-scribe only, in the same commit as the task it records.

| field | value |
|---|---|
| Phase | 0 — Foundation → 2 — Warehouse · **pilot-first (D-127, GM 2026-09-24): the pilot runs on seed 019 + synthetic data; every field/human/sign-off/training/naming item and Tier-0 provisioning is DEFERRED-POST-PILOT** |
| Current task | **5.13 part 1 committed @ `<this commit>` — NOT DONE** (alert evaluation mechanism: `EvaluateAlertRules` + `AcknowledgeAlert`, migrations 0011/0012; part 2 = delivery/escalation/dynamic recipients/reports/job, next on lane 3 after 5.18). Previous task: 0.6a DONE @ `991ee6b`. Completion 21/133. |
| Golden slice (2.9) | **ACCEPTED** · `.golden-slice-accepted` committed · `scripts/new-slice.sh` active (trial on throw-away worktree, `tms assign-route`, 18 REPLACE-ON-COPY markers) · `.githooks/pre-commit` active (①lint/boundaries/types ②touched-module unit tests ③guards:run when database/ staged; no gate on docs-only commits) · scope backend only, no PDA UI (GM choice). R1: an all-zero order gets no GRN and no `wms.inbound.received` event. |
| Deployment tier | **Pilot Tier 0 = local Docker `postgres:16` (D-129)**; Oracle Tier 0 (`docs/package/42-Oracle-Cloud-Deployment.md`) after the pilot (0.3, 0.5, 0.7, 0.6b DEFERRED-POST-PILOT) |
| Schema | `database/schema/01 · 13 · 13B · 019` — the ONLY permitted schema (01 v1.1, 13B v4.4, migrations 0001–0012: 0008 inbound-orders version/G6, 0009 next_doc_no SECURITY DEFINER, 0010 idempotency-keys + variance-photo columns (task 2.9), 0011 `alert_log.version` + N-16 deactivated, 0012 `wms.space_dashboard` security_invoker grant (task 5.13 part 1)) · DB locale UTF8 / collate C / ctype C.UTF-8 · fresh `apply.sh --recreate` clean with 0001–0012 (5.13 part 1): modules/platform `npx vitest run` 85/85, guards G1–G14/G18/G-SEED green · **SCR-HR-ATT-01 APPROVED (D-131)** — migration number not yet issued |
| Session model | fable (`claude-fable-5-1`, set by the GM via /model 2026-09-23 evening; earlier opus) · workers sonnet, reviews/ADR/security opus, pg-scribe sonnet, no haiku (GM 2026-09-23) |
| Toolchain | pnpm 9.15.9 · Node 25.2.1 · Docker 29.0.1 · psql 16.15 · claude CLI · migrations auto-runner (WBS 0.11) · psql UTF-8 fix (WBS 0.15, see `apply.sh` header) · TypeScript 5.9.3 ceiling `<6.1.0` · Python 3.13 (`python`, not `python3`, on this machine) |
| Setup check | 2026-09-24: `bash scripts/check-setup.sh` → READY (133 rows) · `python scripts/gen-briefs.py --check` 15 briefs ok · `python scripts/gen-backlog.py` 133 rows written; `--check` to rerun locally (see CHANGELOG) · `.githooks/commit-msg` accepts `0.6a`/`0.6b` · lint / typecheck / 330 tests / G1–G14+G18 green 2026-09-23 |

## Lanes

| lane | task | module lock | worktree | status |
|---|---|---|---|---|
| 1 | 1.2 catalog (M03) | `catalog` | `../pg-eos-lane-1` | opening 2026-09-24 (D-167 Q18) |
| 2 | 3.3 drivers hard gate | `hr` | `../pg-eos-lane-2` | queued — next session |
| 3 | 5.18 focus boards (M) | `platform` | shared `claude-kit` | queued — next session; then 5.13 part 2, then 3.14 after the GM's iMile portal check (D-172) |

## Last 5 DONE (newest first)

| task | commit |
|---|---|
| 5.13 part 1 — alert evaluation mechanism (`EvaluateAlertRules` + `AcknowledgeAlert`, migrations 0011/0012), NOT DONE | `<this commit>` |
| 0.6a — CI gates ①–⑥ CLOSED, branch protection active (D-165), DONE | `991ee6b` |
| 2.9 — golden slice ACCEPTED (R1 applied; new-slice.sh + pre-commit active), DONE | `78c640e` |
| 2.9 part 2 — GM sheet-3 answers applied (idempotency store, cancel/close rules, variance photo, shared logger), NOT DONE | `efd52f4` (+ fix `811a159`) |
| 2.9 — golden slice "Receive inbound order" (backend), built + reviewed, NOT DONE | `83f984c` |

## Blockers (settle BEFORE any lane opens — reviewer's project-wide items)

- ~~(a)(b)(c) G15–G17 not run by `guards-run.sh` · `new-slice.sh` `LANGS` lacks `am` · no package scaffold for a module with no golden counterpart.~~ **Resolved 2026-09-24 (D-170):** runners executed when present (NOT RUNNABLE otherwise, blocking under `PG_GUARDS_STRICT=1`); `am` added; `new-slice.sh` scaffolds `modules/<module>` from the golden shell before copying the layers.
- **`scripts/deploy.sh` does not exist yet** (CLAUDE.md names it): G15–G17 are NOT RUNNABLE and non-blocking at merge until it exists and exports `PG_GUARDS_STRICT=1` before `pnpm guards:run` (0.6b / deploy slice). Recorded 2026-09-24.
- **Open G-01 item:** G8 anchor storage before the first partition detach (≥ 2028-03) — D-115: `platform.settings` key design.
- **Carried under D-131 (owner GM, post-pilot):** ADR-0003 items 1 (shared PDA — PDA path blocked), 3, 4a, 5 (punch-record retention; doc 40:668, doc 25:429 unchanged), 6, 8, 9; GPS classification; SoD mechanism; §2.5 values. APP-1 has no WBS ID (D-127 no naming) — stays `tasks/proposed/`.
- **Not applied under D-132:** G3 diagram `01-08` regeneration (mermaid renderer not installed); G1/G2 (no retention value).
- **D6 follow-up (0.6a part 2):** production partition maintenance must take the audit-chain advisory lock before partition DDL — no new WBS ID, tracked here.
- WAITING_GM rows: **0** (D-127). Deferred post-pilot: 20 rows, listed under Phase 7 in `tasks/MASTER_BACKLOG.md`.
- Concurrent external processes can delete uncommitted work (incident `a901a04`) · sessions start inside `claude-kit/` · stale `.git/*.lock` files are removed by hand.

## Next 3 tasks (D-172)

1. Lane 1: 1.2 catalog (running in `../pg-eos-lane-1`), then 0.19 admin shell
2. Lane 2: 3.3 drivers hard gate (migration 0014 issued, MIGRATION-REQUEST-2)
3. Lane 3: 5.18 focus boards, then 5.13 part 2 (delivery/escalation/dynamic recipients/reports/job), then 3.14 after the GM's iMile portal check

## Notes

- main is PR-protected — commit on a branch, push, open a PR, merge on green CI.
- Doc 38 is v4.2 (133 rows). `tasks/MASTER_BACKLOG.md` regenerated; Staged rows 2.20 / 5.18 / 6.2b / SC-01 unchanged (TODO, `tasks/backlog/`).
- D-104 superseded by D-129 + D-130 (D-132 G13); D-113 superseded by D-133; D-115's "2.2 within 7 days" superseded by D-128 for the pilot.
- 0.9 closed at `aa46787` with two unmerged WIP branches (`0217e85`, `f127ab2`) — `docs/notes/0.9-abandoned-wip.md`; never merge, never delete.
- Phase-0 policy (GM 2026-09-22): mechanism-only tasks; deferred parts tracked here and in `MASTER_BACKLOG.md`.
- GIT rule (GM 2026-09-23 B3): task ↔ code link is `git log` with `type(WBS):`; previous task's hash recorded here inside the next task's commit. Push policy D-120.
- GM decision sheet: `docs/notes/2026-09-23-gm-decision-sheet.md` · cleanup dispositions: `docs/notes/2026-09-24-cleanup-candidates.md` §4.
