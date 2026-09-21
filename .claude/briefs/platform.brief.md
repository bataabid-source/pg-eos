# `platform` — module brief (generated)

Generated 2026-09-21 by `scripts/gen-briefs.py` from the live schema (`175` tables, 14 schemas). **Do not hand-edit** — change the schema under G-01, then re-run the script.
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
| `counters` | — | yes | reference_read · reference_write |
| `decisions` | — | yes | entity_scope |
| `document_bindings` | لا تبويب نماذج. كل مستند مربوط بعملية وانتقال حالة يولّده… | no | reference_read · reference_write |
| `document_templates` | — | yes | reference_read · reference_write |
| `documents` | — | yes | entity_scope |
| `domain_owners` | — | no | reference_read · reference_write |
| `domain_quality_monthly` | بطاقة جودة البيانات الشهرية لكل مجال D01–D12 — مصدر التنب… | no | internal_only |
| `entities` | الكيانات القانونية. الشركة القابضة (holding) جذر الشجرة و… | no | internal_only |
| `feature_flags` | — | no | reference_read · reference_write |
| `integration_config` | — | no | reference_read · reference_write |
| `integration_queue` | — | no | internal_only |
| `integration_runs` | — | no | internal_only |
| `notifications` | — | yes | entity_scope |
| `outbox` | صندوق صادر معامَلاتي — 40 §B3. يُكتب في نفس معاملة تغيير… | yes | entity_scope |
| `settings` | — | yes | reference_read · reference_write |
| `thresholds` | الحدود العددية التي يحرّرها المدير العام بلا نشر (40 §B5)… | no | reference_read · reference_write |

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

## 6. Golden-slice counterpart paths

filled by bootstrap after 2.9 — every file this module delivers must have a counterpart in the golden slice `modules/wms/{domain,application,infrastructure,api,tests}/receive-inbound`. Replicate with `scripts/new-slice.sh platform <use-case>`; a hand-made file tree is a review FAIL.

## 7. How a worker uses this brief

- This brief replaces the package. Read a package document only where section 1 points to a section this brief does not already carry.
- A table, column or rule you need and cannot find here or in 01 / 13 / 13B / 019 / 40: **STOP and report** — file a schema-change request under EXECUTION-MASTER-v4 §1.11 (G-01). Never invent one.
- Write only inside the paths the slice brief's `Write ONLY` line names. This module's home is `modules/platform/` (+ `tests/`).
- Domain events go to `platform.outbox` in the same transaction as the state change; `platform.domain_events` is retired.
