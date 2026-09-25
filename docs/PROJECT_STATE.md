# PROJECT_STATE — PG-EOS

**Hard limit: 40 lines.** Older history lives in `docs/CHANGELOG.md` (CLAUDE.md · OPERATING RULES · BRIEFS). Maintained by pg-scribe only, in the same commit as the task it records.

| field | value |
|---|---|
| Phase | 0 CLOSED · 1 Commercial Core (done except 1.11, BLOCKED D-178) · 2 Warehouse (9/19) · pilot-first (D-127): seed 019 + synthetic data. Doc 38 **v4.6 (154 rows, D-187/ADR-0004)**. |
| Current task | Lane 1: **WBS 2.11 DONE** — all 5 parts (`a96b013`,`156b042`,`f30f7c7`,`3fadbde`,`f9aeecc`); part 5 closed condition 10 (D-189, per-contract/per-SKU limit, migration 0026, PASS(3 findings, 2 rounds)) — doc-38 row 2.11 fully met, all ten conditions. Lane 1 next: **2.12** (pick → check → pack → load), same `wms/process-outbound` lock. Lane 3: **3.1 parts 1+2 both DONE-in-part @ `e3137d5` (part 1) / `8d2ead9` (part 2)** — `RegisterVehicle` PASS(0 open round 2); `AssertVehicleAssignable` (the real INV-C4-1 gate) PASS(1 finding, 2 rounds), gate mechanism complete/tested/proven, not yet wired to a real assignment write path (future delivery-module slice); `fleet` lock **released**. Lane 2: 2.9b DONE @ `716bf8e` → 4.2 part 1 (`billing.billable_events` domain + repository insert, D-186) DONE-in-part @ `3739487` — PASS(23 findings fixed, 2 rounds); part 2 (pg-reviewer confirmation of the SQLSTATE 23505 duplicate-detection test, mutation-proven by the lane) reviewed inside 4.1a's own round 1, not a separate commit; `billing` lock held. Next: accounting core 4.1a→4.1b→4.19→4.20 (SCR-ACC-01, A2). |
| Golden slice / tier / schema / session model | 2.9 ACCEPTED (`.golden-slice-accepted`, `scripts/new-slice.sh` active) · Pilot Tier 0 = local Docker `postgres:16` (D-129), Oracle DEFERRED-POST-PILOT · migrations 0001–0026 applied (0022 withdrawn), next free **0027** · D-174/D-180 session model: lane sessions sonnet/medium, Master sonnet/medium (opus only ADR/security/D-117), pg-reviewer opus, no haiku |

## Lanes

| lane | task | module lock | worktree |
|---|---|---|---|
| 1 | 2.12 pick → check (checker ≠ picker) → pack → load (2.11 DONE, all ten conditions) | `wms/process-outbound` + `wms/receive-inbound` | `../pg-eos-lane-1` |
| 2 | 4.2 part 1 DONE-in-part @ `3739487`; part 2 open (pg-reviewer confirms in 4.1a round 1); next 4.1a | `billing` | `../pg-eos-lane-2` |
| 3 | 3.1 parts 1+2 DONE-in-part; `fleet` released; awaiting Master's next assignment (3.4, once 2.12 DONE) | — | `../pg-eos-lane-3` |

## Last 5 DONE (newest first)
| task | commit |
|---|---|
| 4.2 part 1 — `billing.billable_events` domain + repository insert (lane 2), DONE-in-part — PASS(23 findings fixed, 2 rounds); part 2 (pg-reviewer confirmation of SQLSTATE 23505 test) reviewed in 4.1a round 1 | `3739487` |
| 2.11 part 5 — condition 10, per-contract/per-SKU order limit, migration 0026 (lane 1) — **WBS 2.11 DONE, all ten conditions** — PASS(3 findings, 2 rounds) | `f9aeecc` |
| 3.1 part 2 — `AssertVehicleAssignable`, the real INV-C4-1 gate (lane 3), DONE-in-part — PASS(1 finding, 2 rounds); gate mechanism complete/tested/proven, not yet wired to a real assignment write path (future delivery-module slice) | `8d2ead9` |
| 3.1 part 1 — register vehicle + documents, no migration (lane 3), DONE-in-part — register-vehicle PASS(0 open round 2) | `e3137d5` |
| 2.11 part 4 — the two deferred describe/scenario naming gaps (lane 1), DONE-in-part — PASS(0) | `3fadbde` |

## Blockers

- `scripts/deploy.sh` missing (G15–G17 NOT RUNNABLE, non-blocking, 0.6b DEFERRED-POST-PILOT). Open G-01 items: G8 anchor storage (≥2028-03, D-115); 3.14/3.17 imile tables missing `entity_id`/CHECKs/outbox (`docs/notes/2026-09-24-imile-agent-scenario.md` §4); 2.15 `space_reservations.qty` no DB CHECK; 3.1 `hr.shift_groups.vehicle_id` pre-existing assignment column the new gate doesn't cover (GM call, `tasks/backlog/MIGRATION-REQUEST-3.md`); INV-C4-1 DB-level enforcement on `tms.delivery_tasks`/`tms.routes.vehicle_id`, required before WBS 3.4, same pattern as `wms.check_space_available()`; 4.2's round-2 G14 red is external — lane 1's own uncommitted migration 0026 on the shared dev DB, not lane 2's to fix; CI's ephemeral DB is the real merge gate.
- The two 0.9 WIP branches (`claude/postgresql-16-254336` @ `0217e85`, `claude/resume-4c8ecc` @ `f127ab2`) are never merged, never deleted.
- Batched Master tasks (frozen paths): `entityId` on `WithContextCtx`; SCR-HR-EMP-01 three DB CHECKs; `packages/domain-kit` browser break (node:crypto in browser bundle); root `eslint.config.mjs` cwd bug; X part 2 (P2 review round 2 #3): `scripts/new-slice.sh:11,205` + template text in `modules/{catalog,fleet,hr,imile}/index.ts` cite the retired "SPEED AND QUALITY (v5)" → "OPERATING RULES · REPLICATE"; `packages/i18n` bootstrap (never created — SCR-I18N-01 §1; 2.11/2.9b keys code-referenced only). D-125 cleanup still open (D-132 disposition, `docs/DECISION_LOG.md`): G1/G2 biometric-retention wording (doc 40:668, doc 25:429) needs a GM-set value, none invented; G3 diagram `01-08.mmd/.svg` not regenerated (needs the mermaid renderer).
- WBS 1.11 BLOCKED (D-178) — see `docs/notes/2026-09-25-wbs-1.11-premature.md`. Pre-existing, untouched: ~7 failures in `tests/evaluate-alerts/**` + `tests/integration/{schema-invariants,audit-chain-*}.test.ts`; 8 `tests/receive-inbound` failures from orphaned `wms.locations` (`T9-*`) fixtures.

## Next 3 tasks

1. Lane 1: 2.12 (pick → check → pack → load) in `wms/process-outbound` — 2.11 DONE, dependency satisfied
2. Lane 2: 4.1a (accounting core; also carries 4.2 part 2 — pg-reviewer confirms the SQLSTATE 23505 test in round 1) → 4.1b → 4.19 → 4.20 (ADR-0004)
3. Lane 3: awaiting the Master's next task assignment — 3.4 (delivery tasks/routes/POD) once 2.12 is DONE, per the earlier Next-3-tasks note
