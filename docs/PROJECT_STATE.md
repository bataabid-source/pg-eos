# PROJECT_STATE — PG-EOS

**Hard limit: 60 lines.** Older history moves to `docs/CHANGELOG.md` (CLAUDE.md · QUOTA DISCIPLINE (v5)).
Maintained by pg-scribe only, in the same commit as the task it records.

| field | value |
|---|---|
| Phase | 0 — Foundation → 2 — Warehouse · **pilot-first (D-127, GM 2026-09-24): the pilot runs on seed 019 + synthetic data; every field/human/sign-off/training/naming item and Tier-0 provisioning is DEFERRED-POST-PILOT** |
| Current task | **Lane handover (Master, D-173/D-175): 1.2 DONE @ `6a53fc8` (PR #12) · 3.3 DONE @ `9616422` (PR #14) · 5.5a part 1 (`platform.sites`) DONE @ `3679b70` (PR #19), part 2 pending · 3.14 part 1 (iMile health reporting) @ `<this commit>` NOT DONE, pg-reviewer PASS round 4 (opus) · 5.13 part 1 @ `a66ea8c` NOT DONE.** Next: lane 1 → 0.19 · lane 2 → 5.5a part 2 (`hr.shifts`/`shift_assignments`/`shift_groups`) · lane 3 → 3.14 part 2 (`services/agent` pull loop), then 5.18. Completion 23/136. Previous governance commit: `976f433` (PR #18). |
| Golden slice (2.9) | **ACCEPTED** · `.golden-slice-accepted` committed · `scripts/new-slice.sh` active (trial on throw-away worktree, `tms assign-route`, 18 REPLACE-ON-COPY markers; registers contract exports itself since `412708a`) · `.githooks/pre-commit` active (①lint/boundaries/types ②touched-module unit tests ③guards:run when database/ staged; no gate on docs-only commits) · scope backend only, no PDA UI (GM choice). R1: an all-zero order gets no GRN and no `wms.inbound.received` event. |
| Deployment tier | **Pilot Tier 0 = local Docker `postgres:16` (D-129)**; Oracle Tier 0 (`docs/package/42-Oracle-Cloud-Deployment.md`) after the pilot (0.3, 0.5, 0.7, 0.6b DEFERRED-POST-PILOT) |
| Schema | `database/schema/01 · 13 · 13B · 019` — the ONLY permitted schema (01 v1.1, 13B v4.4, migrations 0001–0015: 0008 inbound-orders version/G6, 0009 next_doc_no SECURITY DEFINER, 0010 idempotency-keys + variance-photo columns (task 2.9), 0011 `alert_log.version` + N-16 deactivated, 0012 `wms.space_dashboard` security_invoker grant (5.13 part 1), 0013 `catalog.price_lists.version` (1.2), 0014 `hr.employees.version` (3.3), 0015 `platform.sites` + `hr.employees.default_site_id` FK (5.5a part 1)) · DB locale UTF8 / collate C / ctype C.UTF-8 · next free migration **0016** · **SCR-HR-ATT-01 APPROVED (D-131)** — migration number not yet issued |
| Session model | **D-174 (GM 2026-09-24): lane sessions sonnet / effort medium · Master sonnet / medium for merges + bookkeeping, opus only for ADR / security / D-117 · fable only when the GM names it for a single session** · agents pinned: pg-reviewer opus, all other agents sonnet, no haiku (GM 2026-09-23) · fast mode unavailable (SDK) |
| Toolchain | pnpm 9.15.9 · Node 25.2.1 · Docker 29.0.1 · psql 16.15 · claude CLI · migrations auto-runner (WBS 0.11) · psql UTF-8 fix (WBS 0.15, see `apply.sh` header) · TypeScript 5.9.3 ceiling `<6.1.0` · Python 3.13 (`python`, not `python3`, on this machine) · `gh` per command with the Git-Credential-Manager token (D-173) |
| Setup check | 2026-09-24: `python scripts/gen-backlog.py --check` 136 rows (v4.4) · `bash scripts/check-setup.sh` MASTER_BACKLOG OK, PG_APP_USER unset → NOTE only (D-173); its `.git` MISS is a worktree artefact (`.git` is a file there) · `gen-briefs.py --check` needs PG env (PGUSER) — last green 2026-09-24 morning · gates ①–⑥ green on main via CI (PR #14) |

## Lanes

| lane | task | module lock | worktree | status |
|---|---|---|---|---|
| 1 | 0.19 admin app shell (D-172) | `admin` (`apps/admin`) | `../pg-eos-lane-1` | queued — next lane-1 session (`/pg-resume` from main ≥ this commit); 1.2 DONE @ `6a53fc8` |
| 2 | 5.5a part 2: `hr.shifts` / `shift_assignments` / `shift_groups` (SCR-HR-SHIFT-01 §2.1–§2.3) | `hr` (`platform` released, PR #19 merged) | `../pg-eos-lane-2` | queued — next lane-2 session; part 1 (`platform.sites`, migration 0015) DONE @ `3679b70`; next free migration **0016** on request |
| 3 | 3.14 part 2 — `services/agent` pull loop (D-175: portal check confirmed live) | `imile` (new module) | shared `claude-kit` | queued — next lane-3 session; part 1 (health reporting) committed NOT DONE @ `<this commit>`, pg-reviewer PASS round 4; 5.18 stays queued behind it (`platform` free since PR #19/#20) |

## Last 5 DONE (newest first)

| task | commit |
|---|---|
| 3.14 part 1 — iMile health reporting mechanism (`ReportAgentHealth`), NOT DONE | `<this commit>` |
| 5.5a part 1 — `platform.sites` (SCR-HR-SHIFT-01 §2.4), migration 0015, DONE (part 2 of 5.5a pending) | `3679b70` |
| 3.3 — hr.employees (drivers), documents, hard gate (lane 2, first replicated slice) — DONE | `9616422` |
| 1.2 — M03 catalog price lists/lines/import/exceptions, floor rule (lane 1), DONE | `6a53fc8` |
| 5.13 part 1 — alert evaluation mechanism (`EvaluateAlertRules` + `AcknowledgeAlert`, migrations 0011/0012), NOT DONE | `a66ea8c` |

## Blockers (settle BEFORE any lane opens — reviewer's project-wide items)

- ~~(a)(b)(c) G15–G17 not run by `guards-run.sh` · `new-slice.sh` `LANGS` lacks `am` · no package scaffold for a module with no golden counterpart.~~ **Resolved 2026-09-24 (D-170):** runners executed when present (NOT RUNNABLE otherwise, blocking under `PG_GUARDS_STRICT=1`); `am` added; `new-slice.sh` scaffolds `modules/<module>` from the golden shell before copying the layers.
- **`scripts/deploy.sh` does not exist yet** (CLAUDE.md names it): G15–G17 are NOT RUNNABLE and non-blocking at merge until it exists and exports `PG_GUARDS_STRICT=1` before `pnpm guards:run` (0.6b / deploy slice).
- **Open G-01 items:** G8 anchor storage before the first partition detach (≥ 2028-03) — D-115: `platform.settings` key design. **3.14 part 1 (not resolved):** `imile.agent_health` has no `entity_id` — `.reported` NOT published to `platform.outbox` pending a ruling; no DB CHECKs for `pending_pushes >= 0` / `session_valid or error_message not null` (app-layer only) — `docs/notes/2026-09-24-imile-agent-scenario.md` §4 rows e/f.
- **Carried under D-131 (owner GM, post-pilot):** ADR-0003 items 1 (shared PDA — PDA path blocked), 3, 4a, 5 (punch-record retention; doc 40:668, doc 25:429 unchanged), 6, 8, 9; GPS classification; SoD mechanism; §2.5 values. APP-1 has no WBS ID (D-127 no naming) — stays `tasks/proposed/`.
- **Not applied under D-132:** G3 diagram `01-08` regeneration (mermaid renderer not installed); G1/G2 (no retention value). **D6 follow-up (0.6a part 2):** production partition maintenance must take the audit-chain advisory lock before partition DDL — no new WBS ID, tracked here.
- WAITING_GM rows: **0** (D-127). Deferred post-pilot: 20 rows, listed under Phase 7 in `tasks/MASTER_BACKLOG.md`.
- Concurrent external processes can delete uncommitted work (incident `a901a04`) · sessions start inside `claude-kit/` · stale `.git/*.lock` files are removed by hand.
- **Batched Master tasks (frozen paths, one Master-only window):** `entityId` on `WithContextCtx` (`packages/db`, lane 2 finding 2 — slices fail closed 422 until then) · SCR-HR-EMP-01 three DB CHECKs as a Master migration (pre-migration review first) · `catalog.price_list.activated` / `catalog.price_exception.granted` into `packages/events/catalog.ts` when 1.4/1.6 consume them. Done in D-173: PG_APP_USER NOTE in check-setup.
- **Flagged by lane 2 (5.5a part 1), pre-existing, untouched by this slice:** unfiltered `pnpm --filter @pg-eos/platform test` shows ~7 failures in `tests/evaluate-alerts/**` and `tests/integration/{schema-invariants,audit-chain-*}.test.ts` (FK/RLS fixtures, concurrency/timeouts) — audit-chain ones touch the hash chain, Master/GM attention needed.

## Next 3 tasks (D-172 / D-173)

1. Lane 1: 0.19 admin app shell (lock `admin`, D-172) — then 3.1 vehicles
2. Lane 2: 5.5a part 2 — `hr.shifts` / `shift_assignments` / `shift_groups` (lock `hr`) — then D-144 slice 2 (device custody link, requests, leaves → 5.3b)
3. Lane 3: 3.14 part 2 — `services/agent` pull loop (Node + Playwright, dedicated iMile account, 10-min loop, single-session enforcement), then 5.18 (platform free), then 5.13 part 2

## Notes

- main is PR-protected — commit on a branch, push, open a PR, merge on green CI. Lane PRs are opened and merged by the Master (`gh`, rebase merge); a lane branch that conflicts after another lane merges is rebased by the Master and re-pushed as `<branch>-r1` (D-173).
- Doc 38 is **v4.4 (136 rows, D-173)**. `tasks/MASTER_BACKLOG.md` regenerated; Staged rows 2.20 / 2.9b / 6.2b / SC-01 unchanged (TODO, `tasks/backlog/`).
- D-104 superseded by D-129 + D-130 (D-132 G13); D-113 superseded by D-133; D-115's "2.2 within 7 days" superseded by D-128 for the pilot.
- 0.9 closed at `aa46787` with two unmerged WIP branches (`0217e85`, `f127ab2`) — `docs/notes/0.9-abandoned-wip.md`; never merge, never delete.
- Phase-0 policy (GM 2026-09-22): mechanism-only tasks; deferred parts tracked here and in `MASTER_BACKLOG.md`.
- GIT rule (GM 2026-09-23 B3): task ↔ code link is `git log` with `type(WBS):`; previous task's hash recorded here inside the next task's commit. Push policy D-120.
- GM decision sheet: `docs/notes/2026-09-23-gm-decision-sheet.md` · cleanup dispositions: `docs/notes/2026-09-24-cleanup-candidates.md` §4.
