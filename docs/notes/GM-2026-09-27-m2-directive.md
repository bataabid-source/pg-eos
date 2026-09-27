# GM directive to Master M2 (D-195) — corrections approved 2026-09-27

Source: the GM's opening brief of «الماستر M2 — طابور الدمج والموجة 1» (2026-09-27). The Master proposed the corrections below against the repository as found; the GM approved them verbatim: "موافق / معتمد". This file is the directive as it now reads where it differs from the brief; everything not listed here stands as the GM wrote it.

| # | Brief said | Corrected to (evidence) |
|---|---|---|
| 1 | "Open PRs: docs/gov and lane/3-s18" | No PR was open. Two branches without a PR: `docs/gov` (41 behind main, 2 ahead) and `lane/3-s18` (7 behind, 1 ahead). Each: rebase on main → new PR → review → rebase merge. |
| 2 | "gh through `ghx` (Git Credential Manager)" | `ghx` applies to local sessions only; a cloud Master has no `gh` binary and uses the session's GitHub tools for PRs, checks and rebase merges (same merge-queue rule, RUNBOOK §3). |
| 3 | "Move Stryker/G16 to nightly" | `.github/workflows/nightly.yml` already runs every module's G16. D6 is therefore the removal of the per-PR full run from `scripts/guards-run.sh` (gate ⑤), scoped to the modules whose `domain/` changed. |
| 4 | (locks) | The rows `pda` (lane 1) and `billing` (lane 2) have no running session (build lanes frozen); they are released in the D6 commit and re-claimed when a lane opens. |
| 5 | "Cache the gate ⑦ image layers (16 min today)" | The gha layer cache already exists; the cost is `COPY . .` before `pnpm install` (every code change re-installs) plus a `chown -R` layer, under QEMU for arm64. D6 splits a lockfile-only `pnpm fetch` layer and drops the `chown -R`. A target figure (⑦ ≤ 8 min on a PR without a lockfile change) or an arm64 build moved to nightly is a GM decision, not taken here. |
| 6 | (budget) | Every Master merge report states the GitHub Actions minutes consumed this month; at 70 % of the plan's quota the Master opens no new lane and reports. |
| 7 | "X part 6 → 10" (item 5) | X part 6 is D6 itself (item 0); item 5 reads "X part 7 → 10". |
| 8 | Condition B "S1/S2 over HTTP" | Evidence: `tests/scenarios/green.json` lists S1 and S2 and gate ④ passes them in CI on the merge commit. |

Unchanged: the six-file reading list, one slice at a time, the lane-opening request format, the three-session ceiling, the GM's reserved decisions (ADR, money, production, branch deletion outside the merge rule).
