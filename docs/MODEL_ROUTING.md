# MODEL_ROUTING — which agent, which tier, which budget

The routing table of BOOTSTRAP-v5 §4 ("ROUTING TABLE (unchanged) + TOKEN BUDGET (new)"),
copied verbatim, budget column included. The Master selects from it for every delegation
and records `Model:` and `Delegated:` in the commit; pg-reviewer flags any slice whose
trailer is missing or whose tier contradicts this table.

| Work type                                   | Agent          | Tier    | Budget guide (input tokens per delegation) |
|---------------------------------------------|----------------|---------|--------------------------------------------|
| Golden slice 2.9 build                      | pg-backend     | sonnet  | ≤ 60k (brief + golden files only)          |
| Golden slice 2.9 review                     | pg-reviewer    | opus    | ≤ 40k                                      |
| Replicated backend slice                    | pg-backend     | sonnet  | ≤ 40k                                      |
| UI slice from contract + D-blueprint screen | pg-frontend    | sonnet  | ≤ 40k                                      |
| Tests, guards, mutation                     | pg-tester      | sonnet  | ≤ 30k                                      |
| Slice review                                | pg-reviewer    | opus    | ≤ 30k                                      |
| State/backlog/CHANGELOG/i18n/renames        | pg-scribe      | sonnet  | ≤ 10k                                      |
| Single-file edit ≤ 30 lines, no new logic   | Master, direct | session | —                                          |
| Planning, briefs, locks, merges, commits    | Master, direct | session | —                                          |
| ADR / architecture / security design        | Master on opus | opus    | —                                          |
| Task failed twice on sonnet (unsplittable finding only — REVIEW CAP, D-186/P7) | Master on opus | opus    | —                                          |

Budget is enforced by the brief: 8 files / 1,000 lines (CLAUDE.md · OPERATING RULES · SPLIT BEFORE, NOT AFTER). pg-reviewer flags any delegation whose report shows reads outside the list.

Agents are pinned in `.claude/agents/`: pg-reviewer=opus · pg-backend/pg-frontend/pg-tester/pg-scribe=sonnet.
`inherit` is forbidden; an unsupported alias is REPORTED, never silently
replaced. Escalation is upward only (sonnet → opus) and only after two failures, for an ADR or
a security design, or for the WBS 2.9 session. Expected token distribution (EXECUTION-MASTER-v4
Part 4): ~85% sonnet (workers + scribe) · ~10% opus (review) · ~5% session.

**D-117 (GM, 2026-09-23) — standing permission for the two-failures escalation.** When a slice's
review FAILs twice on the same worker (CLAUDE.md · OPERATING RULES · REVIEW CAP — only for a finding that cannot be split: security, audit chain, RLS; it is the last round), the Master switches
its own session to `/model opus` for the fix step only, then returns to whatever model tier the
session was on before — no question asked each time this happens, this permission is standing. If
the Master's session was already on a tier other than opus by explicit user instruction (e.g. the
user ran `/model claude-sonnet-5` for the session), that instruction governs unless the Master
actually switches per this standing permission; a fix made without switching is recorded honestly,
not misreported as opus. (WBS 2.6's round-3 fix ran on sonnet, not opus, because the switch was not
made in that session — accepted as recorded in `docs/CHANGELOG.md`, not redone.)
