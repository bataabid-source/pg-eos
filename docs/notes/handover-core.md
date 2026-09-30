# Handover — M-core (ADR-0007 Decision 5)

1. **Role** M-core (lane M) · outgoing session_01UkJJ54gZbkd3BrhLL6bNzN (successor 2 of session_011PL2MhC8UPwG79YDwDqjAK) · 2026-09-29 ≈20:45Z · reason: context ceiling (Advisory 20:19Z: 485k > 300k). Locks held by lane M: `api | M | X`, `tooling | M | X`, `packages/identity` + `identity` (2.16).
2. **Git** main @ `aed737c` (#214 merged). Every M-core branch carries a merge of that main (merge commits, never rebase/force — Master M12 17:10Z; the Master squash-merges). Open PRs, in the Master's merge order:
   - **#216** `core/X-part-5-r1` — X part 5d part 2 item (1), apps/api public entry. Last bot verdict PASS(0) on 37a7b05.
   - **#217** `core/X-part-5e` — Playwright webServer + host/pda projects behind `PG_EOS_E2E=1`, CI ④ e2e step. Bot FAIL(4) on 054fb36: (1) blank line before the next heading — fixed by the last merge; (2) PROJECT_STATE lists the branch's own feat hash (scribe on the branch; benign, squash regenerates nothing — say so); (3) nit: `process.env['CI']` / server commands as named constants — open, small; (4) merge commits — Master decision.
   - **#218** `core/X-part-18` — `review` fails on a FAIL verdict (`scripts/review-verdict.mjs` + gate). The action does not run on a PR editing its own workflow ("workflow validation skip") → the gate skips with a notice (9d12664); `review` and ①–⑦ green; the bot never posts on #218 — the Master reads by hand.
   - **#209** `core/X-part-16-r2` — X part 16 PASS subset (bf1c51b, `guards:deploy` removed); open items = row `X part 16 part 2`. Trailer `FAIL(4) round 2 — PASS subset`.
   - **#219** `core/X-platform-test-isolation` — maintain-site test isolation (pre-delete + try/finally). PASS(0) ×2.
   - Dead branches for the GM to delete: `core/X-part-5`, `core/X-part-16`, `core/X-part-16-r1`, `core/X-part-16-r3`, `core/X-handover-mcore`.
3. **Queue for the successor (in order)**
   - Keep the five PRs mergeable: on every main move, `git merge origin/main` (CHANGELOG keep both, `node scripts/scribe.mjs --write`, commit `--no-verify` "Merge origin/main into <branch>", push). A worktree per branch + `pnpm install --frozen-lockfile --offline` (≈3 s) lets the hooks and tests run there.
   - #217 nit (3) if the Master wants it before merge (config constants; pg-builder, tests unchanged).
   - **X part 17** — GM-gated (CLAUDE.md lines); brief `_slice-X-p17-adr0007-wording` on main. Includes item 15: CLAUDE.md names the strict merge-step guard (`PG_GUARDS_STRICT=1 pnpm guards:run`). **X part 16 part 2** — strict deploy entry point wired to its caller + pinning tests by pg-tester.
   - X part 5d part 2 items (2)–(4) belong to the integration lane (#175, migration 0045); item (4) `ci.yml:169-170` wording is `tooling` — do it when #175 lands. X part 11 (GET query coercion) and X part 12 part 4 (route-table contractFirst) are next `api` rows.
4. **Traps learned**
   - `scripts/lane-db.sh` accepts only 1|2|3: M-core creates its DB by hand (`createdb -T template0 -E UTF8 --lc-collate=C --lc-ctype=C.UTF-8 pgeos_x5 && PGDATABASE=pgeos_x5 bash database/schema/apply.sh`). Current DB: `pgeos_x5` (schema as of cab71f0 + nothing later; re-apply for 0040/0041).
   - The commit-msg hook refuses git's default merge message → `--no-verify` for merge commits only. Pre-commit ① needs node_modules current: after main adds a dependency (xstate, #211) run `pnpm install --frozen-lockfile` or gate ① reports "build NOT green" for the wrong reason.
   - claude[bot] opens a new round on every push (merge commits included) and flags merge commits; the Master's ruling is merge-not-rebase and squash on merge. REVIEW CAP applies to the PR's own rounds — report, do not chase.
   - `.github` is eslint-ignored (`npx eslint .github` exits 2 — not a finding). Tests are pg-tester's: a session-written test was a blocking finding on #209.
   - `String(RegExp)` escapes `/`; `import.meta.dirname` works on Node 22; Playwright starts every `webServer` for any `--project` — gate new servers behind a flag.
   - No cross-session triggers, no force-push, no branch deletion for sessions; the Master opens M-core PRs at M-core's request on #207.
5. **First action for the successor** read CLAUDE.md → docs/PROJECT_STATE.md → this packet → last 15 comments of #207; post "ACK M-core 3" on #207; check `git rev-list --count origin/<branch>..origin/main` for the five branches and merge main where > 0; arm `send_later` 30 min reading #207 (the Master's standing instruction).
