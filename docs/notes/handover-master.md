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
   - #211 lane 1 2.16 part 2 (head d6de727): claude[bot] FAIL(4) — blocking: receive/put-away screens not XState. Lane 1's `pnpm add xstate` refused by its harness ([Modify Shared Resources]); Master granted `xstate@^5.19.2` + lockfile on #211 (12:00Z) but cannot install it for the lane (would launder the refusal). Needs a human approval in lane 1's session, or M-core under `tooling`. Squash manually at PASS.
   - #209 M-core X part 16 (head 4b17ae3, dirty): FAIL(2) open — blocking finding 1 (G16 skipped at deploy). M-core (011PL2M, 458k) is building X part 5 on core/X-part-5 instead; #209 must be fixed on core/X-part-16-r2 (merge main, pinning test) — no r3/r4 PR.
   - #212 = the Master's bookkeeping PR (M12): GM defaults 12:25Z applied — 2.9 p3 lock `wms` (claimed when reached), QRT/quarantine owner = 2.9 p3, D-203 = 720 (0045 → lane 3); #210 folded in; handover-advisory.md; lane-2 cell = session_012audWizm1uuLmQZBJd1nLy.
   - #175 integration X part 5d part 2 (draft) — needs M-core's route-table export under `api`. #185 hold. 
7. **Sessions** Lane 1 session_01QdrAPRKmFdLKZYJzbceZDc (262k; order: #211 → 2.16 part 2d if any → 2.16 part 3 → 2.9 part 3). Lane 2: no live session — Advisory to create the 4.20 successor. M-core 011PL2M (over ceiling). Integration 014Kgrt (#175). Advisory 01FfooF.
8. **Open GM questions** SCR-WMS-BATCH-EXPIRY-01 (verbatim approval needed; the 01:20Z relay is unverified) · seven sessions after 30 Sept (default: no change until the 2026-09-30 08:00Z evaluation).
