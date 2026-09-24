# PROJECT_STATE — PG-EOS

**Hard limit: 60 lines.** Older history moves to `docs/CHANGELOG.md` (CLAUDE.md · QUOTA DISCIPLINE (v5)).
Maintained by pg-scribe only, in the same commit as the task it records.

| field | value |
|---|---|
| Phase | 0 — Foundation → 2 — Warehouse · **pilot-first (D-127, GM 2026-09-24): the pilot runs on seed 019 + synthetic data; every field/human/sign-off/training/naming item and Tier-0 provisioning is DEFERRED-POST-PILOT** |
| Current task | **2.4 DONE — location weight/volume limits enforced on put-away** (previous task 0.6a part 2 CI Chrome fix @ `d8dc887`). Completion 19/133. |
| Golden slice (2.9) | not built · `.golden-slice-accepted` absent · `scripts/new-slice.sh` is a no-op. Deps 2.4, 2.6, 2.8, 0.15 — **all now DONE**; **2.9 next**, full human review, never parallelised. **Phase-0 gate: passed on 0.8 (D-130)** — pilot backup/restore acceptance against local Docker, 8/8 green. Acceptance also wires every Phase-0 "mechanism only" deferral (GM 2026-09-22), starting with 0.17's login endpoints. |
| Deployment tier | **Pilot Tier 0 = local Docker `postgres:16` (D-129)**; Oracle Tier 0 (`docs/package/42-Oracle-Cloud-Deployment.md`) after the pilot (0.3, 0.5, 0.7, 0.6b DEFERRED-POST-PILOT) |
| Schema | `database/schema/01 · 13 · 13B · 019` — the ONLY permitted schema (01 v1.1, 13B v4.4, migrations 0001–0007) · DB locale UTF8 / collate C / ctype C.UTF-8 · `apply.sh --recreate` green 2026-09-24 (0.6a part 1): 175 tables/14 schemas, `wms.verify_wh1()` 21/21, G1–G13 = 0, G13 100/100, G18/G-SEED = 0, `test:isolation` 55/55 · **SCR-HR-ATT-01 APPROVED (D-131)** — migration number not yet issued; pg-reviewer pre-migration review before any DDL |
| Session model | fable (`claude-fable-5-1`, set by the GM via /model 2026-09-23 evening; earlier opus) · workers sonnet, reviews/ADR/security opus, pg-scribe sonnet, no haiku (GM 2026-09-23) |
| Toolchain | pnpm 9.15.9 · Node 25.2.1 · Docker 29.0.1 · psql 16.15 · claude CLI · migrations auto-runner (WBS 0.11) · psql UTF-8 fix (WBS 0.15, see `apply.sh` header) · TypeScript 5.9.3 ceiling `<6.1.0` · Python 3.13 (`python`, not `python3`, on this machine) |
| Setup check | 2026-09-24: `bash scripts/check-setup.sh` → READY (133 rows) · `python scripts/gen-briefs.py --check` 15 briefs ok · `python scripts/gen-backlog.py` 133 rows written; `--check` to rerun locally (see CHANGELOG) · `.githooks/commit-msg` accepts `0.6a`/`0.6b` · lint / typecheck / 330 tests / G1–G14+G18 green 2026-09-23 |

## Lanes

None claimed.

## Last 5 DONE (newest first)

| task | commit |
|---|---|
| 2.4 — location weight/volume limits enforced on put-away | `<this commit>` |
| 0.6a part 2/2 — CI gates ①–⑥ on GitHub Actions, tests as pgeos_app | `a554810` |
| 0.6a part 2 fix — CI installs Chrome for Puppeteer, `--continue` | `d8dc887` |
| 0.6a part 1/2 — pgeos_app role + entity_scope USING/WITH CHECK (migration 0007, D-133) | `1f19c92` |
| 2.3 — generate 3,330 WH1 location codes (verification-only) | `f3426eb` |

## Blockers

- **Open G-01 item:** G8 anchor storage before the first partition detach (≥ 2028-03) — D-115: `platform.settings` key design.
- **Carried under D-131 (owner GM, post-pilot):** ADR-0003 items 1 (shared PDA — PDA path blocked), 3, 4a, 5 (punch-record retention; doc 40:668, doc 25:429 unchanged), 6, 8, 9; GPS classification; SoD mechanism; §2.5 values. APP-1 has no WBS ID (D-127 no naming) — stays `tasks/proposed/`.
- **Not applied under D-132:** G3 diagram `01-08` regeneration (mermaid renderer not installed); G1/G2 (no retention value).
- (0.18 carried forward) resolved: RLS in 0007, tests/CI as `pgeos_app` in part 2.
- **D6 follow-up (0.6a part 2):** production partition maintenance must take the audit-chain advisory lock before partition DDL (same 40P01 lock-ordering risk hit locally by `turbo test` parallel runs, `modules/platform audit-chain-seq.test.ts` vs. another package's audit write) — no new WBS ID, tracked here.
- WAITING_GM rows: **0** (D-127). Deferred post-pilot: 20 rows, listed under Phase 7 in `tasks/MASTER_BACKLOG.md`.
- Concurrent external processes can delete uncommitted work (incident `a901a04`) · sessions start inside `claude-kit/` · stale `.git/*.lock` files are removed by hand.

## Next 3 tasks

1. **2.9** golden slice "Receive inbound order" (deps 2.4, 2.6, 2.8, 0.15 all DONE, full human review) — never parallelised
2. **0.6a close** — GM ruleset decision on `main` (first green CI run already recorded @ `d8dc887`)
3. Up to three lanes per doc 38 `Lane` column, after `.golden-slice-accepted`

## Notes

- Doc 38 is v4.2 (133 rows). `tasks/MASTER_BACKLOG.md` regenerated; Staged rows 2.20 / 5.18 / 6.2b / SC-01 unchanged (TODO, `tasks/backlog/`).
- D-104 superseded by D-129 + D-130 (D-132 G13); D-113 superseded by D-133; D-115's "2.2 within 7 days" superseded by D-128 for the pilot.
- 0.9 closed at `aa46787` with two unmerged WIP branches (`0217e85`, `f127ab2`) — `docs/notes/0.9-abandoned-wip.md`; never merge, never delete.
- Phase-0 policy (GM 2026-09-22): mechanism-only tasks; deferred parts tracked here and in `MASTER_BACKLOG.md`.
- GIT rule (GM 2026-09-23 B3): task ↔ code link is `git log` with `type(WBS):`; previous task's hash recorded here inside the next task's commit. Push policy D-120.
- GM decision sheet: `docs/notes/2026-09-23-gm-decision-sheet.md` · cleanup dispositions: `docs/notes/2026-09-24-cleanup-candidates.md` §4.
- **0.6a close blocked (D-142):** GitHub plan cannot enforce branch protection on a private repo (rulesets and classic protection both need Team/Pro); GM to choose (a) Pro upgrade, (b) public repo, (c) process-only PR rule.
