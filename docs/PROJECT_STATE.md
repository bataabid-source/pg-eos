# PROJECT_STATE — PG-EOS

**Hard limit: 40 lines.** Older history lives in `docs/CHANGELOG.md` (CLAUDE.md · QUOTA DISCIPLINE v5). Maintained by pg-scribe only, in the same commit as the task it records.

| field | value |
|---|---|
| Phase | 0 CLOSED · 1 Commercial Core (done except 1.11, BLOCKED D-178) · 2 Warehouse (9/19) · pilot-first (D-127): seed 019 + synthetic data. Doc 38 **v4.6 (154 rows, D-187/ADR-0004)**. |
| Current task | Lane 1: 2.11 parts 1–4 DONE (`a96b013`, `156b042`, `f30f7c7`, `3fadbde`); row IN PROGRESS — condition 10 BLOCKED (G-01 SCR-WMS-OUT-02) → 2.12 (recorded default). Lane 2: 2.9b DONE @ `716bf8e` → 4.2 `billing.billable_events` (D-186) brief+RED only until wave 1 merges; then accounting core 4.1a→4.1b→4.19→4.20 (SCR-ACC-01, A2). Lane 3: 3.17 part 1 DONE-in-part @ `ca7f6f1` → 3.1 `fleet` (D-184) pending Master's `tms` claim. P1 governance cleanup (this commit): deletion pass on superseded notes/briefs/sheets. |
| Golden slice / tier / schema / session model | 2.9 ACCEPTED (`.golden-slice-accepted`, `scripts/new-slice.sh` active) · Pilot Tier 0 = local Docker `postgres:16` (D-129), Oracle DEFERRED-POST-PILOT · migrations 0001–0025 applied (0022 withdrawn), next free **0026** · D-174/D-180 session model: lane sessions sonnet/medium, Master sonnet/medium (opus only ADR/security/D-117), pg-reviewer opus, no haiku |

## Lanes

| lane | task | module lock | worktree |
|---|---|---|---|
| 1 | 2.12 pick → check → pack → load (2.11 row blocked only on condition 10, G-01 SCR-WMS-OUT-02) | `wms/process-outbound` + `wms/receive-inbound` | `../pg-eos-lane-1` |
| 2 | 4.2 `billing.billable_events` (D-186) — brief+RED until wave 1 (P1, P7) | `billing` | `../pg-eos-lane-2` |
| 3 | 3.1 `tms.vehicles` + docs + expired-doc gate (D-184) | `fleet` | `../pg-eos-lane-3` |

## Last 5 DONE (newest first)
| task | commit |
|---|---|
| 2.11 part 4 — the two deferred describe/scenario naming gaps (lane 1), DONE-in-part — PASS(0) | `3fadbde` |
| 2.11 part 3 — describe/Gherkin naming sweep + 2.4 picker fix + fixture leak-proofing (lane 1), DONE-in-part | `f30f7c7` |
| 2.11 part 2 — outbound allocation: Allocate/GeneratePickList/cancel-release, single-lot FEFO/FIFO (lane 1), DONE-in-part | `156b042` |
| 2.11 part 1 — outbound order create/checks (9 of 10)/approve/cancel (lane 1), DONE-in-part | `a96b013` |
| 2.9b — schedule inbound + logistics terms, migration 0023 (lane 2), DONE | `716bf8e` |

## Blockers

- `scripts/deploy.sh` missing (G15–G17 NOT RUNNABLE, non-blocking, 0.6b DEFERRED-POST-PILOT). Open G-01 items: G8 anchor storage (≥2028-03, D-115); 3.14/3.17 imile tables missing `entity_id`/CHECKs/outbox (`docs/notes/2026-09-24-imile-agent-scenario.md` §4); 2.15 `space_reservations.qty` no DB CHECK.
- The two 0.9 WIP branches (`claude/postgresql-16-254336` @ `0217e85`, `claude/resume-4c8ecc` @ `f127ab2`) are never merged, never deleted.
- Batched Master tasks (frozen paths): `entityId` on `WithContextCtx`; SCR-HR-EMP-01 three DB CHECKs; `packages/domain-kit` browser break (node:crypto in browser bundle); root `eslint.config.mjs` cwd bug; `packages/i18n` bootstrap (never created — SCR-I18N-01 §1; 2.11/2.9b keys code-referenced only). D-125 cleanup still open (D-132 disposition, `docs/DECISION_LOG.md`): G1/G2 biometric-retention wording (doc 40:668, doc 25:429) needs a GM-set value, none invented; G3 diagram `01-08.mmd/.svg` not regenerated (needs the mermaid renderer).
- WBS 1.11 BLOCKED (D-178) — see `docs/notes/2026-09-25-wbs-1.11-premature.md`. Pre-existing, untouched: ~7 failures in `tests/evaluate-alerts/**` + `tests/integration/{schema-invariants,audit-chain-*}.test.ts`; 8 `tests/receive-inbound` failures from orphaned `wms.locations` (`T9-*`) fixtures.

## Next 3 tasks

1. Lane 1: 2.12 (pick → check → pack → load) in `wms/process-outbound`; 2.11 condition 10 awaits G-01 SCR-WMS-OUT-02
2. Lane 2: 4.2 (`billing.billable_events`) → accounting core 4.1a → 4.1b → 4.19 → 4.20 (ADR-0004)

3. Lane 3: 3.1 (`tms.vehicles`) in module `fleet` — then 3.4 once 2.12 is DONE
