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
  4. Claim the module in LANE_LOCKS (§8). 5. Write the SLICE BRIEF (§5).
  6. Delegate to **pg-tester** first → RED tests (pg-tester writes test files only).
  7. Delegate build to pg-backend / pg-frontend (never edits a test; a test defect goes back to pg-tester).
  8. Receive REPORT (§5).           9. **pg-tester** verifies: suite GREEN, no test weakened or edited by the builder.
 10. Review by **pg-reviewer** (opus) — also called BEFORE writing any migration that touches the schema, RLS or the audit chain.
 11. PASS → pg-scribe updates state/backlog/CHANGELOG → **one `feat(<WBS>)` commit** with trailers → release the lock.
 12. FAIL → same worker, same brief + findings, max 2 rounds → then Master on opus.
 13. Next task, or stop at the phase gate / real blocker / explicit stop.

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

Agent and tier come from `docs/MODEL_ROUTING.md`; record both. A "Read ONLY" list over 12 files or 1,500 lines is split into two slices. Every replicated tree starts from `scripts/new-slice.sh`. Stop at DONE — this session takes no second task.
