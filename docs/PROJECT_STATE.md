# PROJECT_STATE — PG-EOS

**Hard limit: 60 lines.** Older history moves to `docs/CHANGELOG.md` (CLAUDE.md · QUOTA DISCIPLINE (v5)).
Maintained by pg-scribe only, in the same commit as the task it records.

| field | value |
|---|---|
| Phase | 0 — Foundation → 2 — Warehouse (2.1 started 2026-09-23) |
| Current task | **X — D-125 cleanup (external biometric import retired, non-system requirements listed, contested decisions superseded)** (previous task X — ADR-0003 / SCR-HR-ATT-01 @ `e38c171`). Governance only. Completion 16/132 unchanged; 5.4 SUPERSEDED. |
| Golden slice (2.9) | not built · `.golden-slice-accepted` absent · `scripts/new-slice.sh` is a no-op. Depends on 2.4, 2.6, 2.8, 0.15 — **2.6 now DONE** (joins 2.8, 0.15 already DONE); 2.4 still TODO; **Phase-0 gate still open (0.2, 0.8) → 2.9 is no closer to starting.** **Acceptance gains a Phase-0 wiring line (GM 2026-09-22): the golden slice must wire up every part deferred from Phase-0 "mechanism only" tasks — starting with 0.17's login endpoints.** |
| Deployment tier | Tier 0 (`docs/package/42-Oracle-Cloud-Deployment.md`) |
| Schema | `database/schema/01 · 13 · 13B · 019` — the ONLY permitted schema (01 v1.1, 13B v4.4, migrations 0001–0006) · DB locale UTF8 / collate C / ctype C.UTF-8 · `apply.sh --recreate` **green on this machine 2026-09-23**: 175 tables/14 schemas, `wms.verify_wh1()` 21/21 pass (3,330 locations), G1–G13 = 0 (G6 blocking, 0 rows — WBS 0.16 complete), G18/G-SEED report-only = 0 |
| Session model | opus (`claude-opus-5-5`, set by the GM via /model on 2026-09-23 before phase F; earlier today fable `claude-fable-5-1`) · workers sonnet, reviews/ADR/security opus, pg-scribe sonnet, no haiku (GM 2026-09-23) |
| Toolchain | pnpm 9.15.9 · Node 25.2.1 · Docker 29.0.1 · psql 16.15 installed · claude CLI installed (npm -g) · migrations auto-runner enabled (WBS 0.11) · **psql UTF-8 fix** (WBS 0.15: stdin redirect not `-f` to avoid multi-byte corruption; trade-off: error output loses line numbers — see `apply.sh` header for details) · TypeScript 5.9.3 ceiling `<6.1.0` |
| Setup check | D-115 second verification pass (2026-09-23): `bash scripts/check-setup.sh` → READY · `pnpm lint` clean · `pnpm typecheck` 14/14 (cached, full turbo) · `PGUSER=postgres pnpm guards:run` → G1-G14+G18+G-SEED = 0 rows, all blocking guards green (G15-G17 not run, known) · `PGHOST=localhost PGPORT=5432 PGUSER=postgres PGDATABASE=pgeos python scripts/gen-briefs.py --check` → all 15 briefs ok, ≤120 lines, 175 tables/14 schemas · `python scripts/gen-backlog.py --check` → 132 rows, header/X.1-X.6/0.19 agree |

## Lanes

None claimed.

## Last 5 DONE (newest first)

| task | commit |
|---|---|
| X — ADR-0003 native attendance (Proposed, D-126) + SCR-HR-ATT-01 + doc-38 draft | `e38c171` |
| X — CR-BIO-DSH pre-read; Part 0 D-122/123/124 re-verified | `3750448` |
| X — D-122/123/124 (gitattributes, SC-01 dep, 0.6 split draft) | `f30baf8` |
| X — apply GM decision sheet D-115 (0.2/7.10 DONE, staged tasks admitted) | `e58a098` |
| X — record GM decisions 2026-09-23 (D-103…D-121) | `1e4c5c2` |

## Blockers

