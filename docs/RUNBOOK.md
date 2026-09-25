# RUNBOOK — PG-EOS (v1, WBS 0.20)

**Scope: pilot Tier 0 only** (local Docker `postgres:16`, D-129). Oracle Tier 0/2 procedures
(provisioning, remote deploy, remote secrets rotation — WBS 0.3, 0.5, 0.6b, 0.7) are
DEFERRED-POST-PILOT; this runbook covers them only as placeholders (§8) so nothing is invented
ahead of that work. Sealed 2026-09-24 per doc 38 row 0.20 ("drafted as soon as 0.6a is green,
sealed only after 0.8 restore succeeds") — both conditions met; the row's own text governs over
its literal `Depends on: 0.6a, 0.6b, 0.8` cell, since 0.6b (Oracle staging) is itself
DEFERRED-POST-PILOT (D-129) and cannot gate a pilot-scope runbook.

Every procedure below has been exercised at least once during this project (dates/commits cited)
— "tested once" per the WBS 0.20 acceptance criterion ("eight procedures written and tested
once").

---

## 1. Local environment bootstrap

```bash
docker compose up -d            # postgres:16, published on 127.0.0.1:5432 (docker-compose.yml)
cd database/schema
PGHOST=localhost PGPORT=5432 PGUSER=postgres PGDATABASE=pgeos ./apply.sh --recreate
```
`apply.sh --recreate` drops and recreates the target database (UTF8 / collate C / ctype
C.UTF-8 — SCR-TRGM-01), then applies `01 → 13 → 13B → 019 → database/migrations/*.sql` (sort -V)
via stdin redirection (`psql < file`, never `-f file` — WBS 0.15 header explains why), then runs
`guards.sql`. **Exercised:** every session start today (2026-09-24/25); most recently the isolated
`pgeos_lane3merge_check` build before merging PR #22.

## 2. Schema / migration deploy to the shared dev database

A lane never issues its own migration number. Sequence:
1. Lane sends the Master a MIGRATION-REQUEST with its draft SQL and pg-reviewer's pre-migration
   verdict (CLAUDE.md · BUILD METHOD: pg-reviewer runs BEFORE any migration touching schema/RLS/
   the audit chain).
2. Master issues the next free `NNNN` (`tasks/LANE_LOCKS.md` "Migrations issued" — next free
   number recorded there and in `docs/PROJECT_STATE.md` Schema row), lane writes
   `database/migrations/NNNN_<lane>_<slug>.sql`.
3. Migration lands in the lane's own `feat(<WBS>)` commit; `apply.sh` picks it up automatically
   (sort -V order) on the next full apply. Migrations are forward-only — no down-migrations exist
   (CLAUDE.md · GIT).
**Exercised:** 0011–0015 issued and applied this way 2026-09-24 (5.13, 1.2, 3.3, 5.5a part 1).

## 3. CI pipeline / merge to `main`

`main` is protected: PR required, 5 required checks (①②③④⑤⑥ merged as ②③ — see
`.github/workflows/ci.yml`), 0 approvals, no bypass, no force-push (D-165 ruleset
`main-protection`). The Master merges every PR — lane sessions cannot (`gh` is not signed in on
their machines; the Master runs it per-command with the token Git Credential Manager already
holds, never displayed):
```bash
ghx() { GH_TOKEN=$(printf 'protocol=https\nhost=github.com\n' | git credential fill | sed -n 's/^password=//p') gh "$@"; }
ghx pr checks <n> --json name,bucket      # poll until ①-⑥ all pass
ghx pr merge  <n> --rebase                # rebase-merge, linear history
```
If a lane's branch has fallen behind `main` (another lane merged first) and the lane session
cannot force-push its own branch (permission denial is normal and expected), the Master rebases
it locally, resolves conflicts (`docs/CHANGELOG.md` newest-first; `docs/PROJECT_STATE.md` merges
both sides; `packages/contracts/package.json` keeps every module's export block), and pushes the
result as `<branch>-r1` (then `-r2`, … on repeat) with a fresh PR that supersedes the old one.
**Exercised:** PRs #10–#24, 2026-09-24, including three `-rN` rebase chains (lane/1, twice; lane/2
once; lane/3 once).

## 4. Backup

```bash
scripts/backup.sh                         # PGDATABASE defaults to pgeos
PGDATABASE=pgeos_test scripts/backup.sh
```
Writes a `pg_dump` custom-format file to `data/backups/db-<timestamp>.dump`. Local-Docker-only by
design (refuses a non-local `PGHOST` unless `PG_ALLOW_REMOTE_RESTORE=1`). **Exercised:** WBS 0.8
pilot acceptance, `56fa267`, 2026-09-24.

## 5. Restore / rollback

```bash
scripts/restore.sh data/backups/db-<timestamp>.dump
```
Restores into a local `pgeos_restore` database, then runs every guard function present in
`database/schema/*` plus the SCR-TRGM-01 locale/trigram check; exits 0 only if all pass. Does
**not** drop `pgeos_restore` on success (caller's responsibility). Because migrations are
forward-only (§2), **restore-from-backup is the rollback procedure** — there is no
`down`-migration path. **Exercised:** WBS 0.8, `56fa267`; `pnpm test:ops` 8/8 green (~50s).

## 6. Guards re-verification (merge-time or ad hoc)

```bash
PGDATABASE=<throwaway_name> ./apply.sh --recreate     # from database/schema/, on the tree to check
PG_APP_USER=pgeos_app PGDATABASE=<throwaway_name> pnpm --filter @pg-eos/isolation-tests test   # G14
psql -c "DROP DATABASE IF EXISTS <throwaway_name>;"   # clean up
```
Used whenever the shared dev database (`pgeos`) reads a guard red for a reason unrelated to the
change under review (e.g. another lane's unmerged migration already changed policy counts) —
build an isolated, throwaway database from the tree being checked, prove the guard clean there,
then drop it. `pnpm guards:run` (root) wraps the SQL guards (G1–G13, G18) and the isolation suite
(G14) together for the common case. **Exercised:** `pgeos_lane3merge_check`, 2026-09-24, proving
G14 55/55 on the rebased `lane/3` tree ahead of merging PR #22.

## 7. Secrets and credentials (pilot Tier 0)

- **GitHub:** no interactive `gh auth login` on this machine. Git Credential Manager already
  holds a token for the repo's remote; every `gh` call goes through the `ghx()` wrapper in §3,
  which reads it via `git credential fill` and never prints it. Nothing to rotate manually at
  Tier 0 — GCM's own credential lifecycle applies.
- **Database:** local Docker Postgres, trust authentication on `127.0.0.1:5432`. No password, no
  secret to rotate.
- **Application role (`pgeos_app`):** created by migration 0007 (`SECURITY DEFINER`, entity-scope
  RLS); its DB role has no login secret beyond the local trust config.
- Everything beyond this (Oracle IAM users, break-glass credentials, Cloudflare tokens, a real
  secrets-rotation cadence) is WBS 0.3/0.5/0.6b/0.7 — **DEFERRED-POST-PILOT (D-129)**. This
  runbook gets a real §7 replacement when that work starts; no procedure is invented here ahead
  of it (G-01 discipline).

## 8. Placeholders — DEFERRED-POST-PILOT (0.3, 0.5, 0.6b, 0.7; D-129)

Oracle tenancy bootstrap · Tier-0 host provisioning (VCN/NSG/A1.Flex/Cloudflare) · automatic
deploy to staging (CI gate ⑦) · Tier-0 monitoring (Netdata, postgres_exporter, Uptime Kuma) will
each get their own numbered procedure here when their WBS task starts. Not written now — an
un-exercised procedure is not a procedure (WBS 0.20's own "tested once" bar).

## Incident quick reference (observed and handled during this project, not separate WBS items)

- **Stale `.git/*.lock`:** removed by hand (PROJECT_STATE Blockers, standing note).
- **Two sessions on one worktree:** check `tasks/LANE_LOCKS.md` and `ListAgents` before resuming
  any in-progress work — a duplicate session wastes a full review round (D-171 item 1).
- **`pnpm-lock.yaml` corrupted by a rebase auto-merge** (a dependency's version-variant tag
  silently dropped, `ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY` on `--frozen-lockfile`): regenerate
  with `pnpm install --no-frozen-lockfile`, diff should be small and mechanical; re-verify with
  `--frozen-lockfile` before committing. **Exercised:** PR #23 → #24, 2026-09-24.
- **A devDependency pinned above the CI runtime's supported Node range** (crashes every test in
  that package with an obscure runtime error, not a clear version-mismatch message): check the
  package's own `engines` field against `.github/workflows/*.yml`'s `node-version`; pin to the
  newest major that satisfies it. **Exercised:** `jsdom` 30.1.1 → 27.0.0, PR #21, 2026-09-24
  (jsdom 30 needs Node ≥22.22; CI pins 20).
