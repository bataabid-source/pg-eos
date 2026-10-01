Plan: docs/STREAMS.md (ADR-0005, D-192) — streams A–F; DONE = scenario green in Playwright · wave 1 (A: 2.16→2.18 · B: 4.1b p2→4.19→4.20).
Done: phase 0 · phase 1 (1.11 D-178 BLOCKED) · warehouse 9/19 · golden slice 2.9 ACCEPTED · Pilot: Tier 0 Docker pg16 (D-129), seed 019 + synthetic (D-127).
Schema: 0001–0046 applied (0022 withdrawn); 0047 lane 1 (PR #247 open) · 0048/0049/0050 M-core (D-212, D-213) · next free 0051.
Sessions: cloud Postgres via session-start.sh; PG_APP_USER required (ADR-0005 §7) · Master M16 · cap 7 (D-205 C) · D-206..D-213 (CLAUDE.md lines pending).
Agents: pg-tester · pg-builder (sonnet) · pg-builder-core (opus) · pg-reviewer (opus); bookkeeping by scripts/scribe.mjs (state, locks, CHANGELOG template).
