# PROJECT_STATE — PG-EOS

**Hard limit: 60 lines.** Older history moves to `docs/CHANGELOG.md` (CLAUDE.md · QUOTA DISCIPLINE (v5)).
Maintained by pg-scribe only, in the same commit as the task it records.

| field | value |
|---|---|
| Phase | 0 — Foundation → 2 — Warehouse · **pilot-first (D-127, GM 2026-09-24): the pilot runs on seed 019 + synthetic data; every field/human/sign-off/training/naming item and Tier-0 provisioning is DEFERRED-POST-PILOT** |
| Current task | **0.6a part 1/2 DONE — pgeos_app role + entity_scope USING/WITH CHECK (migration 0007, D-133)** (previous task 2.3 @ `f3426eb`). Completion 18/133 (0.6a not yet fully DONE — part 2 CI workflow next). |
| Golden slice (2.9) | not built · `.golden-slice-accepted` absent · `scripts/new-slice.sh` is a no-op. Deps 2.4, 2.6, 2.8, 0.15 — 2.6, 2.8, 0.15, **2.3 now DONE**; **2.4 next**. **Phase-0 gate: passed on 0.8 (D-130)** — pilot backup/restore acceptance against local Docker, 8/8 green. Acceptance also wires every Phase-0 "mechanism only" deferral (GM 2026-09-22), starting with 0.17's login endpoints. |
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
| 2.3 — generate 3,330 WH1 location codes (verification-only) | `f3426eb` |
| 0.8 — pilot backup/restore acceptance (D-130) | `56fa267` |
| X — D-135 session operating directive v6 in CLAUDE.md | `41c1e04` |
| X — D-127…D-134 pilot-first (2.2 closed on seed, ADR-0003 accepted, 0.6a READY) | `1f5027f` |
| X — D-125 cleanup (biometric import retired, GM-confirm list) | `92d0dd9` |

## Blockers

- **Open G-01 item:** G8 anchor storage before the first partition detach (≥ 2028-03) — D-115: `platform.settings` key design.
- **Carried under D-131 (owner GM, post-pilot):** ADR-0003 items 1 (shared PDA — PDA path blocked), 3, 4a, 5 (punch-record retention; doc 40:668, doc 25:429 unchanged), 6, 8, 9; GPS classification; SoD mechanism; §2.5 values. APP-1 has no WBS ID (D-127 no naming) — stays `tasks/proposed/`.
- **Not applied under D-132:** G3 diagram `01-08` regeneration (mermaid renderer not installed); G1/G2 (no retention value).
- (0.18 carried forward → **resolved in 0.6a part 1 (RLS)**; tests move to `pgeos_app` in part 2): migration 0007 split every `entity_scope` policy to `USING`/`WITH CHECK` and added role `pgeos_app` (no superuser, no BYPASSRLS); CI + integration tests still connect as superuser until part 2 lands.
- WAITING_GM rows: **0** (D-127). Deferred post-pilot: 20 rows, listed under Phase 7 in `tasks/MASTER_BACKLOG.md`.
- Concurrent external processes can delete uncommitted work (incident `a901a04`) · sessions start inside `claude-kit/` · stale `.git/*.lock` files are removed by hand.

## Next 3 tasks

1. **0.6a part 2/2** — CI workflow gates ①–⑥ on GitHub Actions + integration tests as role `pgeos_app` (secret scan gitleaks, SBOM syft — D-140)
2. **2.4** (dep 2.3 DONE, lane 2)
3. **2.9** golden slice "Receive inbound order" (dep 2.4, full human review) — never parallelised

## Notes

- Doc 38 is v4.2 (133 rows). `tasks/MASTER_BACKLOG.md` regenerated; Staged rows 2.20 / 5.18 / 6.2b / SC-01 unchanged (TODO, `tasks/backlog/`).
- D-104 superseded by D-129 + D-130 (D-132 G13); D-113 superseded by D-133; D-115's "2.2 within 7 days" superseded by D-128 for the pilot.
- 0.9 closed at `aa46787` with two unmerged WIP branches (`0217e85`, `f127ab2`) — `docs/notes/0.9-abandoned-wip.md`; never merge, never delete.
- Phase-0 policy (GM 2026-09-22): mechanism-only tasks; deferred parts tracked here and in `MASTER_BACKLOG.md`.
- GIT rule (GM 2026-09-23 B3): task ↔ code link is `git log` with `type(WBS):`; previous task's hash recorded here inside the next task's commit. Push policy D-120.
- GM decision sheet: `docs/notes/2026-09-23-gm-decision-sheet.md` · cleanup dispositions: `docs/notes/2026-09-24-cleanup-candidates.md` §4.
- **Batched questions for GM:** D-139 "items 2, 4, 5" (from "0.8 الآن → 0.6a مع البنود 2 و4 و5 مدمجة فيها") — which numbered list? No match found in the referenced files.
