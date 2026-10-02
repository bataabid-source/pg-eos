# Improvement Plan

This document captures the engineering priorities required to stabilize the project after the recent rapid expansion of migrations, PRs, and governance rules.

## Phase 1 — Stabilize the active delivery queue

### Goal

Bring the active PR queue to a green and reviewable state before broadening feature scope.

### Actions

- close and merge the open PRs in merge order
- keep each change set small and reviewable
- rebase only on main before merge
- ensure CI gates are green on every candidate
- maintain strict lock ownership

### Acceptance

- main is stable after the merge sequence
- no active PR remains blocked by a core gate
- active acceptance steps are no longer silently ignored

## Phase 2 — Finish the acceptance contract

### Goal

Restore a real end-to-end scenario signal, especially around the remaining S1 red steps.

### Actions

- resolve the WMS billable-event path
- resolve the delivery-task gap that still blocks acceptance
- keep the acceptance assertions tied to real backend state
- do not turn red checks into placeholders or omissions

### Acceptance

- S1 is consistently green on the relevant lane DB
- P1 and P2 acceptance blockers are closed
- scenario assertions align to the actual business process

## Phase 3 — Governance and guard hygiene

### Goal

Ensure the repo keeps fast, controlled, and reviewable growth.

### Actions

- clear G15, G16, and G17 backlog items
- keep PRs small enough to review without overload
- maintain M-core and lane ownership discipline
- keep migration numbering and lock management exact

### Acceptance

- guard execution is understood and stable
- lane discipline does not drift
- migration and documentation state remain current

## Phase 4 — Documentation and contributor readiness

### Goal

Reduce onboarding friction and make operational knowledge explicit.

### Actions

- root README with repo overview
- getting started guide for local setup
- troubleshooting guide for common runtime failures
- master backlog tracking for near-term tasks

### Acceptance

- a new engineer can install, run, and validate the project without guessing
- the critical path is visible to all contributors
- operational issues have clear remediation paths

## Priority order

1. PR queue stabilization
2. S1 acceptance completion
3. guard and governance cleanup
4. documentation readiness
5. broader scenario coverage and mutation review

## Status

This plan is active and should be updated as each phase is completed.