- **Open G-01 item:** where the G8 anchor is stored before the first partition detach (≥ 2028-03) — D-115: uses the `platform.settings` key design.
- **G-01 item (2.6) CLOSED by D-116:** `wms.skus` stays with no `entity_id`; `outbox_business_needs_entity` not weakened; audit_log-only is final, correct behaviour.
- WAITING_GM · **2.2** field survey — required within 7 days (D-115); the 019 seed is not a substitute — chain 2.2 → 2.3 → 2.4 → 2.9.
- **0.2 DONE (D-115)** — no longer a blocker. **0.8** stays a blocker: a local `pg_dump`/`pg_restore` rehearsal passed in full (`docs/notes/2026-09-23-restore-rehearsal.md`) but does not close 0.8, which still needs the real Tier-0 `backup.sh`/`restore.sh` + OCI Object Storage.
- **Phase-0 gate open** (0.8 only, 0.2 now DONE); **2.9 does not start before it closes**.
- **WAITING_GM · ADR-0003 (Proposed) + SCR-HR-ATT-01 (G-01)** — 11 open items; APP-1 proposed (tasks/proposed/), numbered ID pending GM. CR-BIO-DSH-v3.md never arrived: BIO-3F, BIO-8, D15, D16, Appendix A KPIs undrafted.
- **WAITING_GM · D-125 GM-confirm list** — 13 rows + 3 C(ii) in docs/notes/2026-09-24-cleanup-candidates.md §2–§3 (incl. D-104 vs lane-A rule, punch-record retention, N-16 renumbering).
- (0.18 carried forward) `entity_scope` is `FOR ALL` with `USING` only on `platform.audit_log` and on seven tables, governs INSERT — portal user's audited action rejected; every internal reader/writer must pass `isInternal: true` (GUC-only, false when unset). SCR-RLS-01 §6, SCR-RLS-02 §7, D-002.
- Concurrent external processes on this working directory can delete uncommitted work (incident `a901a04`).
- Sessions must start inside `claude-kit/` (`.claude/agents` + lane-guard hook not registered otherwise).
- Git lock files (`.git/*.lock` → `stale-*.lock-*`) cannot be deleted via tools; remove by hand.

## Next 3 tasks

1. 2.7 Data gate M04 (SKUs) — dependency 2.6 met, GM decision sheet now read (D-115); still WAITING_GM (real scorecard action, lane A)
2. 2.2 field survey → 2.3 → 2.4 (WAITING_GM, 7-day window per D-115)
3. 0.6a CI gates ①–⑥ (drafted split, D-124; deps 0.4 only — READY once doc 38 is edited; 0.6b deploy-to-staging still waits on 0.5)

## Notes

- WAITING_GM: Phase 0 lane A tasks (0.3, 0.5, 0.7, 0.8, 0.20 — 0.2 now DONE) plus the four Staged tasks (admitted, `tasks/backlog/`, blocked on real deps, not built).
- See `docs/notes/2026-09-23-restore-rehearsal.md` (0.8 rehearsal) and `docs/notes/2026-09-23-38-wbs-0.6-split-draft.md` (0.6a/0.6b, D-124, not yet applied to doc 38). SC-01's "sales contracts slice" dependency bound to WBS 1.7 (D-123). `.gitattributes` added (D-122) — CRLF renormalized, zero content change.
- Phase 0 gate: 0.18 isolation **DONE** (G7 = 0, D-002 applied) · 0.16 classification (G6 = 0) · 0.8 restore · 0.1 owners.
- 0.9 closed at `aa46787` with two unmerged WIP branches (`0217e85`, `f127ab2`), catalogued in `docs/notes/0.9-abandoned-wip.md` — never merge, never delete.
- Phase-0 policy (GM 2026-09-22): every task delivers mechanism-only (`packages/*`, tests), no modules/endpoints/screens. Deferred parts tracked here and in `MASTER_BACKLOG.md` (not docs/package/38).
- GIT rule (GM 2026-09-23 B3): no standalone "record the verified hash" commit; task ↔ code link is `git log` with `type(WBS):`; previous task's hash is recorded here inside the next task's commit.
- GM decision sheet: docs/notes/2026-09-23-gm-decision-sheet.md (WAITING_GM rows + G-01 G8 anchor + blockers 2.2/0.2/0.8).
