G16: changed domain/ per PR, every module nightly (X part 6); G15 per STREAMS §G15 (green.json); G17 NOT RUNNABLE; deploy.sh waits on 0.6b.
S1–S20 2/20 present, 0/20 passed (S1/S2 RED on unbuilt rows); previous integration lane silent since 06:32Z — replaced after 5a merges (S18 + 5d).
The "known red" set (platform evaluate-alerts/schema-invariants/audit-chain, wms T9) ran green 2026-09-26 under coverage gates; CI is the arbiter.
Identity threshold test race under turbo (X part 3); superuser-role catalog test deferred (X part 2) — MASTER_BACKLOG.
Open G-01: G8 anchor (approved doc 31 v4.2/D-194, deferrable); imile entity_id/CHECKs/outbox; 2.15 space_reservations.qty CHECK; 3.1 shift_groups.vehicle_id.
INV-C4-1 DB-level enforcement on tms.delivery_tasks / tms.routes.vehicle_id required before 3.4 (stream B).
Lane backlog: 2.16 1a-3c/1a-4b (process) · 3.12 2b/2c-ii · 4.1a 2b · 4.1a p3 p2 · 4.1b p3 · 3.12/3.13 polish · 2.9 p3 — see MASTER_BACKLOG.
WBS 1.11 BLOCKED (D-178). close/0.6a-d166 (2 ahead/151 behind) and lane/3-3.13 (2 ahead) superseded, content on main — GM deletes them (D-193 D5).
Deep review (D-193): no HTTP host/worker/Dockerfile (ADR-0006, X part 5); G-16a OTP limits missing (2.16 part 1a-5); SCR-AUDIT-CHAIN-01/IDENTITY-RLS-01 open.
Master batch (frozen paths): entityId on WithContextCtx; domain-kit browser break; eslint cwd bug; new-slice.sh stale citations.
