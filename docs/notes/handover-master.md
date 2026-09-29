# Handover — Master (ADR-0007 Decision 5)

1. **Role** Master · outgoing M8 session_013Rys8YfUdhuXt6s8U7m8z4 · 2026-09-29 ~05:45Z · reason: context 382,663 of the 400k ceiling (get_session) + GM directive 05:45Z. Ground truth is `origin/main`, never a Master checkout.
2. **Working rule (GM 05:45Z):** every review read and every document read goes to a subagent returning ≤ 20 lines. Do not open replacement PRs anymore: push fixes onto the same PR until it merges. Enable auto-merge only after reading the actual verdict comment. The `review` check is green on any verdict until M-core's fix lands.
3. **Open PRs (Master-owned, both in review round 2, the last under REVIEW CAP):**
   - **#203** `master/locks-s7p2-r2` @ `b82ae21`, locks. Releases `packages/i18n | M` and `wms | 1`. Claims `tooling | M | X` (X part 16) and `api | 2 | 4.19` (#198's route-table edit). Adds backlog rows S7 part 2, 2.9 part 3 (#185's four findings), X part 5d part 2 (#175). **GM order: merge #203 first**, then #202.
   - **#202** `master-adr0007-d198-r6` @ `310856f`, frozen path. D-198: cap 6, auto-archive, Stryker out of local guards. D-200: roles run on disjoint locks, one sentence in the Locks rule. Adds rows X part 16 and X part 17. Round 2 opened with 1 blocking finding: the CLAUDE.md sentence naming Stream C cites a "GM instruction 2026-09-29" that has no DECISION_LOG row. Fix on the same PR: record the GM's verbatim instruction ("After #184 (D-198) merges, add the Stream C lane (S3, S4, S15, S16).") as a D-id, or move the sentence into X part 17.
   - Round 2 FAIL → commit only the PASS subset, and every open finding becomes a row. GM 05:45Z: push that onto the same PR.
   - **Conflict for the GM:** the GM asked for auto-merge on #202/#203, but CLAUDE.md keeps lock and frozen-path PRs manual. Merge them manually, one at a time, after reading PASS, and ask the GM if they want the rule changed.
4. **Decisions this tenure (not on main until #202 merges):** D-198 (verbatim, relayed to M5); D-200 «إذا كان ممكن العمل المتوازي للجلسات طبقه علي كل المستويات» (GM to M8, 2026-09-29). D-199 is reserved for the language-selector directive of 2026-09-27, with its CLAUDE.md line and four agent-file copies (X part 17).
5. **Sessions:**
   - M-core session_011PL2MhC8UPwG79YDwDqjAK: X part 16 brief under `tooling` once #203 is on main. Queued next: the `review`-check fix, then X part 17 agent files, then X part 5d part 2 (`api` after lane 2 releases it).
   - Lane 1 session_01LurRGWNNZEWuceRGGEaCPP: drafting the 2.9 part 3 brief on `lane/1-2.9-part-3-brief`. The Master claims `wms/receive-inbound` together with that brief. 1a-4c (`pda`/`admin`) waits on X part 17.
   - Lane 2 session_01WA2ZtmPUvF99WFr5ZKnMPo (launched 05:41Z from `lane/2-4.19-handover` @ `952cb85`): rebase #198 as `lane/2-4.19-r2` plus the route-table fix. It waits for the `api` row (#203).
   - Integration session_01SThLZenuNFMz5TD2dZVpNe: S7 part 2, then S9/S12 RED in parallel.
   - M7, R4, R5 archived. The watchdog trigger is trig_019kitCX3MxUxmEmjGP91E3v (bound to M8): M9 recreates it on itself with the same prompt, then deletes this one.
6. **Queue for M9, in order:**
   1. ACK me, then archive M8.
   2. Watchdog.
   3. #203 → #202 as above.
   4. One PR with the GM's items 6 and 7, plus the one CHANGELOG line for the 05:45Z directive:
      - a backlog row for M-core: `review` must fail on a FAIL verdict;
      - tomorrow's lock rows for every lane. Each lock ships with its brief (#187/#189 precedent); a lock without a brief goes to the GM as a question.
   5. Stream C lane only after D-198 is on main and its lock row plus brief exist.
   6. #185: hold; it is superseded by 2.9 part 3 and gets closed when that PR opens.
   7. #175: draft; X part 5d part 2.
7. **Open GM questions:**
   - When does the 7th session apply ("7 after the 30 September evaluation")?
   - The value of `identity.session.lifetime_minutes` (X part 5d part 2).
   - Auto-merge on lock and frozen-path PRs versus CLAUDE.md.
