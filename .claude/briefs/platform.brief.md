# `platform` — module brief (generated)

Generated 2026-09-22 by `scripts/gen-briefs.py` from the live schema (`175` tables, 14 schemas). **Do not hand-edit** — change the schema under G-01, then re-run the script.
Schema `platform` · tables in this module: 26 · default lane: M (doc 38 `Lane` column governs).

## 1. Where the rules are
- Build spec (governs on conflict): `docs/package/40-Build-Specification-EN.md` — Part B §B2–§B6 (Audit · Events & Outbox · Documents · Decisions/Automation/Thresholds/Flags · Alerts and Reports)
- Screens / boards / KPIs (binding): `docs/package/D-blueprints/07-Governance-Control.md (decisions, alerts, thresholds)`
- Screens / boards / KPIs (binding): `docs/package/D-blueprints/15-Focus-Boards-UX.md (platform.my_work — SCR-FB-01)`
- Table-level detail beyond this brief: `docs/package/D-blueprints/08-Data-Model-Maps.md`
- Schema source (the ONLY permitted schema): `database/schema/01 · 13 · 13B · 019`
- Client portal app `apps/portal`: doc 40 Part C §C10 · D-blueprints 11-Client-Store-Integration.md

## 2. Tables

| table | row purpose (obj_description) | entity_id | RLS policies |
|---|---|---|---|
| `alert_log` | — | no | internal_only |
| `alert_rules` | — | no | reference_read · reference_write |
| `approval_chains` | — | no | reference_read · reference_write |
| `audit_log` | — | yes | **RLS OFF — G7 red** |
| `audit_log_2026_09` | — | yes | entity_scope |
| `audit_log_2026_10` | — | yes | entity_scope |
| `audit_log_2026_11` | — | yes | entity_scope |
| `audit_log_2026_12` | — | yes | entity_scope |
| `audit_log_default` | — | yes | entity_scope |
| `automation_rules` | — | no | reference_read · reference_write |

`audit_log` (parent + partitions incl. default) — ADR-0002 (13B v4.3, migration `0004_M_audit-chain-seq.sql`): adds `chain_seq bigint not null`, assigned by the trigger after the advisory lock as previous + 1 (no sequence); unique index `<partition>_chain_seq_key` on every partition incl. default; trigger and verifier `SECURITY DEFINER` (owner superuser/BYPASSRLS), `TimeZone` UTC / `DateStyle` ISO,YMD pinned, `READ COMMITTED` required.
| `counters` | — | yes | reference_read · reference_write |
| `decisions` | — | yes | entity_scope |
| `document_bindings` | ط¸â€‍ط·آ§ ط·ع¾ط·آ¨ط¸ث†ط¸ظ¹ط·آ¨ ط¸â€ ط¸â€¦ط·آ§ط·آ°ط·آ¬. ط¸… | no | reference_read · reference_write |
| `document_templates` | — | yes | reference_read · reference_write |
| `documents` | — | yes | entity_scope |
| `domain_owners` | — | no | reference_read · reference_write |
| `domain_quality_monthly` | ط·آ¨ط·آ·ط·آ§ط¸â€ڑط·آ© ط·آ¬ط¸ث†ط·آ¯ط·آ© ط·آ§ط¸â€‍ط·آ¨ط¸ظ¹ط… | no | internal_only |
| `entities` | ط·آ§ط¸â€‍ط¸ئ’ط¸ظ¹ط·آ§ط¸â€ ط·آ§ط·ع¾ ط·آ§ط¸â€‍ط¸â€ڑط·آ§ط¸â€… | no | internal_only |
| `feature_flags` | — | no | reference_read · reference_write |
| `integration_config` | — | no | reference_read · reference_write |
| `integration_queue` | — | no | internal_only |
| `integration_runs` | — | no | internal_only |
| `notifications` | — | yes | entity_scope |
| `outbox` | ط·آµط¸â€ ط·آ¯ط¸ث†ط¸â€ڑ ط·آµط·آ§ط·آ¯ط·آ± ط¸â€¦ط·آ¹ط·آ§ط¸â€… | yes | entity_scope |
| `settings` | — | yes | reference_read · reference_write |
| `thresholds` | ط·آ§ط¸â€‍ط·آ­ط·آ¯ط¸ث†ط·آ¯ ط·آ§ط¸â€‍ط·آ¹ط·آ¯ط·آ¯ط¸ظ¹ط·آ© ط… | no | reference_read · reference_write |

## 3. Status columns and their allowed values (check constraints)

| column | allowed values |
|---|---|
| `decisions.status` | open · decided · expired · cancelled · auto_resolved |
| `documents.status` | issued · superseded · void |
| `integration_queue.status` | pending · processing · done · failed |
| `integration_runs.status` | running · success · failed · partial |
| `notifications.delivery_status` | sent · delivered · bounced · failed |

## 4. Document series and counters

| doc_type | prefix (per entity) |
|---|---|
| `DOC` | `PCC-DC-` |

Allocation is `platform.next_doc_no(entity_id, doc_type)` only — it is the atomic allocator guard G13 measures. Never format a document number in application code.
Sequences in `platform` owned by this module: `alert_log_id_seq` · `audit_log_id_seq` · `outbox_id_seq`.

## 5. Views and functions in this schema

- Views: `platform.mdm_scorecard` · `platform.my_work`
- Functions: `allowed_entities()` · `audit_hash_chain()` · `current_client_id()` · `current_user_id()` · `has_perm()` · `is_internal()` · `is_reference_table()` · `my_employee_id()` · `my_roles()` · `next_doc_no()` · `sanitize_audit()` · `set_stage_due_at()` · `verify_audit_chain()`
- `platform.verify_audit_chain(p_anchor_seq bigint default 1, p_anchor_prev_hash text default null)` returns `(chain_seq, id, occurred_at, problem, detail, expected_hash, actual_hash)` (doc 40 Part F G8); `problem` ∈ `hash_mismatch · prev_hash_mismatch · duplicate_chain_seq · chain_seq_gap · partition_missing_chain_seq_unique_index · definer_owner_cannot_bypass_rls · anchor_invalid · anchor_not_found`. `EXECUTE` revoked from `PUBLIC` on `audit_hash_chain()` and `verify_audit_chain()`.

## 6. Golden-slice counterpart paths

filled by bootstrap after 2.9 — every file this module delivers must have a counterpart in the golden slice `modules/wms/{domain,application,infrastructure,api,tests}/receive-inbound`. Replicate with `scripts/new-slice.sh platform <use-case>`; a hand-made file tree is a review FAIL.

## 7. How a worker uses this brief

- This brief replaces the package. Read a package document only where section 1 points to a section this brief does not already carry.
- A table, column or rule you need and cannot find here or in 01 / 13 / 13B / 019 / 40: **STOP and report** — file a schema-change request under EXECUTION-MASTER-v4 §1.11 (G-01). Never invent one.
- Write only inside the paths the slice brief's `Write ONLY` line names. This module's home is `modules/platform/` (+ `tests/`).
- Domain events go to `platform.outbox` in the same transaction as the state change; `platform.domain_events` is retired.
