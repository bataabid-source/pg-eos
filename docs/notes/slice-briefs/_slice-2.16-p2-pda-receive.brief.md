# SLICE BRIEF — WBS 2.16 part 2 · PDA receive + put-away screens (the PDA steps of S1)

Task: 2.16 part 2 (MASTER_BACKLOG)      Lane: 1 (stream A, weekly goal S1+S2+S18 — GM 2026-09-29 07:20Z, issue #207)      Lock: `pda` (whole module → `apps/pda/**`)
builder: pg-builder
Session: lane 1, branch `lane/1-2.16-p2` (first command: `git fetch origin && git checkout -B lane/1-2.16-p2 origin/main`); the Master sets the lock's worktree cell to `cloud:session_<lane-1 id>` when the session starts.
Model routing (ADR-0005 §5): pg-tester sonnet (RED) → pg-reviewer opus (brief + RED) → pg-builder sonnet → pg-tester verify → pg-reviewer opus close. Budget ≤ 8 files / 1,000 lines read, ≤ 150k tokens; REVIEW CAP 2 rounds.

## Acceptance
doc 38 row 2.16 (verbatim): "Scan response ≤ 1.0 s; shift cannot close with queue > 0" — this part delivers the two D4 screens S1's first scenario drives; the row stays IN PROGRESS.
doc 40 Part E S1 (verbatim): "When the PDA receives batch "B2409-7" with expiry 120 days from today / Then the line is placed in zone QRT".

## Facts (verified by the Master on main 426c315)
- doc 40 §D4 (L422, verbatim): "Nine screens: home · receive · put-away · pick · check · load · count · transfer/return · lookup. Scan is the input; one step per screen; error prevented with sound+vibration and a message stating the next action; … offline 72 h with visible unsynced counter (green 0 / yellow 1–20 / red > 20); shift cannot close with queue > 0; kiosk mode; keyboard-wedge scanner; scan response ≤ 1.0 s."
- `apps/pda/src/router.tsx` already routes all nine screens to `PlaceholderScreen` (part 1a); `/receive` and `/put-away` are replaced by real features here.
- The server side exists: `modules/wms/api/receive-inbound/handlers.ts` exports `handleReceiveLine` (L192), `handleSuggestLocation` (L209), `handleConfirmPutaway` (L221); `apps/api/src/route-table.ts` serves `/<module>/<use-case>/<operation>` by convention — no `api` lock needed.
- `apps/pda/src/features/otp-login/{client.ts,mock-client.ts}` is the port + mock pattern to copy; `apps/pda/src/offline-queue.ts` is the 72 h queue every write goes through.
- S2 and S18 drive none of the nine D4 screens (S2's VA-08 is a VAS command, S18 a monthly snapshot); S1's second scenario drives pick → check → load = `2.16 part 3`, next slice.

## Decisions (defaults — one CHANGELOG line each)
1. One port per screen (`ReceiveClient`, `PutawayClient`) with a mock client; the HTTP client is wired once the host serves the handlers (X part 5 / #175) — the screens never import `modules/*`.
2. Every write is enqueued in `offline-queue.ts` with its Idempotency-Key generated once at scan time.
3. Strings only in `apps/pda/src/i18n/*.json`, all six locales, key sets identical (keys.test.ts); the language selector is untouched (`2.16 part 1a-4c` waits).

## Read ONLY (workers)
- `CLAUDE.md`
- `.claude/briefs/wms.brief.md`
- `apps/pda/src/router.tsx`
- `apps/pda/src/offline-queue.ts`
- `apps/pda/src/features/otp-login/otp-login-screen.tsx`
- `apps/pda/src/features/otp-login/mock-client.ts`
- `modules/wms/api/receive-inbound/handlers.ts` lines 101-240
- `tests/scenarios/S1.spec.ts` lines 240-330

Write ONLY: `apps/pda/src/features/{receive,put-away}/**` · `apps/pda/src/router.tsx` · `apps/pda/src/i18n/*.json` · `apps/pda/tests/{receive,put-away}/**` · `tests/**` (pg-tester only). Frozen paths untouched.
Contract: none changed (the receive-inbound Zod contracts are consumed as they are). Screen spec: doc 40 §D4 above.

## RED tests
`apps/pda/tests/receive/receive-screen.test.tsx` · `apps/pda/tests/put-away/put-away-screen.test.tsx` · `apps/pda/tests/receive/receive-queue.property.test.ts`

```gherkin
Feature: PDA receive and put-away screens (WBS 2.16 part 2)
  Scenario: Scanning SKU, batch and expiry enqueues one receive-line command with one Idempotency-Key
  Scenario: A refused scan plays the error signal and shows the next action, and nothing is enqueued
  Scenario: Put-away shows the suggested location and confirms it by scanning the location code
  Scenario: Offline, both screens keep working and the unsynced counter rises
  Scenario: Every visible string resolves in ar, en, hi, ur, bn, am
```
Property test: for any sequence of scans, each accepted scan enqueues exactly one command and replays never duplicate its Idempotency-Key.

Deliver: the two features + RED files; `pnpm --filter @pg-eos/pda test` and `pnpm guards:run` green; report which S1 step the screens now back (the integration lane rewires S1 onto them under 2.18).
Migration number: none.

Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 — STOP and report (G-01); a needed file outside the lock — STOP and report.
