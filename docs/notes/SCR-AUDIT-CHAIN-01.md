# SCR-AUDIT-CHAIN-01 — audit chain: hash coverage, external anchor, actor forgery (G-01 schema-change request)

**Status:** REQUESTED — filed 2026-09-27 by the consultant session under **EXECUTION-MASTER-v4 §1.11 (G-01)**, authorised by GM decision **D-193 D3 أ**. Nothing in `database/schema/*` changes until the request is applied by a numbered migration with a pre-migration review.

## 1 · Context (verified on `origin/main @ fc4c6d4`)
- `row_hash = sha256(prev_hash || occurred_at || user_id || table_name || record_id || operation)` — `database/migrations/0004_M_audit-chain-seq.sql:79,114`, implementing doc 31 §3-3 verbatim. `old_value`, `new_value`, `reason`, `entity_id` and `changed_fields` are outside the hash: an owner or superuser can edit audit content, or rewrite and re-hash the whole chain, and G8 stays green. The hash is unkeyed SHA-256 with no external anchor (G8 anchor storage is already open under D-115).
- `audit_append` (`0007:250`, requires `user_id = current_user_id()`) is a PERMISSIVE policy, so it is OR-ed with `audit_log`'s permissive `entity_scope FOR ALL` (`0003:201`, WITH CHECK from `0007:213`): `pgeos_app` can insert an audit row carrying any `user_id` whenever `entity_id` is null or in scope.
- Audit rows are written only by application code; `assignRole` (`packages/identity/src/rbac.ts:129`), sessions and OTP issue/verify write none.

## 2 · Requested deltas
| # | Object | Delta | Source | status |
|---|---|---|---|---|
| 1 | `platform.audit_log` policy `audit_append` | `AS RESTRICTIVE` (or `entity_scope` narrowed to FOR SELECT on this table) so the actor check cannot be bypassed by OR | 0007:250 · 0003:201 | requested — first, smallest migration |
| 2 | `platform.audit_log.row_hash` | hash every column in canonical form (jsonb of the row minus `row_hash`, delimiter-safe), doc 31 §3-3 amended | 0004:114 · doc 31 §3-3 | **doc 31 §3-3 amended to v4.2 by the GM (2026-09-27, D-194):** v2 = sha256 of the canonical jsonb of 20 named columns (`hash_version` first), `hash_version smallint not null` (2 for new rows; existing rows marked 1 without touching `row_hash`), `verify_audit_chain` recomputes per version, `hash_version_unknown` outside {1,2}; the migration may be written after the pre-migration review; the 13B-2 trigger text lands in the migration commit; `hash_version` classified `public` (G6) |
| 3 | chain head anchor | periodic signed export of the chain head outside the database (object-lock bucket or signed file), G8 verifies against it | D-115 (open) | approved in doc 31 v4.2 (D-194): period from `platform.thresholds`, head triple `(chain_seq, row_hash, occurred_at)` to an immutable store (object-lock bucket or a signed file handed to the GM), G8 `anchor_mismatch`; the GM may defer it; closes the G-01 item open since D-115 |
| 4 | identity audit | `assignRole`, session create/revoke, OTP issue/verify write `platform.audit_log` rows | rbac.ts:129 | requested — application change, no schema delta; built with 2.16 part 1a-5 |

## 3 · Open items
- Delta 2: doc 31 §3-3 v4.2 (2026-09-27, D-194) is the amended rule; the migration follows the pre-migration review.
- Deltas 1 and 4 need no document change and can be scheduled now (Master, pre-migration review on opus).
