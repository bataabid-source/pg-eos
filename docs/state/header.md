Plan: docs/STREAMS.md (ADR-0005, D-192) — scenario-driven streams A–F; DONE = scenario green in Playwright.
Phase: enablement week (Master + integration lane; build lanes frozen) → wave 1 (A: 2.16→2.18 · B: 4.1b p2→4.19→4.20).
Done so far: phase 0 closed · phase 1 done except 1.11 (BLOCKED D-178) · phase 2 warehouse 9/19 · golden slice 2.9 ACCEPTED.
Pilot: Tier 0 = local Docker postgres:16 (D-129), seed 019 + synthetic data (D-127); doc 38 v4.7 (154 rows).
Schema: 0001–0046 applied (0022 withdrawn; 0040/0041 lane 2; 0042–0044 lane M; 0045 lane 3, D-203; 0046 lane B, 3.4 p1); next free 0047.
Sessions: cloud Postgres via session-start.sh; PG_APP_USER required (ADR-0005 §7) · Master M14 · cap 7 (D-205 C) · D-206 · D-207.
Agents: pg-tester · pg-builder (sonnet) · pg-builder-core (opus) · pg-reviewer (opus); bookkeeping by scripts/scribe.mjs (state, locks, CHANGELOG template).
