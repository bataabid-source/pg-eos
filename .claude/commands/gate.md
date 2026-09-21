---
description: Run gates ①–⑤ locally and print one verdict table. No edits.
allowed-tools: Read, Grep, Glob, Bash
model: sonnet
---
Run the first five of the seven named gates (CLAUDE.md · DEPLOYMENT PIPELINE; doc 36 §4-3) on the current working tree, then print one table and nothing else.

  ① `pnpm lint` — lint + module boundaries + strict types (a cross-module import MUST fail)
  ② `pnpm test --filter <touched module>` — domain unit tests
  ③ `pnpm test:integration` — integration on an ephemeral database
  ④ `pnpm playwright test tests/scenarios` — the doc 40 Part E scenarios (S1–S20)
  ⑤ `bash scripts/guards-run.sh` — guards G1–G18

Gates ⑥ security scan and ⑦ images + migrations run in CI only; print them as `CI-only`.

Verdict table columns: `gate | command | result | first failure`.
Pass condition for ⑤ is the one in CLAUDE.md · TESTING: G1–G17 zero rows or the stated condition (G13 100 unique · G15 all scenarios pass · G16 ≥ 75% · G17 ≤ 2 s); G6 is non-blocking until WBS 0.16 is closed; G18 and G-SEED are report-only.

Any red step stops the pipeline — say so plainly and name the one failure that matters. Do not fix anything in this command.
