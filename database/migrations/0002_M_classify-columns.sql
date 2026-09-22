-- ═══════════════════════════════════════════════════════════════════════════
-- PG-EOS · 0002 · Lane M — bulk rule-based column sensitivity classification
-- Forward-only migration · PostgreSQL 16 · 22/09/2026 · ROUND 2 (pg-reviewer FAIL(11) rework)
--
-- Source: WBS 0.16 (identity.column_classification + deploy guard). Doc 40
--         Part F, G6: "column_classification must cover every column; deploy
--         fails otherwise." Table DDL: database/schema/01-Data-Model.sql:289-295
--         (frozen, already applied — this migration only inserts rows, it
--         never touches 01/13/13B/019).
--
-- ── Which "G6" governs: two different queries exist in this repo ──────────
-- database/schema/guards.sql (lines 59-72) defines G6 as a RAW query over
-- information_schema.columns for the 14 business schemas, with no join to
-- pg_class/pg_namespace — it counts every column of every relation
-- information_schema exposes, including VIEWS. On this database that query
-- returns 2605 unclassified rows.
--
-- identity.unclassified_columns (a helper VIEW added later in
-- 13B-Schema-Reference-Consolidation.sql:2177-2192) additionally joins
-- pg_class/pg_namespace with t.relkind = 'r', restricting the count to
-- ordinary BASE TABLES only (excluding views such as platform.mdm_scorecard,
-- platform.my_work, and others in these schemas). That narrower definition
-- returns 2404 — 201 fewer than the raw guards.sql query.
--
-- DECISION: this migration classifies against the STRICTER, doc-40-governing
-- 2605-row definition (guards.sql's own raw query, reproduced verbatim
-- below), not the narrower 2404-row view. Classifying the full 2605 columns
-- automatically satisfies the narrower 2404-row view too, since it is a
-- strict subset of the same column set — there is no ambiguity or partial
-- completion either way. This is also exactly what
-- modules/identity/tests/integration/column-classification.test.ts's
-- completeness test (test 1) checks directly against guards.sql's raw query.
--
-- ── ROUND 3 (final) — two one-line overrides pg-reviewer's final pass found ─
-- wms.outbound_orders.ship_to_phone was left `public` while its sibling
-- columns on the SAME row, ship_to_name and ship_to_address, are already
-- `personal` (round 2, finding 4/2) — the regex only matches `^phone$` and
-- `recipient_phone`/`landlord_phone`, not `ship_to_phone`. cc.calls.
-- caller_number/.called_number are external callers' phone numbers (every
-- other phone column in the schema is `personal`; these are the only
-- `*_number`-suffixed phone columns the `^phone$`/`mobile_no` regex never
-- sees). Both added as priority-0 overrides — no regex change, no new
-- false-positive risk.
--
-- ── ROUND 2 REWORK — why this file changed ─────────────────────────────────
-- pg-reviewer (opus) FAIL(11): 7 finding categories of live-queried columns
-- proven misclassified as `public` when they should redact via
-- platform.sanitize_audit() (13B:297-305). Round-2 fix below. Summary of
-- what changed vs round 1 (full reasoning is inline as SQL comments at each
-- rule, per the same "a future reader must see WHY without re-deriving it"
-- standard as round 1):
--   • NEW priority 0: an explicit, table-qualified override list (VALUES),
--     joined ahead of the regex cascade, for columns the regex genuinely
--     cannot safely generalize (ambiguous generic names like `name_ar`,
--     `doc_no`, or jsonb snapshot columns) — findings 3, 4, 5, part of 1,
--     and (self-check, see below) two NEW false positives this rework
--     itself would otherwise have introduced.
--   • Priority 1 (secret): + `iban` (finding 2).
--   • Priority 2 (personal): + `bank_ref|bank_name|cheque_no` (finding 2).
--   • Priority 3 (hr payroll): broadened keyword list (finding 6).
--   • Priority 4 (commercial): broadened keyword list (finding 1, finding 6
--     non-hr half) — with two deliberate departures from the finding's
--     literal wording, both documented at the rule itself: `total` anchored
--     to `total$` (not bare) and `rent` bounded to `(^|_)rent(_|$)` (not
--     bare), because live-data spot checks (below) showed the bare forms
--     sweep up unrelated columns. Everything the finding actually needs is
--     still matched — see the rule-level comments.
--   • Self-check per the brief's own instruction ("look for any NEW false
--     positive ... your changes might have introduced"): broadening
--     priority 4 with `_value$` catches `platform.audit_log*.old_value` /
--     `.new_value` (12 columns across the partitioned table + its children)
--     and `cc.ticket_events.from_value` / `.to_value`. These are generic
--     changed-field snapshot containers — the SAME class platform.io
--     integration_queue.payload / imile.shipments.raw already correctly
--     stay `public` for (finding 5's own stated principle) — not a
--     sensitive figure in themselves. sanitize_audit() is invoked with
--     p_schema/p_table of the ORIGINAL audited entity and redacts PER KEY
--     inside the jsonb payload against THAT entity's classification; the
--     container columns' own classification is never consulted for that
--     purpose. Forced back to `public` via the same priority-0 override
--     mechanism. Documented at the override list below.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- Priority 0 — explicit table-qualified overrides (checked BEFORE the regex
-- cascade; an override always wins). Used only where a column/table name is
-- genuinely ambiguous by pattern alone (a broadened regex would either miss
-- the real column or sweep up unrelated ones) — every row below states WHY.
--
--   PERSONAL — an actual person's identity/name/contact, sitting beside
--   sibling columns already correctly `personal` (finding 3, finding 4):
--     hr.employee_documents.doc_no        — this table's doc_type is
--       residency|passport|license|health_card|contract: doc_no here IS a
--       passport/residency number. Cannot broaden the generic `doc_no`
--       pattern — it is the legitimate business document-number column used
--       everywhere else (platform.documents.doc_no, invoice/quote numbers)
--       and those must stay `public`.
--     tms.proof_of_delivery.receiver_id_no — sits beside receiver_name.
--     hr.employees.name_ar / .name_en, hr.employees_basic.name_ar,
--     identity.users.full_name_ar / .full_name_en,
--     hr.recruitment_cases.candidate_name,
--     hr.recruitment_cost_per_employee.candidate_name,
--     housing.properties.landlord_name, partners.partners.contact_person,
--     sales.contacts.name, sales.leads.contact_name,
--     tms.delivery_tasks.recipient_name, tms.proof_of_delivery.receiver_name,
--     wms.inbound_orders.driver_name, imile.driver_id_dashboard.driver_name,
--     wms.outbound_orders.ship_to_name — every one names an actual human.
--       Cannot broaden `name_ar|name_en` generically — that would wrongly
--       sweep up platform.entities.name_ar (a company), catalog.services.
--       name_ar (a service), and hundreds of other non-person "name"
--       columns. Named overrides only.
--     sales.contacts.whatsapp — same class as its sibling .phone (already
--       `personal`), self-contradictory to leave `public`.
--
--   PAYROLL — jsonb snapshot columns embedding already-`payroll` figures
--   (finding 5). Same row as gross_commission/net_commission/deductions,
--   which are correctly `payroll`; a blanket jsonb/snapshot regex would
--   over-classify platform.integration_queue.payload / imile.shipments.raw
--   (reviewer-confirmed correctly `public`), so named overrides only:
--     hr.commission_daily.rule_snapshot / .source_snapshot,
--     hr.sales_commission_events.calc_snapshot / .rule_snapshot.
--
--   COMMERCIAL — real money figures whose column name does not contain any
--   word that can be SAFELY generalized into the priority-4 regex without
--   sweeping up unrelated columns elsewhere in the schema (finding 1
--   stragglers, confirmed live): billing.receipts.unallocated,
--   admin.petty_cash.max_single_txn, platform.decisions.financial_impact,
--   platform.approval_chains.auto_approve_below,
--   tms.delivery_tasks.cod_collected.
--
--   PUBLIC — two classes:
--   (a) finding 7, over-classification: geographic/corporate reference data
--       with no individual data subject, needlessly redacted by the
--       personal-priority `governorate` / `^address$` patterns:
--       imile.coverage_areas.governorate (reference data, no data subject),
--       sales.accounts.governorate / housing.properties.governorate (a
--       company's / building's province — NOT tms.delivery_tasks.
--       governorate, deliberately left `personal`: that one is a delivery
--       destination's province, plausibly a person's address, not named by
--       the reviewer's finding 7 list), wms.warehouses.address (a
--       warehouse, not a person — NOT partners.partners.address, which
--       finding 2 itself confirms must stay `personal` alongside its
--       sibling email/phone on the same row).
--   (b) self-check finds (see ROUND 2 note above): platform.audit_log
--       (+ its 5 partitions) .old_value / .new_value, and
--       cc.ticket_events.from_value / .to_value — generic changed-field
--       snapshot containers, not themselves a sensitive figure; the
--       broadened `_value$` priority-4 pattern would otherwise catch them.
-- ─────────────────────────────────────────────────────────────────────────
with overrides (schema_name, table_name, column_name, sensitivity) as (
  values
    -- personal — finding 3 (document numbers, table-qualified)
    ('hr',       'employee_documents', 'doc_no',          'personal'),
    ('tms',      'proof_of_delivery',  'receiver_id_no',  'personal'),
    -- personal — finding 4 (natural-person names / contact)
    ('hr',       'employees',                     'name_ar',        'personal'),
    ('hr',       'employees',                     'name_en',        'personal'),
    ('hr',       'employees_basic',                'name_ar',        'personal'),
    ('identity', 'users',                          'full_name_ar',   'personal'),
    ('identity', 'users',                          'full_name_en',   'personal'),
    ('hr',       'recruitment_cases',              'candidate_name', 'personal'),
    ('hr',       'recruitment_cost_per_employee',  'candidate_name', 'personal'),
    ('housing',  'properties',                     'landlord_name',  'personal'),
    ('partners', 'partners',                       'contact_person', 'personal'),
    ('sales',    'contacts',                       'name',           'personal'),
    ('sales',    'leads',                          'contact_name',   'personal'),
    ('tms',      'delivery_tasks',                 'recipient_name', 'personal'),
    ('tms',      'proof_of_delivery',               'receiver_name',  'personal'),
    ('wms',      'inbound_orders',                 'driver_name',    'personal'),
    ('imile',    'driver_id_dashboard',            'driver_name',    'personal'),
    ('wms',      'outbound_orders',                'ship_to_name',   'personal'),
    ('wms',      'outbound_orders',                'ship_to_phone',  'personal'),
    ('sales',    'contacts',                       'whatsapp',       'personal'),
    -- personal — round 3 (external caller phone numbers under a *_number name
    -- the ^phone$/mobile_no regex never sees; see ROUND 3 note above)
    ('cc',       'calls',                          'caller_number',  'personal'),
    ('cc',       'calls',                          'called_number',  'personal'),
    -- payroll — finding 5 (jsonb snapshots of already-payroll figures)
    ('hr', 'commission_daily',         'rule_snapshot',   'payroll'),
    ('hr', 'commission_daily',         'source_snapshot', 'payroll'),
    ('hr', 'sales_commission_events',  'calc_snapshot',   'payroll'),
    ('hr', 'sales_commission_events',  'rule_snapshot',   'payroll'),
    -- commercial — finding 1 stragglers (money-in-fact, no safely-general regex word)
    ('billing',  'receipts',          'unallocated',           'commercial'),
    ('admin',    'petty_cash',        'max_single_txn',        'commercial'),
    ('platform', 'decisions',         'financial_impact',      'commercial'),
    ('platform', 'approval_chains',   'auto_approve_below',    'commercial'),
    ('tms',      'delivery_tasks',    'cod_collected',         'commercial'),
    -- public — finding 7 (over-classification: no individual data subject)
    ('imile',   'coverage_areas', 'governorate', 'public'),
    ('sales',   'accounts',       'governorate', 'public'),
    ('housing', 'properties',     'governorate', 'public'),
    ('wms',     'warehouses',     'address',      'public'),
    -- public — self-check: generic changed-value snapshot containers, not
    -- themselves a sensitive figure (would otherwise be swept up by the
    -- broadened `_value$` priority-4 pattern below)
    ('platform', 'audit_log',              'old_value', 'public'),
    ('platform', 'audit_log',              'new_value', 'public'),
    ('platform', 'audit_log_2026_09',      'old_value', 'public'),
    ('platform', 'audit_log_2026_09',      'new_value', 'public'),
    ('platform', 'audit_log_2026_10',      'old_value', 'public'),
    ('platform', 'audit_log_2026_10',      'new_value', 'public'),
    ('platform', 'audit_log_2026_11',      'old_value', 'public'),
    ('platform', 'audit_log_2026_11',      'new_value', 'public'),
    ('platform', 'audit_log_2026_12',      'old_value', 'public'),
    ('platform', 'audit_log_2026_12',      'new_value', 'public'),
    ('platform', 'audit_log_default',      'old_value', 'public'),
    ('platform', 'audit_log_default',      'new_value', 'public'),
    ('cc',       'ticket_events',          'from_value', 'public'),
    ('cc',       'ticket_events',          'to_value',   'public')
)
-- ─────────────────────────────────────────────────────────────────────────
-- Classification rules (priority order — first match wins; priority 0 is
-- the override CTE above, joined first via coalesce):
--
-- Priority 1 — secret (credentials / technical secrets, narrowly matched;
--   deliberately does NOT catch integrity/audit hashes such as row_hash,
--   prev_hash, checksum — those are public verification digests, not
--   secrets). Round 2: + `iban` (finding 2 — a live payment-routing
--   credential, e.g. partners.partners.bank_iban, is more than PII):
--     password | pwd_hash | passwd | secret | api_key | private_key |
--     access_key | credential | webhook_secret | signing_key |
--     encryption_key | auth_token | refresh_token | session_token |
--     pin_hash | otp_secret | otp_code | totp | code_hash | token_hash |
--     iban
--
-- Priority 2 — personal (PII about individuals: phone/email/address as
--   standalone names, national/civil ID, DOB, nationality, witness /
--   beneficiary identity fields, photos/signatures of a person). Round 2:
--   + `bank_ref|cheque_no|bank_name` (finding 2 — part of a person's/
--   partner's payment profile; sensitive but not itself a movable
--   credential the way an IBAN is, hence personal not secret):
--     civil_id | national_id | passport_no | passport_number | iqama |
--     date_of_birth | ^dob$ | nationality | ^address$ | address_ar |
--     address_en | address_text | ship_to_address | landlord_phone |
--     recipient_phone | emergency_contact | next_of_kin | marital_status |
--     blood_type | medical | ^phone$ | mobile_no | ^email$ |
--     witness.*_name | witness.*civil_id | beneficiary_name |
--     signature_url | photo_url | id_photo | governorate |
--     bank_ref | cheque_no | bank_name
--
-- Priority 3 — payroll, SCHEMA-QUALIFIED to hr only (an individual
--   employee's actual pay; the SAME keywords outside hr fall through to
--   priority 4 commercial instead, since they are then business/pricing
--   configuration, not an individual's pay). Round 2: broadened per finding
--   6 — these hr-schema columns (commission events, disciplinary damages,
--   commission-rule limits) name an individual's pay/liability but missed
--   the original narrower keyword list:
--     table_schema = 'hr' and
--     salary | wage | commission | bonus | deduction | payroll |
--     allowance | overtime | gratuity | indemnity | leave_balance |
--     net_pay | gross_pay | basic_pay | amount | charged | deductible |
--     damage | carried_forward | share_pct | max_monthly | min_daily |
--     manager_override_pct | split_on | multiplier
--
-- Priority 4 — commercial (business-financial, non-payroll: pricing, cost,
--   margin, revenue, credit, invoice/payment amounts, fees, rates; also
--   catches the priority-3 payroll keywords when they occur OUTSIDE hr, per
--   priority 3's note above — never silently falls to public). Columns
--   ending in `_id` are excluded here: those are structural foreign-key
--   reference columns (e.g. budget_line_id, budget_id, price_list_id,
--   price_ref_id), not the financial value itself — they fall through to
--   priority 5 (public), consistent with priority 5's own stated default
--   that FK reference columns are public. Round 2 additions (finding 1 +
--   finding 6's non-hr half, e.g. tms.accidents.charged_to_driver/
--   .deductible): + balance | debit | credit | liability | penalty |
--   available | deductible, plus two DELIBERATELY BOUNDED forms (not the
--   finding's literal bare wording — live-data spot checks below showed the
--   bare forms sweep up unrelated columns while missing nothing the finding
--   actually needs):
--     `total` → anchored `total$` (suffix only). Bare `total` would also
--       match housing.capacity_overview.total_beds, imile.sorting_plans.
--       total_shipments/.total_drivers/.total_zones, wms.warehouses.
--       total_sqm — none of them money. `total$` still matches every
--       confirmed column (billing.invoices.total/.subtotal,
--       billing.invoice_lines.line_total, sales.quotes.total/.subtotal,
--       sales.quote_lines.line_total — "subtotal"/"line_total" both END in
--       "total"). Prefixed total_cost/total_amount columns (e.g. admin.
--       purchase_orders.total_amount) don't need this rule at all — they
--       already matched the pre-existing `cost`/`amount` keywords.
--     `rent` → bounded `(^|_)rent(_|$)`. Bare `rent` would also match
--       admin.approval_requests.current_step, platform.counters.
--       current_val, tms.failure_reasons.parent_code (all contain "rent" as
--       a substring of "current"/"parent", none of them money). The bounded
--       form still matches every confirmed column (housing.properties.
--       monthly_rent, housing.units.monthly_rent — "_rent" at the end).
--     `_value$` (anchored, NOT bare `value`) — avoids sweeping up
--       platform.settings.value / platform.thresholds.value (generic
--       config, no anchored-bare match needed by any confirmed finding
--       column — every confirmed column, e.g. expected_value, unit_value,
--       purchase_value, ends in `_value`). The handful of `_value$` matches
--       that are themselves generic snapshot containers rather than a
--       sensitive figure (platform.audit_log*.old_value/.new_value,
--       cc.ticket_events.from_value/.to_value) are forced back to `public`
--       via the priority-0 override above.
--     (not ending in _id) and
--     price | cost | margin | revenue | discount | credit_limit |
--     invoice_amount | invoice_ref | amount | _amt$ | budget | rate_pct |
--     rate_per_unit | payment_terms | standard_cost | ^fee |
--     deposit_amount | contract_value | salary | wage | commission |
--     bonus | deduction | payroll | allowance | overtime | gratuity |
--     total$ | balance | debit | credit | _value$ | (^|_)rent(_|$) |
--     charge | liability | penalty | available | deductible
--
-- Priority 5 — public (the default else: ids, timestamps, status/enum/code
--   text, booleans, FK reference columns, generic descriptive text/notes,
--   URLs that aren't a person's photo/signature, row_hash/prev_hash/
--   checksum-style integrity digests, jsonb operational snapshots that are
--   NOT next to a sensitive figure — see priority-0 payroll overrides for
--   the ones that ARE).
-- ─────────────────────────────────────────────────────────────────────────
insert into identity.column_classification (schema_name, table_name, column_name, sensitivity)
select
  c.table_schema,
  c.table_name,
  c.column_name,
  coalesce(
    o.sensitivity,
    case
      when c.column_name ~* '(password|pwd_hash|passwd|secret|api_key|private_key|access_key|credential|webhook_secret|signing_key|encryption_key|auth_token|refresh_token|session_token|pin_hash|otp_secret|otp_code|totp|code_hash|token_hash|iban)'
        then 'secret'
      when c.column_name ~* '(civil_id|national_id|passport_no|passport_number|iqama|date_of_birth|^dob$|nationality|^address$|address_ar|address_en|address_text|ship_to_address|landlord_phone|recipient_phone|emergency_contact|next_of_kin|marital_status|blood_type|medical|^phone$|mobile_no|^email$|witness.*_name|witness.*civil_id|beneficiary_name|signature_url|photo_url|id_photo|governorate|bank_ref|cheque_no|bank_name)'
        then 'personal'
      when c.table_schema = 'hr'
       and c.column_name ~* '(salary|wage|commission|bonus|deduction|payroll|allowance|overtime|gratuity|indemnity|leave_balance|net_pay|gross_pay|basic_pay|amount|charged|deductible|damage|carried_forward|share_pct|max_monthly|min_daily|manager_override_pct|split_on|multiplier)'
        then 'payroll'
      when c.column_name !~* '_id$'
       and c.column_name ~* '(price|cost|margin|revenue|discount|credit_limit|invoice_amount|invoice_ref|amount|_amt$|budget|rate_pct|rate_per_unit|payment_terms|standard_cost|^fee|deposit_amount|contract_value|salary|wage|commission|bonus|deduction|payroll|allowance|overtime|gratuity|total$|balance|debit|credit|_value$|(^|_)rent(_|$)|charge|liability|penalty|available|deductible)'
        then 'commercial'
      else 'public'
    end
  ) as sensitivity
from information_schema.columns c
left join overrides o
  on o.schema_name = c.table_schema
 and o.table_name  = c.table_name
 and o.column_name = c.column_name
where c.table_schema in ('platform','identity','catalog','sales','wms','tms','cc',
                         'billing','hr','partners','admin','housing','imile','governance')
on conflict (schema_name, table_name, column_name) do nothing;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Verification after apply
-- ═══════════════════════════════════════════════════════════════════════════
--   select count(*) from identity.column_classification;                 -- 2605
--   select sensitivity, count(*) from identity.column_classification
--     group by 1 order by 2 desc;
--   -- G6 raw (guards.sql lines 64-72), must return 0 rows:
--   select c.table_schema, c.table_name, c.column_name
--   from information_schema.columns c
--   where c.table_schema in ('platform','identity','catalog','sales','wms','tms','cc',
--                            'billing','hr','partners','admin','housing','imile','governance')
--     and not exists (select 1 from identity.column_classification k
--                      where k.schema_name = c.table_schema
--                        and k.table_name  = c.table_name
--                        and k.column_name = c.column_name);
-- ═══════════════════════════════════════════════════════════════════════════
