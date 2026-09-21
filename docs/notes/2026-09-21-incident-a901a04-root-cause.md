# Incident a901a04 — root cause (2026-09-21)

**What happened.** At 22:19 local, commit `a901a04` ("chore: cleanup") deleted the WBS 0.4 monorepo skeleton
(`package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig*`, `eslint.config.mjs`, `apps/`, `modules/`,
`packages/`, `tests/`) and moved untracked `node_modules/`, `.turbo/` and the in-progress 0.13 files to
`../_TO_DELETE/`. The running Claude Code session reverted it (`1bc09f7`) and re-did 0.13 (`50055f8`).

**Root cause (identified).** The deletion was performed from *outside* Claude Code — a Cowork (desktop)
session acting on the parent folder `New sys/` was asked to "isolate files not needed by the project". It
misread the 0.4/0.13 build output as leftovers from an old project because it only knew the SETUP-000 state,
and it did not check `git log` before moving files. It was not a tool, hook, or agent inside this repository.

**Resolution.** No permanent loss: everything tracked was restored by the revert; untracked 0.13 work was
re-created by the session. `../_TO_DELETE/` now holds only duplicates and may be deleted by the GM.

**Rule going forward (GM + any external assistant).** Never reorganise, "clean", or move files inside
`claude-kit/` from outside a Claude Code session. The repository's own hygiene is governed by `.gitignore`,
`scripts/check-setup.sh`, and pg-scribe. The blocker "concurrent external processes" in
`docs/PROJECT_STATE.md` can be closed by pg-scribe on the next state update, citing this note.
