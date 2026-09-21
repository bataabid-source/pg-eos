# CHANGELOG — PG-EOS repository

One entry per completed task, newest first (CLAUDE.md · GIT · DOCUMENTATION). Each entry: WBS ID · what changed · Model · Delegated · Review · tokens (estimate). History that leaves `docs/PROJECT_STATE.md` lands here.

---

## BOOTSTRAP-001 — kit verified and completed per BOOTSTRAP-v5 §9 (2026-09-21)

- Verified, nothing re-derived: 5 agents (`opus` ×1 · `sonnet` ×3 · `haiku` ×1; `inherit` = 0; each has `tools:`, the AGENT CONSTRAINTS block and the REPORT format) · 6 commands (13–30 lines, all ≤ 40) · 15 module briefs + `_TEMPLATE` (max 94 lines, all ≤ 120 — pre-generated; **not regenerated from the live schema: psql absent**) · `settings.json` valid JSON · hooks and scripts pass `bash -n` · `scripts/new-slice.sh` prints "golden slice not accepted yet" · `.gitignore` carries the 7 v4 §9 patterns and does NOT ignore `.golden-slice-accepted` · `DECISION REQUIRED` = 0 · MASTER_BACKLOG has 2.9 with its doc-38 criterion · LANE_LOCKS empty · 4 tasks in `tasks/proposed/` WAITING_GM · MODEL_ROUTING carries the §4 table · no `.env`, no credentials · `scripts/check-setup.sh` → FILES READY.
- Recorded: SETUP-000 = `bab005a` in PROJECT_STATE (exactly one DONE with a hash).
- **NOT RUN (environment, not a code blocker):** `database/schema/apply.sh --recreate` — Docker Desktop and psql 16 absent on the GM machine; expected on first run: zero errors · 175 tables · G7 = 0 · G-SEED = 0. `pnpm lint` cross-module-import FAIL test — pnpm absent; it is the acceptance criterion of 0.4 (doc 38) and is delivered there, not duplicated here (default taken, per BOOTSTRAP-v5 §2 "state one default, record it, proceed").
- Unsupported aliases: none reported (aliases are declared in the agent files; they are exercised on first delegation).
- Model: session (claude-fable-5-1, Master direct — state files only) · Delegated: none · Review: n/a (no code) · tokens: ≈ 45k.

## SETUP-000 — repository initialised from package v4 (2026-09-21)

- `docs/package/` ← PG-EOS-v4: A-governing (9 md) · B-reference (26 md) · C-tools → `tools/` · D-blueprints (16 md + `diagrams/` 172 mmd + 153 svg + `tools/`) · root docs (00-README-v4 · AUDIT-REPORT-v4 · CHANGELOG-v4). PNG renders omitted (svg kept) to keep the repository light.
- `database/schema/` ← `01 · 13 · 13B · 019 · guards.sql · apply.sh` — the ONLY permitted schema (175 tables · 16 views · 14 schemas; expected `apply.sh --recreate`: zero errors · G1–G13 = 0 · G7 = 0 · G-SEED = 0).
- Kit at root (CLAUDE.md · `.claude/` · `scripts/` · `tasks/` · `docs/` · `infra/` · `.gitignore`) as shipped in `claude-kit/`.
- **Added by setup (were reported missing by the `/resume` pre-check):** `tasks/MASTER_BACKLOG.md` (132 rows generated from doc 38 by `scripts/gen-backlog.py`, statuses seeded: 0.1 DONE pre-build · lane A WAITING_GM · 0.4 READY · rest TODO) · `docs/DECISION_LOG.md` (seeded from EXECUTION-MASTER-v4 Part 1, zero open markers) · this file · `tasks/{backlog,active,completed,blocked}/` · `docs/notes/` · `scripts/check-setup.sh` · `scripts/gen-backlog.py`.
- Model: n/a (no agent session) · Delegated: none · Review: n/a · tokens: 0 (done outside Claude Code).
- Remaining before BOOTSTRAP-001: install pnpm / Docker Desktop / psql 16 on the GM machine (PROJECT-SETUP-GUIDE §1); run `bash scripts/check-setup.sh` → `docker compose … up -d postgres` → `database/schema/apply.sh --recreate` (§3) → the bootstrap prompt (§4).
