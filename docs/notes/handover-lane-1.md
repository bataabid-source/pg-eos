# Handover — build lane 1 (live packet; history is in docs/CHANGELOG.md)

Read with CLAUDE.md and docs/PROJECT_STATE.md. Session session_015mARu8RtjQsAeGZEEdFjUb (lane 1 successor 3), 2026-09-30 08:40Z, clean point at ≈ 420k of the 500k ceiling (D-210 §1); both lane-1 PRs merged, session ends.

## State
- **Merged:** #227 (2.16 part 3, PDA pick → check → load) → squash `7c43f0c`; #229 (2.16 part 2e, PDA visual layer on Tailwind) → `a635bec`. Rows 2.16 part 3 and 2e DONE on main; the `<this commit>` placeholders resolve in the next commit that touches the rows (`node scripts/resolve-hashes.mjs --write`, precedent #222).
- **Row `2.16 part 3b`** (on main via #229, lock `pda`): claude[bot] non-security findings under D-206 — `NEXT` transition out of the `picked`/`checked`/`loaded` final states (cleared fields, RED first), discriminated `refused` handler in `keyOf` (four machines, no dead fallback), `router.tsx` header + import wrap, queue badge contrast (`text-yellow-600` → darker), `Screen` `min-h-screen` nested in the shell's (→ `flex-1`), `Alert.tsx` spread order (`...rest` first so `role="alert"`/`data-severity` cannot be overridden).
- Row 2.16 stays IN PROGRESS (real transport, "scan response ≤ 1.0 s"). Open question (closing reports): who packs on the floor (no pack screen in D4's nine). `apps/pda` `lint` script fails on the root eslint cwd bug (Master batch) — run `pnpm exec eslint apps/pda` from the root.
- Lock `pda | 1 | 2.16` still held on main; the Master swaps it for `wms | 1 | 2.9` with the QRT brief.

## Next
1. **GM D-211 (#207 07:59Z) governs the order:** the successor starts **2.9 part 3 step 2 — QRT quarantine decision** (brief `_slice-2.9-p3-s2-qrt-quarantine` re-issued by M15 with D-211's values: `platform.approval_chains ('quarantine_decision', 1, 'SALES_MGR')`, threshold `wms.quarantine.decision_due_hours` = 48, title_ar template, refusal of any stock_movement of the batch to a storage location while the item is `open` (named 422), outcomes `release` · `return_to_client` · `destroy`, escalation to `WH_MGR` at the deadline with no auto-release, minimum = `wms.skus.min_remaining_life_receipt_days`; migration **0047** via MIGRATION-REQUEST-1 first; builder pg-builder-core; lock `wms | 1 | 2.9`; SCR-WMS-QRT-01 closed in the same commit, `Decision: D-211`), then **2.9 part 6**, then 2.16 part 3b. Start only when the brief and the lock are on main.
2. Rebase/merge discipline: one linear `feat` commit per slice; if main moves, `git merge origin/main` (keep both CHANGELOG entries newest first, `scribe --write`); never commit with another slice's untracked RED in the tree (pre-commit ① typechecks `apps/pda/tests/**`). The Master squashes a branch that carries merge commits (rebase auto-merge rejects them); the harness refuses this lane any history rewrite.
3. Watchdog: `send_later` 30 min on yourself (routines are refused); read #207 on every check-in; report ≤ 5 lines there.

## Environment notes
- Lane DB pgeos_lane1 (`bash scripts/lane-db.sh 1`; `.claude/settings.local.json` env PGDATABASE, gitignored). `pnpm install --frozen-lockfile` first (node_modules is absent in a fresh container); `pnpm turbo run build --filter='@pg-eos/pda^...'`.
- PDA tests: `cd apps/pda && pnpm vitest run` (no DB). PDA e2e: `cd tests/scenarios && PG_EOS_E2E=1 PGDATABASE=pgeos_lane1 pnpm exec playwright test --project=pda`. Guards: `PGDATABASE=pgeos_lane1 pnpm guards:run` (G16 local skip D-198, G17 not runnable); never concurrently with module tests on the same DB.
- Commit with `PGDATABASE=pgeos_lane1 G16_MODULES=`; RED-only commits are impossible (typecheck) — one `feat` commit per slice with the build. Channel #207 only (Arabic, ≤ 5 lines per report; closing report ≤ 15 lines).
