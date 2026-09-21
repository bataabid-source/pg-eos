# PG-EOS — Build Specification for AI Execution
**Document 40 · Version 4.0 · 21 September 2026**
**Audience:** the AI coding agent executing the WBS (doc 38)

> **v4 — Document status:** GOVERNING (technical contract, rank 1) · **Governs on conflict:** nothing above it; it governs every other document · **Corrections applied in v4:** GOV-04, GOV-05, GOV-06, GOV-07, GOV-08, GOV-09, GOV-10, GOV-35, GOV-36, GOV-40, GOV-43, GOV-44, GOV-48, GOV-49, GOV-50, GOV-54, ADM-04, ADM-09, ADM-14, ADM-31, ADM-37, OPS-20, OPS-32, OPS-33, OPS-35, OPS-54, OPS-69, OPS-70, PLT-03, PLT-04, PLT-05, PLT-08, PLT-17, PLT-22, SCH (13B) · **Previously open decisions:** closed in EXECUTION-MASTER-v4 §1.

**Precedence (R-01 — the single ladder, written verbatim wherever a ladder is stated):**
1. `40-Build-Specification-EN.md` — the technical contract; governs on conflict
2. `36-Technical-Architecture-Audit.md` — architecture, stack, build method
3. `EXECUTION-MASTER-v4.md` — GM decision log (Tier A) + lane plan + commands
4. `42-Oracle-Cloud-Deployment.md` — Tier 0 deployment target
5. `38-WBS.md` — the only task sequence (132 tasks: 126 in eight phases 0–7 + 6 cross-cutting)
6. `22-Master-Data-Governance.md` — ownership, segregation of duties, approval chains
7. `database/01 · 13 · 13B · 019` — **the only permitted schema** (always written "01/13/13B/019")
8. `BOOTSTRAP-v4.md` — operating instructions (no rules of its own; quotes 1–7)
9. All other documents are reference.

> This is the self-sufficient technical specification. An agent holding this document, the four SQL files (01/13/13B/019), and the WBS can build the system without reading the Arabic design package. Where a rule here conflicts with an Arabic document, this document governs.

---

## PART A — SYSTEM CONTRACT

### A1. Non-negotiable Principles

| # | Principle | Enforcement |
|---|---|---|
| P1 | The process is the unit of design; no screen exists without a process | Screen inventory in §D |
| P2 | Single source of truth; derivation allowed, duplication forbidden | Schema review |
| P3 | Ledgers (stock, financial, payroll, audit) are append-only; corrections by counter-entry | `REVOKE UPDATE, DELETE` |
| P4 | Balances are derived and rebuildable with zero diff | Guard test `verify_balance_integrity()` |
| P5 | One write path; every mutation passes the validation layer | Lint: no `db.` outside `withContext()` |
| P6 | Authorisation is data (roles, permissions, RLS), never code branches | RLS on every operational table |
| P7 | Everything is traced: actor, time, device, before/after | Audit log with hash chain |
| P8 | Documents are outputs of state transitions, never data-entry forms | `document_bindings` |
| P9 | No module opens before its data gate is met | `platform.domain_owners.gate_target_pct` |
| P10 | Every invoiced number traces to a recorded event | `billable_events` unique index |
| P11 | Automation by default; humans decide exceptions only | `platform.automation_rules` |

### A2. Multi-Entity Rules

- `platform.entities` is a tree: **PGH — Premium Group Holding** (`entity_kind = holding`, a legal entity with its own CR) is the root; **PCC, PST, PDL, POR** (`operating`) are its children via `parent_id`.
- Every commercial/operational row carries `entity_id`. Customer invoices may carry only an `operating` entity — a DB trigger rejects any non-intercompany invoice on the holding.
- The holding carries: shared costs (head office, executive salaries, shared services), group-level framework contracts with partners/vendors, and executive employees. Shared costs are allocated monthly to the four operating entities via `billing.cost_allocations` on a declared basis (revenue share by default).
- Group consolidation = holding + operating children, with `is_intercompany` rows eliminated.
- One `sales.accounts` row per client across all entities. One `sales.contracts` row per (client, entity).
- Invoices are issued **only** by the entity that rendered the service.
- `credit_limit` and `credit_hold` live on `sales.accounts` (group level). A hold blocks new outbound orders, delivery tasks and CC queues in **all** entities.
- Intercompany transactions carry `is_intercompany = true` and are eliminated in group consolidation.

### A3. Money, Time, Identity

- Money: `numeric(14,3)`, currency KWD, three decimals. Never `float`.
- Time: `timestamptz`, stored UTC, displayed `Asia/Kuwait`. Domain code receives a `Clock` port; never `new Date()`.
- Keys: `uuid` (`gen_random_uuid()`). Human numbers via `platform.next_doc_no(entity, doc_type)` — atomic, never reused, **assigned to invoices only at approval**.
- Soft delete (`deleted_at`) only where stated; **no hard delete in stock or financial schemas**.

### A4. Architecture (from doc 36)

- **Modular monolith.** One NestJS application (Fastify adapter), one PostgreSQL 16 database, one deployment.
- **Hexagonal per module:** `domain/` (imports nothing external), `application/` (one command per file, ports), `infrastructure/` (Drizzle repos, adapters), `api/` (routes, Zod schemas → OpenAPI), `tests/`.
- **Vertical slices.** Deliver migration → domain → application → API → UI → tests as one unit.
- **Cross-module communication:** domain events via transactional outbox, or declared contracts in `packages/contracts`. Direct imports across modules fail lint.
- **Every write endpoint:** requires `Idempotency-Key` header (400 without; 409 on key reuse with different body; replay returns prior result for 7 days).
- **Every mutable aggregate:** `version int` column; `UPDATE … WHERE version = $expected`; zero rows → 409.
- **Every transaction:** opened via `withContext(ctx, fn)` which executes `SET LOCAL app.user_id`, `app.is_internal`, `app.client_id`.
- **State transitions:** XState v5 machines in `domain/state-machines/`; transitions declare allowed roles; illegal transition → 422 with message naming the allowed transitions.
- **Events:** written to `platform.outbox` **in the same transaction** as the state change; relay publishes at-least-once; subscribers are idempotent by `(event_id)`.
- **Jobs:** pg-boss. Retries with backoff; dead-letter after N attempts; every job idempotent.
- **Feature flags:** `platform.feature_flags` with `kill_switch`. New features ship dark.
- **Thresholds:** `platform.thresholds` — numeric business limits are data, never constants in code.

### A5. Agent Constraints (paste into every session)

```
- No table, column, or business rule outside docs 01 / 13 / 13B / 019. Missing?
  STOP and file a one-line schema-change request (SCR) under G-01.
- No object outside the four schema files and guards.sql (see Part I).
- No cross-module import. Use an event or a contract.
- No db.* outside withContext(). No any / @ts-ignore / eslint-disable.
- Never weaken a test to make it pass. Fix the code.
- No if/switch for state transitions — XState. No embedded Arabic strings — i18n.
- No magic numbers — named constants or platform.thresholds.
- No console.log — pino. No Math.random()/new Date() in domain — inject.
- Never invent a number, name, or business rule. If unspecified, ask.
- Replicate the golden slice's file structure exactly.
```

---

## PART B — SHARED PLATFORM (module `platform`, `identity`)

### B1. Identity

**Entities:** `users` (internal / client / agent), `roles`, `permissions` (`module.object.action`), `role_permissions`, `user_roles` (revocable), `user_entities`, `sessions` (revocable, 6 h), `otp_codes`, `column_classification`, `delegations` (≤ 90 days, mandatory `valid_to`), `sod_rules`.

**Rules:**
- **Authentication (R-06).** Internal web users: login = email + one-time code; **no stored passwords on the server**. Field apps use two distinct device models, and both are data, not exceptions:

| | **Premium WH (PDA)** | **Premium Driver** |
|---|---|---|
| Device | **shared** industrial PDA (kiosk) | **personal**, one device per driver |
| Credential | employee code + **6-digit PIN**; the PIN **hash** (argon2id) is cached **on the registered device only** after the first online login — never on the server (G-07) | OTP enrolment **once**, then **30-day** refresh token |
| Re-verification | online **OTP re-verify weekly** | new device = **supervisor approval** |
| Offline window | **72 h** | **7 days** |

  No credential of either model is ever stored server-side as a password; the server stores only the device binding and the session record.
