# SCR-TRGM-01 — pg_trgm produces no trigrams for Arabic under `lc_ctype = C`: duplicate detection on `name_ar` never fires

**Status: RESOLVED — option A** (GM reply "نفذ" to the Master's recommendation, 2026-09-23): databases are created with UTF8, `lc_collate = C`, `lc_ctype = C.UTF-8` (`database/schema/apply.sh`, `infra/docker/docker-compose.yml`, doc 42 v4.1 §4.2/§6.3/§9). Raised under EXECUTION-MASTER-v4 §1.11 (G-01; environment/DDL).
Date: 2026-09-23 · Raised during WBS 1.5 (phase D of the GM directive of 2026-09-23) by the migration-gate review of 0006
(pg-reviewer open question 1), measured by the Master.
Blocks: WBS 1.5 acceptance "duplicate detection fires" (doc 38) for Arabic names; doc 40 §C2 INV-C2-3 ("Duplicate detection on
`cr_number` and name similarity ≥ 0.85 (pg_trgm)"); the weekly duplicate report of doc 22 §5.

## 1. Measurement (PostgreSQL 16.15, local Docker, 2026-09-23)

Every database of the cluster is `encoding UTF8, datcollate C, datctype C` (`pg_database`; `apply.sh` runs a plain
`createdb "$PGDATABASE"`, which inherits the cluster default). Same UTF-8 file, `PGCLIENTENCODING=UTF8`:

| Database ctype | `similarity()` identical Arabic names | one final letter changed (ة/ه) | two different names | `show_trgm('مخزن')` |
|---|---|---|---|---|
| `C` (today: pgeos) | **0** | **0** | 0 | `{}` |
| `C.UTF-8` (scratch database) | 1 | 0.818 | 0.057 | 5 trigrams |

pg_trgm keeps only characters its `t_isalnum` accepts; under the C ctype no Arabic letter is alphanumeric, so every Arabic string has
zero trigrams and `similarity()` is 0. `sales.possible_duplicates` compares `name_ar` only (13B §13B-19), so its name branch can
never fire on real Arabic client names; only the `cr_number` branch remains, and that one the partial unique index already closes.
Latin text is unaffected (the synthetic pair `premiumlogistics` / `premiumlogistics co` measures 0.85 under both ctypes).

## 2. Why this is not fixed inside 1.5

The ctype of a database is fixed when the database is created. Changing it touches `database/schema/apply.sh` (frozen path) and the
database-creation step of the deployment (docker-compose / doc 42 Tier 0), and changes character classification for every text
function in every schema (upper/lower, regex classes, pg_trgm, full-text). That is an environment decision with effects beyond M02.
Writing the 1.5 proof with Latin names only would make "duplicate detection fires" true in the test and false for every real client.

## 3. Options for the GM

| # | Change | Effect | Cost |
|---|---|---|---|
| A | Create the database with `LC_CTYPE = 'C.UTF-8'`, keep `LC_COLLATE = 'C'` (`createdb -T template0 -E UTF8 --lc-collate=C --lc-ctype=C.UTF-8`); same in the deployment's database creation | Arabic trigrams, `upper/lower` and regex classes work; sort order (`C` collation) and existing indexes behave exactly as today | `apply.sh` + deployment step; every environment rebuilt with `--recreate` (no production data exists yet); CHANGELOG-v4 + doc 42 note |
| B | Keep `C`; add a normalised/transliterated name column for matching | Works under any ctype | New column (G-01), a normalisation rule nobody has written, a trigger, classification — larger and invents a business rule |
| C | Accept: name matching is Latin-only; rely on `cr_number` | No change | INV-C2-3's name branch never fires for Arabic names — the rule is not implemented |

Master recommendation: **A** (smallest change; the collation, and so every ordering and index, stays `C`).

## 4. Resolution (2026-09-23)

- `apply.sh --recreate` creates the database from `template0` with UTF8 / collate C / ctype C.UTF-8 and refuses any database created otherwise; the local compose initialises new clusters the same way; doc 42 v4.1 adds the same settings to the Tier-0 compose and to `restore.sh`, plus a behaviour check at WBS 0.5 and 0.8 (the locale name alone proves nothing).
- Measured after the rebuild: `pgeos` = C.UTF-8|C; Arabic trigrams present; the 1.5 proof runs every name scenario on Arabic names.
- Every environment must be rebuilt with `apply.sh --recreate` (no production data exists yet).
- Image parity decided by the GM 2026-09-23 (D-105): `postgres:16` (Debian/glibc) is canonical for dev and Tier 0 — doc 42 v4.2 §4.2 / §9.
