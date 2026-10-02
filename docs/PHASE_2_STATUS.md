# Phase 2 Execution Report

Date: 2026-10-02
Status: In progress
Owner: Master Session

## Executive summary

The repo is in a controlled but not yet stable state. The active PR queue needs a strict merge order before broader testing and feature work can continue safely. The relevant sequence is:

1. PR #218 — M-core, frozen path, review-verdict gate
2. PR #251 — M-core migration 0049
3. PR #252 — integration lane S1 assertions
4. PR #253 — lane 2 billing subscriber

## Current PR state

### #218 — review verdict gate
- State: open
- Mergeability: unstable
- Risk: frozen path (`.github/workflows/*`)
- Required action: rebase on current main and rerun CI until verdict prints PASS
- Decision: manual merge only once green

### #251 — migration 0049
- State: open
- Mergeability: clean
- Status: migration is documented and isolated tests are passing
- Required action: merge after #218 and after #246 has been incorporated on main

### #252 — S1 scenario tests
- State: open
- Mergeability: clean
- Status: Scenario 1 green; scenario 2 remains red only on not-built rows
- Required action: keep soft assertions out; merge after #251 and before #253

### #253 — billing subscriber
- State: open
- Mergeability: clean
- Status: strong local gate results; the WMS billable-event feature is in place
- Required action: merge after #252, but before broader acceptance expansion

## Safe merge order

The project rules require a controlled merge pipeline and no forked history. The merge sequence is:

```text
#218 -> #251 -> #252 -> #253
```

with the following conditions:

- rebase only
- no direct merge commit
- no lock violation
- all gates green
- review verdict PASS
- no change to frozen path outside the PR scope

## Immediate execution checklist

- [ ] fix #218 instability via rebase on main
- [ ] rerun CI gate ①–⑥ on #218
- [ ] merge #218 manually
- [ ] merge #251 after the main branch catches up
- [ ] merge #252 after #251
- [ ] merge #253 after #252
- [ ] rerun scenario suite and assert S1 full green
- [ ] regenerate PROJECT_STATE and lock state

## Phase 3 action plan

Once the merge queue is stable, move to the next fixed sequence:

1. resolve remaining red S1 acceptance rows
2. fix G15/G16/G17 guard backlog
3. add or refine missing scenario coverage S1–S20
4. run mutation and coverage review
5. update runbooks and contributor docs

## Decision gate before proceeding

The suspension point is the merge queue stability check. Until #218 is green and merged, no broad acceptance or backlog expansion should proceed.
