# SLICE BRIEF — WBS 2.16 part 3 · PDA pick → check → load screens (the PDA steps of S1's second scenario)

Task: 2.16 part 3 (MASTER_BACKLOG)      Lane: 1 (stream A, weekly goal S1+S2+S18 — GM 2026-09-29 07:20Z, issue #207)      Lock: `pda` (whole module → `apps/pda/**`) — NOT held now: lane 1 holds `wms | 1 | 2.9` for 2.9 part 3 (GM 17:30Z); the Master re-claims `pda` for lane 1 when 2.9 part 3 closes (`wms` released in the same step)
builder: pg-builder
Sequencing (GM 17:30Z, 17:50Z): lane 1 order = 2.9 part 3 (`wms`) → **2.16 part 3** (`pda`) → 2.16 part 2e (`pda`, visual layer) — one lane-1 session at a time.
Session: lane 1, branch `lane/1-2.16-p3` (first command: `git fetch origin && git checkout -B lane/1-2.16-p3 origin/main`); the Master sets the lock's worktree cell to `cloud:session_<lane-1 id>`.
Model routing (ADR-0005 §5): pg-tester sonnet (RED) → pg-reviewer opus (brief + RED) → pg-builder sonnet → pg-tester verify → pg-reviewer opus close. Budget ≤ 8 files / 1,000 lines read, ≤ 150k tokens; REVIEW CAP 2 rounds.

## Acceptance
Backlog row 2.16 part 3 (verbatim): "PDA pick → check → load screens — the D4 screens S1's second scenario drives ("after checked, billable events …"), over `modules/wms/api/process-outbound` (`handlePickLine`, `handleCheckOrder`, `handleLoadOrder`); checker ≠ picker (doc 40 §D4). Same pattern as part 2." Criterion: "`/pick`, `/check`, `/load` replace their placeholders; checker ≠ picker refused on the screen; `pnpm guards:run` green".
doc 38 row 2.16 (verbatim): "Scan response ≤ 1.0 s; shift cannot close with queue > 0" — the row stays IN PROGRESS.
doc 40 §D4 (lines 420-423, verbatim extract): "Scan is the input; one step per screen; error prevented with sound+vibration and a message stating the next action; blind count; checker ≠ picker".
doc 40 Part E S1 scenario 2 (line 444, verbatim): "And after checked, billable events OF-01×1, OF-02×1, OF-06×1, OF-07×1 exist with status pending".

## Facts (verified by the Master on main 66cfccc; re-verify at slice start)
- Server side exists: `modules/wms/api/process-outbound/handlers.ts` — `handlePickLine` L274, `handleCheckOrder` L291, `handleLoadOrder` L327, each `requireIdempotencyKey`. Contracts `packages/contracts/wms/process-outbound.ts`: `PickLineInputSchema` L101 (orderId, lineId, expectedVersion, qtyActual, varianceReason?, correlationId), `CheckOrderInputSchema` L114, `LoadOrderInputSchema` L136.
- Checker ≠ picker is enforced by the server: `SelfCheckNotAllowedError`, i18nKey `wms.outbound.check.selfCheckNotAllowed` (`modules/wms/domain/process-outbound/errors.ts:272`, D-190 option a — any actor who posted any pick of the order).
- `apps/pda/src/router.tsx` L283-298: `/pick`, `/check`, `/load` are `makePlaceholderRouteComponent` routes. Part 2 (66cfccc) built `receive`/`put-away` as XState v5 machines + ports + mock clients + `scan-queue.ts` (72 h offline queue, one Idempotency-Key + correlationId per accepted scan) + `scan-signal.ts` (sound + vibration).
- No table, column or migration needed (screens + mock clients only). `SCR-WMS-OUT-04` (load manifest cross-order checks) stays open and is not touched.

## Decisions (defaults — one CHANGELOG line each)
1. Same pattern as part 2: per screen a `client.ts` port, a `mock-client.ts`, an XState v5 machine (no if/switch for transitions) and a screen; writes go through the offline queue with one Idempotency-Key per accepted scan. Real transport is not in this part (as in part 2).
2. Checker ≠ picker "refused on the screen" = the check screen shows the server refusal `wms.outbound.check.selfCheckNotAllowed` mapped to a PDA i18n key stating the next action (the server message's own: "a user who took no part in picking this order must perform the check"), with the error sound + vibration; the mock client reproduces the refusal when the checker's id is among the order's pickers. The screen does not re-implement the rule.
3. Pack is not one of D4's nine screens: no pack screen; the load mock starts from a `packed` order. Open question for the closing report (who packs on the floor), not a blocker.
4. New i18n keys in all six locales (ar, en, hi, ur, bn, am); `apps/pda/tests/i18n/keys.test.ts` extended by pg-tester (part 2 precedent).

## Read ONLY (workers)
- `CLAUDE.md`
- `apps/pda/src/features/put-away/put-away-machine.ts`
- `apps/pda/src/features/put-away/put-away-screen.tsx`
- `apps/pda/src/features/receive/scan-queue.ts`
- `apps/pda/src/features/receive/scan-signal.ts`
- `apps/pda/src/router.tsx` lines 180-342
- `packages/contracts/wms/process-outbound.ts` lines 95-223
- `apps/pda/tests/put-away/put-away-screen.test.tsx` lines 1-120

Write ONLY: `apps/pda/src/features/{pick,check,load}/**` · `apps/pda/src/router.tsx` · `apps/pda/src/i18n/*.json` · `apps/pda/tests/**` (pg-tester only). Frozen paths untouched; `modules/wms/**` and `packages/contracts/**` read-only.
Contract: none changed (consumes `PickLineInput`, `CheckOrderInput`, `LoadOrderInput`). Screen spec: doc 40 §D4 lines 420-423.

## RED tests
`apps/pda/tests/outbound/pick-check-load.feature` · `apps/pda/tests/pick/pick-machine.test.ts` · `apps/pda/tests/pick/pick-screen.test.tsx` · `apps/pda/tests/check/check-screen.test.tsx` · `apps/pda/tests/load/load-screen.test.tsx` · `apps/pda/tests/i18n/keys.test.ts` (extended)

```gherkin
Feature: PDA pick, check and load screens (WBS 2.16 part 3)
  Scenario: A scanned pick line queues one PickLine write with one Idempotency-Key and correlationId
  Scenario: A server refusal on a pick plays the error sound + vibration and states the next action
  Scenario: The user who picked the order is refused on the check screen with the next action
  Scenario: A user who did not pick the order checks it and one CheckOrder write is queued
  Scenario: Loading a packed order queues one LoadOrder write
  Scenario: /pick, /check and /load render their screens in all six locales, RTL for ar and ur
```

Deliver: the three screens + RED files; `apps/pda` tests + `pnpm guards:run` green; S1 scenario 2's PDA steps reported to the integration lane (2.18).
Migration number: none. The slice's commit deletes this brief.

Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 — STOP and report (G-01); a needed file outside `pda` (a dependency, the lockfile, `packages/*`) — STOP and report.