- Session revoked immediately on role change. Sessions: 6 h internal; 1 h + 30-day refresh for field apps.
- `column_classification` must cover **every** column in 01/13/13B/019; deploy fails otherwise (G6). Sensitivities: `public · personal · payroll · commercial · secret`. `secret` never reaches the browser.
- SoD trigger: assigning a role that pairs with an existing role in `sod_rules` → reject. **Defaults (four pairs):** (CFO, ACCOUNTANT), (SALES_MGR, CFO), (WH_OP, WH_SUP), (PRO, CFO). Delegation never bypasses SoD (ADR-16c); the trigger fires on insert **and** on update of `role_id`/`revoked_at`.
- **Four-eyes rule:** changes to permissions, secrets, SoD rules or approval chains require a second approver — `DEPUTY_SYSADMIN` or CFO — because GM = SYSADMIN in current staffing.
- Structure editor (roles, permission matrix, domain owners, approval chains, delegations, SoD rules) is a UI screen; changes audited; SoD rule deactivation requires GM role and a reason.

**Roles (codes) — 26:** `GM OWNER SYSADMIN DEPUTY_SYSADMIN CFO ACCOUNTANT COST_ANALYST SALES_MGR SALES_REP OPS_DIR WH_MGR WH_SUP WH_OP DEL_MGR DEL_SUP DRIVER FLEET_MGR CC_MGR CC_AGENT HR_MGR PRO HOUSING_SUP CLIENT_ADMIN CLIENT_CREATOR CLIENT_VIEWER CLIENT_FINANCE`. Seeded in 13B.
Current staffing collapses some: GM = SYSADMIN (with `DEPUTY_SYSADMIN` as the compensating second approver); PRO = ACCOUNTANT (collections) under the controls of EXECUTION-MASTER-v4 §1 — a separate `RCT` receipt series, `GOV` for government fees, and **CFO reconciles both streams**; no OPS_DIR/HR_MGR (line managers hold their scopes — an unfilled position never appears as owner or approver, see doc 22). Roles remain defined; assignment is data.

**Data scopes:** `all · entity · org_unit · subordinates · assigned · account · client · self`. `subordinates` is derived from `hr.employees.reports_to` chain.

### B2. Audit

`platform.audit_log` — defined in **13B** (do not redefine it in code or in a migration). It is **partitioned monthly by `occurred_at`**, and its primary key is therefore **`(id, occurred_at)`**, not `id` alone.

Base columns: `id`, `occurred_at`, `user_id`, `actor_type` (`user · agent · system · ai · client`), `entity_id`, `schema_name`, `table_name`, `record_id`, `operation` (`insert update delete approve reject void login export print read_secret`), `old_value`, `new_value`, `ip_address`, `user_agent`.

**The eleven v4 columns that 40 requires and 13B provides** — every one of them is mandatory, and a guard depends on each:

| # | Column | Type | Why |
|---|---|---|---|
| 1 | `prev_hash` | `text` | SHA-256 chain link (G8) |
| 2 | `row_hash` | `text` | `sha256(prev_hash ‖ occurred_at ‖ user_id ‖ table_name ‖ record_id ‖ operation)` (G8) |
| 3 | `doc_no` | `text` | human number — makes the log searchable by document |
| 4 | `changed_fields` | `text[]` | changed columns only (G9 sampling) |
| 5 | `reason` | `text` | **mandatory** for `reject · void · override` (G10) |
| 6 | `correlation_id` | `uuid` | one business operation across many requests (trace ≤ 2 s, G17) |
| 7 | `request_id` | `uuid` | one HTTP request |
| 8 | `session_id` | `uuid` | revocable session that produced the write |
| 9 | `device_id` | `text` | field-app device binding |
| 10 | `on_behalf_of` | `uuid` | set when acting under a delegation |
| 11 | `actor_type` | `text` | distinguishes human, agent, system, AI and client writes |

