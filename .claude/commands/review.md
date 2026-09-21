---
description: Run pg-reviewer on a slice without a build — used after manual fixes.
argument-hint: "<path>  e.g. modules/wms/application/receive-inbound"
allowed-tools: Read, Grep, Glob, Bash(git diff:*), Bash(git log:*), Bash(pnpm test:*)
model: sonnet
---
Delegate to the **pg-reviewer** agent (opus) a review of `$1`, with no build step.

Give the reviewer, and nothing more:
- the brief that produced this slice (or, if there is none, the paths under `$1` plus `.claude/briefs/<module>.brief.md`);
- `git diff` for those paths;
- the latest test and `scripts/guards-run.sh` output.

The reviewer applies doc 36 §5-4 literally plus the RLS / SoD / secrets / routing-trailer / brief-compliance / golden-slice-shape checks in `.claude/agents/pg-reviewer.md`.

Return its verdict unchanged: `PASS` or `FAIL (<n> findings)` with the numbered findings. Do not fix anything here, do not argue with a finding, and do not mark the task DONE — a slice with an open finding is not DONE.
