# SLICE BRIEF — WBS 2.18 · run S1 to green as the 2.16 screens land (S2, S18 kept current)

Task: 2.18 "Scenarios S1, S2, S18 pass"      Lane: 3 (integration; weekly goal S1+S2+S18 — GM 2026-09-29 07:20Z, issue #207)      Lock: none — the lane writes only `tests/**`
builder: pg-builder
Session: integration lane, branch `lane/3-2.18` (first command: `git fetch origin && git checkout -B lane/3-2.18 origin/main`). pg-tester writes every file; pg-builder is named only because brief-check requires the line — a needed non-test change is reported, never made.
Model routing (ADR-0005 §5): pg-tester sonnet → pg-reviewer opus (brief + first diff) → pg-tester → pg-reviewer opus close. Budget ≤ 8 files / 1,000 lines read, ≤ 150k tokens; REVIEW CAP 2 rounds.

## Acceptance (doc 38 row 2.18, verbatim)
"Playwright green" — for S1, S2, S18 (doc 40 Part E, verbatim, never edited).

## Facts (last verified by the Master on main 426c315; re-verify against the current main at slice start)
- `tests/scenarios/S1.spec.ts` (612 lines) calls the receive-inbound / process-outbound handlers in-process; `tests/scenarios/green.json` lists no scenario; `scripts/scenarios-verdict.mjs` is the one reader (STREAMS §G15).
- S1's NOT BUILT steps today name: shelf-life → quarantine routing and the `quarantine_decision` item (rows 2.16/2.18), `stock_balance.expiry_date` (2.9 part 3 — waits, GM 07:20Z), billable events OF-01/02/06/07 (4.3), the PDL delivery task (3.4). S2 names the VAS command and Lost Revenue view; S18 names row 4.15.
- Lane 1 builds the PDA screens S1 drives: `2.16 part 2` (receive + put-away), then `2.16 part 3` (pick → check → load).

## Decisions (defaults — one CHANGELOG line each)
1. As each 2.16 part merges, the S1 step it backs is rewired to drive that screen and hard-asserted; every other step keeps its named `NOT BUILT` owner row. A step never turns green by weakening its assertion.
2. `green.json` is changed by the Master only, in the commit that closes the row (STREAMS §G15).
3. S2 and S18 are re-run on every merge; a changed failure message is updated to the current owner row, nothing else.

## Read ONLY (workers)
- `CLAUDE.md`
- `tests/scenarios/S1.spec.ts` lines 1-120, 240-330, 430-612
- `tests/scenarios/S2.spec.ts` lines 1-40, 100-177
- `tests/scenarios/playwright.config.ts`
- `tests/scenarios/green.json`
- `scripts/scenarios-verdict.mjs`
- `apps/pda/src/router.tsx` lines 1-40

Write ONLY: `tests/scenarios/**` (pg-tester only). Frozen paths untouched; nothing outside `tests/`.
Contract: none changed. Screen spec: doc 40 §D4, as built by 2.16 parts 2–3.

## RED tests
The existing specs are the RED: `tests/scenarios/S1.spec.ts` · `tests/scenarios/S2.spec.ts` · `tests/scenarios/S18.spec.ts`.

```gherkin
Feature: S1 Full 3PL client (Segment A, PST + PDL) — doc 40 Part E, verbatim
  Scenario: Inbound with short-shelf-life batch is quarantined
  Scenario: Outbound FEFO allocation and billing chain
```

Deliver: one `test(2.18)` commit per landed screen part; the report lists, per S1/S2/S18 step, green or the named owner row; two identical runs, zero residue, G1 = 0.
Migration number: none.

Stop-and-ask if: a step can only turn green by a change outside `tests/` — STOP and report the file and owner row; any table/column/rule not in 01 / 13 / 13B / 019 / 40 — STOP (G-01).
