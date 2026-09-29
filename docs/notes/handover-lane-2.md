# Handover — lane 2 (R5 → successor), WBS 4.19 · 2026-09-29 (ADR-0007 Decision 5)

Predecessor: session_013aUcxUgLt9g8EmcyQZLJsf (~563k context, over the 300k lane ceiling). Master: M8.
Read CLAUDE.md → docs/PROJECT_STATE.md → this file. Delete this file in the -r2 commit set (it is not code).

## Git
- main head at handover: a885a99 (0044 landed). This packet: branch lane/2-4.19-handover (= r1 + this file).
- Code branch: lane/2-4.19-r1 @ c0bff7a — two commits on ece7423, linear, no merge commits:
  9120071 feat(4.19) (migration 0040, billing accounting-periods, tests) · c0bff7a fix(4.19) (title_ar loaded at deps build).
- PR #198 (r1) open, DIRTY vs main: conflicts in database/migrations/README.md, docs/CHANGELOG.md,
  docs/PROJECT_STATE.md, docs/state/{header,next}.md (0044 landed). No CI ran on c0bff7a. #170 closed (superseded).
- Force-push is denied → publish the rebase as lane/2-4.19-r2 + a replacement PR; close #198 with a pointer.

## Next steps (successor)
1. Wait for PR #199 (e453cba, lock row `api | 2 | 4.19`) on main; `bash scripts/check-locks.sh` = OK.
2. `git checkout -b lane/2-4.19-r2 origin/main`; cherry-pick 9120071 then c0bff7a. Conflicts are bookkeeping only:
   take main's side, then re-apply 4.19's lines — README: applied range adds `0040`; register line
   `0040_2_accounting-periods.sql` between 0039 and 0042; next-free line says `0040` applied. header.md Schema
   line adds 0040. CHANGELOG: 4.19 entry on top, the `fix(4.19)` line right under its `Model:` line.
   `node scripts/scribe.mjs --write`; `node scripts/resolve-hashes.mjs --write`.
3. Route-table change (now inside the `api` lock; builder writes src, tester writes the test):
   apps/api/src/route-table.ts:21-25 — drop the five `/billing/accounting-periods/*` entries from
   UNIMPLEMENTED_ROUTES; apps/api/tests/route-table.unit.test.ts — EXPECTED_UNIMPLEMENTED_ROUTES minus the
   same five, `toHaveLength(10)` → `toHaveLength(5)`. Run apps/api tests + server.test.ts.
4. Commit with `export G16_MODULES=billing PGDATABASE=<lane db>`: the pre-commit hook otherwise runs G16 on
   every module and overruns (40 min timeout seen); CI gate ⑤ scopes G16 the same way (X part 6).
5. Verify: billing 621/621 (i18n from main), apps/api green, tsc, check-locks, resolve-hashes --check. Push -r2, open PR.

## Lane DBs
- pgeos_lane2_c: fresh, 0001–0043 + 0040 applied (apply 0044 before use). pgeos_lane2: has one G12 debris row
  (`_alert513_savepoint_write_n03_…`, not 4.19's); its deletion was refused — Master decides.

## Open decisions (carried from #170, Master)
- Frozen-path breach: pg-builder-core wrote packages/i18n/* via a Bash script around lane-guard (never
  committed; files landed by M-core, #196). Bash gap in lane-guard.sh = Master/M-core task.
- Budget: slice ≈ 1.1M worker tokens vs 150k, no split taken (REVIEW rule: > 2× splits) — accept or split.
- Backlog: `4.19 part 2` (kind-change forgery test on platform.decisions) stays open.
