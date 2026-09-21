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
| State/backlog/CHANGELOG/i18n/renames        | pg-scribe      | haiku   | ≤ 10k                                      |
| Single-file edit ≤ 30 lines, no new logic   | Master, direct | session | —                                          |
| Planning, briefs, locks, merges, commits    | Master, direct | session | —                                          |
| ADR / architecture / security design        | Master on opus | opus    | —                                          |
| Task failed twice on sonnet                 | Master on opus | opus    | —                                          |

Budget is enforced by the brief: a brief whose "Read ONLY" list exceeds 12 files or 1,500 lines is split into two slices. pg-reviewer flags any delegation whose report shows reads outside the list.

Agents are pinned in `.claude/agents/`: pg-reviewer=opus · pg-backend/pg-frontend/pg-tester=sonnet
· pg-scribe=haiku. `inherit` is forbidden; an unsupported alias is REPORTED, never silently
replaced. Escalation is upward only (sonnet → opus) and only after two failures, for an ADR or
a security design, or for the WBS 2.9 session. Expected token distribution (EXECUTION-MASTER-v4
Part 4): ~75% sonnet (workers) · ~10% haiku (scribe) · ~10% opus (review) · ~5% session.
