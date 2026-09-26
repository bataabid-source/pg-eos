---
description: Run one WBS task end to end — brief, RED tests, build, review, scribe, one commit, release lock.
argument-hint: "<wbs-id>  e.g. 2.9"
allowed-tools: Read, Edit, Write, Grep, Glob, Bash
model: sonnet
---
Run WBS task $1 as ONE slice, then stop. Rules: `CLAUDE.md`. Module facts: `.claude/briefs/<module>.brief.md`.

Loop (BOOTSTRAP-v5 §2 — mandatory, in order):
  1. Read state (above).           2. Pick the next runnable WBS task (deps done; type 🤖 or ✅).
  3. Verify the acceptance criterion is runnable (command exists, data seeded).
  4. Claim the module — or the module/use-case pair (`wms/put-away`) — in LANE_LOCKS (§8); `bash scripts/check-locks.sh` must print OK.
  5. Write the SLICE BRIEF (§5) to `docs/notes/slice-briefs/_slice-<WBS>.brief.md`, then run
     `bash scripts/brief-check.sh docs/notes/slice-briefs/_slice-<WBS>.brief.md` (budget 8 files / 1,000 lines, P7).
     OVER BUDGET → the Master splits it NOW into part 1 / part 2 with disjoint acceptance subsets (D-179, P7);
     no worker is delegated to until it prints OK. A split made after a failed review round is a review FAIL.
  6. Delegate to **pg-tester** first → RED tests (pg-tester writes test files only). If the slice has a
     migration, the MIGRATION-REQUEST row names the RED test paths pg-tester just wrote — `lane-guard.sh`
     refuses the migration file until they exist.
  7. Delegate build to pg-backend / pg-frontend (never edits a test; a test defect goes back to pg-tester).
  8. Receive REPORT (§5).           9. **pg-tester** verifies: suite GREEN, no test weakened or edited by the builder.
 10. Review by **pg-reviewer** (opus) — also called BEFORE writing any migration that touches the schema, RLS or the audit chain.
 11. PASS → pg-scribe updates state/backlog/CHANGELOG — including every worker's token estimate from its closing
     REPORT line (pg-tester, pg-backend, pg-frontend, pg-reviewer; a missing estimate is asked for, never guessed); the Master names the brief and SCR notes pg-scribe `git rm`s (NOTES).
     In the slice's own commit, pg-scribe `git rm`s the slice brief and every SCR note the slice applied in full
     (CLAUDE.md · OPERATING RULES · NOTES); an SCR with an open G-01 item stays.
     After `git rebase origin/main` and before staging, run `node scripts/resolve-hashes.mjs --write`
     (resolves any `<this commit>` placeholder the previous task's commit left behind — CLAUDE.md ·
     GIT: "the previous task's commit hash is recorded in PROJECT_STATE inside the NEXT task's
     commit"; CI gate ① checks this with `--check`, P3). →
     **one `feat(<WBS>)` commit** with trailers, `Review: PASS(<n> findings, <r> rounds)` → release the lock.
 12. Review cap (P7): round 1 FAIL → ONE builder/tester fix round → round 2. Round 2 FAIL → STOP: commit and merge
     only the GREEN, PASS-reviewed subset (if any); every open finding becomes a `<WBS> part n+1` row in
     MASTER_BACKLOG; there is no round 3. A defect the lane finds itself before submitting is part of finishing the
     fix round, not a new round. D-117 opus escalation stays only for a finding that cannot be split (security,
     audit chain, RLS), and that escalation is itself the last round.
 13. Next task, or stop at the phase gate / real blocker / explicit stop. Inside the slice, never `AskUserQuestion` —
     questions go to the closing report (D-191 amendment); a rebase stop on a commit already on main → `git rebase --skip`
     after an empty `git diff`. After the push and report: handoff + `cleared, relaunch needed: /lane <id> — next <WBS>`, then
     `clear_session("self")` (lane.md step 9).

BRIEF (copy `.claude/briefs/_TEMPLATE.brief.md`; BOOTSTRAP-v5 §5):
  Task: <WBS id + name>            Lane: <A|B|C|1|2|3|M>          Lock: <module(s) claimed>
  Read ONLY: CLAUDE.md · .claude/briefs/<module>.brief.md · <golden slice path> · <doc 40 §> · <schema tables> · <D-blueprint section for screens/KPIs>
  Write ONLY: <paths inside the locked module(s)> · tests/…
  Scenario: <Gherkin block, pasted>
  Contract: <packages/contracts/<module>/<usecase>.ts | "derive from tables: …">
  Screen/Board spec: <D-blueprint doc §… | none>
  Deliver: <exact file list, mirroring the golden slice>
  Migration number: <issued by Master | none>
  Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40.

Agent and tier come from `docs/MODEL_ROUTING.md`; record both. A "Read ONLY" list over 8 files or 1,000 lines is split into two slices before any worker starts (P7). Every replicated tree starts from `scripts/new-slice.sh`. Stop at DONE — this session takes no second task.
