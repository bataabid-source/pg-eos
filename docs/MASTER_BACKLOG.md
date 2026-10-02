# Master Backlog

This backlog reflects the highest-priority work required to move the project from a partially green state to stable delivery.

## Critical path

### 1. Active PR stabilization

1. PR #218 — review verdict gate for FAIL verdicts
2. PR #251 — migration 0049, platform-scoped writer permissions
3. PR #252 — S1 scenario acceptance assertions
4. PR #253 — WMS subscriber for billable events

Required outcome:

- CI gates ①–⑥ green for each PR
- pg-reviewer PASS on each review round
- linear history on main
- no unresolved blocker carried into the next lane

### 2. Acceptance backlog

- S1 remaining red steps caused by missing billing and delivery-task features
- S2 readiness review
- S1–S20 scenario coverage expansion

### 3. Guards backlog

- G15 scenario population
- G16 CI-only execution review
- G17 runnable status or explicit waiver with documented rationale

## Tracked workstreams

### Lane 2 — Billing / 4.3

- finish billable-event insert path for the checked event flow
- confirm system actor behavior under pgeos_worker only
- verify redelivery-safe semantics

### Lane 3 — WMS / S1 scenario work

- resolve S1 fixture and assertion mismatches
- keep scenario assertions aligned with the real DB state
- avoid silently weakening acceptance checks

### M-core / platform work

- complete platform-scoped writer work
- lock review and schema governance for shared platform changes
- keep frozen-path changes small and reviewable

## Execution rule

No new substantial feature work should begin before the current critical path reaches a stable green state.

## Queue priority

1. PR #218
2. PR #251
3. PR #252
4. PR #253
5. G15/G16/G17 repair
6. S1–S20 scenario expansion
7. Mutation and coverage work
8. Secondary docs / UX polish

## Merge conditions

- rebase only
- no direct merge commit
- all gates green
- review verdict PASS
- no lock violation
