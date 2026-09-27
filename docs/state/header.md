Plan: docs/STREAMS.md (ADR-0005, D-192) — scenario-driven streams A–F; DONE = scenario green in Playwright.
Phase: enablement week (Master + integration lane; build lanes frozen) → wave 1 (A: 2.16→2.18 · B: 4.1b p2→4.19→4.20).
Done so far: phase 0 closed · phase 1 done except 1.11 (BLOCKED D-178) · phase 2 warehouse 9/19 · golden slice 2.9 ACCEPTED.
Pilot: Tier 0 = local Docker postgres:16 (D-129), seed 019 + synthetic data (D-127); doc 38 v4.7 (154 rows).
Schema: migrations 0001–0037 + 0039 applied (0022 withdrawn); 0038 · 0040 · 0041 issued to lane 2 (4.1b p2 · 4.19 · 4.20); next free number 0042.
Sessions: remote containers boot Postgres from .claude/hooks/session-start.sh; PG_APP_USER is required (ADR-0005 §7).
Master: «الماستر M2 — طابور الدمج والموجة 1» (cloud, D-195); «تقييم المشروع والمسار القادم» stood down after PR #153. Next migration 0042.
Agents: pg-tester · pg-builder (sonnet) · pg-builder-core (opus) · pg-reviewer (opus); bookkeeping by scripts/scribe.mjs (state, locks, CHANGELOG template).
