# SLICE BRIEF — WBS X part 17 · ADR-0007 addendum Accepted + its gates; agent-file copies of D-199; strict guards at the Master's merge step

Task: X part 17 (MASTER_BACKLOG)      Lane: M (M-core, ADR-0007 Decision 2)      Lock: `tooling` (lane M → `.claude/**`, `scripts/**`, `.github/**`)
builder: pg-builder-core
Session: M-core, branch `core/X-p17` (first command: `git fetch origin && git checkout -B core/X-p17 origin/main`), after X part 16 merges (backlog dependency). CLAUDE.md stays with the Master (lane-guard.sh refuses it to M-core): the Master writes CLAUDE.md, `docs/adr/ADR-0007-cloud-sessions-and-roles.md` and `docs/DECISION_LOG.md` onto this PR in the same merge — M-core never edits them.
Model routing (ADR-0005 §5): pg-tester sonnet (RED) → pg-reviewer opus (brief + RED) → pg-builder-core opus → pg-tester verify → pg-reviewer opus close. Budget ≤ 8 files / 1,000 lines read, ≤ 150k tokens; REVIEW CAP 2 rounds. Manual merge (M-core PR, CLAUDE.md · Merge queue).

## Acceptance
Backlog row X part 17 (verbatim): "CLAUDE.md constraint and the four agent copies identical in one merge; D-199 row; D-200 permissions consistent with BUILD METHOD and lane-guard".
Plus: the ADR-0007 "Proposed amendment" block (D-198 cap six + sixth slot, auto-archive, Stryker; D-200; D-202) becomes Accepted in this PR, each item with its named gate (backlog item 10); the CLAUDE.md TESTING / Merge queue wording records that the Master's manual-merge step runs `PG_GUARDS_STRICT=1 pnpm guards:run` (item 15, from PR #209 review finding 2).

## Facts (verified by the Master on main 3338da2; re-verify at slice start)
- ADR-0007:3,7,122-129 hold the Proposed addendum ("lands with X part 17 — not in force; CLAUDE.md governs"); DECISION_LOG D-198/D-200/D-202 are rows 321-323; D-199 is reserved, not yet written.
- CLAUDE.md:28 still says "max five concurrent cloud sessions"; CLAUDE.md:29 names only the Master's hourly watchdog; AGENT CONSTRAINTS (CLAUDE.md:17-21) is copied verbatim into `.claude/agents/{pg-tester,pg-builder,pg-builder-core,pg-reviewer}.md` (gate ①).
- `scripts/guards-run.sh:132-172`: `PG_GUARDS_STRICT` accepts 0|1; strict makes a missing runner RED and never scopes G16. PR #209 (X part 16) review finding 2: the Merge queue's local `pnpm guards:run` no longer includes G16; Master decision (#209, 08:21Z): the manual-merge step runs `PG_GUARDS_STRICT=1 pnpm guards:run`.
- Named gates for the addendum (item 10): `scripts/check-locks.sh` / `.claude/hooks/lane-guard.sh` for cap and locks · the watchdog constant + a `tests/hooks` case for auto-archive · `.githooks/pre-commit` + CI ⑤ for Stryker.

## Decisions (defaults — one CHANGELOG line each)
1. M-core builds only the gates and the four agent-file copies; the Master's CLAUDE.md / ADR / DECISION_LOG commit is added to the same PR before the close review, so "identical in one merge" is checked by gate ① on one head.
2. Auto-archive (item 9) uses the Master's proposed conditions as a named constant (idle > 2 h, tree clean, no commit ahead of `origin/<branch>`, nothing stashed) — marked a Master proposal, not the GM's words (D-198 (ب)).
3. Items 3, 11, 12, 13 are GM questions / records: carried to the closing report, nothing built for them.

## Open items (not sourced — the Master answers before the session starts)
- Cap six: the sixth slot's naming and seven "after 30 September" wait on a GM D-id (D-198 (ج), item 3); check-locks.sh keeps "max three lanes" unless the Master states the new lane rule.
- D-200 in-session concurrency (item 2) and D-202 scope (item 11) have no verbatim GM wording beyond the recorded rows.
- CLAUDE.md:28 still says five sessions while the GM (a) directive (08:25Z, #207) runs a sixth under D-198; and two lane-1 sessions (`pda`, `wms`) now share lane 1 in lane-guard.sh (branch → lane, one session one slice) — the wording and gate for a second session on one lane are this part's to state.

## Read ONLY (workers)
- `CLAUDE.md`
- `docs/adr/ADR-0007-cloud-sessions-and-roles.md` lines 110-129
- `docs/DECISION_LOG.md` lines 321-323
- `.claude/agents/pg-builder.md`
- `scripts/check-locks.sh`
- `scripts/guards-run.sh` lines 125-175
- `.claude/hooks/lane-guard.sh` lines 180-233
- `tasks/MASTER_BACKLOG.md` lines 355-356

Write ONLY: `.claude/agents/*.md` · `.claude/hooks/**` · `scripts/**` · `.githooks/*` · `.github/**` · `tests/hooks/**` (pg-tester only). CLAUDE.md, `docs/adr/*`, `docs/DECISION_LOG.md`: the Master only. `packages/*`, `database/schema/*` untouched.
Contract: none. Screen/Board spec: none.

## RED tests
New cases in `tests/hooks/run.sh` (pure bash, CI gate ①, `pnpm test:hooks`): agent-constraints copy · check-locks cap · auto-archive · merge-step strict guards; `tests/hooks/X-p17.feature` for the scenarios below.

```gherkin
Feature: ADR-0007 addendum gates (WBS X part 17)
  Scenario: The AGENT CONSTRAINTS block of CLAUDE.md and the four agent files are byte-identical, D-199 exception included
  Scenario: check-locks.sh refuses a lock table beyond the cap the Master states
  Scenario: The watchdog archives an ACKed or merged session and a clean, pushed session idle over the named constant, and never a dirty one
  Scenario: The Master's merge step runs pnpm guards:run with PG_GUARDS_STRICT=1, and losing strict mode fails the test
```
Property check (a generated table of cases inside run.sh): for any session state (tree clean/dirty, commits ahead, stash, idle minutes, ACK), auto-archive fires only when every stated condition holds.

Deliver: the gates + agent copies + RED files; `pnpm check:locks`, `pnpm test:hooks` and `PG_GUARDS_STRICT=1 pnpm guards:run` green; the Master's CLAUDE.md/ADR/DECISION_LOG commit on the same PR head.
Migration number: none.

Stop-and-ask if: any rule without a verbatim GM line or D-id — STOP and report (never invent the sixth slot's name); a needed file outside `tooling` — STOP and report.
