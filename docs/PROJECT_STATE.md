# PROJECT_STATE — PG-EOS

**Hard limit: 60 lines.** Older history moves to `docs/CHANGELOG.md` (CLAUDE.md · QUOTA DISCIPLINE (v5)).
Maintained by pg-scribe only, in the same commit as the task it records.

| field | value |
|---|---|
| Phase | 0 — Foundation → 2 — Warehouse · **pilot-first (D-127, GM 2026-09-24): the pilot runs on seed 019 + synthetic data; every field/human/sign-off/training/naming item and Tier-0 provisioning is DEFERRED-POST-PILOT** |
| Current task | **X — D-135 session operating directive v6 in CLAUDE.md** (previous task X — D-127…D-134 @ `1f5027f`). Governance only. Completion 16/133 (doc 38 v4.2: 0.6 → 0.6a/0.6b, D-124; 0.17 mechanisms and 1.5 proof excluded — ADR-0001). |
| Golden slice (2.9) | not built · `.golden-slice-accepted` absent · `scripts/new-slice.sh` is a no-op. Deps 2.4, 2.6, 2.8, 0.15 — 2.6, 2.8, 0.15 DONE; **2.3 → 2.4 now unblocked (D-128)**. **Phase-0 gate: closes on 0.8 (D-130)** — pilot acceptance against local Docker. Acceptance also wires every Phase-0 "mechanism only" deferral (GM 2026-09-22), starting with 0.17's login endpoints. |
| Deployment tier | **Pilot Tier 0 = local Docker `postgres:16` (D-129)**; Oracle Tier 0 (`docs/package/42-Oracle-Cloud-Deployment.md`) after the pilot (0.3, 0.5, 0.7, 0.6b DEFERRED-POST-PILOT) |
| Schema | `database/schema/01 · 13 · 13B · 019` — the ONLY permitted schema (01 v1.1, 13B v4.4, migrations 0001–0006) · DB locale UTF8 / collate C / ctype C.UTF-8 · `apply.sh --recreate` green 2026-09-23: 175 tables/14 schemas, `wms.verify_wh1()` 21/21, G1–G13 = 0, G18/G-SEED = 0 · **SCR-HR-ATT-01 APPROVED (D-131)** — migration number not yet issued; pg-reviewer pre-migration review before any DDL |
| Session model | fable (`claude-fable-5-1`, set by the GM via /model 2026-09-23 evening; earlier opus) · workers sonnet, reviews/ADR/security opus, pg-scribe sonnet, no haiku (GM 2026-09-23) |
| Toolchain | pnpm 9.15.9 · Node 25.2.1 · Docker 29.0.1 · psql 16.15 · claude CLI · migrations auto-runner (WBS 0.11) · psql UTF-8 fix (WBS 0.15, see `apply.sh` header) · TypeScript 5.9.3 ceiling `<6.1.0` · Python 3.13 (`python`, not `python3`, on this machine) |
| Setup check | 2026-09-24: `bash scripts/check-setup.sh` → READY (133 rows) · `python scripts/gen-briefs.py --check` 15 briefs ok · `python scripts/gen-backlog.py` 133 rows written; `--check` to rerun locally (see CHANGELOG) · `.githooks/commit-msg` accepts `0.6a`/`0.6b` · lint / typecheck / 330 tests / G1–G14+G18 green 2026-09-23 |

## Lanes

None claimed.

## Last 5 DONE (newest first)

| task | commit |
|---|---|
| X — D-127…D-134 pilot-first (2.2 closed on seed, ADR-0003 accepted, 0.6a READY) | `1f5027f` |
| X — D-125 cleanup (biometric import retired, GM-confirm list) | `92d0dd9` |
| X — ADR-0003 native attendance (Proposed, D-126) + SCR-HR-ATT-01 + doc-38 draft | `e38c171` |
| X — CR-BIO-DSH pre-read; Part 0 D-122/123/124 re-verified | `3750448` |
| X — D-122/123/124 (gitattributes, SC-01 dep, 0.6 split draft) | `f30baf8` |

## Blockers

- **Phase-0 gate: closes on 0.8 (D-130)** — real `backup.sh`/`restore.sh` against local Docker with a file target, restore into `pgeos_restore`, guards 0. 0.8 is READY; doc-38 row 0.8 still says "OCI + dep 0.5" (not delegated — GM follow-up), so `/pg-resume` picks it on this decision, not mechanically.
- **Open G-01 item:** G8 anchor storage before the first partition detach (≥ 2028-03) — D-115: `platform.settings` key design.
- **Carried under D-131 (owner GM, post-pilot):** ADR-0003 items 1 (shared PDA — PDA path blocked), 3, 4a, 5 (punch-record retention; doc 40:668, doc 25:429 unchanged), 6, 8, 9; GPS classification; SoD mechanism; §2.5 values. APP-1 has no WBS ID (D-127 no naming) — stays `tasks/proposed/`.
- **Not applied under D-132:** G3 diagram `01-08` regeneration (mermaid renderer not installed); G1/G2 (no retention value).
- (0.18 carried forward → **resolved inside 0.6a, D-133**): `entity_scope` FOR ALL/USING-only; runtime superuser. Until 0.6a lands, internal readers/writers pass `isInternal: true`.
- WAITING_GM rows: **0** (D-127). Deferred post-pilot: 20 rows, listed under Phase 7 in `tasks/MASTER_BACKLOG.md`.
- Concurrent external processes can delete uncommitted work (incident `a901a04`) · sessions start inside `claude-kit/` · stale `.git/*.lock` files are removed by hand.

## Next 3 tasks

1. **0.6a** CI gates ①–⑥ on GitHub Actions (READY, lane M; D-124 + D-133 `pgeos_app` role, `entity_scope` USING / WITH CHECK)
2. **2.3** generate the 3,330 codes from seed 019 (READY, lane 2; D-128) → 2.4 → 2.9
3. **0.8** pilot backup/restore acceptance (READY, lane A → Master executes; D-130) — closes the Phase-0 gate

## Notes

- Doc 38 is v4.2 (133 rows). `tasks/MASTER_BACKLOG.md` regenerated; Staged rows 2.20 / 5.18 / 6.2b / SC-01 unchanged (TODO, `tasks/backlog/`).
- D-104 superseded by D-129 + D-130 (D-132 G13); D-113 superseded by D-133; D-115's "2.2 within 7 days" superseded by D-128 for the pilot.
- 0.9 closed at `aa46787` with two unmerged WIP branches (`0217e85`, `f127ab2`) — `docs/notes/0.9-abandoned-wip.md`; never merge, never delete.
- Phase-0 policy (GM 2026-09-22): mechanism-only tasks; deferred parts tracked here and in `MASTER_BACKLOG.md`.
- GIT rule (GM 2026-09-23 B3): task ↔ code link is `git log` with `type(WBS):`; previous task's hash recorded here inside the next task's commit. Push policy D-120.
- GM decision sheet: `docs/notes/2026-09-23-gm-decision-sheet.md` · cleanup dispositions: `docs/notes/2026-09-24-cleanup-candidates.md` §4.
