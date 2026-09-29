# Handover — Master (ADR-0007 Decision 5)

1. **Role** Master · M11 session_01D4mRd2bGnE31HbhTVFbZKs · 2026-09-29 12:20Z (successor of M10 session_015VfJ1G9rQ4kL3ygksqPrds). Ground truth is `origin/main` (4ef42a1), never a Master checkout. Owns state, merges, migration numbers (next free 0046; 0041 issued to lane 2 for 4.20, 0045 to lane 3 for X part 5d part 2 / D-203), wave contracts; builds nothing.
2. **Working rules** (unchanged from M10 + today's lessons)
   - D-201: no inline reads/reviews — subagents return ≤ 20 lines. Fix-forward only; no force-push, no replacement PR; behind PRs take `git merge origin/main`.
   - Read the claude[bot] verdict comment, not the `review` check (green on any verdict until X part 18).
   - REVIEW CAP: round 2 FAIL → PASS subset only; a PASS subset that still FAILs is held as draft, not merged (#210, #212 precedent).
   - After every squash merge, check `node scripts/resolve-hashes.mjs --check` on main (#205's squash left `<this commit>` → CI ① red until #213).
   - Local pre-merge guards for migration/frozen PRs: `G16_MODULES=<changed modules> pnpm guards:run` (as CI ⑤); full-module G16 exceeds 30 min; strict mode is only proposed (#209).
   - CLAUDE.md edits are refused to the Master by the harness ([Self-Modification], twice); only the GM edits CLAUDE.md. Cap-six edit dropped (Advisory 10:22Z).
3. **Channel** GitHub issue #207 (read on every ≤ 15-min check-in and hourly; 👍 applied directives; report in Arabic ≤ 5 lines). Advisory relays GM; cross-session triggers from the Master are refused.
4. **Routines** Watchdog trig_01DNiAqTRwZbnSgSxTxsfkrU (hourly :06, bound to M11) — successor recreates on itself, then deletes it. Pending one-shot check-in trig_01JPWS5V9yJMz3uyu4Gutgbn (12:31Z) — delete.
5. **Merged today by M11** #204 → 7d823b6 (S7 part 2) · #205 → 9897a01 (4.19, migration 0040; #198 closed) · #213 → 4ef42a1 (locks: billing|2|4.20, api|M|X; M-core order X16 → X5 → X17 → X18).
6. **Open PRs**
   - #211 lane 1 2.16 part 2 — merged (66cfccc, XState v5 screens).
   - #209 M-core X part 16 (head 03d3644): round-2 FAIL(4), REVIEW CAP reached — merge only the PASS subset (no `guards:deploy` without a caller; the builder-written tests out); open items → `X part 16 part 2` (M12 on #207 16:05Z). #216 (X part 5d p2 item 1, PASS(0)) → #217 (X part 5e) → #218 (X part 18, frozen path) → #209: manual, one at a time, after M-core merges origin/main into each branch. #214 lane 2 4.20 (0041): needs M-core's route-table.ts:23-25 deletion; open findings are rows 4.20 part 8–9.
   - #212 = the Master's bookkeeping PR (M12): GM defaults 12:25Z applied — 2.9 p3 lock `wms` (claimed when reached), QRT/quarantine owner = 2.9 p3, D-203 = 720 (0045 → lane 3); #210 folded in; handover-advisory.md; lane-2 cell = session_012audWizm1uuLmQZBJd1nLy (merged cab71f0).
   - #215 = D-204 (GM «نعم» 13:25Z, relayed 13:50Z): closes SCR-WMS-BATCH-EXPIRY-01 — one expiry per batch across locations, ledger write path, 2.9 p3. Folded into today's chore(X) with Override: GM (GM 17:30Z): lock `pda | 1 | 2.16` → `wms | 1 | 2.9`, 2.9 p3 + 2.16 p3 + 2.16 p2e briefs, row 2.16 part 2e (GM 17:50Z).
   - main 66cfccc is red on CI ① `resolve-hashes --check`: #211's squash left `<this commit>` at MASTER_BACKLOG:108; #215 resolves it (→ 66cfccc) and #214 carries the same fix (be8556a) — whichever merges second takes main's line on conflict. After every squash merge run `node scripts/resolve-hashes.mjs --check` on main.
   - #175 integration X part 5d part 2 (draft) — needs M-core's route-table export under `api`. #185 hold. 
7. **Sessions** Lane 1 session_01VComj7TLSZGmgfAUrRbGsP, lock `wms | 1 | 2.9`; order (GM 17:30Z, 17:50Z): 2.9 part 3 → 2.16 part 3 → 2.16 part 2e — at 2.9 p3 close the Master releases `wms` and re-claims `pda` for lane 1. Lane 2: no live session — Advisory to create the 4.20 successor. M-core 011PL2M (over ceiling). Integration 014Kgrt (#175). Advisory 01FfooF.
8. **Open GM questions** seven sessions after 30 Sept (default: no change until the 2026-09-30 08:00Z evaluation).