- Monthly partitions (+ a default partition as a safety net; creating next month's partition is a scheduled job). Retention: operational 18 months; financial/approvals 10 years.
- Sanitizer (`platform.sanitize_audit`): columns classified `payroll commercial secret personal` are stored as `"•••"` markers.
- The chain is written by trigger `platform.audit_hash_chain()` under an advisory lock (concurrent writers cannot fork the chain) and verified by `platform.verify_audit_chain()`. Monthly job runs it; any break → alert GM + SYSADMIN.
- `REVOKE UPDATE, DELETE` on the table.

### B3. Events & Outbox

**`platform.outbox` is the governing event table.** `platform.domain_events` is retired and dropped in 13B; any document naming it means `outbox`.

Columns as defined in 13B:
`platform.outbox(id bigserial, entity_id uuid → platform.entities, aggregate_type, aggregate_id uuid, event_type, payload jsonb, correlation_id uuid not null, causation_id uuid, created_at timestamptz, published_at timestamptz, attempts int, last_error text, actor_id uuid)`
plus indexes on `(published_at) where published_at is null` and on `(correlation_id)`.

**`entity_id` on `platform.outbox` (delivered in 13B, SCR-1):** every commercial/operational event carries the entity of its aggregate; the column is nullable only for platform-level events (aggregate_type in `platform.*` / `identity.*` — permission, SoD, feature-flag, group-level decision), enforced by the check constraint `outbox_business_needs_entity`. RLS: `entity_scope` for entity events; platform events are visible to internal users only. No slice writes entity context into `payload` instead of the column.

The event is written **in the same transaction** as the state change — written or not written *with* the state, never a third case. A relay publishes at-least-once; subscribers are idempotent by `(event_id)`.
Event naming: `<module>.<aggregate>.<past_tense>` e.g. `wms.outbound.checked`, `tms.task.delivered`, `billing.invoice.approved`.
Subscribers (registered in `packages/events`): billing, documents, notifications, audit, traceability.

### B4. Documents

`document_templates` (Handlebars HTML, bilingual, entity header/footer from `platform.entities`), `document_bindings(template, source_table, trigger_state, auto_generate)`, `documents` (frozen `rendered_data`, `file_url`, `version`, `superseded_by`, `checksum`, `legal_hold`, `retain_until`).
Rendering: Chromium headless. Font Cairo. RTL default. **No "forms" screen anywhere**; print button lives on the process screen.
The only permitted blank form: field paper fallback (doc 26) — it creates no record.

### B5. Decisions, Automation, Thresholds, Flags

All six tables below are defined in **13B** under exactly these names. Nothing here is created by a slice.

- **`platform.decisions`**: the Decision Inbox item — `kind, title_ar, context jsonb (computed facts only), financial_impact, urgency, assigned_role, status, decision, decided_by/at, due_at`. Every item has exactly one action set. Item disappears on decision. RLS: entity-scoped, with `entity_id is null` allowed for group-level decisions.
- **`platform.automation_rules`**: `process, level (A0–A3), auto_condition, exception_condition, escalate_to_roles, threshold_key`. This table — not prose — carries the automation level of every process.
- **`platform.thresholds`** — *numeric* business limits, `numeric(14,3)`, editable by GM without a deploy: e.g. `invoice.auto_approve_max`, `purchase.auto_max`, `driver.payment.link_ttl_min=30`, `driver.custody.alert_hours=24`, `driver.custody.escalate_hours=48`, `partner.match_tolerance_pct=2`, `recruitment.escalate_pct=50` (7-day SLA + 50% ⇒ escalation on day 11), and the sixteen ADR-27 keys seeded in 13B (§C8).
- **`platform.settings`** — textual/boolean/JSON settings (`jsonb`). It is **not** a duplicate of `thresholds`: a number that a manager may re-tune lives in `thresholds`; a mode, a provider name or a flag lives in `settings`. Both remain.
- **`platform.feature_flags`**: `key, enabled, rollout_pct, enabled_for_roles, kill_switch, changed_by, changed_at`. New features ship dark.
- **`platform.approval_chains(request_type, step_no, approver_role, min_amount, max_amount, auto_approve_below, is_active)`** — purchase levels (KWD): ≤ 100 automatic · 100–500 department manager · 500–2,000 CFO · > 2,000 GM. "No self-approval" is a real constraint (`requester_id <> approver_id`), never `check (true)`.
- **`platform.domain_owners(domain_code D01–D12, owner_role, approver_role, gate_target_pct)`** — `D10`, never `D010`.

### B6. Alerts (22) and Reports (24)

Defined in doc 25 §2 and §5: **N-01…N-18** plus the four that doc 23 §4 makes mandatory — **N-19** manual integration queue > 20 items or > 48 h · **N-20** WhatsApp bounce rate > 5% · **N-21** bank reconciliation overdue > 7 days · **N-22** integration with no successful run in 24 h. Implementation: `platform.alert_rules(source_query, target_roles, channels, schedule, dedupe_window_hours, quiet_hours, escalate_after_hours, action_label, action_link)`, `platform.alert_log`. Quiet hours 22:00–07:00 except emergencies (fire is not a system alert — it is an operational exception to quiet hours, declared through manual mode). **An alert without an action link is invalid.**

An alert never targets an unfilled position: where doc 25 says "Operations Director" read **WH_MGR + DEL_MGR** by scope, and where it says "HR Manager" read **GM**.

**Reports** read from a **read replica — a Tier 1/2 target**. In **Tier 0 (Phases 0–3)** there is a single server and no replica: reports run against the primary with an explicit `statement_timeout` and an off-peak schedule, outside the operating window.

---

## PART C — MODULE SPECIFICATIONS

Each module: entities → invariants → state machines → commands → events → billing hooks → acceptance link.

### C1. M03 Catalog & Pricing (`catalog`)

**Entities:** `service_categories` (ST HD OF DL VA CC IT), `services` (code, uom, billing_basis, entity_id, `min_price`, `standard_cost`, `requires_contract_clause`), `segments` (SEG-A…F, criteria jsonb, discount_pct), `price_lists` (entity, segment or client, `is_internal` for transfer pricing, validity), `price_list_lines` (tiered: `tier_from/to`, `free_units`), `price_exceptions` (client, service, approved_price, `min_price_at_approval`, validity, `approved_by` GM, `review_at`).

**Invariants:**
- INV-C1-1 An active service must have `min_price` and `standard_cost` (data gate M03).
- INV-C1-2 A quote/invoice line price < `min_price` requires a valid `price_exception` (DB CHECK on `sales.quote_lines`).
- INV-C1-3 Tiered pricing is **progressive** (each tier at its own rate), never "last tier applies to all".
- INV-C1-4 Floor prices and standard costs are approved by GM + CFO; SALES_MGR maintains the catalog but cannot change floors.

**Pricing engine (A3):** resolve in order `exception → contract annex → segment list → standard list → pending`. Never price at zero; `pending` events surface in the Lost Revenue report and Decision Inbox after 7 days.

### C2. M02 Sales & CRM (`sales`)

**Entities:** `accounts` (one per client; `client_kind`, `segment_id`, `owner_user_id`, `credit_limit`, `credit_hold`, `hold_reason`, `payment_terms_days`), `contacts`, `leads`, `opportunities` (`entity_id`, `stage`, `expected_margin_pct`, `services_scope`, `lost_reason` closed list), `activities`, `quotes` (`frozen_snapshot` on send), `quote_lines`, `contracts` (per entity; `billing_cycle`, `payment_terms_days`, `price_list_id`, `bills_failed_attempt`, `bills_return`, `bills_waiting`, `min_monthly_charge`, `sla_enabled`), `contract_sla`, `sla_results`.

**State machines:**
- Lead: `new → contacted → qualified → converted | lost(reason)`
- Opportunity: `qualification → needs_analysis → proposal → negotiation → won | lost(reason)`
- Quote: `draft → finance_review → approved → sent → accepted | rejected | expired`. Roles: SALES_REP creates; SALES_MGR → finance_review; CFO → approved; GM required if any line has an exception. `sent` is frozen; edit creates a new version.
- Contract: `draft → signed → active → suspended | expired → renewed | terminated`.

**Invariants:**
- INV-C2-1 No quote without a qualified account with `cr_number`.
- INV-C2-2 No contract activation without `price_list_id`.
- INV-C2-3 Duplicate detection on `cr_number` and name similarity ≥ 0.85 (pg_trgm); merge, never delete a record with transactions.
- INV-C2-4 Segment upgrade automatic after 3 consecutive months meeting criteria; downgrade manual with client notice.

**Events:** `sales.quote.approved`, `sales.contract.signed`, `sales.contract.expiring`, `sales.account.hold_set`.

### C3. M04 Warehouse (`wms`)

**Entities:** `warehouses` (`is_partner`, `partner_id`), `zones` (`zone_type`), `locations` (seven-character code, §C3 format below; `section`, `aisle_no`, `position_no`, `level_no`, `global_level`, `space_block_id`, `max_weight_kg`, `max_volume_cbm`, `is_blocked`, `assigned_client_id`), `space_blocks`, `space_blocks_out_of_service`, `space_allocations`, `space_reservations` (mandatory `expires_at`), `skus` (**owned by client**; dimensions, packaging hierarchy, storage conditions, `track_batch/serial/expiry`, `picking_policy FIFO|FEFO|LIFO`, min remaining life), `stock_movements` (append-only), `stock_balance` (derived), `inbound_orders`, `outbound_orders`, `order_lines`, `inventory_counts`, `inventory_count_lines`, `occupancy_snapshots` (daily 00:30).

**Location code — the single format (doc 19 §4 governs; identical in 19, here, the 3-D tool and the printed labels).** Seven characters, `[section][aisle]-[position 2 digits]-[level]`:

```
  P 3 - 1 4 - 5
  │ │   │ │   │
  │ │   │ │   └── level (height)
  │ │   └─┴────── position along the aisle (01–99)
  │ └──────────── aisle number (1–9)
  └────────────── section / floor
```

Sections — four only: **P** pallet rack (ground, blue) · **G** mezzanine ground (green) · **M** mezzanine 1 (orange) · **T** mezzanine 2 (red). Colour carries where letters fail. Levels: **P 1–6** (level 1 at the foot); **G · M · T 1–3** numbered *within the floor*, not 1–9 — the continuous 1–9 sequence stays in the database as a derived column (`global_level`). Examples: `P3-14-5` · `G1-08-2` · `M4-22-1` · `T2-31-3`. Numbering origin: position 01 at the door; aisle 1 from the dock side.

**WH1 fixed data (warehouse code `WH1`, PST, Main Abdullah, 41.62 × 34.20 m).** 3,153 storage locations across 8 space blocks: `P-A` 288 · `P-A1` 12 · `G-B` 906 · `G-C` 45 · `M-B` 906 · `M-C` 45 · `T-B` 906 · `T-C` 45 — i.e. A 288 · A1 12 · B 2,718 · C 135. Plus **30 operational** (RCV 6, STG 8, SHP 6, QRT 4, RTN 4, DMG 2) and **147 structural** (blocked, prefix `X-`, black label with white text) = **3,330 codes in total**. Verified volumes and areas: 3,301.641 m³ · 3,830.895 m² · 2,439,750 kg. Location limits: **pallet 1,000 kg / 1.76175 m³; shelf 750 kg / 0.97200 m³** — a hard barrier, not a warning; an entry that exceeds either is rejected. Row pattern across width: `[1,2,2,2,1,2,2,2,1]` with 1,400 mm aisles; pallet rows flank a 5,400 mm reach aisle.

Generated by `019-Warehouse-WH1-Setup.sql`, which produces exactly what doc 19 describes. **Sellable** is not the same as capacity: sellable = capacity − 7% operational buffer (recorded as `space_blocks_out_of_service` rows with reason `operational_buffer`) − out-of-service − contracted − reserved.

**Invariants:**
- INV-C3-1 `stock_movements` append-only; `stock_balance.qty_on_hand ≥ 0`.
- INV-C3-2 Rebuilt balance from ledger equals stored balance (guard test, zero rows).
- INV-C3-3 SKU belongs to one client; a movement whose SKU's client ≠ order's client is rejected.
- INV-C3-4 Put-away exceeding `max_weight_kg` or `max_volume_cbm` rejected; blocked location rejected with reason.
- INV-C3-5 `order_lines.qty_actual ≠ qty_ordered` requires `variance_reason` (DB CHECK).
- INV-C3-6 Checker ≠ picker on the same order (enforced in command).
- INV-C3-7 Count is blind: counter never sees system quantity; recount mandatory on variance; adjustment = `adjust` movement approved by WH_MGR.
- INV-C3-8 Space: `check_space_available()` rejects allocation/reservation exceeding sellable (capacity − out-of-service − contracted − reserved). Reservations expire automatically.

**Outbound ten-condition check (all automatic, each with its own failing test and message):** contract active · no credit hold · sufficient available qty · SKU belongs to client · remaining shelf life ≥ contract minimum · SKU not on hold · location not blocked · ship-to address complete (if delivery) · service price resolvable · qty within contract cap.

**State machines:**
- Inbound: `draft → approved(WH_MGR) → receiving → received → putaway → closed(WH_SUP) | cancelled`. Close blocked while any line is open.
- Outbound: `draft → approved → allocated → picking → picked → checked → packed → loaded → dispatched → delivered | cancelled`.
- Count: `draft → in_progress → review → adjusted → closed`.

**Commands (application/commands):** `ApproveInbound`, `ReceiveLine` (scan SKU → qty/batch/expiry → photo if variance), `SuggestLocation` (A2: conditions, ABC, proximity to shipping, capacity, client assignment), `ConfirmPutaway`, `CreateOutbound`, `RunOutboundChecks`, `Allocate` (FEFO/FIFO), `GeneratePickList` (shortest path), `PickLine`, `CheckOrder`, `PackOrder`, `LoadOrder`, `StartCount`, `CountLocation`, `Recount`, `AdjustCount`, `TakeOccupancySnapshot`, `AllocateSpace`, `ReserveSpace`.

**Events → billing:** `wms.inbound.received → HD-*`; `wms.outbound.checked → OF-*`; `wms.occupancy.snapshot → ST-* daily`; overflow beyond contracted → `ST-12`; `wms.count.closed`; variance → `wms.inbound.variance` (client notified).

**Documents:** GRN on `received`; variance report on variance; pick list on `approved`; delivery note on `checked`; load manifest on `loaded`.

### C4. M05 Delivery (`tms`) & M09 Fleet

**Entities:** `vehicles` (`ownership`, `assigned_driver_id`, `assigned_client_id`, `odometer_km`), `vehicle_documents` (`expiry_date`), `delivery_tasks` (`source_type internal|imile|oula|client_portal|api`, `source_ref` unique per source, `task_type`, address fields incl. `area, block, street, building`, `is_cod`, `cod_amount`, `driver_id`, `vehicle_id`, `attempt_no`, `failure_reason` code), `routes`, `proof_of_delivery` (`delivered_at` server time, `receiver_name`, `signature_url` **or** `photo_url`, `geo_lat/lng`, `device_id`, and the three v4 retention columns **`sha256`** of the captured image, **`legal_hold boolean`**, **`retain_until date`**), `delivery_exceptions` (`is_billable`), `contact_log`, `payment_attempts`, `failure_reasons` (**7 parents × 25 children**; `requires_photo`, `requires_contact_attempts`, `counts_against_driver`), `maintenance_plans` (km-based), `maintenance_orders`, `accidents`, `fuel_ledger` (`odometer_km` mandatory; unique (card, filled_at, amount)).

**POD retention.** Photos are kept **60 days**; `legal_hold` is set automatically on any image linked to a dispute, complaint or disciplinary case, and a held row is never deleted. `retain_until` carries the computed expiry, `sha256` proves the image was not substituted. Deletion is not enabled before Phase 6. These three columns are a schema correction filed against 13B under G-01 — they are not present as delivered.

**Invariants:**
- INV-C4-1 Hard gate: driver with expired residency/licence, or vehicle with expired document, **cannot be assigned**.
- INV-C4-2 Task creation rejected without `area, block, street, phone`.
- INV-C4-3 POD requires GPS + (signature or photo) + receiver name; timestamp from server.
- INV-C4-4 Scan of the shipment barcode required before `delivered`; scanning a shipment not in the driver's custody → reject.
- INV-C4-5 Failure requires a code from `failure_reasons`; no free text; if `requires_contact_attempts = 2`, two `contact_log` rows must exist.
- INV-C4-6 `payment_attempts`: `method = link` cannot be confirmed without `gateway_ref` (DB CHECK). Partial payment rejected absolutely.
- INV-C4-7 Day close blocked while: unscanned undelivered shipments, COD variance ≠ 0, pending payment links, failed shipments in custody, missing final odometer.
- INV-C4-8 DL-11/12/13/14/18 billable only if the corresponding contract flag is true; otherwise the event is recorded as lost revenue.
- INV-C4-9 Fuel entry without odometer rejected; consumption deviation > 20% of 90-day vehicle mean → `is_anomaly`.

**Driver attribution — exactly three reasons count against the driver, and no others (FIXED, EXECUTION-MASTER-v4 §1.2):**

| # | Code | Counts against the driver only when |
|---|---|---|
| 1 | `door_not_opened` | fewer than 2 logged contact attempts exist in `contact_log` |
| 2 | `building_not_found` | POD/attempt GPS is > 300 m from the task address |
| 3 | `shift_time_exhausted` | no supervisor override is recorded |

All three are decided by the system from `contact_log` and GPS — never by opinion. **Vehicle breakdown and accident are never attributed to the driver**: they are attributed to the fleet, and an accident is charged only after an investigation concludes. The twenty-five child reasons live in `tms.failure_reasons` with the parent-qualified code form used by the acceptance tests (e.g. `no_answer.no_response`); the seven parents are: no answer · address · receiver · payment · shipment · arrival · driver.

**State machine (task):** `created → assigned → out_for_delivery → delivered | failed → (attempt 2) → failed → returned | cancelled`; `deferred` returns to `assigned` on a new date.

**Driver app settings (data):** `driver.contact.provider = direct|masked`, `driver.payment.gateway = none|<provider>`, `driver.payment.allow_partial = false`, `driver.payment.link_ttl_min = 30`, `driver.custody.alert_hours = 24`, `driver.custody.escalate_hours = 48`, `driver.ranking.{enabled, mode, show_peer_names, basis, linked_to_bonus, linked_to_penalty=false}`.

**Photo watermark:** shipment no · server timestamp · driver name/code · driver ID · lat/lng · brand; applied on device at capture; camera only (no gallery); SHA-256 stored.

**Events → billing:** `tms.task.delivered → DL-01/02 (+07/08/09/10)`; `tms.task.failed → DL-11 (if contract)`; `tms.task.returned → DL-12 (if contract)`.

### C5. M06 Call Center (`cc`)

**Entities:** `queues` (`client_id` or `is_internal`, targets), `agents`, `agent_queues`, `calls` (`wait_sec`, `talk_sec` generated), `tickets` (`related_table/related_id` → task/order; `priority`, `sla_due_at`, `resolution` mandatory on close), `ticket_events` (`is_internal`).

**Rules:** first-response SLA by priority (urgent 15 min, high 1 h, normal 4 h); escalation at 80% of SLA; agent sees only assigned queues (RLS on `queue_id`); ticket linked to shipment shows live status; satisfaction survey on close.
**Billing:** internal queues → intercompany transfer price; external → package + overage (`CC-01…15`).

### C6. M07 Finance & Billing (`billing`)

**Entities:** `billable_events` (`source_module/table/id`, `service_id`, `qty`, `unit_price`, `price_source`, `price_ref_id`, `status pending|priced|invoiced|excluded|disputed`, `is_intercompany`; **unique (source_table, source_id, service_id)**), `invoices` (`doc_no` null until approved — DB CHECK; `frozen_snapshot`; `invoice_type standard|proforma|intercompany`), `invoice_lines` (`price_source`, `price_ref_id`, `event_count`), `receipts` (`recorded_by` = PRO), `receipt_allocations`, `credit_notes` (GM approval; mandatory original invoice), `gl_accounts` (uniform chart per entity), `journal_entries`, `journal_lines` (CHECK one side only), `cost_allocations`, `profitability`.

**Invariants:**
- INV-C6-1 No manual invoice lines; every line aggregates events.
- INV-C6-2 Approved invoice immutable; correction only by credit note.
- INV-C6-3 `sum(debit) = sum(credit)` per entry (guard test).
- INV-C6-4 Auto-approval when `total ≤ thresholds.invoice.auto_approve_max`; else CFO decision item.
- INV-C6-5 Receipts recorded by PRO; bank reconciliation by CFO; invoice approval by CFO — SoD enforced via `sod_rules`.
- INV-C6-6 Group P&L eliminates rows where `is_intercompany = true`.

**Month-end (3 automated steps under P11):** (1) close events + occupancy + SLA penalties; (2) price, aggregate, draft, auto-approve under threshold, route the rest to Decision Inbox; (3) post journals, allocate costs, compute profitability, emit Lost Revenue report.

**Collections:** reminders at −3, 0, +7, +15, +30 days; automatic group-level hold on limit breach or overdue > terms; release only by GM/CFO with reason and duration.

**Partners (`partners`):** `partner_contracts` (`relation_type`, `sla_back_to_back`, `penalty_recoverable`, `liability_cap`, `insurance_by`), `payable_events` (mirror of billable, linked by `billable_event_id`), `partner_invoices` (auto-match; variance ≤ `thresholds.partner.match_tolerance_pct` auto-approve; else freeze + Decision item; line without our event → rejected).

### C7. M08 HR (`hr`), Housing (`housing`), Admin (`admin`)

**HR entities:** `org_units`, `employees` (`code PG-####`, `reports_to`, `assigned_client_id`, `status`), `teams`, `employee_documents` (`expiry_date`, **alert ladder 90/45/30/15 days — the single ladder; docs 03 and 35 are corrected to it**), `manpower_requests`, `recruitment_cases` (**17 stages with fixed English codes per doc 10 v4 / 13B check constraint**; `stage_owner` NOT NULL; `sla_days`; **`due_at timestamptz` maintained by trigger**), `recruitment_stage_log`, `recruitment_costs`, `commission_rules`, `commission_daily` (`source_snapshot` frozen; 48-h dispute), `penalty_schedule` (**77 items**, 4 degrees, `is_fraud boolean`), `disciplinary_cases` (`signed_by`, `routed_to`).

**Overdue is a trigger, not a generated column.** `recruitment_cases` and `admin.gov_transactions` carry `due_at timestamptz`, set by trigger from `sla_days` and the stage-entry timestamp. A `generated … stored` `is_overdue` cannot work: it would have to read `now()`, which PostgreSQL forbids in a generated column because it is not immutable. Overdue is then `due_at < now()` — evaluated at read time, and escalated by the alert engine. Escalation threshold: `platform.thresholds['recruitment.escalate_pct'] = 50` — 7-day SLA + 50% = escalation on day 11, the same number the acceptance test S13 asserts.

**Penalty schedule = 77 items** in nine categories (ATT 10 · WRK 11 · VEH 11 · CLI 10 · SAF 8 · CON 10 · HOU 9 · CST 4 · SYS 4). The 77 codes are unique and none is dropped. `hr.penalty_schedule.is_fraud` is `true` for `CLI-02/03/04/06/09 · ATT-07/08 · WRK-08`; ADR-28 reads that flag.

**Penalty authority — hierarchical and enforced in the schema, not in prose.** `hr.disciplinary_cases.signed_by` records the signing position; a **trigger** compares the applied degree against that position's ceiling and, when the signer is outside authority, **routes the case upward and records `routed_to`** — it never fails silently and never rejects the case.

| Signing position | Degrees available |
|---|---|
| Team leader / supervisor | D1 warning · D2 written warning |
| WH_MGR · DEL_MGR · SALES_MGR · FLEET_MGR · HOUSING_SUP | D1 · D2 · D3 deduction |
| GM | D1 – D4 — **dismissal is GM only** |

Grievance goes to the level **above the signer**; the signer never decides their own grievance. Kuwait Labour Law 6/2010: Art. 35 (the penalty must be signed **within 15 days of the offence being proven** — `check (signed_at is null or signed_at::date <= proven_date + 15)`), Art. 37 (the due-process fields are mandatory before any deduction, exactly as doc 15 lists them), Art. 38 (5-day monthly cap across **all** signers, excess carried forward), Art. 39, Art. 40 (register + monthly tally), Art. 41 (dismissal flags). Warning shown on every penalty until `penalty_schedule_approved = true`. Governing metric: a manager whose penalties are overturned on grievance **> 30%** has their authority reviewed.

**Driver commission (fixed, seeded in `hr.commission_rules` + `platform.thresholds`):** **0.300 KWD per delivered shipment** · quality bonus **0.050** when first-attempt success ≥ **85%** and there is **no COD variance in the month** · monthly deductions: housing **23** · phone **5** · residency **12** KWD. These are decided values, not an open question.

**iMile driver IDs (`imile.driver_ids`, `driver_id_assignments`):** an ID is a reassignable resource. Assignment is time-bounded; one active assignment per ID and per employee (partial unique indexes). Shipment attribution **only** through view `imile.shipments_attributed` (join on `ofd_at` within assignment window). Termination/resignation trigger closes assignments and frees IDs. Suspension trigger closes the assignment. IDs suspended for conduct are not reassigned.

**Housing:** `properties → units → rooms → beds`; bed is the unit of assignment (`bed_assignments` time-bounded; one active per bed and per employee); `bed_reservations` for incoming recruits with `expires_at`; `maintenance_requests` (SLA 4/24/48 h); `inspections` (unauthorised occupants flagged); `utility_bills`. Clearance blocked until bed released. Housing deduction 23 KD default (setting), pro-rated.

**Admin:** `budget_lines`, `purchase_requests` (no self-approval CHECK), `vendor_quotes` (selection reason mandatory), `purchase_orders` (`three_way_matched` required before payment — CHECK), `petty_cash` (one active fund per holder; expense requires receipt), `assets`, `asset_custody` (one open custody per asset), `gov_transactions` (`stage_owner` NOT NULL; `is_overdue` generated), `approval_requests/steps` (chains from `platform.approval_chains`), `correspondence`.

### C8. M11 iMile Operations (`imile`)

**Entities:** `shipments` (`tracking_no` unique; `internal_status`; `cage_code`; `driver_code`; `delivery_task_id`; `raw` jsonb), **`coverage_areas`** (the delivery coverage map — a table, not a spreadsheet; columns from doc 07), `sorting_plans` (one per date; `approved_by`, `approved_by_kind human|engine`, `quality_gate jsonb`, `edits_pct`), `plan_assignments` (driver, zones[], cage, planned/actual), `scan_log`, `dtl_problems` (`gate_result` G0–G4, `engine_decision`, `auditor_decision`, `actual_outcome`, `rule_was_correct`, `closed_by`, `re_reviewed_at`, `re_review_agreed`), **`dtl_rule_autonomy`**, **`dispatch_autonomy`**, **`driver_trust`** (ADR-27/ADR-28, 13B), `daily_inventory`, `inventory_discrepancies`, `agent_health`.

**Station agent (`services/agent`):** Node + Playwright; dedicated iMile account; single session (any other login drops it — remote UI operator only); pulls every 10 min; pushes audit decisions every 60 s; health heartbeat; stop > 15 min → alert DEL_MGR, > 60 min → GM. CSV fallback tested monthly.

**Sorting (A3):** scan → respond < 1 s with cage/zone/driver from plan; unknown → "waiting" cage + supervisor alert. The happy path has no human step, so the level is **A3** — corrected from the earlier "A2" here and in doc 07. The level itself is data, in `platform.automation_rules`.

**Autonomy is earned, never assumed (ADR-27).** Dispatch and DTL start at A2 and are promoted to autonomous operation only when the recorded thresholds are met; **a rejection is always human**. Promotion and demotion are rows in `imile.dtl_rule_autonomy` (per problem type × decision kind) and `imile.dispatch_autonomy`, and every threshold below is a seeded key in `platform.thresholds` — sixteen of them (the addendum text says "14"; the literal extraction gives 16, and the difference is recorded for GM):

| Key | Value | Unit |
|---|---|---|
| `dtl.auto_close.min_confidence` | 0.900 | ratio |
| `dtl.auto_close.max_cod_kwd` | 20.000 | KWD |
| `dtl.auto_close.min_driver_trust` | 0.800 | ratio |
| `dtl.promotion.consecutive_days` | 14 | days |
| `dtl.promotion.min_accuracy` | 0.970 | ratio |
| `dtl.promotion.min_cases` | 50 | count |
| `dtl.demotion.accuracy_floor` | 0.950 | ratio |
| `dtl.review.random_sample_pct` | 5 | pct |
| `dispatch.gate.max_overflow_pct` | 3 | pct |
| `dispatch.gate.min_drivers_zone_cap_pct` | 95 | pct |
| `dispatch.gate.max_zones_per_driver` | 3 | count |
| `dispatch.promotion.min_plans` | 14 | count |
| `dispatch.promotion.min_unchanged_pct` | 90 | pct |
| `dispatch.demotion.consecutive_plans` | 2 | count |
| `dispatch.demotion.max_edits_pct` | 20 | pct |
| `dispatch.demotion.first_attempt_drop_pts` | 10 | points |

**Dispatch plan:** group by zone, sort by volume, assign largest zone fitting capacity, fill adjacent zones only, respect exclusions and rotation, overflow → carried list + alert. The plan is a proposal until `dispatch_autonomy.level = 1`; supervisor edits are logged in `edits_pct` and fed back weekly. Auto-approval requires the **seven-check quality gate** stored in `sorting_plans.quality_gate` to pass.

**DTL audit:** gates G0 completeness → G1 type/evidence consistency → G2 OCR with sender discrimination → G3 customer decision in driver's handwriting → G4 responsiveness; output `accept | reject | human | reclassify` + confidence + reason; `accept` and `reclassify` may be auto-closed at level 1 (`closed_by = 'engine'`), **`reject` never is**; daily 5% random re-review; nightly reconciliation at 01:40 computes `rule_was_correct`; open > 24 h escalates to DEL_MGR, > 48 h to GM.

**ADR-28 `imile.driver_trust`:** `trust = 1 − (0.35·p1 + 0.25·p2 + 0.20·p3 + 0.10·p4 + 0.10·p5)` clamped to [0,1], trailing 90 days, computed nightly at 01:40, history 24 months. Minimum denominators 10/10/5/20/10. Weights sum to 1.00, checked by a CHECK constraint on save. Hard rules: an open fraud-type disciplinary case (`penalty_schedule.is_fraud`) → **0**; cold start under 30 deliveries → **0.70**. The score is **never shown to the driver** and is **never linked to pay or to a penalty**.

**Daily inventory:** frozen system snapshot → PDA blind scan → auto-diff (missing/extra/wrong status) → mandatory recount → explanation from closed list → unexplained escalates.

### C9. M13 Governance (`governance`)

`budgets`, `budget_lines` (variance computed monthly), `kpis` (tree: group → entity → module), `kpi_targets`, `kpi_actuals`, `objectives`, `key_results`, `risks`, `risk_reviews`, `ncr`, `corrective_actions`, `policies`, `policy_acknowledgements`, `decisions` (central log), board pack generated from reports R-13…R-24.

### C10. M10 Client Portal (separate app `apps/portal`)

12 screens: login · dashboard · inventory (location detail behind setting) · movements · create ASN · create outbound (immediate rejection on hold with reason) · my orders · tracking + POD · stock alerts · invoices & statement · reports export · complaints (creates PCC ticket).
Roles: `CLIENT_ADMIN, CLIENT_CREATOR, CLIENT_VIEWER, CLIENT_FINANCE`. Isolation by RLS: `client_id = current_client_id()`. **Acceptance:** direct ID substitution returns zero rows, not a permission error. Client never sees: other clients, our costs/margins, employees, other prices, executing partners (unless setting), driver names.

**Client API v1 (I-09):** `POST /orders` (idempotent by `client_ref`), `GET /orders/{ref}`, `GET /inventory`, `GET /shipments/{no}`, `POST /webhooks`. Per-client key, revocable; 100 req/min; `/v1` frozen, breaking changes → `/v2` with 6-month overlap.

---

## PART D — APPLICATIONS

### D1. Admin (React) — Decision Inbox first

Home for every role = Decision Inbox (`platform.decisions` filtered by role): each item shows facts + financial impact + one action set; decide inline; item disappears on decision; sorted by impact then urgency. Three screen patterns only: **list** (≤ 6 columns, "needs your action" bar on top), **profile** (identity header, "what's missing before go-live" bar with owner+date, tabs, last tab = audit), **action** (stepper, live condition checks at bottom, errors state what is allowed). Empty-state component is mandatory: names the missing data and its owner. 57 screens (doc 29 §6-3). Global search `Ctrl+K` on any number → Trace screen.

### D2. Premium Decisions (React Native) — managers

Three screens: decisions · six KPI cards per role · search/trace. Decide from push notification without opening the app. Quiet hours. ≤ 25 MB.

### D3. Premium Driver (React Native + Expo)

Screens: readiness check → shift start (face + GPS) → vehicle checklist → load scan → task list (route-ordered; priority badges; in-app call/WhatsApp/SMS via provider adapter; navigation handoff) → task execution (arrive → scan → deliver | fail | defer → COD → POD → confirm) → returns scan → day close (five gates) → earnings (daily, deductions itemised, 48-h dispute) → profile/documents/attendance/penalties+grievance/support.
**Device and session (R-06):** personal device, **one device per driver**; enrol with OTP **once**, then a **30-day refresh** token; a new device requires **supervisor approval**; the device signing key is bound to the enrolment and a revoked device's queue is quarantined.
Offline: SQLite queue with UUIDs; server rejects duplicates by key; device time recorded, server time stamps; **7 days** local.
Anti-tamper: GPS at delivery vs address (> 300 m → warning + reason + audit flag); mock-location detection; camera-only photos; signature stroke data; device binding; one-time face check at shift start.
Lab acceptance: successful delivery **≤ 6 taps and ≤ 45 s**, and in every case at least 2 taps fewer than the iMile app (doc 34 protocol). The absolute target governs; the relative one is an additional condition, never a substitute.

### D4. Premium WH (PWA on industrial PDA)

Nine screens: home · receive · put-away · pick · check · load · count · transfer/return · lookup. Scan is the input; one step per screen; error prevented with sound+vibration and a message stating the next action; blind count; checker ≠ picker; **offline 72 h** with visible unsynced counter (green 0 / yellow 1–20 / red > 20); **shift cannot close with queue > 0**; kiosk mode; keyboard-wedge scanner; **scan response ≤ 1.0 s**.
**Device and session (R-06):** the PDA is a **shared** device. Login = employee code + **6-digit PIN**; the PIN hash is cached **on the device** after the first online login and never stored on the server (G-07); **weekly online OTP re-verification**; the device, not the person, is registered.

---

## PART E — ACCEPTANCE SCENARIOS (Gherkin)

Each feature is an executable Playwright test in `tests/scenarios/`. **All 20 (S1–S20) must pass before any production deploy** — S19 and S20 are written out below from the content of doc 12 (س19، س20), because WBS 4.17 makes them a gate condition for Phase 4. The count is 20 everywhere; it is a count of features S1–S20, each of which may contain more than one `Scenario:` block.

```gherkin
Feature: S1 Full 3PL client (Segment A, PST + PDL)
  Scenario: Inbound with short-shelf-life batch is quarantined
    Given client "GULF" has active PST contract with min receipt shelf life 180 days
    And an approved inbound order for SKU "GULF-0137"
    When the PDA receives batch "B2409-7" with expiry 120 days from today
    Then the line is placed in zone QRT
    And a decision item "quarantine_decision" is created for client contact within 48 h
    And no stock_movement to a storage location exists for that batch

  Scenario: Outbound FEFO allocation and billing chain
    Given available stock of "GULF-0137" in two batches with expiries 90 and 200 days
    When an outbound order for 12 units is approved
    Then allocation takes 12 units from the 90-day batch
    And after checked, billable events OF-01×1, OF-02×1, OF-06×1, OF-07×1 exist with status pending
    And the delivery task is created in PDL

Feature: S2 2PL storage-only client
  Scenario: Off-contract service is captured, not lost
    Given client "PARTS" contract includes only ST-01, ST-11, HD-03, HD-04, HD-08, OF-10
    When the warehouse performs VA-08 shrink wrap for "PARTS"
    Then a billable event VA-08 exists with status pending and no price
    And it appears in the Lost Revenue report

Feature: S3 B2C delivery with SLA
  Scenario: Failed attempt billed only with contract flag
    Given client "SHOP" contract has bills_failed_attempt = true
    And a task with two logged contact attempts
    When the driver records failure "no_answer.no_response"
    Then a billable event DL-11 is created
    And failure counts_against_driver = false

  Scenario: Task without complete address is rejected
    When a task is created with area "Salmiya" and no block or street
    Then the API returns 422 listing the missing fields

Feature: S4 Station client (iMile)
  Scenario: Scan-to-cage under one second
    Given today's sorting plan assigns zone "SABAH" to driver "D-0451" cage "C-07"
    When a shipment for "SABAH" is scanned on the PDA
    Then the response within 1000 ms shows cage "C-07", zone "SABAH", driver "D-0451"

  Scenario: Shipment attributed through time-bounded assignment
    Given ID "D-0451" was assigned to employee "PG-0231" until 14/03 11:20 and to "PG-0245" from 15/03 08:00
    When shipments delivered on 14/03 10:00 and 15/03 09:00 are attributed
    Then the first is attributed to "PG-0231" and the second to "PG-0245"
    And verify_attribution() returns zero rows

Feature: S5 External call-center client
  Scenario: Queue isolation
    Given agent "A1" is assigned only to queue "CLINIC"
    When agent "A1" requests tickets of queue "SHOP"
    Then zero tickets are returned

Feature: S6 Multi-entity client
  Scenario: Group-level hold blocks all entities
    Given client "RETAIL" has contracts with PST, PDL and PCC and credit_limit 15000
    And an overdue PST invoice pushes exposure above the limit
    When the nightly job runs
    Then credit_hold = true
    And a new PST outbound order is rejected with reason "credit hold"
    And a new PDL delivery task is rejected with the same reason
    And a new PCC queue for "RETAIL" is rejected

Feature: S7 Trial client
  Scenario: List prices, zero credit, expiry alert
    Given client "TRIAL" in segment F with a 3-month contract
    Then quotes use standard list prices with no discount
    And credit_limit = 0
    And an alert fires 14 days before contract end

Feature: S8 Delinquent client
  Scenario: Storage keeps billing during hold
    Given client "LATE" is on credit hold
    When the daily occupancy snapshot runs
    Then ST-01 billable events are still generated
    And new outbound orders are rejected

Feature: S9 Multi-entity prospect to contracts
  Scenario: Below-margin warning and partner requirement
    Given cold storage capacity is insufficient
    When an opportunity for 200 cold pallets is created
    Then a decision item "partner_or_decline" is created for GM
    And a quote line for ST-05 at margin 12% shows a warning against threshold 15%

Feature: S10 Price exception
  Scenario: Floor enforced on every write path
    Given ST-01 min_price = 2.500
    When a quote line at 2.100 is submitted via UI, via API, and via import
    Then all three are rejected with the floor price in the message
    When GM approves a price_exception with reason, validity and review date
    Then the line saves referencing the exception
    And the eventual invoice line has price_source = "exception"

Feature: S11 Contract renewal
  Scenario: Renewal file shows lost revenue
    Given 12 months of DL-11 and DL-12 events without contract flags for client "SHOP"
    When the renewal file is generated
    Then it lists 340 failed attempts and 180 returns with estimated value

Feature: S12 Lost opportunity
  Scenario: Closed reason list
    When an opportunity is closed as lost
    Then a lost_reason from the closed list is mandatory
    And the quarterly funnel report groups losses by reason

Feature: S13 Overseas recruitment
  Scenario: No stage without owner; overdue escalates
    When a recruitment case advances to stage "work_permit"
    Then stage_owner is set and sla_days = 7
    When 11 days pass without advancing
    Then a decision item escalates to GM naming the owner

Feature: S14 Purchase of 20 PDAs
  Scenario: Three-way match blocks payment
    Given a PO for 20 units and a receipt of 18
    And a vendor invoice for 20
    When payment is attempted
    Then it is rejected: three_way_matched = false
    When 2 more units are received
    Then three_way_matched = true and payment proceeds

Feature: S15 Driver termination
  Scenario: Clearance and ID release
    Given employee "PG-0231" holds iMile ID "D-0451", a PDA, and a pending advance
    When status is set to terminated
    Then the ID assignment is closed and the ID becomes available
    And clearance is blocked until PDA is returned and advance settled

Feature: S16 ID suspension and reassignment
  Scenario: Conduct suspension is not reassigned
    Given "D-0451" is suspended with category "conduct"
    When reassignment to "PG-0245" is attempted
    Then it is rejected and a "return_to_imile" decision item is created

Feature: S17 Bulk residency renewal
  Scenario: Missing documents assigned to owners
    Given 23 residencies expiring within 90 days, 4 lacking medical results
    When the batch is created
    Then 4 tasks exist, each with an owner and due date

Feature: S18 Storage at partner warehouse
  Scenario: Paired billable and payable events
    Given "GULF" allocated 200 pallets at partner "PW1" (cost 1.800, price 2.600)
    When the monthly snapshot runs
    Then a billable event 200×2.600 and a payable event 200×1.800 exist, linked
    And resale_margin shows 30.8%
    When the partner invoice claims 8,400 against matched 7,900
    Then the invoice status is variance_review and payment is frozen

Feature: S19 Subcontracted delivery peak (doc 12 س19)
  Scenario: Partner proof below our standard is never closed
    Given peak volume is 3× our own capacity
    And an on-demand partner delivery contract at DL-01 cost 0.950 KWD per shipment
    When overflow tasks are assigned to the partner with executed_by_partner = true
    And the partner returns a shipment status without GPS, signature-or-photo and receiver name
    Then the shipment is not closed
    And it is rejected and returned to the partner

  Scenario: Daily COD reconciliation freezes on variance
    Given the partner's end-of-day COD reconciliation shows a variance of 45.000 KWD
    Then settlement is frozen
    And a decision item requires clearance within 48 h

  Scenario: Back-to-back SLA yields a positive margin on failure
    Given 2,800 shipments were executed by the partner in the month
    And our client contract prices DL-01 at 1.400 and has bills_failed_attempt = true
    And 60 of those shipments failed at the partner
    When the monthly invoice and the partner payable are produced
    Then we bill the client 1.400 × 2,800 and the partner bills us 0.950 × 2,800
    And the margin per shipment is 0.450
    And the 60 failed shipments are not paid to the partner
    And DL-11 events for the 60 failed shipments are billed to the client

Feature: S20 Partner invoice dispute (doc 12 س20)
  Scenario: Automatic matching freezes payment and itemises the variance
    Given a partner storage invoice claims 8,400 KWD
    And our recorded payable events total 7,900 KWD
    When automatic matching runs
    Then the variance is 500 KWD, which is 6% and above the 2% tolerance
    And payment is frozen automatically
    And a line-by-line variance report lists 200 pallets for 5 overlap days and an uncontracted handling fee of 180 KWD

  Scenario: Only contracted lines survive the dispute
    Given the overlap days are evidenced by our own stock movements
    And the handling fee has no clause in the partner contract
    When the variance is settled
    Then 8,220 KWD is approved and 180 KWD stays recorded as a dispute
    And the partner issues a credit note before payment is released
    And the partner's rating is reduced for a billing dispute and the reduction enters the renewal file
```

---

## PART F — GUARD TESTS

Every guard below is a **copy-and-paste-runnable** line. G1–G13 and G18 are SQL and live in `database/guards.sql`; G14–G17 are runner commands. A guard fails when it does not meet its stated pass condition — "zero rows" is not the condition for all of them.

| # | Runnable check | Pass condition | Blocking? |
|---|---|---|---|
| G1 | `select count(*) from wms.verify_balance_integrity();` | `0` | yes |
| G2 | `select count(*) from billing.verify_journal_balance();` | `0` | yes |
| G3 | `select count(*) from imile.verify_attribution(current_date - 30, current_date);` | `0` | yes |
| G4 | `select count(*) from imile.verify_no_orphan_ids();` | `0` | yes |
| G5 | `select count(*) from partners.verify_paid_matched();` | `0` | yes |
| G6 | `select count(*) from information_schema.columns c where c.table_schema in ('platform','identity','catalog','sales','wms','tms','cc','billing','hr','partners','admin','housing','imile','governance') and not exists (select 1 from identity.column_classification k where k.schema_name = c.table_schema and k.table_name = c.table_name and k.column_name = c.column_name);` | `0` | yes |
| G7 | `select count(*) from pg_class t join pg_namespace n on n.oid = t.relnamespace where t.relkind = 'r' and n.nspname in ('platform','identity','catalog','sales','wms','tms','cc','billing','hr','partners','admin','housing','imile','governance') and not t.relrowsecurity;` | `0` | yes |
| G8 | `select * from platform.verify_audit_chain();` | `0 rows` | yes |
| G9 | `with w as (select * from platform.outbox order by id desc limit 1000) select count(*) from w where not exists (select 1 from platform.audit_log a where a.correlation_id = w.correlation_id);` | `0` | yes |
| G10 | `select count(*) from platform.audit_log where operation in ('reject','void') and (reason is null or btrim(reason) = '');` | `0` | yes |
| G11 | `select count(*) from billing.invoice_lines l where not exists (select 1 from billing.billable_events e where e.invoice_line_id = l.id);` | `0` | yes |
| G12 | `select count(*) from tms.delivery_tasks t where t.status = 'delivered' and not exists (select 1 from tms.proof_of_delivery p where p.task_id = t.id);` | `0` | yes |
| G13 | `pgbench -c 100 -t 1 -f tests/guards/next_doc_no.sql` then `select count(distinct doc_no) from platform.doc_no_probe;` | `100` unique | yes |
| G14 | `pnpm test:isolation` — client A requests client B's ids directly | `0 rows`, **no error** | yes |
| G15 | `pnpm playwright test tests/scenarios` | **20/20** features (S1–S20) | yes |
| G16 | `pnpm stryker run` on `domain/` | **≥ 75%** mutation score | yes |
| G17 | `pnpm test:trace` — one number in, full timeline out | **≤ 2 s** | yes |
| G18 | `select count(*) from billing.verify_unpriced_events();` | reported, not enforced | **no — report only** |

`deploy.sh` and `pnpm guards:run` execute **G1–G18**. A single blocking failure stops merge *and* deploy. There is no "deploy and fix".

**"Operational table" for G7** means any base table in the fourteen business schemas listed above. Fixed reference tables and system logs are not exempt by category: where a table has no `entity_id`, RLS is still enabled and the policy is written against the access rule that applies to it (internal-only, owner-role-only, or unrestricted read). Enabling RLS on every remaining table in 01/13/13B is WBS task 0.18; classifying every column for G6 is WBS task 0.16.

---

## PART G — NON-FUNCTIONAL TARGETS

| Metric | Target |
|---|---|
| List screen p95 | ≤ 1.2 s |
| Profile screen p95 | ≤ 1.5 s |
| Save p95 | ≤ 0.8 s |
| **PDA scan response** | **≤ 1.0 s** |
| Monthly report (12 months) | ≤ 8 s |
| Availability, business hours | ≥ 99.5% (both tiers) |
| Retention | invoices/journals 10 y; audit 18 m (financial 10 y); biometrics 12 m; photos 60 d with automatic `legal_hold` on disputed items |
| Security | OWASP ASVS L2; secrets manager; TLS 1.3; dependency scan; SBOM; pen-test pre-launch and yearly |

### Continuity by tier (R-03) — a number is never written without its tier

| Item | **Tier 0** (Phases 0–3, Oracle Always Free) | **Tier 2** (from Phase 4, GCP or paid OCI) |
|---|---|---|
| RPO / RTO | **24 h / 4 h** | **≤ 1 h / ≤ 4 h** |
| Backup retention | **14 daily · 8 weekly · 6 monthly** (as implemented in `backup.sh`) | 30 · 12 · 12 |
| Availability, business hours | 99.5% | 99.5% |
| Inbound ports | **zero** — Cloudflare Tunnel only; SSH through the Tunnel/bastion | — |
| Shape | **ARM A1 · 4 OCPU / 24 GB** (the whole Always Free ARM quota in one VM) | sized at the trigger; no paid resource without a written GM instruction |
| Read replica for reports | **not available** — reports run on the primary off-peak with `statement_timeout` | **Tier 1/2 target** |
| Monthly restore test | required | required |

**Tier 1/2 trigger:** before Phase 4 · or more than 40 concurrent users · or a p95 SLO breach sustained for seven days.

Cloud (tiered, doc 42): **Tier 0 — Oracle Always Free**, single `VM.Standard.A1.Flex` (4 OCPU / 24 GB, arm64), Docker Compose (`postgres:16-alpine`, `api`, `admin`, `portal`, `nginx`), **Cloudflare Tunnel, zero inbound ports**, backups to OCI Object Storage 14/8/6. **Tier 2 — Google Cloud `me-central1`**: Cloud Run · Cloud SQL 16 + read replica · GCS · Secret Manager · Terraform. All images `linux/arm64`-compatible. No Redis (pg-boss).

---

## PART H — BUILD ORDER (summary of doc 38)

**Eight phases (0–7)**, 132 tasks: 126 phased + 6 cross-cutting.

Phase 0 Foundation (0.1 → 0.20; the code track starts at 0.4) · Phase 1 Commercial core · Phase 2 Warehouse (golden slice 2.9) · Phase 3 Delivery & iMile · Phase 4 Finance · Phase 5 Support (HR, Housing, Admin, CC, Governance) · Phase 6 Client & Manager apps · **Phase 7 Hardening & launch**. Every phase gate depends on at least one human task (data gate or sign-off). **Prerequisites 1–4 are closed; only the iMile API request remains open and does not block.**

---

## PART I — SCHEMA FILE MAP

There are four schema files and one guard file. **No database object exists outside them.**

| File | What it defines | Applied after |
|---|---|---|
| `database/01-Data-Model.sql` | The core model: `platform` (entities, settings, counters, `next_doc_no`), `identity`, `catalog`, `sales`, `wms`, `tms`, `cc`, `billing`, `hr`, `partners`, `admin`, `imile`, `governance`; base RLS patterns; founding seed data (§13) | — (first) |
| `database/13-Schema-Additions.sql` | Additions to the core model that the reference documents require on existing tables | 01 |
| `database/13B-Schema-Reference-Consolidation.sql` | The 39 tables that existed only inside reference documents, raised into governing SQL: `platform.outbox` (and the drop of `platform.domain_events`), the partitioned `platform.audit_log` with its hash chain, `feature_flags`, `thresholds`, `settings` companions, `decisions`, `automation_rules`, `integration_config/queue`, `alert_rules/alert_log`, `domain_owners`, `approval_chains`, `delegations`, `sod_rules`, `hr.penalty_schedule`, `hr.disciplinary_cases`, `housing.*`, `wms.space_*`, `tms.maintenance_*`/`accidents`/`fuel_ledger`/`contact_log`/`payment_attempts`/`failure_reasons`, `imile.dtl_rule_autonomy`/`dispatch_autonomy`/`driver_trust`; the 26 role seeds; the 4 SoD seeds; the 16 ADR-27 thresholds | 13 |
| `database/019-Warehouse-WH1-Setup.sql` | WH1 only: the warehouse, its zones, its 8 space blocks, and the 3,330 location codes (3,153 storage + 30 operational + 147 structural) with their weight and volume limits — generating exactly what doc 19 §4 describes | 13B |
| `database/guards.sql` | G1–G13 and G18 as runnable SQL (Part F) | 019 |
| `database/apply.sh` | Applies 01 → 13 → 13B → 019 with `-v ON_ERROR_STOP=1`, then runs `guards.sql` | — |

**No object outside these files. A slice needing a new object files a one-line SCR (G-01).**

Migrations produced during the build live in `database/migrations`, numbered by the Master; they never redefine an object these files already own.

---

*End of specification. Identifiers, code, commits and technical docs in English; user-facing text via i18n (ar, en, hi, ur, bn, am).*
